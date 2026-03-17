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
  deployHaproxyCertbotFragment,
  deployHaproxyFragment,
  deployHaproxyFragmentWithoutReload,
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
const BUNDLED_CERTBOT_CFG_PATH_SUFFIX = "/templates/haproxy-certbot.cfg";
const BUNDLED_FRAG_SERVICE_PATH_SUFFIX = "/templates/haproxy-frag.service";
const FRAGMENT_NAME = "app";
const CERTBOT_FRAGMENT_NAME = "certbot";
const REMOTE_FRAGMENT_DIR = "/etc/haproxy/conf.d";
const REMOTE_FRAGMENT_PATH = `/etc/haproxy/conf.d/${FRAGMENT_NAME}.cfg`;
const REMOTE_CERTBOT_FRAGMENT_PATH = `/etc/haproxy/conf.d/${CERTBOT_FRAGMENT_NAME}.cfg`;
const REMOTE_SERVICE_UNIT_PATH = "/etc/systemd/system/haproxy-frag.service";
const EARLY_CONF_DIR_MKDIR_CMD = "sudo mkdir -p '/etc/haproxy/conf.d/'";
const ENABLE_HAPROXY_FRAG_CMD = "sudo systemctl enable haproxy-frag";
const START_OR_RELOAD_HAPROXY_FRAG_CMD =
  "sudo systemctl is-active --quiet haproxy-frag && sudo systemctl reload haproxy-frag || sudo systemctl start haproxy-frag";
const BACKUP_CONF_D_CMD =
  "sudo rm -rf /etc/haproxy/conf.d.bak && sudo cp -a /etc/haproxy/conf.d /etc/haproxy/conf.d.bak";
const RESTORE_CONF_D_CMD =
  "sudo rm -rf /etc/haproxy/conf.d && sudo mv /etc/haproxy/conf.d.bak /etc/haproxy/conf.d";
const CLEANUP_CONF_D_BACKUP_CMD = "sudo rm -rf /etc/haproxy/conf.d.bak";
const HASH_CONF_D_CMD =
  "sudo find /etc/haproxy/conf.d -name '*.cfg' -exec sha256sum {} +";
const REMOTE_FRAGMENT_VALIDATE_CMD =
  `sudo haproxy -c -f '${REMOTE_CFG_PATH}' -f '${REMOTE_FRAGMENT_DIR}/'`;
const STOP_DISABLE_HAPROXY_CMD =
  "sudo systemctl stop haproxy >/dev/null 2>&1 || true && sudo systemctl disable haproxy >/dev/null 2>&1 || true";
const HAPROXY_FRAG_SERVICE_FALLBACK = [
  "[Unit]",
  "Description=HAProxy fragment orchestration service",
  "After=network.target",
  "ConditionDirectoryNotEmpty=/etc/haproxy/conf.d",
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

const BASE_CERTBOT_OPTS = {
  host: "1.2.3.4",
  user: "root",
  privateKey: "TEST_PRIVATE_KEY",
  certbotPort: "8081",
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

const CERTBOT_TEMPLATE_CONTENT = [
  "frontend ft_http",
  "  bind *:80",
  "  acl acme_challenge path_beg /.well-known/acme-challenge/",
  "  use_backend bk_certbot if acme_challenge",
  "",
  "backend bk_certbot",
  "  server certbot 127.0.0.1:${CERTBOT_PORT}",
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
    expect(sshRemoteCmd(2)).toBe(START_OR_RELOAD_HAPROXY_FRAG_CMD);
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
    expect(sshRemoteCmd(2)).toBe(START_OR_RELOAD_HAPROXY_FRAG_CMD);
  });

  it("uses start-or-reload so full-config deploy can recover when haproxy-frag is inactive", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("started haproxy-frag");

    await expect(deployHaproxy(BASE_OPTS)).resolves.toEqual({
      configUploaded: true,
      serviceReloaded: true,
    });

    expect(sshRemoteCmd(2)).toBe(START_OR_RELOAD_HAPROXY_FRAG_CMD);
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
      serviceReloaded: false,
    });

    expect(fs.readFileSync).toHaveBeenCalledWith(
      expect.stringContaining(BUNDLED_BASE_CFG_PATH_SUFFIX),
      "utf-8",
    );
    expect(core.info).toHaveBeenCalledWith(
      `[HAPROXY_UPLOAD] Deploying bundled HAProxy base config to ${REMOTE_CFG_PATH} for fragment-only mode.`,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(1);
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
      serviceReloaded: false,
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
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("prehash  /etc/haproxy/conf.d/app.cfg")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("posthash  /etc/haproxy/conf.d/app.cfg")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

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

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(7);
    expect(sshRemoteCmd(0)).toBe(BACKUP_CONF_D_CMD);
    expect(sshRemoteCmd(1)).toBe(HASH_CONF_D_CMD);
    expect(sshRemoteCmd(2)).toContain(
      `sudo mkdir -p '${REMOTE_FRAGMENT_DIR}' && sudo tee '${REMOTE_FRAGMENT_PATH}' > /dev/null`,
    );
    expect(sshRemoteCmd(2)).toContain("HAPROXY_CFG_EOF");
    expect(sshRemoteCmd(2)).toContain(CONFIG_CONTENT);
    expect(sshRemoteCmd(3)).toBe(REMOTE_FRAGMENT_VALIDATE_CMD);
    expect(sshRemoteCmd(4)).toBe(HASH_CONF_D_CMD);
    expect(sshRemoteCmd(5)).toBe(CLEANUP_CONF_D_BACKUP_CMD);
    expect(sshRemoteCmd(6)).toBe(START_OR_RELOAD_HAPROXY_FRAG_CMD);
    expect(core.info).toHaveBeenCalledWith("[HAPROXY_HASH] Phase: pre-upload");
    expect(core.info).toHaveBeenCalledWith("[HAPROXY_HASH] Phase: post-upload");
  });

  it("uses start-or-reload so fragment deploy works whether haproxy-frag is active or inactive", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("reloaded or started");

    await expect(deployHaproxyFragment(BASE_FRAGMENT_OPTS)).resolves.toEqual({
      configUploaded: true,
      serviceReloaded: true,
    });

    expect(sshRemoteCmd(6)).toBe(START_OR_RELOAD_HAPROXY_FRAG_CMD);
  });

  it("wraps fragment upload failures with clear fragment context", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("tee failed"));

    await expect(deployHaproxyFragment(BASE_FRAGMENT_OPTS)).rejects.toThrow(
      /HAPROXY_UPLOAD: failed to upload fragment "app": tee failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(3);
    expect(sshRemoteCmd(2)).toContain(`'${REMOTE_FRAGMENT_PATH}'`);
  });

  it("can upload and validate a fragment without reloading haproxy-frag", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    const result = await deployHaproxyFragmentWithoutReload(BASE_FRAGMENT_OPTS);

    expect(result).toEqual({
      configUploaded: true,
      serviceReloaded: false,
    });
    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(6);
    expect(sshRemoteCmd(0)).toBe(BACKUP_CONF_D_CMD);
    expect(sshRemoteCmd(1)).toBe(HASH_CONF_D_CMD);
    expect(sshRemoteCmd(2)).toContain(
      `sudo mkdir -p '${REMOTE_FRAGMENT_DIR}' && sudo tee '${REMOTE_FRAGMENT_PATH}' > /dev/null`,
    );
    expect(sshRemoteCmd(3)).toBe(REMOTE_FRAGMENT_VALIDATE_CMD);
    expect(sshRemoteCmd(4)).toBe(HASH_CONF_D_CMD);
    expect(sshRemoteCmd(5)).toBe(CLEANUP_CONF_D_BACKUP_CMD);
  });

  it("restores conf.d and logs post-restore hashes when fragment validation fails", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("prehash /etc/haproxy/conf.d/app.cfg")
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("config invalid"))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("restorehash /etc/haproxy/conf.d/app.cfg");

    await expect(deployHaproxyFragment(BASE_FRAGMENT_OPTS)).rejects.toThrow(
      /HAPROXY_VALIDATE: failed to validate HAProxy configuration after uploading fragment "app": config invalid/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(7);
    expect(sshRemoteCmd(4)).toBe(RESTORE_CONF_D_CMD);
    expect(sshRemoteCmd(5)).toBe(HASH_CONF_D_CMD);
    expect(sshRemoteCmd(6)).toBe(REMOTE_FRAGMENT_VALIDATE_CMD);
    expect(core.info).toHaveBeenCalledWith("[HAPROXY_HASH] Phase: post-restore");
    expect(core.info).toHaveBeenCalledWith(
      `[HAPROXY_VALIDATE] Running HAProxy diagnostic validation on restored configuration for fragment ${FRAGMENT_NAME}…`,
    );
  });

  it("warns and continues when cleanup backup fails after successful fragment validation", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValueOnce("");

    await expect(deployHaproxyFragment(BASE_FRAGMENT_OPTS)).resolves.toEqual({
      configUploaded: true,
      serviceReloaded: true,
    });

    expect(core.warning).toHaveBeenCalledWith(
      "[HAPROXY_BACKUP] Failed to clean up conf.d backup (non-fatal): cleanup failed",
    );
    expect(sshRemoteCmd(5)).toBe(CLEANUP_CONF_D_BACKUP_CMD);
    expect(sshRemoteCmd(6)).toBe(START_OR_RELOAD_HAPROXY_FRAG_CMD);
  });

  it("warns and continues when pre-upload hash logging fails", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("hash failed"))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    await expect(deployHaproxyFragment(BASE_FRAGMENT_OPTS)).resolves.toEqual({
      configUploaded: true,
      serviceReloaded: true,
    });

    expect(core.warning).toHaveBeenCalledWith(
      "[HAPROXY_HASH] Failed to compute conf.d hashes for phase pre-upload (non-fatal): hash failed",
    );
  });

  it("fails immediately when conf.d backup cannot be created", async () => {
    vi.mocked(ssh.sshExec).mockRejectedValueOnce(new Error("cp failed"));

    await expect(deployHaproxyFragment(BASE_FRAGMENT_OPTS)).rejects.toThrow(
      /HAPROXY_BACKUP: failed to snapshot conf.d: cp failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(1);
    expect(sshRemoteCmd(0)).toBe(BACKUP_CONF_D_CMD);
  });

  it("fails with restore error when rollback restore fails", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("config invalid"))
      .mockRejectedValueOnce(new Error("restore failed"));

    await expect(deployHaproxyFragment(BASE_FRAGMENT_OPTS)).rejects.toThrow(
      /HAPROXY_RESTORE: failed to restore conf.d from backup: restore failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(5);
    expect(sshRemoteCmd(4)).toBe(RESTORE_CONF_D_CMD);
  });
});

describe("deployHaproxyCertbotFragment", () => {
  it("renders the bundled template, uploads it, validates it, and reloads haproxy-frag", async () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      const file = String(filePath);
      if (file.includes(BUNDLED_CERTBOT_CFG_PATH_SUFFIX)) {
        return CERTBOT_TEMPLATE_CONTENT as never;
      }
      return CONFIG_CONTENT as never;
    });

    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    const result = await deployHaproxyCertbotFragment(BASE_CERTBOT_OPTS);

    expect(result).toEqual({
      configUploaded: true,
      serviceReloaded: true,
    });
    expect(fs.readFileSync).toHaveBeenCalledWith(
      expect.stringContaining(BUNDLED_CERTBOT_CFG_PATH_SUFFIX),
      "utf-8",
    );
    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(7);
    expect(sshRemoteCmd(0)).toBe(BACKUP_CONF_D_CMD);
    expect(sshRemoteCmd(1)).toBe(HASH_CONF_D_CMD);
    expect(sshRemoteCmd(2)).toContain(`'${REMOTE_CERTBOT_FRAGMENT_PATH}'`);
    expect(sshRemoteCmd(2)).toContain("127.0.0.1:8081");
    expect(sshRemoteCmd(3)).toBe(REMOTE_FRAGMENT_VALIDATE_CMD);
    expect(sshRemoteCmd(4)).toBe(HASH_CONF_D_CMD);
    expect(sshRemoteCmd(5)).toBe(CLEANUP_CONF_D_BACKUP_CMD);
    expect(sshRemoteCmd(6)).toBe(START_OR_RELOAD_HAPROXY_FRAG_CMD);
  });
});

describe("ensureHaproxyFragService", () => {
  it("stops default haproxy best-effort, creates conf.d early, uploads the unit, reloads systemd, and enables haproxy-frag without starting it", async () => {
    await expect(ensureHaproxyFragService(BASE_BASE_OPTS)).resolves.toBeUndefined();

    expect(fs.readFileSync).toHaveBeenCalledWith(
      expect.stringContaining(BUNDLED_FRAG_SERVICE_PATH_SUFFIX),
      "utf-8",
    );
    expect(ssh.withKeyFile).toHaveBeenCalledWith(
      "TEST_PRIVATE_KEY",
      expect.any(Function),
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(5);
    expect(sshRemoteCmd(0)).toBe(STOP_DISABLE_HAPROXY_CMD);
    expect(sshRemoteCmd(1)).toBe(EARLY_CONF_DIR_MKDIR_CMD);
    expect(sshRemoteCmd(2)).toContain(
      `sudo mkdir -p '/etc/systemd/system' && sudo tee '${REMOTE_SERVICE_UNIT_PATH}' > /dev/null`,
    );
    expect(sshRemoteCmd(2)).toContain("HAPROXY_SERVICE_EOF");
    expect(sshRemoteCmd(2)).toContain(CONFIG_CONTENT);
    expect(sshRemoteCmd(3)).toBe("sudo systemctl daemon-reload");
    expect(sshRemoteCmd(4)).toBe(ENABLE_HAPROXY_FRAG_CMD);
    expect(core.info).toHaveBeenCalledWith(
      "[HAPROXY_SERVICE_INSTALL] Creating /etc/haproxy/conf.d/ early before uploading or enabling haproxy-frag…",
    );
    expect(core.info).toHaveBeenCalledWith(
      "[HAPROXY_SERVICE_INSTALL] /etc/haproxy/conf.d/ is ready before haproxy-frag enablement.",
    );
    expect(core.info).toHaveBeenCalledWith(
      "[HAPROXY_SERVICE_INSTALL] Enabling haproxy-frag service without starting it yet…",
    );
    expect(core.info).toHaveBeenCalledWith(
      "[HAPROXY_SERVICE_INSTALL] haproxy-frag service enabled successfully without starting it.",
    );
  });

  it("falls back to the inline service unit when the bundled template is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await expect(ensureHaproxyFragService(BASE_BASE_OPTS)).resolves.toBeUndefined();

    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(sshRemoteCmd(2)).toContain(HAPROXY_FRAG_SERVICE_FALLBACK);
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
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("tee failed"));

    await expect(ensureHaproxyFragService(BASE_BASE_OPTS)).rejects.toThrow(
      /HAPROXY_SERVICE_INSTALL: tee failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(3);
    expect(sshRemoteCmd(0)).toBe(STOP_DISABLE_HAPROXY_CMD);
    expect(sshRemoteCmd(1)).toBe(EARLY_CONF_DIR_MKDIR_CMD);
    expect(sshRemoteCmd(2)).toContain(`'${REMOTE_SERVICE_UNIT_PATH}'`);
  });

  it("wraps daemon-reload failures with HAPROXY_SERVICE_INSTALL", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("daemon-reload failed"));

    await expect(ensureHaproxyFragService(BASE_BASE_OPTS)).rejects.toThrow(
      /HAPROXY_SERVICE_INSTALL: daemon-reload failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(4);
    expect(sshRemoteCmd(3)).toBe("sudo systemctl daemon-reload");
  });

  it("wraps enable-only failures with HAPROXY_SERVICE_INSTALL", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("enable failed"));

    await expect(ensureHaproxyFragService(BASE_BASE_OPTS)).rejects.toThrow(
      /HAPROXY_SERVICE_INSTALL: enable failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(5);
    expect(sshRemoteCmd(4)).toBe(ENABLE_HAPROXY_FRAG_CMD);
  });

  it("tolerates default haproxy stop/disable failures and still proceeds", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("Failed to stop haproxy.service: Unit haproxy.service not loaded.")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");

    await expect(ensureHaproxyFragService(BASE_BASE_OPTS)).resolves.toBeUndefined();

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(5);
    expect(sshRemoteCmd(0)).toBe(STOP_DISABLE_HAPROXY_CMD);
    expect(sshRemoteCmd(1)).toBe(EARLY_CONF_DIR_MKDIR_CMD);
    expect(sshRemoteCmd(2)).toContain(`'${REMOTE_SERVICE_UNIT_PATH}'`);
    expect(sshRemoteCmd(3)).toBe("sudo systemctl daemon-reload");
    expect(sshRemoteCmd(4)).toBe(ENABLE_HAPROXY_FRAG_CMD);
  });

  it("wraps early conf.d creation failures with HAPROXY_SERVICE_INSTALL", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("mkdir failed"));

    await expect(ensureHaproxyFragService(BASE_BASE_OPTS)).rejects.toThrow(
      /HAPROXY_SERVICE_INSTALL: mkdir failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(2);
    expect(sshRemoteCmd(0)).toBe(STOP_DISABLE_HAPROXY_CMD);
    expect(sshRemoteCmd(1)).toBe(EARLY_CONF_DIR_MKDIR_CMD);
  });
});
