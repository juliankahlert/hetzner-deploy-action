import * as core from "@actions/core";
import type { HetznerClient } from "./client.js";

export interface ServerResult {
  id: number;
  ip: string;
  status: string;
  /** True when the server was provisioned (or detected) as IPv6-only. */
  ipv6Only: boolean;
}

interface HetznerPublicNet {
  ipv4: { ip: string } | null;
  ipv6: { ip: string } | null;
}

interface HetznerServer {
  id: number;
  name: string;
  status: string;
  public_net: HetznerPublicNet;
  labels: Record<string, string>;
}

interface ServersResponse {
  servers: HetznerServer[];
}

interface ServerResponse {
  server: HetznerServer;
}

export interface FindOrCreateOptions {
  name: string;
  projectTag: string;
  image: string;
  serverType: string;
  ipv6Only: boolean;
  sshKeyIds: number[];
}

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 60; // 5 minutes max

/** Extract a usable IP from the server's public_net block. */
function extractIp(server: HetznerServer, preferIpv6: boolean): string {
  if (!preferIpv6 && server.public_net.ipv4) {
    return server.public_net.ipv4.ip;
  }
  if (server.public_net.ipv6) {
    // Hetzner returns IPv6 as "2a01:4f8:x:y::/64" — derive the ::1 host address
    const raw = server.public_net.ipv6.ip;
    const prefix = raw.replace(/::\/\d+$/, "");
    return `${prefix}::1`;
  }
  if (server.public_net.ipv4) {
    return server.public_net.ipv4.ip;
  }
  throw new Error(`Server ${server.id} has no public IP address`);
}

export async function findOrCreateServer(
  client: HetznerClient,
  opts: FindOrCreateOptions,
): Promise<ServerResult> {
  core.info(
    `Looking for server "${opts.name}" with label project=${opts.projectTag}…`,
  );

  // Discover existing server by name + label
  const list = await client.get<ServersResponse>("/servers", {
    name: opts.name,
    label_selector: `project=${opts.projectTag}`,
  });

  const existing = list.servers.find((s) => s.name === opts.name);
  if (existing) {
    const hasIpv4 = existing.public_net.ipv4 !== null;
    const actuallyIpv6Only = !hasIpv4;
    const ip = extractIp(existing, opts.ipv6Only);

    if (opts.ipv6Only && hasIpv4) {
      core.warning(
        `Server "${opts.name}" has a public IPv4 but ipv6_only=true was requested. ` +
          `The existing server's network config will not be changed. Using IPv6 address.`,
      );
    } else if (!opts.ipv6Only && !hasIpv4) {
      core.warning(
        `Server "${opts.name}" is IPv6-only but ipv6_only=false was requested. ` +
          `Returning IPv6 address since no IPv4 is available.`,
      );
    }

    core.info(
      `Found existing server "${opts.name}" (id=${existing.id}, ip=${ip}, status=${existing.status}, ipv6_only=${actuallyIpv6Only})`,
    );
    return { id: existing.id, ip, status: existing.status, ipv6Only: actuallyIpv6Only };
  }

  // Create server
  core.info(
    `Server "${opts.name}" not found. Creating (ipv6_only=${opts.ipv6Only})…`,
  );

  const createResp = await client.post<ServerResponse>("/servers", {
    name: opts.name,
    server_type: opts.serverType,
    image: opts.image,
    ssh_keys: opts.sshKeyIds,
    labels: {
      project: opts.projectTag,
      ipv6_only: String(opts.ipv6Only),
    },
    public_net: {
      enable_ipv4: !opts.ipv6Only,
      enable_ipv6: true,
    },
  });

  const server = createResp.server;
  core.info(
    `Server created (id=${server.id}). Waiting for it to become running…`,
  );

  // Poll until the server reaches "running" status
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const check = await client.get<ServerResponse>(`/servers/${server.id}`);
    if (check.server.status === "running") {
      const ip = extractIp(check.server, opts.ipv6Only);
      core.info(
        `Server "${opts.name}" is running (id=${check.server.id}, ip=${ip}, ipv6_only=${opts.ipv6Only})`,
      );
      return { id: check.server.id, ip, status: check.server.status, ipv6Only: opts.ipv6Only };
    }
    core.info(
      `Server status: ${check.server.status}. Polling again in ${POLL_INTERVAL_MS / 1000}s…`,
    );
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Server "${opts.name}" did not reach "running" status within ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`,
  );
}
