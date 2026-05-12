# Changelog

## 0.1.0 — initial release

- `shell.env` hook injects direnv-managed variables on every shell invocation.
- Cache invalidation driven by direnv's own watch-list (via `direnv status --json`), with fallback to root `.envrc` mtime when status output is unavailable or its schema doesn't match expectations.
- cwd-out / cross-root unload mirrors interactive shell behavior — leaving a direnv root unsets the variables it had set.
- Custom tools `direnv_reload` and `direnv_status` for agent-side debugging, sharing the same cache as the hook.
- Configuration via `OPENCODE_DIRENV_{BIN,ALLOW,DENY,VERBOSE}` env vars; allow/deny precedence with deny winning.
- Safety-aware messaging when `.envrc` is blocked — the agent is explicitly told not to run `direnv allow` itself and to defer the decision to the user.
- Hook handler wrapped in top-level try/catch so a plugin bug can never break shell execution.
- Zero runtime dependencies; published as ESM with `.d.ts` types.
