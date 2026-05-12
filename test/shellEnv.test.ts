import { test, expect, describe } from "bun:test";
import { makeShellEnvHandler } from "../src/shellEnv.ts";
import { DirenvCache } from "../src/cache.ts";
import { makeStubLogger, makeTmpDir, writeFile, touch, FAKE_DIRENV_BIN, readDirenvLog } from "./helpers.ts";
import { statSync } from "node:fs";
import type { Config, PluginState } from "../src/types.ts";

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

interface RunOpts {
  inputCwd?: string;
  outputEnv?: Record<string, string | undefined>;
  fakeEnv?: Record<string, string>;
}

async function runHandler(
  deps: {
    cache?: DirenvCache;
    config?: Config;
    defaultCwd?: string;
    state?: PluginState;
    log?: ReturnType<typeof makeStubLogger>;
  },
  opts: RunOpts = {},
) {
  const cache = deps.cache ?? new DirenvCache();
  const config = deps.config ?? makeConfig();
  const defaultCwd = deps.defaultCwd ?? "/never-used";
  const state = deps.state ?? { lastLoadedRoot: null };
  const logStub = deps.log ?? makeStubLogger();
  const handler = makeShellEnvHandler({
    cache, config, defaultCwd, state, log: logStub.logger,
    _spawnExtraEnv: opts.fakeEnv ?? {},
  });
  const output = { env: opts.outputEnv ?? {} };
  await handler({ cwd: opts.inputCwd }, output);
  return { output, logStub, cache, state };
}

describe("shell.env handler", () => {
  test("no-op when no .envrc exists above cwd", async () => {
    const { path, cleanup } = makeTmpDir();
    const { output } = await runHandler({ defaultCwd: path }, { inputCwd: path });
    expect(output.env).toEqual({});
    cleanup();
  });

  test("injects direnv-exported variables into output.env", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const { output } = await runHandler(
      { defaultCwd: root },
      {
        inputCwd: root,
        fakeEnv: {
          FAKE_DIRENV_EXPORT: '{"FOO":"bar"}',
          FAKE_DIRENV_STATUS: statusJsonFor([envrc]),
        },
      },
    );
    expect(output.env.FOO).toBe("bar");
    cleanup();
  });

  test("direnv-wins precedence: overrides existing output.env values", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const { output } = await runHandler(
      { defaultCwd: root },
      {
        inputCwd: root,
        outputEnv: { PATH: "/old" },
        fakeEnv: {
          FAKE_DIRENV_EXPORT: '{"PATH":"/new"}',
          FAKE_DIRENV_STATUS: statusJsonFor([envrc]),
        },
      },
    );
    expect(output.env.PATH).toBe("/new");
    cleanup();
  });

  test("null values delete keys from output.env", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const { output } = await runHandler(
      { defaultCwd: root },
      {
        inputCwd: root,
        outputEnv: { OLD: "value" },
        fakeEnv: {
          FAKE_DIRENV_EXPORT: '{"OLD":null}',
          FAKE_DIRENV_STATUS: statusJsonFor([envrc]),
        },
      },
    );
    expect(output.env.OLD).toBeUndefined();
    cleanup();
  });

  test("allow list filters", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const { output } = await runHandler(
      { defaultCwd: root, config: makeConfig({ allow: new Set(["FOO"]) }) },
      {
        inputCwd: root,
        fakeEnv: {
          FAKE_DIRENV_EXPORT: '{"FOO":"1","BAR":"2"}',
          FAKE_DIRENV_STATUS: statusJsonFor([envrc]),
        },
      },
    );
    expect(output.env).toEqual({ FOO: "1" });
    cleanup();
  });

  test("deny list takes precedence over allow", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const { output } = await runHandler(
      {
        defaultCwd: root,
        config: makeConfig({ allow: new Set(["FOO", "BAR"]), deny: new Set(["FOO"]) }),
      },
      {
        inputCwd: root,
        fakeEnv: {
          FAKE_DIRENV_EXPORT: '{"FOO":"1","BAR":"2"}',
          FAKE_DIRENV_STATUS: statusJsonFor([envrc]),
        },
      },
    );
    expect(output.env).toEqual({ BAR: "2" });
    cleanup();
  });

  test("verbose mode logs injected key names but never values", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const { logStub } = await runHandler(
      { defaultCwd: root, config: makeConfig({ verbose: true }) },
      {
        inputCwd: root,
        fakeEnv: {
          FAKE_DIRENV_EXPORT: '{"SECRET_VALUE":"do-not-log-me"}',
          FAKE_DIRENV_STATUS: statusJsonFor([envrc]),
        },
      },
    );
    const all = logStub.records.map((r) => r.msg + " " + JSON.stringify(r.extra ?? {})).join(" ");
    expect(all).toContain("SECRET_VALUE");
    expect(all).not.toContain("do-not-log-me");
    cleanup();
  });

  test("blocked .envrc → log.warnOnce with safety-aware message, output.env unchanged", async () => {
    const { path: root, cleanup } = makeTmpDir();
    writeFile(root, ".envrc", "");
    const { output, logStub } = await runHandler(
      { defaultCwd: root },
      {
        inputCwd: root,
        outputEnv: { EXISTING: "x" },
        fakeEnv: {
          FAKE_DIRENV_EXIT: "1",
          FAKE_DIRENV_STDERR: ".envrc is blocked. Run `direnv allow`",
        },
      },
    );
    expect(output.env).toEqual({ EXISTING: "x" });
    const blocked = logStub.records.find((r) => /not allowed/i.test(r.msg));
    expect(blocked).toBeDefined();
    expect(blocked!.msg).toMatch(/do not run `direnv allow` yourself/i);
    cleanup();
  });

  test("repeated blocked .envrc calls do not re-warn (warnOnce dedup)", async () => {
    const { path: root, cleanup } = makeTmpDir();
    writeFile(root, ".envrc", "");
    const cache = new DirenvCache();
    const state: PluginState = { lastLoadedRoot: null };
    const log = makeStubLogger();
    const fake = {
      FAKE_DIRENV_EXIT: "1",
      FAKE_DIRENV_STDERR: ".envrc is blocked. Run `direnv allow`",
    };
    await runHandler({ cache, defaultCwd: root, state, log }, { inputCwd: root, fakeEnv: fake });
    await runHandler({ cache, defaultCwd: root, state, log }, { inputCwd: root, fakeEnv: fake });
    const blocked = log.records.filter((r) => /not allowed/i.test(r.msg));
    expect(blocked).toHaveLength(1);
    cleanup();
  });

  test("cache hit: second call does not spawn direnv", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const cache = new DirenvCache();
    const state: PluginState = { lastLoadedRoot: null };
    const logfile = `${root}.log`;
    const fake = {
      FAKE_DIRENV_EXPORT: '{"FOO":"bar"}',
      FAKE_DIRENV_STATUS: statusJsonFor([envrc]),
      FAKE_DIRENV_LOGFILE: logfile,
    };
    await runHandler({ cache, defaultCwd: root, state }, { inputCwd: root, fakeEnv: fake });
    await runHandler({ cache, defaultCwd: root, state }, { inputCwd: root, fakeEnv: fake });
    // First call: 2 invocations (export + status). Second call: 0 (cache hit).
    expect(readDirenvLog(logfile)).toHaveLength(2);
    cleanup();
  });

  test("watch-list invalidation: touching a watched file triggers re-spawn", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const gemfile = writeFile(root, "Gemfile", "");
    const cache = new DirenvCache();
    const state: PluginState = { lastLoadedRoot: null };
    const logfile = `${root}.log`;
    const fake = {
      FAKE_DIRENV_EXPORT: '{"FOO":"bar"}',
      FAKE_DIRENV_STATUS: statusJsonFor([envrc, gemfile]),
      FAKE_DIRENV_LOGFILE: logfile,
    };
    await runHandler({ cache, defaultCwd: root, state }, { inputCwd: root, fakeEnv: fake });
    touch(gemfile);
    await runHandler({ cache, defaultCwd: root, state }, { inputCwd: root, fakeEnv: fake });
    // First call: 2 spawns. Stale → second call: 2 more. Total 4.
    expect(readDirenvLog(logfile)).toHaveLength(4);
    cleanup();
  });

  test("cwd-out unload: leaving the root unsets previously-applied keys", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const outsideDir = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const cache = new DirenvCache();
    const state: PluginState = { lastLoadedRoot: null };

    // First call: inside the root, sets FOO.
    const first = await runHandler(
      { cache, defaultCwd: root, state },
      {
        inputCwd: root,
        fakeEnv: {
          FAKE_DIRENV_EXPORT: '{"FOO":"bar"}',
          FAKE_DIRENV_STATUS: statusJsonFor([envrc]),
        },
      },
    );
    expect(first.output.env.FOO).toBe("bar");
    expect(state.lastLoadedRoot).toBe(root);

    // Second call: outside any .envrc. FOO should be unset.
    const second = await runHandler(
      { cache, defaultCwd: outsideDir.path, state },
      { inputCwd: outsideDir.path, outputEnv: { FOO: "bar", UNRELATED: "x" } },
    );
    expect(second.output.env.FOO).toBeUndefined();
    expect(second.output.env.UNRELATED).toBe("x");
    expect(state.lastLoadedRoot).toBeNull();

    cleanup();
    outsideDir.cleanup();
  });

  test("cwd-cross-root unload: moving to a different root unsets old, sets new", async () => {
    const a = makeTmpDir();
    const b = makeTmpDir();
    const envrcA = writeFile(a.path, ".envrc", "");
    const envrcB = writeFile(b.path, ".envrc", "");
    const cache = new DirenvCache();
    const state: PluginState = { lastLoadedRoot: null };

    await runHandler(
      { cache, defaultCwd: a.path, state },
      {
        inputCwd: a.path,
        fakeEnv: {
          FAKE_DIRENV_EXPORT: '{"FOO":"1"}',
          FAKE_DIRENV_STATUS: statusJsonFor([envrcA]),
        },
      },
    );
    const second = await runHandler(
      { cache, defaultCwd: b.path, state },
      {
        inputCwd: b.path,
        outputEnv: { FOO: "1" }, // simulate the prior env still being present
        fakeEnv: {
          FAKE_DIRENV_EXPORT: '{"BAR":"2"}',
          FAKE_DIRENV_STATUS: statusJsonFor([envrcB]),
        },
      },
    );
    expect(second.output.env.FOO).toBeUndefined();
    expect(second.output.env.BAR).toBe("2");
    expect(state.lastLoadedRoot).toBe(b.path);

    a.cleanup();
    b.cleanup();
  });

  test("hook never throws even when direnv binary is missing mid-session", async () => {
    const { path: root, cleanup } = makeTmpDir();
    writeFile(root, ".envrc", "");
    const { output } = await runHandler(
      { defaultCwd: root, config: makeConfig({ bin: "/totally/missing/direnv" }) },
      { inputCwd: root },
    );
    expect(output.env).toEqual({});
    cleanup();
  });

  test("input.cwd undefined falls back to defaultCwd", async () => {
    const { path: root, cleanup } = makeTmpDir();
    const envrc = writeFile(root, ".envrc", "");
    const { output } = await runHandler(
      { defaultCwd: root },
      {
        fakeEnv: {
          FAKE_DIRENV_EXPORT: '{"FOO":"bar"}',
          FAKE_DIRENV_STATUS: statusJsonFor([envrc]),
        },
      },
    );
    expect(output.env.FOO).toBe("bar");
    cleanup();
  });
});
