import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";
import { withKeyFile, sshExec, shellQuote } from "./ssh.js";

/* ------------------------------------------------------------------ */
/*  Option / result interfaces                                        */
/* ------------------------------------------------------------------ */

/** Options for deploying an HAProxy configuration to a remote host. */
export interface HaproxyDeployOptions {
  /** Server IP or hostname. */
  host: string;
  /** SSH user (e.g. "root"). */
  user: string;
  /** SSH private key content. */
  privateKey: string;
  /** Local path to the HAProxy configuration file. */
  cfgPath: string;
  /** When true the host is an IPv6 address — forces ssh to use `-6`. */
  ipv6Only?: boolean;
}

/** Options for deploying an HAProxy fragment to a remote host. */
export interface HaproxyFragmentOptions {
  /** Server IP or hostname. */
  host: string;
  /** SSH user (e.g. "root"). */
  user: string;
  /** SSH private key content. */
  privateKey: string;
  /** Local path to the HAProxy fragment file. */
  fragmentPath: string;
  /** Fragment name written under `/etc/haproxy/conf.d/<name>.cfg`. */
  fragmentName: string;
  /** When true the host is an IPv6 address — forces ssh to use `-6`. */
  ipv6Only?: boolean;
}

/** Options for deploying the bundled HAProxy base config to a remote host. */
export interface HaproxyBaseOptions {
  /** Server IP or hostname. */
  host: string;
  /** SSH user (e.g. "root"). */
  user: string;
  /** SSH private key content. */
  privateKey: string;
  /** When true the host is an IPv6 address — forces ssh to use `-6`. */
  ipv6Only?: boolean;
}

/** Options for ensuring the bundled HAProxy fragment service exists remotely. */
export interface EnsureHaproxyFragServiceOptions {
  /** Server IP or hostname. */
  host: string;
  /** SSH user (e.g. "root"). */
  user: string;
  /** SSH private key content. */
  privateKey: string;
  /** When true the host is an IPv6 address — forces ssh to use `-6`. */
  ipv6Only?: boolean;
}

/** Options for deploying the bundled HAProxy certbot fragment to a remote host. */
export interface HaproxyCertbotFragmentOptions {
  /** Server IP or hostname. */
  host: string;
  /** SSH user (e.g. "root"). */
  user: string;
  /** SSH private key content. */
  privateKey: string;
  /** Local certbot HTTP-01 listener port rendered into the fragment. */
  certbotPort: string;
  /** When true the host is an IPv6 address — forces ssh to use `-6`. */
  ipv6Only?: boolean;
}

/** Result returned after an HAProxy configuration deployment. */
export interface HaproxyDeployResult {
  /** Whether the configuration file was uploaded to the remote host. */
  configUploaded: boolean;
  /** Whether the HAProxy service was reloaded successfully. */
  serviceReloaded: boolean;
}

/* ------------------------------------------------------------------ */
/*  Error-prefix constants                                            */
/* ------------------------------------------------------------------ */

const ERR_UPLOAD = "HAPROXY_UPLOAD";
const ERR_VALIDATE = "HAPROXY_VALIDATE";
const ERR_RELOAD = "HAPROXY_RELOAD";
const ERR_BACKUP = "HAPROXY_BACKUP";
const ERR_RESTORE = "HAPROXY_RESTORE";
const ERR_HASH = "HAPROXY_HASH";
const ERR_SERVICE_INSTALL = "HAPROXY_SERVICE_INSTALL";
const ERR_CERTBOT_READ = "HAPROXY_CERTBOT_READ";
const ERR_CERTBOT_DEPLOY = "HAPROXY_CERTBOT_DEPLOY";
const HAPROXY_START_OR_RELOAD_CMD =
  "sudo systemctl is-active --quiet haproxy-frag && sudo systemctl reload haproxy-frag || sudo systemctl start haproxy-frag";
const HAPROXY_BASE_FALLBACK = `global
  daemon
  log stdout format raw local0
  maxconn 4096

defaults
  log global
  mode http
  option httplog
  timeout http-request 10s
  timeout connect 5s
  timeout client 30s
  timeout server 30s
`;
const HAPROXY_FRAG_SERVICE_FALLBACK = `[Unit]
Description=HAProxy fragment orchestration service
After=network.target
ConditionDirectoryNotEmpty=/etc/haproxy/conf.d

[Service]
Type=notify
ExecStartPre=/usr/sbin/haproxy -c -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/conf.d/
ExecStart=/usr/sbin/haproxy -Ws -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/conf.d/ -p /run/haproxy-frag.pid
ExecReload=/usr/sbin/haproxy -c -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/conf.d/
ExecReload=/bin/kill -USR2 $MAINPID
KillMode=mixed
Restart=on-failure

[Install]
WantedBy=multi-user.target
`;
const HAPROXY_CERTBOT_FRAGMENT_NAME = "certbot";
const HAPROXY_CERTBOT_FALLBACK = `frontend ft_http
  bind *:80
  acl acme_challenge path_beg /.well-known/acme-challenge/
  use_backend bk_certbot if acme_challenge

backend bk_certbot
  server certbot 127.0.0.1:\${CERTBOT_PORT}
`;

function readBundledHaproxyBase(): string {
  const templatePath = path.resolve(
    __dirname,
    "..",
    "..",
    "templates",
    "haproxy-base.cfg",
  );

  if (!fs.existsSync(templatePath)) {
    return HAPROXY_BASE_FALLBACK;
  }

  try {
    return fs.readFileSync(templatePath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${ERR_UPLOAD}: failed to read bundled HAProxy base config: ${msg}`);
  }
}

function readBundledHaproxyFragService(): string {
  const templatePath = path.resolve(
    __dirname,
    "..",
    "..",
    "templates",
    "haproxy-frag.service",
  );

  if (!fs.existsSync(templatePath)) {
    return HAPROXY_FRAG_SERVICE_FALLBACK;
  }

  try {
    return fs.readFileSync(templatePath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${ERR_SERVICE_INSTALL}: failed to read bundled HAProxy frag service: ${msg}`,
    );
  }
}

function readBundledHaproxyCertbotFragment(): string {
  const templatePath = path.resolve(
    __dirname,
    "..",
    "..",
    "templates",
    "haproxy-certbot.cfg",
  );

  if (!fs.existsSync(templatePath)) {
    core.info(
      `[${ERR_CERTBOT_READ}] Bundled HAProxy certbot fragment template not found at ${templatePath}; using inline fallback.`,
    );
    return HAPROXY_CERTBOT_FALLBACK;
  }

  try {
    return fs.readFileSync(templatePath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${ERR_CERTBOT_READ}: failed to read bundled HAProxy certbot fragment: ${msg}`,
    );
  }
}

export function renderHaproxyCertbotFragment(certbotPort: string): string {
  core.info(`[${ERR_CERTBOT_DEPLOY}] Rendering bundled HAProxy certbot fragment…`);
  core.debug(
    `[${ERR_CERTBOT_DEPLOY}] Substituting certbot fragment port with value: ${certbotPort}`,
  );

  if (!certbotPort) {
    throw new Error(
      `${ERR_CERTBOT_DEPLOY}: certbotPort is required to render the HAProxy certbot fragment`,
    );
  }

  const rendered = readBundledHaproxyCertbotFragment().replaceAll(
    "${CERTBOT_PORT}",
    certbotPort,
  );

  core.info(`[${ERR_CERTBOT_DEPLOY}] HAProxy certbot fragment render complete.`);
  return rendered;
}

async function backupConfD(
  keyPath: string,
  user: string,
  host: string,
  ipv6Only: boolean,
): Promise<void> {
  core.info(`[${ERR_BACKUP}] Creating conf.d snapshot before fragment upload...`);
  try {
    await sshExec(
      keyPath,
      user,
      host,
      "sudo rm -rf /etc/haproxy/conf.d.bak && sudo cp -a /etc/haproxy/conf.d /etc/haproxy/conf.d.bak",
      ipv6Only,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${ERR_BACKUP}: failed to snapshot conf.d: ${msg}`);
  }
  core.info(`[${ERR_BACKUP}] conf.d snapshot created at /etc/haproxy/conf.d.bak.`);
}

async function restoreConfD(
  keyPath: string,
  user: string,
  host: string,
  ipv6Only: boolean,
): Promise<void> {
  core.info(`[${ERR_RESTORE}] Restoring conf.d from backup after validation failure...`);
  try {
    await sshExec(
      keyPath,
      user,
      host,
      "sudo rm -rf /etc/haproxy/conf.d && sudo mv /etc/haproxy/conf.d.bak /etc/haproxy/conf.d",
      ipv6Only,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${ERR_RESTORE}: failed to restore conf.d from backup: ${msg}`);
  }
  core.info(`[${ERR_RESTORE}] conf.d restored from backup successfully.`);
}

async function cleanupConfDBackup(
  keyPath: string,
  user: string,
  host: string,
  ipv6Only: boolean,
): Promise<void> {
  core.info(`[${ERR_BACKUP}] Cleaning up conf.d backup after successful validation...`);
  try {
    await sshExec(
      keyPath,
      user,
      host,
      "sudo rm -rf /etc/haproxy/conf.d.bak",
      ipv6Only,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`[${ERR_BACKUP}] Failed to clean up conf.d backup (non-fatal): ${msg}`);
    return;
  }
  core.info(`[${ERR_BACKUP}] conf.d backup cleaned up.`);
}

async function logConfDHashes(
  keyPath: string,
  user: string,
  host: string,
  phase: "pre-upload" | "post-upload" | "post-restore",
  ipv6Only: boolean,
): Promise<void> {
  core.info(`[${ERR_HASH}] Phase: ${phase}`);
  try {
    const output = await sshExec(
      keyPath,
      user,
      host,
      "sudo find /etc/haproxy/conf.d -name '*.cfg' -exec sha256sum {} +",
      ipv6Only,
    );
    for (const line of output.split("\n")) {
      if (line.trim()) {
        core.info(`[${ERR_HASH}]   ${line.trim()}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(
      `[${ERR_HASH}] Failed to compute conf.d hashes for phase ${phase} (non-fatal): ${msg}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Deploy an HAProxy configuration to a remote host.
 *
 * Steps:
 *   1. Read the local HAProxy configuration file.
 *   2. Upload it to `/etc/haproxy/haproxy.cfg` on the remote host.
 *   3. Validate the uploaded configuration with `haproxy -c`.
 *   4. Reload the HAProxy service.
 *
 * All remote-stage errors are prefixed with their stage label for easy
 * identification in CI logs.
 */
export async function deployHaproxy(
  opts: HaproxyDeployOptions,
): Promise<HaproxyDeployResult> {
  const { host, user, privateKey, cfgPath, ipv6Only = false } = opts;

  const result: HaproxyDeployResult = {
    configUploaded: false,
    serviceReloaded: false,
  };

  const remotePath = "/etc/haproxy/haproxy.cfg";

  core.info(`[${ERR_UPLOAD}] Reading HAProxy configuration from ${cfgPath}…`);

  let configContent: string;
  try {
    configContent = fs.readFileSync(cfgPath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${ERR_UPLOAD}: failed to read local config: ${msg}`);
  }

  await withKeyFile(privateKey, async (keyPath) => {
    core.info(`[${ERR_UPLOAD}] Uploading HAProxy configuration to ${remotePath}…`);
    try {
      await sshExec(
        keyPath,
        user,
        host,
        `sudo mkdir -p ${shellQuote("/etc/haproxy")} && sudo tee ${shellQuote(remotePath)} > /dev/null << 'HAPROXY_CFG_EOF'\n${configContent}\nHAPROXY_CFG_EOF`,
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${ERR_UPLOAD}: ${msg}`);
    }
    result.configUploaded = true;
    core.info(`[${ERR_UPLOAD}] HAProxy configuration written to ${remotePath}.`);

    core.info(`[${ERR_VALIDATE}] Validating HAProxy configuration…`);
    try {
      await sshExec(
        keyPath,
        user,
        host,
        `sudo haproxy -c -f ${shellQuote(remotePath)}`,
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${ERR_VALIDATE}: ${msg}`);
    }
    core.info(`[${ERR_VALIDATE}] HAProxy configuration validation succeeded.`);

    core.info(`[${ERR_RELOAD}] Reloading active haproxy-frag service or starting it if inactive…`);
    try {
      await sshExec(
        keyPath,
        user,
        host,
        HAPROXY_START_OR_RELOAD_CMD,
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${ERR_RELOAD}: ${msg}`);
    }
    result.serviceReloaded = true;
    core.info(`[${ERR_RELOAD}] haproxy-frag service reloaded or started successfully.`);
  });

  return result;
}

/**
 * Deploy the bundled HAProxy base configuration to a remote host.
 *
 * This is intended for fragment-only workflows where the action manages the
 * root `haproxy.cfg` and separate fragment deployments populate `conf.d`.
 */
export async function deployHaproxyBase(
  opts: HaproxyBaseOptions,
): Promise<HaproxyDeployResult> {
  const { host, user, privateKey, ipv6Only = false } = opts;

  const result: HaproxyDeployResult = {
    configUploaded: false,
    serviceReloaded: false,
  };

  const remotePath = "/etc/haproxy/haproxy.cfg";
  const configContent = readBundledHaproxyBase();

  core.info(
    `[${ERR_UPLOAD}] Deploying bundled HAProxy base config to ${remotePath} for fragment-only mode.`,
  );

  await withKeyFile(privateKey, async (keyPath) => {
    try {
      await sshExec(
        keyPath,
        user,
        host,
        `sudo mkdir -p ${shellQuote("/etc/haproxy")} && sudo tee ${shellQuote(remotePath)} > /dev/null << 'HAPROXY_CFG_EOF'\n${configContent}\nHAPROXY_CFG_EOF`,
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${ERR_UPLOAD}: ${msg}`);
    }
    result.configUploaded = true;
    core.info(
      `[${ERR_UPLOAD}] HAProxy base configuration written to ${remotePath} for fragment-only mode.`,
    );
  });

  return result;
}

/**
 * Ensure the bundled fragment-aware HAProxy systemd unit is installed.
 */
export async function ensureHaproxyFragService(
  opts: EnsureHaproxyFragServiceOptions,
): Promise<void> {
  const { host, user, privateKey, ipv6Only = false } = opts;

  const remotePath = "/etc/systemd/system/haproxy-frag.service";
  const serviceContent = readBundledHaproxyFragService();

  core.info(
    `[${ERR_SERVICE_INSTALL}] Installing bundled haproxy-frag service unit to ${remotePath}…`,
  );

  await withKeyFile(privateKey, async (keyPath) => {
    core.info(
      `[${ERR_SERVICE_INSTALL}] Stopping and disabling default haproxy service before enabling haproxy-frag…`,
    );
    try {
      await sshExec(
        keyPath,
        user,
        host,
        "sudo systemctl stop haproxy >/dev/null 2>&1 || true && sudo systemctl disable haproxy >/dev/null 2>&1 || true",
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${ERR_SERVICE_INSTALL}: ${msg}`);
    }
    core.info(
      `[${ERR_SERVICE_INSTALL}] Default haproxy service stop/disable command completed before haproxy-frag install.`,
    );

    core.info(
      `[${ERR_SERVICE_INSTALL}] Creating /etc/haproxy/conf.d/ early before uploading or enabling haproxy-frag…`,
    );
    try {
      await sshExec(
        keyPath,
        user,
        host,
        `sudo mkdir -p ${shellQuote("/etc/haproxy/conf.d/")}`,
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${ERR_SERVICE_INSTALL}: ${msg}`);
    }
    core.info(
      `[${ERR_SERVICE_INSTALL}] /etc/haproxy/conf.d/ is ready before haproxy-frag enablement.`,
    );

    core.info(`[${ERR_SERVICE_INSTALL}] Uploading haproxy-frag service unit to ${remotePath}…`);
    try {
      await sshExec(
        keyPath,
        user,
        host,
        `sudo mkdir -p ${shellQuote("/etc/systemd/system")} && sudo tee ${shellQuote(remotePath)} > /dev/null << 'HAPROXY_SERVICE_EOF'\n${serviceContent}\nHAPROXY_SERVICE_EOF`,
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${ERR_SERVICE_INSTALL}: ${msg}`);
    }
    core.info(`[${ERR_SERVICE_INSTALL}] haproxy-frag service unit written to ${remotePath}.`);

    core.info(`[${ERR_SERVICE_INSTALL}] Reloading systemd daemon…`);
    try {
      await sshExec(
        keyPath,
        user,
        host,
        "sudo systemctl daemon-reload",
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${ERR_SERVICE_INSTALL}: ${msg}`);
    }
    core.info(`[${ERR_SERVICE_INSTALL}] systemd daemon-reload completed successfully.`);

    core.info(
      `[${ERR_SERVICE_INSTALL}] Enabling haproxy-frag service without starting it yet…`,
    );
    try {
      await sshExec(
        keyPath,
        user,
        host,
        "sudo systemctl enable haproxy-frag",
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${ERR_SERVICE_INSTALL}: ${msg}`);
    }
    core.info(`[${ERR_SERVICE_INSTALL}] haproxy-frag service enabled successfully without starting it.`);
  });
}

/**
 * Deploy an HAProxy fragment to a remote host.
 *
 * Steps:
 *   1. Read the local HAProxy fragment file.
 *   2. Upload it to `/etc/haproxy/conf.d/<name>.cfg` on the remote host.
 *   3. Validate the full HAProxy configuration with `haproxy -c`.
 *   4. Reload the HAProxy service.
 */
export async function deployHaproxyFragment(
  opts: HaproxyFragmentOptions,
): Promise<HaproxyDeployResult> {
  const {
    host,
    user,
    privateKey,
    fragmentPath,
    fragmentName,
    ipv6Only = false,
  } = opts;

  const result: HaproxyDeployResult = {
    configUploaded: false,
    serviceReloaded: false,
  };

  const remotePath = `/etc/haproxy/conf.d/${fragmentName}.cfg`;
  const validateBasePath = "/etc/haproxy/haproxy.cfg";
  const validateFragmentsPath = "/etc/haproxy/conf.d/";

  core.info(
    `[${ERR_UPLOAD}] Reading HAProxy fragment ${fragmentName} from ${fragmentPath}…`,
  );

  let fragmentContent: string;
  try {
    fragmentContent = fs.readFileSync(fragmentPath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${ERR_UPLOAD}: failed to read local fragment "${fragmentName}" from ${fragmentPath}: ${msg}`,
    );
  }

  await withKeyFile(privateKey, async (keyPath) => {
    await backupConfD(keyPath, user, host, ipv6Only);
    await logConfDHashes(keyPath, user, host, "pre-upload", ipv6Only);

    core.info(
      `[${ERR_UPLOAD}] Uploading HAProxy fragment ${fragmentName} to ${remotePath}…`,
    );
    try {
      await sshExec(
        keyPath,
        user,
        host,
        `sudo mkdir -p ${shellQuote("/etc/haproxy/conf.d")} && sudo tee ${shellQuote(remotePath)} > /dev/null << 'HAPROXY_CFG_EOF'\n${fragmentContent}\nHAPROXY_CFG_EOF`,
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${ERR_UPLOAD}: failed to upload fragment "${fragmentName}": ${msg}`,
      );
    }
    result.configUploaded = true;
    core.info(`[${ERR_UPLOAD}] HAProxy fragment written to ${remotePath}.`);

    core.info(
      `[${ERR_VALIDATE}] Validating HAProxy configuration after uploading fragment ${fragmentName}…`,
    );
    try {
      await sshExec(
        keyPath,
        user,
        host,
        `sudo haproxy -c -f ${shellQuote(validateBasePath)} -f ${shellQuote(validateFragmentsPath)}`,
        ipv6Only,
      );
    } catch (err: unknown) {
      await restoreConfD(keyPath, user, host, ipv6Only);
      await logConfDHashes(keyPath, user, host, "post-restore", ipv6Only);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${ERR_VALIDATE}: failed to validate HAProxy configuration after uploading fragment "${fragmentName}": ${msg}`,
      );
    }
    core.info(`[${ERR_VALIDATE}] HAProxy configuration validation succeeded.`);

    await logConfDHashes(keyPath, user, host, "post-upload", ipv6Only);
    await cleanupConfDBackup(keyPath, user, host, ipv6Only);

    core.info(`[${ERR_RELOAD}] Reloading active haproxy-frag service or starting it if inactive…`);
    try {
      await sshExec(
        keyPath,
        user,
        host,
        HAPROXY_START_OR_RELOAD_CMD,
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${ERR_RELOAD}: failed to reload haproxy-frag after deploying fragment "${fragmentName}": ${msg}`,
      );
    }
    result.serviceReloaded = true;
    core.info(`[${ERR_RELOAD}] haproxy-frag service reloaded or started successfully.`);
  });

  return result;
}

/**
 * Deploy an HAProxy fragment to a remote host without reloading haproxy-frag.
 *
 * This is used when multiple fragment uploads should be validated first and a
 * later deployment performs the single final reload.
 */
export async function deployHaproxyFragmentWithoutReload(
  opts: HaproxyFragmentOptions,
): Promise<HaproxyDeployResult> {
  const {
    host,
    user,
    privateKey,
    fragmentPath,
    fragmentName,
    ipv6Only = false,
  } = opts;

  const result: HaproxyDeployResult = {
    configUploaded: false,
    serviceReloaded: false,
  };

  const remotePath = `/etc/haproxy/conf.d/${fragmentName}.cfg`;
  const validateBasePath = "/etc/haproxy/haproxy.cfg";
  const validateFragmentsPath = "/etc/haproxy/conf.d/";

  core.info(
    `[${ERR_UPLOAD}] Reading HAProxy fragment ${fragmentName} from ${fragmentPath} for deferred reload flow…`,
  );

  let fragmentContent: string;
  try {
    fragmentContent = fs.readFileSync(fragmentPath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${ERR_UPLOAD}: failed to read local fragment "${fragmentName}" from ${fragmentPath}: ${msg}`,
    );
  }

  await withKeyFile(privateKey, async (keyPath) => {
    await backupConfD(keyPath, user, host, ipv6Only);
    await logConfDHashes(keyPath, user, host, "pre-upload", ipv6Only);

    core.info(
      `[${ERR_UPLOAD}] Uploading HAProxy fragment ${fragmentName} to ${remotePath} without reloading haproxy-frag yet…`,
    );
    try {
      await sshExec(
        keyPath,
        user,
        host,
        `sudo mkdir -p ${shellQuote("/etc/haproxy/conf.d")} && sudo tee ${shellQuote(remotePath)} > /dev/null << 'HAPROXY_CFG_EOF'\n${fragmentContent}\nHAPROXY_CFG_EOF`,
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${ERR_UPLOAD}: failed to upload fragment "${fragmentName}": ${msg}`,
      );
    }
    result.configUploaded = true;
    core.info(`[${ERR_UPLOAD}] HAProxy fragment written to ${remotePath}.`);

    core.info(
      `[${ERR_VALIDATE}] Validating HAProxy configuration after uploading fragment ${fragmentName} without reloading yet…`,
    );
    try {
      await sshExec(
        keyPath,
        user,
        host,
        `sudo haproxy -c -f ${shellQuote(validateBasePath)} -f ${shellQuote(validateFragmentsPath)}`,
        ipv6Only,
      );
    } catch (err: unknown) {
      await restoreConfD(keyPath, user, host, ipv6Only);
      await logConfDHashes(keyPath, user, host, "post-restore", ipv6Only);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${ERR_VALIDATE}: failed to validate HAProxy configuration after uploading fragment "${fragmentName}": ${msg}`,
      );
    }
    await logConfDHashes(keyPath, user, host, "post-upload", ipv6Only);
    await cleanupConfDBackup(keyPath, user, host, ipv6Only);
    core.info(
      `[${ERR_VALIDATE}] HAProxy configuration validation succeeded; deferring haproxy-frag reload until later in the pipeline.`,
    );
  });

  return result;
}

/**
 * Deploy the bundled templated HAProxy certbot fragment to a remote host.
 */
export async function deployHaproxyCertbotFragment(
  opts: HaproxyCertbotFragmentOptions,
): Promise<HaproxyDeployResult> {
  const { host, user, privateKey, certbotPort, ipv6Only = false } = opts;

  const result: HaproxyDeployResult = {
    configUploaded: false,
    serviceReloaded: false,
  };

  const fragmentName = HAPROXY_CERTBOT_FRAGMENT_NAME;
  const remotePath = `/etc/haproxy/conf.d/${fragmentName}.cfg`;
  const validateBasePath = "/etc/haproxy/haproxy.cfg";
  const validateFragmentsPath = "/etc/haproxy/conf.d/";

  core.info(
    `[${ERR_CERTBOT_DEPLOY}] Preparing bundled HAProxy certbot fragment deployment for port ${certbotPort}…`,
  );

  let fragmentContent: string;
  try {
    fragmentContent = renderHaproxyCertbotFragment(certbotPort);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${ERR_CERTBOT_DEPLOY}: ${msg}`);
  }

  await withKeyFile(privateKey, async (keyPath) => {
    await backupConfD(keyPath, user, host, ipv6Only);
    await logConfDHashes(keyPath, user, host, "pre-upload", ipv6Only);

    core.info(
      `[${ERR_CERTBOT_DEPLOY}] Uploading HAProxy certbot fragment ${fragmentName} to ${remotePath}…`,
    );
    try {
      await sshExec(
        keyPath,
        user,
        host,
        `sudo mkdir -p ${shellQuote("/etc/haproxy/conf.d")} && sudo tee ${shellQuote(remotePath)} > /dev/null << 'HAPROXY_CFG_EOF'\n${fragmentContent}\nHAPROXY_CFG_EOF`,
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${ERR_CERTBOT_DEPLOY}: failed to upload certbot fragment "${fragmentName}": ${msg}`,
      );
    }
    result.configUploaded = true;
    core.info(
      `[${ERR_CERTBOT_DEPLOY}] HAProxy certbot fragment written to ${remotePath}.`,
    );

    core.info(
      `[${ERR_CERTBOT_DEPLOY}] Validating HAProxy configuration after uploading certbot fragment ${fragmentName}…`,
    );
    try {
      await sshExec(
        keyPath,
        user,
        host,
        `sudo haproxy -c -f ${shellQuote(validateBasePath)} -f ${shellQuote(validateFragmentsPath)}`,
        ipv6Only,
      );
    } catch (err: unknown) {
      await restoreConfD(keyPath, user, host, ipv6Only);
      await logConfDHashes(keyPath, user, host, "post-restore", ipv6Only);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${ERR_CERTBOT_DEPLOY}: failed to validate HAProxy configuration after uploading certbot fragment "${fragmentName}": ${msg}`,
      );
    }
    core.info(`[${ERR_CERTBOT_DEPLOY}] HAProxy configuration validation succeeded.`);

    await logConfDHashes(keyPath, user, host, "post-upload", ipv6Only);
    await cleanupConfDBackup(keyPath, user, host, ipv6Only);

    core.info(
      `[${ERR_CERTBOT_DEPLOY}] Reloading active haproxy-frag service or starting it if inactive…`,
    );
    try {
      await sshExec(
        keyPath,
        user,
        host,
        HAPROXY_START_OR_RELOAD_CMD,
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${ERR_CERTBOT_DEPLOY}: failed to reload haproxy-frag after deploying certbot fragment "${fragmentName}": ${msg}`,
      );
    }
    result.serviceReloaded = true;
    core.info(
      `[${ERR_CERTBOT_DEPLOY}] haproxy-frag service reloaded or started successfully after certbot fragment deployment.`,
    );
  });

  return result;
}
