import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before imports that trigger them
// ---------------------------------------------------------------------------

vi.mock("@actions/core", async () => {
  const { createCoreMock } = await import("./helpers/mockCore");
  return createCoreMock();
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("../src/deploy/ssh.js", () => ({
  withKeyFile: vi.fn(),
  sshExec: vi.fn(),
  shellQuote: vi.fn((value: string) =>
    `'${value.replace(/'/g, "'\\''")}'`,
  ),
}));

// ---------------------------------------------------------------------------
// Imports (receive mocked implementations)
// ---------------------------------------------------------------------------

import * as core from "@actions/core";
import * as fs from "node:fs";
import * as ssh from "../src/deploy/ssh.js";

import {
  deployHaproxy,
  deployHaproxyBase,
  deployHaproxyFragment,
  ensureHaproxyFragService,
} from "../src/deploy/haproxy";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const FAKE_KEY_PATH = "/tmp/hda-key-XXXXXX/id";
const CFG_PATH = "/workspace/haproxy.cfg";
const FRAGMENT_PATH = "/workspace/fragments/app.cfg";
const REMOTE_CFG_DIR = "/etc/haproxy";
const REMOTE_CFG_PATH = "/etc/haproxy/haproxy.cfg";
const BUNDLED_BASE_CFG_PATH_SUFFIX = "/templates/haproxy-base.cfg";
const BUNDLED_FRAG_SERVICE_PATH_SUFFIX = "/templates/haproxy-frag.service";
const FRAGMENT_NAME = "app";
const REMOTE_FRAGMENT_DIR = "/etc/haproxy/conf.d";
const REMOTE_FRAGMENT_PATH = `/etc/haproxy/conf.d/${FRAGMENT_NAME}.cfg`;
const REMOTE_SERVICE_UNIT_PATH = "/etc/systemd/system/haproxy-frag.service";
const REMOTE_FRAGMENT_VALIDATE_CMD =
  `sudo haproxy -c -f '${REMOTE_CFG_PATH}' -f '${REMOTE_FRAGMENT_DIR}/'`;
const STOP_DISABLE_HAPROXY_CMD =
  "sudo systemctl stop haproxy >/dev/null 2>&1 || true && sudo systemctl disable haproxy >/dev/null 2>&1 || true";
const HAPROXY_FRAG_SERVICE_FALLBACK = [
  "[Unit]",
  "Description=HAProxy fragment orchestration service",
  "After=network.target",
  "",
  "[Service]",
  "Type=notify",
  "ExecStartPre=/usr/sbin/haproxy -c -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/conf.d/",
  "ExecStart=/usr/sbin/haproxy -Ws -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/conf.d/ -p /run/haproxy-frag.pid",
  "ExecReload=/usr/sbin/haproxy -c -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/conf.d/",
  "ExecReload=/bin/kill -USR2 $MAINPID",
  "KillMode=mixed",
  "Restart=on-failure",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
].join("\n");

const BASE_OPTS = {
  host: "1.2.3.4",
  user: "root",
  privateKey: "TEST_PRIVATE_KEY",
  cfgPath: CFG_PATH,
} as const;

const BASE_FRAGMENT_OPTS = {
  host: "1.2.3.4",
  user: "root",
  privateKey: "TEST_PRIVATE_KEY",
  fragmentPath: FRAGMENT_PATH,
  fragmentName: FRAGMENT_NAME,
} as const;

const BASE_BASE_OPTS = {
  host: "1.2.3.4",
  user: "root",
  privateKey: "TEST_PRIVATE_KEY",
} as const;

const CONFIG_CONTENT = [
  "global",
  "  daemon",
  "defaults",
  "  mode http",
  "frontend web",
  "  bind *:80",
  "  default_backend app",
].join("\n");

function sshRemoteCmd(callIndex: number): string {
  return vi.mocked(ssh.sshExec).mock.calls[callIndex]![3] as string;
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(CONFIG_CONTENT as never);
  vi.mocked(ssh.shellQuote).mockImplementation(
    (value: string) => `'${value.replace(/'/g, "'\\''")}'`,
  );
  vi.mocked(ssh.withKeyFile).mockImplementation(
    async (_privateKey: string, fn: (keyPath: string) => Promise<unknown>) =>
      fn(FAKE_KEY_PATH),
  );
  vi.mocked(ssh.sshExec).mockResolvedValue("");
});

// ===========================================================================
// deployHaproxy
// ===========================================================================

describe("deployHaproxy", () => {
  it("reads the config, uploads it, validates it, and reloads haproxy", async () => {
    const result = await deployHaproxy(BASE_OPTS);

    expect(result).toEqual({
      configUploaded: true,
      serviceReloaded: true,
    });

    expect(fs.readFileSync).toHaveBeenCalledWith(CFG_PATH, "utf-8");
    expect(ssh.withKeyFile).toHaveBeenCalledWith(
      "TEST_PRIVATE_KEY",
      expect.any(Function),
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(3);
    expect(sshRemoteCmd(0)).toContain(
      `sudo mkdir -p '${REMOTE_CFG_DIR}' && sudo tee '${REMOTE_CFG_PATH}' > /dev/null`,
    );
    expect(sshRemoteCmd(0)).toContain("HAPROXY_CFG_EOF");
    expect(sshRemoteCmd(0)).toContain(CONFIG_CONTENT);
    expect(sshRemoteCmd(1)).toBe(
      `sudo haproxy -c -f '${REMOTE_CFG_PATH}'`,
    );
    expect(sshRemoteCmd(2)).toBe("sudo systemctl reload haproxy-frag");
  });

  it("wraps upload failures with the HAPROXY_UPLOAD prefix", async () => {
    vi.mocked(ssh.sshExec).mockRejectedValueOnce(new Error("tee failed"));

    await expect(deployHaproxy(BASE_OPTS)).rejects.toThrow(
      /HAPROXY_UPLOAD: tee failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(1);
    expect(sshRemoteCmd(0)).toContain(`'${REMOTE_CFG_PATH}'`);
  });

  it("wraps validation failures with the HAPROXY_VALIDATE prefix", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("config invalid"));

    await expect(deployHaproxy(BASE_OPTS)).rejects.toThrow(
      /HAPROXY_VALIDATE: config invalid/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(2);
    expect(sshRemoteCmd(0)).toContain(`'${REMOTE_CFG_PATH}'`);
    expect(sshRemoteCmd(1)).toBe(
      `sudo haproxy -c -f '${REMOTE_CFG_PATH}'`,
    );
  });

  it("wraps reload failures with the HAPROXY_RELOAD prefix", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("reload failed"));

    await expect(deployHaproxy(BASE_OPTS)).rejects.toThrow(
      /HAPROXY_RELOAD: reload failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(3);
    expect(sshRemoteCmd(1)).toBe(
      `sudo haproxy -c -f '${REMOTE_CFG_PATH}'`,
    );
    expect(sshRemoteCmd(2)).toBe("sudo systemctl reload haproxy-frag");
  });

  it("wraps local config read failures with the HAPROXY_UPLOAD prefix", async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: missing config");
    });

    await expect(deployHaproxy(BASE_OPTS)).rejects.toThrow(
      /HAPROXY_UPLOAD: failed to read local config: ENOENT: missing config/,
    );

    expect(ssh.withKeyFile).not.toHaveBeenCalled();
    expect(ssh.sshExec).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// deployHaproxyFragment
// ===========================================================================

describe("deployHaproxyBase", () => {
  it("reads the bundled template, uploads it, and logs the deploy message", async () => {
    const result = await deployHaproxyBase(BASE_BASE_OPTS);

    expect(result).toEqual({
      configUploaded: true,
      serviceReloaded: true,
    });

    expect(fs.readFileSync).toHaveBeenCalledWith(
      expect.stringContaining(BUNDLED_BASE_CFG_PATH_SUFFIX),
      "utf-8",
    );
    expect(core.info).toHaveBeenCalledWith(
      `[HAPROXY_UPLOAD] Deploying bundled HAProxy base config to ${REMOTE_CFG_PATH} for fragment-only mode.`,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(3);
    expect(sshRemoteCmd(0)).toContain(
      `sudo mkdir -p '${REMOTE_CFG_DIR}' && sudo tee '${REMOTE_CFG_PATH}' > /dev/null`,
    );
    expect(sshRemoteCmd(0)).toContain("HAPROXY_CFG_EOF");
    expect(sshRemoteCmd(0)).toContain(CONFIG_CONTENT);
  });

  it("falls back to the inline base config when the bundled template is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await deployHaproxyBase(BASE_BASE_OPTS);

    expect(result).toEqual({
      configUploaded: true,
      serviceReloaded: true,
    });
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(sshRemoteCmd(0)).toContain("log stdout format raw local0");
  });

  it("wraps non-missing bundled template read failures with clear context", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    await expect(deployHaproxyBase(BASE_BASE_OPTS)).rejects.toThrow(
      /HAPROXY_UPLOAD: failed to read bundled HAProxy base config: EACCES: permission denied/,
    );

    expect(ssh.withKeyFile).not.toHaveBeenCalled();
    expect(ssh.sshExec).not.toHaveBeenCalled();
  });
});

describe("deployHaproxyFragment", () => {
  it("reads the fragment, uploads it, validates the full config, and reloads haproxy", async () => {
    const result = await deployHaproxyFragment(BASE_FRAGMENT_OPTS);

    expect(result).toEqual({
      configUploaded: true,
      serviceReloaded: true,
    });

    expect(fs.readFileSync).toHaveBeenCalledWith(FRAGMENT_PATH, "utf-8");
    expect(ssh.withKeyFile).toHaveBeenCalledWith(
      "TEST_PRIVATE_KEY",
      expect.any(Function),
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(3);
    expect(sshRemoteCmd(0)).toContain(
      `sudo mkdir -p '${REMOTE_FRAGMENT_DIR}' && sudo tee '${REMOTE_FRAGMENT_PATH}' > /dev/null`,
    );
    expect(sshRemoteCmd(0)).toContain("HAPROXY_CFG_EOF");
    expect(sshRemoteCmd(0)).toContain(CONFIG_CONTENT);
    expect(sshRemoteCmd(1)).toBe(REMOTE_FRAGMENT_VALIDATE_CMD);
    expect(sshRemoteCmd(2)).toBe("sudo systemctl reload haproxy-frag");
  });

  it("wraps fragment upload failures with clear fragment context", async () => {
    vi.mocked(ssh.sshExec).mockRejectedValueOnce(new Error("tee failed"));

    await expect(deployHaproxyFragment(BASE_FRAGMENT_OPTS)).rejects.toThrow(
      /HAPROXY_UPLOAD: failed to upload fragment "app": tee failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(1);
    expect(sshRemoteCmd(0)).toContain(`'${REMOTE_FRAGMENT_PATH}'`);
  });
});

describe("ensureHaproxyFragService", () => {
  it("stops default haproxy best-effort, uploads the unit, reloads systemd, and enables haproxy-frag", async () => {
    await expect(ensureHaproxyFragService(BASE_BASE_OPTS)).resolves.toBeUndefined();

    expect(fs.readFileSync).toHaveBeenCalledWith(
      expect.stringContaining(BUNDLED_FRAG_SERVICE_PATH_SUFFIX),
      "utf-8",
    );
    expect(ssh.withKeyFile).toHaveBeenCalledWith(
      "TEST_PRIVATE_KEY",
      expect.any(Function),
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(4);
    expect(sshRemoteCmd(0)).toBe(STOP_DISABLE_HAPROXY_CMD);
    expect(sshRemoteCmd(1)).toContain(
      `sudo mkdir -p '/etc/systemd/system' && sudo tee '${REMOTE_SERVICE_UNIT_PATH}' > /dev/null`,
    );
    expect(sshRemoteCmd(1)).toContain("HAPROXY_SERVICE_EOF");
    expect(sshRemoteCmd(1)).toContain(CONFIG_CONTENT);
    expect(sshRemoteCmd(2)).toBe("sudo systemctl daemon-reload");
    expect(sshRemoteCmd(3)).toBe("sudo systemctl enable --now haproxy-frag");
  });

  it("falls back to the inline service unit when the bundled template is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await expect(ensureHaproxyFragService(BASE_BASE_OPTS)).resolves.toBeUndefined();

    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(sshRemoteCmd(1)).toContain(HAPROXY_FRAG_SERVICE_FALLBACK);
  });

  it("wraps bundled service template read failures with HAPROXY_SERVICE_INSTALL", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    await expect(ensureHaproxyFragService(BASE_BASE_OPTS)).rejects.toThrow(
      /HAPROXY_SERVICE_INSTALL: failed to read bundled HAProxy frag service: EACCES: permission denied/,
    );

    expect(ssh.withKeyFile).not.toHaveBeenCalled();
    expect(ssh.sshExec).not.toHaveBeenCalled();
  });

  it("wraps service unit upload failures with HAPROXY_SERVICE_INSTALL", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("tee failed"));

    await expect(ensureHaproxyFragService(BASE_BASE_OPTS)).rejects.toThrow(
      /HAPROXY_SERVICE_INSTALL: tee failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(2);
    expect(sshRemoteCmd(0)).toBe(STOP_DISABLE_HAPROXY_CMD);
    expect(sshRemoteCmd(1)).toContain(`'${REMOTE_SERVICE_UNIT_PATH}'`);
  });

  it("wraps daemon-reload failures with HAPROXY_SERVICE_INSTALL", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("daemon-reload failed"));

    await expect(ensureHaproxyFragService(BASE_BASE_OPTS)).rejects.toThrow(
      /HAPROXY_SERVICE_INSTALL: daemon-reload failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(3);
    expect(sshRemoteCmd(2)).toBe("sudo systemctl daemon-reload");
  });

  it("wraps enable/start failures with HAPROXY_SERVICE_INSTALL", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("enable failed"));

    await expect(ensureHaproxyFragService(BASE_BASE_OPTS)).rejects.toThrow(
      /HAPROXY_SERVICE_INSTALL: enable failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(4);
    expect(sshRemoteCmd(3)).toBe("sudo systemctl enable --now haproxy-frag");
  });

  it("tolerates default haproxy stop/disable failures and still proceeds", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("Failed to stop haproxy.service: Unit haproxy.service not loaded.")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    await expect(ensureHaproxyFragService(BASE_BASE_OPTS)).resolves.toBeUndefined();

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(4);
    expect(sshRemoteCmd(0)).toBe(STOP_DISABLE_HAPROXY_CMD);
    expect(sshRemoteCmd(1)).toContain(`'${REMOTE_SERVICE_UNIT_PATH}'`);
    expect(sshRemoteCmd(2)).toBe("sudo systemctl daemon-reload");
    expect(sshRemoteCmd(3)).toBe("sudo systemctl enable --now haproxy-frag");
  });
});
