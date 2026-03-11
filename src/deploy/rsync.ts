import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { SSH_OPTIONS, writeKeyFile, cleanupKeyFile, formatSshHost } from "./ssh.js";

/** Parameters accepted by {@link rsyncDeploy}. */
export interface RsyncOptions {
  /** Server IP or hostname to connect to. */
  host: string;
  /** SSH user on the remote server. */
  user: string;
  /** Local directory to deploy (trailing slash is normalised automatically). */
  sourceDir: string;
  /** Absolute path on the remote server where files are placed. */
  targetDir: string;
  /** SSH private key content (PEM). Written to a temp file for the transfer. */
  sshKey: string;
  /** When true the host is an IPv6 address — forces ssh/rsync to use `-6`. */
  ipv6Only?: boolean;
  /** Custom SSH port (defaults to 22). */
  port?: number;
}

/* ------------------------------------------------------------------ */
/*  Input validation                                                  */
/* ------------------------------------------------------------------ */

/** Allowed characters in an absolute target directory path. */
const SAFE_PATH_RE = /^\/[a-zA-Z0-9._/\-]+$/;

/** Allowed characters in an SSH user name. */
const SAFE_USER_RE = /^[a-zA-Z_][a-zA-Z0-9_.\-]*$/;

/**
 * Deploy a local directory to a remote server using rsync over SSH.
 *
 * - Writes `sshKey` to a temporary file with mode 0600 and removes it
 *   after the transfer (even on failure).
 * - Uses `rsync -avz --delete` to mirror the source into the target.
 * - SSH is configured with `StrictHostKeyChecking=accept-new` so the
 *   first connection auto-accepts the host key without prompting.
 */
export async function rsyncDeploy(opts: RsyncOptions): Promise<void> {
  const {
    host,
    user,
    sourceDir,
    targetDir,
    sshKey,
    ipv6Only = false,
    port = 22,
  } = opts;

  // Validate inputs before writing any key material to disk.
  if (!SAFE_USER_RE.test(user)) {
    throw new Error(`rsync: invalid SSH user: ${JSON.stringify(user)}`);
  }
  if (!SAFE_PATH_RE.test(targetDir)) {
    throw new Error(
      `rsync: invalid target directory: ${JSON.stringify(targetDir)}`,
    );
  }

  // Normalise source path: ensure trailing slash so rsync copies *contents*.
  const normalisedSource = sourceDir.endsWith("/")
    ? sourceDir
    : `${sourceDir}/`;

  // Write private key to a temp file with strict permissions.
  const keyFile = writeKeyFile(sshKey);

  try {
    core.info("SSH private key written to temporary file.");

    // Build the SSH command used by rsync.
    const sshParts: string[] = [
      "ssh",
      ...SSH_OPTIONS,
      "-i",
      keyFile,
      "-p",
      String(port),
    ];

    if (ipv6Only) {
      sshParts.push("-6");
    }

    const sshCmd = sshParts.join(" ");

    // Format remote destination — bracket IPv6 addresses regardless of
    // ipv6Only flag (the server may be IPv6-only even when the flag is false,
    // e.g. reusing an existing server that has no IPv4).
    const remoteHost = formatSshHost(host);
    const destination = `${user}@${remoteHost}:${targetDir}`;

    // Assemble rsync arguments.
    const rsyncArgs: string[] = [
      "-avz",
      "--delete",
      "--protect-args",
      "-e",
      sshCmd,
      normalisedSource,
      destination,
    ];

    core.info(`rsync ${rsyncArgs.join(" ")}`);

    let exitCode: number;
    try {
      exitCode = await exec.exec("rsync", rsyncArgs, {
        silent: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ipv6Only) {
        throw new Error(
          `rsync failed (IPv6-only mode): ${msg}. ` +
            "The runner may lack IPv6 connectivity. " +
            "Use a self-hosted runner with IPv6 or set ipv6_only: false to provision a dual-stack server.",
        );
      }
      throw err;
    }

    if (exitCode !== 0) {
      const base = `rsync exited with code ${exitCode}`;
      if (ipv6Only) {
        throw new Error(
          `${base} (IPv6-only mode). ` +
            "The runner may lack IPv6 connectivity. " +
            "Use a self-hosted runner with IPv6 or set ipv6_only: false to provision a dual-stack server.",
        );
      }
      throw new Error(base);
    }

    core.info("rsync transfer completed successfully.");
  } finally {
    // Clean up the temporary key file unconditionally.
    try {
      cleanupKeyFile(keyFile);
      core.info("Temporary SSH key file removed.");
    } catch {
      core.warning("Failed to remove temporary SSH key file.");
    }
  }
}
