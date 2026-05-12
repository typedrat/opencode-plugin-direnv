import type { Logger } from "./types.ts";

export const SERVICE = "opencode-plugin-direnv";

/**
 * A minimal subset of the OpenCode plugin context's `client` we depend on.
 * Modeled narrowly so we can stub it cleanly in tests.
 */
interface ClientLike {
  app: {
    log: (call: {
      body: {
        service: string;
        level: "debug" | "info" | "warn" | "error";
        message: string;
        extra?: Record<string, unknown>;
      };
    }) => Promise<unknown>;
  };
}

/**
 * Wrap an OpenCode client's `app.log` into a typed `Logger`.
 * All emitted records carry `service: "opencode-plugin-direnv"`.
 * Errors from the underlying log call are swallowed — logging must
 * never break the plugin.
 */
export function makeLogger(client: ClientLike): Logger {
  const warnOnceKeys = new Set<string>();

  const emit = async (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<void> => {
    const body = extra === undefined
      ? { service: SERVICE, level, message }
      : { service: SERVICE, level, message, extra };
    try {
      await client.app.log({ body });
    } catch {
      // Swallow — logging failures must not propagate.
    }
  };

  return {
    debug: (m, e) => emit("debug", m, e),
    info: (m, e) => emit("info", m, e),
    warn: (m, e) => emit("warn", m, e),
    error: (m, e) => emit("error", m, e),
    warnOnce: async (key, message, extra) => {
      if (warnOnceKeys.has(key)) return;
      warnOnceKeys.add(key);
      await emit("warn", message, extra);
    },
  };
}
