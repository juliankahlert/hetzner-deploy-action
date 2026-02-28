import * as core from "@actions/core";

interface ValidatableInputs {
  serverName: string;
  sshUser: string;
  sourceDir: string;
  targetDir: string;
  serviceName: string;
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
      throw new Error(`Input "${rule.label}" is required but was empty.`);
    }

    if (!rule.pattern.test(value)) {
      throw new Error(
        `Invalid value for "${rule.label}": ${JSON.stringify(value)}. ${rule.hint}`,
      );
    }
  }

  core.info("Input validation passed.");
}
