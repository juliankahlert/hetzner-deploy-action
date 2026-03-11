import type { Mock } from "vitest";
import { vi } from "vitest";

/* ------------------------------------------------------------------ */
/*  Fetch mocking helpers                                             */
/* ------------------------------------------------------------------ */

/** A minimal typed wrapper around a `vi.fn()` that replaces `globalThis.fetch`. */
export type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

/**
 * Create a `vi.fn()` typed as {@link FetchMock} and install it as
 * `globalThis.fetch`.  Returns the mock so callers can configure it.
 *
 * **Important:** Call this inside `beforeEach` and restore the original
 * `fetch` in `afterEach` (or use `vi.restoreAllMocks()`).
 */
export function createFetchMock(): FetchMock {
  const mock: FetchMock = vi.fn();
  vi.stubGlobal("fetch", mock);
  return mock;
}

/**
 * Configure a {@link FetchMock} to return a single JSON response for
 * the next call (or all calls when combined with `mockReturnValue`).
 *
 * @param fetchMock The fetch mock to configure.
 * @param body      JSON-serialisable payload to return.
 * @param status    HTTP status code (default `200`).
 */
export function mockFetchJson(
  fetchMock: FetchMock,
  body: unknown,
  status = 200,
): void {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/** Entry in the response sequence passed to {@link mockFetchSequence}. */
export interface FetchSequenceEntry {
  /** JSON-serialisable response body. */
  body: unknown;
  /** HTTP status code (default `200`). */
  status?: number;
}

/**
 * Configure a {@link FetchMock} to return an ordered sequence of JSON
 * responses, one per call.
 *
 * ```ts
 * mockFetchSequence(fetchMock, [
 *   { body: { server: { id: 1 } } },
 *   { body: { error: { code: "rate_limit" } }, status: 429 },
 *   { body: { server: { id: 1, status: "running" } } },
 * ]);
 * ```
 */
export function mockFetchSequence(
  fetchMock: FetchMock,
  responses: FetchSequenceEntry[],
): void {
  for (const { body, status = 200 } of responses) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
}

/* ------------------------------------------------------------------ */
/*  HetznerAPI mock                                                   */
/* ------------------------------------------------------------------ */

/**
 * Minimal mock surface for the `hetzner-ts` `HetznerAPI` class.
 *
 * Only the sub-APIs actually used by this project (`servers`, `sshKeys`)
 * are pre-stubbed; extend as needed.
 */
export interface MockHetznerAPI {
  /** Stub for `api.servers` property. */
  servers: {
    getAll: Mock;
    get: Mock;
    create: Mock;
    delete: Mock;
  };
  /** Stub for `api.sshKeys` property. */
  sshKeys: {
    getAll: Mock;
    get: Mock;
    create: Mock;
    delete: Mock;
  };
  /** Low-level `request` inherited from `BaseAPI` — useful for ad-hoc mocking. */
  request: Mock;
}

/**
 * Create a mock object that satisfies the shape tests expect from
 * `new HetznerAPI(token)`.
 *
 * Intended to be used with `vi.mock("hetzner-ts", …)`:
 *
 * ```ts
 * const mockApi = createMockHetznerAPI();
 * vi.mock("hetzner-ts", () => ({
 *   HetznerAPI: vi.fn(() => mockApi),
 * }));
 * ```
 *
 * All methods are `vi.fn()` stubs — configure return values per-test.
 */
export function createMockHetznerAPI(): MockHetznerAPI {
  return {
    servers: {
      getAll: vi.fn().mockResolvedValue({ success: true, response: { servers: [] } }),
      get: vi.fn().mockResolvedValue({ success: true, response: { server: null } }),
      create: vi.fn().mockResolvedValue({ success: true, response: { server: { id: 1 } } }),
      delete: vi.fn().mockResolvedValue({ success: true, response: {} }),
    },
    sshKeys: {
      getAll: vi.fn().mockResolvedValue({ success: true, response: { ssh_keys: [] } }),
      get: vi.fn().mockResolvedValue({ success: true, response: { ssh_key: null } }),
      create: vi.fn().mockResolvedValue({ success: true, response: { ssh_key: { id: 1 } } }),
      delete: vi.fn().mockResolvedValue({ success: true, response: {} }),
    },
    request: vi.fn(),
  };
}
