import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before imports that trigger them
// ---------------------------------------------------------------------------

vi.mock("@actions/core", async () => {
  const { createCoreMock } = await import("./helpers/mockCore");
  return createCoreMock();
});

vi.mock("../src/deploy/ssh.js", () => ({
  withKeyFile: vi.fn(),
  sshExec: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (receive mocked implementations)
// ---------------------------------------------------------------------------

import * as core from "@actions/core";
import * as ssh from "../src/deploy/ssh.js";

import {
  createStrategyForFamily,
  detectOs,
  detectOsFromSlug,
  parseOsRelease,
} from "../src/deploy/osDetect.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAKE_KEY_PATH = "/tmp/hda-key-XXXXXX/id";

const BASE_OPTIONS = {
  image: "ubuntu-24.04",
  host: "1.2.3.4",
  user: "root",
  privateKey: "TEST_PRIVATE_KEY",
  ipv6Only: false,
} as const;

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  vi.mocked(ssh.withKeyFile).mockImplementation(
    async (_privateKey: string, fn: (keyPath: string) => Promise<unknown>) =>
      fn(FAKE_KEY_PATH),
  );
  vi.mocked(ssh.sshExec).mockResolvedValue("ID=ubuntu\nID_LIKE=debian\n");
});

describe("detectOsFromSlug", () => {
  it("maps ubuntu and debian slugs to the debian family", () => {
    expect(detectOsFromSlug("ubuntu-24.04")).toBe("debian");
    expect(detectOsFromSlug("debian-12")).toBe("debian");
  });

  it("maps fedora, centos, and rocky slugs to the fedora family", () => {
    expect(detectOsFromSlug("fedora-40")).toBe("fedora");
    expect(detectOsFromSlug("centos-stream-9")).toBe("fedora");
    expect(detectOsFromSlug("rocky-9")).toBe("fedora");
    expect(detectOsFromSlug("rhel-9.4")).toBe("fedora");
  });

  it("returns null for unknown slugs", () => {
    expect(detectOsFromSlug("freebsd-14")).toBeNull();
  });
});

describe("parseOsRelease", () => {
  it("parses debian-family identifiers from ID_LIKE", () => {
    const family = parseOsRelease([
      'NAME="Linux Mint"',
      "ID=linuxmint",
      'ID_LIKE="ubuntu debian"',
    ].join("\n"));

    expect(family).toBe("debian");
    expect(core.debug).toHaveBeenCalledWith(
      expect.stringContaining(
        '[OS_DETECT] Parsed /etc/os-release identifiers: ID="linuxmint", ID_LIKE=["ubuntu","debian"].',
      ),
    );
  });

  it("parses fedora-family identifiers from ID and ID_LIKE", () => {
    expect(parseOsRelease("ID=rocky\n")).toBe("fedora");

    const family = parseOsRelease([
      'NAME="AlmaLinux"',
      "ID=almalinux",
      'ID_LIKE="rhel fedora"',
    ].join("\n"));

    expect(family).toBe("fedora");
  });

  it("throws OS_DETECT_UNSUPPORTED for unknown os-release content", () => {
    expect(() => parseOsRelease("ID=arch\nID_LIKE=rolling\n")).toThrow(
      /OS_DETECT_UNSUPPORTED/,
    );
  });
});

describe("createStrategyForFamily", () => {
  it("returns strategies with the requested family", () => {
    const debianStrategy = createStrategyForFamily("debian");
    const fedoraStrategy = createStrategyForFamily("fedora");

    expect(debianStrategy.family).toBe("debian");
    expect(fedoraStrategy.family).toBe("fedora");
    expect(Object.isFrozen(debianStrategy)).toBe(true);
    expect(Object.isFrozen(debianStrategy.packages)).toBe(true);
    expect(Object.isFrozen(debianStrategy.firewall)).toBe(true);
    expect(Object.isFrozen(fedoraStrategy)).toBe(true);
    expect(Object.isFrozen(fedoraStrategy.packages)).toBe(true);
    expect(Object.isFrozen(fedoraStrategy.firewall)).toBe(true);
  });
});

describe("detectOs", () => {
  it("uses the slug fast path and skips SSH fallback", async () => {
    const strategy = await detectOs(BASE_OPTIONS);

    expect(strategy.family).toBe("debian");
    expect(ssh.withKeyFile).not.toHaveBeenCalled();
    expect(ssh.sshExec).not.toHaveBeenCalled();

    expect(core.info).toHaveBeenCalledWith(
      "[OS_DETECT] Starting OS detection for 1.2.3.4.",
    );
    expect(core.debug).toHaveBeenCalledWith(
      '[OS_DETECT] Evaluating image slug "ubuntu-24.04".',
    );
    expect(core.info).toHaveBeenCalledWith(
      "[OS_DETECT] Detected debian family from image slug.",
    );
    expect(core.info).toHaveBeenCalledWith(
      "[OS_DETECT] Completed OS detection with debian strategy.",
    );
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("warns and falls back to reading /etc/os-release over SSH when the slug is unknown", async () => {
    const osRelease = 'ID="rocky"\nNAME="Rocky Linux"\n';
    vi.mocked(ssh.sshExec).mockResolvedValue(osRelease);

    const strategy = await detectOs({
      ...BASE_OPTIONS,
      image: "my-custom-image",
    });

    expect(strategy.family).toBe("fedora");
    expect(ssh.withKeyFile).toHaveBeenCalledWith(
      "TEST_PRIVATE_KEY",
      expect.any(Function),
    );
    expect(ssh.sshExec).toHaveBeenCalledWith(
      FAKE_KEY_PATH,
      "root",
      "1.2.3.4",
      "cat /etc/os-release",
      false,
    );

    expect(core.warning).toHaveBeenCalledWith(
      '[OS_DETECT] Unsupported or unknown image slug "my-custom-image"; falling back to /etc/os-release over SSH.',
    );
    expect(core.debug).toHaveBeenCalledWith(
      "[OS_DETECT] Reading /etc/os-release from 1.2.3.4.",
    );
    expect(core.debug).toHaveBeenCalledWith(
      expect.stringContaining("[OS_DETECT] Fetched /etc/os-release ("),
    );
    expect(core.debug).toHaveBeenCalledWith(
      expect.stringContaining("[OS_DETECT] Parsed /etc/os-release identifiers:"),
    );
    expect(core.info).toHaveBeenCalledWith(
      "[OS_DETECT] Detected fedora family from /etc/os-release.",
    );
    expect(core.info).toHaveBeenCalledWith(
      "[OS_DETECT] Completed OS detection with fedora strategy.",
    );
  });

  it("throws an OS_DETECT-prefixed error for unsupported fallback detection", async () => {
    vi.mocked(ssh.sshExec).mockResolvedValue("ID=arch\nID_LIKE=rolling\n");

    await expect(
      detectOs({
        ...BASE_OPTIONS,
        image: "custom-unknown-image",
      }),
    ).rejects.toThrow(/^OS_DETECT/);

    await expect(
      detectOs({
        ...BASE_OPTIONS,
        image: "custom-unknown-image",
      }),
    ).rejects.toThrow(/OS_DETECT_UNSUPPORTED/);
  });

  it("throws an OS_DETECT-prefixed error when SSH fallback fails", async () => {
    vi.mocked(ssh.sshExec).mockRejectedValue(new Error("connection reset"));

    await expect(
      detectOs({
        ...BASE_OPTIONS,
        image: "custom-unknown-image",
      }),
    ).rejects.toThrow(
      /^OS_DETECT: failed to read \/etc\/os-release over SSH: connection reset$/,
    );
  });
});
