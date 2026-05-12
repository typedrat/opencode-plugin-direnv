// All shared types for opencode-plugin-direnv.
// This module has no runtime code and no imports from other src/ files,
// keeping the rest of the codebase a clean DAG.

/**
 * A single entry in direnv's watch-list. Each entry tracks a file whose
 * mtime change should trigger a reload. The plugin re-stats every entry
 * on each shell.env hook to detect staleness.
 */
export interface WatchEntry {
  /** Absolute filesystem path. */
  path: string;
  /** Milliseconds since epoch, as returned by direnv status --json (or our stat fallback). */
  mtime: number;
}

/**
 * The fully-resolved configuration for a plugin instance, derived from
 * environment variables at init time.
 */
export interface Config {
  /** Absolute path to the direnv binary. */
  bin: string;
  /** Whitelist of variable names; null = allow all. */
  allow: Set<string> | null;
  /** Blacklist of variable names; empty set = deny none. Takes precedence over `allow`. */
  deny: Set<string>;
  /** When true, log every injected/removed variable name (never values). */
  verbose: boolean;
}

/** Result of `direnv export json`. */
export type ExportResult =
  | { ok: true; env: Record<string, string | null> }
  | {
      ok: false;
      kind: "missing-bin" | "blocked" | "exec-error" | "parse-error";
      message: string;
    };

/** Result of `direnv status --json`. */
export type StatusResult =
  | { ok: true; watches: WatchEntry[] }
  | {
      ok: false;
      kind: "missing-bin" | "exec-error" | "parse-error" | "schema-mismatch";
      message: string;
    };

/** One cache entry per direnv root. */
export interface CacheEntry {
  /** Variables direnv wants to set (string) or unset (null). */
  env: Record<string, string | null>;
  /** The watch-list direnv reported alongside this env. Used for staleness checks. */
  watches: WatchEntry[];
  /** When this entry was computed (ms since epoch), for status display. */
  computedAt: number;
}

/**
 * Mutable per-instance state, owned by the plugin entry point.
 * Used by the shell.env handler to implement cwd-out unload semantics.
 */
export interface PluginState {
  /** The most recently applied direnv root, or null if none / unloaded. */
  lastLoadedRoot: string | null;
}

/**
 * Minimal logger interface; the concrete implementation lives in log.ts.
 * Declared here so other modules can depend on the interface without
 * importing the log module directly.
 */
export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): Promise<void>;
  info(msg: string, extra?: Record<string, unknown>): Promise<void>;
  warn(msg: string, extra?: Record<string, unknown>): Promise<void>;
  error(msg: string, extra?: Record<string, unknown>): Promise<void>;
  /** Like `warn`, but no-op if `key` has been seen before in this logger instance. */
  warnOnce(key: string, msg: string, extra?: Record<string, unknown>): Promise<void>;
}
