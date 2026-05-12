# opencode-plugin-direnv

An [OpenCode](https://opencode.ai) plugin that injects [direnv](https://direnv.net)-managed environment variables into the agent's and user's shell sessions.

When you cd into a project with a `.envrc`, your shell loads the project's environment automatically — `PATH`, language toolchain versions, service credentials, whatever you've declared. Without this plugin, OpenCode's agent tools (`bash`, etc.) don't inherit that environment, so the agent's `PATH` diverges from yours and project-local binaries vanish.

This plugin closes that gap by making direnv's environment authoritative for every shell invocation OpenCode performs.

## Install

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-plugin-direnv"]
}
```

OpenCode installs the package automatically via Bun at startup.

## Requirements

- `direnv` available on `PATH`, or `OPENCODE_DIRENV_BIN` set to its absolute path.
- Each `.envrc` must be `direnv allow`ed by you (the user) — see the **Safety** section below.

## Configuration

All configuration is via environment variables, read once when OpenCode starts.

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_DIRENV_BIN` | auto-detect on `PATH` | Explicit path to the `direnv` binary. |
| `OPENCODE_DIRENV_ALLOW` | unset (allow all) | Comma-separated whitelist of variable names. Only these are injected. |
| `OPENCODE_DIRENV_DENY` | unset (deny none) | Comma-separated blacklist. Takes precedence over `OPENCODE_DIRENV_ALLOW`. |
| `OPENCODE_DIRENV_VERBOSE` | `0` | Set to `1` or `true` to log every injected variable name (never values). |

Empty strings are treated as unset.

## Tools

The plugin exposes two custom tools the agent can call:

### `direnv_reload`

Reloads direnv for the current working directory after an `.envrc` change or `direnv allow`. Returns an added/changed/removed/unchanged diff — names only, never values.

Example agent output:
```
direnv reloaded at /home/me/projects/api
added (2):   DATABASE_URL, REDIS_URL
changed (1): PATH
removed (0)
unchanged (12)
```

### `direnv_status`

Shows what direnv is currently contributing — root, watched files, variables being set/unset, allow/deny filter. Useful for debugging "why isn't `$FOO` set?"

Pass `show_values: true` to include values inline. Off by default to avoid leaking secrets.

## Precedence

When the plugin and another source (your shell, another OpenCode plugin) both want to set the same variable, **direnv wins**. This matches how direnv works in a real shell and matches the user's likely intent: "when I'm in this project, this is the env."

If you need a variable to be untouchable by direnv — for example, to force a particular `PATH` from your global config — add it to `OPENCODE_DIRENV_DENY`. The deny list is the escape hatch.

## Safety: `direnv allow`

`direnv allow` authorizes an `.envrc` to execute arbitrary shell code in your environment every time you `cd` into the directory. It is the security boundary direnv was built around: an unfamiliar `.envrc` is blocked by default so a human can read it first.

**This plugin explicitly instructs the agent not to run `direnv allow` on its own.** When the plugin encounters a blocked `.envrc`, it returns a message telling the agent to show you the `.envrc` contents and ask you to run `direnv allow` after you've reviewed them.

This rule is enforced softly — by wording in the tool descriptions and warning messages, not by intercepting commands. A determined agent could still bypass it (different quoting, writing the allow-file directly, etc.). If that matters in your threat model, audit your agent's actions or use OpenCode's [permissions](https://opencode.ai/docs/permissions) system to restrict `bash`.

## Troubleshooting

**"direnv binary unavailable" in the log.**
Either install direnv (`brew install direnv` / `apt install direnv` / etc.) or set `OPENCODE_DIRENV_BIN` to its absolute path.

**".envrc at /path is not allowed" in the log.**
You haven't `direnv allow`ed the `.envrc` yet. Review its contents and run `direnv allow` in that directory yourself.

**Values aren't appearing.**
- Run the `direnv_status` tool — it lists exactly what direnv is contributing, what's filtered, and what the watch-list is.
- Check `OPENCODE_DIRENV_ALLOW` and `OPENCODE_DIRENV_DENY` — your variable may be filtered.
- After editing an `.envrc`, the plugin auto-detects via direnv's watch-list. If that fails (e.g. a `watch_file` or `on_git_branch` directive in an unusual setup), call the `direnv_reload` tool from the agent.

## License

MIT — see `LICENSE`.
