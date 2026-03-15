import * as core from "@actions/core";
import { shellQuote } from "../ssh.js";

import type { OsStrategy } from "../osStrategy.js";

const FEDORA_LOG_PREFIX = "[FEDORA]";
const FEDORA_PACKAGE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._+-]+$/;

function logInfo(message: string): void {
  core.info(`${FEDORA_LOG_PREFIX} ${message}`);
}

function debugCommand(label: string, command: string): string {
  core.debug(`${FEDORA_LOG_PREFIX} ${label}: ${command}`);
  return command;
}

/** Create the Fedora-specific deployment strategy factory. */
export function createFedoraStrategy(): OsStrategy {
  logInfo("Creating Fedora OS strategy.");

  return Object.freeze({
    family: "fedora",
    packages: Object.freeze({
      packageNamePattern: FEDORA_PACKAGE_NAME_PATTERN,
      install(packages: readonly string[]): string {
        const pkgList = packages.map((pkg) => shellQuote(pkg)).join(" ");
        return debugCommand(
          "Generated package install command",
          `sudo dnf install -y --setopt=install_weak_deps=False ${pkgList}`,
        );
      },
      verify(packageName: string): string {
        return debugCommand(
          "Generated package verify command",
          `rpm -q ${shellQuote(packageName)}`,
        );
      },
    }),
    firewall: Object.freeze({
      install(): string {
        return debugCommand(
          "Generated firewall install command",
          "command -v firewall-cmd >/dev/null 2>&1 || (sudo dnf install -y --setopt=install_weak_deps=False firewalld && sudo systemctl enable --now firewalld) && command -v firewall-cmd >/dev/null 2>&1",
        );
      },
      defaults(): string {
        return debugCommand(
          "Generated firewall defaults command",
          "sudo systemctl is-active firewalld",
        );
      },
      allow(rule: string): string {
        return debugCommand(
          "Generated firewall allow command",
          `sudo firewall-cmd --permanent --zone=drop --add-port=${rule}`,
        );
      },
      enable(): string {
        return debugCommand(
          "Generated firewall enable command",
          "sudo firewall-cmd --set-default-zone=drop && sudo firewall-cmd --reload",
        );
      },
    }),
  });
}
