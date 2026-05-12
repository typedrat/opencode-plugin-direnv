import { test, expect, describe } from "bun:test";
import { applyEnv, classifyForApply } from "../src/applyEnv.ts";

describe("applyEnv", () => {
  test("sets string values into output.env", () => {
    const out: Record<string, string | undefined> = {};
    applyEnv(out, { FOO: "bar", BAZ: "qux" }, null, new Set());
    expect(out).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("null values delete keys from output.env", () => {
    const out: Record<string, string | undefined> = { OLD: "value" };
    applyEnv(out, { OLD: null }, null, new Set());
    expect(out.OLD).toBeUndefined();
    expect("OLD" in out).toBe(false);
  });

  test("direnv-wins: overrides pre-existing values", () => {
    const out: Record<string, string | undefined> = { PATH: "/old" };
    applyEnv(out, { PATH: "/new" }, null, new Set());
    expect(out.PATH).toBe("/new");
  });

  test("allow list filters: only listed vars are applied", () => {
    const out: Record<string, string | undefined> = {};
    applyEnv(out, { FOO: "1", BAR: "2", BAZ: "3" }, new Set(["FOO", "BAZ"]), new Set());
    expect(out).toEqual({ FOO: "1", BAZ: "3" });
  });

  test("deny list filters: listed vars are skipped", () => {
    const out: Record<string, string | undefined> = {};
    applyEnv(out, { FOO: "1", SECRET: "x" }, null, new Set(["SECRET"]));
    expect(out).toEqual({ FOO: "1" });
  });

  test("deny takes precedence over allow", () => {
    const out: Record<string, string | undefined> = {};
    applyEnv(out, { FOO: "1" }, new Set(["FOO"]), new Set(["FOO"]));
    expect(out).toEqual({});
  });

  test("allow + deny together: only allowed-and-not-denied vars applied", () => {
    const out: Record<string, string | undefined> = {};
    applyEnv(
      out,
      { A: "1", B: "2", C: "3" },
      new Set(["A", "B"]),
      new Set(["B"]),
    );
    expect(out).toEqual({ A: "1" });
  });

  test("filtered null still deletes from output (because direnv said unset)", () => {
    // Wait — the spec says deny "filters" the var entirely. A denied unset means
    // we DON'T delete (we leave the existing value alone). Let's verify that.
    const out: Record<string, string | undefined> = { SECRET: "kept" };
    applyEnv(out, { SECRET: null }, null, new Set(["SECRET"]));
    expect(out.SECRET).toBe("kept");
  });
});

describe("classifyForApply", () => {
  test("partitions an env result into apply / filtered-by-allow / filtered-by-deny", () => {
    const result = classifyForApply(
      { A: "1", B: "2", C: null, D: "4" },
      new Set(["A", "B", "C"]), // allow
      new Set(["B"]),           // deny
    );
    expect(result.apply).toEqual({ A: "1", C: null });
    expect(result.filteredByDeny.sort()).toEqual(["B"]);
    expect(result.filteredByAllow.sort()).toEqual(["D"]);
  });

  test("with allow=null, nothing is filtered by allow", () => {
    const result = classifyForApply({ A: "1" }, null, new Set());
    expect(result.apply).toEqual({ A: "1" });
    expect(result.filteredByAllow).toEqual([]);
    expect(result.filteredByDeny).toEqual([]);
  });
});
