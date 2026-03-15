import * as core from "@actions/core";

import type { OsFamily, OsStrategy } from "./osStrategy.js";
import { createDebianStrategy } from "./strategies/debian.js";
import { createFedoraStrategy } from "./strategies/fedora.js";
import { sshExec, withKeyFile } from "./ssh.js";

const OS_DETECT_LOG_PREFIX = "[OS_DETECT]";
const OS_DETECT_ERROR_PREFIX = "OS_DETECT";
const OS_DETECT_UNSUPPORTED = "OS_DETECT_UNSUPPORTED";

const DEBIAN_IDENTIFIERS = new Set(["debian", "ubuntu"]);
const FEDORA_IDENTIFIERS = new Set([
  "fedora",
  "centos",
  "rocky",
  "rhel",
]);

/** Options for remote OS detection and strategy selection. */
export interface DetectOsOptions {
  /** Hetzner image slug used during provisioning. */
  image: string;
  /** Server IP or hostname. */
  host: string;
  /** SSH user used for remote inspection. */
  user: string;
  /** SSH private key content. */
  privateKey: string;
  /** When true the host is an IPv6 address — forces ssh to use `-6`. */
  ipv6Only?: boolean;
}

function logInfo(message: string): void {
  core.info(`${OS_DETECT_LOG_PREFIX} ${message}`);
}

function logWarning(message: string): void {
  core.warning(`${OS_DETECT_LOG_PREFIX} ${message}`);
}

function logDebug(message: string): void {
  core.debug(`${OS_DETECT_LOG_PREFIX} ${message}`);
}

function normalizeOsReleaseValue(rawValue: string): string {
  const value = rawValue.trim();

  if (value.length < 2) {
    return value;
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }

  return value;
}

function familyFromIdentifiers(identifiers: readonly string[]): OsFamily | null {
  for (const identifier of identifiers) {
    if (DEBIAN_IDENTIFIERS.has(identifier)) {
      return "debian";
    }

    if (FEDORA_IDENTIFIERS.has(identifier)) {
      return "fedora";
    }
  }

  return null;
}

function createUnsupportedError(detail: string): Error {
  return new Error(`${OS_DETECT_UNSUPPORTED}: ${detail}`);
}

function wrapOsDetectError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith(OS_DETECT_ERROR_PREFIX)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${OS_DETECT_ERROR_PREFIX}: ${message}`);
}

async function readOsReleaseOverSsh(
  options: DetectOsOptions,
): Promise<string> {
  const { privateKey, user, host, ipv6Only = false } = options;

  try {
    return await withKeyFile(privateKey, async (keyPath) => {
      logDebug(`Reading /etc/os-release from ${host}.`);
      return await sshExec(keyPath, user, host, "cat /etc/os-release", ipv6Only);
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${OS_DETECT_ERROR_PREFIX}: failed to read /etc/os-release over SSH: ${message}`,
    );
  }
}

/**
 * Detect an OS family directly from a Hetzner image slug.
 *
 * Returns `null` when the slug does not map to a supported family.
 */
export function detectOsFromSlug(image: string): OsFamily | null {
  const identifiers = image
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0);

  return familyFromIdentifiers(identifiers);
}

/**
 * Parse `/etc/os-release` content and map it to a supported OS family.
 *
 * Throws `OS_DETECT_UNSUPPORTED` when the parsed identifiers are unknown.
 */
export function parseOsRelease(content: string): OsFamily {
  const entries = new Map<string, string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = normalizeOsReleaseValue(line.slice(separatorIndex + 1));
    entries.set(key, value);
  }

  const id = entries.get("ID")?.toLowerCase() ?? "";
  const idLike = (entries.get("ID_LIKE") ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0);

  logDebug(
    `Parsed /etc/os-release identifiers: ID=${JSON.stringify(id)}, ID_LIKE=${JSON.stringify(idLike)}.`,
  );

  const family = familyFromIdentifiers([id, ...idLike].filter((part) => part.length > 0));
  if (family) {
    return family;
  }

  throw createUnsupportedError(
    `unsupported /etc/os-release identifiers: ID=${JSON.stringify(id)}, ID_LIKE=${JSON.stringify(idLike.join(" "))}`,
  );
}

/** Create a deployment strategy for a supported OS family. */
export function createStrategyForFamily(family: OsFamily): OsStrategy {
  switch (family) {
    case "debian":
      return createDebianStrategy();
    case "fedora":
      return createFedoraStrategy();
  }
}

/**
 * Detect the remote operating-system family and return the matching strategy.
 *
 * Detection order:
 *   1. Fast-path from the provisioned image slug.
 *   2. Fallback to remote `/etc/os-release` over SSH.
 *   3. Throw `OS_DETECT_UNSUPPORTED` when still unknown.
 */
export async function detectOs(options: DetectOsOptions): Promise<OsStrategy> {
  const { image, host } = options;

  logInfo(`Starting OS detection for ${host}.`);
  logDebug(`Evaluating image slug ${JSON.stringify(image)}.`);

  try {
    const familyFromSlug = detectOsFromSlug(image);
    if (familyFromSlug) {
      logInfo(`Detected ${familyFromSlug} family from image slug.`);
      const strategy = createStrategyForFamily(familyFromSlug);
      logInfo(`Completed OS detection with ${strategy.family} strategy.`);
      return strategy;
    }

    logWarning(
      `Unsupported or unknown image slug ${JSON.stringify(image)}; falling back to /etc/os-release over SSH.`,
    );

    const osRelease = await readOsReleaseOverSsh(options);
    logDebug(`Fetched /etc/os-release (${osRelease.length} bytes).`);

    const familyFromOsRelease = parseOsRelease(osRelease);
    logInfo(`Detected ${familyFromOsRelease} family from /etc/os-release.`);

    const strategy = createStrategyForFamily(familyFromOsRelease);
    logInfo(`Completed OS detection with ${strategy.family} strategy.`);
    return strategy;
  } catch (error: unknown) {
    throw wrapOsDetectError(error);
  }
}
