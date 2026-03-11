import type { Mock } from "vitest";
import { vi } from "vitest";

/** Shape returned by {@link createCoreMock}. */
export interface CoreMocks {
  info: Mock<(...args: unknown[]) => void>;
  warning: Mock<(...args: unknown[]) => void>;
  error: Mock<(...args: unknown[]) => void>;
  debug: Mock<(...args: unknown[]) => void>;
  setFailed: Mock<(...args: unknown[]) => void>;
  getInput: Mock<(...args: unknown[]) => string>;
  setOutput: Mock<(...args: unknown[]) => void>;
  setSecret: Mock<(...args: unknown[]) => void>;
}

/**
 * Create a set of `vi.fn()` mocks for the most commonly used
 * `@actions/core` methods.
 *
 * Usage with `vi.mock`:
 * ```ts
 * const coreMocks = createCoreMock();
 * vi.mock("@actions/core", () => coreMocks);
 * ```
 *
 * `getInput` returns `""` by default; override per-test via
 * `coreMocks.getInput.mockReturnValue(...)` or
 * `coreMocks.getInput.mockImplementation(...)`.
 */
export function createCoreMock(): CoreMocks {
  return {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    setFailed: vi.fn(),
    getInput: vi.fn().mockReturnValue(""),
    setOutput: vi.fn(),
    setSecret: vi.fn(),
  };
}
