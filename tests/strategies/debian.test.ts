import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before imports that trigger them
// ---------------------------------------------------------------------------

vi.mock("@actions/core", async () => {
  const { createCoreMock } = await import("../helpers/mockCore");
  return createCoreMock();
});

// ---------------------------------------------------------------------------
// Imports (receive mocked implementations)
// ---------------------------------------------------------------------------

import * as core from "@actions/core";

import { createDebianStrategy } from "../../src/deploy/strategies/debian";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("createDebianStrategy", () => {
  it("returns the debian family and logs initialization", () => {
    const strategy = createDebianStrategy();

    expect(strategy.family).toBe("debian");
    expect(core.info).toHaveBeenCalledWith("[DEBIAN] Creating Debian OS strategy.");
  });

  it("builds apt-get install commands with shell-quoted packages", () => {
    const strategy = createDebianStrategy();

    expect(strategy.packages.install(["podman", "ca-certificates"])).toBe(
      "sudo apt-get update -qq && sudo apt-get install -y -qq 'podman' 'ca-certificates'",
    );
    expect(core.debug).toHaveBeenCalledWith(
      "[DEBIAN] Generated package install command: sudo apt-get update -qq && sudo apt-get install -y -qq 'podman' 'ca-certificates'",
    );
  });

  it("builds dpkg verify commands with shell-quoted package names", () => {
    const strategy = createDebianStrategy();

    expect(strategy.packages.verify("nginx")).toBe("dpkg -s 'nginx'");
    expect(core.debug).toHaveBeenCalledWith(
      "[DEBIAN] Generated package verify command: dpkg -s 'nginx'",
    );
  });

  it("accepts valid package names and rejects invalid ones", () => {
    const strategy = createDebianStrategy();
    const pattern = strategy.packages.packageNamePattern;

    expect(pattern.test("nginx")).toBe(true);
    expect(pattern.test("libssl3")).toBe(true);
    expect(pattern.test("python3-venv")).toBe(true);
    expect(pattern.test("a")).toBe(false);
    expect(pattern.test("Nginx")).toBe(false);
    expect(pattern.test("-nginx")).toBe(false);
    expect(pattern.test("nginx;rm -rf /")).toBe(false);
  });

  it("builds ufw firewall commands and logs each generated command", () => {
    const strategy = createDebianStrategy();

    expect(strategy.firewall.install()).toBe(
      "command -v ufw >/dev/null 2>&1 || (sudo apt-get update -qq && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw) && command -v ufw >/dev/null 2>&1",
    );
    expect(strategy.firewall.defaults()).toBe(
      "sudo ufw default deny incoming && sudo ufw default allow outgoing",
    );
    expect(strategy.firewall.allow("443/tcp")).toBe("sudo ufw allow 443/tcp");
    expect(strategy.firewall.enable()).toBe("sudo ufw --force enable");

    expect(core.debug).toHaveBeenCalledWith(
      "[DEBIAN] Generated firewall install command: command -v ufw >/dev/null 2>&1 || (sudo apt-get update -qq && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw) && command -v ufw >/dev/null 2>&1",
    );
    expect(core.debug).toHaveBeenCalledWith(
      "[DEBIAN] Generated firewall defaults command: sudo ufw default deny incoming && sudo ufw default allow outgoing",
    );
    expect(core.debug).toHaveBeenCalledWith(
      "[DEBIAN] Generated firewall allow command: sudo ufw allow 443/tcp",
    );
    expect(core.debug).toHaveBeenCalledWith(
      "[DEBIAN] Generated firewall enable command: sudo ufw --force enable",
    );
  });
});
