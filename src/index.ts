import * as core from "@actions/core";
import { load } from "js-yaml";
import { deployPipeline, type ActionInputs } from "./pipeline.js";
import {
  mapKebabToCamel,
  VALID_SERVICE_KEYS,
  validateInputs,
  validateServiceConfig,
  type ServiceConfig,
  type ValidatableInputs,
} from "./validate.js";

function defaultServiceExecStart(serviceName: string): string {
  return `/usr/bin/env bash -c 'echo "${serviceName} started"'`;
}

const DEFAULT_SERVICE_TYPE: ServiceConfig["type"] = "simple";
const DEFAULT_SERVICE_RESTART: ServiceConfig["restart"] = "on-failure";
const DEFAULT_SERVICE_RESTART_SEC = 5;

function parseServiceInput(input: string): Partial<ServiceConfig> | undefined {
  if (!input) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = load(input);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `INPUT_VALIDATION_ Invalid YAML for "service": ${message}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      'INPUT_VALIDATION_ Input "service" must be a YAML mapping/object.',
    );
  }

  const raw = parsed as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!VALID_SERVICE_KEYS.has(key)) {
      throw new Error(
        `INPUT_VALIDATION_ Invalid key in "service": ${JSON.stringify(key)}. Allowed keys: ${Array.from(VALID_SERVICE_KEYS).join(", ")}.`,
      );
    }
  }

  return mapKebabToCamel(raw);
}

function buildServiceConfig(raw: {
  serviceName: string;
  execStart?: string;
  serviceType: string;
  serviceRestart: string;
  serviceRestartSec: string;
  parsedService?: Partial<ServiceConfig>;
}): ServiceConfig | undefined {
  const merged = {
    ...(raw.serviceName
      ? {
          name: raw.serviceName,
          execStart: raw.execStart || defaultServiceExecStart(raw.serviceName),
          type: (raw.serviceType || DEFAULT_SERVICE_TYPE) as ServiceConfig["type"],
          restart: (raw.serviceRestart || DEFAULT_SERVICE_RESTART) as ServiceConfig["restart"],
          restartSec: raw.serviceRestartSec
            ? Number(raw.serviceRestartSec)
            : DEFAULT_SERVICE_RESTART_SEC,
        }
      : {}),
    ...raw.parsedService,
  };

  if (!merged.name) {
    return undefined;
  }

  return {
    name: merged.name,
    execStart:
      merged.execStart || raw.execStart || defaultServiceExecStart(merged.name),
    type: merged.type,
    restart: merged.restart,
    restartSec: merged.restartSec,
    user: merged.user,
    workingDirectory: merged.workingDirectory,
  };
}

function parseInputs(): ActionInputs {
  // Collect raw string values — defaults come from action.yml exclusively.
  const execStart = core.getInput("exec_start");
  const flatServiceName = core.getInput("service_name");
  const serviceType = core.getInput("service_type");
  const serviceRestart = core.getInput("service_restart");
  const serviceRestartSec = core.getInput("service_restart_sec");
  const serviceYaml = core.getInput("service");

  const parsedService = parseServiceInput(serviceYaml);
  validateServiceConfig(parsedService);

  const validatedServiceName = parsedService?.name ?? flatServiceName;
  const validatedExecStart = parsedService?.execStart ?? execStart;

  const raw = {
    serverName: core.getInput("server_name", { required: true }),
    sshUser: core.getInput("ssh_user"),
    sourceDir: core.getInput("source_dir"),
    targetDir: core.getInput("target_dir"),
    serviceName: validatedServiceName,
    serviceType:
      ((parsedService?.type ?? serviceType) || DEFAULT_SERVICE_TYPE) as string,
    serviceRestart:
      ((parsedService?.restart ?? serviceRestart) || DEFAULT_SERVICE_RESTART) as string,
    serviceRestartSec:
      parsedService?.restartSec != null
        ? String(parsedService.restartSec)
        : (serviceRestartSec || String(DEFAULT_SERVICE_RESTART_SEC)),
    ...(validatedExecStart ? { execStart: validatedExecStart } : {}),
    image: core.getInput("image"),
    serverType: core.getInput("server_type"),
    projectTag: core.getInput("project_tag", { required: true }),
    ipv6Only: core.getInput("ipv6_only"),
    containerImage: core.getInput("container_image"),
    containerPort: core.getInput("container_port"),
    haproxyCfg: core.getInput("haproxy_cfg"),
    haproxyFragment: core.getInput("haproxy_fragment"),
    haproxyFragmentName: core.getInput("haproxy_fragment_name"),
    firewallEnabled: core.getInput("firewall_enabled"),
    firewallExtraPorts: core.getInput("firewall_extra_ports"),
  } satisfies ValidatableInputs;

  // Validate all non-secret inputs before any cloud API call.
  validateInputs(raw);

  const service = buildServiceConfig({
    serviceName: flatServiceName,
    execStart: execStart || undefined,
    serviceType,
    serviceRestart,
    serviceRestartSec,
    parsedService,
  });

  return {
    hcloudToken: core.getInput("hcloud_token", { required: true }),
    serverName: raw.serverName,
    projectTag: raw.projectTag,
    image: raw.image,
    serverType: raw.serverType,
    ipv6Only: raw.ipv6Only === "true",
    publicKey: core.getInput("public_key", { required: true }),
    sshPrivateKey: core.getInput("ssh_private_key", { required: true }),
    sshUser: raw.sshUser,
    serviceName: flatServiceName,
    service,
    execStart: raw.execStart || undefined,
    sourceDir: raw.sourceDir,
    targetDir: raw.targetDir,
    containerImage: raw.containerImage || undefined,
    containerPort: raw.containerPort || undefined,
    haproxyCfg: raw.haproxyCfg || undefined,
    haproxyFragment: raw.haproxyFragment || undefined,
    haproxyFragmentName: raw.haproxyFragmentName || undefined,
    firewallEnabled: raw.firewallEnabled === "true",
    firewallExtraPorts: raw.firewallExtraPorts
      ? raw.firewallExtraPorts.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
  };
}

function maskSecrets(inputs: ActionInputs): void {
  core.setSecret(inputs.hcloudToken);
  if (inputs.sshPrivateKey) {
    core.setSecret(inputs.sshPrivateKey);
  }
  if (inputs.publicKey) {
    core.setSecret(inputs.publicKey);
  }
}

function logInputs(inputs: ActionInputs): void {
  core.info("Resolved inputs:");
  core.debug("Upload-only deploy bundle marker.");
  core.info(`  server_name:  ${inputs.serverName}`);
  core.info(`  project_tag:  ${inputs.projectTag}`);
  core.info(`  image:        ${inputs.image}`);
  core.info(`  server_type:  ${inputs.serverType}`);
  core.info(`  ipv6_only:    ${String(inputs.ipv6Only)}`);
  core.info(`  ssh_user:     ${inputs.sshUser}`);
  core.info(`  service:      ${inputs.service ? "(provided)" : "(not set)"}`);
  core.info(`  service_name: ${inputs.serviceName ? "(provided)" : "(not set)"}`);
  core.info(`  exec_start:   ${inputs.execStart ? "(provided)" : "(not set)"}`);
  core.info(`  source_dir:   ${inputs.sourceDir}`);
  core.info(`  target_dir:   ${inputs.targetDir}`);
  core.info(`  public_key:   ${inputs.publicKey ? "(provided)" : "(not set)"}`);
  core.info(
    `  ssh_private_key: ${inputs.sshPrivateKey ? "(provided)" : "(not set)"}`,
  );
  core.info(
    `  container_image: ${inputs.containerImage ?? "(not set)"}`,
  );
  core.info(`  container_port: ${inputs.containerPort ?? "(not set)"}`);
  core.info(
    `  haproxy_cfg:     ${inputs.haproxyCfg ?? "(not set)"}`,
  );
  core.info(
    `  haproxy_fragment: ${inputs.haproxyFragment ?? "(not set)"}`,
  );
  core.info(
    `  haproxy_fragment_name: ${inputs.haproxyFragmentName ?? "(not set)"}`,
  );
  core.info(
    `  firewall_enabled: ${String(inputs.firewallEnabled)}`,
  );
  core.info(
    `  firewall_extra_ports: ${inputs.firewallExtraPorts?.join(", ") ?? "(not set)"}`,
  );
}

async function run(): Promise<void> {
  const inputs = parseInputs();

  maskSecrets(inputs);
  logInputs(inputs);

  await deployPipeline(inputs);

  core.info("Action completed.");
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(message);
});
