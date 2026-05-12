import { test, expect } from "bun:test";
import { makeTmpDir, writeFile, touch, makeStubLogger, FAKE_DIRENV_BIN, readDirenvLog } from "./helpers.ts";
import { statSync, existsSync } from "node:fs";

test("makeTmpDir creates a directory and cleanup removes it", () => {
  const { path, cleanup } = makeTmpDir();
  expect(existsSync(path)).toBe(true);
  cleanup();
  expect(existsSync(path)).toBe(false);
});

test("writeFile creates parent dirs", () => {
  const { path, cleanup } = makeTmpDir();
  const full = writeFile(path, "a/b/c.txt", "hello");
  expect(Bun.file(full).text()).resolves.toBe("hello");
  cleanup();
});

test("touch advances mtime", () => {
  const { path, cleanup } = makeTmpDir();
  const full = writeFile(path, "x", "y");
  const before = statSync(full).mtimeMs;
  touch(full);
  const after = statSync(full).mtimeMs;
  expect(after).toBeGreaterThan(before);
  cleanup();
});

test("makeStubLogger collects records and dedupes warnOnce", async () => {
  const { logger, records } = makeStubLogger();
  await logger.info("hello");
  await logger.warnOnce("k", "first");
  await logger.warnOnce("k", "second"); // dropped
  await logger.warnOnce("k2", "third");
  expect(records).toEqual([
    { level: "info", msg: "hello" },
    { level: "warn", msg: "first" },
    { level: "warn", msg: "third" },
  ]);
});

test("FAKE_DIRENV_BIN is an absolute path to an existing file", () => {
  expect(FAKE_DIRENV_BIN.startsWith("/")).toBe(true);
  expect(existsSync(FAKE_DIRENV_BIN)).toBe(true);
});

test("fake direnv emits FAKE_DIRENV_EXPORT for `export json`", async () => {
  const { path: tmp, cleanup } = makeTmpDir();
  const logfile = `${tmp}/log`;
  const result = Bun.spawn([FAKE_DIRENV_BIN, "export", "json"], {
    env: { ...process.env, FAKE_DIRENV_EXPORT: '{"FOO":"bar"}', FAKE_DIRENV_LOGFILE: logfile },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(result.stdout).text();
  await result.exited;
  expect(stdout).toBe('{"FOO":"bar"}');
  expect(result.exitCode).toBe(0);
  const log = readDirenvLog(logfile);
  expect(log).toHaveLength(1);
  expect(log[0]!.argv.slice(1)).toEqual(["export", "json"]);
  cleanup();
});
