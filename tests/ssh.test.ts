import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecOptions } from "@actions/exec";
import { mockExecWithStdout } from "./helpers/mockExec";

// ---------------------------------------------------------------------------
// Module mocks — declared before imports that trigger them
// ---------------------------------------------------------------------------

vi.mock("@actions/core", async () => {
  const { createCoreMock } = await import("./helpers/mockCore");
  return createCoreMock();
});

vi.mock("@actions/exec", async () => {
  const { createExecMock } = await import("./helpers/mockExec");
  return createExecMock();
});

// ---------------------------------------------------------------------------
// Imports (receive mocked implementations)
// ---------------------------------------------------------------------------

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { waitForSsh } from "../src/deploy/ssh.js";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const KEY_PATH = "/tmp/id";
const USER = "root";
const HOST = "1.2.3.4";

function mockProbeOnce(result: { stdout?: string; error?: Error }): void {
  vi.mocked(exec.exec).mockImplementationOnce(
    async (
      _commandLine: string,
      _args?: string[],
      options?: ExecOptions,
    ): Promise<number> => {
      if (result.error) {
        throw result.error;
      }

      if (result.stdout !== undefined) {
        options?.listeners?.stdout?.(Buffer.from(result.stdout));
      }

      return 0;
    },
  );
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  mockExecWithStdout(vi.mocked(exec.exec), "ok");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForSsh", () => {
  it("returns immediately when the first SSH probe succeeds", async () => {
    await expect(waitForSsh(KEY_PATH, USER, HOST)).resolves.toBeUndefined();

    expect(exec.exec).toHaveBeenCalledOnce();
    expect(core.info).not.toHaveBeenCalled();
    expect(vi.mocked(exec.exec).mock.calls[0]).toEqual(
      expect.arrayContaining(["ssh", expect.arrayContaining([`${USER}@${HOST}`, "echo ok"])]),
    );
  });

  it("retries transient failures until a later probe succeeds", async () => {
    vi.useFakeTimers();

    mockProbeOnce({ error: new Error("connection refused") });
    mockProbeOnce({ error: new Error("connection reset") });
    mockProbeOnce({ stdout: "ok" });

    const waitPromise = waitForSsh(KEY_PATH, USER, HOST);

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    await expect(waitPromise).resolves.toBeUndefined();

    expect(exec.exec).toHaveBeenCalledTimes(3);
    expect(core.info).toHaveBeenCalledTimes(2);
    expect(core.info).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("retrying in 2s: connection refused"),
    );
    expect(core.info).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("retrying in 4s: connection reset"),
    );
  });

  it("throws the last transient error after exhausting the retry budget", async () => {
    vi.useFakeTimers();

    const error = new Error("connection timed out");
    vi.mocked(exec.exec).mockRejectedValue(error);

    const waitPromise = waitForSsh(KEY_PATH, USER, HOST).catch(
      (caught: unknown) => caught,
    );

    for (const delayMs of [2000, 4000, 8000, 16000, 32000, 32000]) {
      await vi.advanceTimersByTimeAsync(delayMs);
    }

    await expect(waitPromise).resolves.toBe(error);

    expect(exec.exec).toHaveBeenCalledTimes(7);
    expect(core.info).toHaveBeenCalledTimes(6);
    expect(core.info).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("retrying in 2s"),
    );
    expect(core.info).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("retrying in 4s"),
    );
    expect(core.info).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("retrying in 8s"),
    );
    expect(core.info).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("retrying in 16s"),
    );
    expect(core.info).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("retrying in 32s"),
    );
    expect(core.info).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("retrying in 32s"),
    );
  });

  it("fails immediately on permission denied errors", async () => {
    vi.useFakeTimers();

    const error = new Error("Permission denied (publickey)");
    vi.mocked(exec.exec).mockRejectedValueOnce(error);

    await expect(waitForSsh(KEY_PATH, USER, HOST)).rejects.toBe(error);

    expect(exec.exec).toHaveBeenCalledOnce();
    expect(core.info).not.toHaveBeenCalled();
  });

  it("retries mixed transient probe failures including bad stdout", async () => {
    vi.useFakeTimers();

    mockProbeOnce({ stdout: "not ready" });
    mockProbeOnce({ error: new Error("host unreachable") });
    mockProbeOnce({ stdout: "ok" });

    const waitPromise = waitForSsh(KEY_PATH, USER, HOST);

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    await expect(waitPromise).resolves.toBeUndefined();

    expect(exec.exec).toHaveBeenCalledTimes(3);
    expect(core.info).toHaveBeenCalledTimes(2);
    expect(core.info).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        "retrying in 2s: Unexpected SSH probe output: not ready",
      ),
    );
    expect(core.info).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("retrying in 4s: host unreachable"),
    );
  });
});
