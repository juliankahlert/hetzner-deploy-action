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

import {
  installPackages,
  DEFAULT_PACKAGES,
} from "../src/deploy/packageInstall";
import { createDebianStrategy } from "../src/deploy/strategies/debian";
import { createFedoraStrategy } from "../src/deploy/strategies/fedora";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const FAKE_TMP = "/tmp";
const FAKE_TMP_DIR = "/tmp/hda-key-XXXXXX";

const BASE_OPTS = {
  host: "1.2.3.4",
  user: "root",
  privateKey: "TEST_KEY",
} as const;

const debianStrategy = createDebianStrategy();
const fedoraStrategy = createFedoraStrategy();

/** Extract the remote command (last SSH arg) from a given exec mock call. */
function remoteCmd(callIndex: number): string {
  const args = vi.mocked(exec.exec).mock.calls[callIndex][1]!;
  return args[args.length - 1];
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
  mockExecWithStdout(vi.mocked(exec.exec), "");
});

// ===========================================================================
// 1. Success path
// ===========================================================================

describe("installPackages — success path", () => {
  it("runs cloud-init wait, apt-get install, and dpkg verify for default packages", async () => {
    await installPackages({ ...BASE_OPTS, strategy: debianStrategy });

    // Stage 1: cloud-init
    expect(remoteCmd(0)).toBe("cloud-init status --wait");

    // Stage 2: apt-get install (shell-quoted package names)
    expect(remoteCmd(1)).toBe(
      `sudo apt-get update -qq && sudo apt-get install -y -qq ${DEFAULT_PACKAGES.map((p) => `'${p}'`).join(" ")}`,
    );

    // Stage 3: verify — one dpkg -s per package (shell-quoted)
    for (let i = 0; i < DEFAULT_PACKAGES.length; i++) {
      expect(remoteCmd(2 + i)).toBe(`dpkg -s '${DEFAULT_PACKAGES[i]}'`);
    }
  });

  it("accepts a custom packages list", async () => {
    await installPackages({
      ...BASE_OPTS,
      packages: ["nginx"],
      strategy: debianStrategy,
    });

    expect(remoteCmd(1)).toBe(
      "sudo apt-get update -qq && sudo apt-get install -y -qq 'nginx'",
    );
    expect(remoteCmd(2)).toBe("dpkg -s 'nginx'");
  });

  it("defaults to Debian strategy when omitted", async () => {
    await installPackages(BASE_OPTS);

    expect(remoteCmd(1)).toBe(
      `sudo apt-get update -qq && sudo apt-get install -y -qq ${DEFAULT_PACKAGES.map((p) => `'${p}'`).join(" ")}`,
    );
    expect(remoteCmd(2)).toBe(`dpkg -s '${DEFAULT_PACKAGES[0]}'`);
  });

  it("uses Fedora strategy commands when provided", async () => {
    await installPackages({
      ...BASE_OPTS,
      packages: ["podman", "haproxy"],
      strategy: fedoraStrategy,
    });

    expect(remoteCmd(1)).toBe(
      "sudo dnf install -y --setopt=install_weak_deps=False 'podman' 'haproxy'",
    );
    expect(remoteCmd(2)).toBe("rpm -q 'podman'");
    expect(remoteCmd(3)).toBe("rpm -q 'haproxy'");
  });

  it("logs stage labels with PACKAGE_INSTALL_ prefix", async () => {
    await installPackages({ ...BASE_OPTS, strategy: debianStrategy });

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("[PACKAGE_INSTALL_CLOUD_INIT]"),
    );
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("[PACKAGE_INSTALL_INSTALL]"),
    );
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("[PACKAGE_INSTALL_VERIFY]"),
    );
  });

  it("includes default packages podman and haproxy", () => {
    expect(DEFAULT_PACKAGES).toContain("podman");
    expect(DEFAULT_PACKAGES).toContain("haproxy");
  });
});

// ===========================================================================
// 2. Cloud-init failure
// ===========================================================================

describe("installPackages — cloud-init failure", () => {
  it("throws with PACKAGE_INSTALL_CLOUD_INIT prefix", async () => {
    vi.mocked(exec.exec).mockRejectedValueOnce(new Error("timed out"));

    await expect(
      installPackages({ ...BASE_OPTS, strategy: debianStrategy }),
    ).rejects.toThrow(
      /PACKAGE_INSTALL_CLOUD_INIT/,
    );
  });

  it("includes the original error message", async () => {
    vi.mocked(exec.exec).mockRejectedValueOnce(
      new Error("cloud-init not found"),
    );

    await expect(
      installPackages({ ...BASE_OPTS, strategy: debianStrategy }),
    ).rejects.toThrow(
      /cloud-init not found/,
    );
  });
});

// ===========================================================================
// 3. Install failure
// ===========================================================================

describe("installPackages — install failure", () => {
  it("throws with PACKAGE_INSTALL_INSTALL prefix", async () => {
    // cloud-init succeeds, install fails
    vi.mocked(exec.exec)
      .mockImplementationOnce(async (_cmd, _args, opts) => {
        opts?.listeners?.stdout?.(Buffer.from(""));
        return 0;
      })
      .mockRejectedValueOnce(new Error("apt-get failed"));

    await expect(
      installPackages({ ...BASE_OPTS, strategy: debianStrategy }),
    ).rejects.toThrow(
      /PACKAGE_INSTALL_INSTALL/,
    );
  });
});

// ===========================================================================
// 4. Verify failure
// ===========================================================================

describe("installPackages — verify failure", () => {
  it("throws with PACKAGE_INSTALL_VERIFY prefix", async () => {
    // cloud-init succeeds, install succeeds, verify fails
    vi.mocked(exec.exec)
      .mockImplementationOnce(async (_cmd, _args, opts) => {
        opts?.listeners?.stdout?.(Buffer.from(""));
        return 0;
      })
      .mockImplementationOnce(async (_cmd, _args, opts) => {
        opts?.listeners?.stdout?.(Buffer.from(""));
        return 0;
      })
      .mockRejectedValueOnce(new Error("package not found"));

    await expect(
      installPackages({ ...BASE_OPTS, strategy: debianStrategy }),
    ).rejects.toThrow(
      /PACKAGE_INSTALL_VERIFY/,
    );
  });

  it("includes the original error message in verify failure", async () => {
    vi.mocked(exec.exec)
      .mockImplementationOnce(async (_cmd, _args, opts) => {
        opts?.listeners?.stdout?.(Buffer.from(""));
        return 0;
      })
      .mockImplementationOnce(async (_cmd, _args, opts) => {
        opts?.listeners?.stdout?.(Buffer.from(""));
        return 0;
      })
      .mockRejectedValueOnce(new Error("dpkg: package nginx not installed"));

    await expect(
      installPackages({ ...BASE_OPTS, strategy: debianStrategy }),
    ).rejects.toThrow(
      /dpkg: package nginx not installed/,
    );
  });
});

// ===========================================================================
// 5. Input validation
// ===========================================================================

describe("installPackages — input validation", () => {
  it("rejects an empty package list", async () => {
    await expect(
      installPackages({ ...BASE_OPTS, packages: [] }),
    ).rejects.toThrow(/PACKAGE_INSTALL_VALIDATE.*must not be empty/);
  });

  it("rejects names with shell metacharacters", async () => {
    await expect(
      installPackages({ ...BASE_OPTS, packages: ["foo;rm -rf /"] }),
    ).rejects.toThrow(/PACKAGE_INSTALL_VALIDATE.*invalid package name/);
  });

  it("rejects single-character names (minimum 2 chars)", async () => {
    await expect(
      installPackages({ ...BASE_OPTS, packages: ["x"] }),
    ).rejects.toThrow(/PACKAGE_INSTALL_VALIDATE.*invalid package name/);
  });

  it("rejects names starting with a non-alphanumeric character", async () => {
    await expect(
      installPackages({ ...BASE_OPTS, packages: ["-bad"] }),
    ).rejects.toThrow(/PACKAGE_INSTALL_VALIDATE.*invalid package name/);
  });

  it("rejects uppercase package names", async () => {
    await expect(
      installPackages({ ...BASE_OPTS, packages: ["Nginx"] }),
    ).rejects.toThrow(/PACKAGE_INSTALL_VALIDATE.*invalid package name/);
  });

  it("accepts Fedora-valid package names with uppercase letters", async () => {
    await expect(
      installPackages({
        ...BASE_OPTS,
        packages: ["Nginx"],
        strategy: fedoraStrategy,
      }),
    ).resolves.toBeUndefined();

    expect(remoteCmd(1)).toBe(
      "sudo dnf install -y --setopt=install_weak_deps=False 'Nginx'",
    );
    expect(remoteCmd(2)).toBe("rpm -q 'Nginx'");
  });

  it("does not create a key file when validation fails", async () => {
    await installPackages({
      ...BASE_OPTS,
      packages: [],
      strategy: debianStrategy,
    }).catch(() => {});

    expect(fs.mkdtempSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
