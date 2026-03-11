import type { Mock } from "vitest";
import { vi } from "vitest";
import type { ExecOptions } from "@actions/exec";

/** Shape returned by {@link createExecMock}. */
export interface ExecMocks {
  exec: Mock<(
    commandLine: string,
    args?: string[],
    options?: ExecOptions,
  ) => Promise<number>>;
}

/**
 * Create a set of `vi.fn()` mocks for `@actions/exec`.
 *
 * The `exec` mock resolves with exit code `0` by default.
 *
 * Usage with `vi.mock`:
 * ```ts
 * const execMocks = createExecMock();
 * vi.mock("@actions/exec", () => execMocks);
 * ```
 */
export function createExecMock(): ExecMocks {
  return {
    exec: vi.fn().mockResolvedValue(0),
  };
}

/**
 * Configure an `exec` mock so that when it is called with an `options`
 * argument containing a `listeners.stdout` callback, that callback is
 * invoked with the given `stdout` string (as a Buffer).
 *
 * This is useful for testing code that reads command output via the
 * `@actions/exec` listener pattern (e.g. `remoteSetup.ts`'s `sshExec`).
 *
 * The mock still resolves with exit code `0`.
 *
 * @param execMock  The `exec` vi.fn() mock to configure.
 * @param stdout    The string to feed to the stdout listener.
 */
export function mockExecWithStdout(
  execMock: ExecMocks["exec"],
  stdout: string,
): void {
  execMock.mockImplementation(
    async (
      _commandLine: string,
      _args?: string[],
      options?: ExecOptions,
    ): Promise<number> => {
      if (options?.listeners?.stdout) {
        options.listeners.stdout(Buffer.from(stdout));
      }
      return 0;
    },
  );
}
