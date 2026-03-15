import * as core from "@actions/core";
import { shellQuote } from "../ssh.js";
import type { OsStrategy } from "../osStrategy.js";

const DEBIAN_LOG_PREFIX = "[DEBIAN]";

/**
 * Valid Debian package name: lowercase alphanumeric start, followed by
 * lowercase alphanumeric, dots, plus signs, or hyphens. Minimum 2 chars.
 * @see https://www.debian.org/doc/debian-policy/ch-controlfields.html#source
 */
const DEBIAN_PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9.+-]+$/;

function logInfo(message: string): void {
  core.info(`${DEBIAN_LOG_PREFIX} ${message}`);
}

function logDebug(message: string): void {
  core.debug(`${DEBIAN_LOG_PREFIX} ${message}`);
}

function debugCommand(label: string, command: string): string {
  logDebug(`${label}: ${command}`);
  return command;
}

/** Create the Debian package/firewall command strategy. */
export function createDebianStrategy(): OsStrategy {
  logInfo("Creating Debian OS strategy.");

  return Object.freeze({
    family: "debian",
    packages: Object.freeze({
      packageNamePattern: DEBIAN_PACKAGE_NAME_PATTERN,
      install(packages: readonly string[]): string {
        const pkgList = packages.map((pkg) => shellQuote(pkg)).join(" ");
        return debugCommand(
          "Generated package install command",
          `sudo apt-get update -qq && sudo apt-get install -y -qq ${pkgList}`,
        );
      },
      verify(packageName: string): string {
        return debugCommand(
          "Generated package verify command",
          `dpkg -s ${shellQuote(packageName)}`,
        );
      },
    }),
    firewall: Object.freeze({
      install(): string {
        return debugCommand(
          "Generated firewall install command",
          "command -v ufw >/dev/null 2>&1 || (sudo apt-get update -qq && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw) && command -v ufw >/dev/null 2>&1",
        );
      },
      defaults(): string {
        return debugCommand(
          "Generated firewall defaults command",
          "sudo ufw default deny incoming && sudo ufw default allow outgoing",
        );
      },
      allow(rule: string): string {
        return debugCommand(
          "Generated firewall allow command",
          `sudo ufw allow ${rule}`,
        );
      },
      enable(): string {
        return debugCommand(
          "Generated firewall enable command",
          "sudo ufw --force enable",
        );
      },
    }),
  });
}
