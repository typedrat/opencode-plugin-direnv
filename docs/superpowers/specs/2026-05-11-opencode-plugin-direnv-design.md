# opencode-plugin-direnv — Design

**Date:** 2026-05-11
**Status:** Approved for implementation planning

## Summary

An OpenCode plugin that gives the agent (and the user's terminals launched
through OpenCode) the same environment `direnv` would produce for the current
working directory. Variables are injected via the `shell.env` hook, cached by
direnv-root with mtime-based invalidation, and made inspectable and refreshable
via two custom tools: `direnv_reload` and `direnv_status`.

Distributed as the npm package `opencode-plugin-direnv` and authored as a
TypeScript Bun module with zero runtime dependencies.

## Motivation

`direnv` is the dominant convention for per-directory environment management in
developer workflows — project-specific `PATH` entries, language toolchain
versions (`use flake`, `use nix`, `mise`), service credentials, and so on. When
an OpenCode agent runs `bash` or any shell-touching tool, it does not inherit
this environment unless something puts it there. The result is friction: the
agent sees a different `PATH` than the user's shell, can't find project-local
binaries, and reports confusing errors.

This plugin closes that gap by making direnv's environment authoritative for
every shell invocation OpenCode performs.

## Goals

- Inject direnv-managed variables into `output.env` on every `shell.env` hook
  call, scoped to the invocation's `cwd`.
- Respect `.envrc` allow/block status — never bypass direnv's security model.
- Be fast enough that the latency overhead is invisible in interactive use
  (cached path < 5ms).
- Fail gracefully and visibly when direnv is missing, blocked, or broken —
  never crash a shell call.
- Give the agent first-class tools to reload and inspect direnv state for
  debugging.

## Non-goals

- Reimplementing `.envrc` evaluation. We shell out to direnv.
- Watching `.envrc` files for changes in the background. Invalidation is
  lazy (mtime-checked on the next `shell.env` call).
- Configuration via `opencode.json`. All configuration is via environment
  variables.
- Supporting non-Bun runtimes. OpenCode plugins run under Bun; we use Bun
  APIs directly.

## Approach

`direnv` ships a stable JSON export contract: `direnv export json` run with a
given `cwd` emits a JSON object mapping variable names to either string values
(set/change) or `null` (unset). We invoke this binary per direnv-root and
cache the result. The same contract is what `direnv`'s editor integrations and
tools like `mise` use, so it's well-trodden ground.

Alternatives considered and rejected:

- **`direnv exec <dir> env -0` + diff against `process.env`** — works without
  the JSON contract but is brittle (`SHLVL`, `_`, and other noise leak through)
  and slower (extra `env` process).
- **Reimplementing `.envrc` parsing in JS** — `.envrc` files routinely
  `source_up`, `use flake`, `use nix`, `dotenv`, etc. Reimplementing direnv's
  stdlib is a nightmare and would diverge from upstream.

## Architecture

```
opencode-plugin-direnv/
├── src/
│   ├── index.ts        # Plugin entry: shell.env hook + tool registration
│   ├── direnv.ts       # Bun.spawn wrapper around `direnv export json`
│   ├── cache.ts        # mtime-keyed in-memory cache
│   ├── config.ts       # env-var → typed Config (called once at init)
│   ├── log.ts          # client.app.log wrapper + warnOnce dedup
│   └── tools.ts        # direnv_reload, direnv_status tool definitions
├── test/
│   ├── direnv.test.ts
│   ├── cache.test.ts
│   ├── config.test.ts
│   ├── plugin.test.ts
│   ├── tools.test.ts
│   └── fixtures/
│       └── fake-direnv # bash script: emits canned JSON, configurable exit
├── package.json        # name: opencode-plugin-direnv, type: module
├── tsconfig.json
├── README.md
└── LICENSE             # MIT
```

### Data flow — `shell.env` hook

```
shell.env hook fires
  │
  ▼
cwd = input.cwd ?? project.worktree ?? project.directory
  │
  ▼
findDirenvRoot(cwd)              ── walk up looking for .envrc, stop at fs root
  │
  ├── none → return (no-op)
  │
  ▼
cache.get(root)                  ── re-stats tracked files for mtime
  │
  ├── hit, mtimes unchanged → use cached env
  │
  └── miss or stale
        │
        ▼
      direnv.exportJson(bin, root)   ── Bun.spawn([bin, "export", "json"], { cwd: root })
        │
        ├── exit ≠ 0 / missing bin / blocked .envrc
        │     → log.warnOnce, cache empty env (so we don't respawn endlessly)
        │
        ▼
      parse JSON → Record<string, string | null>
        │
        ▼
      cache.set(root, { env, mtimes })
  │
  ▼
applyEnv(output.env, resolvedEnv, allow, deny)
  ├── deny list wins over allow list
  ├── null value → delete output.env[key]
  ├── string value → set output.env[key] (overrides existing — direnv wins)
  └── verbose → log injected/removed key names (never values)
```

Top-level handler is wrapped in `try/catch` that logs and swallows — a
plugin bug must never break shell execution.

### Module contracts

**`config.ts`** — pure, called once at plugin init.

```ts
export interface Config {
  bin: string;                  // resolved direnv binary path
  allow: Set<string> | null;    // null = allow all variables
  deny: Set<string>;            // empty set = deny none; takes precedence over allow
  verbose: boolean;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>): Config;
```

Reads:

- `OPENCODE_DIRENV_BIN` — explicit binary path. Falls back to `Bun.which("direnv")`.
- `OPENCODE_DIRENV_ALLOW` — comma-separated variable names. Empty/unset = allow all.
- `OPENCODE_DIRENV_DENY` — comma-separated variable names. Empty/unset = deny none.
- `OPENCODE_DIRENV_VERBOSE` — `1` or `true` (case-insensitive) enables verbose logging.

Throws `ConfigError` if `bin` cannot be resolved. The plugin init catches this,
logs once, and the plugin becomes a no-op for the session.

**`direnv.ts`** — pure I/O wrapper, no caching.

```ts
export type DirenvResult =
  | { ok: true; env: Record<string, string | null>; sourcedFiles: string[] }
  | { ok: false; kind: "missing-bin" | "blocked" | "exec-error" | "parse-error"; message: string };

export async function findDirenvRoot(cwd: string): Promise<string | null>;
export async function exportJson(bin: string, cwd: string): Promise<DirenvResult>;
```

`findDirenvRoot` walks up from `cwd` checking for `.envrc` at each level,
stopping at the filesystem root. Returns the directory containing the nearest
`.envrc`, or `null`.

`exportJson` uses `Bun.spawn([bin, "export", "json"], { cwd, stdout: "pipe",
stderr: "pipe" })`. On non-zero exit, classifies the error by stderr pattern
(direnv's blocked-envrc message is recognizable and stable; everything else is
`exec-error`). On exit 0, parses stdout as JSON; failure is `parse-error`.

`sourcedFiles`: best-effort. On the same call we also invoke `direnv status
--json` and extract the list of files in the load chain. If that command fails
or its schema differs from what we expect, fall back to `[root + "/.envrc"]`.
Cache invalidation degrades gracefully — worst case the user edits a
`source_up`'d file and must call `direnv_reload` to see the change.

**`cache.ts`** — in-memory only, scoped to the plugin instance.

```ts
export interface CacheEntry {
  env: Record<string, string | null>;
  mtimes: Map<string, number>;  // absolute file path → mtime ms
  computedAt: number;           // for status output
}

export class DirenvCache {
  async get(root: string): Promise<CacheEntry | null>;  // null = miss or stale
  peek(root: string): CacheEntry | null;                // no stat, no staleness check
  set(root: string, entry: CacheEntry): void;
  invalidate(root: string): void;
  roots(): string[];                                    // for status / debugging
}
```

`get` re-stats every file in `entry.mtimes` via `Bun.file(path).stat()`; if any
mtime differs or any tracked file is now missing, returns `null`. No TTL, no
LRU — direnv roots per session are bounded.

`peek` exists so `direnv_status` can show the last-computed state without
paying for re-stats, and so `direnv_reload` can diff old-vs-new.

**`log.ts`** — thin wrapper around `client.app.log`.

```ts
export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): Promise<void>;
  info(msg: string, extra?: Record<string, unknown>): Promise<void>;
  warn(msg: string, extra?: Record<string, unknown>): Promise<void>;
  error(msg: string, extra?: Record<string, unknown>): Promise<void>;
  warnOnce(key: string, msg: string, extra?: Record<string, unknown>): Promise<void>;
}

export function makeLogger(client: PluginContext["client"]): Logger;
```

All logs carry `service: "opencode-plugin-direnv"`. `warnOnce` holds a
`Set<string>` of keys in closure; subsequent calls with the same key are
no-ops. Keys are caller-chosen (e.g. `"missing-bin"`, `"blocked:<root>"`).

**`tools.ts`** — custom tool factories.

```ts
interface ToolDeps {
  cache: DirenvCache;
  config: Config;
  log: Logger;
  defaultCwd: string;  // project.worktree ?? project.directory
}

export function makeReloadTool(deps: ToolDeps): Tool;
export function makeStatusTool(deps: ToolDeps): Tool;
```

Both tools accept an optional `cwd` argument and fall back to `defaultCwd`.

**`index.ts`** — composes everything, returns the plugin object:

```ts
export const DirenvPlugin: Plugin = async (ctx) => {
  const log = makeLogger(ctx.client);
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    await log.warn(`direnv plugin disabled: ${(e as Error).message}`);
    return {}; // no-op plugin
  }

  const cache = new DirenvCache();
  const defaultCwd = ctx.worktree ?? ctx.directory;
  const deps = { cache, config, log, defaultCwd };

  return {
    "shell.env": makeShellEnvHandler(deps),
    tool: {
      direnv_reload: makeReloadTool(deps),
      direnv_status: makeStatusTool(deps),
    },
  };
};
```

### Custom tools

#### `direnv_reload`

```ts
direnv_reload: tool({
  description:
    "Reload the direnv environment for the current working directory. " +
    "Use this after editing an .envrc, running `direnv allow`, or when " +
    "environment variables seem stale. Returns a summary of what changed. " +
    "Variable values are never included in the output — only names and counts.",
  args: {
    cwd: tool.schema.string().optional()
      .describe("Directory to resolve direnv against. Defaults to the project worktree."),
  },
  async execute(args, context) { ... }
})
```

Behavior:

1. Resolve `cwd = args.cwd ?? deps.defaultCwd`.
2. `findDirenvRoot(cwd)` → if `null`, return `"No .envrc found above <cwd>"`.
3. `previous = cache.peek(root)`.
4. `cache.invalidate(root)`.
5. `result = direnv.exportJson(config.bin, root)`.
6. On failure, return a human-readable error (including the `direnv allow`
   hint when `kind === "blocked"`) and leave the cache invalidated.
7. On success, write the new entry to the cache and return a diff:
   ```
   direnv reloaded at /path/to/root
   added (2):     FOO, BAR
   changed (1):   PATH
   removed (1):   STALE_VAR
   unchanged (12)
   ```
   Names only — never values.

#### `direnv_status`

```ts
direnv_status: tool({
  description:
    "Show what direnv is currently contributing to the shell environment. " +
    "Lists the resolved .envrc root, which variables direnv is setting or " +
    "unsetting, and any allow/deny filter that's active. Useful for debugging " +
    "why an env var isn't showing up.",
  args: {
    cwd: tool.schema.string().optional(),
    show_values: tool.schema.boolean().optional().default(false)
      .describe("Include variable values in the output. Off by default to avoid leaking secrets."),
  },
  async execute(args, context) { ... }
})
```

Behavior:

1. Resolve `cwd`.
2. `findDirenvRoot(cwd)` → if `null`, return a clear "no .envrc found, walked
   up to /" message.
3. `entry = cache.peek(root)`. If absent, populate it via `exportJson` (do
   **not** invalidate first — that's what `direnv_reload` is for).
4. Apply allow/deny to compute the effective set, the filtered set, and the
   unset set.
5. Return a structured report:
   ```
   direnv status
   root:       /path/to/root
   .envrc:     allowed (mtime: 2026-05-11 14:22:01)
   sourced:    .envrc, ../shared.envrc
   binary:     /usr/bin/direnv
   verbose:    off
   allow list: <none>
   deny list:  SECRET_TOKEN

   setting (8):
     DATABASE_URL
     PATH
     ...
   unsetting (1):
     OLD_VAR
   filtered by deny (1):
     SECRET_TOKEN
   ```
6. If `show_values: true`, include values inline after each variable name.
   The agent must opt in explicitly — the right friction for secrets.

## Configuration

All configuration is via environment variables, read once at plugin init:

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_DIRENV_BIN` | `Bun.which("direnv")` | Explicit path to the direnv binary |
| `OPENCODE_DIRENV_ALLOW` | unset (allow all) | Comma-separated whitelist of variable names |
| `OPENCODE_DIRENV_DENY` | unset (deny none) | Comma-separated blacklist; takes precedence over allow |
| `OPENCODE_DIRENV_VERBOSE` | `0` | `1` / `true` enables per-injection log lines (names only) |

Empty strings are treated as unset. Variable names in allow/deny are
case-sensitive (matching shell convention).

## Error handling

| Scenario | Behavior |
|---|---|
| `direnv` binary not found at init | `log.warn` once, plugin returns `{}` (no hooks, no tools) |
| `direnv` binary missing at hook time (deleted post-init) | `warnOnce("missing-bin")`, cache empty env |
| `.envrc` exists but not allowed | `warnOnce("blocked:<root>", "Run `direnv allow` in <root>")`, cache empty env |
| `direnv export json` exits non-zero (other) | `log.error` with stderr, cache empty env |
| JSON parse fails | `log.error`, cache empty env |
| Hook handler itself throws | Top-level `try/catch` logs and swallows |
| Tool handler throws | Returns a formatted error string to the agent (tools should never raise to OpenCode) |

The "cache empty env on failure" pattern intentionally prevents repeated
subprocess spawns when something is durably broken. It self-heals on the next
`.envrc` mtime change or on `direnv_reload`.

## Variable precedence

direnv wins. If `output.env[KEY]` already has a value when our hook runs, and
direnv produces a value for `KEY`, we overwrite. This matches real direnv
behavior in a user's shell and matches the user's likely intent ("when I'm in
this project, this is the env"). The deny list is the escape hatch for cases
where another plugin or the user needs to win.

## Testing strategy

`bun test`, hermetic. The core technique: a **fake direnv binary** at
`test/fixtures/fake-direnv`:

```bash
#!/usr/bin/env bash
# Reads:
#   FAKE_DIRENV_EXIT     - exit code (default 0)
#   FAKE_DIRENV_STDOUT   - path to a file to cat as stdout, OR literal JSON
#   FAKE_DIRENV_STDERR   - path to a file to cat as stderr, OR literal string
# Echoes / exits accordingly.
```

Tests set `OPENCODE_DIRENV_BIN` to the fake's absolute path and the
`FAKE_DIRENV_*` env vars per test case. This avoids mocking `Bun.spawn`
itself — we exercise the real subprocess pipeline.

Coverage targets:

- **`config.ts`**: each env var parsed, `ConfigError` when bin can't be resolved,
  empty-string vs unset semantics, case-insensitive boolean parsing.
- **`direnv.ts`**: `findDirenvRoot` finds nearest `.envrc`, stops at fs root;
  `exportJson` happy path, blocked detection from stderr, exec-error, parse-error;
  `sourcedFiles` populated from `direnv status --json` when available.
- **`cache.ts`**: `get` returns null on miss, null on stale (touch a fixture
  file), entry on fresh; `peek` ignores staleness; `invalidate` works;
  multiple roots coexist.
- **`plugin.test.ts`**: end-to-end with a fake `ctx` (stub `client.app.log`,
  real `project`/`directory`/`worktree`), construct via `DirenvPlugin(ctx)`,
  call the returned `shell.env` handler with various `input`/`output` shapes,
  assert `output.env`. Tests:
  - direnv-wins precedence over pre-existing `output.env` values
  - null values delete keys
  - allow list filtering
  - deny list filtering (overrides allow)
  - verbose mode logs names only
  - `warnOnce` deduplicates blocked-envrc warnings across calls
  - hook never throws even when `exportJson` errors
- **`tools.test.ts`**:
  - `direnv_reload` returns "no .envrc" message when appropriate
  - `direnv_reload` produces correct added/changed/removed/unchanged diff
  - `direnv_reload` surfaces blocked hint with `direnv allow` instruction
  - `direnv_reload` invalidates cache (subsequent `shell.env` call re-spawns —
    assert via fake-direnv invocation counter file)
  - `direnv_status` reads from cache without invalidating
  - `direnv_status` populates cache on miss
  - `direnv_status` shows only names by default
  - `direnv_status` shows values when `show_values: true`
  - `direnv_status` reports deny-filtered variables in their own section

## Packaging

`package.json`:

```jsonc
{
  "name": "opencode-plugin-direnv",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "build": "bun build ./src/index.ts --target=bun --outdir=dist && tsc --emitDeclarationOnly",
    "test": "bun test",
    "prepublishOnly": "bun run build"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": "*"
  },
  "devDependencies": {
    "@opencode-ai/plugin": "*",
    "typescript": "^5"
  },
  "engines": {
    "bun": ">=<matches OpenCode's pin — TBD at implementation time>"
  },
  "license": "MIT"
}
```

The plugin's public surface is a single named export:

```ts
export const DirenvPlugin: Plugin = async (ctx) => { ... };
```

Users add it to `opencode.json`:

```jsonc
{
  "plugin": ["opencode-plugin-direnv"]
}
```

## README outline

1. **What it does** — one-paragraph summary with a before/after example.
2. **Install** — npm package add via `opencode.json`.
3. **Requirements** — direnv installed on `PATH` (or `OPENCODE_DIRENV_BIN`
   set), `.envrc` allowed via `direnv allow`.
4. **Configuration** — table of env vars.
5. **Tools** — `direnv_reload`, `direnv_status` with example agent output.
6. **Precedence** — direnv wins; deny list is the escape hatch.
7. **Troubleshooting** — "direnv blocked", missing binary, why values aren't
   appearing.
8. **License** — MIT.

## Risks

- **`direnv export json` schema changes.** Stable for years, but if upstream
  changes the contract our parser breaks. Mitigation: `parse-error` is a
  classified error kind with a clear log message pointing at upstream.
- **`direnv status --json` schema.** Less stable than `export json`. We
  treat it as best-effort and fall back to root `.envrc`-only mtime tracking
  if the schema doesn't match expectations.
- **Latency on cache miss.** First `shell.env` call in a new direnv root pays
  the cost of `direnv export json` (typically 10–200ms). Acceptable; subsequent
  calls are sub-millisecond.
- **Secret exposure via `direnv_status --show_values`.** The agent has to opt
  in per-call, and the tool description explicitly warns about it. This is the
  right friction level for an interactive debugging tool.
