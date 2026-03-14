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

.include /etc/haproxy/conf.d/
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

    core.info(`[${ERR_RELOAD}] Reloading haproxy service…`);
    try {
      await sshExec(
        keyPath,
        user,
        host,
        "sudo systemctl reload haproxy",
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${ERR_RELOAD}: ${msg}`);
    }
    result.serviceReloaded = true;
    core.info(`[${ERR_RELOAD}] haproxy service reloaded successfully.`);
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
    core.info(`[${ERR_UPLOAD}] HAProxy base configuration written to ${remotePath}.`);

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

    core.info(`[${ERR_RELOAD}] Reloading haproxy service…`);
    try {
      await sshExec(
        keyPath,
        user,
        host,
        "sudo systemctl reload haproxy",
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${ERR_RELOAD}: ${msg}`);
    }
    result.serviceReloaded = true;
    core.info(`[${ERR_RELOAD}] haproxy service reloaded successfully.`);
  });

  return result;
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
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${ERR_VALIDATE}: failed to validate HAProxy configuration after uploading fragment "${fragmentName}": ${msg}`,
      );
    }
    core.info(`[${ERR_VALIDATE}] HAProxy configuration validation succeeded.`);

    core.info(`[${ERR_RELOAD}] Reloading haproxy service…`);
    try {
      await sshExec(
        keyPath,
        user,
        host,
        "sudo systemctl reload haproxy",
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${ERR_RELOAD}: failed to reload haproxy after deploying fragment "${fragmentName}": ${msg}`,
      );
    }
    result.serviceReloaded = true;
    core.info(`[${ERR_RELOAD}] haproxy service reloaded successfully.`);
  });

  return result;
}
