import { describe, expect, it } from "vitest";

import { compileFragment } from "../src/deploy/haproxyCompiler";
import type { HaproxyFragment } from "../src/deploy/haproxyTypes";

const GENERATED_HEADER = "# Generated from JSON fragment — do not edit manually";

function createFragment(overrides?: Partial<HaproxyFragment>): HaproxyFragment {
  return {
    frontend: {},
    backend: {},
    ...overrides,
  };
}

describe("compileFragment", () => {
  it("produces identical output for the same input across repeated runs", () => {
    const fragment = createFragment({
      frontend: {
        "443": {
          bind: "*:443 ssl crt /etc/haproxy/certs/",
          acl: ["host_app hdr(host) -i app.example.com"],
          use_backend: ["bk_app if host_app"],
          default_backend: "bk_fallback",
        },
      },
      backend: {
        bk_app: {
          mode: "http",
          server: ["app_1 127.0.0.1:8080 check"],
        },
      },
    });

    const first = compileFragment(fragment);
    const second = compileFragment(fragment);

    expect(first).toBe(second);
  });

  it("includes the generated header by default and omits it when disabled", () => {
    const fragment = createFragment({
      frontend: {
        "80": {
          bind: "*:80",
          acl: [],
          use_backend: [],
        },
      },
    });

    const withHeader = compileFragment(fragment);
    const withoutHeader = compileFragment(fragment, { addHeader: false });

    expect(withHeader).toContain(GENERATED_HEADER);
    expect(withHeader.startsWith(`${GENERATED_HEADER}\nfrontend ft_80\n`)).toBe(true);
    expect(withoutHeader).not.toContain(GENERATED_HEADER);
    expect(withoutHeader).toBe("frontend ft_80\n  bind *:80\n");
  });

  it("renders frontend blocks with bind, ordered acl/use_backend directives, and default_backend", () => {
    const fragment = createFragment({
      frontend: {
        "443": {
          bind: "*:443 ssl crt /etc/haproxy/certs/",
          acl: [
            "host_app hdr(host) -i app.example.com",
            "path_api path_beg /api",
          ],
          use_backend: [
            "bk_app_api if host_app path_api",
            "bk_app if host_app",
          ],
          default_backend: "bk_fallback",
        },
      },
    });

    const output = compileFragment(fragment, { addHeader: false });

    expect(output).toContain("frontend ft_443");
    expect(output).toContain("\n  bind *:443 ssl crt /etc/haproxy/certs/\n");
    expect(output).toContain("  default_backend bk_fallback\n");

    const aclHostIndex = output.indexOf("  acl host_app hdr(host) -i app.example.com");
    const aclPathIndex = output.indexOf("  acl path_api path_beg /api");
    const useBackendApiIndex = output.indexOf("  use_backend bk_app_api if host_app path_api");
    const useBackendAppIndex = output.indexOf("  use_backend bk_app if host_app");

    expect(aclHostIndex).toBeGreaterThan(-1);
    expect(aclPathIndex).toBeGreaterThan(aclHostIndex);
    expect(useBackendApiIndex).toBeGreaterThan(aclPathIndex);
    expect(useBackendAppIndex).toBeGreaterThan(useBackendApiIndex);
  });

  it("sorts multiple frontend blocks lexicographically by port key", () => {
    const fragment = createFragment({
      frontend: {
        "80": { bind: "*:80", acl: [], use_backend: [] },
        "1000": { bind: "*:1000", acl: [], use_backend: [] },
        "443": { bind: "*:443", acl: [], use_backend: [] },
      },
    });

    const output = compileFragment(fragment, { addHeader: false });

    const firstIndex = output.indexOf("frontend ft_1000");
    const secondIndex = output.indexOf("frontend ft_443");
    const thirdIndex = output.indexOf("frontend ft_80");

    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(thirdIndex).toBeGreaterThan(secondIndex);
  });

  it("renders backend blocks with mode and indented server lines", () => {
    const fragment = createFragment({
      backend: {
        bk_app: {
          mode: "http",
          server: [
            "app_1 127.0.0.1:8080 check",
            "app_2 127.0.0.1:8081 check backup",
          ],
        },
      },
    });

    const output = compileFragment(fragment, { addHeader: false });

    expect(output).toContain("backend bk_app\n  mode http\n");
    expect(output).toContain("  server app_1 127.0.0.1:8080 check\n");
    expect(output).toContain("  server app_2 127.0.0.1:8081 check backup\n");
  });

  it("sorts multiple backend blocks lexicographically by backend name", () => {
    const fragment = createFragment({
      backend: {
        bk_zeta: { mode: "http", server: ["zeta 127.0.0.1:9002 check"] },
        bk_alpha: { mode: "http", server: ["alpha 127.0.0.1:9000 check"] },
        bk_middle: { mode: "http", server: ["middle 127.0.0.1:9001 check"] },
      },
    });

    const output = compileFragment(fragment, { addHeader: false });

    const alphaIndex = output.indexOf("backend bk_alpha");
    const middleIndex = output.indexOf("backend bk_middle");
    const zetaIndex = output.indexOf("backend bk_zeta");

    expect(alphaIndex).toBeGreaterThan(-1);
    expect(middleIndex).toBeGreaterThan(alphaIndex);
    expect(zetaIndex).toBeGreaterThan(middleIndex);
  });

  it("separates top-level blocks with a blank line and ends output with a trailing newline", () => {
    const fragment = createFragment({
      frontend: {
        "80": {
          bind: "*:80",
          acl: [],
          use_backend: [],
        },
      },
      backend: {
        bk_app: {
          mode: "http",
          server: ["app_1 127.0.0.1:8080 check"],
        },
      },
    });

    const output = compileFragment(fragment, { addHeader: false });

    expect(output).toContain("  bind *:80\n\nbackend bk_app");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("omits acl and use_backend lines when their arrays are empty", () => {
    const fragment = createFragment({
      frontend: {
        "8080": {
          bind: "127.0.0.1:8080",
          acl: [],
          use_backend: [],
        },
      },
    });

    const output = compileFragment(fragment, { addHeader: false });

    expect(output).toBe("frontend ft_8080\n  bind 127.0.0.1:8080\n");
    expect(output).not.toMatch(/\n  acl /);
    expect(output).not.toMatch(/\n  use_backend /);
  });
});
