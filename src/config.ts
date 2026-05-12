import type { Config } from "./types.ts";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Parse a flat env-var record into a Config. Read once at plugin init.
 * Throws ConfigError if the direnv binary cannot be located.
 *
 * Env vars consumed:
 *   OPENCODE_DIRENV_BIN     - explicit path to the direnv binary
 *   OPENCODE_DIRENV_ALLOW   - comma-separated whitelist (empty = allow all)
 *   OPENCODE_DIRENV_DENY    - comma-separated blacklist (takes precedence over allow)
 *   OPENCODE_DIRENV_VERBOSE - "1" or "true" (case-insensitive) enables verbose logging
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const bin = resolveBin(env["OPENCODE_DIRENV_BIN"], env["PATH"]);
  if (!bin) {
    throw new ConfigError(
      "Could not locate direnv binary. Set OPENCODE_DIRENV_BIN to its absolute path, " +
        "or install direnv so it appears on PATH.",
    );
  }

  return {
    bin,
    allow: parseList(env["OPENCODE_DIRENV_ALLOW"]) ?? null,
    deny: parseList(env["OPENCODE_DIRENV_DENY"]) ?? new Set(),
    verbose: parseBool(env["OPENCODE_DIRENV_VERBOSE"]),
  };
}

function resolveBin(explicit: string | undefined, pathEnv: string | undefined): string | null {
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  // Bun.which honors the PATH option; pass it explicitly so tests can isolate.
  return Bun.which("direnv", pathEnv !== undefined ? { PATH: pathEnv } : undefined);
}

/** Parse "A, B, ,C" → Set(["A","B","C"]). Returns null for empty/unset. */
function parseList(raw: string | undefined): Set<string> | null {
  if (!raw) return null;
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) return null;
  return new Set(names);
}

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return lower === "1" || lower === "true";
}
