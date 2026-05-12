import { test, expect, describe } from "bun:test";
import { loadConfig, ConfigError } from "../src/config.ts";
import { FAKE_DIRENV_BIN } from "./helpers.ts";

describe("loadConfig", () => {
  test("resolves bin from OPENCODE_DIRENV_BIN", () => {
    const cfg = loadConfig({ OPENCODE_DIRENV_BIN: FAKE_DIRENV_BIN });
    expect(cfg.bin).toBe(FAKE_DIRENV_BIN);
  });

  test("explicit OPENCODE_DIRENV_BIN bypasses PATH search", () => {
    // When explicit bin is set, PATH is irrelevant.
    const cfg = loadConfig({ OPENCODE_DIRENV_BIN: FAKE_DIRENV_BIN, PATH: "" });
    expect(cfg.bin).toBe(FAKE_DIRENV_BIN);
  });

  test("throws ConfigError when bin cannot be resolved", () => {
    // Empty PATH, unset bin → Bun.which returns null.
    expect(() => loadConfig({ OPENCODE_DIRENV_BIN: "", PATH: "" })).toThrow(ConfigError);
  });

  test("ConfigError message mentions direnv and OPENCODE_DIRENV_BIN", () => {
    try {
      loadConfig({ OPENCODE_DIRENV_BIN: "", PATH: "" });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      expect(msg).toMatch(/direnv/);
      expect(msg).toMatch(/OPENCODE_DIRENV_BIN/);
    }
  });

  test("allow=null when OPENCODE_DIRENV_ALLOW is unset", () => {
    const cfg = loadConfig({ OPENCODE_DIRENV_BIN: FAKE_DIRENV_BIN });
    expect(cfg.allow).toBeNull();
  });

  test("allow=null when OPENCODE_DIRENV_ALLOW is empty string", () => {
    const cfg = loadConfig({ OPENCODE_DIRENV_BIN: FAKE_DIRENV_BIN, OPENCODE_DIRENV_ALLOW: "" });
    expect(cfg.allow).toBeNull();
  });

  test("allow is a Set parsed from comma-separated names", () => {
    const cfg = loadConfig({ OPENCODE_DIRENV_BIN: FAKE_DIRENV_BIN, OPENCODE_DIRENV_ALLOW: "FOO,BAR,BAZ" });
    expect(cfg.allow).toEqual(new Set(["FOO", "BAR", "BAZ"]));
  });

  test("allow trims whitespace and drops empty entries", () => {
    const cfg = loadConfig({ OPENCODE_DIRENV_BIN: FAKE_DIRENV_BIN, OPENCODE_DIRENV_ALLOW: " FOO , , BAR " });
    expect(cfg.allow).toEqual(new Set(["FOO", "BAR"]));
  });

  test("deny is an empty Set when unset", () => {
    const cfg = loadConfig({ OPENCODE_DIRENV_BIN: FAKE_DIRENV_BIN });
    expect(cfg.deny).toEqual(new Set());
  });

  test("deny is parsed from comma-separated names", () => {
    const cfg = loadConfig({ OPENCODE_DIRENV_BIN: FAKE_DIRENV_BIN, OPENCODE_DIRENV_DENY: "SECRET,TOKEN" });
    expect(cfg.deny).toEqual(new Set(["SECRET", "TOKEN"]));
  });

  test("verbose=false when unset", () => {
    const cfg = loadConfig({ OPENCODE_DIRENV_BIN: FAKE_DIRENV_BIN });
    expect(cfg.verbose).toBe(false);
  });

  test.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["True", true],
    ["0", false],
    ["false", false],
    ["no", false],
    ["", false],
  ])("verbose for OPENCODE_DIRENV_VERBOSE=%j is %s", (raw, expected) => {
    const cfg = loadConfig({ OPENCODE_DIRENV_BIN: FAKE_DIRENV_BIN, OPENCODE_DIRENV_VERBOSE: raw });
    expect(cfg.verbose).toBe(expected);
  });
});
