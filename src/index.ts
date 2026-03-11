import * as core from "@actions/core";
import { deployPipeline, type ActionInputs } from "./pipeline.js";
import { validateInputs, type ValidatableInputs } from "./validate.js";

function parseInputs(): ActionInputs {
  // Collect raw string values — defaults come from action.yml exclusively.
  const raw: ValidatableInputs = {
    serverName: core.getInput("server_name", { required: true }),
    sshUser: core.getInput("ssh_user"),
    sourceDir: core.getInput("source_dir"),
    targetDir: core.getInput("target_dir"),
    serviceName: core.getInput("service_name"),
    image: core.getInput("image"),
    serverType: core.getInput("server_type"),
    projectTag: core.getInput("project_tag", { required: true }),
    ipv6Only: core.getInput("ipv6_only"),
    containerImage: core.getInput("container_image"),
    haproxyCfg: core.getInput("haproxy_cfg"),
    firewallEnabled: core.getInput("firewall_enabled"),
  };

  // Validate all non-secret inputs before any cloud API call.
  validateInputs(raw);

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
    serviceName: raw.serviceName,
    sourceDir: raw.sourceDir,
    targetDir: raw.targetDir,
    containerImage: raw.containerImage || undefined,
    haproxyCfg: raw.haproxyCfg || undefined,
    firewallEnabled: raw.firewallEnabled === "true",
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
  core.info(`  server_name:  ${inputs.serverName}`);
  core.info(`  project_tag:  ${inputs.projectTag}`);
  core.info(`  image:        ${inputs.image}`);
  core.info(`  server_type:  ${inputs.serverType}`);
  core.info(`  ipv6_only:    ${String(inputs.ipv6Only)}`);
  core.info(`  ssh_user:     ${inputs.sshUser}`);
  core.info(`  service_name: ${inputs.serviceName ? "(provided)" : "(not set)"}`);
  core.info(`  source_dir:   ${inputs.sourceDir}`);
  core.info(`  target_dir:   ${inputs.targetDir}`);
  core.info(`  public_key:   ${inputs.publicKey ? "(provided)" : "(not set)"}`);
  core.info(
    `  ssh_private_key: ${inputs.sshPrivateKey ? "(provided)" : "(not set)"}`,
  );
  core.info(
    `  container_image: ${inputs.containerImage ?? "(not set)"}`,
  );
  core.info(
    `  haproxy_cfg:     ${inputs.haproxyCfg ?? "(not set)"}`,
  );
  core.info(
    `  firewall_enabled: ${String(inputs.firewallEnabled)}`,
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
