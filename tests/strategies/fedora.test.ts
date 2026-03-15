import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@actions/core", async () => {
  const { createCoreMock } = await import("../helpers/mockCore");
  return createCoreMock();
});

import * as core from "@actions/core";

import { createFedoraStrategy } from "../../src/deploy/strategies/fedora";

describe("createFedoraStrategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the fedora family and logs instantiation", () => {
    const strategy = createFedoraStrategy();

    expect(strategy.family).toBe("fedora");
    expect(core.info).toHaveBeenCalledWith("[FEDORA] Creating Fedora OS strategy.");
  });

  it("builds the expected package commands", () => {
    const strategy = createFedoraStrategy();

    expect(strategy.packages.install(["podman", "haproxy"])).toBe(
      "sudo dnf install -y --setopt=install_weak_deps=False 'podman' 'haproxy'",
    );
    expect(strategy.packages.verify("podman")).toBe("rpm -q 'podman'");
  });

  it("accepts valid package names and rejects invalid ones", () => {
    const pattern = createFedoraStrategy().packages.packageNamePattern;

    expect(pattern.test("podman")).toBe(true);
    expect(pattern.test("python3-devel")).toBe(true);
    expect(pattern.test("libstdc++")).toBe(true);
    expect(pattern.test("my_pkg")).toBe(true);

    expect(pattern.test("x")).toBe(false);
    expect(pattern.test("-nginx")).toBe(false);
    expect(pattern.test("bad name")).toBe(false);
    expect(pattern.test("nginx;rm -rf /")).toBe(false);
  });

  it("builds the expected firewall commands", () => {
    const strategy = createFedoraStrategy();

    expect(strategy.firewall.install()).toBe(
      "command -v firewall-cmd >/dev/null 2>&1 || (sudo dnf install -y --setopt=install_weak_deps=False firewalld && sudo systemctl enable --now firewalld) && command -v firewall-cmd >/dev/null 2>&1",
    );
    expect(strategy.firewall.defaults()).toBe(
      "sudo firewall-cmd --set-default-zone=drop",
    );
    expect(strategy.firewall.allow("443/tcp")).toBe(
      "sudo firewall-cmd --permanent --add-port=443/tcp",
    );
    expect(strategy.firewall.enable()).toBe("sudo firewall-cmd --reload");
  });

  it("emits [FEDORA] debug logs for generated commands", () => {
    const strategy = createFedoraStrategy();

    strategy.packages.install(["podman", "haproxy"]);
    strategy.packages.verify("podman");
    strategy.firewall.install();
    strategy.firewall.defaults();
    strategy.firewall.allow("80/tcp");
    strategy.firewall.enable();

    expect(core.debug).toHaveBeenNthCalledWith(
      1,
      "[FEDORA] Generated package install command: sudo dnf install -y --setopt=install_weak_deps=False 'podman' 'haproxy'",
    );
    expect(core.debug).toHaveBeenNthCalledWith(
      2,
      "[FEDORA] Generated package verify command: rpm -q 'podman'",
    );
    expect(core.debug).toHaveBeenNthCalledWith(
      3,
      "[FEDORA] Generated firewall install command: command -v firewall-cmd >/dev/null 2>&1 || (sudo dnf install -y --setopt=install_weak_deps=False firewalld && sudo systemctl enable --now firewalld) && command -v firewall-cmd >/dev/null 2>&1",
    );
    expect(core.debug).toHaveBeenNthCalledWith(
      4,
      "[FEDORA] Generated firewall defaults command: sudo firewall-cmd --set-default-zone=drop",
    );
    expect(core.debug).toHaveBeenNthCalledWith(
      5,
      "[FEDORA] Generated firewall allow command: sudo firewall-cmd --permanent --add-port=80/tcp",
    );
    expect(core.debug).toHaveBeenNthCalledWith(
      6,
      "[FEDORA] Generated firewall enable command: sudo firewall-cmd --reload",
    );
  });
});
