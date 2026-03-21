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

vi.mock("node:path", () => ({
  resolve: vi.fn((...segments: string[]) => segments.join("/")),
}));

vi.mock("../src/deploy/ssh.js", () => ({
  withKeyFile: vi.fn(),
  sshExec: vi.fn(),
  shellQuote: vi.fn((value: string) =>
    `'${value.replace(/'/g, "'\\''")}'`,
  ),
}));

vi.mock("../src/deploy/remoteSetup.js", () => ({
  remoteSetup: vi.fn(),
  ensureTargetDir: vi.fn(),
  ensureServiceUser: vi.fn(),
  setTargetOwnership: vi.fn(),
  installSystemdUnit: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (receive mocked implementations)
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import * as ssh from "../src/deploy/ssh.js";
import * as remoteSetup from "../src/deploy/remoteSetup.js";

import type { DuckdnsDeployOptions } from "../src/deploy/duckdns.js";
import {
  deployDuckdns,
  DUCKDNS_CONFIG,
  DUCKDNS_INITIAL,
  DUCKDNS_PERMS,
  DUCKDNS_SCRIPT,
  DUCKDNS_TIMER,
  DUCKDNS_UNIT,
  DUCKDNS_USER,
  renderConfig,
  renderScript,
  renderServiceUnit,
  renderTimerUnit,
} from "../src/deploy/duckdns.js";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const FAKE_KEY_PATH = "/tmp/hda-key-XXXXXX/id";
const CONFIG_PATH = "/etc/duckdns/config.yaml";

const BASE_OPTS = {
  host: "1.2.3.4",
  user: "root",
  privateKey: "TEST_PRIVATE_KEY",
  token: "duckdns-token",
  domain: "example-subdomain",
} as const satisfies DuckdnsDeployOptions;

const FILE_SCRIPT_TEMPLATE = [
  "#!/usr/bin/env python3",
  '# file-template marker',
  'CONFIG = "{{CONFIG_PATH}}"',
].join("\n");

const FILE_SERVICE_TEMPLATE = [
  "[Unit]",
  "Description=DuckDNS updater (file template)",
  "",
  "[Service]",
  "Type=oneshot",
  "User=duckdns",
  "ExecStart=/usr/bin/python3 /etc/duckdns/update.py",
].join("\n");

const FILE_TIMER_TEMPLATE = [
  "[Timer]",
  "Description=DuckDNS timer (file template)",
  "OnUnitActiveSec=5min",
  "Persistent=true",
  "",
  "[Install]",
  "WantedBy=timers.target",
].join("\n");

function expectNoPlaceholders(rendered: string): void {
  expect(rendered).not.toMatch(/\{\{[^}]+\}\}/);
}

function readTemplatePath(callIndex = 0): string {
  return vi.mocked(fs.readFileSync).mock.calls[callIndex]![0] as string;
}

function sshRemoteCmd(callIndex: number): string {
  return vi.mocked(ssh.sshExec).mock.calls[callIndex]![3] as string;
}

function sshCallSlice(start: number, end?: number): string[] {
  return vi.mocked(ssh.sshExec).mock.calls
    .slice(start, end)
    .map((call) => call[3] as string);
}

function expectStandaloneHeredocTerminator(command: string, terminator: string): void {
  expect(command).toMatch(new RegExp(`\\n${terminator}$`));
  expect(command).not.toContain(`\n${terminator} && `);
}

function infoMessages(): string[] {
  return vi.mocked(core.info).mock.calls.map(([message]) => String(message));
}

function warningMessages(): string[] {
  return vi.mocked(core.warning).mock.calls.map(([message]) => String(message));
}

function expectLogsRedacted(
  opts: Pick<DuckdnsDeployOptions, "token" | "domain"> = BASE_OPTS,
): void {
  const messages = [...infoMessages(), ...warningMessages()];

  for (const message of messages) {
    expect(message).not.toContain(opts.token);
    expect(message.includes(opts.domain) && message.includes(opts.token)).toBe(
      false,
    );
  }
}

function rejectSshCommand(
  predicate: (command: string) => boolean,
  errorMessage: string,
): void {
  vi.mocked(ssh.sshExec).mockImplementation(async (...args) => {
    const command = args[3] as string;

    if (predicate(command)) {
      throw new Error(errorMessage);
    }

    return "";
  });
}

async function expectDeployFailure(
  opts: DuckdnsDeployOptions,
  prefix: string,
  detail: string,
  absentDetail?: string,
): Promise<void> {
  try {
    await deployDuckdns(opts);
    throw new Error("Expected deployDuckdns to reject");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);

    const message = (error as Error).message;

    expect(message).toContain(prefix);
    expect(message).toContain(detail);

    if (absentDetail != null) {
      expect(message).not.toContain(absentDetail);
    }
  }
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  vi.mocked(fs.existsSync).mockReturnValue(false as never);
  vi.mocked(path.resolve).mockImplementation(
    (...segments: string[]) => segments.join("/"),
  );
  vi.mocked(ssh.shellQuote).mockImplementation(
    (value: string) => `'${value.replace(/'/g, "'\\''")}'`,
  );
  vi.mocked(ssh.withKeyFile).mockImplementation(
    async (_privateKey: string, fn: (keyPath: string) => Promise<unknown>) =>
      fn(FAKE_KEY_PATH),
  );
  vi.mocked(ssh.sshExec).mockResolvedValue("");
  vi.mocked(remoteSetup.remoteSetup).mockResolvedValue({
    unitInstalled: false,
    serviceRestarted: false,
  });
  vi.mocked(remoteSetup.ensureTargetDir).mockResolvedValue(undefined);
  vi.mocked(remoteSetup.ensureServiceUser).mockResolvedValue({
    serviceUserEnsured: true,
  });
  vi.mocked(remoteSetup.setTargetOwnership).mockResolvedValue({
    targetOwnershipReset: true,
  });
  vi.mocked(remoteSetup.installSystemdUnit).mockResolvedValue({
    unitInstalled: true,
    serviceRestarted: true,
  });
});

// ===========================================================================
// 1. renderConfig
// ===========================================================================

describe("renderConfig", () => {
  it("contains token and domain in expected flat YAML output", () => {
    const rendered = renderConfig(BASE_OPTS.token, BASE_OPTS.domain);

    expect(rendered).toBe(
      'token: "duckdns-token"\ndomain: "example-subdomain"\n',
    );
  });

  it("does not leave unresolved placeholders", () => {
    const rendered = renderConfig(BASE_OPTS.token, BASE_OPTS.domain);

    expectNoPlaceholders(rendered);
  });
});

// ===========================================================================
// 2. renderScript
// ===========================================================================

describe("renderScript", () => {
  it("uses the file-first template path when the template exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true as never);
    vi.mocked(fs.readFileSync).mockReturnValue(FILE_SCRIPT_TEMPLATE as never);

    const rendered = renderScript(CONFIG_PATH);

    expect(fs.readFileSync).toHaveBeenCalledOnce();
    expect(readTemplatePath()).toContain("duckdns-update.py");
    expect(rendered).toBe(
      FILE_SCRIPT_TEMPLATE.split("{{CONFIG_PATH}}").join(CONFIG_PATH),
    );
    expect(rendered).toContain("# file-template marker");
    expectNoPlaceholders(rendered);
  });

  it("falls back to the built-in template when the template file is absent", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false as never);

    const rendered = renderScript(CONFIG_PATH);

    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(rendered).toContain('CONFIG = "/etc/duckdns/config.yaml"');
    expect(rendered).toContain('"""DuckDNS dynamic DNS updater."""');
    expectNoPlaceholders(rendered);
  });
});

// ===========================================================================
// 3. renderServiceUnit
// ===========================================================================

describe("renderServiceUnit", () => {
  it("uses the file-first template path when the service unit exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true as never);
    vi.mocked(fs.readFileSync).mockReturnValue(FILE_SERVICE_TEMPLATE as never);

    const rendered = renderServiceUnit();

    expect(fs.readFileSync).toHaveBeenCalledOnce();
    expect(readTemplatePath()).toContain("duckdns.service");
    expect(rendered).toBe(FILE_SERVICE_TEMPLATE);
    expect(rendered).toContain("Description=DuckDNS updater (file template)");
  });

  it("falls back to the built-in service unit and includes key directives", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false as never);

    const rendered = renderServiceUnit();

    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(rendered).toContain("Type=oneshot");
    expect(rendered).toContain("User=duckdns");
    expect(rendered).toContain(
      "ExecStart=/usr/bin/python3 /etc/duckdns/update.py",
    );
  });
});

// ===========================================================================
// 4. renderTimerUnit
// ===========================================================================

describe("renderTimerUnit", () => {
  it("uses the file-first template path when the timer unit exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true as never);
    vi.mocked(fs.readFileSync).mockReturnValue(FILE_TIMER_TEMPLATE as never);

    const rendered = renderTimerUnit();

    expect(fs.readFileSync).toHaveBeenCalledOnce();
    expect(readTemplatePath()).toContain("duckdns.timer");
    expect(rendered).toBe(FILE_TIMER_TEMPLATE);
    expect(rendered).toContain("Description=DuckDNS timer (file template)");
  });

  it("falls back to the built-in timer unit and includes key directives", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false as never);

    const rendered = renderTimerUnit();

    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(rendered).toContain("OnUnitActiveSec=5min");
    expect(rendered).toContain("Persistent=true");
    expect(rendered).toContain("WantedBy=timers.target");
  });
});

// ===========================================================================
// 5. deployDuckdns
// ===========================================================================

describe("deployDuckdns", () => {
  it("runs the full orchestration flow in order", async () => {
    const result = await deployDuckdns(BASE_OPTS);

    expect(result).toEqual({
      domainUpdated: true,
      timerInstalled: true,
    });

    expect(remoteSetup.ensureServiceUser).toHaveBeenCalledWith({
      host: BASE_OPTS.host,
      user: BASE_OPTS.user,
      privateKey: BASE_OPTS.privateKey,
      serviceUser: "duckdns",
      ipv6Only: false,
    });
    expect(remoteSetup.ensureTargetDir).toHaveBeenCalledWith({
      host: BASE_OPTS.host,
      user: BASE_OPTS.user,
      privateKey: BASE_OPTS.privateKey,
      targetDir: "/etc/duckdns",
      ipv6Only: false,
    });

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(9);

    const commands = sshCallSlice(0, 9);

    expect(commands[0]).toContain(
      "sudo tee '/etc/duckdns/config.yaml' > /dev/null << 'DUCKDNS_CONFIG_EOF'",
    );
    expect(commands[0]).toContain(renderConfig(BASE_OPTS.token, BASE_OPTS.domain));

    expect(commands[1]).toContain(
      "sudo chown -R 'duckdns':'duckdns' '/etc/duckdns'",
    );
    expect(commands[1]).toContain("sudo chmod 0700 '/etc/duckdns'");
    expect(commands[1]).toContain("sudo chmod 0600 '/etc/duckdns/config.yaml'");

    expect(commands[2]).toContain(
      "sudo tee '/etc/duckdns/update.py' > /dev/null << 'DUCKDNS_SCRIPT_EOF'",
    );
    expect(commands[2]).toContain(renderScript(CONFIG_PATH));
    expectStandaloneHeredocTerminator(commands[2], "DUCKDNS_SCRIPT_EOF");

    expect(commands[3]).toContain("sudo chmod 0755 '/etc/duckdns/update.py'");
    expect(commands[3]).toContain(
      "sudo chown 'duckdns':'duckdns' '/etc/duckdns/update.py'",
    );

    expect(commands[4]).toContain(
      "sudo tee '/etc/systemd/system/duckdns.service' > /dev/null << 'DUCKDNS_SERVICE_UNIT_EOF'",
    );
    expect(commands[4]).toContain(renderServiceUnit());

    expect(commands[5]).toContain(
      "sudo tee '/etc/systemd/system/duckdns.timer' > /dev/null << 'DUCKDNS_TIMER_UNIT_EOF'",
    );
    expect(commands[5]).toContain(renderTimerUnit());

    expect(commands[6]).toBe("sudo systemctl daemon-reload");
    expect(commands[7]).toBe("sudo systemctl enable --now duckdns.timer");
    expect(commands[8]).toBe("sudo systemctl start duckdns.service");

    expectLogsRedacted();
  });

  it("treats the initial service start failure as non-fatal", async () => {
    rejectSshCommand(
      (command) => command === "sudo systemctl start duckdns.service",
      "start failed",
    );

    const result = await deployDuckdns(BASE_OPTS);

    expect(result).toEqual({
      domainUpdated: false,
      timerInstalled: true,
    });
    expect(warningMessages()).toEqual(
      expect.arrayContaining([
        expect.stringContaining(DUCKDNS_INITIAL),
        expect.stringContaining("initial service run failed"),
      ]),
    );
    expect(sshRemoteCmd(7)).toBe("sudo systemctl enable --now duckdns.timer");
    expect(sshRemoteCmd(8)).toBe("sudo systemctl start duckdns.service");

    expectLogsRedacted();
  });

  it("continues when permission hardening fails", async () => {
    rejectSshCommand(
      (command) => command.includes("sudo chmod 0600 '/etc/duckdns/config.yaml'"),
      "chmod failed",
    );

    const result = await deployDuckdns(BASE_OPTS);

    expect(result).toEqual({
      domainUpdated: true,
      timerInstalled: true,
    });
    expect(warningMessages()).toEqual(
      expect.arrayContaining([
        expect.stringContaining(DUCKDNS_PERMS),
        expect.stringContaining("permission hardening failed"),
      ]),
    );
    expect(sshRemoteCmd(2)).toContain("/etc/duckdns/update.py");
    expectStandaloneHeredocTerminator(sshRemoteCmd(2), "DUCKDNS_SCRIPT_EOF");
    expect(sshRemoteCmd(3)).toContain("sudo chmod 0755 '/etc/duckdns/update.py'");
    expect(sshRemoteCmd(7)).toBe("sudo systemctl enable --now duckdns.timer");

    expectLogsRedacted();
  });

  it("wraps ensure service user failures with the DUCKDNS_USER prefix", async () => {
    vi.mocked(remoteSetup.ensureServiceUser).mockRejectedValueOnce(
      new Error("useradd failed"),
    );

    await expectDeployFailure(BASE_OPTS, DUCKDNS_USER, "service user duckdns");
  });

  it("wraps config phase failures with the DUCKDNS_CONFIG prefix", async () => {
    rejectSshCommand(
      (command) => command.includes("/etc/duckdns/config.yaml"),
      "tee failed",
    );

    await expectDeployFailure(
      BASE_OPTS,
      DUCKDNS_CONFIG,
      "/etc/duckdns/config.yaml",
      "tee failed",
    );
  });

  it("wraps script upload failures with the DUCKDNS_SCRIPT prefix", async () => {
    rejectSshCommand(
      (command) => command.includes("/etc/duckdns/update.py"),
      "script upload failed",
    );

    await expectDeployFailure(BASE_OPTS, DUCKDNS_SCRIPT, "/etc/duckdns/update.py");
  });

  it("wraps service unit handling failures with the DUCKDNS_UNIT prefix", async () => {
    rejectSshCommand(
      (command) => command === "sudo systemctl daemon-reload",
      "daemon-reload failed",
    );

    await expectDeployFailure(BASE_OPTS, DUCKDNS_UNIT, "reload systemd daemon");
  });

  it("wraps timer activation failures with the DUCKDNS_TIMER prefix", async () => {
    rejectSshCommand(
      (command) => command === "sudo systemctl enable --now duckdns.timer",
      "enable failed",
    );

    await expectDeployFailure(BASE_OPTS, DUCKDNS_TIMER, "enable duckdns.timer");
  });

  it("forwards the ipv6Only flag to helpers and ssh calls", async () => {
    const opts = {
      ...BASE_OPTS,
      ipv6Only: true,
    } satisfies DuckdnsDeployOptions;

    await deployDuckdns(opts);

    expect(remoteSetup.ensureServiceUser).toHaveBeenCalledWith({
      host: opts.host,
      user: opts.user,
      privateKey: opts.privateKey,
      serviceUser: "duckdns",
      ipv6Only: true,
    });
    expect(remoteSetup.ensureTargetDir).toHaveBeenCalledWith({
      host: opts.host,
      user: opts.user,
      privateKey: opts.privateKey,
      targetDir: "/etc/duckdns",
      ipv6Only: true,
    });
    expect(
      vi.mocked(ssh.sshExec).mock.calls.every((call) => call[4] === true),
    ).toBe(true);
  });
});
