# Bidirectional Link-Up — Both Terminals Get Instructions

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, bugfix, feature, api, ui
**Project:** Browser Switchboard

## Goal

### Problem

The Link-up modal in `terminals.html` establishes a **one-way** link from parent to child. The parent terminal receives an instruction (and the `/terminals/relay` curl command) telling it to message the child. The child terminal receives **nothing** — no awareness of the relationship, no knowledge of the parent's identity, and no way to message back. As the user put it: "it's just one terminal shouting at another."

There are two distinct defects:

1. **The child never learns about the relationship.** In instant mode, the child only receives a relayed payload *if* the parent actually runs the curl command — and even then, it gets the message content but no awareness of the ongoing relationship or how to reply. In standing mode, the child gets nothing at all, ever — the standing order is appended only to the parent's prompts.

2. **The preset `direction` field is silently ignored.** Every preset carries a `direction` (`head-receives` or `member-receives`) that determines *who should receive the instruction*. The team spawn path (`wireSpawnedTeam`) honors this correctly. But the link-up modal always sends to the parent regardless of direction. This is acknowledged in a comment at `terminals.js:9030-9035` as a "known asymmetry, deliberately left." The practical consequence: selecting "Reports to me — it works what I hand it" (which is `member-receives`) should install the instruction on the **child** (member) telling it to report to the parent (head). Instead, it goes to the **parent**, telling the parent to report to the child — actively inverted.

### Background

The Link-up modal has two modes:
- **Instant**: The panel sends a one-shot prompt to the parent via `ptySendPrompt`, built by `buildLinkPrompt()`. That prompt tells the parent to relay a message to the child via `POST /terminals/relay`.
- **Standing**: The panel saves a standing order `(parent, child, instruction)` via `POST /terminals/standing-orders`. The order is appended to every prompt sent to the `parent` terminal. The child is never notified.

The preset vocabulary (`LINK_PRESETS`) is defined in two places that must stay in sync:
- `src/services/linkPresets.ts` — the TypeScript source of truth
- `src/webview/terminals.js` — a client mirror (the webview is served as a classic script with no module loading)

A contract test (`src/test/link-presets-mirror-contract.test.js`) enforces that the two copies have identical ids, labels, templates, and directions.

### Root Cause

1. `sendLinkMessage()` in `terminals.js` only ever sends to the parent — there is no second `ptySendPrompt` call for the child.
2. `resolvePreset()` is always called with `(id, parentSel.value, childSel.value)` regardless of the preset's `direction`. For `member-receives` presets, the arguments should be swapped so `{child}` resolves to the head name (as it does in `wireSpawnedTeam`).
3. `buildLinkPrompt()` only builds a prompt addressed to the parent, with the relay curl targeting the child. There is no corresponding builder for the child's perspective.

### Outcome

After this fix, linking terminal A to terminal B via the Link-up modal will:
- Send the primary instruction to the correct terminal (honoring `direction`)
- Send a complementary instruction to the other terminal, describing the relationship from its perspective and including the `/terminals/relay` curl command so it can reach the primary
- Do this in both instant mode (two `ptySendPrompt` calls) and standing mode (two standing orders — one for each direction)

Both terminals will know the relationship exists, what it means from their side, and how to communicate with the other.

## User Review Required

- **Complementary template wording**: Seven new `complementaryTemplate` strings are proposed below (step 1). These are instructional prose that agents will act on — review for tone, accuracy, and consistency with the main templates before implementation.
- **Unlinked standing orders**: The two standing orders created per link are independent (deleting one does not delete the other). This is a deliberate trade-off for the initial fix — confirm this is acceptable before implementation.

## Complexity Audit

### Routine
- Adding a `complementaryTemplate` field to 7 presets in two mirror files (mechanical, follows existing pattern)
- Adding `resolveComplementaryPreset()` — mirrors the existing `resolvePreset` pattern
- Adding `presetDirection()` helper — one-line lookup on `LINK_PRESETS`
- Updating `renderStandingList()` — no structural change, two items appear naturally
- Updating the contract test — extends existing assertions with a new field

### Complex / Risky
- **Direction-aware argument swapping** in `applyPresetToMessage()` and `sendLinkMessage()` — the `member-receives` swap must match `wireSpawnedTeam`'s convention exactly, and must NOT affect the migration recogniser at `terminals.js:9345` which calls `resolvePreset('reviewer', o.parent, o.child)` for stale-order detection
- **Dual-send sequencing in instant mode** — the current code closes the modal on primary success (line 9696) before any secondary send; restructuring to send-both-then-close requires careful ordering to avoid closing on partial failure
- **Contract test parser** — `extractPresets()` collects single-quoted fragments after `template:` until `}` or `id:`; adding `complementaryTemplate` after `template` will cause the parser to swallow complementary fragments into `template` unless the bounding logic is updated (see step 7)

## Edge-Case & Dependency Audit

- **Race Conditions**: The fleet can change between modal open and send. The current code re-validates both ends at `terminals.js:9639-9641`. The dual-send extends this: both terminals must be live at send time. If the secondary terminal dies between the primary and secondary send, the partial-failure path (step 5.5) fires — the primary is instructed, the modal closes, and a warning toast names the failed secondary.
- **Security**: No new security surface. The `/terminals/relay` endpoint validates both `from` and `to` against the live PTY fleet (`LocalApiServer.ts:2530-2538`) and hardcodes `clearBeforePrompt: false`. The auth token reaches the shell as `$SWITCHBOARD_API_TOKEN` — never interpolated into the prompt text.
- **Side Effects**: Two standing orders are created per link instead of one. The standing list (`renderStandingList`) shows two entries — one per direction. Deleting one does not delete the other (they are independent pair-scoped orders). This is transparent: the operator sees both directions and can delete them independently.
- **Dependencies & Conflicts**: The migration recogniser at `terminals.js:9345` (`migrateCodingTeamOrdersClient`) calls `resolvePreset('reviewer', o.parent, o.child)` to detect stale reviewer pair rows. This call must NOT be affected by the direction fix — it compares stored pair-order text (always head-receives oriented) and must keep its current argument order. The direction fix applies ONLY to `applyPresetToMessage()` and `sendLinkMessage()`. Additionally, the `reports-to-head` main template uses `POST /terminals/verb/ptySendPrompt` for the member→head report, while all complementary templates use `POST /terminals/relay`. This delivery-mechanism asymmetry is pre-existing (the main template is byte-identical to `AGENT_GROUP_CALLBACK_INSTRUCTION` in `teamWiring.ts`, enforced by contract test) and must NOT be changed — changing it would break the contract.

## Dependencies

- `feature_plan_20260812171500_link-up-presets-fire-through-relay-not-standing-orders.md` — introduced the preset vocabulary, the `direction` field, and the known asymmetry this plan fixes

## Adversarial Synthesis

Key risks: (1) the contract test parser will silently merge `complementaryTemplate` fragments into `template` unless its bounding logic is updated; (2) the instant-mode close-on-primary-success sequence must be restructured to send-both-then-close; (3) the migration recogniser's `resolvePreset` call at line 9345 must not be swept into the direction fix. Mitigations: update the parser to bound `template` extraction at `complementaryTemplate:` (step 7), restructure `sendLinkMessage` to close only after both sends resolve (step 5), and scope the direction fix to `applyPresetToMessage` + `sendLinkMessage` only (step 3).

## Proposed Changes

### 1. Add `complementaryTemplate` to each preset

**Files:** `src/services/linkPresets.ts`, `src/webview/terminals.js` (LINK_PRESETS mirror)

Add a `complementaryTemplate` field to each preset. This is the instruction for the "other" terminal — the one that does NOT receive the main template. It describes the same relationship from the other terminal's perspective and includes the `/terminals/relay` delivery route.

`{parent}` and `{child}` always refer to the dropdown selections (parent = the Parent select, child = the Child select), regardless of which terminal receives the instruction. This keeps substitution simple and consistent.

Proposed complementary templates:

- **`researcher`** (head-receives; complementary goes to the child):
  ```
  You have been designated as {parent}'s researcher. {parent} will hand you questions that need external sources, documentation or API details — it cannot see your conversation, so work standalone from what it sends. When you have results, deliver them to {parent} — POST /terminals/relay with {"to":"{parent}","from":"{child}","message":"<your findings>"} against the port in .switchboard/api-server-port.txt. Do not wait to be asked.
  ```

- **`reviewer`** (head-receives; complementary goes to the child):
  ```
  You have been designated as {parent}'s reviewer. {parent} will hand you summaries of completed work — it cannot see your conversation, so review from what it sends. When you have feedback, deliver it to {parent} — POST /terminals/relay with {"to":"{parent}","from":"{child}","message":"<your review>"} against the port in .switchboard/api-server-port.txt. Address defects directly; do not defer.
  ```

- **`tester`** (head-receives; complementary goes to the child):
  ```
  You have been designated as {parent}'s tester. {parent} will hand you changes to verify along with the expected behaviour — it cannot see your conversation, so test from what it sends. When you have results, deliver them to {parent} — POST /terminals/relay with {"to":"{parent}","from":"{child}","message":"<pass/fail and details>"} against the port in .switchboard/api-server-port.txt. Report failures with enough detail for {parent} to fix them.
  ```

- **`handoff`** (head-receives; complementary goes to the child):
  ```
  {parent} is handing over the full context of a task to you: the goal, what has been done so far, what is left, and any decisions or dead ends that matter. {parent} cannot see your conversation, so pick it up from what it sends. If you need more context, ask {parent} — POST /terminals/relay with {"to":"{parent}","from":"{child}","message":"<your question>"} against the port in .switchboard/api-server-port.txt.
  ```

- **`second-opinion`** (head-receives; complementary goes to the child):
  ```
  {parent} may ask you for a second opinion before committing to an approach. When it does, it will state the approach, the alternatives it rejected and why. Respond with your assessment — POST /terminals/relay with {"to":"{parent}","from":"{child}","message":"<your opinion>"} against the port in .switchboard/api-server-port.txt. {parent} is the decision-maker, not you — advise, do not decide.
  ```

- **`reports-to-head`** (member-receives; complementary goes to the parent/head):
  ```
  {child} has been linked to you as your worker. It will report to you when it finishes tasks — naming what it changed and what to review. Review its reports and dispatch next work to it via POST /terminals/relay with {"to":"{child}","from":"{parent}","message":"<next task or feedback>"} against the port in .switchboard/api-server-port.txt. Do not wait for {child} to ask.
  ```

- **`custom`** (head-receives; complementary goes to the child):
  Empty string. When the complementary template is empty, a generic notification is sent instead (see step 5).

Add a `complementaryTemplate` field to the `LinkPreset` interface in `linkPresets.ts`.

**Field ordering note**: Place `complementaryTemplate` AFTER `template` in each preset object literal (natural reading order). The contract test parser must be updated to handle this — see step 7.

### 2. Add `resolveComplementaryPreset()` to both files

**Files:** `src/services/linkPresets.ts`, `src/webview/terminals.js`

Add a `resolveComplementaryPreset(id, parentName, childName)` function that:
- Finds the preset by id
- If `complementaryTemplate` is empty or missing, returns `''` (the caller will use a generic fallback)
- Otherwise substitutes `{child}` and `{parent}` and returns the resolved string

Mirror the function in both files, matching the existing `resolvePreset` pattern.

**Clarification:** The TS-side `resolveComplementaryPreset` has no production caller — the team spawn path (`wireSpawnedTeam`) does not use complementary templates (it carries `member-receives` via the team prompt, not a pair order). The TS function exists for mirror symmetry with the JS side. If the contract test is extended to test resolver behavior (not just preset definitions), both copies must match. If not, the TS copy is harmless dead code that keeps the mirror convention.

### 3. Honor `direction` in the modal — fix argument swapping

**File:** `src/webview/terminals.js`

In `applyPresetToMessage()` and `sendLinkMessage()`, determine the primary recipient based on the selected preset's `direction`:

- `head-receives`: primary = parent (dropdown), secondary = child (dropdown). Resolve main template with `(id, parentName, childName)` — as now.
- `member-receives`: primary = child (dropdown), secondary = parent (dropdown). Resolve main template with `(id, childName, parentName)` — **swap the arguments** so `{child}` resolves to the head name, matching `wireSpawnedTeam`'s convention.

Add a helper function `presetDirection(id)` that returns the direction for a given preset id (looking up the `LINK_PRESETS` array).

Update `applyPresetToMessage()` to use the correct argument order based on direction, so the textarea preview shows the correctly-oriented instruction before sending.

**Critical scope guard**: The `resolvePreset('reviewer', o.parent, o.child)` call at `terminals.js:9345` in `migrateCodingTeamOrdersClient` is a migration recogniser that detects stale reviewer pair rows. It must keep its current argument order — it compares against stored pair-order text that is always head-receives oriented. Do NOT route this call through the direction-aware logic.

### 4. Generalize `buildLinkPrompt()` for both directions

**File:** `src/webview/terminals.js`

Refactor `buildLinkPrompt` into `buildLinkPromptFor(targetName, otherName, instruction)`:
- `targetName` — the terminal receiving this prompt
- `otherName` — the terminal it should communicate with
- `instruction` — the resolved instruction text

The function builds the same shell block as today, but parameterized for either direction:
```
You have been asked to relay something to another Switchboard terminal.

TARGET TERMINAL: {otherName}
YOUR TERMINAL:   {targetName}

OPERATOR INSTRUCTION:
---
{instruction}
---

To deliver this to {otherName}, run:

curl -s -X POST "{api}/terminals/relay" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SWITCHBOARD_API_TOKEN" \
  -d '{"to":"{otherName}","from":"{targetName}","message":"<the operator instruction above, verbatim>"}'

For a long or multi-line message, use a heredoc to build the JSON body instead of hand-escaping it into the -d string.

Carry out the operator instruction now.
```

> **Superseded:** Keep the existing `buildLinkPrompt(parentName, childName, message)` as a thin wrapper for backward compatibility if any other call site uses it (check first — it may only be called from `sendLinkMessage`).
> **Reason:** `buildLinkPrompt` is called from exactly one site — `sendLinkMessage` at `terminals.js:9677`. No other call site exists in the file. A backward-compat wrapper would be dead code.
> **Replaced with:** Rename `buildLinkPrompt` directly to `buildLinkPromptFor(targetName, otherName, instruction)`. No wrapper needed. Update the single call site in `sendLinkMessage`.

### 5. Update `sendLinkMessage()` — instant mode: send to both terminals

**File:** `src/webview/terminals.js`

In the `else` branch (instant mode) of `sendLinkMessage()`:

1. Determine primary/secondary and resolve both instructions:
   - `direction = presetDirection(presetSel.value)`
   - If `head-receives`: primary = parent, secondary = child. Main instruction = `resolvePreset(id, parent, child)`. Complementary = `resolveComplementaryPreset(id, parent, child)`.
   - If `member-receives`: primary = child, secondary = parent. Main instruction = `resolvePreset(id, child, parent)` (swapped). Complementary = `resolveComplementaryPreset(id, parent, child)` (NOT swapped — complementary templates use `{parent}` and `{child}` as dropdown values).

2. If the complementary is empty (custom preset), generate a generic notification:
   ```
   You have been linked to {otherName} by the operator. To communicate with {otherName}, use POST /terminals/relay with {"to":"{otherName}","from":"{targetName}","message":"<your message>"} against the port in .switchboard/api-server-port.txt.
   ```

3. Send the main instruction to the primary terminal via `ptySendPrompt` (as now, but to the correct terminal).

4. Send the complementary instruction to the secondary terminal via a second `ptySendPrompt` call.

5. Handle partial failure: if the primary send succeeds but the secondary fails, close the modal and toast a warning: `Instructed {primary} but failed to notify {secondary}: {error}`. If the primary fails, show the error inline (as now) and do not send the secondary.

6. On full success, toast: `Linked {primary} ↔ {secondary}` (bidirectional arrow instead of the current one-way `→`).

**Close-sequencing fix**: The current code closes the modal on primary success (line 9696) BEFORE any secondary send. This must be restructured: send primary, check success, send secondary, check success, THEN close the modal and toast. The modal must stay open until both sends resolve so that a secondary failure can still display an inline error or a warning toast while the modal context is available. Specifically:
- Primary fails → `setLinkError(...)` inline, modal stays open, return.
- Primary succeeds, secondary fails → close modal, toast warning.
- Both succeed → close modal, toast success.

### 6. Update `sendLinkMessage()` — standing mode: save two orders

**File:** `src/webview/terminals.js`

In the `if (linkMode === 'standing')` branch:

1. Determine primary/secondary and resolve both instructions (same logic as instant mode, step 5.1).

2. Save the main standing order: `POST /terminals/standing-orders` with `{action: 'add', parent: primaryName, child: secondaryName, instruction: mainInstruction}`. This order is appended to the primary's prompts. (In the standing-orders schema, `parent` = the terminal that RECEIVES the order, `child` = the terminal the order is ABOUT — confirmed at `teamWiring.ts:36` and `terminals.js:9426`.)

3. Save the complementary standing order: `POST /terminals/standing-orders` with `{action: 'add', parent: secondaryName, child: primaryName, instruction: complementaryInstruction}`. This order is appended to the secondary's prompts.

4. If the complementary is empty (custom preset), use the generic notification text as the complementary instruction.

5. Handle partial failure: if the first save succeeds but the second fails, toast a warning. If the first fails, show the error inline and do not attempt the second. Note: the standing-orders endpoint does not support batch/transactional adds — a partial failure leaves a one-sided order that the operator must manually delete from the standing list.

6. On full success, toast: `Standing orders saved for {primary} ↔ {secondary}`.

### 7. Update the contract test

**File:** `src/test/link-presets-mirror-contract.test.js`

**Parser fix (required before adding complementaryTemplate assertions):** The existing `extractPresets()` function collects single-quoted fragments after `template:` until it encounters `}` or `id:` (with a `> 200` char guard). When `complementaryTemplate` is added AFTER `template` in each entry, the text between `template`'s last fragment and `complementaryTemplate`'s first fragment is ` complementaryTemplate: ` — which contains neither `}` nor `id:`, so the loop will NOT stop and will silently merge `complementaryTemplate`'s fragments into `template`. This is a parser bug that must be fixed before the new assertions can pass.

Fix: update the fragment-collection loop to also stop when `between.includes('complementaryTemplate:')`. Then add a parallel extraction for `complementaryTemplate` using the same fragment-collection pattern, bounded by `}`, `id:`, or `template:` (whichever comes first). The `complementaryTemplate` extraction finds `complementaryTemplate:` after the entry's `id:` match, collects fragments, and stops at the same boundaries.

After the parser fix:
- Extend `extractPresets()` to also extract `complementaryTemplate` from each entry.
- Add a test: "each preset has matching complementaryTemplate across both files" — same pattern as the existing template match test.
- Add a test: "custom preset has an empty complementaryTemplate" — mirrors the existing empty-template test for `custom`.

### 8. Update the standing-orders list rendering (transparency)

**File:** `src/webview/terminals.js` (`renderStandingList()`)

No structural change needed — the two orders will naturally appear as two items in the standing list:
- `parent ← child: <main instruction>`
- `child ← parent: <complementary instruction>`

This is transparent and accurate. The operator can see both directions of the link and delete them independently. No linkage mechanism is needed for the initial fix.

## Verification Plan

1. **Contract test**: Run `node src/test/link-presets-mirror-contract.test.js` — all tests pass, including the new `complementaryTemplate` assertions.
2. **Instant mode, head-receives preset (e.g. Researcher)**:
   - Open Link-up modal, select parent A and child B, pick "Researcher", click SEND
   - Verify terminal A receives the researcher instruction with the relay curl targeting B
   - Verify terminal B receives the complementary instruction describing its role as A's researcher, with the relay curl targeting A
3. **Instant mode, member-receives preset (Reports to me)**:
   - Open Link-up modal, select parent A and child B, pick "Reports to me", click SEND
   - Verify terminal B (the child/member) receives the main instruction telling it to report to A (the head) — NOT terminal A
   - Verify terminal A (the parent/head) receives the complementary instruction telling it to expect reports from B
4. **Instant mode, custom preset**:
   - Open Link-up modal, type a custom instruction, click SEND
   - Verify terminal A (parent) receives the custom instruction with the relay curl
   - Verify terminal B (child) receives a generic "you have been linked" notification with the relay curl
5. **Standing mode, head-receives preset**:
   - Open Link-up modal, switch to Standing, pick "Researcher", click SAVE
   - Verify the standing list shows two entries: `A ← B: <main>` and `B ← A: <complementary>`
   - Send a prompt to A — verify the main instruction is appended
   - Send a prompt to B — verify the complementary instruction is appended
6. **Standing mode, member-receives preset**:
   - Same as above but with "Reports to me" — verify the main order is on B (child) and the complementary is on A (parent)
7. **Partial failure**: Kill terminal B while the modal is open, then click SEND — verify terminal A gets instructed, the modal closes, and a warning toast appears about B.
8. **Delete**: Delete one of the two standing orders — verify the other remains (they are independent).
