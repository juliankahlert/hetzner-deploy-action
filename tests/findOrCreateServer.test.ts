import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HetznerClient } from "../src/hetzner/client.js";

const coreMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn().mockReturnValue(""),
  setOutput: vi.fn(),
  setSecret: vi.fn(),
}));

vi.mock("@actions/core", () => coreMocks);

import {
  findOrCreateServer,
  type FindOrCreateOptions,
} from "../src/hetzner/findOrCreateServer.js";

interface TestServer {
  id: number;
  name: string;
  status: string;
  public_net: {
    ipv4: { ip: string } | null;
    ipv6: { ip: string } | null;
  };
  labels: Record<string, string>;
}

type GetImpl = (
  path: string,
  params?: Record<string, string>,
) => Promise<unknown>;
type PostImpl = (path: string, body: unknown) => Promise<unknown>;

const BASE_OPTIONS: FindOrCreateOptions = {
  name: "ci-server",
  projectTag: "demo-project",
  image: "ubuntu-24.04",
  serverType: "cpx11",
  ipv6Only: false,
  sshKeyIds: [11, 22],
};

function makeServer(overrides: Partial<TestServer> = {}): TestServer {
  const base: TestServer = {
    id: 101,
    name: BASE_OPTIONS.name,
    status: "running",
    public_net: {
      ipv4: { ip: "203.0.113.10" },
      ipv6: { ip: "2001:db8:abcd:12::/64" },
    },
    labels: { project: BASE_OPTIONS.projectTag },
  };

  const publicNetOverrides = overrides.public_net;

  return {
    ...base,
    ...overrides,
    public_net: {
      ipv4:
        publicNetOverrides && "ipv4" in publicNetOverrides
          ? publicNetOverrides.ipv4
          : base.public_net.ipv4,
      ipv6:
        publicNetOverrides && "ipv6" in publicNetOverrides
          ? publicNetOverrides.ipv6
          : base.public_net.ipv6,
    },
    labels: {
      ...base.labels,
      ...overrides.labels,
    },
  };
}

function createMockClient(handlers: {
  get?: GetImpl;
  post?: PostImpl;
}): HetznerClient & {
  get: ReturnType<typeof vi.fn<GetImpl>>;
  post: ReturnType<typeof vi.fn<PostImpl>>;
} {
  const get = vi.fn<GetImpl>(
    handlers.get ??
      (async (path: string) => {
        throw new Error(`Unexpected GET ${path}`);
      }),
  );
  const post = vi.fn<PostImpl>(
    handlers.post ??
      (async (path: string) => {
        throw new Error(`Unexpected POST ${path}`);
      }),
  );

  return {
    api: {} as HetznerClient["api"],
    get: get as HetznerClient["get"] & typeof get,
    post: post as HetznerClient["post"] & typeof post,
  };
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe("findOrCreateServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an existing server with its IPv4 and no warnings", async () => {
    const existing = makeServer();
    const client = createMockClient({
      get: async (path, params) => {
        expect(path).toBe("/servers");
        expect(params).toEqual({
          name: BASE_OPTIONS.name,
          label_selector: `project=${BASE_OPTIONS.projectTag}`,
        });
        return { servers: [existing] };
      },
    });

    const result = await findOrCreateServer(client, BASE_OPTIONS);

    expect(result).toEqual({
      id: existing.id,
      ip: "203.0.113.10",
      status: existing.status,
      ipv6Only: false,
    });
    expect(client.post).not.toHaveBeenCalled();
    expect(coreMocks.warning).not.toHaveBeenCalled();
  });

  it("warns and falls back to IPv4 when IPv6 is requested but unavailable", async () => {
    const existing = makeServer({
      public_net: {
        ipv4: { ip: "198.51.100.8" },
        ipv6: null,
      },
    });
    const client = createMockClient({
      get: async () => ({ servers: [existing] }),
    });

    const result = await findOrCreateServer(client, {
      ...BASE_OPTIONS,
      ipv6Only: true,
    });

    expect(result).toEqual({
      id: existing.id,
      ip: "198.51.100.8",
      status: existing.status,
      ipv6Only: false,
    });
    expect(coreMocks.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'has a public IPv4 but ipv6_only=true was requested',
      ),
    );
  });

  it("warns and derives an IPv6 host address for an IPv6-only existing server", async () => {
    const existing = makeServer({
      public_net: {
        ipv4: null,
        ipv6: { ip: "2a01:4f8:c010:12ab::/64" },
      },
    });
    const client = createMockClient({
      get: async () => ({ servers: [existing] }),
    });

    const result = await findOrCreateServer(client, BASE_OPTIONS);

    expect(result).toEqual({
      id: existing.id,
      ip: "2a01:4f8:c010:12ab::1",
      status: existing.status,
      ipv6Only: true,
    });
    expect(coreMocks.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'is IPv6-only but ipv6_only=false was requested',
      ),
    );
  });

  it("throws when an existing server has no public IP address", async () => {
    const existing = makeServer({
      public_net: {
        ipv4: null,
        ipv6: null,
      },
    });
    const client = createMockClient({
      get: async () => ({ servers: [existing] }),
    });

    await expect(findOrCreateServer(client, BASE_OPTIONS)).rejects.toThrow(
      `Server ${existing.id} has no public IP address`,
    );
  });

  it("creates a server and polls until it becomes running", async () => {
    vi.useFakeTimers();

    const created = makeServer({ id: 202, status: "initializing" });
    const pollResponses = [
      { server: makeServer({ id: 202, status: "starting" }) },
      { server: makeServer({ id: 202, status: "running" }) },
    ];

    const client = createMockClient({
      get: async (path) => {
        if (path === "/servers") {
          return { servers: [] };
        }
        if (path === "/servers/202") {
          return pollResponses.shift() ?? pollResponses[pollResponses.length - 1];
        }
        throw new Error(`Unexpected GET ${path}`);
      },
      post: async (path, body) => {
        expect(path).toBe("/servers");
        expect(body).toEqual({
          name: BASE_OPTIONS.name,
          server_type: BASE_OPTIONS.serverType,
          image: BASE_OPTIONS.image,
          ssh_keys: BASE_OPTIONS.sshKeyIds,
          labels: {
            project: BASE_OPTIONS.projectTag,
            ipv6_only: "false",
          },
          public_net: {
            enable_ipv4: true,
            enable_ipv6: true,
          },
        });
        return { server: created };
      },
    });

    const resultPromise = findOrCreateServer(client, BASE_OPTIONS);

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5000);

    await expect(resultPromise).resolves.toEqual({
      id: 202,
      ip: "203.0.113.10",
      status: "running",
      ipv6Only: false,
    });
    expect(client.get).toHaveBeenCalledTimes(3);
    expect(coreMocks.info).toHaveBeenCalledWith(
      expect.stringContaining("Server status: starting. Polling again in 5s"),
    );
  });

  it("throws after the maximum polling attempts when the server never runs", async () => {
    vi.useFakeTimers();

    const created = makeServer({ id: 303, status: "initializing" });
    const stalled = makeServer({ id: 303, status: "starting" });

    const client = createMockClient({
      get: async (path) => {
        if (path === "/servers") {
          return { servers: [] };
        }
        if (path === "/servers/303") {
          return { server: stalled };
        }
        throw new Error(`Unexpected GET ${path}`);
      },
      post: async () => ({ server: created }),
    });

    const resultPromise = findOrCreateServer(client, BASE_OPTIONS).catch(
      (error: unknown) => error,
    );

    await flushMicrotasks();
    await vi.runAllTimersAsync();

    const error = await resultPromise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Server "ci-server" did not reach "running" status within 300s',
    );
    expect(client.get).toHaveBeenCalledTimes(61);
    expect(client.post).toHaveBeenCalledTimes(1);
  });
});
