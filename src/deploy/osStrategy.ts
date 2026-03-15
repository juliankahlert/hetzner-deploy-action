/** Supported operating-system families for deployment strategies. */
export type OsFamily = "debian" | "fedora";

/** Command factory contract for OS-specific package operations. */
export interface PackageCommands {
  /** Validation regex for package names accepted by this OS family. */
  readonly packageNamePattern: RegExp;
  /** Build the package-install command for the requested package list. */
  install(packages: readonly string[]): string;
  /** Build the package-verification command for a single package. */
  verify(packageName: string): string;
}

/** Command factory contract for OS-specific firewall operations. */
export interface FirewallCommands {
  /** Build the firewall-package install command. */
  install(): string;
  /** Build the firewall default-policy command. */
  defaults(): string;
  /** Build the firewall allow-rule command for a normalized rule/port spec. */
  allow(rule: string): string;
  /** Build the firewall enable command. */
  enable(): string;
}

/** Canonical contract for OS-aware deployment strategy implementations. */
export interface OsStrategy {
  /** Selected operating-system family. */
  readonly family: OsFamily;
  /** OS-specific package command helpers. */
  readonly packages: PackageCommands;
  /** OS-specific firewall command helpers. */
  readonly firewall: FirewallCommands;
}
