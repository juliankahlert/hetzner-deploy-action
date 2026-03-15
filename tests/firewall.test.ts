import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before imports that trigger them
// ---------------------------------------------------------------------------

vi.mock("@actions/core", async () => {
  const { createCoreMock } = await import("./helpers/mockCore");
  return {
    ...createCoreMock(),
    startGroup: vi.fn(),
    endGroup: vi.fn(),
  };
});

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
import * as ssh from "../src/deploy/ssh.js";
import { createDebianStrategy } from "../src/deploy/strategies/debian";
import { createFedoraStrategy } from "../src/deploy/strategies/fedora";

import {
  configureFirewall,
  FIREWALL_ERRORS,
} from "../src/deploy/firewall";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const FAKE_KEY_PATH = "/tmp/hda-key-XXXXXX/id";

const DEBIAN_STRATEGY = createDebianStrategy();
const FEDORA_STRATEGY = createFedoraStrategy();

function expectedFirewallCommands(
  strategy: {
    firewall: {
      install(): string;
      defaults(): string;
      allow(rule: string): string;
      enable(): string;
    };
  },
  extraPorts: readonly string[] = [],
): string[] {
  return [
    strategy.firewall.install(),
    strategy.firewall.defaults(),
    strategy.firewall.allow("22/tcp"),
    strategy.firewall.allow("80/tcp"),
    strategy.firewall.allow("443/tcp"),
    ...extraPorts.map((port) => strategy.firewall.allow(port)),
    strategy.firewall.enable(),
  ];
}

const BASE_OPTS = {
  host: "1.2.3.4",
  user: "root",
  privateKey: "TEST_PRIVATE_KEY",
  strategy: DEBIAN_STRATEGY,
} as const;

function sshRemoteCmd(callIndex: number): string {
  return vi.mocked(ssh.sshExec).mock.calls[callIndex]![3] as string;
}

function sshCallSlice(start: number, end?: number): string[] {
  return vi.mocked(ssh.sshExec).mock.calls
    .slice(start, end)
    .map((call) => call[3] as string);
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

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
// configureFirewall
// ===========================================================================

describe("configureFirewall", () => {
  it("runs the full success path in order and returns applied rule counts", async () => {
    const result = await configureFirewall(BASE_OPTS);

    expect(result).toEqual({
      firewallEnabled: true,
      rulesApplied: 3,
    });

    expect(ssh.withKeyFile).toHaveBeenCalledWith(
      "TEST_PRIVATE_KEY",
      expect.any(Function),
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(6);
    expect(sshCallSlice(0)).toEqual(expectedFirewallCommands(DEBIAN_STRATEGY));

    expect(core.startGroup).toHaveBeenCalledWith("Configure firewall");
    expect(core.startGroup).toHaveBeenCalledWith("Enable firewall");
    expect(core.endGroup).toHaveBeenCalledTimes(7);
  });

  it("uses a validate-and-install command when ensuring ufw is present", async () => {
    await configureFirewall(BASE_OPTS);

    expect(sshRemoteCmd(0)).toBe(DEBIAN_STRATEGY.firewall.install());
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining(`[${FIREWALL_ERRORS.INSTALL}]`),
    );
  });

  it("aborts before web rules and enable when the ssh rule fails", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("port 22 failed"));

    await expect(configureFirewall(BASE_OPTS)).rejects.toThrow(
      /FIREWALL_SSH_RULE: port 22 failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(3);
    expect(sshCallSlice(0)).toEqual(expectedFirewallCommands(DEBIAN_STRATEGY).slice(0, 3));
    expect(sshCallSlice(0)).not.toContain(DEBIAN_STRATEGY.firewall.enable());
  });

  it("wraps enable failures with a FIREWALL_ENABLE prefix", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("enable denied"));

    await expect(configureFirewall(BASE_OPTS)).rejects.toThrow(
      /FIREWALL_ENABLE: enable denied/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(6);
    expect(sshRemoteCmd(5)).toBe(DEBIAN_STRATEGY.firewall.enable());
  });

  it("keeps rerun commands idempotent and safe across repeated executions", async () => {
    const first = await configureFirewall(BASE_OPTS);
    const second = await configureFirewall(BASE_OPTS);

    expect(first).toEqual({ firewallEnabled: true, rulesApplied: 3 });
    expect(second).toEqual({ firewallEnabled: true, rulesApplied: 3 });

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(12);
    expect(sshCallSlice(0, 6)).toEqual(sshCallSlice(6, 12));
    expect(sshCallSlice(0, 6)).toContain(DEBIAN_STRATEGY.firewall.defaults());
    expect(sshCallSlice(0, 6)).toContain(DEBIAN_STRATEGY.firewall.allow("22/tcp"));
    expect(sshCallSlice(0, 6)).toContain(DEBIAN_STRATEGY.firewall.enable());
  });

  it("applies extra ports after the default web rules", async () => {
    const result = await configureFirewall({
      ...BASE_OPTS,
      extraPorts: [8080, "53/udp"],
    });

    expect(result).toEqual({
      firewallEnabled: true,
      rulesApplied: 5,
    });

    expect(sshCallSlice(0)).toEqual(
      expectedFirewallCommands(DEBIAN_STRATEGY, ["8080/tcp", "53/udp"]),
    );
  });

  it("defaults to Debian strategy behavior when strategy is omitted", async () => {
    const result = await configureFirewall({
      host: "1.2.3.4",
      user: "root",
      privateKey: "TEST_PRIVATE_KEY",
    });

    expect(result).toEqual({
      firewallEnabled: true,
      rulesApplied: 3,
    });

    expect(sshCallSlice(0)).toEqual(expectedFirewallCommands(DEBIAN_STRATEGY));
  });

  it("uses Fedora firewall helpers when a Fedora strategy is provided", async () => {
    const result = await configureFirewall({
      host: "1.2.3.4",
      user: "root",
      privateKey: "TEST_PRIVATE_KEY",
      strategy: FEDORA_STRATEGY,
      extraPorts: [8080, "53/udp"],
    });

    expect(result).toEqual({
      firewallEnabled: true,
      rulesApplied: 5,
    });

    expect(sshCallSlice(0)).toEqual(
      expectedFirewallCommands(FEDORA_STRATEGY, ["8080/tcp", "53/udp"]),
    );
  });

  it("rejects invalid extra ports with a FIREWALL_VALIDATE prefix", async () => {
    await expect(
      configureFirewall({
        ...BASE_OPTS,
        extraPorts: ["70000/tcp"],
      }),
    ).rejects.toThrow(/FIREWALL_VALIDATE: port out of range/);

    expect(ssh.withKeyFile).not.toHaveBeenCalled();
    expect(ssh.sshExec).not.toHaveBeenCalled();
  });
});
