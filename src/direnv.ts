import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExportResult, StatusResult, WatchEntry } from "./types.ts";

/**
 * Walk up from `cwd` looking for the nearest `.envrc`. Returns the absolute
 * directory containing it, or null if none exists up to the filesystem root.
 */
export async function findDirenvRoot(cwd: string): Promise<string | null> {
  let current = resolve(cwd);
  // Loop bounded by reaching the filesystem root (where dirname(x) === x).
  while (true) {
    if (existsSync(join(current, ".envrc"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Run `direnv export json` in `cwd`. Returns the parsed env diff or a
 * classified error. `extraEnv` is merged into the subprocess environment;
 * tests use it to drive the fake-direnv binary.
 */
export async function exportJson(
  bin: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<ExportResult> {
  const result = await runDirenv(bin, ["export", "json"], cwd, extraEnv);
  if (result.kind === "spawn-failed") {
    return { ok: false, kind: "missing-bin", message: result.message };
  }
  if (result.exitCode !== 0) {
    if (isBlockedStderr(result.stderr)) {
      return { ok: false, kind: "blocked", message: result.stderr.trim() };
    }
    return {
      ok: false,
      kind: "exec-error",
      message: `direnv export json exited ${result.exitCode}: ${result.stderr.trim()}`,
    };
  }
  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) {
    return { ok: true, env: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return {
      ok: false,
      kind: "parse-error",
      message: `direnv export json: invalid JSON: ${(e as Error).message}`,
    };
  }
  if (!isStringOrNullRecord(parsed)) {
    return {
      ok: false,
      kind: "parse-error",
      message: "direnv export json: expected a JSON object of string-or-null values",
    };
  }
  return { ok: true, env: parsed };
}

/**
 * Run `direnv status --json` in `cwd`. Returns the watch-list (which may be
 * empty if no .envrc is active) or a classified error.
 */
export async function statusJson(
  bin: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<StatusResult> {
  const result = await runDirenv(bin, ["status", "--json"], cwd, extraEnv);
  if (result.kind === "spawn-failed") {
    return { ok: false, kind: "missing-bin", message: result.message };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      kind: "exec-error",
      message: `direnv status --json exited ${result.exitCode}: ${result.stderr.trim()}`,
    };
  }
  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) {
    return { ok: true, watches: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return {
      ok: false,
      kind: "parse-error",
      message: `direnv status --json: invalid JSON: ${(e as Error).message}`,
    };
  }
  const extracted = extractWatches(parsed);
  if (extracted === "schema-mismatch") {
    return {
      ok: false,
      kind: "schema-mismatch",
      message: "direnv status --json: unexpected shape for state.foundRC.watches",
    };
  }
  return { ok: true, watches: extracted };
}

// --- internals -------------------------------------------------------------

interface RunResult {
  kind: "ran" | "spawn-failed";
  exitCode: number;
  stdout: string;
  stderr: string;
  message: string;
}

async function runDirenv(
  bin: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string>,
): Promise<RunResult> {
  // Pre-check: Bun.spawn throws synchronously if the binary doesn't exist.
  // We classify that uniformly as "spawn-failed".
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return {
      kind: "spawn-failed",
      exitCode: -1,
      stdout: "",
      stderr: "",
      message: `Failed to spawn ${bin}: ${(e as Error).message}`,
    };
  }
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    const exitCode = await proc.exited;
    return { kind: "ran", exitCode, stdout, stderr, message: "" };
  } catch (e) {
    return {
      kind: "spawn-failed",
      exitCode: -1,
      stdout: "",
      stderr: "",
      message: `Failed to spawn ${bin}: ${(e as Error).message}`,
    };
  }
}

function isBlockedStderr(stderr: string): boolean {
  // direnv prints messages like:
  //   direnv: error /path/.envrc is blocked. Run `direnv allow` to approve its content
  // Match on the stable substring.
  return /\.envrc is blocked\b/.test(stderr) || /is blocked\. Run `direnv allow`/.test(stderr);
}

function isStringOrNullRecord(x: unknown): x is Record<string, string | null> {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  for (const v of Object.values(x as Record<string, unknown>)) {
    if (v !== null && typeof v !== "string") return false;
  }
  return true;
}

/**
 * Extract the watch-list from a parsed direnv status --json document.
 * Returns "schema-mismatch" if the document has the foundRC.watches field
 * but the entries don't match the expected shape.
 *
 * Expected shape:
 *   { state: { foundRC: { watches: [ { Path: string, Modified: ISO8601-string }, ... ] } } }
 *
 * Absent foundRC → empty watches, ok.
 */
function extractWatches(doc: unknown): WatchEntry[] | "schema-mismatch" {
  if (doc === null || typeof doc !== "object") return "schema-mismatch";
  const state = (doc as { state?: unknown }).state;
  if (state === undefined) return [];
  if (state === null || typeof state !== "object") return "schema-mismatch";
  const foundRC = (state as { foundRC?: unknown }).foundRC;
  if (foundRC === undefined || foundRC === null) return [];
  if (typeof foundRC !== "object") return "schema-mismatch";
  const watches = (foundRC as { watches?: unknown }).watches;
  if (watches === undefined) return [];
  if (!Array.isArray(watches)) return "schema-mismatch";

  const out: WatchEntry[] = [];
  for (const entry of watches) {
    if (entry === null || typeof entry !== "object") return "schema-mismatch";
    const path = (entry as { Path?: unknown }).Path;
    const modified = (entry as { Modified?: unknown }).Modified;
    if (typeof path !== "string" || typeof modified !== "string") {
      return "schema-mismatch";
    }
    const mtime = Date.parse(modified);
    if (Number.isNaN(mtime)) {
      // Fall back to stat-now if direnv's timestamp is unparseable.
      try {
        const st = statSync(path);
        out.push({ path, mtime: st.mtimeMs });
      } catch {
        return "schema-mismatch";
      }
    } else {
      out.push({ path, mtime });
    }
  }
  return out;
}
