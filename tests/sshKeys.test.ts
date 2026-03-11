import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before imports that trigger them
// ---------------------------------------------------------------------------

vi.mock("@actions/core", async () => {
  const { createCoreMock } = await import("./helpers/mockCore");
  return createCoreMock();
});

// ---------------------------------------------------------------------------
// Imports (receive mocked implementations)
// ---------------------------------------------------------------------------

import * as core from "@actions/core";
import type { HetznerClient } from "../src/hetzner/client.js";
import { ensureSshKey } from "../src/hetzner/sshKeys.js";
import { createMockHetznerAPI } from "./helpers/mockHetznerApi";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const KEY_NAME = "myproject-deploy";
const PUBLIC_KEY = "ssh-ed25519 AAAATESTKEY original-comment";

function makeClient(): {
  client: HetznerClient;
  api: ReturnType<typeof createMockHetznerAPI>;
} {
  const api = createMockHetznerAPI();
  return {
    api,
    client: { api } as unknown as HetznerClient,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureSshKey", () => {
  it("throws when the name lookup API call fails", async () => {
    const { client, api } = makeClient();

    api.sshKeys.getAll.mockResolvedValueOnce({
      success: false,
      response: { error: { message: "lookup failed" } },
    });

    await expect(ensureSshKey(client, KEY_NAME, PUBLIC_KEY)).rejects.toThrow(
      "Hetzner API error listing SSH keys: lookup failed",
    );

    expect(api.sshKeys.getAll).toHaveBeenCalledTimes(1);
    expect(api.sshKeys.getAll).toHaveBeenCalledWith({ name: KEY_NAME });
    expect(api.sshKeys.create).not.toHaveBeenCalled();
  });

  it("returns an existing key by exact name without creating one", async () => {
    const { client, api } = makeClient();
    const existingKey = {
      id: 7,
      name: KEY_NAME,
      fingerprint: "aa:bb:cc",
      public_key: PUBLIC_KEY,
    };

    api.sshKeys.getAll.mockResolvedValueOnce({
      success: true,
      response: {
        ssh_keys: [{ ...existingKey, name: "other-key", id: 8 }, existingKey],
      },
    });

    await expect(ensureSshKey(client, KEY_NAME, PUBLIC_KEY)).resolves.toEqual({
      id: 7,
      name: KEY_NAME,
      fingerprint: "aa:bb:cc",
    });

    expect(api.sshKeys.getAll).toHaveBeenCalledTimes(1);
    expect(api.sshKeys.getAll).toHaveBeenCalledWith({ name: KEY_NAME });
    expect(api.sshKeys.create).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(
      `SSH key "${KEY_NAME}" found (id=7).`,
    );
  });

  it("creates the key when no matching name exists", async () => {
    const { client, api } = makeClient();

    api.sshKeys.getAll.mockResolvedValueOnce({
      success: true,
      response: { ssh_keys: [] },
    });
    api.sshKeys.create.mockResolvedValueOnce({
      success: true,
      response: {
        ssh_key: {
          id: 11,
          name: KEY_NAME,
          fingerprint: "11:22:33",
          public_key: PUBLIC_KEY,
        },
      },
    });

    await expect(ensureSshKey(client, KEY_NAME, PUBLIC_KEY)).resolves.toEqual({
      id: 11,
      name: KEY_NAME,
      fingerprint: "11:22:33",
    });

    expect(api.sshKeys.getAll).toHaveBeenCalledTimes(1);
    expect(api.sshKeys.getAll).toHaveBeenCalledWith({ name: KEY_NAME });
    expect(api.sshKeys.create).toHaveBeenCalledTimes(1);
    expect(api.sshKeys.create).toHaveBeenCalledWith({
      name: KEY_NAME,
      public_key: PUBLIC_KEY,
    });
  });

  it("falls back to a full scan on uniqueness_error and matches normalized keys", async () => {
    const { client, api } = makeClient();
    const existingKey = {
      id: 21,
      name: "legacy-deploy",
      fingerprint: "de:ad:be:ef",
      public_key: "ssh-ed25519 AAAATESTKEY different-comment   ",
    };

    api.sshKeys.getAll
      .mockResolvedValueOnce({
        success: true,
        response: { ssh_keys: [] },
      })
      .mockResolvedValueOnce({
        success: true,
        response: {
          ssh_keys: [
            {
              id: 22,
              name: "another-key",
              fingerprint: "00:11:22",
              public_key: "ssh-rsa AAAADIFFERENT ignored-comment",
            },
            existingKey,
          ],
        },
      });
    api.sshKeys.create.mockResolvedValueOnce({
      success: false,
      response: {
        error: {
          code: "uniqueness_error",
          message: "SSH key already exists",
        },
      },
    });

    await expect(ensureSshKey(client, KEY_NAME, PUBLIC_KEY)).resolves.toEqual({
      id: 21,
      name: "legacy-deploy",
      fingerprint: "de:ad:be:ef",
    });

    expect(api.sshKeys.getAll).toHaveBeenCalledTimes(2);
    expect(api.sshKeys.getAll).toHaveBeenNthCalledWith(1, { name: KEY_NAME });
    expect(api.sshKeys.getAll).toHaveBeenNthCalledWith(2, { per_page: 50 });
    expect(api.sshKeys.create).toHaveBeenCalledTimes(1);
    expect(api.sshKeys.create).toHaveBeenCalledWith({
      name: KEY_NAME,
      public_key: PUBLIC_KEY,
    });
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("Public key already registered under a different name"),
    );
  });

  it("throws when the fallback full scan fails after uniqueness_error", async () => {
    const { client, api } = makeClient();

    api.sshKeys.getAll
      .mockResolvedValueOnce({
        success: true,
        response: { ssh_keys: [] },
      })
      .mockResolvedValueOnce({
        success: false,
        response: { error: { message: "full scan failed" } },
      });
    api.sshKeys.create.mockResolvedValueOnce({
      success: false,
      response: {
        error: {
          code: "uniqueness_error",
          message: "SSH key already exists",
        },
      },
    });

    await expect(ensureSshKey(client, KEY_NAME, PUBLIC_KEY)).rejects.toThrow(
      "Hetzner API error listing SSH keys: full scan failed",
    );

    expect(api.sshKeys.getAll).toHaveBeenCalledTimes(2);
    expect(api.sshKeys.getAll).toHaveBeenNthCalledWith(1, { name: KEY_NAME });
    expect(api.sshKeys.getAll).toHaveBeenNthCalledWith(2, { per_page: 50 });
    expect(api.sshKeys.create).toHaveBeenCalledTimes(1);
  });

  it("rethrows the create error when uniqueness fallback finds no normalized match, including single-part keys", async () => {
    const { client, api } = makeClient();
    const singlePartKey = "ssh-ed25519-singlepart";

    api.sshKeys.getAll
      .mockResolvedValueOnce({
        success: true,
        response: { ssh_keys: [] },
      })
      .mockResolvedValueOnce({
        success: true,
        response: {
          ssh_keys: [
            {
              id: 31,
              name: "unrelated-single-part",
              fingerprint: "33:44:55",
              public_key: "ssh-rsa-singlepart",
            },
          ],
        },
      });
    api.sshKeys.create.mockResolvedValueOnce({
      success: false,
      response: {
        error: {
          code: "uniqueness_error",
          message: "duplicate public key",
        },
      },
    });

    await expect(ensureSshKey(client, KEY_NAME, singlePartKey)).rejects.toThrow(
      `Failed to ensure SSH key "${KEY_NAME}": duplicate public key (uniqueness_error)`,
    );

    expect(api.sshKeys.getAll).toHaveBeenCalledTimes(2);
    expect(api.sshKeys.getAll).toHaveBeenNthCalledWith(1, { name: KEY_NAME });
    expect(api.sshKeys.getAll).toHaveBeenNthCalledWith(2, { per_page: 50 });
    expect(api.sshKeys.create).toHaveBeenCalledWith({
      name: KEY_NAME,
      public_key: singlePartKey,
    });
  });

  it("rethrows non-uniqueness create errors directly", async () => {
    const { client, api } = makeClient();

    api.sshKeys.getAll.mockResolvedValueOnce({
      success: true,
      response: { ssh_keys: [] },
    });
    api.sshKeys.create.mockResolvedValueOnce({
      success: false,
      response: {
        error: {
          code: "forbidden",
          message: "permission denied",
        },
      },
    });

    await expect(ensureSshKey(client, KEY_NAME, PUBLIC_KEY)).rejects.toThrow(
      `Failed to ensure SSH key "${KEY_NAME}": permission denied (forbidden)`,
    );

    expect(api.sshKeys.getAll).toHaveBeenCalledTimes(1);
    expect(api.sshKeys.getAll).toHaveBeenCalledWith({ name: KEY_NAME });
    expect(api.sshKeys.create).toHaveBeenCalledTimes(1);
    expect(api.sshKeys.create).toHaveBeenCalledWith({
      name: KEY_NAME,
      public_key: PUBLIC_KEY,
    });
  });
});
