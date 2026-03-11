import * as core from "@actions/core";
import { withKeyFile, sshExec, shellQuote } from "./ssh.js";

/* ------------------------------------------------------------------ */
/*  Option / result interfaces                                        */
/* ------------------------------------------------------------------ */

/** Options for configuring UFW on a remote host. */
export interface FirewallOptions {
  /** Server IP or hostname. */
  host: string;
  /** SSH user (e.g. "root"). */
  user: string;
  /** SSH private key content. */
  privateKey: string;
  /** When true the host is an IPv6 address — forces ssh to use `-6`. */
  ipv6Only?: boolean;
  /** Additional ports to allow (defaults to TCP when protocol is omitted). */
  extraPorts?: ReadonlyArray<number | string>;
}

/** Result returned after firewall configuration completes. */
export interface FirewallResult {
  /** Whether UFW was enabled successfully. */
  firewallEnabled: boolean;
  /** Number of allow-rules applied successfully. */
  rulesApplied: number;
}

/* ------------------------------------------------------------------ */
/*  Error-prefix constants                                            */
/* ------------------------------------------------------------------ */

export const FIREWALL_ERRORS = {
  VALIDATE: "FIREWALL_VALIDATE",
  INSTALL: "FIREWALL_INSTALL",
  DEFAULTS: "FIREWALL_DEFAULTS",
  SSH_RULE: "FIREWALL_SSH_RULE",
  WEB_RULES: "FIREWALL_WEB_RULES",
  EXTRA_RULES: "FIREWALL_EXTRA_RULES",
  ENABLE: "FIREWALL_ENABLE",
} as const;

/* ------------------------------------------------------------------ */
/*  Validation helpers                                                */
/* ------------------------------------------------------------------ */

const PORT_SPEC_RE = /^(\d{1,5})(?:\/(tcp|udp))?$/i;

function normalizeExtraPort(port: number | string): string {
  const raw = String(port).trim();
  const match = PORT_SPEC_RE.exec(raw);

  if (!match) {
    throw new Error(
      `${FIREWALL_ERRORS.VALIDATE}: invalid extra port: ${JSON.stringify(port)}`,
    );
  }

  const portNumber = Number(match[1]);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new Error(
      `${FIREWALL_ERRORS.VALIDATE}: port out of range: ${JSON.stringify(port)}`,
    );
  }

  const protocol = (match[2] ?? "tcp").toLowerCase();
  return `${portNumber}/${protocol}`;
}

async function withLogGroup<T>(title: string, fn: () => Promise<T>): Promise<T> {
  core.startGroup(title);
  try {
    return await fn();
  } finally {
    core.endGroup();
  }
}

async function runFirewallCommand(
  keyPath: string,
  user: string,
  host: string,
  command: string,
  errorPrefix: string,
  ipv6Only: boolean,
): Promise<string> {
  try {
    return await sshExec(keyPath, user, host, command, ipv6Only);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${errorPrefix}: ${msg}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Install and configure UFW on a remote host.
 *
 * Stages:
 *   1. Validate/install `ufw` when missing.
 *   2. Set default policies.
 *   3. Allow SSH, required web ports, and optional extra ports.
 *   4. Enable UFW non-interactively.
 *
 * All remote-stage failures are wrapped with `FIREWALL_*` prefixes for
 * easier CI log inspection.
 */
export async function configureFirewall(
  options: FirewallOptions,
): Promise<FirewallResult> {
  const {
    host,
    user,
    privateKey,
    ipv6Only = false,
    extraPorts = [],
  } = options;

  const normalizedExtraPorts = extraPorts.map((port) => normalizeExtraPort(port));

  const result: FirewallResult = {
    firewallEnabled: false,
    rulesApplied: 0,
  };

  await withLogGroup("Configure firewall", async () => {
    core.info(`Preparing UFW on ${host}${ipv6Only ? " (IPv6-only mode)" : ""}…`);

    await withKeyFile(privateKey, async (keyPath) => {
      await withLogGroup("Validate/install UFW", async () => {
        core.info(`[${FIREWALL_ERRORS.INSTALL}] Ensuring UFW is installed…`);
        await runFirewallCommand(
          keyPath,
          user,
          host,
          "command -v ufw >/dev/null 2>&1 || (sudo apt-get update -qq && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw) && command -v ufw >/dev/null 2>&1",
          FIREWALL_ERRORS.INSTALL,
          ipv6Only,
        );
        core.info(`[${FIREWALL_ERRORS.INSTALL}] UFW is available.`);
      });

      await withLogGroup("Set firewall defaults", async () => {
        core.info(`[${FIREWALL_ERRORS.DEFAULTS}] Setting deny-incoming / allow-outgoing defaults…`);
        await runFirewallCommand(
          keyPath,
          user,
          host,
          "sudo ufw default deny incoming && sudo ufw default allow outgoing",
          FIREWALL_ERRORS.DEFAULTS,
          ipv6Only,
        );
        core.info(`[${FIREWALL_ERRORS.DEFAULTS}] Default policies configured.`);
      });

      await withLogGroup("Allow SSH access", async () => {
        core.info(`[${FIREWALL_ERRORS.SSH_RULE}] Allowing SSH on 22/tcp…`);
        await runFirewallCommand(
          keyPath,
          user,
          host,
          "sudo ufw allow 22/tcp",
          FIREWALL_ERRORS.SSH_RULE,
          ipv6Only,
        );
        result.rulesApplied += 1;
        core.info(`[${FIREWALL_ERRORS.SSH_RULE}] SSH rule configured.`);
      });

      await withLogGroup("Allow web ports", async () => {
        core.info(`[${FIREWALL_ERRORS.WEB_RULES}] Allowing 80/tcp…`);
        await runFirewallCommand(
          keyPath,
          user,
          host,
          "sudo ufw allow 80/tcp",
          FIREWALL_ERRORS.WEB_RULES,
          ipv6Only,
        );
        result.rulesApplied += 1;

        core.info(`[${FIREWALL_ERRORS.WEB_RULES}] Allowing 443/tcp…`);
        await runFirewallCommand(
          keyPath,
          user,
          host,
          "sudo ufw allow 443/tcp",
          FIREWALL_ERRORS.WEB_RULES,
          ipv6Only,
        );
        result.rulesApplied += 1;

        core.info(`[${FIREWALL_ERRORS.WEB_RULES}] Required web rules configured.`);
      });

      await withLogGroup("Allow extra ports", async () => {
        if (normalizedExtraPorts.length === 0) {
          core.info(`[${FIREWALL_ERRORS.EXTRA_RULES}] No extra ports requested.`);
          return;
        }

        for (const port of normalizedExtraPorts) {
          core.info(`[${FIREWALL_ERRORS.EXTRA_RULES}] Allowing ${port}…`);
          await runFirewallCommand(
            keyPath,
            user,
            host,
            `sudo ufw allow ${shellQuote(port)}`,
            FIREWALL_ERRORS.EXTRA_RULES,
            ipv6Only,
          );
          result.rulesApplied += 1;
        }

        core.info(`[${FIREWALL_ERRORS.EXTRA_RULES}] Extra port rules configured.`);
      });

      await withLogGroup("Enable firewall", async () => {
        core.info(`[${FIREWALL_ERRORS.ENABLE}] Enabling UFW…`);
        await runFirewallCommand(
          keyPath,
          user,
          host,
          "sudo ufw --force enable",
          FIREWALL_ERRORS.ENABLE,
          ipv6Only,
        );
        result.firewallEnabled = true;
        core.info(`[${FIREWALL_ERRORS.ENABLE}] UFW enabled successfully.`);
      });
    });
  });

  return result;
}
