import { test, expect, describe } from "bun:test";
import { DirenvCache } from "../src/cache.ts";
import { makeTmpDir, writeFile, touch } from "./helpers.ts";
import { statSync } from "node:fs";
import type { CacheEntry, WatchEntry } from "../src/types.ts";

function entryFromFiles(env: Record<string, string | null>, paths: string[]): CacheEntry {
  const watches: WatchEntry[] = paths.map((p) => ({ path: p, mtime: statSync(p).mtimeMs }));
  return { env, watches, computedAt: Date.now() };
}

describe("DirenvCache", () => {
  test("get returns null on miss", async () => {
    const cache = new DirenvCache();
    expect(await cache.get("/some/root")).toBeNull();
  });

  test("get returns entry when all watched files are unchanged", async () => {
    const { path, cleanup } = makeTmpDir();
    const f = writeFile(path, ".envrc", "");
    const cache = new DirenvCache();
    const entry = entryFromFiles({ FOO: "bar" }, [f]);
    cache.set(path, entry);
    const hit = await cache.get(path);
    expect(hit).not.toBeNull();
    expect(hit!.env).toEqual({ FOO: "bar" });
    cleanup();
  });

  test("get returns null when a watched file's mtime has advanced", async () => {
    const { path, cleanup } = makeTmpDir();
    const f = writeFile(path, ".envrc", "");
    const cache = new DirenvCache();
    cache.set(path, entryFromFiles({ FOO: "bar" }, [f]));
    touch(f);
    expect(await cache.get(path)).toBeNull();
    cleanup();
  });

  test("get returns null when a watched file has been deleted", async () => {
    const { path, cleanup } = makeTmpDir();
    const f = writeFile(path, ".envrc", "");
    const cache = new DirenvCache();
    cache.set(path, entryFromFiles({ FOO: "bar" }, [f]));
    const fs = await import("node:fs");
    fs.rmSync(f);
    expect(await cache.get(path)).toBeNull();
    cleanup();
  });

  test("peek ignores staleness", async () => {
    const { path, cleanup } = makeTmpDir();
    const f = writeFile(path, ".envrc", "");
    const cache = new DirenvCache();
    cache.set(path, entryFromFiles({ FOO: "bar" }, [f]));
    touch(f);
    const peeked = cache.peek(path);
    expect(peeked).not.toBeNull();
    expect(peeked!.env).toEqual({ FOO: "bar" });
    cleanup();
  });

  test("peek returns null on miss", () => {
    const cache = new DirenvCache();
    expect(cache.peek("/none")).toBeNull();
  });

  test("invalidate removes entry; subsequent get returns null", async () => {
    const { path, cleanup } = makeTmpDir();
    const f = writeFile(path, ".envrc", "");
    const cache = new DirenvCache();
    cache.set(path, entryFromFiles({ FOO: "bar" }, [f]));
    cache.invalidate(path);
    expect(await cache.get(path)).toBeNull();
    expect(cache.peek(path)).toBeNull();
    cleanup();
  });

  test("multiple roots coexist independently", async () => {
    const a = makeTmpDir();
    const b = makeTmpDir();
    const fa = writeFile(a.path, ".envrc", "");
    const fb = writeFile(b.path, ".envrc", "");
    const cache = new DirenvCache();
    cache.set(a.path, entryFromFiles({ FOO: "a" }, [fa]));
    cache.set(b.path, entryFromFiles({ FOO: "b" }, [fb]));
    expect((await cache.get(a.path))!.env).toEqual({ FOO: "a" });
    expect((await cache.get(b.path))!.env).toEqual({ FOO: "b" });
    cache.invalidate(a.path);
    expect(await cache.get(a.path)).toBeNull();
    expect((await cache.get(b.path))!.env).toEqual({ FOO: "b" });
    a.cleanup();
    b.cleanup();
  });

  test("roots() returns the keys of currently-stored entries (regardless of staleness)", () => {
    const { path, cleanup } = makeTmpDir();
    const cache = new DirenvCache();
    cache.set(path, { env: {}, watches: [], computedAt: 0 });
    expect(cache.roots()).toEqual([path]);
    cache.invalidate(path);
    expect(cache.roots()).toEqual([]);
    cleanup();
  });

  test("entry with empty watches is always fresh (degenerate case)", async () => {
    const cache = new DirenvCache();
    cache.set("/x", { env: { FOO: "bar" }, watches: [], computedAt: 0 });
    const hit = await cache.get("/x");
    expect(hit).not.toBeNull();
  });
});
