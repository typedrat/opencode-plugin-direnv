import { test, expect, describe } from "bun:test";
import { makeReloadTool, makeStatusTool } from "../src/tools.ts";
import { DirenvCache } from "../src/cache.ts";
import { makeStubLogger, makeTmpDir, writeFile, FAKE_DIRENV_BIN, readDirenvLog } from "./helpers.ts";
import { TOOL_SAFETY_NOTE } from "../src/messages.ts";
import { statSync } from "node:fs";
import type { Config } from "../src/types.ts";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return { bin: FAKE_DIRENV_BIN, allow: null, deny: new Set(), verbose: false, ...overrides };
}

function statusJsonFor(watchedFiles: string[]): string {
  return JSON.stringify({
    state: {
      foundRC: {
        watches: watchedFiles.map((p) => ({
          Path: p,
          Modified: new Date(statSync(p).mtimeMs).toISOString(),
        })),
      },
    },
  });
}

function makeDeps(defaultCwd: string, configOverrides: Partial<Config> = {}) {
  const cache = new DirenvCache();
  const config = makeConfig(configOverrides);
  const log = makeStubLogger();
  return { cache, config, log: log.logger, defaultCwd, logStub: log };
}

// Minimal context object passed to tool.execute. The real OpenCode passes
// many more fields, but the tools only need this for cwd defaulting.
const fakeContext = {} as any;

describe("direnv_reload tool", () => {
  test("description includes the safety note", () => {
    const deps = makeDeps("/tmp");
    const tool = makeReloadTool({ ...deps, log: deps.log });
    expect(tool.description).toContain(TOOL_SAFETY_NOTE.trim());
  });

  test("returns 'no .envrc' message when none exists above cwd", async () => {
    const { path, cleanup } = makeTmpDir();
    const deps = makeDeps(path);
    const tool = makeReloadTool({ ...deps, log: deps.log, _spawnExtraEnv: {} });
    const result = await tool.execute({ cwd: path }, fakeContext);
    expect(result).toMatch(/no \.envrc found/i);
    expect(result).toContain(path);
    cleanup();
  });

  test("reports added / changed / removed / unchanged on a real reload", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const deps = makeDeps(root);
    // Pre-seed cache with an old env.
    deps.cache.set(root, {
      env: { OLD: "gone", CHANGED: "before", SAME: "same" },
      watches: [{ path: envrc, mtime: 0 /* force stale */ }],
      computedAt: 0,
    });
    const tool = makeReloadTool({
      ...deps,
      log: deps.log,
      _spawnExtraEnv: {
        FAKE_DIRENV_EXPORT: JSON.stringify({ NEW: "yes", CHANGED: "after", SAME: "same" }),
        FAKE_DIRENV_STATUS: statusJsonFor([envrc]),
      },
    });
    const result = await tool.execute({ cwd: root }, fakeContext);
    expect(result).toContain("added (1)");
    expect(result).toContain("NEW");
    expect(result).toContain("changed (1)");
    expect(result).toContain("CHANGED");
    expect(result).toContain("removed (1)");
    expect(result).toContain("OLD");
    expect(result).toContain("unchanged");
    expect(result).toContain("SAME"); // appears as "unchanged"
    // VALUES MUST NOT appear in the output.
    expect(result).not.toContain("after");
    expect(result).not.toContain("before");
    expect(result).not.toContain("gone");
    expect(result).not.toContain("yes");
    cleanup();
  });

  test("blocked .envrc returns the safety-aware message", async () => {
    const { path: root, cleanup } = makeTmpDir();
    writeFile(root, ".envrc", "");
    const deps = makeDeps(root);
    const tool = makeReloadTool({
      ...deps,
      log: deps.log,
      _spawnExtraEnv: {
        FAKE_DIRENV_EXIT: "1",
        FAKE_DIRENV_STDERR: ".envrc is blocked. Run `direnv allow`",
      },
    });
    const result = await tool.execute({ cwd: root }, fakeContext);
    expect(result).toMatch(/do not run `direnv allow` yourself/i);
    expect(result).toMatch(/show .* contents to the user/i);
    expect(result).toContain(root);
    cleanup();
  });

  test("invalidates the cache: subsequent shell.env hook re-spawns direnv", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const logfile = `${root}.log`;
    const deps = makeDeps(root);
    // Pre-seed cache so a hook call would otherwise be a no-spawn hit.
    deps.cache.set(root, {
      env: { OLD: "v" },
      watches: [{ path: envrc, mtime: statSync(envrc).mtimeMs }],
      computedAt: 0,
    });
    const tool = makeReloadTool({
      ...deps,
      log: deps.log,
      _spawnExtraEnv: {
        FAKE_DIRENV_EXPORT: '{"NEW":"v"}',
        FAKE_DIRENV_STATUS: statusJsonFor([envrc]),
        FAKE_DIRENV_LOGFILE: logfile,
      },
    });
    await tool.execute({ cwd: root }, fakeContext);
    // Reload itself runs export+status once (2 invocations).
    expect(readDirenvLog(logfile)).toHaveLength(2);
    // The cache now reflects {"NEW":"v"}.
    expect(deps.cache.peek(root)!.env).toEqual({ NEW: "v" });
    cleanup();
  });

  test("uses defaultCwd when args.cwd is omitted", async () => {
    const { path: root, cleanup } = makeTmpDir();
    writeFile(root, ".envrc", "");
    const deps = makeDeps(root);
    const tool = makeReloadTool({
      ...deps,
      log: deps.log,
      _spawnExtraEnv: {
        FAKE_DIRENV_EXPORT: '{"FOO":"bar"}',
        FAKE_DIRENV_STATUS: '{"state":{"foundRC":{"watches":[]}}}',
      },
    });
    const result = await tool.execute({}, fakeContext);
    expect(result).toMatch(/reloaded/i);
    cleanup();
  });
});

describe("direnv_status tool", () => {
  test("description includes the safety note", () => {
    const deps = makeDeps("/tmp");
    const tool = makeStatusTool({ ...deps, log: deps.log });
    expect(tool.description).toContain(TOOL_SAFETY_NOTE.trim());
  });

  test("returns 'no .envrc' message when none exists", async () => {
    const { path, cleanup } = makeTmpDir();
    const deps = makeDeps(path);
    const tool = makeStatusTool({ ...deps, log: deps.log, _spawnExtraEnv: {} });
    const result = await tool.execute({ cwd: path }, fakeContext);
    expect(result).toMatch(/no \.envrc found/i);
    cleanup();
  });

  test("reads from cache without invalidating; no spawn on second call", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const logfile = `${root}.log`;
    const deps = makeDeps(root);
    const tool = makeStatusTool({
      ...deps,
      log: deps.log,
      _spawnExtraEnv: {
        FAKE_DIRENV_EXPORT: '{"FOO":"bar"}',
        FAKE_DIRENV_STATUS: statusJsonFor([envrc]),
        FAKE_DIRENV_LOGFILE: logfile,
      },
    });
    // First call populates cache (2 invocations).
    await tool.execute({ cwd: root }, fakeContext);
    // Second call should be a cache hit, no new invocations.
    await tool.execute({ cwd: root }, fakeContext);
    expect(readDirenvLog(logfile)).toHaveLength(2);
    cleanup();
  });

  test("shows only variable names by default (no values)", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const deps = makeDeps(root);
    const tool = makeStatusTool({
      ...deps,
      log: deps.log,
      _spawnExtraEnv: {
        FAKE_DIRENV_EXPORT: '{"PUBLIC_KEY":"abc","SECRET_TOKEN":"xyz","OLD":null}',
        FAKE_DIRENV_STATUS: statusJsonFor([envrc]),
      },
    });
    const result = await tool.execute({ cwd: root }, fakeContext);
    expect(result).toContain("PUBLIC_KEY");
    expect(result).toContain("SECRET_TOKEN");
    expect(result).toContain("OLD");
    expect(result).not.toContain("abc");
    expect(result).not.toContain("xyz");
    cleanup();
  });

  test("shows values when show_values:true", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const deps = makeDeps(root);
    const tool = makeStatusTool({
      ...deps,
      log: deps.log,
      _spawnExtraEnv: {
        FAKE_DIRENV_EXPORT: '{"FOO":"bar-value"}',
        FAKE_DIRENV_STATUS: statusJsonFor([envrc]),
      },
    });
    const result = await tool.execute({ cwd: root, show_values: true }, fakeContext);
    expect(result).toContain("FOO");
    expect(result).toContain("bar-value");
    cleanup();
  });

  test("lists deny-filtered variables in their own section", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const deps = makeDeps(root, { deny: new Set(["SECRET_TOKEN"]) });
    const tool = makeStatusTool({
      ...deps,
      log: deps.log,
      _spawnExtraEnv: {
        FAKE_DIRENV_EXPORT: '{"FOO":"a","SECRET_TOKEN":"x"}',
        FAKE_DIRENV_STATUS: statusJsonFor([envrc]),
      },
    });
    const result = await tool.execute({ cwd: root }, fakeContext);
    expect(result).toMatch(/filtered by deny/i);
    expect(result).toContain("SECRET_TOKEN");
    cleanup();
  });

  test("lists the resolved watch-list files", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const gemfile = writeFile(root, "Gemfile", "");
    const deps = makeDeps(root);
    const tool = makeStatusTool({
      ...deps,
      log: deps.log,
      _spawnExtraEnv: {
        FAKE_DIRENV_EXPORT: '{"FOO":"bar"}',
        FAKE_DIRENV_STATUS: statusJsonFor([envrc, gemfile]),
      },
    });
    const result = await tool.execute({ cwd: root }, fakeContext);
    expect(result).toContain(envrc);
    expect(result).toContain(gemfile);
    cleanup();
  });

  test("blocked .envrc returns safety-aware message", async () => {
    const { path: root, cleanup } = makeTmpDir();
    writeFile(root, ".envrc", "");
    const deps = makeDeps(root);
    const tool = makeStatusTool({
      ...deps,
      log: deps.log,
      _spawnExtraEnv: {
        FAKE_DIRENV_EXIT: "1",
        FAKE_DIRENV_STDERR: ".envrc is blocked. Run `direnv allow`",
      },
    });
    const result = await tool.execute({ cwd: root }, fakeContext);
    expect(result).toMatch(/do not run `direnv allow` yourself/i);
    cleanup();
  });
});
