import type { DirenvCache } from "./cache.ts";
import { applyEnv, classifyForApply } from "./applyEnv.ts";
import { findDirenvRoot } from "./direnv.ts";
import { blockedEnvrcMessage } from "./messages.ts";
import { resolveEnv } from "./resolveEnv.ts";
import type { Config, Logger, PluginState } from "./types.ts";

export interface ShellEnvDeps {
  cache: DirenvCache;
  config: Config;
  log: Logger;
  defaultCwd: string;
  state: PluginState;
  /**
   * Test seam: extra env merged into every direnv subprocess call.
   * Production callers omit this; tests use it to drive the fake-direnv binary.
   */
  _spawnExtraEnv?: Record<string, string>;
}

/**
 * Build the shell.env hook handler. The handler:
 *
 *   1. Resolves cwd = input.cwd ?? defaultCwd.
 *   2. Finds the nearest .envrc (direnv root) above cwd.
 *   3. If we previously loaded a different root (or no root applies now),
 *      unsets the previous root's variables from output.env first.
 *   4. If a root is found, resolves direnv env via the cache, applies it
 *      with allow/deny filtering, and updates state.lastLoadedRoot.
 *
 * The entire handler is wrapped in try/catch — a plugin bug must never
 * break shell execution.
 */
export function makeShellEnvHandler(deps: ShellEnvDeps) {
  return async (
    input: { cwd?: string | undefined },
    output: { env: Record<string, string | undefined> },
  ): Promise<void> => {
    try {
      const cwd = input.cwd ?? deps.defaultCwd;
      const root = await findDirenvRoot(cwd);

      // Step 1: cwd-out / cross-root unload of the previous root, if any.
      if (deps.state.lastLoadedRoot !== null && deps.state.lastLoadedRoot !== root) {
        await unloadPrevious(deps, output);
      }

      // Step 2: no .envrc → done after unload.
      if (root === null) {
        deps.state.lastLoadedRoot = null;
        return;
      }

      // Step 3: resolve + apply.
      const result = await resolveEnv(
        { cache: deps.cache, config: deps.config, log: deps.log },
        root,
        deps._spawnExtraEnv,
      );
      if (!result.ok) {
        if (result.kind === "blocked") {
          await deps.log.warnOnce(`blocked:${root}`, blockedEnvrcMessage(root));
        } else if (result.kind === "missing-bin") {
          await deps.log.warnOnce(
            "missing-bin",
            `direnv binary unavailable (${result.message}); skipping env injection.`,
          );
        } else {
          await deps.log.error(`direnv ${result.kind}: ${result.message}`);
        }
        // Do not update lastLoadedRoot; we did not apply anything for `root`.
        return;
      }

      const classification = classifyForApply(
        result.entry.env,
        deps.config.allow,
        deps.config.deny,
      );
      applyEnv(output.env, result.entry.env, deps.config.allow, deps.config.deny);

      if (deps.config.verbose) {
        const setting = Object.entries(classification.apply)
          .filter(([, v]) => v !== null)
          .map(([k]) => k);
        const unsetting = Object.entries(classification.apply)
          .filter(([, v]) => v === null)
          .map(([k]) => k);
        await deps.log.info("direnv applied", {
          root,
          fromCache: result.fromCache,
          setting,
          unsetting,
          filteredByAllow: classification.filteredByAllow,
          filteredByDeny: classification.filteredByDeny,
        });
      }

      deps.state.lastLoadedRoot = root;
    } catch (e) {
      // Top-level safety net. Logging itself may fail; swallow that too.
      try {
        await deps.log.error(`shell.env handler crashed: ${(e as Error).message}`);
      } catch {
        // intentionally empty
      }
    }
  };
}

async function unloadPrevious(
  deps: ShellEnvDeps,
  output: { env: Record<string, string | undefined> },
): Promise<void> {
  const prev = deps.state.lastLoadedRoot;
  if (prev === null) return;
  const entry = deps.cache.peek(prev);
  if (entry === null) {
    // Evicted between load and unload — best-effort, can't un-set what we don't remember.
    if (deps.config.verbose) {
      await deps.log.info("direnv unload skipped (cache evicted)", { root: prev });
    }
    return;
  }
  // For every key the previous root SET (string value), delete it.
  // For every key it UNSET (null value), there's nothing to do — we never set it.
  for (const [key, value] of Object.entries(entry.env)) {
    if (deps.config.deny.has(key)) continue;
    if (deps.config.allow !== null && !deps.config.allow.has(key)) continue;
    if (value !== null) {
      delete output.env[key];
    }
  }
  if (deps.config.verbose) {
    await deps.log.info("direnv unloaded", { root: prev });
  }
}
