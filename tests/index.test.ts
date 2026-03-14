import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  core: {
    debug: vi.fn(),
    error: vi.fn(),
    getInput: vi.fn<(name: string) => string>(),
    info: vi.fn(),
    setFailed: vi.fn(),
    setOutput: vi.fn(),
    setSecret: vi.fn(),
    warning: vi.fn(),
  },
  deployPipeline: vi.fn<(inputs: unknown) => Promise<void>>(),
  validateInputs: vi.fn<(inputs: unknown) => void>(),
}));

vi.mock("@actions/core", () => mocks.core);

vi.mock("../src/pipeline.js", () => ({
  deployPipeline: mocks.deployPipeline,
}));

vi.mock("../src/validate.js", () => ({
  VALID_SERVICE_KEYS: new Set([
    "name",
    "exec-start",
    "type",
    "restart",
    "restart-sec",
    "user",
    "working-directory",
  ]),
  mapKebabToCamel: (raw: Record<string, unknown>) => ({
    name: raw["name"] as string,
    execStart: raw["exec-start"] as string,
    type: raw["type"] as string | undefined,
    restart: raw["restart"] as string | undefined,
    restartSec:
      raw["restart-sec"] != null ? Number(raw["restart-sec"]) : undefined,
    user: raw["user"] as string | undefined,
    workingDirectory: raw["working-directory"] as string | undefined,
  }),
  validateInputs: mocks.validateInputs,
}));

const REQUIRED_INPUTS = {
  hcloud_token: "token-123",
  project_tag: "demo-project",
  public_key: "ssh-ed25519 AAAATEST",
  server_name: "demo-server",
  ssh_private_key: "PRIVATE_KEY",
};

function mockInputs(overrides: Record<string, string> = {}): void {
  const values = { ...REQUIRED_INPUTS, ...overrides };

  mocks.core.getInput.mockImplementation((name: string) => values[name] ?? "");
}

async function importEntrypoint(): Promise<void> {
  await import("../src/index.js");
  await Promise.resolve();
}

function infoMessages(): string[] {
  return mocks.core.info.mock.calls.map(([message]) => String(message));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.deployPipeline.mockResolvedValue(undefined);
  mocks.validateInputs.mockImplementation(() => {});
  mockInputs();
});

describe("src/index entrypoint", () => {
  it("passes fully configured inputs through to the pipeline", async () => {
    mockInputs({
      container_image: "ghcr.io/acme/app:1.2.3",
      container_port: "8080:80",
      exec_start: "/usr/bin/node /srv/app/server.js --port 8080",
      firewall_enabled: "true",
      firewall_extra_ports: "8080, 53/udp , , 443",
      haproxy_cfg: "/etc/haproxy/haproxy.cfg",
      haproxy_fragment: "frontend app",
      haproxy_fragment_name: "app",
      image: "ubuntu-24.04",
      ipv6_only: "true",
      server_type: "cx22",
      service_name: "demo.service",
      service_restart: "always",
      service_restart_sec: "9",
      service_type: "notify",
      source_dir: "dist",
      ssh_user: "deployer",
      target_dir: "/srv/app",
    });

    await importEntrypoint();

    expect(mocks.validateInputs).toHaveBeenCalledWith({
      containerPort: "8080:80",
      containerImage: "ghcr.io/acme/app:1.2.3",
      execStart: "/usr/bin/node /srv/app/server.js --port 8080",
      firewallEnabled: "true",
      firewallExtraPorts: "8080, 53/udp , , 443",
      haproxyCfg: "/etc/haproxy/haproxy.cfg",
      haproxyFragment: "frontend app",
      haproxyFragmentName: "app",
      image: "ubuntu-24.04",
      ipv6Only: "true",
      projectTag: "demo-project",
      serverName: "demo-server",
      serverType: "cx22",
      serviceName: "demo.service",
      serviceRestart: "always",
      serviceRestartSec: "9",
      serviceType: "notify",
      sourceDir: "dist",
      sshUser: "deployer",
      targetDir: "/srv/app",
    });
    expect(mocks.validateInputs).toHaveBeenCalledTimes(1);
    expect(mocks.deployPipeline).toHaveBeenCalledWith({
      containerImage: "ghcr.io/acme/app:1.2.3",
      containerPort: "8080:80",
      execStart: "/usr/bin/node /srv/app/server.js --port 8080",
      firewallEnabled: true,
      firewallExtraPorts: ["8080", "53/udp", "443"],
      haproxyCfg: "/etc/haproxy/haproxy.cfg",
      haproxyFragment: "frontend app",
      haproxyFragmentName: "app",
      hcloudToken: "token-123",
      image: "ubuntu-24.04",
      ipv6Only: true,
      projectTag: "demo-project",
      publicKey: "ssh-ed25519 AAAATEST",
      serverName: "demo-server",
      serverType: "cx22",
      service: {
        execStart: "/usr/bin/node /srv/app/server.js --port 8080",
        name: "demo.service",
        restart: "always",
        restartSec: 9,
        type: "notify",
        user: undefined,
        workingDirectory: undefined,
      },
      serviceName: "demo.service",
      sourceDir: "dist",
      sshPrivateKey: "PRIVATE_KEY",
      sshUser: "deployer",
      targetDir: "/srv/app",
    });
    expect(mocks.core.setSecret).toHaveBeenCalledTimes(3);
    expect(mocks.core.setSecret).toHaveBeenCalledWith("token-123");
    expect(mocks.core.setSecret).toHaveBeenCalledWith("PRIVATE_KEY");
    expect(mocks.core.setSecret).toHaveBeenCalledWith("ssh-ed25519 AAAATEST");

    const logs = infoMessages();
    expect(logs).toContain("  ipv6_only:    true");
    expect(logs).toContain("  service:      (provided)");
    expect(logs).toContain("  service_name: (provided)");
    expect(logs).toContain("  exec_start:   (provided)");
    expect(logs).toContain("  container_image: ghcr.io/acme/app:1.2.3");
    expect(logs).toContain("  firewall_extra_ports: 8080, 53/udp, 443");
    expect(logs).toContain("Action completed.");
  });

  it("uses empty-input fallbacks for optional values", async () => {
    await importEntrypoint();

    expect(mocks.deployPipeline).toHaveBeenCalledWith({
      containerImage: undefined,
      containerPort: undefined,
      firewallEnabled: false,
      firewallExtraPorts: undefined,
      haproxyCfg: undefined,
      haproxyFragment: undefined,
      haproxyFragmentName: undefined,
      hcloudToken: "token-123",
      image: "",
      ipv6Only: false,
      projectTag: "demo-project",
      publicKey: "ssh-ed25519 AAAATEST",
      serverName: "demo-server",
      serverType: "",
      service: undefined,
      serviceName: "",
      sourceDir: "",
      sshPrivateKey: "PRIVATE_KEY",
      sshUser: "",
      targetDir: "",
    });

    const logs = infoMessages();
    expect(logs).toContain("  service:      (not set)");
    expect(logs).toContain("  service_name: (not set)");
    expect(logs).toContain("  container_image: (not set)");
    expect(logs).toContain("  container_port: (not set)");
    expect(logs).toContain("  haproxy_cfg:     (not set)");
    expect(logs).toContain("  haproxy_fragment: (not set)");
    expect(logs).toContain("  haproxy_fragment_name: (not set)");
    expect(logs).toContain("  firewall_enabled: false");
    expect(logs).toContain("  firewall_extra_ports: (not set)");
  });

  it("builds structured service config from flat defaults when service yaml is absent", async () => {
    mockInputs({
      service_name: "demo.service",
    });

    await importEntrypoint();

    expect(mocks.validateInputs).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: "demo.service",
        serviceType: "simple",
        serviceRestart: "on-failure",
        serviceRestartSec: "5",
      }),
    );
    expect(mocks.deployPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: "demo.service",
        service: {
          name: "demo.service",
          execStart: "/usr/bin/env bash -c 'echo \"demo.service started\"'",
          type: "simple",
          restart: "on-failure",
          restartSec: 5,
          user: undefined,
          workingDirectory: undefined,
        },
      }),
    );
  });

  it("prefers structured service yaml over flat service settings", async () => {
    mockInputs({
      exec_start: "/usr/bin/node /srv/app/legacy.js",
      service: [
        "name: yaml.service",
        "exec-start: /usr/bin/node /srv/app/yaml.js",
        "type: notify",
        "restart: always",
        "restart-sec: 11",
      ].join("\n"),
      service_name: "legacy.service",
      service_restart: "on-failure",
      service_restart_sec: "5",
      service_type: "simple",
    });

    await importEntrypoint();

    expect(mocks.validateInputs).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: "yaml.service",
        execStart: "/usr/bin/node /srv/app/yaml.js",
        serviceType: "notify",
        serviceRestart: "always",
        serviceRestartSec: "11",
      }),
    );
    expect(mocks.deployPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: "legacy.service",
        service: {
          name: "yaml.service",
          execStart: "/usr/bin/node /srv/app/yaml.js",
          type: "notify",
          restart: "always",
          restartSec: 11,
          user: undefined,
          workingDirectory: undefined,
        },
      }),
    );
  });

  it("rejects malformed service yaml", async () => {
    mockInputs({
      service: "name: broken.service\nexec-start: [",
    });

    await importEntrypoint();

    await vi.waitFor(() => {
      expect(mocks.core.setFailed).toHaveBeenCalledWith(
        expect.stringMatching(/^INPUT_VALIDATION_ Invalid YAML for "service":/),
      );
    });
    expect(mocks.deployPipeline).not.toHaveBeenCalled();
  });

  it("rejects unknown keys in structured service yaml", async () => {
    mockInputs({
      service: [
        "name: yaml.service",
        "exec-start: /usr/bin/node /srv/app/yaml.js",
        "unknown-key: nope",
      ].join("\n"),
    });

    await importEntrypoint();

    await vi.waitFor(() => {
      expect(mocks.core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('INPUT_VALIDATION_ Invalid key in "service": "unknown-key"'),
      );
    });
    expect(mocks.deployPipeline).not.toHaveBeenCalled();
  });

  it("rejects scalar structured service yaml", async () => {
    mockInputs({
      service: "just-a-string",
    });

    await importEntrypoint();

    await vi.waitFor(() => {
      expect(mocks.core.setFailed).toHaveBeenCalledWith(
        'INPUT_VALIDATION_ Input "service" must be a YAML mapping/object.',
      );
    });
    expect(mocks.deployPipeline).not.toHaveBeenCalled();
  });

  it("rejects array structured service yaml", async () => {
    mockInputs({
      service: "- name: foo",
    });

    await importEntrypoint();

    await vi.waitFor(() => {
      expect(mocks.core.setFailed).toHaveBeenCalledWith(
        'INPUT_VALIDATION_ Input "service" must be a YAML mapping/object.',
      );
    });
    expect(mocks.deployPipeline).not.toHaveBeenCalled();
  });

  it("reports Error failures via core.setFailed", async () => {
    mocks.deployPipeline.mockRejectedValueOnce(new Error("boom"));

    await importEntrypoint();

    await vi.waitFor(() => {
      expect(mocks.core.setFailed).toHaveBeenCalledWith("boom");
    });
  });

  it("reports non-Error failures via string conversion", async () => {
    mocks.deployPipeline.mockRejectedValueOnce("plain failure");

    await importEntrypoint();

    await vi.waitFor(() => {
      expect(mocks.core.setFailed).toHaveBeenCalledWith("plain failure");
    });
  });
});
