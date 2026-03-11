import * as core from "@actions/core";
import { createClient } from "./hetzner/client.js";
import { ensureSshKey } from "./hetzner/sshKeys.js";
import { findOrCreateServer } from "./hetzner/findOrCreateServer.js";
import { ensureTargetDir, installSystemdUnit } from "./deploy/remoteSetup.js";
import { installPackages } from "./deploy/packageInstall.js";
import { rsyncDeploy } from "./deploy/rsync.js";
import { deployPodman } from "./deploy/podman.js";

/* ------------------------------------------------------------------ */
/*  Stage labels (ordered)                                            */
/* ------------------------------------------------------------------ */

/** Labeled constants for each pipeline stage, in execution order. */
export const STAGES = {
  installPackages: "installPackages",
  ensureTargetDir: "ensureTargetDir",
  rsyncDeploy: "rsyncDeploy",
  podman: "podman",
  systemd: "systemd",
  haproxy: "haproxy",
  firewall: "firewall",
} as const;

export type StageName = (typeof STAGES)[keyof typeof STAGES];

/** Ordered list of all stage labels for deterministic iteration. */
export const STAGE_ORDER: readonly StageName[] = [
  STAGES.installPackages,
  STAGES.ensureTargetDir,
  STAGES.rsyncDeploy,
  STAGES.podman,
  STAGES.systemd,
  STAGES.haproxy,
  STAGES.firewall,
];

/* ------------------------------------------------------------------ */
/*  Pipeline inputs                                                   */
/* ------------------------------------------------------------------ */

/** Inputs consumed by the deploy pipeline. */
export interface ActionInputs {
  hcloudToken: string;
  serverName: string;
  projectTag: string;
  image: string;
  serverType: string;
  ipv6Only: boolean;
  publicKey: string;
  sshPrivateKey: string;
  sshUser: string;
  serviceName: string;
  sourceDir: string;
  targetDir: string;
  /** Container image reference — enables the podman stage when set. */
  containerImage?: string;
  /** Container port or mapping passed to Podman Quadlet. */
  containerPort?: string;
  /** HAProxy config path — enables the haproxy stage when set. */
  haproxyCfg?: string;
  /** Enables the firewall stage when true. */
  firewallEnabled?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Error helper                                                      */
/* ------------------------------------------------------------------ */

/** Wrap a stage failure with the DEPLOY_PIPELINE_ prefix. */
function pipelineError(stage: StageName, cause: unknown): Error {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new Error(`DEPLOY_PIPELINE_${stage}: ${msg}`);
}

/* ------------------------------------------------------------------ */
/*  Stage predicates                                                  */
/* ------------------------------------------------------------------ */

/** Determine which stages are active for the given inputs. */
export function activeStages(inputs: ActionInputs): StageName[] {
  return STAGE_ORDER.filter((stage) => {
    switch (stage) {
      case STAGES.installPackages:
      case STAGES.ensureTargetDir:
      case STAGES.rsyncDeploy:
        return true;
      case STAGES.podman:
        return Boolean(inputs.containerImage);
      case STAGES.systemd:
        return Boolean(inputs.serviceName) && !inputs.containerImage;
      case STAGES.haproxy:
        return Boolean(inputs.haproxyCfg);
      case STAGES.firewall:
        return Boolean(inputs.firewallEnabled);
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Pipeline                                                          */
/* ------------------------------------------------------------------ */

/**
 * Orchestrate the full provisioning + deployment pipeline.
 *
 * 1. Provision Hetzner resources (SSH key, server).
 * 2. Execute ordered deploy stages, skipping those whose inputs are absent.
 *
 * Stage failures are wrapped with a `DEPLOY_PIPELINE_<stage>:` prefix so
 * callers can identify which step failed.
 */
export async function deployPipeline(inputs: ActionInputs): Promise<void> {
  /* ---- Hetzner resource provisioning ---- */
  core.info("--- Hetzner resource provisioning ---");

  const client = createClient(inputs.hcloudToken);

  core.info("Provisioning: Ensuring SSH key is registered…");
  const sshKey = await ensureSshKey(
    client,
    `${inputs.projectTag}-deploy`,
    inputs.publicKey,
  );

  core.info("Provisioning: Finding or creating server…");
  const server = await findOrCreateServer(client, {
    name: inputs.serverName,
    projectTag: inputs.projectTag,
    image: inputs.image,
    serverType: inputs.serverType,
    ipv6Only: inputs.ipv6Only,
    sshKeyIds: [sshKey.id],
  });

  core.setOutput("server_ip", server.ip);
  core.setOutput("server_id", String(server.id));
  core.setOutput("server_status", server.status);

  core.info("--- Hetzner provisioning complete ---");
  core.info(`  server_id:     ${server.id}`);
  core.info(`  server_ip:     ${server.ip}`);
  core.info(`  server_status: ${server.status}`);

  /* ---- Deployment stages ---- */
  core.info("--- Deployment ---");

  if (inputs.ipv6Only) {
    core.warning(
      "ipv6_only is enabled — the runner must have IPv6 connectivity " +
        `to reach the server at ${server.ip}. If deploy fails, verify that ` +
        "your GitHub Actions runner supports outbound IPv6.",
    );
  }

  const stages = activeStages(inputs);
  const total = stages.length;
  let setupResult = { unitInstalled: false, serviceRestarted: false };
  let podmanResult = { quadletUploaded: false, serviceRestarted: false };

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const stepLabel = `Step ${i + 1}/${total}`;

    core.info(`${stepLabel}: [${stage}]`);

    try {
      switch (stage) {
        case STAGES.installPackages:
          await installPackages({
            host: server.ip,
            user: inputs.sshUser,
            privateKey: inputs.sshPrivateKey,
            ipv6Only: inputs.ipv6Only,
          });
          break;

        case STAGES.ensureTargetDir:
          await ensureTargetDir({
            host: server.ip,
            user: inputs.sshUser,
            privateKey: inputs.sshPrivateKey,
            targetDir: inputs.targetDir,
            ipv6Only: inputs.ipv6Only,
          });
          break;

        case STAGES.rsyncDeploy:
          await rsyncDeploy({
            host: server.ip,
            user: inputs.sshUser,
            sourceDir: inputs.sourceDir,
            targetDir: inputs.targetDir,
            sshKey: inputs.sshPrivateKey,
            ipv6Only: inputs.ipv6Only,
          });
          break;

        case STAGES.podman:
          if (!inputs.containerImage) {
            throw new Error("container_image is required for podman deployment");
          }
          podmanResult = await deployPodman({
            host: server.ip,
            user: inputs.sshUser,
            privateKey: inputs.sshPrivateKey,
            image: inputs.containerImage,
            port: inputs.containerPort ?? "8080",
            serviceName: inputs.serviceName || "app",
            ipv6Only: inputs.ipv6Only,
          });
          core.info(
            `Podman service "${inputs.serviceName || "app"}" deployed and restarted.`,
          );
          break;

        case STAGES.systemd:
          setupResult = await installSystemdUnit({
            host: server.ip,
            user: inputs.sshUser,
            privateKey: inputs.sshPrivateKey,
            targetDir: inputs.targetDir,
            serviceName: inputs.serviceName,
            ipv6Only: inputs.ipv6Only,
          });
          core.info(`Service unit "${inputs.serviceName}" installed and restarted.`);
          break;

        case STAGES.haproxy:
          // Future: HAProxy configuration
          core.info(`[${stage}] HAProxy configuration not yet implemented.`);
          break;

        case STAGES.firewall:
          // Future: Firewall rules
          core.info(`[${stage}] Firewall configuration not yet implemented.`);
          break;
      }
    } catch (err: unknown) {
      if (inputs.ipv6Only) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `DEPLOY_PIPELINE_${stage}: Deploy to IPv6-only server failed: ${msg}\n` +
            "Hint: The server was provisioned with ipv6_only=true. Ensure " +
            "the GitHub Actions runner has outbound IPv6 connectivity. " +
            "Standard GitHub-hosted runners do NOT support IPv6.",
        );
      }
      throw pipelineError(stage, err);
    }

    core.info(`${stepLabel}: [${stage}] done`);
  }

  /* ---- Summary ---- */
  core.info("--- Deployment complete ---");
  core.info(`  stages executed: ${stages.join(", ")}`);
  core.info(`  rsync:             done`);
  if (stages.includes(STAGES.podman)) {
    core.info(
      `  podman quadlet:    ${podmanResult.quadletUploaded ? "uploaded" : "skipped"}`,
    );
    core.info(
      `  podman restarted:  ${podmanResult.serviceRestarted ? "yes" : "no"}`,
    );
  }
  core.info(
    `  systemd unit:      ${setupResult.unitInstalled ? "installed" : "skipped"}`,
  );
  core.info(
    `  service restarted: ${setupResult.serviceRestarted ? "yes" : "no"}`,
  );
  core.info("Pipeline completed.");
}
