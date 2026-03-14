import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";
import { sshExec, withKeyFile, shellQuote } from "./ssh.js";

/* ------------------------------------------------------------------ */
/*  Option / result interfaces                                        */
/* ------------------------------------------------------------------ */

/** Options for remote host setup (backward-compatible). */
export interface RemoteSetupOptions {
  /** Server IP or hostname. */
  host: string;
  /** SSH user (e.g. "root"). */
  user: string;
  /** SSH private key content. */
  privateKey: string;
  /** Absolute path on remote where files will be deployed. */
  targetDir: string;
  /** Optional systemd service name. When provided the unit is installed and the service restarted. */
  serviceName?: string;
  /** Command that systemd ExecStart= should invoke. Defaults to a no-op placeholder. */
  execStart?: string;
  /** When true the host is an IPv6 address — forces ssh to use `-6`. */
  ipv6Only?: boolean;
}

/** Options for ensuring the target directory on the remote host. */
export interface EnsureTargetDirOptions {
  /** Server IP or hostname. */
  host: string;
  /** SSH user (e.g. "root"). */
  user: string;
  /** SSH private key content. */
  privateKey: string;
  /** Absolute path on remote to create. */
  targetDir: string;
  /** When true the host is an IPv6 address — forces ssh to use `-6`. */
  ipv6Only?: boolean;
}

/** Options for installing (and restarting) a systemd unit. */
export interface InstallSystemdUnitOptions {
  /** Server IP or hostname. */
  host: string;
  /** SSH user (e.g. "root"). */
  user: string;
  /** SSH private key content. */
  privateKey: string;
  /** Working directory for the service (ExecStart cwd). */
  targetDir: string;
  /** systemd service name (without `.service` suffix). */
  serviceName: string;
  /** Command that systemd ExecStart= should invoke. Defaults to a no-op placeholder. */
  execStart?: string;
  /** When true the host is an IPv6 address — forces ssh to use `-6`. */
  ipv6Only?: boolean;
}

/** Result returned after remote setup completes. */
export interface RemoteSetupResult {
  /** Whether a systemd unit was installed. */
  unitInstalled: boolean;
  /** Whether the service was restarted. */
  serviceRestarted: boolean;
}

/* ------------------------------------------------------------------ */
/*  Template rendering                                                */
/* ------------------------------------------------------------------ */

/** Read the bundled systemd unit template and substitute placeholders. */
function renderUnit(vars: Record<string, string>): string {
  const templatePath = path.resolve(__dirname, "..", "..", "templates", "systemd.service");

  let content: string;
  if (fs.existsSync(templatePath)) {
    content = fs.readFileSync(templatePath, "utf-8");
  } else {
    // Fallback minimal template (when running from ncc bundle where template may not be adjacent)
    content = [
      "[Unit]",
      "Description={{SERVICE_NAME}}",
      "After=network.target",
      "",
      "[Service]",
      "Type=simple",
      "User={{USER}}",
      "WorkingDirectory={{WORKING_DIR}}",
      "ExecStart={{EXEC_START}}",
      "Restart=on-failure",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
    ].join("\n");
  }

  for (const [key, value] of Object.entries(vars)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), () => value);
  }
  return content;
}

function resolveExecStart(serviceName: string, execStart?: string): string {
  return execStart ?? `/usr/bin/env bash -c 'echo "${serviceName} started"'`;
}

/* ------------------------------------------------------------------ */
/*  Public helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Ensure the target directory exists on the remote host.
 *
 * Creates a temporary SSH key file, runs `sudo mkdir -p`, and cleans up
 * the key automatically.
 */
export async function ensureTargetDir(
  opts: EnsureTargetDirOptions,
): Promise<void> {
  const { host, user, privateKey, targetDir, ipv6Only = false } = opts;

  core.info(`Creating target directory ${targetDir} on ${host}…`);
  await withKeyFile(privateKey, (keyPath) =>
    sshExec(keyPath, user, host, `sudo mkdir -p ${shellQuote(targetDir)}`, ipv6Only),
  );
}

/**
 * Render, upload, and activate a systemd service unit on the remote host.
 *
 * Steps:
 *   1. Render the unit template with the provided variables.
 *   2. Upload via heredoc over SSH (`sudo tee`).
 *   3. `systemctl daemon-reload`.
 *   4. `systemctl enable` + `systemctl restart`.
 *
 * Manages its own temporary SSH key file internally.
 *
 * @returns An object indicating whether the unit was installed and the
 *          service restarted.
 */
export async function installSystemdUnit(
  opts: InstallSystemdUnitOptions,
): Promise<Pick<RemoteSetupResult, "unitInstalled" | "serviceRestarted">> {
  const { host, user, privateKey, targetDir, serviceName, execStart, ipv6Only = false } = opts;

  const result = { unitInstalled: false, serviceRestarted: false };

  core.info(`Installing systemd unit for "${serviceName}"…`);

  const resolvedExecStart = resolveExecStart(serviceName, execStart);
  core.info(`Resolved systemd ExecStart: ${resolvedExecStart}`);

  const unitContent = renderUnit({
    SERVICE_NAME: serviceName,
    WORKING_DIR: targetDir,
    USER: user,
    EXEC_START: resolvedExecStart,
  });

  const unitPath = `/etc/systemd/system/${serviceName}.service`;

  await withKeyFile(privateKey, async (keyPath) => {
    // Upload the unit file via heredoc (avoids scp dependency on remote)
    await sshExec(
      keyPath,
      user,
      host,
      `sudo tee ${shellQuote(unitPath)} > /dev/null << 'UNIT_EOF'\n${unitContent}\nUNIT_EOF`,
      ipv6Only,
    );
    result.unitInstalled = true;
    core.info(`Unit file written to ${unitPath}.`);

    // Reload systemd daemon
    core.info("Running systemctl daemon-reload…");
    await sshExec(keyPath, user, host, "sudo systemctl daemon-reload", ipv6Only);

    // Enable and restart the service
    core.info(`Enabling and restarting ${serviceName}…`);
    await sshExec(
      keyPath,
      user,
      host,
      `sudo systemctl enable ${shellQuote(serviceName)} && sudo systemctl restart ${shellQuote(serviceName)}`,
      ipv6Only,
    );
    result.serviceRestarted = true;
    core.info(`Service "${serviceName}" restarted successfully.`);
  });

  return result;
}

/* ------------------------------------------------------------------ */
/*  Public API (backward-compatible wrapper)                          */
/* ------------------------------------------------------------------ */

/**
 * Prepare the remote host for the deployed application.
 *
 * Steps:
 *   1. Create (or ensure) the target directory.
 *   2. If `serviceName` is provided:
 *      a. Render the systemd unit template.
 *      b. Upload the unit file via heredoc over SSH.
 *      c. Run `systemctl daemon-reload`.
 *      d. Restart the service.
 *
 * This is a convenience wrapper around {@link ensureTargetDir} and
 * {@link installSystemdUnit}.
 */
export async function remoteSetup(
  opts: RemoteSetupOptions,
): Promise<RemoteSetupResult> {
  const { host, user, privateKey, targetDir, serviceName, execStart, ipv6Only = false } = opts;

  const result: RemoteSetupResult = {
    unitInstalled: false,
    serviceRestarted: false,
  };

  // 1. Ensure target directory exists
  await ensureTargetDir({ host, user, privateKey, targetDir, ipv6Only });

  // 2. Systemd unit setup (only when service_name is provided)
  if (!serviceName) {
    core.info("No service_name provided — skipping systemd unit setup.");
    return result;
  }

  const unitResult = await installSystemdUnit({
    host,
    user,
    privateKey,
    targetDir,
    serviceName,
    execStart,
    ipv6Only,
  });

  result.unitInstalled = unitResult.unitInstalled;
  result.serviceRestarted = unitResult.serviceRestarted;

  return result;
}
