import { statSync } from "node:fs";
import { join } from "node:path";
import type { DirenvCache } from "./cache.ts";
import { exportJson, statusJson } from "./direnv.ts";
import type { CacheEntry, Config, Logger, WatchEntry } from "./types.ts";

export interface ResolveDeps {
  cache: DirenvCache;
  config: Config;
  log: Logger;
}

export type ResolveResult =
  | { ok: true; entry: CacheEntry; fromCache: boolean }
  | {
      ok: false;
      kind: "missing-bin" | "blocked" | "exec-error" | "parse-error";
      message: string;
    };

/**
 * Resolve direnv's env + watch-list for a given root, consulting the cache.
 *
 * - Cache hit (fresh): returns the existing entry, no subprocess.
 * - Cache miss/stale: spawns `direnv export json` and `direnv status --json`
 *   in parallel, builds a CacheEntry, stores it, returns it.
 * - On exportJson error: returns the classified failure. Does NOT cache.
 * - On statusJson failure (any kind): falls back to watching only
 *   `<root>/.envrc` by its current mtime, logs warnOnce("status-fallback").
 *
 * `extraEnv` is passed through to the subprocess; tests use it to drive
 * the fake-direnv binary.
 */
export async function resolveEnv(
  deps: ResolveDeps,
  root: string,
  extraEnv: Record<string, string> = {},
): Promise<ResolveResult> {
  const cached = await deps.cache.get(root);
  if (cached !== null) {
    return { ok: true, entry: cached, fromCache: true };
  }

  const [exp, stat] = await Promise.all([
    exportJson(deps.config.bin, root, extraEnv),
    statusJson(deps.config.bin, root, extraEnv),
  ]);

  if (!exp.ok) {
    // Surface export errors directly; the caller (shell.env handler or tool)
    // decides how to message them.
    return { ok: false, kind: exp.kind, message: exp.message };
  }

  let watches: WatchEntry[];
  if (stat.ok) {
    watches = stat.watches;
  } else {
    await deps.log.warnOnce(
      "status-fallback",
      `direnv status --json unavailable (${stat.kind}); falling back to .envrc-only mtime tracking. Reload via direnv_reload if watched files (e.g. via watch_file, on_git_branch) change.`,
    );
    watches = fallbackWatches(root);
  }

  const entry: CacheEntry = { env: exp.env, watches, computedAt: Date.now() };
  deps.cache.set(root, entry);
  return { ok: true, entry, fromCache: false };
}

function fallbackWatches(root: string): WatchEntry[] {
  const path = join(root, ".envrc");
  try {
    const mtime = statSync(path).mtimeMs;
    return [{ path, mtime }];
  } catch {
    // .envrc deleted between findDirenvRoot and stat — degenerate; no watches.
    return [];
  }
}
