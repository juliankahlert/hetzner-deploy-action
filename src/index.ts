import * as core from "@actions/core";
import { createClient } from "./hetzner/client.js";
import { ensureSshKey } from "./hetzner/sshKeys.js";
import { findOrCreateServer } from "./hetzner/findOrCreateServer.js";
import { rsyncDeploy } from "./deploy/rsync.js";
import { remoteSetup } from "./deploy/remoteSetup.js";
import { installPackages } from "./deploy/packageInstall.js";
import { validateInputs, type ValidatableInputs } from "./validate.js";

interface ActionInputs {
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
}

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
}

async function run(): Promise<void> {
  const inputs = parseInputs();

  maskSecrets(inputs);
  logInputs(inputs);

  // WP2: Hetzner resource provisioning
  core.info("--- Hetzner resource provisioning ---");

  const client = createClient(inputs.hcloudToken);

  core.info("Step 1/2: Ensuring SSH key is registered…");
  const sshKey = await ensureSshKey(
    client,
    `${inputs.projectTag}-deploy`,
    inputs.publicKey,
  );

  core.info("Step 2/2: Finding or creating server…");
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

  // WP3 + WP4: Deploy — ensure target dir, rsync files, then install systemd unit
  core.info("--- Deployment ---");

  if (inputs.ipv6Only) {
    core.warning(
      "ipv6_only is enabled — the runner must have IPv6 connectivity " +
        `to reach the server at ${server.ip}. If deploy fails, verify that ` +
        "your GitHub Actions runner supports outbound IPv6.",
    );
  }

  let setupResult = { unitInstalled: false, serviceRestarted: false };

  try {
    core.info("Step 1/4: Ensuring target directory on remote host…");
    await remoteSetup({
      host: server.ip,
      user: inputs.sshUser,
      privateKey: inputs.sshPrivateKey,
      targetDir: inputs.targetDir,
      ipv6Only: inputs.ipv6Only,
    });

    core.info("Step 2/4: Installing required packages…");
    await installPackages({
      host: server.ip,
      user: inputs.sshUser,
      privateKey: inputs.sshPrivateKey,
      ipv6Only: inputs.ipv6Only,
    });

    core.info("Step 3/4: Syncing files via rsync…");
    await rsyncDeploy({
      host: server.ip,
      user: inputs.sshUser,
      sourceDir: inputs.sourceDir,
      targetDir: inputs.targetDir,
      sshKey: inputs.sshPrivateKey,
      ipv6Only: inputs.ipv6Only,
    });

    if (inputs.serviceName) {
      core.info("Step 4/4: Installing and restarting systemd unit…");
      setupResult = await remoteSetup({
        host: server.ip,
        user: inputs.sshUser,
        privateKey: inputs.sshPrivateKey,
        targetDir: inputs.targetDir,
        serviceName: inputs.serviceName,
        ipv6Only: inputs.ipv6Only,
      });
      core.info(`Service unit "${inputs.serviceName}" installed and restarted.`);
    } else {
      core.info("Step 4/4: No service_name provided — skipping systemd unit.");
    }
  } catch (deployErr: unknown) {
    const msg =
      deployErr instanceof Error ? deployErr.message : String(deployErr);

    if (inputs.ipv6Only) {
      throw new Error(
        `Deploy to IPv6-only server failed: ${msg}\n` +
          "Hint: The server was provisioned with ipv6_only=true. Ensure " +
          "the GitHub Actions runner has outbound IPv6 connectivity. " +
          "Standard GitHub-hosted runners do NOT support IPv6.",
      );
    }
    throw deployErr;
  }

  core.info("--- Deployment complete ---");
  core.info(`  rsync:             done`);
  core.info(
    `  systemd unit:      ${setupResult.unitInstalled ? "installed" : "skipped"}`,
  );
  core.info(
    `  service restarted: ${setupResult.serviceRestarted ? "yes" : "no"}`,
  );

  core.info("Action completed.");
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(message);
});
