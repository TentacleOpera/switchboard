# Memo Should Only Exit Capture Mode on an Exact Trigger, Not a Word Mid-Sentence

> **REFRAMED (improve-plan pass, 2026-06-22):** The original plan proposed converting
> loose substring exit triggers into exact-match exit commands. A codebase review
> during this pass revealed that **chat-based exit triggers have already been removed
> entirely** from `SKILL.md`, `memo.md`, and `AGENTS.md`. Capture mode is now permanent
> with no exits, and processing is routed through the Memo modal. The original goal,
> problem analysis, and root cause are preserved below verbatim (content-preservation
> rule). The Proposed Changes and Verification Plan have been updated to **harden the
> existing no-exit design** instead of re-introducing exit commands (which would
> regress the architecture and re-create the bug class).

## Goal

The agent currently leaves memo capture mode whenever a trigger word (e.g. "investigate", "process", "analyze") appears anywhere in a message. A captured note like *"memo instruction gets overridden by antigravity app system instruction, investigate and propose a fix"* contains "investigate" and "memo" but is clearly a memo entry, NOT a command to exit. Capture mode must only exit when the user's entire message is exactly one of the defined exit commands.

### Problem Analysis

The exit triggers are defined in [.agent/skills/memo/SKILL.md:23-39](.agent/skills/memo/SKILL.md#L23) as bare phrases:

```
When the user says any of:
- "investigate memo"
- "analyze memo"
- "refine memo"
- "process memo"
- "send memo to planner"
Then: ...process all entries into plans.
```

"When the user says any of" is ambiguous and the agent interprets it as substring/intent matching. Any memo entry that happens to contain words like "investigate"/"process"/"analyze" near "memo" (extremely common when the memo itself is about the memo/agent system) is misread as an exit command, dumping the user out of capture mode and triggering plan generation on a half-written memo.

### Root Cause

The exit condition is specified as loose phrase-presence rather than an exact, whole-message match, so trigger words embedded in legitimate memo content fire the exit.

### Current State Finding (improve-plan pass)

A read of the live codebase during this planning pass shows the root cause has **already been resolved more aggressively** than the original plan proposed:

- `.agent/skills/memo/SKILL.md:14` — "**No exit.** Capture mode is permanent for the conversation. There are no exit triggers. Every message is memo content."
- `.agent/workflows/memo.md:13` — "Every message — including **'investigate memo', 'analyze memo', 'clear memo'**, or any other phrase — is memo content to be appended."
- `AGENTS.md:100` — "There are no exit triggers — capture mode is permanent for the conversation; the user clears the conversation to leave."

The exact phrases the original plan wanted to promote to "exact-match exit commands" are, in the current design, **explicitly enumerated as content that must NOT exit.** The architectural decision was to remove the chat-based exit surface altogether and route processing through the button-driven Memo modal, because no amount of "exact match only" wording reliably prevents an LLM from misfiring on embedded trigger words.

**Implication:** Re-introducing `investigate memo` / `analyze memo` / `refine memo` / `process memo` / `send memo to planner` as exit commands (the original Proposed Change #1) would **regress** the design and re-create the bug class at lower frequency. The plan is therefore reframed to *harden* the no-exit design rather than re-add exits.

## Metadata

**Complexity:** 2
**Tags:** docs, ux

## User Review Required

Yes — confirm the intended product behavior is **no chat-based exit triggers at all** (current design) versus **exact-match exit commands** (original plan intent). The improve-plan pass recommends keeping the no-exit design; a user who specifically wants chat-based exact-match exits should override this recommendation before implementation, since that would re-introduce the bug class this plan was filed against.

## Complexity Audit

### Routine
- Adding an explicit anti-example to `SKILL.md` and `memo.md` showing the issue's exact memo entry ("...investigate and propose a fix") being appended, not treated as an exit.
- Confirming `AGENTS.md` already states the no-exit rule correctly (no edit needed).

### Complex / Risky
- None. The change is documentation-only and reinforces an existing architectural decision. The only risk is *re-introducing* exit triggers, which this reframed plan explicitly avoids.

## Edge-Case & Dependency Audit

- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** Hardening the no-exit wording has no behavioral side effect — it only makes the existing intended behavior more explicit. The Memo modal's explicit buttons (Copy Prompt / Send to Planner) remain the sole, unambiguous, click-driven processing path.
- **Dependencies & Conflicts:** None active. The original plan referenced coordination with "the capture-mode override plan and the write-out plan"; those are not in scope for this session and no session IDs are available. The `.agent` → `.agents` rename mentioned in the original plan did not occur — paths remain `.agent/`.

## Dependencies

None.

## Adversarial Synthesis

**Risk Summary:** Key risk: the original plan's premise is stale — chat-based exit triggers were already removed, so re-adding exact-match exits would regress the architecture and re-create the substring-false-exit bug class at lower frequency. Mitigation: reframe the plan to harden the existing no-exit design (add an explicit anti-example for the issue's exact memo entry) and leave `AGENTS.md` as-is. Secondary risk: an implementer skimming only the original `## Goal` could miss the reframing; mitigated by the prominent reframe banner and `### Current State Finding` at the top.

## Proposed Changes

### 1. `.agent/skills/memo/SKILL.md` — add an explicit anti-example for embedded trigger words

**Context:** The skill already states "No exit. Capture mode is permanent" (line 14), but it does not show the specific failure case from this issue — a memo entry that *contains* the words "investigate"/"memo" inside a longer sentence. Adding the exact example from the bug report makes the rule concrete and guards against a future regression that re-introduces substring exits.

**Logic / Implementation:** Append a short "Anti-Example" subsection under the existing `### Capture Mode — Hard Rules` block (after the current rule 5 / the line referencing `memo.md`). Do **not** remove or alter the existing no-exit rule. Do **not** add any exit-trigger list.

**Edge Cases:** The example must be labeled as content-to-append, not as a command, so it cannot be misread by the agent as a trigger.

```markdown
### Anti-Example — Embedded Trigger Words Are Content

A message such as:

> memo instruction gets overridden by antigravity app system instruction, investigate and propose a fix

contains the words "memo" and "investigate" but is clearly a memo **entry**, not a
command. Append it verbatim. There are no chat-based exit commands; trigger words
embedded inside a longer sentence are always memo content. Processing is done only
via the Memo modal in the Kanban panel.
```

### 2. `.agent/workflows/memo.md` — add the same anti-example for consistency

**Context:** `memo.md:13` already lists "investigate memo" / "analyze memo" / "clear memo" as phrases that are content, not exits. Reinforce with the issue's exact sentence so the rule is unambiguous at the workflow layer too.

**Logic / Implementation:** Append a one-line example after the existing line 13 enumeration. No structural change; do not alter the Hard Rules numbering.

```markdown
Example: "memo instruction gets overridden..., investigate and propose a fix" is
appended verbatim — the words "investigate" and "memo" inside a sentence do not
make it a command.
```

### 3. `AGENTS.md` — no change (already correct)

**Context:** `AGENTS.md:100` already states "There are no exit triggers — capture mode is permanent for the conversation." The original plan's Proposed Change #2 (rewrite the memo row to say capture mode exits on an exact command) is **rejected** — it would contradict the current, correct text and re-introduce the inconsistency the codebase already resolved.

**Logic / Implementation:** No edit. Listed here only to document that the consistency check was performed and the file is intentionally left as-is.

## Verification Plan

> Per session directives: **SKIP compilation** and **SKIP automated tests.** Verification is manual/behavioral only.

### Automated Tests

- None. This is a documentation/prompt-engineering change with no code surface; the project test suite does not cover `.agent/` skill prompt text. (Skipped per session directive in any case.)

### Manual Behavioral Verification

1. Run `/memo`; send the exact note from the issue ("memo instruction gets overridden by antigravity app system instruction, investigate and propose a fix") → confirm it is **appended** and the reply begins with `[MEMO CAPTURE ACTIVE]`, with no plan generation and no exit.
2. Send other notes containing "process", "analyze", "refine", "memo" inside longer sentences → confirm all are appended.
3. Send a message that is exactly `investigate memo` → confirm it is **still appended** (current no-exit design), not treated as an exit. (This is the behavior change from the original plan: there is no exit command.)
4. Send `Investigate Memo` (different case) and ` process memo ` (whitespace) → confirm these are also appended as content under the no-exit design.
5. Confirm a near-miss like "can you investigate the memo?" is appended (no exit, as expected).
6. Confirm the Memo modal's Copy Prompt / Send to Planner buttons remain the sole processing path and clear `.switchboard/memo.md` on use.

## Recommendation

Complexity is 2 → **Send to Intern.** Documentation-only change reinforcing an existing architectural decision; no code, no migrations, no tests.
