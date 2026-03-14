import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockExecWithStdout } from "./helpers/mockExec";

// ---------------------------------------------------------------------------
// Module mocks — declared before imports that trigger them
// ---------------------------------------------------------------------------

vi.mock("@actions/core", async () => {
  const { createCoreMock } = await import("./helpers/mockCore");
  return createCoreMock();
});

vi.mock("@actions/exec", async () => {
  const { createExecMock } = await import("./helpers/mockExec");
  return createExecMock();
});

vi.mock("node:fs", () => ({
  mkdtempSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmdirSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  tmpdir: vi.fn(),
}));

vi.mock("node:path", () => ({
  join: vi.fn((...segments: string[]) => segments.join("/")),
  dirname: vi.fn((p: string) => p.substring(0, p.lastIndexOf("/"))),
  resolve: vi.fn((...segments: string[]) => segments.join("/")),
}));

// ---------------------------------------------------------------------------
// Imports (receive mocked implementations)
// ---------------------------------------------------------------------------

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ensureServiceUser,
  ensureTargetDir,
  installSystemdUnit,
  remoteSetup,
  setTargetOwnership,
} from "../src/deploy/remoteSetup";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const FAKE_TMP = "/tmp";
const FAKE_TMP_DIR = "/tmp/hda-key-XXXXXX";
const FAKE_KEY_FILE = "/tmp/hda-key-XXXXXX/id";

const BASE_OPTS = {
  host: "1.2.3.4",
  user: "root",
  privateKey: "TEST_PRIVATE_KEY",
  targetDir: "/opt/app",
} as const;

const UNIT_OPTS = {
  ...BASE_OPTS,
  user: "deploy",
  serviceName: "myapp",
  execStart: "/usr/bin/node index.js",
} as const;

/** File-based template with markers that distinguish it from the fallback. */
const FILE_TEMPLATE = [
  "[Unit]",
  "Description={{SERVICE_NAME}}",
  "After=network.target",
  "",
  "[Service]",
  "Type={{SERVICE_TYPE}}",
  "User={{USER}}",
  "WorkingDirectory={{WORKING_DIR}}",
  "ExecStart={{EXEC_START}}",
  "Restart={{SERVICE_RESTART}}",
  "RestartSec={{SERVICE_RESTART_SEC}}",
  "StandardOutput=journal",
  "StandardError=journal",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
].join("\n");

function uploadedUnitContent(callIndex: number): string {
  const cmd = remoteCmd(callIndex);
  const match = cmd.match(/<< 'UNIT_EOF'\n([\s\S]*)\nUNIT_EOF$/);

  expect(match).not.toBeNull();
  return match![1];
}

/** Extract the remote command (last SSH arg) from a given exec mock call. */
function remoteCmd(callIndex: number): string {
  const args = vi.mocked(exec.exec).mock.calls[callIndex][1]!;
  return args[args.length - 1];
}

/** Extract the full SSH arg array from a given exec mock call. */
function sshArgs(callIndex: number): string[] {
  return vi.mocked(exec.exec).mock.calls[callIndex][1]! as string[];
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  // Re-establish default behaviours after reset
  vi.mocked(os.tmpdir).mockReturnValue(FAKE_TMP);
  vi.mocked(fs.mkdtempSync).mockReturnValue(FAKE_TMP_DIR);
  vi.mocked(fs.existsSync).mockReturnValue(false as never);
  vi.mocked(path.join).mockImplementation(
    (...segments: string[]) => segments.join("/"),
  );
  vi.mocked(path.dirname).mockImplementation(
    (p: string) => p.substring(0, p.lastIndexOf("/")),
  );
  vi.mocked(path.resolve).mockImplementation(
    (...segments: string[]) => segments.join("/"),
  );
  mockExecWithStdout(vi.mocked(exec.exec), "");
});

// ===========================================================================
// 1. ensureTargetDir
// ===========================================================================

describe("ensureTargetDir", () => {
  it("builds ssh command with sudo mkdir -p and shell-quoted path", async () => {
    await ensureTargetDir(BASE_OPTS);

    expect(exec.exec).toHaveBeenCalledOnce();
    const [cmd] = vi.mocked(exec.exec).mock.calls[0];
    expect(cmd).toBe("ssh");

    const args = sshArgs(0);
    expect(args).toEqual(expect.arrayContaining(["-i", FAKE_KEY_FILE]));
    expect(args).toContain("root@1.2.3.4");
    expect(remoteCmd(0)).toBe("sudo mkdir -p '/opt/app'");
  });

  it("shell-quotes paths containing embedded single quotes", async () => {
    await ensureTargetDir({
      ...BASE_OPTS,
      targetDir: "/opt/it's here",
    });

    // shellQuote escapes ' via the '\'' trick
    expect(remoteCmd(0)).toBe("sudo mkdir -p '/opt/it'\\''s here'");
  });
});

// ===========================================================================
// 2. ensureServiceUser / setTargetOwnership
// ===========================================================================

describe("remote setup helpers", () => {
  it("ensureServiceUser runs idempotent ssh command and returns success flag", async () => {
    const result = await ensureServiceUser({
      ...BASE_OPTS,
      serviceUser: "deploy",
    });

    expect(exec.exec).toHaveBeenCalledOnce();
    expect(remoteCmd(0)).toBe(
      "id 'deploy' 2>/dev/null || sudo useradd --system --no-create-home --shell /usr/sbin/nologin 'deploy'",
    );
    expect(result).toEqual({ serviceUserEnsured: true });

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("Ensuring service user deploy exists on 1.2.3.4"),
    );
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("Service user deploy is ready."),
    );
  });

  it("setTargetOwnership runs quoted chown command and returns success flag", async () => {
    const result = await setTargetOwnership({
      ...BASE_OPTS,
      serviceUser: "deploy",
      targetDir: "/opt/it's here",
    });

    expect(exec.exec).toHaveBeenCalledOnce();
    expect(remoteCmd(0)).toBe(
      "sudo chown -R 'deploy':'deploy' '/opt/it'\\''s here'",
    );
    expect(result).toEqual({ targetOwnershipReset: true });

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("Resetting ownership for /opt/it's here to deploy:deploy on 1.2.3.4"),
    );
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("Ownership reset for /opt/it's here."),
    );
  });
});

// ===========================================================================
// 3 & 4. installSystemdUnit — template branches, upload, daemon-reload, etc.
// ===========================================================================

describe("installSystemdUnit", () => {
  describe("template rendering", () => {
    it("reads and renders file-based template with all seven placeholders", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true as never);
      vi.mocked(fs.readFileSync).mockReturnValue(FILE_TEMPLATE as never);

      await installSystemdUnit({
        ...UNIT_OPTS,
        serviceType: "notify",
        serviceRestart: "always",
        serviceRestartSec: 15,
      });

      expect(fs.readFileSync).toHaveBeenCalledOnce();

      const unitContent = uploadedUnitContent(0);
      expect(unitContent).toContain("Description=myapp");
      expect(unitContent).toContain("Type=notify");
      expect(unitContent).toContain("User=deploy");
      expect(unitContent).toContain("WorkingDirectory=/opt/app");
      expect(unitContent).toContain("ExecStart=/usr/bin/node index.js");
      expect(unitContent).toContain("Restart=always");
      expect(unitContent).toContain("RestartSec=15");
      expect(unitContent).toContain("StandardOutput=journal");
      expect(unitContent).toContain("StandardError=journal");
    });

    it("uses fallback template with journal lines and matching placeholders", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false as never);

      await installSystemdUnit({
        ...UNIT_OPTS,
        serviceType: "exec",
        serviceRestart: "always",
        serviceRestartSec: "30s",
      });

      expect(fs.readFileSync).not.toHaveBeenCalled();

      const unitContent = uploadedUnitContent(0);
      expect(unitContent).toContain("Description=myapp");
      expect(unitContent).toContain("Type=exec");
      expect(unitContent).toContain("User=deploy");
      expect(unitContent).toContain("WorkingDirectory=/opt/app");
      expect(unitContent).toContain("ExecStart=/usr/bin/node index.js");
      expect(unitContent).toContain("Restart=always");
      expect(unitContent).toContain("RestartSec=30s");
      expect(unitContent).toContain("StandardOutput=journal");
      expect(unitContent).toContain("StandardError=journal");
    });

    it("applies simple/on-failure/5 defaults when service fields are omitted", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false as never);

      await installSystemdUnit(UNIT_OPTS);

      const unitContent = uploadedUnitContent(0);
      expect(unitContent).toContain("Type=simple");
      expect(unitContent).toContain("Restart=on-failure");
      expect(unitContent).toContain("RestartSec=5");
    });
  });

  describe("ssh commands and behaviour", () => {
    it("uploads unit via heredoc with sudo tee", async () => {
      await installSystemdUnit(UNIT_OPTS);

      const cmd = remoteCmd(0);
      expect(cmd).toMatch(
        /^sudo tee '\/etc\/systemd\/system\/myapp\.service'/,
      );
      expect(cmd).toContain("UNIT_EOF");
    });

    it("runs daemon-reload after upload", async () => {
      await installSystemdUnit(UNIT_OPTS);

      expect(remoteCmd(1)).toBe("sudo systemctl daemon-reload");
    });

    it("enables and restarts the service", async () => {
      await installSystemdUnit(UNIT_OPTS);

      expect(remoteCmd(2)).toBe(
        "sudo systemctl enable 'myapp' && sudo systemctl restart 'myapp'",
      );
    });

    it("returns { unitInstalled: true, serviceRestarted: true }", async () => {
      const result = await installSystemdUnit(UNIT_OPTS);

      expect(result).toEqual({
        unitInstalled: true,
        serviceRestarted: true,
      });
    });
  });

  it("uses default execStart placeholder when execStart is omitted", async () => {
    await installSystemdUnit({
      ...BASE_OPTS,
      user: "deploy",
      serviceName: "myapp",
    });

    const cmd = remoteCmd(0);
    expect(cmd).toContain(
      `ExecStart=/usr/bin/env bash -c 'echo "myapp started"'`,
    );
  });
});

// ===========================================================================
// 5 & 6. remoteSetup
// ===========================================================================

describe("remoteSetup", () => {
  it("without serviceName: skips unit install and returns flags false", async () => {
    const result = await remoteSetup(BASE_OPTS);

    expect(result).toEqual({
      unitInstalled: false,
      serviceRestarted: false,
    });

    // Only the mkdir call from ensureTargetDir
    expect(exec.exec).toHaveBeenCalledOnce();
    expect(remoteCmd(0)).toMatch(/^sudo mkdir -p/);

    // core.info mentions skipping
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("skipping"),
    );
  });

  it("with serviceName: delegates to both helpers and returns expected result", async () => {
    const result = await remoteSetup({
      ...BASE_OPTS,
      serviceName: "webapp",
      execStart: "/usr/bin/node serve.js",
    });

    expect(result).toEqual({
      unitInstalled: true,
      serviceRestarted: true,
    });

    // 1 mkdir + 3 systemd-related ssh calls = 4
    expect(exec.exec).toHaveBeenCalledTimes(4);

    // Call 0: mkdir from ensureTargetDir
    expect(remoteCmd(0)).toMatch(/^sudo mkdir -p/);
    // Call 1: heredoc upload from installSystemdUnit
    expect(remoteCmd(1)).toMatch(/^sudo tee/);
    // Call 2: daemon-reload
    expect(remoteCmd(2)).toBe("sudo systemctl daemon-reload");
    // Call 3: enable + restart
    expect(remoteCmd(3)).toContain("systemctl enable");
    expect(remoteCmd(3)).toContain("systemctl restart");
  });
});

// ===========================================================================
// 7. IPv6 handling
// ===========================================================================

describe("IPv6 handling", () => {
  const IPV6_HOST = "2001:db8::1";

  it("passes -6 flag when ipv6Only is true", async () => {
    await ensureTargetDir({
      ...BASE_OPTS,
      host: IPV6_HOST,
      ipv6Only: true,
    });

    expect(sshArgs(0)).toContain("-6");
  });

  it("brackets IPv6 host in ssh destination", async () => {
    await ensureTargetDir({
      ...BASE_OPTS,
      host: IPV6_HOST,
      ipv6Only: true,
    });

    expect(sshArgs(0)).toContain(`root@[${IPV6_HOST}]`);
  });

  it("brackets IPv6 host even when ipv6Only is false", async () => {
    await ensureTargetDir({
      ...BASE_OPTS,
      host: IPV6_HOST,
      ipv6Only: false,
    });

    const args = sshArgs(0);
    expect(args).not.toContain("-6");
    expect(args).toContain(`root@[${IPV6_HOST}]`);
  });

  it("wraps SSH error with IPv6 connectivity hint when ipv6Only is true", async () => {
    vi.mocked(exec.exec).mockRejectedValueOnce(
      new Error("connection refused"),
    );

    await expect(
      ensureTargetDir({
        ...BASE_OPTS,
        host: IPV6_HOST,
        ipv6Only: true,
      }),
    ).rejects.toThrow(/SSH failed \(IPv6-only mode\)/);
  });

  it("rethrows original error when ipv6Only is false", async () => {
    const original = new Error("connection refused");
    vi.mocked(exec.exec).mockRejectedValueOnce(original);

    await expect(
      ensureTargetDir({
        ...BASE_OPTS,
        host: IPV6_HOST,
        ipv6Only: false,
      }),
    ).rejects.toBe(original);
  });
});

// ===========================================================================
// 8. Key file cleanup (finally behaviour)
// ===========================================================================

describe("key file cleanup", () => {
  it("writes private key to temp file with mode 0600", async () => {
    await ensureTargetDir(BASE_OPTS);

    expect(fs.mkdtempSync).toHaveBeenCalledWith(`${FAKE_TMP}/hda-key-`);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      FAKE_KEY_FILE,
      "TEST_PRIVATE_KEY\n",
      { mode: 0o600 },
    );
  });

  it("removes key file and parent directory after success", async () => {
    await ensureTargetDir(BASE_OPTS);

    expect(fs.unlinkSync).toHaveBeenCalledWith(FAKE_KEY_FILE);
    expect(fs.rmdirSync).toHaveBeenCalledWith(FAKE_TMP_DIR);
  });

  it("cleans up key file even when SSH command fails", async () => {
    vi.mocked(exec.exec).mockRejectedValueOnce(new Error("network down"));

    await ensureTargetDir(BASE_OPTS).catch(() => {});

    // Finally block should still have run
    expect(fs.unlinkSync).toHaveBeenCalledWith(FAKE_KEY_FILE);
    expect(fs.rmdirSync).toHaveBeenCalledWith(FAKE_TMP_DIR);
  });
});
