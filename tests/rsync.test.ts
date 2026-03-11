import { describe, it, expect, vi, beforeEach } from "vitest";

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
}));

vi.mock("node:os", () => ({
  tmpdir: vi.fn(),
}));

vi.mock("node:path", () => ({
  join: vi.fn((...segments: string[]) => segments.join("/")),
  dirname: vi.fn((p: string) => p.substring(0, p.lastIndexOf("/"))),
}));

// ---------------------------------------------------------------------------
// Imports (receive mocked implementations)
// ---------------------------------------------------------------------------

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { rsyncDeploy, type RsyncOptions } from "../src/deploy/rsync";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const FAKE_TMP = "/tmp";
const FAKE_TMP_DIR = "/tmp/hda-key-XXXXXX";
const FAKE_KEY_FILE = "/tmp/hda-key-XXXXXX/id";

/** Builds an RsyncOptions object with sensible IPv4 defaults. */
function makeOpts(overrides?: Partial<RsyncOptions>): RsyncOptions {
  return {
    host: "1.2.3.4",
    user: "deploy",
    sourceDir: "./dist",
    targetDir: "/opt/app",
    sshKey: "-----BEGIN KEY-----\ndata\n-----END KEY-----\n",
    ipv6Only: false,
    port: 22,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  // Re-establish default behaviours after reset
  vi.mocked(os.tmpdir).mockReturnValue(FAKE_TMP);
  vi.mocked(fs.mkdtempSync).mockReturnValue(FAKE_TMP_DIR);
  vi.mocked(path.join).mockImplementation(
    (...segments: string[]) => segments.join("/"),
  );
  vi.mocked(path.dirname).mockImplementation(
    (p: string) => p.substring(0, p.lastIndexOf("/")),
  );
  vi.mocked(exec.exec).mockResolvedValue(0);
});

// ---------------------------------------------------------------------------
// 1. Happy path — IPv4
// ---------------------------------------------------------------------------

describe("rsyncDeploy — happy path IPv4", () => {
  it("writes SSH key to a temp file with mode 0600", async () => {
    await rsyncDeploy(makeOpts());

    expect(fs.mkdtempSync).toHaveBeenCalledWith(`${FAKE_TMP}/hda-key-`);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      FAKE_KEY_FILE,
      expect.any(String),
      { mode: 0o600 },
    );
  });

  it("invokes rsync with SSH command and correct destination", async () => {
    await rsyncDeploy(makeOpts());

    expect(exec.exec).toHaveBeenCalledOnce();
    const [cmd, args, opts] = vi.mocked(exec.exec).mock.calls[0];
    expect(cmd).toBe("rsync");
    expect(args).toEqual(
      expect.arrayContaining(["-avz", "--delete", "--protect-args", "-e"]),
    );

    // SSH command includes key file and host-key settings
    const sshCmd = args![args!.indexOf("-e") + 1];
    expect(sshCmd).toContain(`-i ${FAKE_KEY_FILE}`);
    expect(sshCmd).toContain("-p 22");
    expect(sshCmd).toContain("StrictHostKeyChecking=accept-new");

    // Destination: user@host:targetDir
    expect(args).toContain("deploy@1.2.3.4:/opt/app");
    expect(opts).toEqual({ silent: false });
  });

  it("cleans up temp key and directory after transfer", async () => {
    await rsyncDeploy(makeOpts());

    expect(fs.unlinkSync).toHaveBeenCalledWith(FAKE_KEY_FILE);
    expect(fs.rmdirSync).toHaveBeenCalledWith(FAKE_TMP_DIR);
  });
});

// ---------------------------------------------------------------------------
// 2. Happy path — IPv6
// ---------------------------------------------------------------------------

describe("rsyncDeploy — happy path IPv6", () => {
  const ipv6Host = "2001:db8::1";

  it("includes -6 flag in SSH arguments when ipv6Only is true", async () => {
    await rsyncDeploy(makeOpts({ host: ipv6Host, ipv6Only: true }));

    const args = vi.mocked(exec.exec).mock.calls[0][1]!;
    const sshCmd = args[args.indexOf("-e") + 1];
    expect(sshCmd).toContain(" -6");
  });

  it("uses bracketed host in destination", async () => {
    await rsyncDeploy(makeOpts({ host: ipv6Host, ipv6Only: true }));

    const args = vi.mocked(exec.exec).mock.calls[0][1]!;
    expect(args).toContain(`deploy@[${ipv6Host}]:/opt/app`);
  });

  it("brackets IPv6 address even when ipv6Only is false", async () => {
    await rsyncDeploy(makeOpts({ host: ipv6Host, ipv6Only: false }));

    const args = vi.mocked(exec.exec).mock.calls[0][1]!;
    expect(args).toContain(`deploy@[${ipv6Host}]:/opt/app`);
    const sshCmd = args[args.indexOf("-e") + 1];
    expect(sshCmd).not.toContain("-6");
  });
});

// ---------------------------------------------------------------------------
// 3. exec throw path
// ---------------------------------------------------------------------------

describe("rsyncDeploy — exec throw path", () => {
  it("wraps error with IPv6 hint when ipv6Only is true", async () => {
    vi.mocked(exec.exec).mockRejectedValueOnce(
      new Error("Connection refused"),
    );

    const err = await rsyncDeploy(
      makeOpts({ host: "2001:db8::1", ipv6Only: true }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("IPv6-only mode");
    expect((err as Error).message).toContain("ipv6_only: false");
  });

  it("rethrows original error when ipv6Only is false", async () => {
    const original = new Error("Connection refused");
    vi.mocked(exec.exec).mockRejectedValueOnce(original);

    await expect(
      rsyncDeploy(makeOpts({ ipv6Only: false })),
    ).rejects.toBe(original);
  });
});

// ---------------------------------------------------------------------------
// 4. Non-zero exit code
// ---------------------------------------------------------------------------

describe("rsyncDeploy — non-zero exit code", () => {
  it("throws error containing the exit code", async () => {
    vi.mocked(exec.exec).mockResolvedValueOnce(23);

    await expect(rsyncDeploy(makeOpts())).rejects.toThrow(
      "rsync exited with code 23",
    );
  });

  it("includes IPv6 hint when ipv6Only is true and exit code is non-zero", async () => {
    vi.mocked(exec.exec).mockResolvedValueOnce(12);

    const err = await rsyncDeploy(
      makeOpts({ host: "2001:db8::1", ipv6Only: true }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/exited with code 12/);
    expect((err as Error).message).toMatch(/IPv6-only mode/);
  });
});

// ---------------------------------------------------------------------------
// 5. Source directory trailing slash normalisation
// ---------------------------------------------------------------------------

describe("rsyncDeploy — trailing slash normalisation", () => {
  it("appends trailing slash when sourceDir lacks one", async () => {
    await rsyncDeploy(makeOpts({ sourceDir: "./build" }));

    const args = vi.mocked(exec.exec).mock.calls[0][1]!;
    expect(args).toContain("./build/");
  });

  it("does not duplicate an existing trailing slash", async () => {
    await rsyncDeploy(makeOpts({ sourceDir: "./build/" }));

    const args = vi.mocked(exec.exec).mock.calls[0][1]!;
    const sourceArg = args.find((a) => a.startsWith("./build"));
    expect(sourceArg).toBe("./build/");
  });
});

// ---------------------------------------------------------------------------
// 6. Cleanup in finally block on failure
// ---------------------------------------------------------------------------

describe("rsyncDeploy — cleanup on failure", () => {
  it("removes temp files even when exec rejects", async () => {
    vi.mocked(exec.exec).mockRejectedValueOnce(new Error("network down"));

    await rsyncDeploy(makeOpts()).catch(() => {});

    expect(fs.unlinkSync).toHaveBeenCalledWith(FAKE_KEY_FILE);
    expect(fs.rmdirSync).toHaveBeenCalledWith(FAKE_TMP_DIR);
  });

  it("emits warning when cleanup itself fails", async () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    await rsyncDeploy(makeOpts());

    expect(core.warning).toHaveBeenCalledWith(
      "Failed to remove temporary SSH key file.",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Input validation
// ---------------------------------------------------------------------------

describe("rsyncDeploy — input validation", () => {
  it("rejects a relative targetDir", async () => {
    await expect(
      rsyncDeploy(makeOpts({ targetDir: "relative/path" })),
    ).rejects.toThrow(/invalid target directory/);
  });

  it("rejects targetDir with shell metacharacters", async () => {
    await expect(
      rsyncDeploy(makeOpts({ targetDir: "/opt/app;rm -rf /" })),
    ).rejects.toThrow(/invalid target directory/);
  });

  it("rejects user with shell metacharacters", async () => {
    await expect(
      rsyncDeploy(makeOpts({ user: "user;whoami" })),
    ).rejects.toThrow(/invalid SSH user/);
  });

  it("does not create a key file when validation fails", async () => {
    await rsyncDeploy(makeOpts({ targetDir: "bad" })).catch(() => {});

    expect(fs.mkdtempSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
