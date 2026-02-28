import * as core from "@actions/core";
import type { HetznerClient } from "./client.js";

/** Minimal SSH key info needed downstream (server create). */
export interface SshKeyResult {
  id: number;
  name: string;
  fingerprint: string;
}

/**
 * Ensure the given SSH public key is registered in the Hetzner project.
 *
 * Strategy:
 *   1. List keys filtered by **name** (exact match).
 *   2. If no match, attempt **create**.
 *   3. On uniqueness_error (key body already registered under a different
 *      name), fall back to a fingerprint/public-key scan.
 *
 * @param client    Authenticated HetznerClient.
 * @param name      Desired key name (e.g. `${projectTag}-deploy`).
 * @param publicKey Raw SSH public key string (e.g. "ssh-ed25519 AAAA…").
 * @returns         Key id, name and fingerprint.
 */
export async function ensureSshKey(
  client: HetznerClient,
  name: string,
  publicKey: string,
): Promise<SshKeyResult> {
  core.info(`Ensuring SSH key "${name}" exists in project…`);

  // 1. Lookup by name via the typed SDK
  const byName = await client.api.sshKeys.getAll({ name });
  if (!byName.success) {
    throw new Error(
      `Hetzner API error listing SSH keys: ${byName.response.error.message}`,
    );
  }

  const nameMatch = byName.response.ssh_keys.find((k) => k.name === name);
  if (nameMatch) {
    core.info(`SSH key "${name}" found (id=${nameMatch.id}).`);
    return pick(nameMatch);
  }

  // 2. Key not found by name — create it
  core.info(`SSH key "${name}" not found — creating…`);
  const created = await client.api.sshKeys.create({
    name,
    public_key: publicKey,
  });

  if (created.success) {
    const key = created.response.ssh_key;
    core.info(`SSH key "${name}" created (id=${key.id}).`);
    return pick(key);
  }

  // 3. Handle uniqueness_error: key body exists under a different name.
  const errCode = created.response.error.code;
  if (errCode === "uniqueness_error") {
    core.info(
      "Public key already registered under a different name — scanning by fingerprint…",
    );

    const all = await client.api.sshKeys.getAll({ per_page: 50 });
    if (!all.success) {
      throw new Error(
        `Hetzner API error listing SSH keys: ${all.response.error.message}`,
      );
    }

    const normalizedInput = normalizePublicKey(publicKey);
    const match = all.response.ssh_keys.find(
      (k) => normalizePublicKey(k.public_key) === normalizedInput,
    );

    if (match) {
      core.info(
        `Found existing SSH key "${match.name}" (id=${match.id}) matching the provided public key.`,
      );
      return pick(match);
    }
  }

  // Any other error — propagate.
  throw new Error(
    `Failed to ensure SSH key "${name}": ${created.response.error.message} (${errCode})`,
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/** Strip optional comment / trailing whitespace for comparison. */
function normalizePublicKey(raw: string): string {
  const parts = raw.trim().split(/\s+/);
  // SSH public key format: <type> <base64> [comment]
  return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : parts[0];
}

function pick(k: {
  id: number;
  name: string;
  fingerprint: string;
}): SshKeyResult {
  return { id: k.id, name: k.name, fingerprint: k.fingerprint };
}
