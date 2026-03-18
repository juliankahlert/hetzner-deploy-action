/* ------------------------------------------------------------------ */
/*  HAProxy JSON Fragment Schema, Route Normalizer & Validator        */
/*                                                                    */
/*  This module defines the type contract consumed by the fragment    */
/*  generator (rWP-2), the remote compiler (rWP-3), and the frag.d   */
/*  management layer (rWP-4).  It also provides the route normalizer  */
/*  and a collect-all fragment validator.                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Fragment schema interfaces                                        */
/* ------------------------------------------------------------------ */

/** A single HAProxy frontend block, keyed by port in the parent record. */
export interface HaproxyFrontendEntry {
  /** Bind directive, e.g. `"*:443 ssl crt /etc/haproxy/certs/"`. */
  bind: string;
  /** ACL definitions, e.g. `["host_example hdr(host) -i example.com"]`. */
  acl: string[];
  /** Backend routing rules, e.g. `["bk_example if host_example"]`. */
  use_backend: string[];
  /** Default backend for unmatched requests (catch-all routes). */
  default_backend?: string;
}

/** A single HAProxy backend block. */
export interface HaproxyBackendEntry {
  /** HAProxy mode, typically `"http"`. */
  mode: string;
  /** Server lines, e.g. `["app 127.0.0.1:8080 check"]`. */
  server: string[];
}

/**
 * Complete HAProxy JSON fragment — the wire format between the
 * fragment generator and the config compiler.
 *
 * Frontends are keyed by port number (as string); backends are keyed
 * by backend name.
 */
export interface HaproxyFragment {
  /** Frontend definitions keyed by port number (string). */
  frontend: Record<string, HaproxyFrontendEntry>;
  /** Backend definitions keyed by backend name. */
  backend: Record<string, HaproxyBackendEntry>;
}

/** Inputs consumed by the HAProxy fragment generator. */
export interface GeneratorInputs {
  serviceName: string;
  bindPort: number;
  backendAddress: string;
  backendPort: number;
  mode?: string;
  balanceAlgorithm?: string;
  sslCertPath?: string;
  healthCheck?: string;
  domain?: string;
  certbot?: boolean;
  certbotPort?: number;
}

/** Result emitted by the HAProxy fragment generator. */
export interface GeneratorResult {
  fragment: HaproxyFragment;
  certbotFragment?: HaproxyFragment;
}

/** Local compile-time options for HAProxy fragment rendering. */
export interface LocalCompileOptions {
  addHeader?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Route normalizer types                                            */
/* ------------------------------------------------------------------ */

/** Classification of a normalized route for ACL generation strategy. */
export type RouteKind = "catch-all" | "host-only" | "host-path" | "path-only";

/**
 * Structured result of route normalization.
 *
 * All fields are always present (not optional) — callers can
 * destructure without guarding for property existence, using `kind`
 * as the sole branching discriminant.
 */
export interface NormalizedRoute {
  /** Determines the ACL generation strategy. */
  kind: RouteKind;
  /** Lowercase hostname. Present when kind is `"host-only"` or `"host-path"`. */
  host: string | undefined;
  /** Path component (no trailing slash). Present when kind is `"host-path"` or `"path-only"`. */
  path: string | undefined;
  /**
   * `true` when the path uses prefix-match semantics (derived from
   * glob `{,/**}` in the original route).  Only meaningful when kind
   * is `"host-path"` or `"path-only"`.
   */
  isPathPrefix: boolean;
}

/* ------------------------------------------------------------------ */
/*  Validation types                                                  */
/* ------------------------------------------------------------------ */

/** A single validation error with JSON-path location. */
export interface FragmentValidationError {
  /** Dot-delimited path to the offending element, e.g. `"frontend.443.bind"`. */
  path: string;
  /** Human-readable error description. */
  message: string;
}

/* ------------------------------------------------------------------ */
/*  Shared constants                                                  */
/* ------------------------------------------------------------------ */

/**
 * Regex matching residual Mustache-style template tokens like
 * `{{service}}`.  Used by both the validator (AC-G9) and the
 * generator to detect un-substituted placeholders.
 */
export const TEMPLATE_TOKEN_RE: RegExp = /\{\{[^}]+\}\}/;

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                  */
/* ------------------------------------------------------------------ */

function isNonNullObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string");
}

function checkTemplateTokens(
  value: string,
  path: string,
  errors: FragmentValidationError[],
): void {
  const match = TEMPLATE_TOKEN_RE.exec(value);
  if (match) {
    errors.push({
      path,
      message: `Residual template token found: '${match[0]}'`,
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Route normalizer                                                  */
/* ------------------------------------------------------------------ */

/** Glob suffix that maps to path-prefix ACL semantics. */
const GLOB_SUFFIX = "{,/**}";

/**
 * Normalize a raw route string into structured host/path components.
 *
 * Rules (from the HAProxy overview spec):
 *   1. Strip scheme (`http://`, `https://`)
 *   2. Lowercase host portion only (path case is preserved)
 *   3. Trim trailing slashes (unless path is exactly `/`)
 *   4. Detect host-only vs host+path vs path-only
 *   5. Handle glob `{,/**}` → path-prefix semantics
 *   6. Default `/*` or empty → catch-all
 */
export function normalizeRoute(raw: string): NormalizedRoute {
  let s = raw.trim();

  // Catch-all detection (before any other processing)
  if (s === "" || s === "/*" || s === "*") {
    return { kind: "catch-all", host: undefined, path: undefined, isPathPrefix: false };
  }

  // Strip scheme
  s = s.replace(/^https?:\/\//, "");

  // Detect and strip glob suffix → sets prefix flag
  let isPathPrefix = false;
  if (s.endsWith(GLOB_SUFFIX)) {
    isPathPrefix = true;
    s = s.slice(0, -GLOB_SUFFIX.length);
  }

  // Split host from path at first "/"
  const slashIdx = s.indexOf("/");
  let host: string;
  let rawPath: string | undefined;

  if (slashIdx === -1) {
    host = s;
    rawPath = undefined;
  } else {
    host = s.slice(0, slashIdx);
    rawPath = s.slice(slashIdx); // includes leading "/"
  }

  // Lowercase host only (path case preserved)
  host = host.toLowerCase();

  // No path → host-only
  if (rawPath === undefined || rawPath === "") {
    return { kind: "host-only", host, path: undefined, isPathPrefix: false };
  }

  // Trim trailing slashes (unless path is exactly "/")
  const pathResult = rawPath.replace(/\/+$/, "") || "/";

  // Path-only simplified route (`/hello`, `/hello{,/**}`, `/`) → no host ACL
  if (host === "") {
    return {
      kind: "path-only",
      host: undefined,
      path: pathResult,
      isPathPrefix,
    };
  }

  // Path reduced to just "/" → treat as host-only (no meaningful path)
  if (pathResult === "/") {
    return { kind: "host-only", host, path: undefined, isPathPrefix: false };
  }

  // Host + path
  return { kind: "host-path", host, path: pathResult, isPathPrefix };
}

/* ------------------------------------------------------------------ */
/*  Fragment validator                                                */
/* ------------------------------------------------------------------ */

function validateFrontendEntry(
  port: string,
  entry: unknown,
  errors: FragmentValidationError[],
): void {
  const prefix = `frontend.${port}`;

  if (!isNonNullObject(entry)) {
    errors.push({ path: prefix, message: "frontend entry must be a non-null object" });
    return;
  }

  // bind
  if (typeof entry.bind !== "string") {
    errors.push({ path: `${prefix}.bind`, message: "'bind' must be a string" });
  } else {
    checkTemplateTokens(entry.bind, `${prefix}.bind`, errors);
  }

  // acl
  if (!isStringArray(entry.acl)) {
    errors.push({ path: `${prefix}.acl`, message: "'acl' must be an array of strings" });
  } else {
    for (let i = 0; i < entry.acl.length; i++) {
      checkTemplateTokens(entry.acl[i], `${prefix}.acl[${i}]`, errors);
    }
  }

  // use_backend
  if (!isStringArray(entry.use_backend)) {
    errors.push({
      path: `${prefix}.use_backend`,
      message: "'use_backend' must be an array of strings",
    });
  } else {
    for (let i = 0; i < entry.use_backend.length; i++) {
      checkTemplateTokens(entry.use_backend[i], `${prefix}.use_backend[${i}]`, errors);
    }
  }

  // optional default_backend
  if ("default_backend" in entry && typeof entry.default_backend === "string") {
    checkTemplateTokens(entry.default_backend, `${prefix}.default_backend`, errors);
  }
}

function validateBackendEntry(
  name: string,
  entry: unknown,
  errors: FragmentValidationError[],
): void {
  const prefix = `backend.${name}`;

  if (!isNonNullObject(entry)) {
    errors.push({ path: prefix, message: "backend entry must be a non-null object" });
    return;
  }

  // mode
  if (typeof entry.mode !== "string") {
    errors.push({ path: `${prefix}.mode`, message: "'mode' must be a string" });
  } else {
    checkTemplateTokens(entry.mode, `${prefix}.mode`, errors);
  }

  // server
  if (!isStringArray(entry.server)) {
    errors.push({ path: `${prefix}.server`, message: "'server' must be an array of strings" });
  } else {
    for (let i = 0; i < entry.server.length; i++) {
      checkTemplateTokens(entry.server[i], `${prefix}.server[${i}]`, errors);
    }
  }
}

/**
 * Validate an HAProxy JSON fragment against the expected schema.
 *
 * Returns **all** validation errors found (collect-all pattern — does
 * not throw).  An empty array means the fragment is valid.
 */
export function validateFragment(fragment: unknown): FragmentValidationError[] {
  const errors: FragmentValidationError[] = [];

  // V1: top-level shape
  if (!isNonNullObject(fragment)) {
    errors.push({ path: "", message: "Fragment must be a non-null object" });
    return errors; // cannot proceed further
  }

  // V2 + V3: frontend
  if (!isNonNullObject(fragment.frontend)) {
    errors.push({ path: "frontend", message: "'frontend' must be a non-null object" });
  } else {
    const frontendKeys = Object.keys(fragment.frontend);
    if (frontendKeys.length === 0) {
      errors.push({
        path: "frontend",
        message: "'frontend' must contain at least one port entry",
      });
    } else {
      for (const [port, entry] of Object.entries(fragment.frontend)) {
        validateFrontendEntry(port, entry, errors);
      }
    }
  }

  // V7: backend
  if (!isNonNullObject(fragment.backend)) {
    errors.push({ path: "backend", message: "'backend' must be a non-null object" });
  } else {
    for (const [name, entry] of Object.entries(fragment.backend)) {
      validateBackendEntry(name, entry, errors);
    }
  }

  return errors;
}
