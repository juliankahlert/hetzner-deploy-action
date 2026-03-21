import * as core from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createClient } from "./hetzner/client.js";
import { ensureSshKey } from "./hetzner/sshKeys.js";
import { findOrCreateServer } from "./hetzner/findOrCreateServer.js";
import {
  ensureServiceUser,
  ensureTargetDir,
  installSystemdUnit,
  setTargetOwnership,
} from "./deploy/remoteSetup.js";
import { detectOs } from "./deploy/osDetect.js";
import { DEFAULT_PACKAGES, installPackages } from "./deploy/packageInstall.js";
import { rsyncDeploy } from "./deploy/rsync.js";
import { deployPodman } from "./deploy/podman.js";
import {
  deployHaproxy,
  deployHaproxyBase,
  deployHaproxyCertbotFragment,
  deployHaproxyFragment,
  deployHaproxyFragmentWithoutReload,
  ensureHaproxyFragService,
} from "./deploy/haproxy.js";
import { compileFragment } from "./deploy/haproxyCompiler.js";
import { generateFragment } from "./deploy/haproxyGenerator.js";
import { deployDuckdns } from "./deploy/duckdns.js";
import { configureFirewall } from "./deploy/firewall.js";
import { waitForSsh, withKeyFile } from "./deploy/ssh.js";
import type { OsStrategy } from "./deploy/osStrategy.js";
import { normalizeRoute } from "./deploy/haproxyTypes.js";
import type { ServiceConfig } from "./validate.js";

const DEFAULT_CERTBOT_PORT = "8888";
const DEFAULT_SIMPLIFIED_HOST_PORT = 443;
const DEFAULT_SIMPLIFIED_ROUTE = "/*";
const DEFAULT_SIMPLIFIED_FRAGMENT_NAME = "json-fragment";
const DEFAULT_SIMPLIFIED_SSL_CERT_PATH = "/etc/haproxy/certs/";
const CERTBOT_FRAGMENT_NAME = "certbot";
const HAPROXY_SIMPLIFIED_LOG_PREFIX = "[HAPROXY_SIMPLIFIED]";

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
  duckdns: "duckdns",
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
  STAGES.duckdns,
  STAGES.firewall,
];

/* ------------------------------------------------------------------ */
/*  Pipeline inputs                                                   */
/* ------------------------------------------------------------------ */

export interface DuckDnsConfig {
  token: string;
  domain: string;
}

/** Inputs consumed by the deploy pipeline. */
export interface ActionInputs {
  hcloudToken: string;
  serverName: string;
  projectTag: string;
  image: string;
  serverType: string;
  ipv6Only: boolean;
  certbot: boolean;
  duckdns?: DuckDnsConfig;
  publicKey: string;
  sshPrivateKey: string;
  sshUser: string;
  serviceName: string;
  service?: ServiceConfig;
  sourceDir: string;
  targetDir: string;
  /** Custom ExecStart command for the installed systemd unit. */
  execStart?: string;
  /** Container image reference — enables the podman stage when set. */
  containerImage?: string;
  /** Container port or mapping passed to Podman Quadlet. */
  containerPort?: string;
  /** Certbot HTTP-01 port override. */
  certbotPort?: string;
  /** HAProxy config path — enables the haproxy stage when set. */
  haproxyCfg?: string;
  /** HAProxy fragment path — also enables the haproxy stage when set. */
  haproxyFragment?: string;
  /** HAProxy fragment name written on the remote host. */
  haproxyFragmentName?: string;
  /** Simplified HAProxy host port input. */
  hostPort?: string;
  /** Simplified HAProxy route input. */
  route?: string;
  /** Simplified HAProxy app port input. */
  appPort?: string;
  /** Enables the firewall stage when true. */
  firewallEnabled?: boolean;
  /** Additional firewall ports to allow. */
  firewallExtraPorts?: string[];
}

/* ------------------------------------------------------------------ */
/*  Error helper                                                      */
/* ------------------------------------------------------------------ */

/** Wrap a stage failure with the DEPLOY_PIPELINE_ prefix. */
function pipelineError(stage: StageName, cause: unknown): Error {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new Error(`DEPLOY_PIPELINE_${stage}: ${msg}`);
}

function mergeHaproxyResult(
  current: { configUploaded: boolean; serviceReloaded: boolean },
  next: { configUploaded: boolean; serviceReloaded: boolean },
): { configUploaded: boolean; serviceReloaded: boolean } {
  return {
    configUploaded: current.configUploaded || next.configUploaded,
    serviceReloaded: current.serviceReloaded || next.serviceReloaded,
  };
}

function hasSimplifiedHaproxyInputs(inputs: ActionInputs): boolean {
  return Boolean(inputs.hostPort || inputs.route || inputs.appPort);
}

function hasRawHaproxyInputs(inputs: ActionInputs): boolean {
  return Boolean(inputs.haproxyCfg || inputs.haproxyFragment);
}

function resolveSimplifiedFragmentName(inputs: ActionInputs): string {
  return (
    inputs.service?.name ||
    inputs.serviceName ||
    inputs.haproxyFragmentName ||
    DEFAULT_SIMPLIFIED_FRAGMENT_NAME
  );
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
        return Boolean(inputs.service?.name) && !inputs.containerImage;
      case STAGES.haproxy:
        return Boolean(
          inputs.haproxyCfg ||
            inputs.haproxyFragment ||
            inputs.certbot ||
            hasSimplifiedHaproxyInputs(inputs),
        );
      case STAGES.duckdns:
        return Boolean(inputs.duckdns);
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

  const effectiveIpv6Only = server.ipv6Only;

  /* ---- Deployment stages ---- */
  core.info("--- Deployment ---");

  if (effectiveIpv6Only !== inputs.ipv6Only) {
    core.warning(
      `Server networking differs from requested ipv6_only=${inputs.ipv6Only}; ` +
        `server-effective ipv6_only=${effectiveIpv6Only}. ` +
        "Continuing deployment using the server's effective IPv6 mode.",
    );
  }

  if (inputs.ipv6Only) {
    core.warning(
      "ipv6_only is enabled by user request — the runner must have IPv6 connectivity " +
        `to reach the server at ${server.ip}. If deploy fails, verify that ` +
        "your GitHub Actions runner supports outbound IPv6.",
    );
  }

  core.info("Waiting for SSH to become available...");
  await withKeyFile(inputs.sshPrivateKey, async (keyPath) => {
    await waitForSsh(keyPath, inputs.sshUser, server.ip, effectiveIpv6Only);
  });
  core.info("SSH is ready.");

  core.info(`[OS_DETECT] Starting remote OS detection for ${server.ip}...`);
  let strategy: OsStrategy;
  try {
    strategy = await detectOs({
      image: inputs.image,
      host: server.ip,
      user: inputs.sshUser,
      privateKey: inputs.sshPrivateKey,
      ipv6Only: effectiveIpv6Only,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`DEPLOY_PIPELINE_osDetect: ${msg}`);
  }
  core.info(`[OS_DETECT] Using ${strategy.family} strategy family.`);

  const stages = activeStages(inputs);
  const total = stages.length;
  let setupResult = { unitInstalled: false, serviceRestarted: false };
  let podmanResult = { quadletUploaded: false, serviceRestarted: false };
  let haproxyResult = { configUploaded: false, serviceReloaded: false };
  let duckdnsResult = { domainUpdated: false, timerInstalled: false };
  let firewallResult = { firewallEnabled: false, rulesApplied: 0 };

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
            packages: inputs.certbot
              ? [...DEFAULT_PACKAGES, "certbot"]
              : undefined,
            strategy,
            ipv6Only: effectiveIpv6Only,
          });
          break;

        case STAGES.ensureTargetDir:
          await ensureTargetDir({
            host: server.ip,
            user: inputs.sshUser,
            privateKey: inputs.sshPrivateKey,
            targetDir: inputs.targetDir,
            ipv6Only: effectiveIpv6Only,
          });
          break;

        case STAGES.rsyncDeploy:
          await rsyncDeploy({
            host: server.ip,
            user: inputs.sshUser,
            sourceDir: inputs.sourceDir,
            targetDir: inputs.targetDir,
            sshKey: inputs.sshPrivateKey,
            ipv6Only: effectiveIpv6Only,
          });
          break;

        case STAGES.podman:
          if (!inputs.containerImage) {
            throw new Error("container_image is required for podman deployment");
          }
          {
            const serviceName = inputs.service?.name || inputs.serviceName || "app";
            podmanResult = await deployPodman({
              host: server.ip,
              user: inputs.sshUser,
              privateKey: inputs.sshPrivateKey,
              image: inputs.containerImage,
              port: inputs.containerPort ?? "8080",
              serviceName,
              ipv6Only: effectiveIpv6Only,
            });
            core.info(`Podman service "${serviceName}" deployed and restarted.`);
          }
          break;

        case STAGES.systemd:
          if (!inputs.service?.name) {
            throw new Error("service.name is required for systemd deployment");
          }
          if (inputs.service.user) {
            core.info(`  Ensuring service user "${inputs.service.user}"...`);
            await ensureServiceUser({
              host: server.ip,
              user: inputs.sshUser,
              privateKey: inputs.sshPrivateKey,
              serviceUser: inputs.service.user,
              ipv6Only: effectiveIpv6Only,
            });
            core.info(`  Service user "${inputs.service.user}" ready.`);

            const serviceWorkingDirectory =
              inputs.service.workingDirectory ?? inputs.targetDir;
            core.info(
              `  Resetting ownership for "${serviceWorkingDirectory}" to "${inputs.service.user}"...`,
            );
            await setTargetOwnership({
              host: server.ip,
              user: inputs.sshUser,
              privateKey: inputs.sshPrivateKey,
              serviceUser: inputs.service.user,
              targetDir: serviceWorkingDirectory,
              ipv6Only: effectiveIpv6Only,
            });
            core.info(`  Ownership reset for "${serviceWorkingDirectory}".`);
          }
          core.info(`  Installing systemd unit for "${inputs.service.name}"...`);
          setupResult = await installSystemdUnit({
            host: server.ip,
            user: inputs.sshUser,
            privateKey: inputs.sshPrivateKey,
            targetDir: inputs.targetDir,
            serviceUser: inputs.service.user,
            serviceWorkingDirectory: inputs.service.workingDirectory,
            serviceName: inputs.service.name,
            execStart: inputs.service.execStart,
            serviceType: inputs.service.type,
            serviceRestart: inputs.service.restart,
            serviceRestartSec: inputs.service.restartSec,
            ipv6Only: effectiveIpv6Only,
          });
          core.info(`  Systemd unit "${inputs.service.name}" installed.`);
          core.info(`Service unit "${inputs.service.name}" installed and restarted.`);
          break;

        case STAGES.haproxy:
          if (
            !inputs.haproxyCfg &&
            !inputs.haproxyFragment &&
            !inputs.certbot &&
            !hasSimplifiedHaproxyInputs(inputs)
          ) {
            throw new Error(
              "haproxy_cfg, haproxy_fragment, certbot, or simplified HAProxy inputs are required for haproxy deployment",
            );
          }

          {
            const simplifiedInputsPresent = hasSimplifiedHaproxyInputs(inputs);
            const rawHaproxyInputsPresent = hasRawHaproxyInputs(inputs);
            const useSimplifiedHaproxyFlow = simplifiedInputsPresent && !rawHaproxyInputsPresent;
            const shouldDeployBaseConfig =
              !inputs.haproxyCfg &&
              (Boolean(inputs.haproxyFragment) || inputs.certbot || useSimplifiedHaproxyFlow);
            const certbotPort = inputs.certbotPort ?? DEFAULT_CERTBOT_PORT;

            await ensureHaproxyFragService({
              host: server.ip,
              user: inputs.sshUser,
              privateKey: inputs.sshPrivateKey,
              ipv6Only: effectiveIpv6Only,
            });

            if (inputs.haproxyCfg) {
              haproxyResult = mergeHaproxyResult(
                haproxyResult,
                await deployHaproxy({
                  host: server.ip,
                  user: inputs.sshUser,
                  privateKey: inputs.sshPrivateKey,
                  cfgPath: inputs.haproxyCfg,
                  ipv6Only: effectiveIpv6Only,
                }),
              );
            }

            if (shouldDeployBaseConfig) {
              core.info(
                "HAProxy fragment-only mode detected; deploying bundled base config before fragment deployment.",
              );
              haproxyResult = mergeHaproxyResult(
                haproxyResult,
                await deployHaproxyBase({
                  host: server.ip,
                  user: inputs.sshUser,
                  privateKey: inputs.sshPrivateKey,
                  ipv6Only: effectiveIpv6Only,
                }),
              );
            }

            if (useSimplifiedHaproxyFlow) {
              core.info(
                `${HAPROXY_SIMPLIFIED_LOG_PREFIX} Simplified-input branch selected for HAProxy stage (raw file inputs not selected).`,
              );

              if (!inputs.appPort) {
                throw new Error(
                  "app_port is required for simplified HAProxy deployment when host_port or route is provided",
                );
              }

              const bindPort = Number(inputs.hostPort ?? DEFAULT_SIMPLIFIED_HOST_PORT);
              const backendPort = Number(inputs.appPort);
              const routeInput = inputs.route ?? DEFAULT_SIMPLIFIED_ROUTE;
              const normalizedRoute = normalizeRoute(routeInput);
              const fragmentName = resolveSimplifiedFragmentName(inputs);
              const serviceName = resolveSimplifiedFragmentName(inputs);

              core.info(
                `${HAPROXY_SIMPLIFIED_LOG_PREFIX} Normalized route summary: kind=${normalizedRoute.kind}, host=${normalizedRoute.host ?? "(none)"}, path=${normalizedRoute.path ?? "(none)"}, prefix=${normalizedRoute.isPathPrefix ? "yes" : "no"}.`,
              );

              const generated = generateFragment({
                serviceName,
                bindPort,
                backendAddress: "127.0.0.1",
                backendPort,
                domain: routeInput,
                certbot: inputs.certbot,
                certbotPort: Number(certbotPort),
                sslCertPath:
                  bindPort === 443 ? DEFAULT_SIMPLIFIED_SSL_CERT_PATH : undefined,
              });

              const hasSeparateCertbotFragment = Boolean(generated.certbotFragment);
              core.info(
                `${HAPROXY_SIMPLIFIED_LOG_PREFIX} Local certbot merge decision: ${inputs.certbot ? (hasSeparateCertbotFragment ? "compile separate certbot fragment" : "certbot merged into primary fragment") : "certbot disabled; primary fragment only"}.`,
              );

              let tempDir: string | undefined;

              try {
                tempDir = fs.mkdtempSync(
                  path.join(os.tmpdir(), "haproxy-simplified-"),
                );
                core.info(
                  `${HAPROXY_SIMPLIFIED_LOG_PREFIX} Created temp directory for compiled fragments: ${tempDir}.`,
                );

                const primaryTempPath = path.join(tempDir, "primary.cfg");
                const compiledPrimary = compileFragment(generated.fragment);
                core.info(
                  `${HAPROXY_SIMPLIFIED_LOG_PREFIX} Writing compiled primary fragment temp file: ${primaryTempPath}.`,
                );
                fs.writeFileSync(primaryTempPath, compiledPrimary, "utf8");

                if (hasSeparateCertbotFragment && generated.certbotFragment) {
                  const certbotTempPath = path.join(tempDir, "certbot.cfg");
                  const compiledCertbot = compileFragment(generated.certbotFragment);
                  core.info(
                    `${HAPROXY_SIMPLIFIED_LOG_PREFIX} Writing compiled certbot fragment temp file: ${certbotTempPath}.`,
                  );
                  fs.writeFileSync(certbotTempPath, compiledCertbot, "utf8");

                  core.info(
                    `${HAPROXY_SIMPLIFIED_LOG_PREFIX} Invoking deployHaproxyFragmentWithoutReload for compiled primary temp file ${primaryTempPath} as fragment "${fragmentName}".`,
                  );
                  haproxyResult = mergeHaproxyResult(
                    haproxyResult,
                    await deployHaproxyFragmentWithoutReload({
                      host: server.ip,
                      user: inputs.sshUser,
                      privateKey: inputs.sshPrivateKey,
                      fragmentPath: primaryTempPath,
                      fragmentName,
                      ipv6Only: effectiveIpv6Only,
                    }),
                  );

                  core.info(
                    `${HAPROXY_SIMPLIFIED_LOG_PREFIX} Invoking deployHaproxyFragment for compiled certbot temp file ${certbotTempPath} as fragment "${CERTBOT_FRAGMENT_NAME}".`,
                  );
                  haproxyResult = mergeHaproxyResult(
                    haproxyResult,
                    await deployHaproxyFragment({
                      host: server.ip,
                      user: inputs.sshUser,
                      privateKey: inputs.sshPrivateKey,
                      fragmentPath: certbotTempPath,
                      fragmentName: CERTBOT_FRAGMENT_NAME,
                      ipv6Only: effectiveIpv6Only,
                    }),
                  );
                } else {
                  core.info(
                    `${HAPROXY_SIMPLIFIED_LOG_PREFIX} Invoking deployHaproxyFragment for compiled primary temp file ${primaryTempPath} as fragment "${fragmentName}".`,
                  );
                  haproxyResult = mergeHaproxyResult(
                    haproxyResult,
                    await deployHaproxyFragment({
                      host: server.ip,
                      user: inputs.sshUser,
                      privateKey: inputs.sshPrivateKey,
                      fragmentPath: primaryTempPath,
                      fragmentName,
                      ipv6Only: effectiveIpv6Only,
                    }),
                  );
                }
              } finally {
                if (tempDir) {
                  core.info(
                    `${HAPROXY_SIMPLIFIED_LOG_PREFIX} Cleaning up compiled fragment temp directory: ${tempDir}.`,
                  );
                  fs.rmSync(tempDir, { recursive: true, force: true });
                  core.info(
                    `${HAPROXY_SIMPLIFIED_LOG_PREFIX} Temp directory cleanup complete: ${tempDir}.`,
                  );
                }
              }
            }

            if (inputs.haproxyFragment) {
              if (!inputs.haproxyFragmentName) {
                throw new Error(
                  "haproxy_fragment_name is required for haproxy fragment deployment",
                );
              }

              if (inputs.certbot) {
                core.info(
                  `HAProxy certbot flow enabled; uploading custom fragment "${inputs.haproxyFragmentName}" without reloading so certbot can trigger the final fragment reload once.`,
                );
                haproxyResult = mergeHaproxyResult(
                  haproxyResult,
                  await deployHaproxyFragmentWithoutReload({
                    host: server.ip,
                    user: inputs.sshUser,
                    privateKey: inputs.sshPrivateKey,
                    fragmentPath: inputs.haproxyFragment,
                    fragmentName: inputs.haproxyFragmentName,
                    ipv6Only: effectiveIpv6Only,
                  }),
                );
              } else {
                haproxyResult = mergeHaproxyResult(
                  haproxyResult,
                  await deployHaproxyFragment({
                    host: server.ip,
                    user: inputs.sshUser,
                    privateKey: inputs.sshPrivateKey,
                    fragmentPath: inputs.haproxyFragment,
                    fragmentName: inputs.haproxyFragmentName,
                    ipv6Only: effectiveIpv6Only,
                  }),
                );
              }
            }

            if (inputs.certbot && !useSimplifiedHaproxyFlow) {
              core.info(
                `HAProxy certbot flow enabled; deploying bundled certbot fragment with final haproxy-frag reload using certbot_port=${certbotPort}.`,
              );
              haproxyResult = mergeHaproxyResult(
                haproxyResult,
                await deployHaproxyCertbotFragment({
                  host: server.ip,
                  user: inputs.sshUser,
                  privateKey: inputs.sshPrivateKey,
                  certbotPort,
                  ipv6Only: effectiveIpv6Only,
                }),
              );
            }
          }
          core.info("HAProxy configuration deployed and service reloaded.");
          break;

        case STAGES.duckdns:
          if (!inputs.duckdns) {
            throw new Error("duckdns input is required for duckdns deployment");
          }
          core.info(
            `[DUCKDNS] Starting DuckDNS stage for domain "${inputs.duckdns.domain}".`,
          );
          duckdnsResult = await deployDuckdns({
            host: server.ip,
            user: inputs.sshUser,
            privateKey: inputs.sshPrivateKey,
            token: inputs.duckdns.token,
            domain: inputs.duckdns.domain,
            ipv6Only: effectiveIpv6Only,
          });
          core.info(
            `[DUCKDNS] Stage result: domainUpdated=${String(duckdnsResult.domainUpdated)} timerInstalled=${String(duckdnsResult.timerInstalled)}.`,
          );
          core.info("DuckDNS deployment completed successfully.");
          break;

        case STAGES.firewall:
          firewallResult = await configureFirewall({
            host: server.ip,
            user: inputs.sshUser,
            privateKey: inputs.sshPrivateKey,
            ipv6Only: effectiveIpv6Only,
            extraPorts: inputs.firewallExtraPorts,
            strategy,
          });
          core.info("Firewall configured and enabled.");
          break;
      }
    } catch (err: unknown) {
      if (effectiveIpv6Only) {
        if (inputs.ipv6Only) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `DEPLOY_PIPELINE_${stage}: Deploy to IPv6-only server failed: ${msg}\n` +
              "Hint: The server-effective ipv6_only setting is true. Ensure " +
              "the GitHub Actions runner has outbound IPv6 connectivity. " +
              "Standard GitHub-hosted runners do NOT support IPv6.",
          );
        }
        core.warning(
          "The server-effective ipv6_only setting is true. Deploy connectivity may still require outbound IPv6 support from the GitHub Actions runner.",
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
  if (stages.includes(STAGES.haproxy)) {
    core.info(
      `  haproxy config:    ${haproxyResult.configUploaded ? "uploaded" : "skipped"}`,
    );
    core.info(
      `  haproxy reloaded:  ${haproxyResult.serviceReloaded ? "yes" : "no"}`,
    );
  }
  if (stages.includes(STAGES.duckdns)) {
    core.info(
      `  duckdns updated:   ${duckdnsResult.domainUpdated ? "yes" : "no"}`,
    );
    core.info(
      `  duckdns timer:     ${duckdnsResult.timerInstalled ? "installed" : "skipped"}`,
    );
  }
  if (stages.includes(STAGES.firewall)) {
    core.info(
      `  firewall enabled:  ${firewallResult.firewallEnabled ? "yes" : "no"}`,
    );
    core.info(`  firewall rules:   ${firewallResult.rulesApplied}`);
  }
  core.info(
    `  systemd unit:      ${setupResult.unitInstalled ? "installed" : "skipped"}`,
  );
  core.info(
    `  service restarted: ${setupResult.serviceRestarted ? "yes" : "no"}`,
  );
  core.info("Pipeline completed.");
}
