import * as core from "@actions/core";

import {
  TEMPLATE_TOKEN_RE,
  normalizeRoute,
  validateFragment,
  type GeneratorInputs,
  type GeneratorResult,
  type HaproxyFragment,
  type NormalizedRoute,
} from "./haproxyTypes.js";

const HAPROXY_GENERATE_LOG_PREFIX = "[HAPROXY_GENERATE]";
const DEFAULT_CERTBOT_PORT = 8888;
const CERTBOT_FRONTEND_KEY = "80";
const CERTBOT_ACL = "acme_challenge path_beg /.well-known/acme-challenge/";
const CERTBOT_USE_BACKEND = "bk_certbot if acme_challenge";
const CERTBOT_BACKEND_NAME = "bk_certbot";
const CERTBOT_SERVER_NAME = "certbot";

function prefixedMessage(message: string): string {
  return `${HAPROXY_GENERATE_LOG_PREFIX} ${message}`;
}

function createGenerationError(message: string): Error {
  return new Error(prefixedMessage(message));
}

function buildHostAclTemplate(route: NormalizedRoute): string {
  if (!route.host) {
    throw createGenerationError("cannot build host ACL template without a normalized host");
  }

  return `host_{{service}} hdr(host) -i ${route.host}`;
}

function buildUseBackendRuleTemplate(route: NormalizedRoute): string {
  const backendName = "bk_{{service}}";
  const hostAclName = "host_{{service}}";

  if (route.kind === "host-only") {
    return `${backendName} if ${hostAclName}`;
  }

  if ((route.kind !== "host-path" && route.kind !== "path-only") || !route.path) {
    throw createGenerationError("cannot build backend rule template for non-routable path state");
  }

  const pathCondition = route.isPathPrefix
    ? `{ path_beg -i ${route.path} }`
    : `{ path -i ${route.path} }`;

  if (route.kind === "path-only") {
    return `${backendName} if ${pathCondition}`;
  }

  return `${backendName} if ${hostAclName} ${pathCondition}`;
}

function summarizeValidationErrors(fragment: HaproxyFragment): string {
  const errors = validateFragment(fragment);

  if (errors.length === 0) {
    return "";
  }

  const summary = errors
    .map((error) => `${error.path || "<root>"}: ${error.message}`)
    .join("; ");

  return `fragment validation failed with ${errors.length} error(s): ${summary}`;
}

function assertValidFragment(fragment: HaproxyFragment, context: string): void {
  const validationSummary = summarizeValidationErrors(fragment);

  if (validationSummary) {
    throw createGenerationError(`${context}: ${validationSummary}`);
  }
}

function createCertbotFragment(certbotPort: number): HaproxyFragment {
  return {
    frontend: {
      [CERTBOT_FRONTEND_KEY]: {
        bind: "*:80",
        acl: [CERTBOT_ACL],
        use_backend: [CERTBOT_USE_BACKEND],
      },
    },
    backend: {
      [CERTBOT_BACKEND_NAME]: {
        mode: "http",
        server: [`${CERTBOT_SERVER_NAME} 127.0.0.1:${certbotPort} check`],
      },
    },
  };
}

function mergeCertbotIntoFragment(fragment: HaproxyFragment, certbotPort: number): HaproxyFragment {
  const frontendEntry = fragment.frontend[CERTBOT_FRONTEND_KEY];

  if (!frontendEntry) {
    throw createGenerationError("cannot merge certbot fragment without an existing port-80 frontend");
  }

  return {
    frontend: {
      ...fragment.frontend,
      [CERTBOT_FRONTEND_KEY]: {
        ...frontendEntry,
        acl: [CERTBOT_ACL, ...frontendEntry.acl],
        use_backend: [CERTBOT_USE_BACKEND, ...frontendEntry.use_backend],
      },
    },
    backend: {
      ...fragment.backend,
      [CERTBOT_BACKEND_NAME]: {
        mode: "http",
        server: [`${CERTBOT_SERVER_NAME} 127.0.0.1:${certbotPort} check`],
      },
    },
  };
}

export function resolveServiceTokens(template: string, serviceName: string): string {
  const resolved = template.replaceAll("{{service}}", serviceName);
  const unresolvedToken = TEMPLATE_TOKEN_RE.exec(resolved);

  if (unresolvedToken) {
    throw createGenerationError(
      `unresolved template token '${unresolvedToken[0]}' in value: ${template}`,
    );
  }

  return resolved;
}

export function generateFragment(inputs: GeneratorInputs): GeneratorResult {
  core.info(
    prefixedMessage(
      `Generating HAProxy fragment for service '${inputs.serviceName}' on bind port ${inputs.bindPort}.`,
    ),
  );

  const route = normalizeRoute(inputs.domain ?? "");
  const frontendKey = String(inputs.bindPort);
  const frontendBind = inputs.sslCertPath
    ? `*:${inputs.bindPort} ssl crt ${inputs.sslCertPath}`
    : `*:${inputs.bindPort}`;
  const backendName = resolveServiceTokens("bk_{{service}}", inputs.serviceName);
  const serverName = resolveServiceTokens("{{service}}_1", inputs.serviceName);
  const includeHealthCheck = inputs.healthCheck === undefined || Boolean(inputs.healthCheck);
  const serverTarget = `${inputs.backendAddress}:${inputs.backendPort}`;
  const serverLine = includeHealthCheck
    ? `${serverName} ${serverTarget} check`
    : `${serverName} ${serverTarget}`;

  const fragment: HaproxyFragment = {
    frontend: {
      [frontendKey]: {
        bind: frontendBind,
        acl: [],
        use_backend: [],
      },
    },
    backend: {
      [backendName]: {
        mode: inputs.mode ?? "http",
        server: [serverLine],
      },
    },
  };

  const frontendEntry = fragment.frontend[frontendKey];

  switch (route.kind) {
    case "catch-all": {
      frontendEntry.default_backend = backendName;
      break;
    }
    case "host-only":
    case "host-path": {
      frontendEntry.acl.push(resolveServiceTokens(buildHostAclTemplate(route), inputs.serviceName));
      frontendEntry.use_backend.push(
        resolveServiceTokens(buildUseBackendRuleTemplate(route), inputs.serviceName),
      );
      break;
    }
    case "path-only": {
      frontendEntry.use_backend.push(
        resolveServiceTokens(buildUseBackendRuleTemplate(route), inputs.serviceName),
      );
      break;
    }
    default: {
      throw createGenerationError(`unsupported normalized route kind: ${(route as { kind?: string }).kind}`);
    }
  }

  let finalFragment = fragment;
  let certbotFragment: HaproxyFragment | undefined;

  if (inputs.certbot === true) {
    const certbotPort = inputs.certbotPort ?? DEFAULT_CERTBOT_PORT;

    core.info(prefixedMessage(`Generating certbot fragment for port ${certbotPort}.`));

    if (inputs.bindPort === 80) {
      core.info(prefixedMessage("Merging certbot routing into primary port-80 frontend."));
      finalFragment = mergeCertbotIntoFragment(fragment, certbotPort);
    } else {
      core.info(prefixedMessage("Returning separate certbot fragment for port-80 frontend."));
      certbotFragment = createCertbotFragment(certbotPort);
    }
  }

  assertValidFragment(finalFragment, "invalid primary fragment output");

  if (certbotFragment) {
    assertValidFragment(certbotFragment, "invalid certbot fragment output");
  }

  core.info(
    prefixedMessage(
      `Generated HAProxy fragment for service '${inputs.serviceName}' with route kind '${route.kind}'.`,
    ),
  );

  return { fragment: finalFragment, certbotFragment };
}
