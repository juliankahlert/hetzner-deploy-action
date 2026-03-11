import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createFetchMock,
  createMockHetznerAPI,
  mockFetchJson,
  mockFetchSequence,
  type FetchMock,
} from "./helpers/mockHetznerApi";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports that trigger them
// ---------------------------------------------------------------------------

// Mock @actions/core using shared helper
vi.mock("@actions/core", async () => {
  const { createCoreMock } = await import("./helpers/mockCore");
  return createCoreMock();
});

// Mock hetzner-ts so we never instantiate the real SDK
const MockHetznerAPICtor = vi.hoisted(() => vi.fn(function () {}));
vi.mock("hetzner-ts", () => ({ HetznerAPI: MockHetznerAPICtor }));

import {
  createClient,
  HetznerApiError,
} from "../src/hetzner/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN = "test-token-abc123";

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("HetznerClient", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = createFetchMock();
    MockHetznerAPICtor.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // 1. GET success with query params and Authorization header
  // -------------------------------------------------------------------------
  describe("get()", () => {
    it("sends GET with query params and Authorization header", async () => {
      const payload = { servers: [{ id: 1, name: "srv-1" }] };
      mockFetchJson(fetchMock, payload);

      const client = createClient(TOKEN);
      const result = await client.get("/servers", { name: "srv-1" });

      expect(result).toEqual(payload);
      expect(fetchMock).toHaveBeenCalledOnce();

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        "https://api.hetzner.cloud/v1/servers?name=srv-1",
      );
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      });
      expect(init?.body).toBeUndefined();
    });

    it("does not append a dangling query string for empty params", async () => {
      const payload = { servers: [] };
      mockFetchJson(fetchMock, payload);

      const client = createClient(TOKEN);
      const result = await client.get("/servers", {});

      expect(result).toEqual(payload);
      expect(fetchMock).toHaveBeenCalledOnce();

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.hetzner.cloud/v1/servers");
      expect(init?.method).toBe("GET");
    });
  });

  // -------------------------------------------------------------------------
  // 2. POST success with JSON body
  // -------------------------------------------------------------------------
  describe("post()", () => {
    it("sends POST with JSON body and returns parsed response", async () => {
      const reqBody = { name: "new-server", server_type: "cx22" };
      const resBody = { server: { id: 42, name: "new-server" } };
      mockFetchJson(fetchMock, resBody, 201);

      const client = createClient(TOKEN);
      const result = await client.post("/servers", reqBody);

      expect(result).toEqual(resBody);
      expect(fetchMock).toHaveBeenCalledOnce();

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.hetzner.cloud/v1/servers");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify(reqBody));
    });
  });

  // -------------------------------------------------------------------------
  // 3. 204 response returns undefined
  // -------------------------------------------------------------------------
  describe("204 No Content", () => {
    it("returns undefined for 204 responses", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const client = createClient(TOKEN);
      const result = await client.post("/servers/42/actions/shutdown", {});

      expect(result).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Non-retryable 4xx throws HetznerApiError
  // -------------------------------------------------------------------------
  describe("non-retryable errors", () => {
    it("throws HetznerApiError with status/code/message for 404", async () => {
      mockFetchJson(
        fetchMock,
        { error: { code: "not_found", message: "Server not found" } },
        404,
      );

      const client = createClient(TOKEN);
      const error = await client.get("/servers/999").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HetznerApiError);
      const apiErr = error as InstanceType<typeof HetznerApiError>;
      expect(apiErr.status).toBe(404);
      expect(apiErr.code).toBe("not_found");
      expect(apiErr.message).toBe("Server not found");
    });

    it("throws immediately without retrying for 403", async () => {
      mockFetchJson(
        fetchMock,
        { error: { code: "forbidden", message: "Insufficient permissions" } },
        403,
      );

      const client = createClient(TOKEN);
      await expect(client.get("/servers")).rejects.toThrow(HetznerApiError);
      // Only one fetch call — no retries
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to unknown code and HTTP status when error body is not JSON", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("not json", {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        }),
      );

      const client = createClient(TOKEN);
      const error = await client.get("/servers").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HetznerApiError);
      const apiErr = error as InstanceType<typeof HetznerApiError>;
      expect(apiErr.status).toBe(400);
      expect(apiErr.code).toBe("unknown");
      expect(apiErr.message).toBe("HTTP 400");
    });

    it("falls back to unknown code when error JSON omits code", async () => {
      mockFetchJson(
        fetchMock,
        { error: { message: "Bad request payload" } },
        400,
      );

      const client = createClient(TOKEN);
      const error = await client.get("/servers").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HetznerApiError);
      const apiErr = error as InstanceType<typeof HetznerApiError>;
      expect(apiErr.status).toBe(400);
      expect(apiErr.code).toBe("unknown");
      expect(apiErr.message).toBe("Bad request payload");
    });

    it("falls back to HTTP status message when error JSON omits message", async () => {
      mockFetchJson(fetchMock, { error: { code: "bad_request" } }, 400);

      const client = createClient(TOKEN);
      const error = await client.get("/servers").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HetznerApiError);
      const apiErr = error as InstanceType<typeof HetznerApiError>;
      expect(apiErr.status).toBe(400);
      expect(apiErr.code).toBe("bad_request");
      expect(apiErr.message).toBe("HTTP 400");
    });
  });

  // -------------------------------------------------------------------------
  // 5. 429 retries with exponential backoff (fake timers)
  // -------------------------------------------------------------------------
  describe("429 rate-limit retry with backoff", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries on 429 with exponential backoff and succeeds", async () => {
      const successPayload = { servers: [] };

      // First two calls → 429, third call → success
      mockFetchSequence(fetchMock, [
        { body: { error: { code: "rate_limit", message: "Rate limit exceeded" } }, status: 429 },
        { body: { error: { code: "rate_limit", message: "Rate limit exceeded" } }, status: 429 },
        { body: successPayload },
      ]);

      const client = createClient(TOKEN);
      const promise = client.get("/servers");

      // Attempt 0 fires immediately → 429 → schedules 1000ms delay
      await vi.advanceTimersByTimeAsync(1000);

      // Attempt 1 fires → 429 → schedules 2000ms delay
      await vi.advanceTimersByTimeAsync(2000);

      // Attempt 2 fires → 200 success
      const result = await promise;

      expect(result).toEqual(successPayload);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // 6. 5xx retry exhaustion throws after max retries
  // -------------------------------------------------------------------------
  describe("5xx retry exhaustion", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("throws HetznerApiError after exhausting all retries on 500", async () => {
      const errBody = { error: { code: "server_error", message: "Internal Server Error" } };

      // 4 calls total: initial + 3 retries, all return 500
      mockFetchSequence(
        fetchMock,
        Array(4).fill({ body: errBody, status: 500 }),
      );

      const client = createClient(TOKEN);
      // Attach .catch immediately to prevent unhandled rejection
      const promise = client.get("/servers").catch((e: unknown) => e);

      // Attempt 0 → 500 → 1000ms backoff
      await vi.advanceTimersByTimeAsync(1000);
      // Attempt 1 → 500 → 2000ms backoff
      await vi.advanceTimersByTimeAsync(2000);
      // Attempt 2 → 500 → 4000ms backoff
      await vi.advanceTimersByTimeAsync(4000);
      // Attempt 3 → 500 → exhausted, throws

      const error = await promise;
      expect(error).toBeInstanceOf(HetznerApiError);
      const apiErr = error as InstanceType<typeof HetznerApiError>;
      expect(apiErr.status).toBe(500);
      expect(apiErr.code).toBe("server_error");
      expect(apiErr.message).toBe("Internal Server Error");

      // initial attempt + MAX_RETRIES (3) = 4 total calls
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  // -------------------------------------------------------------------------
  // 7. `api` getter returns HetznerAPI instance from mocked hetzner-ts
  // -------------------------------------------------------------------------
  describe("api getter", () => {
    it("returns HetznerAPI instance constructed with the token", () => {
      const fakeInstance = createMockHetznerAPI();
      MockHetznerAPICtor.mockImplementation(function () {
        return fakeInstance;
      });

      const client = createClient(TOKEN);

      expect(client.api).toBe(fakeInstance);
      expect(MockHetznerAPICtor).toHaveBeenCalledOnce();
      expect(MockHetznerAPICtor).toHaveBeenCalledWith(TOKEN);
    });
  });
});
