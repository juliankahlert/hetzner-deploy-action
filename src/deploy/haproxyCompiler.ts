import * as core from "@actions/core";
import type {
  HaproxyBackendEntry,
  HaproxyFragment,
  HaproxyFrontendEntry,
  LocalCompileOptions,
} from "./haproxyTypes.js";

const HAPROXY_COMPILE_LOG_PREFIX = "[HAPROXY_COMPILE]";
const GENERATED_HEADER = "# Generated from JSON fragment — do not edit manually";
const INDENT = "  ";

function compareLexicographically(a: string, b: string): number {
  if (a < b) {
    return -1;
  }

  if (a > b) {
    return 1;
  }

  return 0;
}

function renderFrontendBlock(port: string, frontend: HaproxyFrontendEntry): string {
  const lines: string[] = [`frontend ft_${port}`, `${INDENT}bind ${frontend.bind}`];

  for (const acl of frontend.acl) {
    lines.push(`${INDENT}acl ${acl}`);
  }

  for (const backendRule of frontend.use_backend) {
    lines.push(`${INDENT}use_backend ${backendRule}`);
  }

  if (frontend.default_backend) {
    lines.push(`${INDENT}default_backend ${frontend.default_backend}`);
  }

  return lines.join("\n");
}

function renderBackendBlock(name: string, backend: HaproxyBackendEntry): string {
  const lines: string[] = [`backend ${name}`, `${INDENT}mode ${backend.mode}`];

  for (const server of backend.server) {
    lines.push(`${INDENT}server ${server}`);
  }

  return lines.join("\n");
}

export function compileFragment(
  fragment: HaproxyFragment,
  options?: LocalCompileOptions,
): string {
  const addHeader = options?.addHeader !== false;
  const frontendPorts = Object.keys(fragment.frontend).sort(compareLexicographically);
  const backendNames = Object.keys(fragment.backend).sort(compareLexicographically);

  core.info(`${HAPROXY_COMPILE_LOG_PREFIX} Starting local HAProxy fragment compilation.`);
  core.debug(
    `${HAPROXY_COMPILE_LOG_PREFIX} Header rendering is ${addHeader ? "enabled" : "disabled"}.`,
  );
  core.debug(
    `${HAPROXY_COMPILE_LOG_PREFIX} Frontend render order: ${frontendPorts.length > 0 ? frontendPorts.join(", ") : "(none)"}.`,
  );
  core.debug(
    `${HAPROXY_COMPILE_LOG_PREFIX} Backend render order: ${backendNames.length > 0 ? backendNames.join(", ") : "(none)"}.`,
  );

  const blocks: string[] = [];

  for (const port of frontendPorts) {
    core.debug(`${HAPROXY_COMPILE_LOG_PREFIX} Rendering frontend block for port ${port}.`);
    blocks.push(renderFrontendBlock(port, fragment.frontend[port]));
  }

  for (const name of backendNames) {
    core.debug(`${HAPROXY_COMPILE_LOG_PREFIX} Rendering backend block ${name}.`);
    blocks.push(renderBackendBlock(name, fragment.backend[name]));
  }

  const renderedBlocks = blocks.join("\n\n");

  if (addHeader) {
    const output = renderedBlocks ? `${GENERATED_HEADER}\n${renderedBlocks}\n` : `${GENERATED_HEADER}\n`;
    core.info(`${HAPROXY_COMPILE_LOG_PREFIX} Local HAProxy fragment compilation complete.`);
    return output;
  }

  const output = renderedBlocks ? `${renderedBlocks}\n` : "\n";
  core.info(`${HAPROXY_COMPILE_LOG_PREFIX} Local HAProxy fragment compilation complete.`);
  return output;
}
