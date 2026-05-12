import { mkdtempSync, writeFileSync, rmSync, utimesSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger } from "../src/types.ts";

/** Absolute path to the fake direnv binary, used by every direnv-touching test. */
export const FAKE_DIRENV_BIN = resolve(import.meta.dir, "fixtures/fake-direnv");

/**
 * Create a fresh temp directory for a test. Caller is responsible for cleanup
 * via the returned `cleanup` function (idempotent).
 */
export function makeTmpDir(prefix = "opencode-direnv-test-"): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // ignore — best-effort
      }
    },
  };
}

/** Write a file inside a tmp dir, creating parent dirs as needed. */
export function writeFile(dir: string, relPath: string, content: string): string {
  const full = join(dir, relPath);
  const parent = full.slice(0, full.lastIndexOf("/"));
  if (parent && parent !== dir) {
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(full, content);
  return full;
}

/**
 * Bump a file's mtime to "now + 1 second" so cache staleness checks observe a change
 * even when called within the same millisecond as the original write.
 */
export function touch(path: string): void {
  const future = new Date(Date.now() + 1000);
  utimesSync(path, future, future);
}

/** Collected log records for assertions. */
export interface LoggedRecord {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  extra?: Record<string, unknown>;
}

/** A stub logger that records all calls into an array. warnOnce dedupes by key. */
export function makeStubLogger(): { logger: Logger; records: LoggedRecord[]; warnOnceKeys: Set<string> } {
  const records: LoggedRecord[] = [];
  const warnOnceKeys = new Set<string>();
  const push = (level: LoggedRecord["level"]) => async (msg: string, extra?: Record<string, unknown>) => {
    records.push(extra === undefined ? { level, msg } : { level, msg, extra });
  };
  const logger: Logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    warnOnce: async (key, msg, extra) => {
      if (warnOnceKeys.has(key)) return;
      warnOnceKeys.add(key);
      records.push(extra === undefined ? { level: "warn", msg } : { level: "warn", msg, extra });
    },
  };
  return { logger, records, warnOnceKeys };
}

/**
 * Read the fake-direnv invocation log into structured records.
 * Each line is `argv0|argv1|argv2|...|CWD=<path>`.
 */
export function readDirenvLog(logfile: string): Array<{ argv: string[]; cwd: string }> {
  if (!existsSync(logfile)) return [];
  const lines = readFileSync(logfile, "utf8").split("\n").filter((l) => l.length > 0);
  return lines.map((line) => {
    const parts = line.split("|");
    const cwdPart = parts[parts.length - 1] ?? "";
    const cwd = cwdPart.startsWith("CWD=") ? cwdPart.slice(4) : "";
    const argv = parts.slice(0, -1);
    return { argv, cwd };
  });
}
