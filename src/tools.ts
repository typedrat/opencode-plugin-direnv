import { tool } from "@opencode-ai/plugin";
import type { DirenvCache } from "./cache.ts";
import { classifyForApply } from "./applyEnv.ts";
import { findDirenvRoot } from "./direnv.ts";
import { blockedEnvrcMessage, TOOL_SAFETY_NOTE } from "./messages.ts";
import { resolveEnv } from "./resolveEnv.ts";
import type { Config, Logger } from "./types.ts";

export interface ToolDeps {
  cache: DirenvCache;
  config: Config;
  log: Logger;
  defaultCwd: string;
  /** Test seam, same as in ShellEnvDeps. */
  _spawnExtraEnv?: Record<string, string>;
}

export function makeReloadTool(deps: ToolDeps) {
  return tool({
    description:
      "Reload the direnv environment for the current working directory. " +
      "Use this after the user has edited and allowed an .envrc, or when " +
      "environment variables seem stale. Returns a summary of what changed. " +
      "Variable values are never included in the output — only names and counts." +
      TOOL_SAFETY_NOTE,
    args: {
      cwd: tool.schema
        .string()
        .optional()
        .describe("Directory to resolve direnv against. Defaults to the project worktree."),
    },
    async execute(args) {
      const cwd = (args.cwd as string | undefined) ?? deps.defaultCwd;
      const root = await findDirenvRoot(cwd);
      if (root === null) {
        return `No .envrc found above ${cwd}.`;
      }
      const previous = deps.cache.peek(root);
      deps.cache.invalidate(root);
      const result = await resolveEnv(
        { cache: deps.cache, config: deps.config, log: deps.log },
        root,
        deps._spawnExtraEnv,
      );
      if (!result.ok) {
        return formatResolveError(result, root);
      }
      return formatReloadDiff(root, previous?.env ?? {}, result.entry.env);
    },
  });
}

export function makeStatusTool(deps: ToolDeps) {
  return tool({
    description:
      "Show what direnv is currently contributing to the shell environment. " +
      "Lists the resolved .envrc root, which variables direnv is setting or " +
      "unsetting, and any allow/deny filter that's active. Useful for debugging " +
      "why an env var isn't showing up." +
      TOOL_SAFETY_NOTE,
    args: {
      cwd: tool.schema.string().optional(),
      show_values: tool.schema
        .boolean()
        .optional()
        .default(false)
        .describe("Include variable values in the output. Off by default to avoid leaking secrets."),
    },
    async execute(args) {
      const cwd = (args.cwd as string | undefined) ?? deps.defaultCwd;
      const root = await findDirenvRoot(cwd);
      if (root === null) {
        return `No .envrc found above ${cwd}.`;
      }
      // Use cached entry if present (do not invalidate). On miss, populate.
      let entry = deps.cache.peek(root);
      if (entry === null) {
        const result = await resolveEnv(
          { cache: deps.cache, config: deps.config, log: deps.log },
          root,
          deps._spawnExtraEnv,
        );
        if (!result.ok) {
          return formatResolveError(result, root);
        }
        entry = result.entry;
      }
      return formatStatus(deps.config, root, entry, args.show_values ?? false);
    },
  });
}

// --- formatters ------------------------------------------------------------

function formatResolveError(
  result: { ok: false; kind: string; message: string },
  root: string,
): string {
  if (result.kind === "blocked") {
    return blockedEnvrcMessage(root);
  }
  if (result.kind === "missing-bin") {
    return `direnv binary unavailable: ${result.message}`;
  }
  return `direnv ${result.kind}: ${result.message}`;
}

function formatReloadDiff(
  root: string,
  before: Record<string, string | null>,
  after: Record<string, string | null>,
): string {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];

  // Compare by key, treating null and missing as both "not set" for diff purposes.
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of allKeys) {
    const b = before[k];
    const a = after[k];
    if (b === undefined && a !== undefined) {
      added.push(k);
    } else if (b !== undefined && a === undefined) {
      removed.push(k);
    } else if (b !== a) {
      changed.push(k);
    } else {
      unchanged.push(k);
    }
  }
  const lines: string[] = [];
  lines.push(`direnv reloaded at ${root}`);
  lines.push(`added (${added.length})${added.length ? ":   " + added.sort().join(", ") : ""}`);
  lines.push(`changed (${changed.length})${changed.length ? ": " + changed.sort().join(", ") : ""}`);
  lines.push(`removed (${removed.length})${removed.length ? ": " + removed.sort().join(", ") : ""}`);
  lines.push(`unchanged (${unchanged.length})${unchanged.length ? ": " + unchanged.sort().join(", ") : ""}`);
  return lines.join("\n");
}

function formatStatus(
  config: Config,
  root: string,
  entry: { env: Record<string, string | null>; watches: { path: string; mtime: number }[]; computedAt: number },
  showValues: boolean,
): string {
  const c = classifyForApply(entry.env, config.allow, config.deny);
  const setting = Object.entries(c.apply).filter(([, v]) => v !== null);
  const unsetting = Object.entries(c.apply).filter(([, v]) => v === null).map(([k]) => k);

  const lines: string[] = [];
  lines.push("direnv status");
  lines.push(`root:       ${root}`);
  lines.push(`binary:     ${config.bin}`);
  lines.push(`verbose:    ${config.verbose ? "on" : "off"}`);
  lines.push(`allow list: ${config.allow === null ? "<none>" : [...config.allow].sort().join(", ")}`);
  lines.push(`deny list:  ${config.deny.size === 0 ? "<none>" : [...config.deny].sort().join(", ")}`);
  lines.push(`cached at:  ${new Date(entry.computedAt).toISOString()}`);
  lines.push("");
  lines.push(`watching (${entry.watches.length}):`);
  for (const w of entry.watches) lines.push(`  ${w.path}`);
  lines.push("");
  lines.push(`setting (${setting.length}):`);
  for (const [k, v] of setting.sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(showValues ? `  ${k}=${v}` : `  ${k}`);
  }
  lines.push(`unsetting (${unsetting.length}):`);
  for (const k of unsetting.sort()) lines.push(`  ${k}`);
  if (c.filteredByAllow.length > 0) {
    lines.push(`filtered by allow list (${c.filteredByAllow.length}):`);
    for (const k of c.filteredByAllow.sort()) lines.push(`  ${k}`);
  }
  if (c.filteredByDeny.length > 0) {
    lines.push(`filtered by deny list (${c.filteredByDeny.length}):`);
    for (const k of c.filteredByDeny.sort()) lines.push(`  ${k}`);
  }
  return lines.join("\n");
}
