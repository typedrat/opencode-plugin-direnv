import { test, expect, describe } from "bun:test";
import { DirenvPlugin } from "../src/index.ts";
import { makeTmpDir, writeFile, FAKE_DIRENV_BIN } from "./helpers.ts";
import { statSync } from "node:fs";

function makeCtx(directory: string, worktree?: string) {
  const calls: Array<{ body: any }> = [];
  return {
    ctx: {
      project: { id: "p", worktree: worktree ?? directory },
      directory,
      worktree: worktree ?? directory,
      $: undefined as any,
      client: {
        app: {
          log: async (call: any) => {
            calls.push(call);
          },
        },
      },
    } as any,
    logCalls: calls,
  };
}

describe("DirenvPlugin", () => {
  test("returns an empty plugin (no hooks) when config init fails", async () => {
    const orig = process.env.OPENCODE_DIRENV_BIN;
    const origPath = process.env.PATH;
    process.env.OPENCODE_DIRENV_BIN = "";
    process.env.PATH = "";
    try {
      const { ctx } = makeCtx("/tmp");
      const plugin = await DirenvPlugin(ctx);
      expect(plugin["shell.env"]).toBeUndefined();
      expect(plugin.tool).toBeUndefined();
    } finally {
      if (orig === undefined) delete process.env.OPENCODE_DIRENV_BIN;
      else process.env.OPENCODE_DIRENV_BIN = orig;
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
    }
  });

  test("wires shell.env hook and both tools when config succeeds", async () => {
    const orig = process.env.OPENCODE_DIRENV_BIN;
    process.env.OPENCODE_DIRENV_BIN = FAKE_DIRENV_BIN;
    try {
      const { path, cleanup } = makeTmpDir();
      const { ctx } = makeCtx(path);
      const plugin = await DirenvPlugin(ctx);
      expect(typeof plugin["shell.env"]).toBe("function");
      expect(plugin.tool).toBeDefined();
      expect(plugin.tool!.direnv_reload).toBeDefined();
      expect(plugin.tool!.direnv_status).toBeDefined();
      cleanup();
    } finally {
      if (orig === undefined) delete process.env.OPENCODE_DIRENV_BIN;
      else process.env.OPENCODE_DIRENV_BIN = orig;
    }
  });

  test("shell.env hook + reload tool share the same cache (end-to-end)", async () => {
    const orig = process.env.OPENCODE_DIRENV_BIN;
    process.env.OPENCODE_DIRENV_BIN = FAKE_DIRENV_BIN;
    try {
      const { path: root, cleanup } = makeTmpDir();
      const envrc = writeFile(root, ".envrc", "");
      const status = JSON.stringify({
        state: {
          foundRC: {
            watches: [{ Path: envrc, Modified: new Date(statSync(envrc).mtimeMs).toISOString() }],
          },
        },
      });

      // We can't pass fakeEnv through the public API (no test seam in index.ts),
      // so we drive the fake direnv via process.env directly for this test.
      const prevExport = process.env.FAKE_DIRENV_EXPORT;
      const prevStatus = process.env.FAKE_DIRENV_STATUS;
      process.env.FAKE_DIRENV_EXPORT = '{"FOO":"bar"}';
      process.env.FAKE_DIRENV_STATUS = status;

      try {
        const { ctx } = makeCtx(root);
        const plugin = await DirenvPlugin(ctx);

        // Call the hook: should set FOO.
        const out: { env: Record<string, string | undefined> } = { env: {} };
        await plugin["shell.env"]!({ cwd: root }, out);
        expect(out.env.FOO).toBe("bar");

        // Change what direnv returns; call the reload tool.
        process.env.FAKE_DIRENV_EXPORT = '{"FOO":"baz"}';
        const reloadResult = await plugin.tool!.direnv_reload.execute({ cwd: root }, {} as any);
        expect(reloadResult).toMatch(/changed/i);

        // Next hook call sees the new value (no spawn — cache was set by reload).
        const out2: { env: Record<string, string | undefined> } = { env: {} };
        await plugin["shell.env"]!({ cwd: root }, out2);
        expect(out2.env.FOO).toBe("baz");
      } finally {
        if (prevExport === undefined) delete process.env.FAKE_DIRENV_EXPORT;
        else process.env.FAKE_DIRENV_EXPORT = prevExport;
        if (prevStatus === undefined) delete process.env.FAKE_DIRENV_STATUS;
        else process.env.FAKE_DIRENV_STATUS = prevStatus;
      }
      cleanup();
    } finally {
      if (orig === undefined) delete process.env.OPENCODE_DIRENV_BIN;
      else process.env.OPENCODE_DIRENV_BIN = orig;
    }
  });
});
