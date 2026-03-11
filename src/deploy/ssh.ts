import * as exec from "@actions/exec";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/* ------------------------------------------------------------------ */
/*  SSH constants                                                     */
/* ------------------------------------------------------------------ */

/** Common SSH options used for both ssh and rsync. */
export const SSH_OPTIONS: readonly string[] = [
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "ConnectTimeout=30",
];

/* ------------------------------------------------------------------ */
/*  Key-file management                                               */
/* ------------------------------------------------------------------ */

/**
 * Write the private key to a temporary file with mode 0600.
 * Returns the path — caller MUST clean up via `cleanupKeyFile`.
 */
export function writeKeyFile(privateKey: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hda-key-"));
  const keyPath = path.join(dir, "id");
  const content = privateKey.endsWith("\n") ? privateKey : privateKey + "\n";
  fs.writeFileSync(keyPath, content, { mode: 0o600 });
  return keyPath;
}

/**
 * Remove the temporary key file and its parent directory.
 * Throws on failure — callers decide whether to swallow or surface errors.
 */
export function cleanupKeyFile(keyPath: string): void {
  fs.unlinkSync(keyPath);
  fs.rmdirSync(path.dirname(keyPath));
}

/**
 * Manage a temporary SSH key file around an async callback.
 * Creates the file before `fn`, removes it afterwards (even on error).
 */
export async function withKeyFile<T>(
  privateKey: string,
  fn: (keyPath: string) => Promise<T>,
): Promise<T> {
  const keyPath = writeKeyFile(privateKey);
  try {
    return await fn(keyPath);
  } finally {
    try {
      cleanupKeyFile(keyPath);
    } catch {
      /* best-effort */
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Host formatting                                                   */
/* ------------------------------------------------------------------ */

/**
 * Format a host string for SSH — brackets raw IPv6 addresses.
 */
export function formatSshHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/* ------------------------------------------------------------------ */
/*  Remote command execution                                          */
/* ------------------------------------------------------------------ */

/**
 * Run a command on the remote host over SSH.
 *
 * When `ipv6Only` is true, `-6` is passed to force IPv6. The host is
 * always bracketed if it contains a colon (raw IPv6 address).
 *
 * @returns The combined stdout as a string.
 */
export async function sshExec(
  keyPath: string,
  user: string,
  host: string,
  remoteCmd: string,
  ipv6Only = false,
): Promise<string> {
  const sshArgs = [...SSH_OPTIONS, "-i", keyPath];

  if (ipv6Only) {
    sshArgs.push("-6");
  }

  const sshHost = formatSshHost(host);

  sshArgs.push(`${user}@${sshHost}`, remoteCmd);

  let stdout = "";
  try {
    await exec.exec("ssh", sshArgs, {
      silent: false,
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        },
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ipv6Only) {
      throw new Error(
        `SSH failed (IPv6-only mode): ${msg}. ` +
          "The runner may lack IPv6 connectivity. " +
          "Use a self-hosted runner with IPv6 or set ipv6_only: false to provision a dual-stack server.",
      );
    }
    throw err;
  }
  return stdout.trim();
}

/* ------------------------------------------------------------------ */
/*  Shell quoting                                                     */
/* ------------------------------------------------------------------ */

/**
 * Wrap a value in single-quotes for safe interpolation into a remote
 * shell command.  Any embedded single-quotes are escaped with the
 * standard `'\''` trick.
 */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
