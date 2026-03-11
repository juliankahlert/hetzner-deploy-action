import * as core from "@actions/core";

export interface ValidatableInputs {
  serverName: string;
  sshUser: string;
  sourceDir: string;
  targetDir: string;
  serviceName: string;
  image: string;
  serverType: string;
  projectTag: string;
  ipv6Only: string;
}

/** Allowlist patterns — each must match the entire value. */
const rules: {
  field: keyof ValidatableInputs;
  label: string;
  pattern: RegExp;
  hint: string;
  optional?: boolean;
}[] = [
  {
    field: "serverName",
    label: "server_name",
    pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/,
    hint: "Must start with alphanumeric; only letters, digits, dots, hyphens, underscores (max 63 chars).",
  },
  {
    field: "sshUser",
    label: "ssh_user",
    pattern: /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/,
    hint: "Must be a valid Unix username (letters, digits, underscores, hyphens; max 32 chars).",
  },
  {
    field: "sourceDir",
    label: "source_dir",
    pattern: /^(?!.*\.\.)(?:\.|\/?[a-zA-Z0-9._-][a-zA-Z0-9._\/-]*)$/,
    hint: 'Must be "." or a relative/absolute path without ".." or special characters.',
  },
  {
    field: "targetDir",
    label: "target_dir",
    pattern: /^\/(?!.*\.\.)[a-zA-Z0-9._-][a-zA-Z0-9._\/-]*$/,
    hint: 'Must be an absolute path (starts with /) without ".." or special characters.',
  },
  {
    field: "serviceName",
    label: "service_name",
    pattern: /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,255}$/,
    hint: "Must start with alphanumeric; only letters, digits, dots, hyphens, underscores, @ (max 256 chars).",
    optional: true,
  },
  {
    field: "image",
    label: "image",
    pattern: /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/,
    hint: "Must start with a letter; only letters, digits, dots, hyphens, underscores (max 64 chars).",
  },
  {
    field: "serverType",
    label: "server_type",
    pattern: /^[a-z]{2,4}[0-9]{1,3}(-[a-z0-9]+)?$/,
    hint: "Must be a valid Hetzner server type slug, e.g. cx23, cpx11, cx22-dedicated.",
  },
  {
    field: "projectTag",
    label: "project_tag",
    pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/,
    hint: "Must start with alphanumeric; only letters, digits, dots, hyphens, underscores (max 255 chars).",
  },
  {
    field: "ipv6Only",
    label: "ipv6_only",
    pattern: /^(true|false)$/,
    hint: 'Must be exactly "true" or "false".',
  },
];

/**
 * Validate user-supplied inputs against strict allowlists.
 * Throws immediately on the first violation so the action fails fast.
 */
export function validateInputs(inputs: ValidatableInputs): void {
  for (const rule of rules) {
    const value = inputs[rule.field];

    if (!value) {
      if (rule.optional) continue;
      // Required fields are enforced by core.getInput({ required: true }),
      // but guard here too for safety.
      throw new Error(
        `INPUT_VALIDATION_ Input "${rule.label}" is required but was empty.`,
      );
    }

    if (!rule.pattern.test(value)) {
      throw new Error(
        `INPUT_VALIDATION_ Invalid value for "${rule.label}": ${JSON.stringify(value)}. ${rule.hint}`,
      );
    }
  }

  core.info("Input validation passed.");
}
