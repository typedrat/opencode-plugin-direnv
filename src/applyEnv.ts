/**
 * Pure helper: apply a direnv result to an output env object with allow/deny
 * filtering. `direnv wins` — existing values are overwritten. Null values
 * delete keys (unless the key is denied, in which case the deletion is also
 * suppressed; same logic — deny means "leave this variable alone").
 *
 * @param output Mutable env record (the `output.env` from a shell.env hook).
 * @param resolved direnv export json result.
 * @param allow null = allow all; otherwise only keys in the set are applied.
 * @param deny  empty = deny none; takes precedence over allow.
 */
export function applyEnv(
  output: Record<string, string | undefined>,
  resolved: Record<string, string | null>,
  allow: Set<string> | null,
  deny: Set<string>,
): void {
  for (const [key, value] of Object.entries(resolved)) {
    if (deny.has(key)) continue;
    if (allow !== null && !allow.has(key)) continue;
    if (value === null) {
      delete output[key];
    } else {
      output[key] = value;
    }
  }
}

/**
 * Categorize a resolved env into apply-now and filtered-out buckets.
 * Used by direnv_status to report what's being filtered, and by the
 * shell.env handler for verbose logging.
 */
export function classifyForApply(
  resolved: Record<string, string | null>,
  allow: Set<string> | null,
  deny: Set<string>,
): {
  apply: Record<string, string | null>;
  filteredByAllow: string[];
  filteredByDeny: string[];
} {
  const apply: Record<string, string | null> = {};
  const filteredByAllow: string[] = [];
  const filteredByDeny: string[] = [];
  for (const [key, value] of Object.entries(resolved)) {
    if (deny.has(key)) {
      filteredByDeny.push(key);
      continue;
    }
    if (allow !== null && !allow.has(key)) {
      filteredByAllow.push(key);
      continue;
    }
    apply[key] = value;
  }
  return { apply, filteredByAllow, filteredByDeny };
}
