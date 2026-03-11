import * as core from "@actions/core";
import { withKeyFile, sshExec, shellQuote } from "./ssh.js";

/* ------------------------------------------------------------------ */
/*  Options                                                           */
/* ------------------------------------------------------------------ */

/** Options for the package installation stage. */
export interface PackageInstallOptions {
  /** Server IP or hostname. */
  host: string;
  /** SSH user (e.g. "root"). */
  user: string;
  /** SSH private key content. */
  privateKey: string;
  /** Packages to install. Defaults to {@link DEFAULT_PACKAGES}. */
  packages?: string[];
  /** When true the host is an IPv6 address — forces ssh to use `-6`. */
  ipv6Only?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

/** Default packages provisioned on every server. */
export const DEFAULT_PACKAGES: readonly string[] = ["podman", "haproxy"];

/**
 * Valid Debian package name: lowercase alphanumeric start, followed by
 * lowercase alphanumeric, dots, plus signs, or hyphens.  Minimum 2 chars.
 * @see https://www.debian.org/doc/debian-policy/ch-controlfields.html#source
 */
const VALID_PKG_RE = /^[a-z0-9][a-z0-9.+\-]+$/;

/* ------------------------------------------------------------------ */
/*  Stage / error prefixes                                            */
/* ------------------------------------------------------------------ */

const STAGE_CLOUD_INIT = "PACKAGE_INSTALL_CLOUD_INIT";
const STAGE_INSTALL = "PACKAGE_INSTALL_INSTALL";
const STAGE_VERIFY = "PACKAGE_INSTALL_VERIFY";
const STAGE_VALIDATE = "PACKAGE_INSTALL_VALIDATE";

/* ------------------------------------------------------------------ */
/*  Validation                                                        */
/* ------------------------------------------------------------------ */

/**
 * Validate that `packages` is non-empty and every entry conforms to the
 * Debian package naming policy.  Throws with a `PACKAGE_INSTALL_VALIDATE:`
 * prefix on failure.
 */
function validatePackageNames(packages: readonly string[]): void {
  if (packages.length === 0) {
    throw new Error(`${STAGE_VALIDATE}: package list must not be empty`);
  }
  for (const name of packages) {
    if (!VALID_PKG_RE.test(name)) {
      throw new Error(
        `${STAGE_VALIDATE}: invalid package name: ${JSON.stringify(name)}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Install required packages on the remote host.
 *
 * Stages:
 *   1. Wait for cloud-init to finish (so apt locks are released).
 *   2. `apt-get update && apt-get install` the requested packages.
 *   3. Verify each package is installed via `dpkg -s`.
 *
 * All errors are prefixed with their stage label (`PACKAGE_INSTALL_*`)
 * for easy identification in CI logs.
 */
export async function installPackages(
  opts: PackageInstallOptions,
): Promise<void> {
  const {
    host,
    user,
    privateKey,
    packages = DEFAULT_PACKAGES,
    ipv6Only = false,
  } = opts;

  validatePackageNames(packages);

  await withKeyFile(privateKey, async (keyPath) => {
    // Stage 1: Wait for cloud-init readiness
    core.info(`[${STAGE_CLOUD_INIT}] Waiting for cloud-init to complete…`);
    try {
      await sshExec(
        keyPath,
        user,
        host,
        "cloud-init status --wait",
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${STAGE_CLOUD_INIT}: ${msg}`);
    }
    core.info(`[${STAGE_CLOUD_INIT}] Cloud-init ready.`);

    // Stage 2: Install packages
    const pkgList = packages.map((p) => shellQuote(p)).join(" ");
    core.info(
      `[${STAGE_INSTALL}] Installing packages: ${pkgList}…`,
    );
    try {
      await sshExec(
        keyPath,
        user,
        host,
        `sudo apt-get update -qq && sudo apt-get install -y -qq ${pkgList}`,
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${STAGE_INSTALL}: ${msg}`);
    }
    core.info(`[${STAGE_INSTALL}] Packages installed successfully.`);

    // Stage 3: Verify installed packages
    core.info(`[${STAGE_VERIFY}] Verifying installed packages…`);
    try {
      for (const pkg of packages) {
        await sshExec(keyPath, user, host, `dpkg -s ${shellQuote(pkg)}`, ipv6Only);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${STAGE_VERIFY}: ${msg}`);
    }
    core.info(`[${STAGE_VERIFY}] All packages verified.`);
  });
}
