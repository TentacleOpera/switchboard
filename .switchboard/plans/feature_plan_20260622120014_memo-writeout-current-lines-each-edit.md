# Memo Skill: Write Out the Current Memo Lines After `/memo` and After Every Edit

## Goal

When using the memo skill, after the user types `/memo` and after every subsequent edit (append) to the memo file, the agent should write out the current list of memo lines so the user always sees the full, up-to-date memo contents.

### Problem Analysis

The memo skill [.agent/skills/memo/SKILL.md](.agent/skills/memo/SKILL.md) currently:
- On `/memo` ("Capture Mode") — reads the file and displays "current entry count and last few entries" ([9-13](.agent/skills/memo/SKILL.md#L9)).
- On each appended entry — responds only with `Added to memo: "<first 50 chars>..." (N entries total)` ([15-21](.agent/skills/memo/SKILL.md#L15)).

So after edits the user sees a one-line truncated acknowledgement, not the full current memo. There is no instruction to echo the complete, numbered list of memo lines after each change, which makes it hard to track what has been captured and to catch mis-captured entries.

The same truncated acknowledgement format is duplicated in the **workflow file** [.agent/workflows/memo.md](.agent/workflows/memo.md) ([18-19](.agent/workflows/memo.md#L18)), and line 12 of that workflow restricts file reading to "the first turn." Per AGENTS.md Rule #1, workflows are executed step-by-step and take enforcement precedence over skills. Any change to the skill that is not mirrored in the workflow file will be overridden in practice.

### Root Cause

The skill AND workflow both specify a truncated, single-entry acknowledgement instead of re-emitting the full current memo list after each append (and on `/memo` entry). The workflow additionally restricts memo-file reading to the first turn only, which would block the re-read needed for a full write-out.

## Metadata

**Complexity:** 2
**Tags:** ux

## User Review Required

Yes — confirm that the full numbered write-out (rather than a truncated acknowledgement) is desired after every append, including for long memos. Also confirm the desired behavior after "clear memo" (show "(0 entries total)").

## Complexity Audit

### Routine
- Editing the skill instructions to require a full, numbered write-out of memo lines after `/memo` and after each append.
- Editing the workflow file to mirror the same write-out format and to lift the "first turn only" reading restriction.
- Specifying the post-"clear memo" display.
- No source code (TypeScript) changes — this is prompt/skill text only.

### Complex / Risky
- None. The change is confined to two instructional markdown files. The on-disk memo format and `_parseMemoEntries` parsing logic are unchanged.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The memo file is written and read by a single agent in a single conversation; no concurrent writers.
- **Security:** None. The memo file is local workspace state.
- **Side Effects:** Echoing the full memo each turn is more verbose; acceptable and explicitly requested. Must not break capture mode (no analysis — just display). The re-read of `.switchboard/memo.md` on every turn is within the skill's "no files beyond `.switchboard/memo.md`" rule, but the workflow's current "first turn only" reading restriction (memo.md line 12) MUST be lifted to permit per-turn re-reads.
- **Dependencies & Conflicts:** 
  - Depends on the capture-mode override fix plan (`feature_plan_20260622120010_memo-instruction-antigravity-override-fix.md`) — if capture mode does not hold, the write-out never happens. This plan assumes capture mode is functional.
  - After the `.agent` → `.agents` rename (if/when it happens), both file paths change. Current paths: `.agent/skills/memo/SKILL.md` and `.agent/workflows/memo.md`.
  - The on-disk format is one issue per blank-line-separated block. The append rule in both the skill and workflow already mandates blank-line separation between entries. Because blank-line separators are always inserted, the paragraph-split path in `_parseMemoEntries` ([KanbanProvider.ts:7017-7039](src/services/KanbanProvider.ts#L7017)) is the active code path, so the agent's blank-line-based numbering will match the issue count "Send to Planner" produces. **Assumption:** the append rule's blank-line separator is always followed. If a host strips blank lines, the fallback prefix-based path in `_parseMemoEntries` would produce a different count — but that is out of scope for this plan.

## Dependencies

- `feature_plan_20260622120010_memo-instruction-antigravity-override-fix.md` — Memo capture-mode override fix. This plan's write-out only manifests if capture mode holds.

## Adversarial Synthesis

Key risks: (1) the workflow file duplicates the truncated format and enforces a "first turn only" read restriction — if not updated, it overrides the skill and the write-out never appears; (2) segmentation mismatch with `_parseMemoEntries` if blank-line separators are ever missing. Mitigations: update BOTH the skill and workflow file in lockstep; rely on the existing blank-line append rule to keep segmentation consistent, and state this as an explicit assumption rather than an invariant.

## Proposed Changes

### 1. `.agent/skills/memo/SKILL.md` — require a full write-out

Update Capture Mode entry ([9-13](.agent/skills/memo/SKILL.md#L9)):
```markdown
### Capture Mode — Hard Rules

1. **Append, do not answer.** Append the user's message to `.switchboard/memo.md` and acknowledge. You may not analyze, investigate, plan, write code, or offer help.
2. **No eager analysis.** A message that looks like a question, bug report, or task is still memo content — append it verbatim.
3. **No eager action.** Do not run tools, search codebase, or read files beyond `.switchboard/memo.md`. Re-reading `.switchboard/memo.md` on every turn (to write out the full list) is permitted and required.
4. **No exit.** Capture mode is permanent for the conversation. There are no exit triggers. Every message is memo content.
5. **Re-assert every turn.** Begin every reply with `[MEMO CAPTURE ACTIVE]`.
```

Update Appending Entries ([19-24](.agent/skills/memo/SKILL.md#L19)):
```markdown
### Appending Entries

For each user message while in capture mode:

1. Append the user's message text to `.switchboard/memo.md`, separated from previous entries by a blank line.
2. Re-read `.switchboard/memo.md` and write out the FULL current memo as a numbered list
   (each blank-line-separated entry = one numbered item), ending with
   "(N entries total) — still capturing."
3. Do NOT analyze, investigate, plan, or write code — just capture and echo the list.
```

Update Clearing ([26-32](.agent/skills/memo/SKILL.md#L26)):
```markdown
### Clearing

If the user says "clear memo":

1. Truncate `.switchboard/memo.md` to empty.
2. Respond with: `[MEMO CAPTURE ACTIVE] Memo cleared. (0 entries total) — still capturing.`
3. Stay in capture mode.
```

Example output the skill should produce after each edit:
```
[MEMO CAPTURE ACTIVE]
1. Bug: login button overlaps on mobile
2. Thought: maybe cache the user profile
3. Issue: API returns 500 on empty payload
(3 entries total) — still capturing.
```

### 2. `.agent/workflows/memo.md` — mirror the write-out and lift the read restriction

**Context:** The workflow file is read and executed step-by-step per AGENTS.md Rule #1 and takes enforcement precedence over the skill. It currently contains the same truncated format and a "first turn only" reading restriction. Both must be updated in lockstep with the skill.

Update Hard Rule #3 ([memo.md:12](.agent/workflows/memo.md#L12)):
```markdown
3. **No eager action.** Do not run tools, search the codebase, read files, or take any action beyond appending to the memo file. Reading `.switchboard/memo.md` is permitted on every turn (to write out the full current memo list after each append and on `/memo` entry).
```

Update Process step 1 (Initialize) ([memo.md:17](.agent/workflows/memo.md#L17)):
```markdown
1. **Initialize:** On `/memo`, read `.switchboard/memo.md` (create if absent). Write out the FULL current memo as a numbered list (one number per blank-line-separated entry), then state the total count. Enter capture mode.
```

Update Process step 2 (Capture) ([memo.md:18-19](.agent/workflows/memo.md#L18)):
```markdown
2. **Capture:** For each subsequent message — every message, no exceptions — append verbatim to `.switchboard/memo.md`, separated from previous entries by a blank line. Then re-read the file and write out the FULL current memo as a numbered list (each blank-line-separated entry = one numbered item), ending with "(N entries total) — still capturing."
```

Update In-Capture Commands ("clear memo") ([memo.md:22](.agent/workflows/memo.md#L22)):
```markdown
- "clear memo" — truncates `.switchboard/memo.md` to empty, confirms "Memo cleared. (0 entries total) — still capturing.", and STAYS in capture mode. This is memo content that triggers a side action, not an exit.
```

## Verification Plan

### Automated Tests

No automated tests apply — this is a prompt/skill text change with no TypeScript logic changes. The test suite will be run separately by the user.

### Manual Verification

1. Run `/memo` in a workspace with an existing `.switchboard/memo.md` → confirm the agent prints the full numbered list of existing entries and the count.
2. Append three entries one at a time → after each, confirm the agent prints the complete current numbered list (not just the new line) with the updated count.
3. Confirm the numbering matches blank-line segmentation (so it equals the issue count "Send to Planner" would generate), given the append rule's blank-line separator is followed.
4. Run "clear memo" → confirm the agent responds with "Memo cleared. (0 entries total) — still capturing." and stays in capture mode.
5. Confirm capture mode is not broken (no analysis, entries still appended, every reply begins with `[MEMO CAPTURE ACTIVE]`).

---

**Recommendation:** Complexity 2 → Send to Intern.
