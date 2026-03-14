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
      serviceName: "",
      sourceDir: "",
      sshPrivateKey: "PRIVATE_KEY",
      sshUser: "",
      targetDir: "",
    });

    const logs = infoMessages();
    expect(logs).toContain("  service_name: (not set)");
    expect(logs).toContain("  container_image: (not set)");
    expect(logs).toContain("  container_port: (not set)");
    expect(logs).toContain("  haproxy_cfg:     (not set)");
    expect(logs).toContain("  haproxy_fragment: (not set)");
    expect(logs).toContain("  haproxy_fragment_name: (not set)");
    expect(logs).toContain("  firewall_enabled: false");
    expect(logs).toContain("  firewall_extra_ports: (not set)");
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
