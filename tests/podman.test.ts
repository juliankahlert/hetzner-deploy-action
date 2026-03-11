import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before imports that trigger them
// ---------------------------------------------------------------------------

vi.mock("@actions/core", async () => {
  const { createCoreMock } = await import("./helpers/mockCore");
  return createCoreMock();
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:path", () => ({
  resolve: vi.fn((...segments: string[]) => segments.join("/")),
}));

vi.mock("../src/deploy/ssh.js", () => ({
  withKeyFile: vi.fn(),
  sshExec: vi.fn(),
  shellQuote: vi.fn((value: string) =>
    `'${value.replace(/'/g, "'\\''")}'`,
  ),
}));

// ---------------------------------------------------------------------------
// Imports (receive mocked implementations)
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import * as ssh from "../src/deploy/ssh.js";

import { renderQuadlet, deployPodman } from "../src/deploy/podman";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const FAKE_KEY_PATH = "/tmp/hda-key-XXXXXX/id";

const BASE_OPTS = {
  host: "1.2.3.4",
  user: "root",
  privateKey: "TEST_PRIVATE_KEY",
  image: "docker.io/library/nginx:latest",
  port: "8080:80",
  serviceName: "webapp",
} as const;

const FILE_TEMPLATE = [
  "[Unit]",
  "Description={{SERVICE_NAME}}",
  "",
  "[Container]",
  "Image={{IMAGE}}",
  "PublishPort={{PORT}}",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
].join("\n");

function sshRemoteCmd(callIndex: number): string {
  return vi.mocked(ssh.sshExec).mock.calls[callIndex]![3] as string;
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  vi.mocked(fs.existsSync).mockReturnValue(false as never);
  vi.mocked(path.resolve).mockImplementation(
    (...segments: string[]) => segments.join("/"),
  );
  vi.mocked(ssh.shellQuote).mockImplementation(
    (value: string) => `'${value.replace(/'/g, "'\\''")}'`,
  );
  vi.mocked(ssh.withKeyFile).mockImplementation(
    async (_privateKey: string, fn: (keyPath: string) => Promise<unknown>) =>
      fn(FAKE_KEY_PATH),
  );
  vi.mocked(ssh.sshExec).mockResolvedValue("");
});

// ===========================================================================
// 1. renderQuadlet
// ===========================================================================

describe("renderQuadlet", () => {
  it("substitutes service, image, and port placeholders from the template", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true as never);
    vi.mocked(fs.readFileSync).mockReturnValue(FILE_TEMPLATE as never);

    const rendered = renderQuadlet({
      SERVICE_NAME: "webapp",
      IMAGE: "ghcr.io/example/app:1.2.3",
      PORT: "8080:80",
    });

    expect(fs.readFileSync).toHaveBeenCalledOnce();
    expect(rendered).toContain("Description=webapp");
    expect(rendered).toContain("Image=ghcr.io/example/app:1.2.3");
    expect(rendered).toContain("PublishPort=8080:80");
    expect(rendered).not.toContain("{{SERVICE_NAME}}");
    expect(rendered).not.toContain("{{IMAGE}}");
    expect(rendered).not.toContain("{{PORT}}");
  });

  it("uses the fallback template when the bundled template file is missing", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false as never);

    const rendered = renderQuadlet({
      SERVICE_NAME: "fallback-app",
      IMAGE: "docker.io/library/caddy:latest",
      PORT: "9090:90",
    });

    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(rendered).toContain("Description=fallback-app");
    expect(rendered).toContain("Image=docker.io/library/caddy:latest");
    expect(rendered).toContain("PublishPort=9090:90");
    expect(rendered).toContain("AutoUpdate=registry");
    expect(rendered).toContain("WantedBy=multi-user.target default.target");
  });

  it("wraps template load failures with the PODMAN_RENDER prefix", () => {
    vi.mocked(fs.existsSync).mockImplementation(() => {
      throw new Error("template I/O failed");
    });

    expect(() =>
      renderQuadlet({
        SERVICE_NAME: "webapp",
        IMAGE: "docker.io/library/nginx:latest",
        PORT: "8080:80",
      }),
    ).toThrow(/PODMAN_RENDER: failed to load template: template I\/O failed/);
  });
});

// ===========================================================================
// 2. deployPodman
// ===========================================================================

describe("deployPodman", () => {
  it("uploads the quadlet, reloads systemd, and restarts the service on success", async () => {
    const result = await deployPodman(BASE_OPTS);

    expect(result).toEqual({
      quadletUploaded: true,
      serviceRestarted: true,
    });

    expect(ssh.withKeyFile).toHaveBeenCalledWith(
      "TEST_PRIVATE_KEY",
      expect.any(Function),
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(3);
    expect(sshRemoteCmd(0)).toContain("sudo mkdir -p /etc/containers/systemd");
    expect(sshRemoteCmd(0)).toContain(
      "sudo tee '/etc/containers/systemd/webapp.container' > /dev/null",
    );
    expect(sshRemoteCmd(0)).toContain("QUADLET_EOF");
    expect(sshRemoteCmd(0)).toContain("Description=webapp");
    expect(sshRemoteCmd(0)).toContain(
      "Image=docker.io/library/nginx:latest",
    );
    expect(sshRemoteCmd(0)).toContain("PublishPort=8080:80");
    expect(sshRemoteCmd(1)).toBe("sudo systemctl daemon-reload");
    expect(sshRemoteCmd(2)).toBe("sudo systemctl restart 'webapp'");
  });

  it("wraps upload failures with the PODMAN_UPLOAD prefix", async () => {
    vi.mocked(ssh.sshExec).mockRejectedValueOnce(new Error("tee failed"));

    await expect(deployPodman(BASE_OPTS)).rejects.toThrow(
      /PODMAN_UPLOAD: tee failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(1);
    expect(sshRemoteCmd(0)).toContain(
      "'/etc/containers/systemd/webapp.container'",
    );
  });

  it("wraps daemon-reload failures with the PODMAN_START prefix", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("reload failed"));

    await expect(deployPodman(BASE_OPTS)).rejects.toThrow(
      /PODMAN_START: daemon-reload failed: reload failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(2);
    expect(sshRemoteCmd(0)).toContain(
      "'/etc/containers/systemd/webapp.container'",
    );
    expect(sshRemoteCmd(1)).toBe("sudo systemctl daemon-reload");
  });

  it("wraps restart failures with the PODMAN_START prefix", async () => {
    vi.mocked(ssh.sshExec)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("restart failed"));

    await expect(deployPodman(BASE_OPTS)).rejects.toThrow(
      /PODMAN_START: restart failed: restart failed/,
    );

    expect(vi.mocked(ssh.sshExec)).toHaveBeenCalledTimes(3);
    expect(sshRemoteCmd(1)).toBe("sudo systemctl daemon-reload");
    expect(sshRemoteCmd(2)).toBe("sudo systemctl restart 'webapp'");
  });
});
