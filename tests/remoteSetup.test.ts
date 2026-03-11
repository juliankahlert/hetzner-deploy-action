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
  ensureTargetDir,
  installSystemdUnit,
  remoteSetup,
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
  "Type=simple",
  "User={{USER}}",
  "WorkingDirectory={{WORKING_DIR}}",
  "ExecStart={{EXEC_START}}",
  "Restart=on-failure",
  "RestartSec=5",
  "StandardOutput=journal",
  "StandardError=journal",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
].join("\n");

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
// 2 & 3. installSystemdUnit — template branches, upload, daemon-reload, etc.
// ===========================================================================

describe("installSystemdUnit", () => {
  describe("template rendering", () => {
    it("reads and renders file-based template when it exists", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true as never);
      vi.mocked(fs.readFileSync).mockReturnValue(FILE_TEMPLATE as never);

      await installSystemdUnit(UNIT_OPTS);

      expect(fs.readFileSync).toHaveBeenCalledOnce();

      // File template has StandardOutput/StandardError markers
      const cmd = remoteCmd(0);
      expect(cmd).toContain("StandardOutput=journal");
      expect(cmd).toContain("StandardError=journal");
      // Placeholders substituted
      expect(cmd).toContain("Description=myapp");
      expect(cmd).toContain("User=deploy");
      expect(cmd).toContain("WorkingDirectory=/opt/app");
      expect(cmd).toContain("ExecStart=/usr/bin/node index.js");
    });

    it("uses fallback template when file is missing", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false as never);

      await installSystemdUnit(UNIT_OPTS);

      expect(fs.readFileSync).not.toHaveBeenCalled();

      const cmd = remoteCmd(0);
      // Fallback template lacks StandardOutput/StandardError
      expect(cmd).not.toContain("StandardOutput=journal");
      expect(cmd).not.toContain("StandardError=journal");
      // Core substitutions still applied
      expect(cmd).toContain("Description=myapp");
      expect(cmd).toContain("User=deploy");
      expect(cmd).toContain("ExecStart=/usr/bin/node index.js");
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
// 4 & 5. remoteSetup
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
// 6. IPv6 handling
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
// 7. Key file cleanup (finally behaviour)
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
