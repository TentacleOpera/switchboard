# Add 'process memo' Command to Exit Capture Mode and Process Entries into Plans

## Goal

Memo capture mode currently has no chat-based exit path — the user must clear the conversation to leave, and processing is done only via the Memo modal in the Kanban panel. The user wants a clear `process memo` command that:
1. Exits capture mode.
2. Tells the agent to process all captured memo entries into plan files (one plan per entry).

The agent must advise this command at the end of every memo capture reply, replacing the current footer: "To process entries, use the Memo modal in the Kanban panel (send/copy buttons). Clear the conversation to exit." The command must be stated exactly and just by itself, so the user can copy-paste it.

### Problem Analysis & Root Cause

**Root cause:** The memo workflow (`.agents/workflows/memo.md`) was deliberately designed with "no exit triggers" as Hard Rule #4 (line 13) to prevent accidental exit from capture mode. The only processing path was the Kanban Memo modal (backend-driven, immune to host system prompt overrides). However, this creates a poor UX: the user must leave their chat, open the Kanban panel, find the Memo modal, and use send/copy buttons. A chat-based `process memo` command provides a direct path from capture to plan creation without context-switching.

The current footer text (Hard Rule #5, line 14) reads:
> "To process entries, use the Memo modal in the Kanban panel (send/copy buttons). Clear the conversation to exit."

This needs to be replaced with a footer that advises the `process memo` command. The command itself must be a new exception to the "no exit triggers" rule — it is the one and only chat-based exit/processing command.

### Relationship to Prior Bug History

The prior plan `feature_plan_20260622120011_memo-exit-trigger-exact-match.md` (implemented + reviewed 2026-06-22) addressed a real bug: chat exit triggers were specified as **loose phrase-presence / substring matching** ("When the user says any of…"), so a memo entry that merely *contained* "investigate" and "memo" mid-sentence (e.g. *"memo instruction gets overridden…, investigate and propose a fix"*) was misread as an exit command, dumping the user out of capture mode and triggering plan generation on a half-written memo. That was the root cause: **in-sentence / substring matching**, not the mere existence of a chat-based exit.

The prior plan's *response* was to remove all chat-based exit triggers entirely and route processing through the button-driven Memo modal. That was an over-correction relative to the root cause — it eliminated the chat-exit UX surface altogether instead of fixing the matching semantics. This plan corrects the over-correction by restoring a chat-based exit with the root cause directly addressed:

- **Old buggy design:** a *5-phrase* exit list (`investigate memo`, `analyze memo`, `refine memo`, `process memo`, `send memo to planner`) matched as **loose phrase-presence** — trigger words embedded in a longer sentence fired the exit. This is the bug class that must stay dead.
- **This plan:** a *single* distinctive 2-word command (`process memo`) matched as **the entire message, exactly** (case-insensitive, whitespace-trimmed) — not substring, not phrase-presence. The strengthened anti-example explicitly teaches that "I want to process memo later" is content, not a command.

The root cause (in-sentence substring matching) is directly fixed by the exact-whole-message match requirement. The prior plan's secondary, weaker concern — that an LLM might *occasionally* misfire even on an exact-match instruction — is a residual low-probability risk, not the original bug class. It is mitigated by the single-command scope (vs. the old 5-phrase surface) and the anti-example, and the Memo modal remains as the guaranteed-capture, button-driven fallback for anyone who hits the misfire case.

## Metadata

- **Tags:** feature, ux, docs
- **Complexity:** 4/10
- **Files affected:** `.agents/workflows/memo.md`, `AGENTS.md`
- **Shipped state:** The memo workflow has shipped in released versions. The `/memo` command and its rules are distributed as `.agents/` files. Changes to workflow files are scaffolded/overwritten on setup, so no file migration is needed — but the change must be backward-compatible (existing memo files are unaffected). This is a behavior change to shipped state: existing users who update will see a new footer and gain a new exit command; users on older versions are unaffected.

## User Review Required

**No — user has confirmed the design direction.** The prior bug (`feature_plan_20260622120011`) was in-sentence / substring matching of a 5-phrase exit list, which the exact-whole-message match requirement in this plan directly fixes. The user has reviewed the prior bug history and confirmed that restoring a single exact-match chat exit (rather than the prior plan's remove-all-exits over-correction) is the intended behavior. The residual low-probability LLM-misfire-on-exact-match risk is accepted; the Memo modal remains as the button-driven fallback.

## Complexity Audit

### Routine
- Updating Hard Rule #4 in `memo.md` to add `process memo` as the single exception to "no exit triggers."
- Updating Hard Rule #5 in `memo.md` to replace the footer text with the `process memo` command advisory.
- Updating the `memo.md` front-matter description (line 2) — currently says "no exit," which becomes inaccurate.
- Adding a new "Process Memo Command" section to `memo.md` describing the `process memo` flow.
- Updating the "Processing Captured Entries" section to mention the chat command as an alternative to the Memo modal.
- Updating `AGENTS.md` line 100 to reflect the new command.
- Updating the `AGENTS.md` workflow registry table (line 21) description.

### Complex / Risky
- The prior bug class (in-sentence / substring matching of a 5-phrase exit list) must stay dead. The new `process memo` command is scoped to a *single* distinctive 2-word command matched as **the entire message, exactly** (case-insensitive, whitespace-trimmed) — not substring, not phrase-presence. The anti-example section (lines 16-25) is strengthened to explicitly teach that "I want to process memo later" is content, not a command. This directly fixes the original root cause rather than re-introducing it.
- Residual low-probability risk: an LLM may *occasionally* misfire even on an exact-match instruction (the prior plan's weaker secondary concern, not the original bug). Mitigated by single-command scope + anti-example; the Memo modal remains as the guaranteed-capture, button-driven fallback.
- The Memo modal remains as the guaranteed-capture path. The chat command is a convenience, not a replacement — both paths should be documented.

## Edge-Case & Dependency Audit

1. **Exact match requirement:** The `process memo` command must only trigger when the user's message is exactly "process memo" (case-insensitive, whitespace-trimmed, as the entire message). If the phrase appears embedded in a longer sentence (e.g., "I want to process memo entries later"), it must be treated as memo content, not a command. This is the direct fix for the prior in-sentence/substring bug class — the match is on the whole message, not on phrase presence.
2. **Memo modal coexistence:** The Memo modal in the Kanban panel remains fully functional. The `process memo` chat command is an additional path, not a replacement. Both must work.
3. **AGENTS.md consistency:** The AGENTS.md Memo Capture Mode Priority Rule (line 100) currently says "There are no exit triggers — capture mode is permanent for the conversation; the user clears the conversation to leave." This must be updated to mention the `process memo` exception.
4. **SKILL.md:** `.agents/skills/memo/SKILL.md` is currently a 3-line redirect to the workflow file. No change needed — it points to `memo.md` which will be updated.
5. **Plan generation behavior:** When `process memo` is invoked, the agent exits capture mode and processes each memo entry into a separate plan file (one plan per entry), following the standard Switchboard plan format. The agent reads `.switchboard/memo.md`, parses entries (blank-line-separated blocks), and creates a plan file per entry in `.switchboard/plans/`. **Parsing rule (Clarification):** one plan per blank-line-separated block, treating each block as one entry regardless of whether it reads as a clean "issue." A block that is non-actionable (e.g., "remember to buy milk") still produces a plan file; the user can delete it from the Kanban board. A block that mentions multiple distinct bugs still produces a single plan (the user can split it later). This removes the ambiguity between "one plan per issue" (Goal) and "one plan per entry" (Proposed Change) — they are the same thing: one plan per blank-line-separated block.
6. **Memo file clearing — DO NOT clear (resolved contradiction):** After processing, the agent must **NOT** clear `.switchboard/memo.md`. This is consistent with CLAUDE.md's data-preservation ethos and the prior design where only the Memo modal (button-driven) clears the file. The user can clear the memo via the Memo modal if desired. **Known limitation:** this creates a re-processing hazard — if the user runs `process memo` twice without clearing, duplicate plan files are generated. This is accepted; the user manages it by clearing via the Memo modal after a successful `process memo`. The agent should remind the user of this in its completion report.
7. **First-turn UX (Clarification):** The `/memo` entry message (Process step 1) writes out the memo list and enters capture mode. Because Hard Rule #5 puts the `process memo` footer on every capture-mode reply (including the first), the user does see the command on entry. To avoid it being cryptic on first contact, Process step 1 should include a brief one-line note that `process memo` exits capture mode and processes entries into plans.

## Dependencies

- `feature_plan_20260622120011_memo-exit-trigger-exact-match.md` — prior plan that removed all chat-based exit triggers as an over-correction for the in-sentence/substring false-exit bug. This plan corrects that over-correction by restoring a single exact-match chat exit. Read before implementation to understand the original bug class that the exact-match requirement must keep dead.
- `feature_plan_20260624102449_update-readme-and-tutorial-docs-with-latest-features.md` — docs plan that describes memo capture behavior in README/tutorial text. It already anticipates "the upcoming 'process memo' command" and should be coordinated so its memo description matches the shipped behavior.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) re-introducing a chat exit could re-open the prior in-sentence/substring false-exit bug class — directly mitigated by scoping to a single distinctive 2-word command matched as the *entire message, exactly* (not phrase-presence), plus a strengthened anti-example; this fixes the original root cause rather than restoring the old 5-phrase loose-match design. (2) An internal clear/don't-clear contradiction was resolved in favor of "do not clear" (data preservation), accepting a re-processing hazard the user manages via the Memo modal. (3) The `memo.md` front-matter description and three required plan sections were missing and are now added. The Memo modal is retained as the guaranteed-capture, button-driven fallback for the residual low-probability LLM-misfire-on-exact-match case.

## Proposed Changes

### 1. Update `.agents/workflows/memo.md`

**A. Front-matter description (line 2) — remove the now-inaccurate "no exit":**

Change from:
```
description: Memo capture mode — append-only, no analysis, no exit
```
to:
```
description: Memo capture mode — append-only, no analysis; exit with `process memo`
```

**B. Hard Rule #4 (line 13) — add the `process memo` exception:**

Change from:
```
4. **No exit.** Capture mode is permanent for the duration of this conversation. There are no exit triggers. Every message — including "investigate memo", "analyze memo", "clear memo", or any other phrase — is memo content to be appended verbatim. To leave capture mode, the user clears the conversation.
```
to:
```
4. **No exit, except `process memo`.** Capture mode is permanent for the duration of this conversation. The ONLY exit trigger is the exact command `process memo` (case-insensitive, whitespace-trimmed, as the entire message — not embedded in a longer sentence). Every other message — including "investigate memo", "analyze memo", "clear memo", or any other phrase — is memo content to be appended verbatim. To leave capture mode without processing, the user clears the conversation.
```

**C. Hard Rule #5 (line 14) — replace the footer text:**

Change from:
```
5. **Re-assert every turn.** Begin every capture-mode reply with the marker `[MEMO CAPTURE ACTIVE]` and end with: "To process entries, use the Memo modal in the Kanban panel (send/copy buttons). Clear the conversation to exit."
```
to:
```
5. **Re-assert every turn.** Begin every capture-mode reply with the marker `[MEMO CAPTURE ACTIVE]` and end with exactly:

process memo
```

**D. Update the Anti-Example section (lines 16-25) — add `process memo` to the anti-example:**

Append after the existing anti-example:
```
The command `process memo` is the sole exception: it must be the entire message, exactly "process memo" (case-insensitive). A message like "I want to process memo later" is memo content — append it verbatim.
```

**E. Add a new section after "Process" (after line 30):**

```markdown
## Process Memo Command

When the user sends exactly `process memo` (case-insensitive, whitespace-trimmed, as the entire message — not embedded in a longer sentence):

1. **Exit capture mode.** Stop appending to `.switchboard/memo.md`. This message is NOT appended.
2. **Read the full memo.** Read `.switchboard/memo.md` and parse entries (blank-line-separated blocks).
3. **Create one plan per entry.** For each blank-line-separated block, create a separate plan file in `.switchboard/plans/` following the standard Switchboard plan format (Goal, Metadata, Complexity Audit, Edge-Case & Dependency Audit, Proposed Changes, Verification Plan). Use the naming convention `feature_plan_<timestamp>_<slug>.md`. Treat each block as one entry regardless of whether it reads as a clean "issue" — non-actionable entries still produce a plan file the user can delete.
4. **Report.** List the created plan files and their derived titles. Remind the user that `.switchboard/memo.md` was NOT cleared and that re-running `process memo` will create duplicates — to clear the memo, use the Memo modal in the Kanban panel.
5. **Do not clear the memo file.** The user can clear it via the Memo modal if desired.

This is the only chat-based exit from capture mode. The Memo modal in the Kanban panel remains the alternative processing path (backend-driven, immune to host system prompt overrides).
```

**F. Update the "Processing Captured Entries" section (lines 32-33):**

Change from:
```
## Processing Captured Entries
To process memo entries into plan files, use the Memo modal in the Kanban panel. The modal's "send" button dispatches entries to the planner and clears the memo; the "copy" button copies the planner prompt to clipboard and clears the memo. This is the only way to process entries — chat capture mode has no exit triggers. This path is backend-driven and immune to host system prompt overrides.
```
to:
```
## Processing Captured Entries
There are two ways to process memo entries into plan files:

1. **Chat command:** Send exactly `process memo` to exit capture mode and have the agent create one plan file per entry. The memo file is NOT cleared by this path — clear it via the Memo modal to avoid duplicates on re-run.
2. **Memo modal (Kanban panel):** The modal's "send" button dispatches entries to the planner and clears the memo; the "copy" button copies the planner prompt to clipboard and clears the memo. This path is backend-driven and immune to host system prompt overrides.
```

**G. Update Process step 1 (line 28) — add a one-line note about `process memo` on entry (Clarification):**

Append to the existing step 1 text:
```
After stating the total count, add: "To process these entries into plan files and exit capture mode, send: process memo"
```

### 2. Update `AGENTS.md` (line 100)

Change from:
```
While `/memo` capture mode is active, capture mode takes precedence over the default "analyze and act" behavior. The agent appends each user message to `.switchboard/memo.md` and does NOT analyze, plan, or write code. Every capture-mode reply begins with `[MEMO CAPTURE ACTIVE]`. There are no exit triggers — capture mode is permanent for the conversation; the user clears the conversation to leave. To process captured entries into plan files, use the Memo modal in the Kanban panel (send/copy buttons). For guaranteed capture that no host system prompt can override, use the Memo modal.
```
to:
```
While `/memo` capture mode is active, capture mode takes precedence over the default "analyze and act" behavior. The agent appends each user message to `.switchboard/memo.md` and does NOT analyze, plan, or write code. Every capture-mode reply begins with `[MEMO CAPTURE ACTIVE]` and ends by advising the command `process memo`. The sole exit trigger is the exact command `process memo` (case-insensitive, as the entire message) — it exits capture mode and processes all entries into plan files (one per entry). To leave without processing, clear the conversation. The Memo modal in the Kanban panel remains as an alternative processing path (backend-driven, immune to host system prompt overrides).
```

### 3. Update the workflow registry table in `AGENTS.md` (line 21)

Change from:
```
| `/memo` | **`memo.md`** | Memo capture mode — append-only, no analysis, no exit. |
```
to:
```
| `/memo` | **`memo.md`** | Memo capture mode — append-only, no analysis. Exit with `process memo`. |
```

## Verification Plan

> Per session directives: **SKIP compilation** and **SKIP automated tests.** Verification is manual/behavioral only.

### Automated Tests

- None. This is a documentation/prompt-engineering change to `.agents/` workflow files and `AGENTS.md`; the project test suite does not cover agent prompt text. (Skipped per session directive in any case.)

### Manual Behavioral Verification

1. **Enter memo mode:** Type `/memo` in an IDE chat. Verify the agent enters capture mode, the first reply includes the new one-line note about `process memo`, and the reply ends with `process memo` (not the old "use the Memo modal" text).
2. **Capture entries:** Send 2-3 test messages. Verify each is appended to `.switchboard/memo.md` and the reply ends with `process memo`.
3. **Anti-example test:** Send a message like "I want to process memo later" — verify it is appended as memo content, NOT treated as the exit command.
4. **Process memo:** Send exactly `process memo`. Verify:
   - The agent exits capture mode (no `[MEMO CAPTURE ACTIVE]` marker in the response).
   - The agent reads `.switchboard/memo.md` and creates one plan file per blank-line-separated entry in `.switchboard/plans/`.
   - The plan files follow the standard Switchboard plan format and the `feature_plan_<timestamp>_<slug>.md` naming convention.
   - The completion report lists the created files and reminds the user the memo file was NOT cleared.
   - `.switchboard/memo.md` is NOT cleared by the chat command.
5. **Re-processing hazard check:** Send `process memo` a second time without clearing the memo — verify duplicate plan files are generated (confirming the documented limitation), then clear via the Memo modal.
6. **Memo modal still works:** Verify the Kanban Memo modal send/copy buttons still function independently and clear `.switchboard/memo.md` on use.
7. **AGENTS.md consistency:** Verify the AGENTS.md memo section (line 100) and workflow registry table (line 21) reflect the new `process memo` command, and that `memo.md` front-matter description (line 2) no longer says "no exit."

## Recommendation

Complexity is 4 → **Send to Coder.** Documentation/prompt-engineering change across 2 files with no code surface, but it modifies shipped agent behavior and must keep the prior in-sentence/substring false-exit bug class dead via the exact-whole-message match requirement. The user has already confirmed the design direction (User Review Required = No).

---

## Reviewer Pass (2026-06-24)

### Stage 1 — Adversarial Findings

- **CRITICAL — None.** The core mechanism (exact-whole-message match in Hard Rule #4, `process memo` footer, Process Memo Command section) is correct and does not re-introduce the in-sentence/substring false-exit bug class.
- **MAJOR — `memo.md:25-27` (pre-fix):** Stale anti-example body still claimed "There are no chat-based exit commands" and "Processing is done only via the Memo modal in the Kanban panel." This directly contradicted Hard Rule #4 (line 13), the appended exception sentence (line 29), and the two-paths "Processing Captured Entries" section (lines 48-52). The plan's section 1D said "append after the existing anti-example," which the implementation did — but it left the stale body text that the append now contradicts, creating an internal contradiction in the same section. An LLM reading the workflow file would get conflicting signals.
- **NIT — `AGENTS.md:91`:** Skill registry one-liner for `memo` does not mention the `process memo` exit. The plan did not scope this line; the workflow registry table (line 21) was updated. Minor inconsistency, not material to behavior.
- **NIT — `memo.md:32`:** Process step 1 entry note runs into "Enter capture mode" without a separator (`...send: process memo" Enter capture mode.`). Cosmetic only.

### Stage 2 — Balanced Synthesis

**Keep:** Hard Rule #4 (line 13), Hard Rule #5 footer (lines 14-16), Process Memo Command section (lines 36-46), Processing Captured Entries two-paths section (lines 48-52), AGENTS.md line 100, AGENTS.md line 21, front-matter description (line 2) — all match the plan exactly.
**Fix now:** `memo.md:25-27` stale anti-example body — rewrite to remove the false "no chat-based exit commands" / "only via the Memo modal" claims while preserving the core teaching (embedded trigger words = content).
**Defer:** AGENTS.md:91 skill one-liner and memo.md:32 punctuation — cosmetic, not material.

### Stage 3 — Code Fixes Applied

- **`memo.md:24-28` (MAJOR fix):** Rewrote the anti-example body. Removed "There are no chat-based exit commands" and "Processing is done only via the Memo modal in the Kanban panel." Replaced with: "Trigger words embedded inside a longer sentence are always memo content — the sole chat-based exit is the exact whole-message command `process memo` (see Hard Rule #4 and the Process Memo Command section below). The Memo modal in the Kanban panel remains the alternative processing path." This eliminates the internal contradiction; the appended exception sentence (line 30) now reinforces rather than contradicts the body.

### Stage 4 — Verification

- **Compilation:** Skipped per session directive.
- **Automated tests:** Skipped per session directive (project test suite does not cover agent prompt text in any case).
- **Stale-reference scan:** `grep` for `no chat-based exit|only via the Memo modal|no exit` in `memo.md` → **0 matches** post-fix. Contradiction eliminated.
- **AGENTS.md scan:** `grep` for the same stale patterns → **0 matches**. AGENTS.md lines 21 and 100 verified to match the plan exactly.
- **Git diff:** Only the anti-example body fix is uncommitted (` M .agents/workflows/memo.md`). All other implementation changes were committed in `45d2027`.

### Files Changed

- `.agents/workflows/memo.md` — anti-example body rewritten (MAJOR fix, lines 24-28). All other memo.md changes were committed in `45d2027` and verified correct.
- `AGENTS.md` — committed in `45d2027`, verified correct (lines 21, 100). No review changes.

### Remaining Risks

1. **Re-processing hazard (accepted):** `process memo` does NOT clear `.switchboard/memo.md`; re-running creates duplicate plan files. Documented in the Process Memo Command section and the completion-report step. User manages via Memo modal clearing. This is the plan's accepted design decision, not a defect.
2. **Residual LLM-misfire-on-exact-match (accepted):** An LLM may occasionally misfire even on an exact-match instruction. Mitigated by single-command scope + anti-example; Memo modal remains the button-driven fallback. Accepted by the user.
3. **AGENTS.md:91 skill one-liner (NIT, deferred):** Does not mention `process memo`. Not material to behavior; the workflow registry table (line 21) and the priority rule (line 100) both carry the full guidance.
4. **memo.md:32 punctuation (NIT, deferred):** Entry note runs into "Enter capture mode" without a separator. Cosmetic only.
