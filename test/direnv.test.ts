import { test, expect, describe } from "bun:test";
import { findDirenvRoot, exportJson, statusJson } from "../src/direnv.ts";
import { makeTmpDir, writeFile, FAKE_DIRENV_BIN } from "./helpers.ts";

describe("findDirenvRoot", () => {
  test("returns directory containing .envrc when cwd is that directory", async () => {
    const { path, cleanup } = makeTmpDir();
    writeFile(path, ".envrc", "");
    expect(await findDirenvRoot(path)).toBe(path);
    cleanup();
  });

  test("walks up to find nearest .envrc", async () => {
    const { path, cleanup } = makeTmpDir();
    writeFile(path, ".envrc", "");
    writeFile(path, "a/b/c.txt", "");
    expect(await findDirenvRoot(`${path}/a/b`)).toBe(path);
    cleanup();
  });

  test("returns nearest, not furthest", async () => {
    const { path, cleanup } = makeTmpDir();
    writeFile(path, ".envrc", "outer");
    writeFile(path, "a/.envrc", "inner");
    expect(await findDirenvRoot(`${path}/a`)).toBe(`${path}/a`);
    cleanup();
  });

  test("returns null when no .envrc exists up to fs root", async () => {
    const { path, cleanup } = makeTmpDir();
    expect(await findDirenvRoot(path)).toBeNull();
    cleanup();
  });
});

describe("exportJson", () => {
  test("returns ok:true with parsed env on exit 0", async () => {
    const { path, cleanup } = makeTmpDir();
    const result = await exportJson(FAKE_DIRENV_BIN, path, {
      FAKE_DIRENV_EXPORT: '{"FOO":"bar","UNSET":null}',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env).toEqual({ FOO: "bar", UNSET: null });
    }
    cleanup();
  });

  test("classifies blocked .envrc by stderr pattern", async () => {
    const { path, cleanup } = makeTmpDir();
    const result = await exportJson(FAKE_DIRENV_BIN, path, {
      FAKE_DIRENV_EXIT: "1",
      FAKE_DIRENV_STDERR: "direnv: error /tmp/foo/.envrc is blocked. Run `direnv allow` to approve its content",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("blocked");
    }
    cleanup();
  });

  test("classifies missing-bin when spawn fails (ENOENT)", async () => {
    const { path, cleanup } = makeTmpDir();
    const result = await exportJson("/nonexistent/direnv", path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("missing-bin");
    }
    cleanup();
  });

  test("classifies exec-error on other non-zero exits", async () => {
    const { path, cleanup } = makeTmpDir();
    const result = await exportJson(FAKE_DIRENV_BIN, path, {
      FAKE_DIRENV_EXIT: "2",
      FAKE_DIRENV_STDERR: "some other error",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("exec-error");
      expect(result.message).toContain("some other error");
    }
    cleanup();
  });

  test("classifies parse-error on invalid JSON", async () => {
    const { path, cleanup } = makeTmpDir();
    const result = await exportJson(FAKE_DIRENV_BIN, path, {
      FAKE_DIRENV_EXPORT: "not json",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("parse-error");
    }
    cleanup();
  });

  test("treats empty stdout as empty env (direnv emits nothing when no changes)", async () => {
    const { path, cleanup } = makeTmpDir();
    const result = await exportJson(FAKE_DIRENV_BIN, path, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env).toEqual({});
    }
    cleanup();
  });
});

describe("statusJson", () => {
  test("parses watches from state.foundRC.watches", async () => {
    const { path, cleanup } = makeTmpDir();
    const status = {
      state: {
        foundRC: {
          path: `${path}/.envrc`,
          allowed: 0,
          watches: [
            { Path: `${path}/.envrc`, Modified: "2026-05-11T14:22:01.000Z" },
            { Path: `${path}/Gemfile`, Modified: "2026-05-11T14:22:02.000Z" },
          ],
        },
      },
    };
    const result = await statusJson(FAKE_DIRENV_BIN, path, {
      FAKE_DIRENV_STATUS: JSON.stringify(status),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.watches).toEqual([
        { path: `${path}/.envrc`, mtime: Date.parse("2026-05-11T14:22:01.000Z") },
        { path: `${path}/Gemfile`, mtime: Date.parse("2026-05-11T14:22:02.000Z") },
      ]);
    }
    cleanup();
  });

  test("returns empty watches when state.foundRC is absent", async () => {
    const { path, cleanup } = makeTmpDir();
    const result = await statusJson(FAKE_DIRENV_BIN, path, {
      FAKE_DIRENV_STATUS: '{"state":{}}',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.watches).toEqual([]);
    }
    cleanup();
  });

  test("schema-mismatch when watches entries lack expected keys", async () => {
    const { path, cleanup } = makeTmpDir();
    const result = await statusJson(FAKE_DIRENV_BIN, path, {
      FAKE_DIRENV_STATUS: '{"state":{"foundRC":{"watches":[{"unexpected":"shape"}]}}}',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("schema-mismatch");
    }
    cleanup();
  });

  test("missing-bin on ENOENT", async () => {
    const { path, cleanup } = makeTmpDir();
    const result = await statusJson("/nonexistent/direnv", path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("missing-bin");
    }
    cleanup();
  });

  test("parse-error on invalid JSON", async () => {
    const { path, cleanup } = makeTmpDir();
    const result = await statusJson(FAKE_DIRENV_BIN, path, {
      FAKE_DIRENV_STATUS: "garbage",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("parse-error");
    }
    cleanup();
  });

  test("exec-error on non-zero exit", async () => {
    const { path, cleanup } = makeTmpDir();
    const result = await statusJson(FAKE_DIRENV_BIN, path, {
      FAKE_DIRENV_EXIT: "1",
      FAKE_DIRENV_STDERR: "boom",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("exec-error");
      expect(result.message).toContain("boom");
    }
    cleanup();
  });
});
