import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before imports that trigger them
// ---------------------------------------------------------------------------

vi.mock("@actions/core", async () => {
  const { createCoreMock } = await import("./helpers/mockCore");
  return createCoreMock();
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

// Hetzner modules — mock at module boundary
vi.mock("../src/hetzner/client.js", () => ({
  createClient: vi.fn(),
}));

vi.mock("../src/hetzner/sshKeys.js", () => ({
  ensureSshKey: vi.fn(),
}));

vi.mock("../src/hetzner/findOrCreateServer.js", () => ({
  findOrCreateServer: vi.fn(),
}));

// Deploy modules — mock at module boundary
vi.mock("../src/deploy/remoteSetup.js", () => ({
  ensureServiceUser: vi.fn(),
  ensureTargetDir: vi.fn(),
  installSystemdUnit: vi.fn(),
  setTargetOwnership: vi.fn(),
}));

vi.mock("../src/deploy/packageInstall.js", () => ({
  installPackages: vi.fn(),
}));

vi.mock("../src/deploy/rsync.js", () => ({
  rsyncDeploy: vi.fn(),
}));

vi.mock("../src/deploy/podman.js", () => ({
  deployPodman: vi.fn(),
}));

vi.mock("../src/deploy/haproxy.js", () => ({
  deployHaproxy: vi.fn(),
  deployHaproxyBase: vi.fn(),
  deployHaproxyFragment: vi.fn(),
  ensureHaproxyFragService: vi.fn(),
}));

vi.mock("../src/deploy/firewall.js", () => ({
  configureFirewall: vi.fn(),
}));

vi.mock("../src/deploy/ssh.js", () => ({
  withKeyFile: vi.fn(),
  waitForSsh: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (receive mocked implementations)
// ---------------------------------------------------------------------------

import * as core from "@actions/core";
import { existsSync } from "node:fs";
import { createClient } from "../src/hetzner/client.js";
import { ensureSshKey } from "../src/hetzner/sshKeys.js";
import { findOrCreateServer } from "../src/hetzner/findOrCreateServer.js";
import {
  ensureServiceUser,
  ensureTargetDir,
  installSystemdUnit,
  setTargetOwnership,
} from "../src/deploy/remoteSetup.js";
import { installPackages } from "../src/deploy/packageInstall.js";
import { rsyncDeploy } from "../src/deploy/rsync.js";
import { deployPodman } from "../src/deploy/podman.js";
import {
  deployHaproxy,
  deployHaproxyBase,
  deployHaproxyFragment,
  ensureHaproxyFragService,
} from "../src/deploy/haproxy.js";
import { configureFirewall } from "../src/deploy/firewall.js";
import { withKeyFile, waitForSsh } from "../src/deploy/ssh.js";
import {
  deployPipeline,
  activeStages,
  STAGES,
  STAGE_ORDER,
  type ActionInputs,
} from "../src/pipeline";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const FAKE_SERVER = {
  id: 42,
  ip: "1.2.3.4",
  status: "running",
  ipv6Only: false,
};

const FAKE_SSH_KEY = {
  id: 7,
  name: "myproject-deploy",
  fingerprint: "aa:bb:cc",
};

/** Minimal valid inputs with all optional features disabled. */
const BASE_INPUTS: ActionInputs = {
  hcloudToken: "fake-token",
  serverName: "test-server",
  projectTag: "myproject",
  image: "ubuntu-24.04",
  serverType: "cx22",
  ipv6Only: false,
  publicKey: "ssh-ed25519 AAAA",
  sshPrivateKey: "PRIVATE_KEY",
  sshUser: "deploy",
  serviceName: "",
  sourceDir: ".",
  targetDir: "/opt/app",
};

function makeService(overrides: Partial<NonNullable<ActionInputs["service"]>> = {}) {
  return {
    name: "myapp",
    execStart: "/usr/bin/node /opt/app/server.js",
    ...overrides,
  };
}

/** Build inputs with overrides. */
function withInputs(overrides: Partial<ActionInputs>): ActionInputs {
  return { ...BASE_INPUTS, ...overrides };
}

/** Track the order in which deploy stages are invoked. */
let callOrder: string[];

function trackCallOrder(): void {
  vi.mocked(installPackages).mockImplementation(async () => {
    callOrder.push(STAGES.installPackages);
  });
  vi.mocked(ensureTargetDir).mockImplementation(async () => {
    callOrder.push(STAGES.ensureTargetDir);
  });
  vi.mocked(rsyncDeploy).mockImplementation(async () => {
    callOrder.push(STAGES.rsyncDeploy);
  });
  vi.mocked(deployPodman).mockImplementation(async () => {
    callOrder.push(STAGES.podman);
    return { quadletUploaded: true, serviceRestarted: true };
  });
  vi.mocked(deployHaproxy).mockImplementation(async () => {
    callOrder.push(STAGES.haproxy);
    return { configUploaded: true, serviceReloaded: true };
  });
  vi.mocked(deployHaproxyFragment).mockImplementation(async () => {
    callOrder.push(STAGES.haproxy);
    return { configUploaded: true, serviceReloaded: true };
  });
  vi.mocked(configureFirewall).mockImplementation(async () => {
    callOrder.push(STAGES.firewall);
    return { firewallEnabled: true, rulesApplied: 4 };
  });
  vi.mocked(installSystemdUnit).mockImplementation(async () => {
    callOrder.push(STAGES.systemd);
    return { unitInstalled: true, serviceRestarted: true };
  });
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  callOrder = [];

  // Default Hetzner mocks — provisioning always succeeds
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(createClient).mockReturnValue({} as ReturnType<typeof createClient>);
  vi.mocked(ensureSshKey).mockResolvedValue(FAKE_SSH_KEY);
  vi.mocked(findOrCreateServer).mockResolvedValue(FAKE_SERVER);

  // Default deploy mocks — all stages succeed
  vi.mocked(installPackages).mockResolvedValue(undefined);
  vi.mocked(ensureServiceUser).mockResolvedValue({ serviceUserEnsured: true });
  vi.mocked(ensureTargetDir).mockResolvedValue(undefined);
  vi.mocked(rsyncDeploy).mockResolvedValue(undefined);
  vi.mocked(setTargetOwnership).mockResolvedValue({ targetOwnershipReset: true });
  vi.mocked(deployPodman).mockResolvedValue({
    quadletUploaded: true,
    serviceRestarted: true,
  });
  vi.mocked(deployHaproxy).mockResolvedValue({
    configUploaded: true,
    serviceReloaded: true,
  });
  vi.mocked(deployHaproxyBase).mockResolvedValue({
    configUploaded: true,
    serviceReloaded: false,
  });
  vi.mocked(deployHaproxyFragment).mockResolvedValue({
    configUploaded: true,
    serviceReloaded: true,
  });
  vi.mocked(ensureHaproxyFragService).mockResolvedValue(undefined);
  vi.mocked(configureFirewall).mockResolvedValue({
    firewallEnabled: true,
    rulesApplied: 4,
  });
  vi.mocked(installSystemdUnit).mockResolvedValue({
    unitInstalled: true,
    serviceRestarted: true,
  });
  vi.mocked(withKeyFile).mockImplementation(async (_privateKey, callback) => callback("/tmp/fake-key"));
  vi.mocked(waitForSsh).mockResolvedValue(undefined);
});

// ===========================================================================
// 1. STAGE_ORDER constant
// ===========================================================================

describe("STAGE_ORDER", () => {
  it("contains exactly 7 stages", () => {
    expect(STAGE_ORDER).toHaveLength(7);
  });

  it("has the correct ordering", () => {
    expect(STAGE_ORDER).toEqual([
      "installPackages",
      "ensureTargetDir",
      "rsyncDeploy",
      "podman",
      "systemd",
      "haproxy",
      "firewall",
    ]);
  });
});

// ===========================================================================
// 2. activeStages — conditional skipping
// ===========================================================================

describe("activeStages", () => {
  it("returns only core stages when all optional inputs are absent", () => {
    const stages = activeStages(BASE_INPUTS);

    expect(stages).toEqual([
      STAGES.installPackages,
      STAGES.ensureTargetDir,
      STAGES.rsyncDeploy,
    ]);
  });

  it("includes podman when containerImage is set", () => {
    const stages = activeStages(withInputs({ containerImage: "docker.io/myapp:latest" }));

    expect(stages).toContain(STAGES.podman);
  });

  it("excludes systemd when containerImage is set (even with service config)", () => {
    const stages = activeStages(
      withInputs({
        containerImage: "docker.io/myapp:latest",
        serviceName: "myapp",
        service: makeService(),
      }),
    );

    expect(stages).toContain(STAGES.podman);
    expect(stages).not.toContain(STAGES.systemd);
  });

  it("includes systemd when service.name is set and no containerImage", () => {
    const stages = activeStages(withInputs({ serviceName: "myapp", service: makeService() }));

    expect(stages).toContain(STAGES.systemd);
    expect(stages).not.toContain(STAGES.podman);
  });

  it("excludes systemd when service config is absent and no containerImage", () => {
    const stages = activeStages(withInputs({ serviceName: "myapp", service: undefined }));

    expect(stages).not.toContain(STAGES.systemd);
  });

  it("includes haproxy when haproxyCfg is set", () => {
    const without = activeStages(BASE_INPUTS);
    expect(without).not.toContain(STAGES.haproxy);

    const withHaproxy = activeStages(withInputs({ haproxyCfg: "/etc/haproxy/haproxy.cfg" }));
    expect(withHaproxy).toContain(STAGES.haproxy);
  });

  it("includes haproxy when only haproxyFragment is set", () => {
    const stages = activeStages(
      withInputs({
        haproxyFragment: "/etc/haproxy/conf.d/app.cfg",
        haproxyFragmentName: "app",
      }),
    );

    expect(stages).toContain(STAGES.haproxy);
  });

  it("includes firewall only when firewallEnabled is true", () => {
    const without = activeStages(BASE_INPUTS);
    expect(without).not.toContain(STAGES.firewall);

    const withFirewall = activeStages(withInputs({ firewallEnabled: true }));
    expect(withFirewall).toContain(STAGES.firewall);
  });

  it("excludes firewall when firewallEnabled is explicitly false", () => {
    const stages = activeStages(withInputs({ firewallEnabled: false }));

    expect(stages).not.toContain(STAGES.firewall);
  });

  it("preserves STAGE_ORDER ordering when multiple optional stages are active", () => {
    const stages = activeStages(
      withInputs({
        serviceName: "myapp",
        service: makeService(),
        haproxyCfg: "/etc/haproxy/haproxy.cfg",
        firewallEnabled: true,
      }),
    );

    // All should be present in order
    expect(stages).toEqual([
      STAGES.installPackages,
      STAGES.ensureTargetDir,
      STAGES.rsyncDeploy,
      STAGES.systemd,
      STAGES.haproxy,
      STAGES.firewall,
    ]);
  });
});

// ===========================================================================
// 3. deployPipeline — stage execution ordering
// ===========================================================================

describe("deployPipeline — stage ordering", () => {
  it("calls core stages in order: installPackages → ensureTargetDir → rsyncDeploy", async () => {
    trackCallOrder();

    await deployPipeline(BASE_INPUTS);

    expect(callOrder).toEqual([
      STAGES.installPackages,
      STAGES.ensureTargetDir,
      STAGES.rsyncDeploy,
    ]);
  });

  it("calls systemd after rsyncDeploy when service config is set", async () => {
    trackCallOrder();

    await deployPipeline(withInputs({ serviceName: "myapp", service: makeService() }));

    expect(callOrder).toEqual([
      STAGES.installPackages,
      STAGES.ensureTargetDir,
      STAGES.rsyncDeploy,
      STAGES.systemd,
    ]);
  });

  it("ensures service user ownership before installing systemd when service.user is present", async () => {
    await deployPipeline(
      withInputs({
        serviceName: "myapp",
        service: makeService({
          user: "svc-myapp",
          workingDirectory: "/srv/myapp/current",
        }),
      }),
    );

    const ensureUserCall = vi.mocked(ensureServiceUser).mock.invocationCallOrder[0];
    const setOwnershipCall = vi.mocked(setTargetOwnership).mock.invocationCallOrder[0];
    const installUnitCall = vi.mocked(installSystemdUnit).mock.invocationCallOrder[0];

    expect(ensureServiceUser).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      serviceUser: "svc-myapp",
      ipv6Only: false,
    });
    expect(setTargetOwnership).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      serviceUser: "svc-myapp",
      targetDir: "/srv/myapp/current",
      ipv6Only: false,
    });
    expect(ensureUserCall).toBeLessThan(setOwnershipCall);
    expect(setOwnershipCall).toBeLessThan(installUnitCall);
  });

  it("falls back to targetDir for ownership when service workingDirectory is absent", async () => {
    await deployPipeline(
      withInputs({
        serviceName: "myapp",
        service: makeService({ user: "svc-myapp", workingDirectory: undefined }),
      }),
    );

    expect(setTargetOwnership).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      serviceUser: "svc-myapp",
      targetDir: "/opt/app",
      ipv6Only: false,
    });
  });

  it("skips service-user helpers when service.user is undefined", async () => {
    await deployPipeline(
      withInputs({
        serviceName: "myapp",
        service: makeService({
          user: undefined,
          workingDirectory: "/srv/myapp/current",
        }),
      }),
    );

    expect(ensureServiceUser).not.toHaveBeenCalled();
    expect(setTargetOwnership).not.toHaveBeenCalled();
    expect(installSystemdUnit).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      targetDir: "/opt/app",
      serviceUser: undefined,
      serviceWorkingDirectory: "/srv/myapp/current",
      serviceName: "myapp",
      execStart: "/usr/bin/node /opt/app/server.js",
      serviceType: undefined,
      serviceRestart: undefined,
      serviceRestartSec: undefined,
      ipv6Only: false,
    });
  });

  it("passes undefined workingDirectory to installSystemdUnit when service workingDirectory is absent", async () => {
    await deployPipeline(
      withInputs({
        serviceName: "myapp",
        service: makeService({
          user: "svc-myapp",
          workingDirectory: undefined,
        }),
      }),
    );

    expect(installSystemdUnit).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      targetDir: "/opt/app",
      serviceUser: "svc-myapp",
      serviceWorkingDirectory: undefined,
      serviceName: "myapp",
      execStart: "/usr/bin/node /opt/app/server.js",
      serviceType: undefined,
      serviceRestart: undefined,
      serviceRestartSec: undefined,
      ipv6Only: false,
    });
  });

  it("does not call installSystemdUnit when service config is absent", async () => {
    await deployPipeline(withInputs({ serviceName: "myapp", service: undefined }));

    expect(installSystemdUnit).not.toHaveBeenCalled();
  });

  it("does not call installSystemdUnit when containerImage is present", async () => {
    await deployPipeline(
      withInputs({
        containerImage: "docker.io/myapp:latest",
        serviceName: "myapp",
        service: makeService(),
      }),
    );

    expect(installSystemdUnit).not.toHaveBeenCalled();
  });

  it("calls podman before haproxy and firewall when those stages are active", async () => {
    trackCallOrder();

    await deployPipeline(
      withInputs({
        containerImage: "docker.io/myapp:latest",
        haproxyCfg: "/etc/haproxy/haproxy.cfg",
        firewallEnabled: true,
      }),
    );

    expect(callOrder).toEqual([
      STAGES.installPackages,
      STAGES.ensureTargetDir,
      STAGES.rsyncDeploy,
      STAGES.podman,
      STAGES.haproxy,
      STAGES.firewall,
    ]);
  });

  it("calls ensureHaproxyFragService before haproxy deploy functions when haproxy stage is active", async () => {
    await deployPipeline(
      withInputs({
        haproxyCfg: "/etc/haproxy/haproxy.cfg",
        haproxyFragment: "/tmp/app.fragment.cfg",
        haproxyFragmentName: "app",
      }),
    );

    const ensureCall = vi.mocked(ensureHaproxyFragService).mock.invocationCallOrder[0];
    const deployCfgCall = vi.mocked(deployHaproxy).mock.invocationCallOrder[0];
    const deployFragmentCall = vi.mocked(deployHaproxyFragment).mock.invocationCallOrder[0];

    expect(ensureCall).toBeLessThan(deployCfgCall);
    expect(ensureCall).toBeLessThan(deployFragmentCall);
  });

  it("runs fragment-only haproxy flow in order: ensure service, deploy base, then deploy fragment", async () => {
    await deployPipeline(
      withInputs({
        haproxyFragment: "/tmp/app.fragment.cfg",
        haproxyFragmentName: "app",
      }),
    );

    const ensureCall = vi.mocked(ensureHaproxyFragService).mock.invocationCallOrder[0];
    const deployBaseCall = vi.mocked(deployHaproxyBase).mock.invocationCallOrder[0];
    const deployFragmentCall = vi.mocked(deployHaproxyFragment).mock.invocationCallOrder[0];

    expect(ensureCall).toBeLessThan(deployBaseCall);
    expect(deployBaseCall).toBeLessThan(deployFragmentCall);
    expect(deployHaproxy).not.toHaveBeenCalled();
  });

  it("tracks full fragment-only flow in callOrder", async () => {
    trackCallOrder();
    vi.mocked(ensureHaproxyFragService).mockImplementation(async () => {
      callOrder.push("ensureHaproxyFragService");
    });
    vi.mocked(deployHaproxyBase).mockImplementation(async () => {
      callOrder.push("deployHaproxyBase");
      return { configUploaded: true, serviceReloaded: false };
    });
    vi.mocked(deployHaproxyFragment).mockImplementation(async () => {
      callOrder.push("deployHaproxyFragment");
      return { configUploaded: true, serviceReloaded: true };
    });

    await deployPipeline(
      withInputs({
        haproxyFragment: "/tmp/app.fragment.cfg",
        haproxyFragmentName: "app",
      }),
    );

    expect(callOrder).toEqual([
      STAGES.installPackages,
      STAGES.ensureTargetDir,
      STAGES.rsyncDeploy,
      "ensureHaproxyFragService",
      "deployHaproxyBase",
      "deployHaproxyFragment",
    ]);
  });

  it("uses fragment result for final haproxy reload summary in fragment-only mode", async () => {
    vi.mocked(deployHaproxyBase).mockResolvedValueOnce({
      configUploaded: true,
      serviceReloaded: false,
    });
    vi.mocked(deployHaproxyFragment).mockResolvedValueOnce({
      configUploaded: true,
      serviceReloaded: true,
    });

    await deployPipeline(
      withInputs({
        haproxyFragment: "/tmp/app.fragment.cfg",
        haproxyFragmentName: "app",
      }),
    );

    expect(core.info).toHaveBeenCalledWith("  haproxy reloaded:  yes");
    expect(core.info).not.toHaveBeenCalledWith("  haproxy reloaded:  no");
  });

  it("does not call deployHaproxy in fragment-only mode", async () => {
    await deployPipeline(
      withInputs({
        haproxyFragment: "/tmp/app.fragment.cfg",
        haproxyFragmentName: "app",
      }),
    );

    expect(deployHaproxy).not.toHaveBeenCalled();
    expect(deployHaproxyBase).toHaveBeenCalledOnce();
    expect(deployHaproxyFragment).toHaveBeenCalledOnce();
  });

  it("wraps fragment-only base deployment failures with DEPLOY_PIPELINE_haproxy prefix", async () => {
    vi.mocked(deployHaproxyBase).mockRejectedValueOnce(new Error("base upload failed"));

    await expect(
      deployPipeline(
        withInputs({
          haproxyFragment: "/tmp/app.fragment.cfg",
          haproxyFragmentName: "app",
        }),
      ),
    ).rejects.toThrow(/^DEPLOY_PIPELINE_haproxy: base upload failed$/);

    expect(deployHaproxy).not.toHaveBeenCalled();
    expect(deployHaproxyFragment).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. deployPipeline — Hetzner provisioning
// ===========================================================================

describe("deployPipeline — Hetzner provisioning", () => {
  it("creates client with the provided token", async () => {
    await deployPipeline(BASE_INPUTS);

    expect(createClient).toHaveBeenCalledWith("fake-token");
  });

  it("calls ensureSshKey with projectTag-deploy name and publicKey", async () => {
    await deployPipeline(BASE_INPUTS);

    expect(ensureSshKey).toHaveBeenCalledWith(
      expect.anything(), // client
      "myproject-deploy",
      "ssh-ed25519 AAAA",
    );
  });

  it("calls findOrCreateServer with expected options", async () => {
    await deployPipeline(BASE_INPUTS);

    expect(findOrCreateServer).toHaveBeenCalledWith(
      expect.anything(), // client
      expect.objectContaining({
        name: "test-server",
        projectTag: "myproject",
        image: "ubuntu-24.04",
        serverType: "cx22",
        ipv6Only: false,
        sshKeyIds: [FAKE_SSH_KEY.id],
      }),
    );
  });

  it("sets server_ip, server_id, and server_status outputs", async () => {
    await deployPipeline(BASE_INPUTS);

    expect(core.setOutput).toHaveBeenCalledWith("server_ip", "1.2.3.4");
    expect(core.setOutput).toHaveBeenCalledWith("server_id", "42");
    expect(core.setOutput).toHaveBeenCalledWith("server_status", "running");
  });

  it("logs SSH readiness gate start and completion", async () => {
    await deployPipeline(BASE_INPUTS);

    expect(core.info).toHaveBeenCalledWith("Waiting for SSH to become available...");
    expect(core.info).toHaveBeenCalledWith("SSH is ready.");
  });

  it("waits for SSH using the temporary key path and effective IPv6 mode", async () => {
    await deployPipeline(BASE_INPUTS);

    expect(withKeyFile).toHaveBeenCalledWith("PRIVATE_KEY", expect.any(Function));
    expect(waitForSsh).toHaveBeenCalledWith("/tmp/fake-key", "deploy", "1.2.3.4", false);
  });

  it("passes server-effective ipv6Only to the SSH readiness gate", async () => {
    vi.mocked(findOrCreateServer).mockResolvedValueOnce({
      ...FAKE_SERVER,
      ip: "2001:db8::1",
      ipv6Only: true,
    });

    await deployPipeline(withInputs({ ipv6Only: false }));

    expect(waitForSsh).toHaveBeenCalledWith("/tmp/fake-key", "deploy", "2001:db8::1", true);
  });
});

// ===========================================================================
// 5. deployPipeline — conditional stage skipping
// ===========================================================================

describe("deployPipeline — conditional skipping", () => {
  it("skips podman stage when containerImage is absent", async () => {
    await deployPipeline(BASE_INPUTS);

    expect(deployPodman).not.toHaveBeenCalled();
  });

  it("executes podman stage when containerImage is present", async () => {
    await deployPipeline(withInputs({ containerImage: "docker.io/myapp:latest" }));

    expect(deployPodman).toHaveBeenCalledOnce();
  });

  it("skips haproxy stage when haproxyCfg is absent", async () => {
    await deployPipeline(BASE_INPUTS);

    expect(ensureHaproxyFragService).not.toHaveBeenCalled();
    expect(deployHaproxy).not.toHaveBeenCalled();
    expect(deployHaproxyFragment).not.toHaveBeenCalled();
  });

  it("executes haproxy stage when haproxyCfg is present", async () => {
    await deployPipeline(withInputs({ haproxyCfg: "/etc/haproxy/haproxy.cfg" }));

    expect(ensureHaproxyFragService).toHaveBeenCalledOnce();
    expect(deployHaproxy).toHaveBeenCalledOnce();
    expect(deployHaproxyFragment).not.toHaveBeenCalled();
  });

  it("executes haproxy stage when only haproxyFragment is present", async () => {
    await deployPipeline(
      withInputs({
        haproxyFragment: "/tmp/app.fragment.cfg",
        haproxyFragmentName: "app",
      }),
    );

    expect(deployHaproxy).not.toHaveBeenCalled();
    expect(deployHaproxyBase).toHaveBeenCalledOnce();
    expect(deployHaproxyFragment).toHaveBeenCalledOnce();
  });

  it("executes both haproxy config and fragment deployments when both inputs are present", async () => {
    await deployPipeline(
      withInputs({
        haproxyCfg: "/etc/haproxy/haproxy.cfg",
        haproxyFragment: "/tmp/app.fragment.cfg",
        haproxyFragmentName: "app",
      }),
    );

    expect(deployHaproxy).toHaveBeenCalledOnce();
    expect(deployHaproxyBase).not.toHaveBeenCalled();
    expect(deployHaproxyFragment).toHaveBeenCalledOnce();
  });

  it("skips firewall stage when firewallEnabled is falsy", async () => {
    await deployPipeline(BASE_INPUTS);

    expect(configureFirewall).not.toHaveBeenCalled();
  });

  it("executes firewall stage when firewallEnabled is true", async () => {
    await deployPipeline(withInputs({ firewallEnabled: true }));

    expect(configureFirewall).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// 6. deployPipeline — error propagation with DEPLOY_PIPELINE_ prefix
// ===========================================================================

describe("deployPipeline — error propagation", () => {
  it("stops before deployment stages when SSH readiness gate fails", async () => {
    vi.mocked(waitForSsh).mockRejectedValueOnce(new Error("ssh not ready"));

    await expect(deployPipeline(BASE_INPUTS)).rejects.toThrow("ssh not ready");

    expect(installPackages).not.toHaveBeenCalled();
    expect(ensureTargetDir).not.toHaveBeenCalled();
    expect(rsyncDeploy).not.toHaveBeenCalled();
  });

  it("wraps installPackages failure with DEPLOY_PIPELINE_installPackages prefix", async () => {
    vi.mocked(installPackages).mockRejectedValueOnce(new Error("apt-get failed"));

    await expect(deployPipeline(BASE_INPUTS)).rejects.toThrow(
      /^DEPLOY_PIPELINE_installPackages: apt-get failed$/,
    );
  });

  it("wraps ensureTargetDir failure with DEPLOY_PIPELINE_ensureTargetDir prefix", async () => {
    vi.mocked(ensureTargetDir).mockRejectedValueOnce(new Error("mkdir failed"));

    await expect(deployPipeline(BASE_INPUTS)).rejects.toThrow(
      /^DEPLOY_PIPELINE_ensureTargetDir: mkdir failed$/,
    );
  });

  it("wraps rsyncDeploy failure with DEPLOY_PIPELINE_rsyncDeploy prefix", async () => {
    vi.mocked(rsyncDeploy).mockRejectedValueOnce(new Error("rsync exited with code 1"));

    await expect(deployPipeline(BASE_INPUTS)).rejects.toThrow(
      /^DEPLOY_PIPELINE_rsyncDeploy: rsync exited with code 1$/,
    );
  });

  it("wraps systemd failure with DEPLOY_PIPELINE_systemd prefix", async () => {
    vi.mocked(installSystemdUnit).mockRejectedValueOnce(
      new Error("daemon-reload failed"),
    );

    await expect(
      deployPipeline(withInputs({ serviceName: "myapp", service: makeService() })),
    ).rejects.toThrow(/^DEPLOY_PIPELINE_systemd: daemon-reload failed$/);
  });

  it("wraps ensureServiceUser failure with DEPLOY_PIPELINE_systemd prefix and stops later helpers", async () => {
    vi.mocked(ensureServiceUser).mockRejectedValueOnce(new Error("useradd failed"));

    await expect(
      deployPipeline(
        withInputs({
          serviceName: "myapp",
          service: makeService({ user: "svc-myapp" }),
          firewallEnabled: true,
        }),
      ),
    ).rejects.toThrow(/^DEPLOY_PIPELINE_systemd: useradd failed$/);

    expect(ensureServiceUser).toHaveBeenCalledOnce();
    expect(setTargetOwnership).not.toHaveBeenCalled();
    expect(installSystemdUnit).not.toHaveBeenCalled();
    expect(configureFirewall).not.toHaveBeenCalled();
  });

  it("wraps setTargetOwnership failure with DEPLOY_PIPELINE_systemd prefix and stops later helpers", async () => {
    vi.mocked(setTargetOwnership).mockRejectedValueOnce(new Error("chown failed"));

    await expect(
      deployPipeline(
        withInputs({
          serviceName: "myapp",
          service: makeService({
            user: "svc-myapp",
            workingDirectory: "/srv/myapp/current",
          }),
          firewallEnabled: true,
        }),
      ),
    ).rejects.toThrow(/^DEPLOY_PIPELINE_systemd: chown failed$/);

    expect(ensureServiceUser).toHaveBeenCalledOnce();
    expect(setTargetOwnership).toHaveBeenCalledOnce();
    expect(installSystemdUnit).not.toHaveBeenCalled();
    expect(configureFirewall).not.toHaveBeenCalled();
  });

  it("wraps podman failure with DEPLOY_PIPELINE_podman prefix", async () => {
    vi.mocked(deployPodman).mockRejectedValueOnce(new Error("quadlet upload failed"));

    await expect(
      deployPipeline(withInputs({ containerImage: "docker.io/myapp:latest" })),
    ).rejects.toThrow(/^DEPLOY_PIPELINE_podman: quadlet upload failed$/);
  });

  it("wraps haproxy failure with DEPLOY_PIPELINE_haproxy prefix", async () => {
    vi.mocked(deployHaproxy).mockRejectedValueOnce(new Error("reload failed"));

    await expect(
      deployPipeline(withInputs({ haproxyCfg: "/etc/haproxy/haproxy.cfg" })),
    ).rejects.toThrow(/^DEPLOY_PIPELINE_haproxy: reload failed$/);
  });

  it("wraps haproxy helper failure with DEPLOY_PIPELINE_haproxy prefix", async () => {
    vi.mocked(ensureHaproxyFragService).mockRejectedValueOnce(new Error("ensure service failed"));

    await expect(
      deployPipeline(withInputs({ haproxyCfg: "/etc/haproxy/haproxy.cfg" })),
    ).rejects.toThrow(/^DEPLOY_PIPELINE_haproxy: ensure service failed$/);
  });

  it("wraps haproxy fragment failure with DEPLOY_PIPELINE_haproxy prefix", async () => {
    vi.mocked(deployHaproxyFragment).mockRejectedValueOnce(new Error("fragment reload failed"));

    await expect(
      deployPipeline(
        withInputs({
          haproxyFragment: "/tmp/app.fragment.cfg",
          haproxyFragmentName: "app",
        }),
      ),
    ).rejects.toThrow(/^DEPLOY_PIPELINE_haproxy: fragment reload failed$/);
  });

  it("wraps firewall failure with DEPLOY_PIPELINE_firewall prefix", async () => {
    vi.mocked(configureFirewall).mockRejectedValueOnce(new Error("FIREWALL_APPLY failed"));

    await expect(
      deployPipeline(withInputs({ firewallEnabled: true })),
    ).rejects.toThrow(/^DEPLOY_PIPELINE_firewall: FIREWALL_APPLY failed$/);
  });

  it("wraps non-Error thrown values in the DEPLOY_PIPELINE_ prefix", async () => {
    vi.mocked(installPackages).mockRejectedValueOnce("string error");

    await expect(deployPipeline(BASE_INPUTS)).rejects.toThrow(
      /^DEPLOY_PIPELINE_installPackages: string error$/,
    );
  });

  it("stops execution after the first failing stage", async () => {
    vi.mocked(installPackages).mockRejectedValueOnce(new Error("fail"));

    await deployPipeline(BASE_INPUTS).catch(() => {});

    expect(ensureTargetDir).not.toHaveBeenCalled();
    expect(rsyncDeploy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 7. deployPipeline — IPv6 error hint
// ===========================================================================

describe("deployPipeline — IPv6 error handling", () => {
  const IPV6_SERVER = {
    id: 42,
    ip: "2001:db8::1",
    status: "running",
    ipv6Only: true,
  };

  beforeEach(() => {
    vi.mocked(findOrCreateServer).mockResolvedValue(IPV6_SERVER);
  });

  it("emits IPv6 warning when ipv6Only is enabled", async () => {
    await deployPipeline(withInputs({ ipv6Only: true }));

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("ipv6_only is enabled"),
    );
  });

  it("wraps stage error with IPv6 hint when ipv6Only is true", async () => {
    vi.mocked(installPackages).mockRejectedValueOnce(new Error("connection refused"));

    await expect(
      deployPipeline(withInputs({ ipv6Only: true })),
    ).rejects.toThrow(/DEPLOY_PIPELINE_installPackages.*IPv6-only server failed/);
  });

  it("includes runner IPv6 hint in IPv6 error message", async () => {
    vi.mocked(rsyncDeploy).mockRejectedValueOnce(new Error("timeout"));

    await expect(
      deployPipeline(withInputs({ ipv6Only: true })),
    ).rejects.toThrow(/outbound IPv6 connectivity/);
  });

  it("does not add IPv6 hint when ipv6Only is false", async () => {
    vi.mocked(installPackages).mockRejectedValueOnce(new Error("connection refused"));

    await expect(deployPipeline(BASE_INPUTS)).rejects.toThrow(
      /^DEPLOY_PIPELINE_installPackages: connection refused$/,
    );
  });
});

describe("deployPipeline — IPv6 propagation", () => {
  it("passes ipv6Only true to deployment stages when server is IPv6-only", async () => {
    vi.mocked(findOrCreateServer).mockResolvedValueOnce({
      ...FAKE_SERVER,
      ip: "2001:db8::1",
      ipv6Only: true,
    });

    await deployPipeline(withInputs({ ipv6Only: false }));

    expect(installPackages).toHaveBeenCalledWith(expect.objectContaining({ ipv6Only: true }));
    expect(ensureTargetDir).toHaveBeenCalledWith(expect.objectContaining({ ipv6Only: true }));
    expect(rsyncDeploy).toHaveBeenCalledWith(expect.objectContaining({ ipv6Only: true }));
  });

  it("passes ipv6Only false to deployment stages when server is IPv4-only", async () => {
    vi.mocked(findOrCreateServer).mockResolvedValueOnce({
      ...FAKE_SERVER,
      ip: "1.2.3.4",
      ipv6Only: false,
    });

    await deployPipeline(withInputs({ ipv6Only: true }));

    expect(installPackages).toHaveBeenCalledWith(expect.objectContaining({ ipv6Only: false }));
    expect(ensureTargetDir).toHaveBeenCalledWith(expect.objectContaining({ ipv6Only: false }));
    expect(rsyncDeploy).toHaveBeenCalledWith(expect.objectContaining({ ipv6Only: false }));
  });

  it("warns when server and input IPv6 modes differ", async () => {
    vi.mocked(findOrCreateServer).mockResolvedValueOnce({
      ...FAKE_SERVER,
      ip: "2001:db8::1",
      ipv6Only: true,
    });

    await deployPipeline(withInputs({ ipv6Only: false }));

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("Server networking differs"),
    );
  });
});

// ===========================================================================
// 8. deployPipeline — passes correct arguments to deploy stages
// ===========================================================================

describe("deployPipeline — stage arguments", () => {
  it("passes server IP and SSH credentials to installPackages", async () => {
    await deployPipeline(BASE_INPUTS);

    expect(installPackages).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      ipv6Only: false,
    });
  });

  it("passes server IP, SSH credentials, and targetDir to ensureTargetDir", async () => {
    await deployPipeline(BASE_INPUTS);

    expect(ensureTargetDir).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      targetDir: "/opt/app",
      ipv6Only: false,
    });
  });

  it("passes correct options to rsyncDeploy", async () => {
    await deployPipeline(BASE_INPUTS);

    expect(rsyncDeploy).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      sourceDir: ".",
      targetDir: "/opt/app",
      sshKey: "PRIVATE_KEY",
      ipv6Only: false,
    });
  });

  it("passes structured service options to installSystemdUnit", async () => {
    await deployPipeline(
      withInputs({
        serviceName: "legacy-name",
        service: makeService({
          name: "myapp",
          execStart: "/usr/bin/node /opt/app/server.js --port 3000",
          type: "notify",
          restart: "always",
          restartSec: 9,
          user: "svc-myapp",
          workingDirectory: "/srv/myapp/current",
        }),
      }),
    );

    expect(installSystemdUnit).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      targetDir: "/opt/app",
      serviceUser: "svc-myapp",
      serviceWorkingDirectory: "/srv/myapp/current",
      serviceName: "myapp",
      execStart: "/usr/bin/node /opt/app/server.js --port 3000",
      serviceType: "notify",
      serviceRestart: "always",
      serviceRestartSec: 9,
      ipv6Only: false,
    });
  });

  it("uses service.name for podman when structured service is present", async () => {
    await deployPipeline(
      withInputs({
        containerImage: "docker.io/myapp:latest",
        serviceName: "legacy-name",
        service: makeService({ name: "structured-name" }),
      }),
    );

    expect(deployPodman).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: "structured-name",
      }),
    );
  });

  it("passes correct options to deployPodman when containerImage is set", async () => {
    await deployPipeline(
      withInputs({
        containerImage: "docker.io/myapp:latest",
        containerPort: "8080:80",
        serviceName: "myapp",
      }),
    );

    expect(deployPodman).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      image: "docker.io/myapp:latest",
      port: "8080:80",
      serviceName: "myapp",
      ipv6Only: false,
    });
  });

  it("passes correct options to deployHaproxy when haproxyCfg is set", async () => {
    await deployPipeline(withInputs({ haproxyCfg: "/etc/haproxy/haproxy.cfg" }));

    expect(ensureHaproxyFragService).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      ipv6Only: false,
    });
    expect(deployHaproxy).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      cfgPath: "/etc/haproxy/haproxy.cfg",
      ipv6Only: false,
    });
  });

  it("passes correct options to deployHaproxyFragment when fragment input is set", async () => {
    await deployPipeline(
      withInputs({
        haproxyFragment: "/tmp/app.fragment.cfg",
        haproxyFragmentName: "app",
      }),
    );

    expect(deployHaproxyFragment).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      fragmentPath: "/tmp/app.fragment.cfg",
      fragmentName: "app",
      ipv6Only: false,
    });
  });

  it("passes correct options to deployHaproxyBase before fragment-only deployment", async () => {
    await deployPipeline(
      withInputs({
        haproxyFragment: "/tmp/app.fragment.cfg",
        haproxyFragmentName: "app",
      }),
    );

    expect(deployHaproxyBase).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      ipv6Only: false,
    });
    expect(deployHaproxy).not.toHaveBeenCalled();
    expect(deployHaproxyFragment).toHaveBeenCalledOnce();
  });

  it("passes correct options to configureFirewall when firewall is enabled", async () => {
    await deployPipeline(withInputs({ firewallEnabled: true }));

    expect(configureFirewall).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      ipv6Only: false,
      extraPorts: undefined,
    });
  });

  it("passes firewall extraPorts from inputs", async () => {
    await deployPipeline(withInputs({ firewallEnabled: true, firewallExtraPorts: ["8080", "53/udp"] }));

    expect(configureFirewall).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      ipv6Only: false,
      extraPorts: ["8080", "53/udp"],
    });
  });

  it("defaults deployPodman port to 8080 when containerPort is omitted", async () => {
    await deployPipeline(
      withInputs({
        containerImage: "docker.io/myapp:latest",
        serviceName: "myapp",
      }),
    );

    expect(deployPodman).toHaveBeenCalledWith({
      host: "1.2.3.4",
      user: "deploy",
      privateKey: "PRIVATE_KEY",
      image: "docker.io/myapp:latest",
      port: "8080",
      serviceName: "myapp",
      ipv6Only: false,
    });
  });
});
