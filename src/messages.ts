/**
 * Safety-aware message returned when an .envrc exists but is not allowed.
 *
 * SECURITY CONTRACT: This message tells the agent NOT to run `direnv allow`
 * on its own. `direnv allow` authorizes the .envrc to execute arbitrary
 * shell code in the user's environment — a security boundary direnv was
 * built around. The agent must defer the decision to the user.
 *
 * If you change this wording, also update:
 *   - README.md "Safety: `direnv allow`" section
 *   - The corresponding test in test/messages.test.ts
 */
export function blockedEnvrcMessage(root: string): string {
  return (
    `.envrc at ${root} is not allowed. Show its contents to the user and ` +
    `ask them to run \`direnv allow\` after they've reviewed it. ` +
    `Do not run \`direnv allow\` yourself — it grants the .envrc permission ` +
    `to execute arbitrary shell code in the user's environment.`
  );
}

/**
 * Safety note appended to both custom tool descriptions. Mirrors the
 * blockedEnvrcMessage but written for the LLM's description-field context.
 */
export const TOOL_SAFETY_NOTE =
  "\n\n" +
  "Safety: If this reports that an .envrc is not allowed, do NOT run " +
  "`direnv allow` to fix it. That command authorizes arbitrary shell " +
  "execution; show the .envrc contents to the user and ask them to run " +
  "`direnv allow` themselves after reviewing.";
