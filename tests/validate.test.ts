import { describe, it, expect, vi } from "vitest";

// Mock @actions/core before importing validate
vi.mock("@actions/core", () => ({
  info: vi.fn(),
}));

import { validateInputs, type ValidatableInputs } from "../src/validate";

/** A complete set of valid inputs used as baseline. */
const validInputs: ValidatableInputs = {
  serverName: "my-server-01",
  sshUser: "deploy",
  sourceDir: ".",
  targetDir: "/opt/app",
  serviceName: "",
  image: "ubuntu-24.04",
  serverType: "cx23",
  projectTag: "myproject",
  ipv6Only: "false",
  containerImage: "",
  containerPort: "",
  haproxyCfg: "",
  firewallEnabled: "",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function withOverride(
  overrides: Partial<ValidatableInputs>,
): ValidatableInputs {
  return { ...validInputs, ...overrides };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
describe("validateInputs — happy path", () => {
  it("passes with all valid inputs", () => {
    expect(() => validateInputs(validInputs)).not.toThrow();
  });

  it("passes with optional serviceName empty", () => {
    expect(() =>
      validateInputs(withOverride({ serviceName: "" })),
    ).not.toThrow();
  });

  it("passes with ipv6Only true", () => {
    expect(() =>
      validateInputs(withOverride({ ipv6Only: "true" })),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// serverName
// ---------------------------------------------------------------------------
describe("validateInputs — serverName", () => {
  it("accepts max-length name (63 chars)", () => {
    const name = "a" + "b".repeat(62);
    expect(() => validateInputs(withOverride({ serverName: name }))).not.toThrow();
  });

  it("accepts name starting with digit", () => {
    expect(() =>
      validateInputs(withOverride({ serverName: "1server" })),
    ).not.toThrow();
  });

  it("accepts dots, hyphens, underscores", () => {
    expect(() =>
      validateInputs(withOverride({ serverName: "my.server_name-1" })),
    ).not.toThrow();
  });

  it("rejects empty serverName", () => {
    expect(() =>
      validateInputs(withOverride({ serverName: "" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects name exceeding 63 chars", () => {
    const name = "a" + "b".repeat(63);
    expect(() =>
      validateInputs(withOverride({ serverName: name })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects shell injection in serverName", () => {
    expect(() =>
      validateInputs(withOverride({ serverName: "; rm -rf /" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects command substitution", () => {
    expect(() =>
      validateInputs(withOverride({ serverName: "$(curl evil)" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });
});

// ---------------------------------------------------------------------------
// image
// ---------------------------------------------------------------------------
describe("validateInputs — image", () => {
  it("accepts ubuntu-24.04", () => {
    expect(() =>
      validateInputs(withOverride({ image: "ubuntu-24.04" })),
    ).not.toThrow();
  });

  it("accepts debian-12", () => {
    expect(() =>
      validateInputs(withOverride({ image: "debian-12" })),
    ).not.toThrow();
  });

  it("accepts max-length image (64 chars)", () => {
    const img = "a" + "b".repeat(63);
    expect(() => validateInputs(withOverride({ image: img }))).not.toThrow();
  });

  it("rejects image starting with digit", () => {
    expect(() =>
      validateInputs(withOverride({ image: "24ubuntu" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects image exceeding 64 chars", () => {
    const img = "a" + "b".repeat(64);
    expect(() =>
      validateInputs(withOverride({ image: img })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects empty image", () => {
    expect(() =>
      validateInputs(withOverride({ image: "" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects image with spaces", () => {
    expect(() =>
      validateInputs(withOverride({ image: "ubuntu 24" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });
});

// ---------------------------------------------------------------------------
// serverType
// ---------------------------------------------------------------------------
describe("validateInputs — serverType", () => {
  it("accepts cx23", () => {
    expect(() =>
      validateInputs(withOverride({ serverType: "cx23" })),
    ).not.toThrow();
  });

  it("accepts cpx11", () => {
    expect(() =>
      validateInputs(withOverride({ serverType: "cpx11" })),
    ).not.toThrow();
  });

  it("accepts type with suffix like cx22-dedicated", () => {
    expect(() =>
      validateInputs(withOverride({ serverType: "cx22-dedicated" })),
    ).not.toThrow();
  });

  it("rejects uppercase serverType", () => {
    expect(() =>
      validateInputs(withOverride({ serverType: "CX23" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects empty serverType", () => {
    expect(() =>
      validateInputs(withOverride({ serverType: "" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects invalid format", () => {
    expect(() =>
      validateInputs(withOverride({ serverType: "server-large" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });
});

// ---------------------------------------------------------------------------
// projectTag
// ---------------------------------------------------------------------------
describe("validateInputs — projectTag", () => {
  it("accepts simple tag", () => {
    expect(() =>
      validateInputs(withOverride({ projectTag: "my-project.v2" })),
    ).not.toThrow();
  });

  it("accepts max-length tag (255 chars)", () => {
    const tag = "a" + "b".repeat(254);
    expect(() =>
      validateInputs(withOverride({ projectTag: tag })),
    ).not.toThrow();
  });

  it("rejects tag exceeding 255 chars", () => {
    const tag = "a" + "b".repeat(255);
    expect(() =>
      validateInputs(withOverride({ projectTag: tag })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects empty projectTag", () => {
    expect(() =>
      validateInputs(withOverride({ projectTag: "" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects tag starting with dot", () => {
    expect(() =>
      validateInputs(withOverride({ projectTag: ".hidden" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });
});

// ---------------------------------------------------------------------------
// ipv6Only
// ---------------------------------------------------------------------------
describe("validateInputs — ipv6Only", () => {
  it("accepts 'true'", () => {
    expect(() =>
      validateInputs(withOverride({ ipv6Only: "true" })),
    ).not.toThrow();
  });

  it("accepts 'false'", () => {
    expect(() =>
      validateInputs(withOverride({ ipv6Only: "false" })),
    ).not.toThrow();
  });

  it("rejects 'yes'", () => {
    expect(() =>
      validateInputs(withOverride({ ipv6Only: "yes" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects '1'", () => {
    expect(() =>
      validateInputs(withOverride({ ipv6Only: "1" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects 'True' (case-sensitive)", () => {
    expect(() =>
      validateInputs(withOverride({ ipv6Only: "True" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects empty ipv6Only", () => {
    expect(() =>
      validateInputs(withOverride({ ipv6Only: "" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });
});

// ---------------------------------------------------------------------------
// sshUser
// ---------------------------------------------------------------------------
describe("validateInputs — sshUser", () => {
  it("accepts root", () => {
    expect(() =>
      validateInputs(withOverride({ sshUser: "root" })),
    ).not.toThrow();
  });

  it("accepts underscore-prefixed user", () => {
    expect(() =>
      validateInputs(withOverride({ sshUser: "_deploy" })),
    ).not.toThrow();
  });

  it("rejects user starting with digit", () => {
    expect(() =>
      validateInputs(withOverride({ sshUser: "1user" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects user exceeding 32 chars", () => {
    const user = "a" + "b".repeat(32);
    expect(() =>
      validateInputs(withOverride({ sshUser: user })),
    ).toThrow(/INPUT_VALIDATION_/);
  });
});

// ---------------------------------------------------------------------------
// sourceDir
// ---------------------------------------------------------------------------
describe("validateInputs — sourceDir", () => {
  it("accepts '.'", () => {
    expect(() =>
      validateInputs(withOverride({ sourceDir: "." })),
    ).not.toThrow();
  });

  it("accepts relative path", () => {
    expect(() =>
      validateInputs(withOverride({ sourceDir: "build/output" })),
    ).not.toThrow();
  });

  it("rejects path traversal with '..'", () => {
    expect(() =>
      validateInputs(withOverride({ sourceDir: "../../etc/passwd" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects command injection", () => {
    expect(() =>
      validateInputs(withOverride({ sourceDir: "$(curl evil)" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });
});

// ---------------------------------------------------------------------------
// targetDir
// ---------------------------------------------------------------------------
describe("validateInputs — targetDir", () => {
  it("accepts /opt/app", () => {
    expect(() =>
      validateInputs(withOverride({ targetDir: "/opt/app" })),
    ).not.toThrow();
  });

  it("rejects relative path", () => {
    expect(() =>
      validateInputs(withOverride({ targetDir: "opt/app" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects path traversal", () => {
    expect(() =>
      validateInputs(withOverride({ targetDir: "/opt/../etc/passwd" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });
});

// ---------------------------------------------------------------------------
// serviceName (optional)
// ---------------------------------------------------------------------------
describe("validateInputs — serviceName (optional)", () => {
  it("allows empty string", () => {
    expect(() =>
      validateInputs(withOverride({ serviceName: "" })),
    ).not.toThrow();
  });

  it("accepts valid service name with @", () => {
    expect(() =>
      validateInputs(withOverride({ serviceName: "myapp@1.service" })),
    ).not.toThrow();
  });

  it("rejects service name with spaces", () => {
    expect(() =>
      validateInputs(withOverride({ serviceName: "my service" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects service name starting with dot", () => {
    expect(() =>
      validateInputs(withOverride({ serviceName: ".hidden" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });
});

// ---------------------------------------------------------------------------
// containerPort (optional)
// ---------------------------------------------------------------------------
describe("validateInputs — containerPort (optional)", () => {
  it('accepts a single port like "8080"', () => {
    expect(() =>
      validateInputs(withOverride({ containerPort: "8080" })),
    ).not.toThrow();
  });

  it('accepts a port mapping like "8080:80"', () => {
    expect(() =>
      validateInputs(withOverride({ containerPort: "8080:80" })),
    ).not.toThrow();
  });

  it("rejects non-numeric containerPort", () => {
    expect(() =>
      validateInputs(withOverride({ containerPort: "abc" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects containerPort mappings with a non-numeric target", () => {
    expect(() =>
      validateInputs(withOverride({ containerPort: "80:abc" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });

  it("rejects malformed containerPort separators", () => {
    expect(() =>
      validateInputs(withOverride({ containerPort: "8080::80" })),
    ).toThrow(/INPUT_VALIDATION_/);
  });
});

// ---------------------------------------------------------------------------
// Error message prefix
// ---------------------------------------------------------------------------
describe("validateInputs — error messages", () => {
  it("prefixes required-empty errors with INPUT_VALIDATION_", () => {
    expect(() =>
      validateInputs(withOverride({ serverName: "" })),
    ).toThrow(/^INPUT_VALIDATION_/);
  });

  it("prefixes pattern-mismatch errors with INPUT_VALIDATION_", () => {
    expect(() =>
      validateInputs(withOverride({ serverName: "; rm -rf /" })),
    ).toThrow(/^INPUT_VALIDATION_/);
  });
});
