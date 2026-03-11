import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";
import { withKeyFile, sshExec, shellQuote } from "./ssh.js";

/* ------------------------------------------------------------------ */
/*  Option / result interfaces                                        */
/* ------------------------------------------------------------------ */

/** Options for deploying a container via Podman Quadlet. */
export interface PodmanDeployOptions {
  /** Server IP or hostname. */
  host: string;
  /** SSH user (e.g. "root"). */
  user: string;
  /** SSH private key content. */
  privateKey: string;
  /** Container image reference (e.g. "docker.io/library/nginx:latest"). */
  image: string;
  /** Published port mapping (e.g. "8080:80"). */
  port: string;
  /** Quadlet service name (used for the .container filename). */
  serviceName: string;
  /** When true the host is an IPv6 address — forces ssh to use `-6`. */
  ipv6Only?: boolean;
}

/** Result returned after a Podman Quadlet deployment. */
export interface PodmanDeployResult {
  /** Whether the quadlet file was uploaded to the remote host. */
  quadletUploaded: boolean;
  /** Whether the service was restarted successfully. */
  serviceRestarted: boolean;
}

/* ------------------------------------------------------------------ */
/*  Error-prefix constants                                            */
/* ------------------------------------------------------------------ */

const ERR_RENDER = "PODMAN_RENDER";
const ERR_UPLOAD = "PODMAN_UPLOAD";
const ERR_START = "PODMAN_START";

/* ------------------------------------------------------------------ */
/*  Template rendering                                                */
/* ------------------------------------------------------------------ */

/**
 * Read the bundled Quadlet container template and substitute placeholders.
 *
 * Exported for unit-testing; production callers should use
 * {@link deployPodman} instead.
 */
export function renderQuadlet(vars: Record<string, string>): string {
  const templatePath = path.resolve(
    __dirname,
    "..",
    "..",
    "templates",
    "quadlet.container",
  );

  let content: string;
  try {
    if (fs.existsSync(templatePath)) {
      content = fs.readFileSync(templatePath, "utf-8");
    } else {
      // Fallback minimal template (when running from ncc bundle where
      // template may not be adjacent)
      content = [
        "[Unit]",
        "Description={{SERVICE_NAME}}",
        "After=network-online.target",
        "Requires=network-online.target",
        "",
        "[Container]",
        "Image={{IMAGE}}",
        "PublishPort={{PORT}}",
        "AutoUpdate=registry",
        "",
        "[Service]",
        "Restart=on-failure",
        "RestartSec=5",
        "NoNewPrivileges=true",
        "",
        "[Install]",
        "WantedBy=multi-user.target default.target",
      ].join("\n");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${ERR_RENDER}: failed to load template: ${msg}`);
  }

  for (const [key, value] of Object.entries(vars)) {
    content = content.replace(
      new RegExp(`\\{\\{${key}\\}\\}`, "g"),
      () => value,
    );
  }
  return content;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Deploy a container to a remote host using Podman Quadlet.
 *
 * Steps:
 *   1. Render the Quadlet `.container` template with the provided options.
 *   2. Upload the rendered file to `/etc/containers/systemd/<name>.container`
 *      on the remote host via heredoc over SSH (`sudo tee`).
 *   3. Run `systemctl daemon-reload` to pick up the new Quadlet unit.
 *   4. Restart the generated service.
 *
 * All errors are prefixed with their stage label (`PODMAN_RENDER`,
 * `PODMAN_UPLOAD`, `PODMAN_START`) for easy identification in CI logs.
 */
export async function deployPodman(
  opts: PodmanDeployOptions,
): Promise<PodmanDeployResult> {
  const {
    host,
    user,
    privateKey,
    image,
    port,
    serviceName,
    ipv6Only = false,
  } = opts;

  const result: PodmanDeployResult = {
    quadletUploaded: false,
    serviceRestarted: false,
  };

  // 1. Render the Quadlet template
  core.info(`[${ERR_RENDER}] Rendering Quadlet template for "${serviceName}"…`);
  const quadletContent = renderQuadlet({
    SERVICE_NAME: serviceName,
    IMAGE: image,
    PORT: port,
  });

  const remotePath = `/etc/containers/systemd/${serviceName}.container`;

  await withKeyFile(privateKey, async (keyPath) => {
    // 2. Upload the Quadlet file via heredoc
    core.info(`[${ERR_UPLOAD}] Uploading Quadlet file to ${remotePath}…`);
    try {
      await sshExec(
        keyPath,
        user,
        host,
        `sudo mkdir -p /etc/containers/systemd && sudo tee ${shellQuote(remotePath)} > /dev/null << 'QUADLET_EOF'\n${quadletContent}\nQUADLET_EOF`,
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${ERR_UPLOAD}: ${msg}`);
    }
    result.quadletUploaded = true;
    core.info(`[${ERR_UPLOAD}] Quadlet file written to ${remotePath}.`);

    // 3. Reload systemd daemon to process the new Quadlet file
    core.info(`[${ERR_START}] Running systemctl daemon-reload…`);
    try {
      await sshExec(
        keyPath,
        user,
        host,
        "sudo systemctl daemon-reload",
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${ERR_START}: daemon-reload failed: ${msg}`);
    }

    // 4. Restart the service (Quadlet generates a service named after the file)
    core.info(`[${ERR_START}] Restarting ${serviceName}…`);
    try {
      await sshExec(
        keyPath,
        user,
        host,
        `sudo systemctl restart ${shellQuote(serviceName)}`,
        ipv6Only,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${ERR_START}: restart failed: ${msg}`);
    }
    result.serviceRestarted = true;
    core.info(
      `[${ERR_START}] Service "${serviceName}" restarted successfully.`,
    );
  });

  return result;
}
