import * as core from "@actions/core";
import type { OsStrategy } from "./osStrategy.js";
import { createDebianStrategy } from "./strategies/debian.js";
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
  /** OS-specific command strategy. Defaults to Debian helpers. */
  strategy?: OsStrategy;
  /** When true the host is an IPv6 address — forces ssh to use `-6`. */
  ipv6Only?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

/** Default packages provisioned on every server. */
export const DEFAULT_PACKAGES: readonly string[] = ["podman", "haproxy"];

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
 * selected strategy package naming policy. Throws with a
 * `PACKAGE_INSTALL_VALIDATE:` prefix on failure.
 */
function validatePackageNames(
  packages: readonly string[],
  strategy: OsStrategy,
): void {
  if (packages.length === 0) {
    throw new Error(`${STAGE_VALIDATE}: package list must not be empty`);
  }
  for (const name of packages) {
    if (!strategy.packages.packageNamePattern.test(name)) {
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
 *   2. Install the requested packages via the selected OS strategy.
 *   3. Verify each package is installed via the selected OS strategy.
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
    strategy = createDebianStrategy(),
    ipv6Only = false,
  } = opts;

  validatePackageNames(packages, strategy);

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
    const installCommand = strategy.packages.install(packages);
    core.info(
      `[${STAGE_INSTALL}] Installing packages: ${pkgList}…`,
    );
    try {
      await sshExec(
        keyPath,
        user,
        host,
        installCommand,
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
        await sshExec(
          keyPath,
          user,
          host,
          strategy.packages.verify(pkg),
          ipv6Only,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${STAGE_VERIFY}: ${msg}`);
    }
    core.info(`[${STAGE_VERIFY}] All packages verified.`);
  });
}
