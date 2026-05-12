import { test, expect, describe } from "bun:test";
import { resolveEnv } from "../src/resolveEnv.ts";
import { DirenvCache } from "../src/cache.ts";
import { makeStubLogger, makeTmpDir, writeFile, FAKE_DIRENV_BIN, readDirenvLog } from "./helpers.ts";
import { statSync } from "node:fs";
import type { Config } from "../src/types.ts";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return { bin: FAKE_DIRENV_BIN, allow: null, deny: new Set(), verbose: false, ...overrides };
}

function statusJsonFor(root: string, watchedFiles: string[]): string {
  return JSON.stringify({
    state: {
      foundRC: {
        path: `${root}/.envrc`,
        allowed: 0,
        watches: watchedFiles.map((p) => ({
          Path: p,
          Modified: new Date(statSync(p).mtimeMs).toISOString(),
        })),
      },
    },
  });
}

describe("resolveEnv", () => {
  test("returns env from cache when fresh, no spawn", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const logfile = `${root}.log`;
    const cache = new DirenvCache();
    cache.set(root, {
      env: { CACHED: "yes" },
      watches: [{ path: envrc, mtime: statSync(envrc).mtimeMs }],
      computedAt: 0,
    });
    const { logger } = makeStubLogger();
    const out = await resolveEnv(
      { cache, config: makeConfig(), log: logger },
      root,
      { FAKE_DIRENV_LOGFILE: logfile },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.entry.env).toEqual({ CACHED: "yes" });
    // No spawn because cache was fresh.
    expect(readDirenvLog(logfile)).toEqual([]);
    cleanup();
  });

  test("on cache miss, spawns export + status and caches the result", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const logfile = `${root}.log`;
    const cache = new DirenvCache();
    const { logger } = makeStubLogger();
    const out = await resolveEnv(
      { cache, config: makeConfig(), log: logger },
      root,
      {
        FAKE_DIRENV_LOGFILE: logfile,
        FAKE_DIRENV_EXPORT: '{"FOO":"bar"}',
        FAKE_DIRENV_STATUS: statusJsonFor(root, [envrc]),
      },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.entry.env).toEqual({ FOO: "bar" });
      expect(out.entry.watches.map((w) => w.path)).toEqual([envrc]);
    }
    expect(cache.peek(root)).not.toBeNull();
    const log = readDirenvLog(logfile);
    expect(log.map((r) => r.argv.slice(1).join(" ")).sort()).toEqual([
      "export json",
      "status --json",
    ]);
    cleanup();
  });

  test("falls back to root/.envrc watch when status returns schema-mismatch", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const cache = new DirenvCache();
    const { logger, warnOnceKeys } = makeStubLogger();
    const out = await resolveEnv(
      { cache, config: makeConfig(), log: logger },
      root,
      {
        FAKE_DIRENV_EXPORT: '{"FOO":"bar"}',
        FAKE_DIRENV_STATUS: '{"state":{"foundRC":{"watches":[{"bad":"shape"}]}}}',
      },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.entry.watches.map((w) => w.path)).toEqual([envrc]);
    }
    expect(warnOnceKeys.has("status-fallback")).toBe(true);
    cleanup();
  });

  test("falls back to root/.envrc watch when status returns non-object", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const cache = new DirenvCache();
    const { logger, warnOnceKeys } = makeStubLogger();
    const out = await resolveEnv(
      { cache, config: makeConfig(), log: logger },
      root,
      {
        FAKE_DIRENV_EXPORT: '{"FOO":"bar"}',
        FAKE_DIRENV_STATUS: '"not an object"',
      },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.entry.watches.map((w) => w.path)).toEqual([envrc]);
    }
    expect(warnOnceKeys.has("status-fallback")).toBe(true);
    cleanup();
  });

  test("propagates exportJson blocked error and does not cache", async () => {
    const { path: root, cleanup } = makeTmpDir();
    writeFile(root, ".envrc", "");
    const cache = new DirenvCache();
    const { logger } = makeStubLogger();
    const out = await resolveEnv(
      { cache, config: makeConfig(), log: logger },
      root,
      {
        FAKE_DIRENV_EXIT: "1",
        FAKE_DIRENV_STDERR: ".envrc is blocked. Run `direnv allow`",
      },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("blocked");
    expect(cache.peek(root)).toBeNull();
    cleanup();
  });
});
