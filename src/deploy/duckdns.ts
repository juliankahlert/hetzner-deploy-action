import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureServiceUser, ensureTargetDir } from "./remoteSetup.js";
import { shellQuote, sshExec, withKeyFile } from "./ssh.js";

/* ------------------------------------------------------------------ */
/*  Option / result interfaces                                        */
/* ------------------------------------------------------------------ */

/** Options for deploying DuckDNS assets to a remote host. */
export interface DuckdnsDeployOptions {
  /** Server IP or hostname. */
  host: string;
  /** SSH user (e.g. "root"). */
  user: string;
  /** SSH private key content. */
  privateKey: string;
  /** DuckDNS API token. */
  token: string;
  /** DuckDNS domain to update. */
  domain: string;
  /** When true the host is an IPv6 address — forces ssh to use `-6`. */
  ipv6Only?: boolean;
}

/** Result returned after DuckDNS deployment completes. */
export interface DuckdnsDeployResult {
  /** Whether the domain was updated during the deployment flow. */
  domainUpdated: boolean;
  /** Whether the timer unit was installed during the deployment flow. */
  timerInstalled: boolean;
}

/* ------------------------------------------------------------------ */
/*  Error-prefix constants                                            */
/* ------------------------------------------------------------------ */

export const DUCKDNS_USER = "DUCKDNS_USER";
export const DUCKDNS_CONFIG = "DUCKDNS_CONFIG";
export const DUCKDNS_PERMS = "DUCKDNS_PERMS";
export const DUCKDNS_SCRIPT = "DUCKDNS_SCRIPT";
export const DUCKDNS_UNIT = "DUCKDNS_UNIT";
export const DUCKDNS_TIMER = "DUCKDNS_TIMER";
export const DUCKDNS_INITIAL = "DUCKDNS_INITIAL";

/* ------------------------------------------------------------------ */
/*  Template fallbacks                                                */
/* ------------------------------------------------------------------ */

const DUCKDNS_UPDATE_SCRIPT_FALLBACK = `#!/usr/bin/env python3
"""DuckDNS dynamic DNS updater."""

import sys
import urllib.parse
import urllib.request

CONFIG = "{{CONFIG_PATH}}"


def log(message: str) -> None:
    print(message, file=sys.stderr)


def strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def load_config(path: str) -> dict[str, str]:
    config: dict[str, str] = {}

    with open(path, encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            line = raw_line.strip()

            if not line or line.startswith("#"):
                continue

            if ":" not in line:
                raise ValueError(f"invalid config line {line_number}")

            key, value = line.split(":", 1)
            key = key.strip()
            value = strip_quotes(value.strip())

            if not key:
                raise ValueError(f"invalid config line {line_number}")

            config[key] = value

    return config


def update_duckdns(domain: str, token: str) -> str:
    query = urllib.parse.urlencode({"domains": domain, "token": token, "ip": ""})
    url = f"https://www.duckdns.org/update?{query}"

    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace").strip()


def main() -> int:
    try:
        config = load_config(CONFIG)
    except FileNotFoundError:
        log(f"duckdns update failed: config not found at {CONFIG}")
        return 1
    except OSError:
        log("duckdns update failed: unable to read config")
        return 1
    except ValueError as error:
        log(f"duckdns update failed: {error}")
        return 1

    domain = config.get("domain", "").strip()
    token = config.get("token", "").strip()

    if not domain or not token:
        log("duckdns update failed: config requires domain and token")
        return 1

    try:
        result = update_duckdns(domain, token)
    except Exception as error:  # noqa: BLE001
        log(f"duckdns update failed: {error.__class__.__name__}")
        return 1

    if result == "OK":
        log(f"duckdns update succeeded for domain {domain}")
        return 0

    if result == "KO":
        log(f"duckdns update failed for domain {domain}: KO")
        return 1

    log(f"duckdns update failed for domain {domain}: unexpected response {result!r}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
`;

const DUCKDNS_SERVICE_FALLBACK = `[Unit]
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=duckdns
ExecStart=/usr/bin/python3 /etc/duckdns/update.py
`;

const DUCKDNS_TIMER_FALLBACK = `[Timer]
OnBootSec=0
OnUnitActiveSec=5min
AccuracySec=1min
Persistent=true

[Install]
WantedBy=timers.target
`;

function templatePath(fileName: string): string {
  return path.resolve(__dirname, "..", "..", "templates", fileName);
}

function readTemplate(fileName: string, fallback: string, errorPrefix: string): string {
  const resolvedPath = templatePath(fileName);

  if (!fs.existsSync(resolvedPath)) {
    return fallback;
  }

  try {
    return fs.readFileSync(resolvedPath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${errorPrefix}: failed to read template ${fileName}: ${msg}`);
  }
}

function renderYamlScalar(value: string): string {
  return JSON.stringify(value);
}

/** Render flat YAML config content for `/etc/duckdns/config.yaml`. */
export function renderConfig(token: string, domain: string): string {
  return `token: ${renderYamlScalar(token)}\ndomain: ${renderYamlScalar(domain)}\n`;
}

/** Render the DuckDNS update script with a resolved config path. */
export function renderScript(configPath: string): string {
  return readTemplate("duckdns-update.py", DUCKDNS_UPDATE_SCRIPT_FALLBACK, DUCKDNS_SCRIPT).replaceAll(
    "{{CONFIG_PATH}}",
    configPath,
  );
}

/** Render the DuckDNS systemd service unit. */
export function renderServiceUnit(): string {
  return readTemplate("duckdns.service", DUCKDNS_SERVICE_FALLBACK, DUCKDNS_UNIT);
}

/** Render the DuckDNS systemd timer unit. */
export function renderTimerUnit(): string {
  return readTemplate("duckdns.timer", DUCKDNS_TIMER_FALLBACK, DUCKDNS_TIMER);
}

const DUCKDNS_LOG_PREFIX = "[DUCKDNS]";
const DUCKDNS_SERVICE_USER_NAME = "duckdns";
const DUCKDNS_DIR = "/etc/duckdns";
const DUCKDNS_CONFIG_PATH = "/etc/duckdns/config.yaml";
const DUCKDNS_SCRIPT_PATH = "/etc/duckdns/update.py";
const DUCKDNS_SERVICE_UNIT_PATH = "/etc/systemd/system/duckdns.service";
const DUCKDNS_TIMER_UNIT_PATH = "/etc/systemd/system/duckdns.timer";

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wrapDuckdnsError(
  prefix: string,
  message: string,
  error: unknown,
  includeCauseMessage = true,
): Error {
  const detail = includeCauseMessage ? `: ${safeErrorMessage(error)}` : "";
  const wrapped = new Error(`${prefix}: ${message}${detail}`);
  Object.assign(wrapped, { cause: error });
  return wrapped;
}

function heredocTeeCommand(remotePath: string, content: string, marker: string): string {
  const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;
  return `sudo tee ${shellQuote(remotePath)} > /dev/null << '${marker}'\n${normalizedContent}${marker}`;
}

/** Deploy DuckDNS configuration, updater script, and timer on the remote host. */
export async function deployDuckdns(
  opts: DuckdnsDeployOptions,
): Promise<DuckdnsDeployResult> {
  const { host, user, privateKey, token, domain, ipv6Only = false } = opts;
  const result: DuckdnsDeployResult = {
    domainUpdated: false,
    timerInstalled: false,
  };

  core.info(`${DUCKDNS_LOG_PREFIX} Starting DuckDNS deployment orchestration.`);

  core.info(`${DUCKDNS_LOG_PREFIX} Phase 1/6: ensuring service user.`);
  try {
    await ensureServiceUser({
      host,
      user,
      privateKey,
      serviceUser: DUCKDNS_SERVICE_USER_NAME,
      ipv6Only,
    });
  } catch (error: unknown) {
    throw wrapDuckdnsError(
      DUCKDNS_USER,
      `failed to ensure service user ${DUCKDNS_SERVICE_USER_NAME}`,
      error,
    );
  }
  core.info(`${DUCKDNS_LOG_PREFIX} Phase 1/6 complete.`);

  core.info(`${DUCKDNS_LOG_PREFIX} Phase 2/6: ensuring target directory and writing config.`);
  try {
    await ensureTargetDir({
      host,
      user,
      privateKey,
      targetDir: DUCKDNS_DIR,
      ipv6Only,
    });

    await withKeyFile(privateKey, (keyPath) =>
      sshExec(
        keyPath,
        user,
        host,
        heredocTeeCommand(DUCKDNS_CONFIG_PATH, renderConfig(token, domain), "DUCKDNS_CONFIG_EOF"),
        ipv6Only,
      ),
    );
  } catch (error: unknown) {
    throw wrapDuckdnsError(
      DUCKDNS_CONFIG,
      `failed to prepare ${DUCKDNS_CONFIG_PATH}`,
      error,
      false,
    );
  }
  core.info(`${DUCKDNS_LOG_PREFIX} Config written to ${DUCKDNS_CONFIG_PATH}.`);
  core.info(`${DUCKDNS_LOG_PREFIX} Phase 2/6 complete.`);

  core.info(`${DUCKDNS_LOG_PREFIX} Phase 3/6: hardening permissions.`);
  try {
    await withKeyFile(privateKey, (keyPath) =>
      sshExec(
        keyPath,
        user,
        host,
        [
          `sudo chown -R ${shellQuote(DUCKDNS_SERVICE_USER_NAME)}:${shellQuote(DUCKDNS_SERVICE_USER_NAME)} ${shellQuote(DUCKDNS_DIR)}`,
          `sudo chmod 0700 ${shellQuote(DUCKDNS_DIR)}`,
          `sudo chmod 0600 ${shellQuote(DUCKDNS_CONFIG_PATH)}`,
        ].join(" && "),
        ipv6Only,
      ),
    );
    core.info(`${DUCKDNS_LOG_PREFIX} Permission hardening complete.`);
  } catch (error: unknown) {
    core.warning(
      `${DUCKDNS_LOG_PREFIX} ${DUCKDNS_PERMS}: permission hardening failed; continuing: ${safeErrorMessage(error)}`,
    );
  }
  core.info(`${DUCKDNS_LOG_PREFIX} Phase 3/6 complete.`);

  core.info(`${DUCKDNS_LOG_PREFIX} Phase 4/6: uploading updater script.`);
  try {
    await withKeyFile(privateKey, async (keyPath) => {
      await sshExec(
        keyPath,
        user,
        host,
        heredocTeeCommand(
          DUCKDNS_SCRIPT_PATH,
          renderScript(DUCKDNS_CONFIG_PATH),
          "DUCKDNS_SCRIPT_EOF",
        ),
        ipv6Only,
      );

      await sshExec(
        keyPath,
        user,
        host,
        [
          `sudo chmod 0755 ${shellQuote(DUCKDNS_SCRIPT_PATH)}`,
          `sudo chown ${shellQuote(DUCKDNS_SERVICE_USER_NAME)}:${shellQuote(DUCKDNS_SERVICE_USER_NAME)} ${shellQuote(DUCKDNS_SCRIPT_PATH)}`,
        ].join(" && "),
        ipv6Only,
      );
    });
  } catch (error: unknown) {
    throw wrapDuckdnsError(
      DUCKDNS_SCRIPT,
      `failed to install updater script at ${DUCKDNS_SCRIPT_PATH}`,
      error,
    );
  }
  core.info(`${DUCKDNS_LOG_PREFIX} Updater script ready at ${DUCKDNS_SCRIPT_PATH}.`);
  core.info(`${DUCKDNS_LOG_PREFIX} Phase 4/6 complete.`);

  core.info(`${DUCKDNS_LOG_PREFIX} Phase 5/6: installing systemd service and timer units.`);
  await withKeyFile(privateKey, async (keyPath) => {
    try {
      await sshExec(
        keyPath,
        user,
        host,
        heredocTeeCommand(DUCKDNS_SERVICE_UNIT_PATH, renderServiceUnit(), "DUCKDNS_SERVICE_UNIT_EOF"),
        ipv6Only,
      );
    } catch (error: unknown) {
      throw wrapDuckdnsError(
        DUCKDNS_UNIT,
        `failed to install service unit at ${DUCKDNS_SERVICE_UNIT_PATH}`,
        error,
      );
    }

    try {
      await sshExec(
        keyPath,
        user,
        host,
        heredocTeeCommand(DUCKDNS_TIMER_UNIT_PATH, renderTimerUnit(), "DUCKDNS_TIMER_UNIT_EOF"),
        ipv6Only,
      );
    } catch (error: unknown) {
      throw wrapDuckdnsError(
        DUCKDNS_TIMER,
        `failed to install timer unit at ${DUCKDNS_TIMER_UNIT_PATH}`,
        error,
      );
    }

    try {
      await sshExec(keyPath, user, host, "sudo systemctl daemon-reload", ipv6Only);
    } catch (error: unknown) {
      throw wrapDuckdnsError(DUCKDNS_UNIT, "failed to reload systemd daemon", error);
    }

    try {
      await sshExec(keyPath, user, host, "sudo systemctl enable --now duckdns.timer", ipv6Only);
      result.timerInstalled = true;
    } catch (error: unknown) {
      throw wrapDuckdnsError(DUCKDNS_TIMER, "failed to enable duckdns.timer", error);
    }
  });
  core.info(`${DUCKDNS_LOG_PREFIX} Timer enabled and active.`);
  core.info(`${DUCKDNS_LOG_PREFIX} Phase 5/6 complete.`);

  core.info(`${DUCKDNS_LOG_PREFIX} Phase 6/6: running initial update.`);
  try {
    await withKeyFile(privateKey, (keyPath) =>
      sshExec(keyPath, user, host, "sudo systemctl start duckdns.service", ipv6Only),
    );
    result.domainUpdated = true;
    core.info(`${DUCKDNS_LOG_PREFIX} Initial DuckDNS update completed successfully.`);
  } catch (error: unknown) {
    result.domainUpdated = false;
    core.warning(
      `${DUCKDNS_LOG_PREFIX} ${DUCKDNS_INITIAL}: initial service run failed; continuing: ${safeErrorMessage(error)}`,
    );
  }
  core.info(`${DUCKDNS_LOG_PREFIX} Phase 6/6 complete.`);
  core.info(
    `${DUCKDNS_LOG_PREFIX} DuckDNS deployment complete. timerInstalled=${String(result.timerInstalled)} domainUpdated=${String(result.domainUpdated)}`,
  );

  return result;
}
