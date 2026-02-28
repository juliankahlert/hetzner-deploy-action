import * as core from "@actions/core";
import { HetznerAPI } from "hetzner-ts";

const BASE_URL = "https://api.hetzner.cloud/v1";
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export class HetznerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HetznerApiError";
  }
}

export interface HetznerClient {
  /** Typed hetzner-ts SDK instance for resource-specific APIs. */
  readonly api: HetznerAPI;
  /** Low-level GET with retry & exponential backoff. */
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
  /** Low-level POST with retry & exponential backoff. */
  post<T>(path: string, body: unknown): Promise<T>;
}

async function request<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, string>,
): Promise<T> {
  let url = `${BASE_URL}${path}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += `?${qs}`;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (resp.ok) {
      if (resp.status === 204) return undefined as T;
      return (await resp.json()) as T;
    }

    const errBody = (await resp.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const error = (errBody.error ?? {}) as Record<string, unknown>;
    const code = String(error.code ?? "unknown");
    const message = String(error.message ?? `HTTP ${resp.status}`);

    // Only retry on 429 (rate-limit) and 5xx (server errors)
    if (resp.status !== 429 && resp.status < 500) {
      throw new HetznerApiError(resp.status, code, message);
    }

    if (attempt < MAX_RETRIES) {
      const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      core.warning(
        `Hetzner API ${resp.status} on ${method} ${path}, retrying in ${delay}ms…`,
      );
      await new Promise((r) => setTimeout(r, delay));
    } else {
      throw new HetznerApiError(resp.status, code, message);
    }
  }

  throw new Error("Unexpected end of retry loop");
}

/** Create an authenticated Hetzner Cloud client. */
export function createClient(token: string): HetznerClient {
  return {
    api: new HetznerAPI(token),
    get<T>(path: string, params?: Record<string, string>): Promise<T> {
      return request<T>(token, "GET", path, undefined, params);
    },
    post<T>(path: string, body: unknown): Promise<T> {
      return request<T>(token, "POST", path, body);
    },
  };
}
