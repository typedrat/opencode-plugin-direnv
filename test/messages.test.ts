import { test, expect } from "bun:test";
import { blockedEnvrcMessage } from "../src/messages.ts";

test("blockedEnvrcMessage includes the path", () => {
  expect(blockedEnvrcMessage("/path/to/root")).toContain("/path/to/root");
});

test("blockedEnvrcMessage instructs the agent NOT to run direnv allow itself", () => {
  // This is a security contract. If you change this wording, update the README too.
  const msg = blockedEnvrcMessage("/r");
  expect(msg).toMatch(/do not run `direnv allow` yourself/i);
  expect(msg).toMatch(/show .* contents to the user/i);
  expect(msg).toMatch(/arbitrary shell/i);
});

test("blockedEnvrcMessage suggests the user run direnv allow after review", () => {
  const msg = blockedEnvrcMessage("/r");
  expect(msg).toMatch(/ask them to run `direnv allow`/i);
});
