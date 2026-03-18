import { describe, it, expect } from "vitest";

import {
  normalizeRoute,
  validateFragment,
  TEMPLATE_TOKEN_RE,
  type GeneratorInputs,
  type GeneratorResult,
  type LocalCompileOptions,
  type HaproxyFragment,
  type NormalizedRoute,
  type FragmentValidationError,
} from "../src/deploy/haproxyTypes";

/* ------------------------------------------------------------------ */
/*  exported type smoke tests                                         */
/* ------------------------------------------------------------------ */

describe("exported generator and compile option types", () => {
  it("supports GeneratorInputs structural usage", () => {
    const inputs: GeneratorInputs = {
      serviceName: "app",
      bindPort: 443,
      backendAddress: "127.0.0.1",
      backendPort: 8080,
      domain: "app.example.com",
      certbot: true,
      certbotPort: 8888,
    };

    expect(inputs.serviceName).toBe("app");
    expect(inputs.bindPort).toBe(443);
  });

  it("supports GeneratorResult structural usage", () => {
    const fragment: HaproxyFragment = {
      frontend: {
        "443": {
          bind: "*:443 ssl crt /etc/haproxy/certs/",
          acl: ["host_app hdr(host) -i app.example.com"],
          use_backend: ["bk_app if host_app"],
        },
      },
      backend: {
        bk_app: {
          mode: "http",
          server: ["app_1 127.0.0.1:8080 check"],
        },
      },
    };

    const result: GeneratorResult = {
      fragment,
      certbotFragment: {
        frontend: {
          "80": {
            bind: "*:80",
            acl: ["acme_challenge path_beg /.well-known/acme-challenge/"],
            use_backend: ["bk_certbot if acme_challenge"],
          },
        },
        backend: {
          bk_certbot: {
            mode: "http",
            server: ["certbot 127.0.0.1:8888 check"],
          },
        },
      },
    };

    expect(result.fragment).toBe(fragment);
    expect(result.certbotFragment?.backend.bk_certbot.mode).toBe("http");
  });

  it("supports LocalCompileOptions structural usage", () => {
    const options: LocalCompileOptions = { addHeader: true };

    expect(options.addHeader).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  TEMPLATE_TOKEN_RE                                                 */
/* ------------------------------------------------------------------ */

describe("TEMPLATE_TOKEN_RE", () => {
  it("matches Mustache-style tokens", () => {
    expect(TEMPLATE_TOKEN_RE.test("{{service}}")).toBe(true);
    expect(TEMPLATE_TOKEN_RE.test("prefix {{foo}} suffix")).toBe(true);
    expect(TEMPLATE_TOKEN_RE.test("{{a_b-c}}")).toBe(true);
  });

  it("does not match non-template strings", () => {
    expect(TEMPLATE_TOKEN_RE.test("no tokens here")).toBe(false);
    expect(TEMPLATE_TOKEN_RE.test("{single}")).toBe(false);
    expect(TEMPLATE_TOKEN_RE.test("")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  normalizeRoute                                                    */
/* ------------------------------------------------------------------ */

describe("normalizeRoute", () => {
  describe("catch-all routes", () => {
    it.each([
      ["", "empty string"],
      ["/*", "wildcard path"],
      ["*", "bare asterisk"],
      ["  ", "whitespace only"],
      ["  /* ", "wildcard with whitespace"],
    ])('returns catch-all for %j (%s)', (input: string) => {
      const result = normalizeRoute(input);
      expect(result).toEqual<NormalizedRoute>({
        kind: "catch-all",
        host: undefined,
        path: undefined,
        isPathPrefix: false,
      });
    });
  });

  describe("scheme stripping", () => {
    it("strips https://", () => {
      const result = normalizeRoute("https://example.com/v2");
      expect(result.host).toBe("example.com");
      expect(result.path).toBe("/v2");
    });

    it("strips http://", () => {
      const result = normalizeRoute("http://example.com");
      expect(result.kind).toBe("host-only");
      expect(result.host).toBe("example.com");
    });

    it("strips scheme and lowercases host", () => {
      const result = normalizeRoute("https://Api.Example.COM/v2");
      expect(result).toEqual<NormalizedRoute>({
        kind: "host-path",
        host: "api.example.com",
        path: "/v2",
        isPathPrefix: false,
      });
    });
  });

  describe("host-only routes", () => {
    it("detects host without path", () => {
      const result = normalizeRoute("example.com");
      expect(result).toEqual<NormalizedRoute>({
        kind: "host-only",
        host: "example.com",
        path: undefined,
        isPathPrefix: false,
      });
    });

    it("treats trailing slash as host-only", () => {
      const result = normalizeRoute("example.com/");
      expect(result).toEqual<NormalizedRoute>({
        kind: "host-only",
        host: "example.com",
        path: undefined,
        isPathPrefix: false,
      });
    });

    it("trims whitespace before processing", () => {
      const result = normalizeRoute("  example.com  ");
      expect(result.kind).toBe("host-only");
      expect(result.host).toBe("example.com");
    });

    it("lowercases host portion", () => {
      const result = normalizeRoute("EXAMPLE.COM");
      expect(result.host).toBe("example.com");
    });
  });

  describe("host-path routes", () => {
    it("splits host and path", () => {
      const result = normalizeRoute("example.com/api");
      expect(result).toEqual<NormalizedRoute>({
        kind: "host-path",
        host: "example.com",
        path: "/api",
        isPathPrefix: false,
      });
    });

    it("trims trailing slashes from path", () => {
      const result = normalizeRoute("example.com/api/");
      expect(result.path).toBe("/api");
    });

    it("trims multiple trailing slashes", () => {
      const result = normalizeRoute("example.com/api///");
      expect(result.path).toBe("/api");
    });

    it("preserves path case", () => {
      const result = normalizeRoute("EXAMPLE.COM/CaseSensitive");
      expect(result.host).toBe("example.com");
      expect(result.path).toBe("/CaseSensitive");
    });

    it("handles deep paths", () => {
      const result = normalizeRoute("example.com/A/B/C");
      expect(result.path).toBe("/A/B/C");
    });
  });

  describe("glob suffix handling", () => {
    it("detects glob suffix and sets isPathPrefix", () => {
      const result = normalizeRoute("example.com/hello{,/**}");
      expect(result).toEqual<NormalizedRoute>({
        kind: "host-path",
        host: "example.com",
        path: "/hello",
        isPathPrefix: true,
      });
    });

    it("handles glob with scheme", () => {
      const result = normalizeRoute("https://Example.COM/api{,/**}");
      expect(result).toEqual<NormalizedRoute>({
        kind: "host-path",
        host: "example.com",
        path: "/api",
        isPathPrefix: true,
      });
    });
  });

  describe("full spec examples", () => {
    it("minimal catch-all (omitted route)", () => {
      expect(normalizeRoute("")).toEqual<NormalizedRoute>({
        kind: "catch-all",
        host: undefined,
        path: undefined,
        isPathPrefix: false,
      });
    });

    it("explicit host+path on port 80", () => {
      const result = normalizeRoute("www.my.server/hello{,/**}");
      expect(result).toEqual<NormalizedRoute>({
        kind: "host-path",
        host: "www.my.server",
        path: "/hello",
        isPathPrefix: true,
      });
    });

    it("full URL-style route", () => {
      const result = normalizeRoute("https://Api.Example.COM/v2");
      expect(result).toEqual<NormalizedRoute>({
        kind: "host-path",
        host: "api.example.com",
        path: "/v2",
        isPathPrefix: false,
      });
    });
  });
});

/* ------------------------------------------------------------------ */
/*  validateFragment                                                  */
/* ------------------------------------------------------------------ */

describe("validateFragment", () => {
  /** Helper to build a valid fragment for positive tests. */
  function validFragment(): HaproxyFragment {
    return {
      frontend: {
        "443": {
          bind: "*:443 ssl crt /etc/haproxy/certs/",
          acl: ["host_my-app hdr(host) -i my-app.example.com"],
          use_backend: ["bk_my-app if host_my-app"],
        },
      },
      backend: {
        "bk_my-app": {
          mode: "http",
          server: ["my-app_1 127.0.0.1:8080 check"],
        },
      },
    };
  }

  describe("valid fragments", () => {
    it("returns empty array for a valid fragment", () => {
      expect(validateFragment(validFragment())).toEqual([]);
    });

    it("accepts a fragment with multiple ports and backends", () => {
      const frag: HaproxyFragment = {
        frontend: {
          "80": {
            bind: "*:80",
            acl: ["acme_challenge path_beg /.well-known/acme-challenge/"],
            use_backend: ["bk_certbot if acme_challenge"],
          },
          "443": {
            bind: "*:443 ssl crt /etc/haproxy/certs/",
            acl: ["host_app hdr(host) -i app.example.com"],
            use_backend: ["bk_app if host_app"],
          },
        },
        backend: {
          bk_certbot: { mode: "http", server: ["certbot 127.0.0.1:8888 check"] },
          bk_app: { mode: "http", server: ["app_1 127.0.0.1:3000 check"] },
        },
      };
      expect(validateFragment(frag)).toEqual([]);
    });

    it("accepts empty backend object (no backends)", () => {
      const frag = validFragment();
      frag.backend = {};
      // empty backend record is structurally valid
      expect(validateFragment(frag)).toEqual([]);
    });

    it("accepts optional default_backend field", () => {
      const frag = validFragment();
      frag.frontend["443"].default_backend = "bk_fallback";
      expect(validateFragment(frag)).toEqual([]);
    });
  });

  describe("V1: top-level shape", () => {
    it.each([
      [null, "null"],
      [undefined, "undefined"],
      [42, "number"],
      ["string", "string"],
      [true, "boolean"],
      [[], "array"],
    ])("rejects %s (%s)", (input, _label) => {
      void _label;
      const errors = validateFragment(input);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual<FragmentValidationError>({
        path: "",
        message: "Fragment must be a non-null object",
      });
    });
  });

  describe("V2: frontend missing or invalid", () => {
    it("reports missing frontend", () => {
      const errors = validateFragment({ backend: {} });
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "frontend",
        message: "'frontend' must be a non-null object",
      });
    });

    it("reports frontend as array", () => {
      const errors = validateFragment({ frontend: [], backend: {} });
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "frontend",
        message: "'frontend' must be a non-null object",
      });
    });

    it("reports null frontend", () => {
      const errors = validateFragment({ frontend: null, backend: {} });
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "frontend",
        message: "'frontend' must be a non-null object",
      });
    });
  });

  describe("V3: frontend empty", () => {
    it("reports empty frontend object", () => {
      const errors = validateFragment({ frontend: {}, backend: {} });
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "frontend",
        message: "'frontend' must contain at least one port entry",
      });
    });
  });

  describe("V4: bind must be a string", () => {
    it("reports non-string bind", () => {
      const frag = validFragment();
      (frag.frontend["443"] as unknown as Record<string, unknown>).bind = 443;
      const errors = validateFragment(frag);
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "frontend.443.bind",
        message: "'bind' must be a string",
      });
    });

    it("reports missing bind", () => {
      const frag = validFragment();
      delete (frag.frontend["443"] as unknown as Record<string, unknown>).bind;
      const errors = validateFragment(frag);
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "frontend.443.bind",
        message: "'bind' must be a string",
      });
    });
  });

  describe("V5: acl must be string[]", () => {
    it("reports non-array acl", () => {
      const frag = validFragment();
      (frag.frontend["443"] as unknown as Record<string, unknown>).acl = "not-array";
      const errors = validateFragment(frag);
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "frontend.443.acl",
        message: "'acl' must be an array of strings",
      });
    });

    it("reports acl containing non-strings", () => {
      const frag = validFragment();
      (frag.frontend["443"] as unknown as Record<string, unknown>).acl = [42];
      const errors = validateFragment(frag);
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "frontend.443.acl",
        message: "'acl' must be an array of strings",
      });
    });
  });

  describe("V6: use_backend must be string[]", () => {
    it("reports non-array use_backend", () => {
      const frag = validFragment();
      (frag.frontend["443"] as unknown as Record<string, unknown>).use_backend = null;
      const errors = validateFragment(frag);
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "frontend.443.use_backend",
        message: "'use_backend' must be an array of strings",
      });
    });
  });

  describe("V7: backend missing or invalid", () => {
    it("reports missing backend", () => {
      const errors = validateFragment({
        frontend: {
          "80": { bind: "*:80", acl: [], use_backend: [] },
        },
      });
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "backend",
        message: "'backend' must be a non-null object",
      });
    });
  });

  describe("V8: backend mode must be a string", () => {
    it("reports non-string mode", () => {
      const frag = validFragment();
      (frag.backend["bk_my-app"] as unknown as Record<string, unknown>).mode = 123;
      const errors = validateFragment(frag);
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "backend.bk_my-app.mode",
        message: "'mode' must be a string",
      });
    });
  });

  describe("V9: backend server must be string[]", () => {
    it("reports non-array server", () => {
      const frag = validFragment();
      (frag.backend["bk_my-app"] as unknown as Record<string, unknown>).server = "single";
      const errors = validateFragment(frag);
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "backend.bk_my-app.server",
        message: "'server' must be an array of strings",
      });
    });
  });

  describe("V10: template token detection", () => {
    it("detects template token in bind", () => {
      const frag = validFragment();
      frag.frontend["443"].bind = "*:443 {{ssl_opts}}";
      const errors = validateFragment(frag);
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "frontend.443.bind",
        message: "Residual template token found: '{{ssl_opts}}'",
      });
    });

    it("detects template token in acl", () => {
      const frag = validFragment();
      frag.frontend["443"].acl = ["host_{{service}} hdr(host) -i example.com"];
      const errors = validateFragment(frag);
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "frontend.443.acl[0]",
        message: "Residual template token found: '{{service}}'",
      });
    });

    it("detects template token in use_backend", () => {
      const frag = validFragment();
      frag.frontend["443"].use_backend = ["bk_{{service}} if host_app"];
      const errors = validateFragment(frag);
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "frontend.443.use_backend[0]",
        message: "Residual template token found: '{{service}}'",
      });
    });

    it("detects template token in default_backend", () => {
      const frag = validFragment();
      frag.frontend["443"].default_backend = "bk_{{service}}";
      const errors = validateFragment(frag);
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "frontend.443.default_backend",
        message: "Residual template token found: '{{service}}'",
      });
    });

    it("detects template token in backend mode", () => {
      const frag = validFragment();
      frag.backend["bk_my-app"].mode = "{{mode}}";
      const errors = validateFragment(frag);
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "backend.bk_my-app.mode",
        message: "Residual template token found: '{{mode}}'",
      });
    });

    it("detects template token in backend server", () => {
      const frag = validFragment();
      frag.backend["bk_my-app"].server = ["{{service}}_1 127.0.0.1:8080 check"];
      const errors = validateFragment(frag);
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "backend.bk_my-app.server[0]",
        message: "Residual template token found: '{{service}}'",
      });
    });
  });

  describe("collect-all error pattern", () => {
    it("returns multiple errors at once", () => {
      const broken = {
        frontend: {
          "80": {
            bind: 80,        // V4 error
            acl: "not-array", // V5 error
            use_backend: null,// V6 error
          },
        },
        backend: {
          bk_bad: {
            mode: 123,        // V8 error
            server: "single", // V9 error
          },
        },
      };
      const errors = validateFragment(broken);
      expect(errors.length).toBeGreaterThanOrEqual(5);
      const paths = errors.map((e) => e.path);
      expect(paths).toContain("frontend.80.bind");
      expect(paths).toContain("frontend.80.acl");
      expect(paths).toContain("frontend.80.use_backend");
      expect(paths).toContain("backend.bk_bad.mode");
      expect(paths).toContain("backend.bk_bad.server");
    });

    it("reports both frontend and backend errors simultaneously", () => {
      const errors = validateFragment({});
      expect(errors.length).toBe(2);
      const paths = errors.map((e) => e.path);
      expect(paths).toContain("frontend");
      expect(paths).toContain("backend");
    });
  });

  describe("frontend entry is not an object", () => {
    it("reports non-object frontend entry", () => {
      const errors = validateFragment({
        frontend: { "80": "not-an-object" },
        backend: {},
      });
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "frontend.80",
        message: "frontend entry must be a non-null object",
      });
    });
  });

  describe("backend entry is not an object", () => {
    it("reports non-object backend entry", () => {
      const errors = validateFragment({
        frontend: { "80": { bind: "*:80", acl: [], use_backend: [] } },
        backend: { bk_bad: null },
      });
      expect(errors).toContainEqual<FragmentValidationError>({
        path: "backend.bk_bad",
        message: "backend entry must be a non-null object",
      });
    });
  });
});
