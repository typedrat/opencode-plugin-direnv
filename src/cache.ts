import { statSync } from "node:fs";
import type { CacheEntry } from "./types.ts";

/**
 * In-memory cache of direnv-resolved environments, keyed by direnv root
 * (the absolute directory containing the active .envrc). Scoped to a single
 * plugin instance — never persisted to disk.
 *
 * Staleness: `get` re-stats every file in `entry.watches` and returns null
 * if any file's current mtime differs from the recorded one, or if a watched
 * file no longer exists. An entry with an empty watch-list is treated as
 * always-fresh (degenerate but valid: nothing to watch means nothing can change).
 */
export class DirenvCache {
  readonly #entries = new Map<string, CacheEntry>();

  /**
   * Returns the cached entry if present AND all watched files have unchanged
   * mtimes; otherwise null. The returned object is the live cache value —
   * callers must treat it as read-only. Mutating `entry.env` or `entry.watches`
   * will corrupt subsequent cache hits.
   */
  async get(root: string): Promise<CacheEntry | null> {
    const entry = this.#entries.get(root);
    if (!entry) return null;
    if (!this.#isFresh(entry)) return null;
    return entry;
  }

  /**
   * Returns the cached entry if present, regardless of staleness. Same
   * read-only contract as `get`.
   */
  peek(root: string): CacheEntry | null {
    return this.#entries.get(root) ?? null;
  }

  set(root: string, entry: CacheEntry): void {
    this.#entries.set(root, entry);
  }

  invalidate(root: string): void {
    this.#entries.delete(root);
  }

  roots(): string[] {
    return [...this.#entries.keys()];
  }

  #isFresh(entry: CacheEntry): boolean {
    for (const watch of entry.watches) {
      let currentMtime: number;
      try {
        currentMtime = statSync(watch.path).mtimeMs;
      } catch {
        return false; // file missing → stale
      }
      // Compare at integer-millisecond precision. The stored mtime may have been
      // parsed from an ISO 8601 string (e.g. from direnv status --json), which
      // only carries millisecond precision. The kernel mtime can have fractional
      // milliseconds; truncating both sides avoids spurious cache misses.
      if (Math.trunc(currentMtime) !== Math.trunc(watch.mtime)) {
        return false;
      }
    }
    return true;
  }
}
