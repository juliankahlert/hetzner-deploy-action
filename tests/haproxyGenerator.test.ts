import { describe, expect, it } from "vitest";

import { generateFragment, resolveServiceTokens } from "../src/deploy/haproxyGenerator";
import { validateFragment, type GeneratorInputs, type HaproxyFragment } from "../src/deploy/haproxyTypes";

function createInputs(overrides: Partial<GeneratorInputs> = {}): GeneratorInputs {
  return {
    serviceName: "myapp",
    bindPort: 443,
    backendAddress: "127.0.0.1",
    backendPort: 3000,
    domain: "app.example.com",
    ...overrides,
  };
}

describe("resolveServiceTokens", () => {
  it("replaces the service token", () => {
    expect(resolveServiceTokens("bk_{{service}}", "myapp")).toBe("bk_myapp");
  });

  it("throws when a token remains unresolved", () => {
    expect(() => resolveServiceTokens("bk_{{service}}_{{other}}", "myapp")).toThrow(
      "[HAPROXY_GENERATE] unresolved template token '{{other}}' in value: bk_{{service}}_{{other}}",
    );
  });
});

describe("generateFragment", () => {
  it("generates the minimal host-only mapping with expected naming conventions", () => {
    const { fragment, certbotFragment } = generateFragment(createInputs());

    expect(certbotFragment).toBeUndefined();
    expect(fragment).toEqual<HaproxyFragment>({
      frontend: {
        "443": {
          bind: "*:443",
          acl: ["host_myapp hdr(host) -i app.example.com"],
          use_backend: ["bk_myapp if host_myapp"],
        },
      },
      backend: {
        bk_myapp: {
          mode: "http",
          server: ["myapp_1 127.0.0.1:3000 check"],
        },
      },
    });
  });

  it("defaults mode to http and includes a health check when undefined", () => {
    const { fragment } = generateFragment(createInputs({ healthCheck: undefined }));

    expect(fragment.backend.bk_myapp.mode).toBe("http");
    expect(fragment.backend.bk_myapp.server).toEqual(["myapp_1 127.0.0.1:3000 check"]);
  });

  it("appends ssl certificate options to the bind line", () => {
    const { fragment } = generateFragment(
      createInputs({ bindPort: 8443, sslCertPath: "/etc/haproxy/certs/site.pem" }),
    );

    expect(fragment.frontend["8443"].bind).toBe("*:8443 ssl crt /etc/haproxy/certs/site.pem");
  });

  it("creates host ACL and use_backend rules for host-only domains", () => {
    const { fragment } = generateFragment(createInputs({ domain: "www.example.com" }));

    expect(fragment.frontend["443"].acl).toEqual(["host_myapp hdr(host) -i www.example.com"]);
    expect(fragment.frontend["443"].use_backend).toEqual(["bk_myapp if host_myapp"]);
    expect(fragment.frontend["443"].default_backend).toBeUndefined();
  });

  it("uses default_backend for an empty domain catch-all route", () => {
    const { fragment } = generateFragment(createInputs({ domain: "" }));

    expect(fragment.frontend["443"]).toEqual({
      bind: "*:443",
      acl: [],
      use_backend: [],
      default_backend: "bk_myapp",
    });
  });

  it("produces a primary fragment that passes validation", () => {
    const { fragment } = generateFragment(createInputs({ domain: "api.example.com/v1" }));

    expect(validateFragment(fragment)).toEqual([]);
  });

  it("throws a prefixed error when serviceName leaves unresolved tokens", () => {
    expect(() => generateFragment(createInputs({ serviceName: "{{missing}}" }))).toThrow(
      /\[HAPROXY_GENERATE\]/,
    );
  });

  it("returns a separate certbot fragment when certbot is enabled on a non-80 bind port", () => {
    const result = generateFragment(createInputs({ certbot: true, bindPort: 443, certbotPort: 9999 }));

    expect(result.fragment.frontend["443"]).toEqual({
      bind: "*:443",
      acl: ["host_myapp hdr(host) -i app.example.com"],
      use_backend: ["bk_myapp if host_myapp"],
    });
    expect(result.certbotFragment).toEqual<HaproxyFragment>({
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
          server: ["certbot 127.0.0.1:9999 check"],
        },
      },
    });
  });

  it("merges certbot rules ahead of service rules on port 80", () => {
    const result = generateFragment(
      createInputs({ bindPort: 80, certbot: true, domain: "app.example.com/api{,/**}" }),
    );

    expect(result.certbotFragment).toBeUndefined();
    expect(result.fragment.frontend["80"]).toEqual({
      bind: "*:80",
      acl: [
        "acme_challenge path_beg /.well-known/acme-challenge/",
        "host_myapp hdr(host) -i app.example.com",
      ],
      use_backend: ["bk_certbot if acme_challenge", "bk_myapp if host_myapp { path_beg -i /api }"],
    });
    expect(result.fragment.backend).toEqual({
      bk_myapp: {
        mode: "http",
        server: ["myapp_1 127.0.0.1:3000 check"],
      },
      bk_certbot: {
        mode: "http",
        server: ["certbot 127.0.0.1:8888 check"],
      },
    });
  });
});
