import { test, expect, describe } from "bun:test";
import { makeLogger, SERVICE } from "../src/log.ts";

interface LogCall {
  body: {
    service: string;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    extra?: Record<string, unknown>;
  };
}

function makeStubClient(): { client: { app: { log: (call: LogCall) => Promise<void> } }; calls: LogCall[] } {
  const calls: LogCall[] = [];
  return {
    client: {
      app: {
        log: async (call: LogCall) => {
          calls.push(call);
        },
      },
    },
    calls,
  };
}

describe("makeLogger", () => {
  test("info logs with service tag and level", async () => {
    const { client, calls } = makeStubClient();
    const log = makeLogger(client as any);
    await log.info("hello");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ service: SERVICE, level: "info", message: "hello" });
  });

  test("warn, error, debug all set the right level", async () => {
    const { client, calls } = makeStubClient();
    const log = makeLogger(client as any);
    await log.debug("d");
    await log.info("i");
    await log.warn("w");
    await log.error("e");
    expect(calls.map((c) => c.body.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  test("extra is forwarded when provided", async () => {
    const { client, calls } = makeStubClient();
    const log = makeLogger(client as any);
    await log.info("hello", { foo: "bar" });
    expect(calls[0]!.body.extra).toEqual({ foo: "bar" });
  });

  test("warnOnce emits on first call with a key", async () => {
    const { client, calls } = makeStubClient();
    const log = makeLogger(client as any);
    await log.warnOnce("k1", "first");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ service: SERVICE, level: "warn", message: "first" });
  });

  test("warnOnce suppresses subsequent calls with the same key", async () => {
    const { client, calls } = makeStubClient();
    const log = makeLogger(client as any);
    await log.warnOnce("k", "first");
    await log.warnOnce("k", "second");
    await log.warnOnce("k", "third");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.message).toBe("first");
  });

  test("warnOnce keys are independent", async () => {
    const { client, calls } = makeStubClient();
    const log = makeLogger(client as any);
    await log.warnOnce("a", "msg-a");
    await log.warnOnce("b", "msg-b");
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.body.message)).toEqual(["msg-a", "msg-b"]);
  });

  test("warnOnce dedup is per-logger-instance, not global", async () => {
    const a = makeStubClient();
    const b = makeStubClient();
    const logA = makeLogger(a.client as any);
    const logB = makeLogger(b.client as any);
    await logA.warnOnce("k", "from-a");
    await logB.warnOnce("k", "from-b"); // different logger, should fire
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  test("log call rejecting does not propagate (swallow)", async () => {
    const failingClient = {
      app: {
        log: async () => {
          throw new Error("network down");
        },
      },
    };
    const log = makeLogger(failingClient as any);
    // Must not throw.
    await log.info("x");
    await log.warnOnce("k", "y");
  });
});
