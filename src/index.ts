import type { Plugin } from "@opencode-ai/plugin";
import { DirenvCache } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { makeLogger } from "./log.ts";
import { makeShellEnvHandler } from "./shellEnv.ts";
import { makeReloadTool, makeStatusTool } from "./tools.ts";
import type { PluginState } from "./types.ts";

/**
 * OpenCode plugin: injects direnv-managed environment variables into the
 * agent's and user's shell sessions via the `shell.env` hook, with two
 * companion tools (`direnv_reload`, `direnv_status`) for agent-side debugging.
 *
 * Configured entirely via environment variables — see the README.
 */
export const DirenvPlugin: Plugin = async (ctx) => {
  const log = makeLogger(ctx.client);

  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    await log.warn(`direnv plugin disabled: ${(e as Error).message}`);
    return {};
  }

  const cache = new DirenvCache();
  // Worktree is the right default — it's the git project root, which is
  // typically where the .envrc lives.
  const defaultCwd: string = ctx.worktree ?? ctx.directory;
  const state: PluginState = { lastLoadedRoot: null };

  const sharedDeps = { cache, config, log, defaultCwd };
  return {
    "shell.env": makeShellEnvHandler({ ...sharedDeps, state }),
    tool: {
      direnv_reload: makeReloadTool(sharedDeps),
      direnv_status: makeStatusTool(sharedDeps),
    },
  };
};

export default DirenvPlugin;
