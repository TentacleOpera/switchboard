# Remove "OPTIONAL" label from Phone-a-Friend prompt directive

## Goal

### Problem
The Phone-a-Friend prompt addon — injected into coder/lead/intern prompts when `phoneAFriend` is enabled — is currently prefixed with the literal token `(OPTIONAL)`:

> `PHONE-A-FRIEND (OPTIONAL): When you have finished coding ALL plans in this batch, notify the Phone-a-Friend agent ONCE by running: ...`

Because the directive is the *only* mechanism that triggers the second-pass Phone-a-Friend terminal, labelling it "OPTIONAL" is counterproductive: coding agents (Claude Code, Cursor, Devin, etc.) read the `(OPTIONAL)` qualifier as a license to skip the step, which means the `curl` notification to the LocalApiServer is never sent, the Phone-a-Friend terminal is never dispatched, and the entire addon silently no-ops. The user observed exactly this during testing — every agent skips it.

### Background context
- The Phone-a-Friend flow is opt-in at the addon level: the user must explicitly tick the "Phone-a-Friend" checkbox on the coder/lead/intern role in the Agents tab (`sharedDefaults.js` lines 115/138/192 — `default: false`).
- Once enabled, the directive is the *sole* signal that drives the second pass. There is no fallback path; if the curl is not sent, nothing happens.
- The original author added `(OPTIONAL)` to convey "best-effort" semantics (the host silently drops the request if no Phone-a-Friend terminal is configured). That intent is reasonable, but the word "OPTIONAL" is the wrong signal — it tells the agent the *action* is optional, not merely the *outcome*.

### Root cause
`PHONE_A_FRIEND_DIRECTIVE` in `src/services/agentPromptBuilder.ts` (line 483–484) opens with the string `PHONE-A-FRIEND (OPTIONAL):`. The qualifier is purely cosmetic — it carries no behavioural meaning to the host — but it is read by coding agents as a directive-tier downgrade. The fix is to drop the `(OPTIONAL)` qualifier from the directive text and rephrase the best-effort caveat so it describes the *outcome* (the request succeeds silently if no terminal is listening) rather than the *action* (which must always be performed).

## Metadata
- **Tags:** prompts, phone-a-friend, addons, agent-behaviour
- **Complexity:** 2 (single-string edit, no logic change)

## Complexity Audit
**Routine.** This is a one-line text change to a prompt-template string literal. No control flow, no schema, no UI wiring, no migration. The directive is consumed verbatim by `buildPrompt` for coder/lead/intern roles (lines 907, 1253, 1299, 1341, 1379) and the change propagates automatically.

## Edge-Case & Dependency Audit
- **No behavioural change for users who have the addon disabled.** The directive is only emitted when `options?.phoneAFriendEnabled && options?.apiPort` is truthy (line 907). Disabled users see no directive at all.
- **No dependency on the LocalApiServer.** The endpoint contract (`POST /phone-a-friend`) is unchanged; only the wording the agent reads changes.
- **No UI change required.** The Agents-tab checkbox label/tooltip in `sharedDefaults.js` and `kanban.html` already describe the addon correctly and do not use the word "optional" — they are out of scope.
- **Backwards compatibility.** Existing persisted agent configs (`agentConfig.ts` line 213) store `phoneAFriend: boolean`; the directive text is generated at build time, so no stored state references the old string.
- **Adversarial consideration:** Removing "OPTIONAL" must not over-promise. The directive should still convey that a missing Phone-a-Friend terminal is non-fatal (so the agent does not block on a failed curl or treat a silent 200 as an error). The rephrasing preserves this: "if the Phone-a-Friend agent is not running, the request will succeed silently" stays, but the leading `(OPTIONAL):` goes.

## Proposed Changes

### `src/services/agentPromptBuilder.ts` — reword the directive header

Replace the `(OPTIONAL)` qualifier with an imperative header and keep the best-effort outcome clause intact.

**Before** (lines 483–484):
```ts
export const PHONE_A_FRIEND_DIRECTIVE = (port: number) =>
  `PHONE-A-FRIEND (OPTIONAL): When you have finished coding ALL plans in this batch, notify the Phone-a-Friend agent ONCE by running:\ncurl -s -X POST http://127.0.0.1:${port}/phone-a-friend -H "Content-Type: application/json" -d '{"planFile":"<PLAN_FILE_PATH>","originRole":"coder"}'\nReplace <PLAN_FILE_PATH> with the relative path of the LAST plan file you completed. Send exactly one request per batch (not one per plan). This is a best-effort signal — if the Phone-a-Friend agent is not running, the request will succeed silently. (Requires the Phone-a-Friend agent configured in the Agents tab.)`;
```

**After:**
```ts
export const PHONE_A_FRIEND_DIRECTIVE = (port: number) =>
  `PHONE-A-FRIEND: When you have finished coding ALL plans in this batch, you MUST notify the Phone-a-Friend agent ONCE by running:\ncurl -s -X POST http://127.0.0.1:${port}/phone-a-friend -H "Content-Type: application/json" -d '{"planFile":"<PLAN_FILE_PATH>","originRole":"coder"}'\nReplace <PLAN_FILE_PATH> with the relative path of the LAST plan file you completed. Send exactly one request per batch (not one per plan). This is a required step — if the Phone-a-Friend agent is not running, the request will still succeed silently, but you must send it regardless. (Requires the Phone-a-Friend agent configured in the Agents tab.)`;
```

Key wording changes:
1. Drop `(OPTIONAL)` from the header → `PHONE-A-FRIEND:`.
2. Add `you MUST` to the action sentence to make the imperative unambiguous.
3. Replace `This is a best-effort signal` with `This is a required step` while keeping the silent-success caveat so the agent does not block on a failed/empty response.

### No other files require changes
- `sharedDefaults.js`, `kanban.html`, `agentConfig.ts`, `LocalApiServer.ts`, `KanbanProvider.ts`, `TaskViewerProvider.ts` — all reference the addon by its `phoneAFriend`/`phone_a_friend` keys and labels; none reproduce the `(OPTIONAL)` string. They are out of scope.

## Verification Plan
1. **Build:** `npm run compile` (or the repo's TypeScript build) — confirm no type errors from the string edit.
2. **Grep guard:** `rg -n 'OPTIONAL' src/services/agentPromptBuilder.ts` should return no matches inside `PHONE_A_FRIEND_DIRECTIVE`.
3. **Prompt inspection:** Enable the Phone-a-Friend addon on the `coder` role in the Agents tab, dispatch a one-plan batch to coder, and inspect the generated prompt (via the Prompt Preview / `TaskViewerProvider` prompt view). Confirm the directive now reads `PHONE-A-FRIEND: When you have finished coding ALL plans in this batch, you MUST notify...` with no `(OPTIONAL)` token.
4. **Behavioural smoke test:** With a Phone-a-Friend terminal configured and the LocalApiServer running, dispatch a small batch to coder and confirm the coder emits the `curl -s -X POST .../phone-a-friend` call on batch completion and the Phone-a-Friend terminal receives the dispatch.
5. **Disabled-addon regression:** Disable the addon, regenerate the coder prompt, and confirm the directive block is entirely absent (unchanged from prior behaviour).

### Red Team Findings

#### `src/services/agentPromptBuilder.ts`
- **Failure Mode 1 (Line 483-484):** Incorrect syntax or brace mismatch in template literal interpolation. *Analysis:* The template literal uses standard interpolation `${port}` and backticks. Visual inspection confirms syntax is perfectly valid.
- **Failure Mode 2 (Line 483-484):** Coding agents get confused by `<PLAN_FILE_PATH>` placeholder in the instruction. *Analysis:* The instruction explicitly explains: "Replace <PLAN_FILE_PATH> with the relative path of the LAST plan file you completed", which is standard and unmodified.
- **Failure Mode 3 (Line 483-484):** The curl command might block execution if curl hangs or fails. *Analysis:* The curl command has `-s` (silent) parameter to suppress progress meter and error messages.

**Stage Complete:** INTERN CODED
