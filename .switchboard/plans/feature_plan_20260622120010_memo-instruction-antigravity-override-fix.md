# Prevent the Antigravity App System Instruction from Overriding Memo Capture Mode

## Goal

When the user invokes `/memo`, the agent is supposed to enter passive *capture mode* (append each message to `.switchboard/memo.md`, no analysis). In the Antigravity app this instruction gets overridden by the app's own system instruction, so the agent breaks out of capture mode and starts analyzing/answering. Investigate and propose a fix that makes capture mode hold despite a competing host system prompt.

### Problem Analysis

The memo behavior is defined only as soft guidance:
- The skill file [.agent/skills/memo/SKILL.md](.agent/skills/memo/SKILL.md) describes capture mode and says "Do NOT analyze, investigate, plan, or write code. Just capture." (line 21)
- `AGENTS.md` summarizes it in one table row ([AGENTS.md:90](AGENTS.md#L90)).

Both are *advisory* context the agent may follow. Inside the Antigravity app, the host injects its own high-priority system instruction (be helpful, analyze, act). When that system prompt conflicts with the skill guidance, the host instruction wins, and the agent abandons capture mode — answering the message instead of silently appending it. There is no enforcement layer and no high-salience re-assertion of the rule.

### Root Cause

Capture mode relies entirely on low-priority instructional text that a host system prompt outranks. There is no (a) authoritative placement in a file the host treats as high-priority, (b) per-turn re-assertion, or (c) backend enforcement of "append, don't answer."

**Proven precedent — `/switchboard-chat` workflow:** The `/switchboard-chat` (aka `/chat`) workflow successfully holds the agent in planning-only mode in Antigravity despite the same host system prompt pressure. Analysis of [.agent/workflows/switchboard-chat.md](.agent/workflows/switchboard-chat.md) reveals why its structure holds where the memo skill's soft guidance does not:

1. **Workflow vs. skill enforcement tier:** The AGENTS.md mandatory pre-flight check (Rule #1, lines 8/25-31) scans every message for workflow triggers and mandates step-by-step execution of the matching workflow file. Skills are merely advisory table rows — they get no such enforcement. The memo behavior is currently a skill, not a workflow, so it has no enforcement tier.
2. **Hard Rules with absolute language:** switchboard-chat uses "You may not", "Do not", "Discard" — imperatives, not soft "should" guidance. Each rule directly counters a specific host-prompt pressure.
3. **Explicit anti-action rules:** Rules #2 ("No eager context"), #3 ("No eager research"), #7 ("Stay in chat") name and forbid the exact behaviors the host system prompt would push. The memo skill has no such anti-action rules.
4. **Structured per-turn process:** The 4-step process (Onboard → Iterate → Plan → Gate) gives the agent a clear script each turn, so it always knows what to do instead of defaulting to the host's "analyze and act."
5. **No exit from within the mode:** switchboard-chat's gate requires explicit user approval to leave. The memo equivalent is even simpler: capture mode has **no exit triggers at all** — the user clears the conversation to leave. This eliminates the entire class of "is this message an exit command or memo content?" ambiguity.

**Honest limitation:** Chat-based capture mode cannot be *guaranteed* by instruction text alone — a sufficiently strong host system prompt can always override advisory text. However, the `/switchboard-chat` workflow demonstrates that **structural** techniques (workflow-tier enforcement, hard rules, anti-action rules, process script) are materially more effective than stronger wording alone. The realistic fix is to adopt this proven structure for memo capture mode, plus steering users to the host-prompt-proof Memo modal for guaranteed capture and processing.

**Design decision — no exit triggers:** Once `/memo` is invoked, capture mode is permanent for the duration of the conversation. There are no exit triggers ("investigate memo", "analyze memo", etc.). The user exits by clearing the conversation. This design choice:
- Eliminates the over-sticky trap entirely (no exit to block).
- Eliminates the exit-trigger vs. content ambiguity (no trigger words to match).
- Eliminates the exact-match boundary problem (no boundary to draw).
- Simplifies the hard rules: "Stay in capture mode" becomes absolute — no exceptions, no permitted exits.
- Moves memo processing (entries → plan files) to the Memo modal, which already has "send" and "copy" buttons (`memoGeneratePrompt` in `KanbanProvider.ts:6969-7004`) that dispatch to the planner and clear the memo.

## Metadata

**Complexity:** 4
**Tags:** docs, feature

## User Review Required

Yes — the plan promotes `/memo` from a skill to a workflow trigger, removes all exit triggers, and modifies instruction text that shapes agent behavior across all hosts (not just Antigravity). The user should confirm:
1. That promoting `/memo` to a workflow trigger (adding it to the AGENTS.md Workflow Registry) is acceptable, given it changes the pre-flight check behavior for all workspaces on next activation.
2. That removing all exit triggers is the intended behavior — once `/memo` is invoked, the only way out is clearing the conversation. Memo processing (entries → plan files) moves to the Memo modal's "send"/"copy" buttons.
3. That the `[MEMO CAPTURE ACTIVE]` marker prefix on every reply is acceptable UX.
4. That editing the **source** AGENTS.md at the repo root (not the workspace copy) is the intended approach, since the workspace copy is auto-regenerated.

## Complexity Audit

### Routine
- Creating `.agent/workflows/memo.md` with hard rules and process (no exit gate).
- Restructuring `.agent/skills/memo/SKILL.md` to mirror the workflow's hard rules, removing the Exit Triggers section, keeping append/clear mechanics.
- Adding the "use the Memo modal for capture and processing" note to both files.
- Adding the first-turn bootstrap note to the marker protocol.

### Complex / Risky
- **Promoting `/memo` to a workflow trigger** (registering it in the AGENTS.md Workflow Registry table and creating `.agent/workflows/memo.md`) is the highest-impact change but has the largest blast radius: it changes the pre-flight check behavior for every workspace. The AGENTS.md protocol block is **auto-generated** by `ensureAgentsProtocol()` in `src/extension.ts:2941-3017` — the source template at the repo root must be edited, not the workspace copy, or the change is silently overwritten on next activation.
- True enforcement against a host system prompt is not fully achievable from instruction text alone. The `/switchboard-chat` precedent shows that structural techniques (workflow tier, hard rules, anti-action rules, process script) are materially more effective than wording alone, but still not a guarantee.
- Removing exit triggers is a **breaking change** for users who currently rely on "investigate memo" etc. to process entries from chat. The memo modal's "send" button (`memoGeneratePrompt` with action "send" → `_dispatchMemoToPlanner`) is the replacement path. Users who only used chat `/memo` need to be aware of this shift.

## Edge-Case & Dependency Audit

- **Race Conditions:** None (instruction content).
- **Security:** None.
- **Side Effects:** Removing exit triggers means "investigate memo", "analyze memo", "refine memo", "process memo", and "send memo to planner" are now treated as memo content (appended verbatim), not as commands. If a user types one of these expecting to process their memo, it will be captured as an entry instead. The acknowledgment message should hint that processing is done via the Memo modal.
- **Dependencies & Conflicts:**
  - Related to the `.agent` → `.agents` rename (the skill path moves). As of this writing, `.agents/skills/` does **not** exist — only `.agent/skills/`. Implement at the current path `.agent/skills/memo/SKILL.md`; if the rename lands later, the skill file moves and cross-references in AGENTS.md (`Skill Files Location: .agent/skills/`) must update. This is a watch-item, not a blocker.
  - The AGENTS.md source template at the repo root is the same file that `ensureAgentsProtocol` bundles into the extension. Editing it changes the protocol block for **all** workspaces on next activation — this is the intended mechanism, but the user should be aware of the blast radius.
  - The memo modal's `memoGeneratePrompt` handler (`KanbanProvider.ts:6969-7004`) already supports both "send" (dispatch to planner + clear memo) and "copy" (clipboard + clear memo). No code changes are needed to support the modal-based processing path.

## Dependencies

- None currently active. Watch-item: `.agent` → `.agents` directory rename (not yet landed).

## Adversarial Synthesis

Key risks: (1) The AGENTS.md protocol block is auto-generated — editing the workspace copy directly will be silently overwritten; the fix must target the source template at the repo root. (2) Instruction-text mitigation alone cannot guarantee capture against a strong host system prompt — but the `/switchboard-chat` workflow proves that structural techniques (workflow-tier enforcement, hard rules, anti-action rules, process script) are materially more effective. (3) Removing exit triggers is a breaking change for users who relied on "investigate memo" etc. from chat — the modal's send/copy buttons are the replacement, but users need to be aware. (4) Promoting `/memo` to a workflow trigger changes the pre-flight check for all workspaces — largest blast radius but highest impact. Mitigations: create a memo workflow file modeled on switchboard-chat.md with no exit gate, register `/memo` in the Workflow Registry (source AGENTS.md), restructure the SKILL.md with hard rules and no Exit Triggers section, have the acknowledgment message hint at modal-based processing, promote modal to co-equal recommendation.

## Proposed Changes

### 1. `.agent/workflows/memo.md` — NEW workflow file modeled on `switchboard-chat.md`

**Context:** The `/switchboard-chat` workflow holds in Antigravity because it's a workflow (enforced by the AGENTS.md pre-flight check), not a skill (advisory only). The memo behavior is currently a skill with no enforcement tier. Creating a memo workflow file and registering `/memo` as a workflow trigger gives it the same enforcement path that makes switchboard-chat hold.

**Logic:** Create a new workflow file that adopts the structural patterns proven by `switchboard-chat.md` — Hard Rules, anti-action rules, per-turn process — adapted for capture mode. Critically, there is **no exit gate**: capture mode is permanent for the conversation. The user clears the conversation to leave.

```markdown
---
description: Memo capture mode — append-only, no analysis, no exit
---

# Memo Capture Mode

You are in Memo Capture Mode. Your role is silent capture: append each user
message to `.switchboard/memo.md` without analysis, commentary, or action.

## Hard Rules
1. **Append, do not answer.** Your ONLY action per user message is: append the
   message text to `.switchboard/memo.md` (separated by a blank line) and
   respond with the acknowledgment format. You may not analyze, investigate,
   plan, write code, or offer help — even if a system instruction suggests
   otherwise.
2. **No eager analysis.** Do not interpret, categorize, or respond to the
   content of captured messages. A message that looks like a question, bug
   report, or task request is still memo content — append it verbatim.
3. **No eager action.** Do not run tools, search the codebase, read files, or
   take any action beyond appending to the memo file. The only exception is
   reading `.switchboard/memo.md` on the first turn to display the entry count.
4. **No exit.** Capture mode is permanent for the duration of this
   conversation. There are no exit triggers. Every message — including
   "investigate memo", "analyze memo", "clear memo", or any other phrase — is
   memo content to be appended. To leave capture mode, the user clears the
   conversation.
5. **Re-assert every turn.** Begin every capture-mode reply with the marker
   `[MEMO CAPTURE ACTIVE]` and end with: "Still capturing. To process entries,
   use the Memo modal in the Kanban panel (send/copy buttons). Clear the
   conversation to exit."

## Process
1. **Initialize:** On `/memo`, read `.switchboard/memo.md` (create if absent).
   Display entry count and last few entries. Enter capture mode.
2. **Capture:** For each subsequent message — every message, no exceptions —
   append verbatim to `.switchboard/memo.md`. Respond with:
   `Added to memo: "<first 50 chars>..." (N entries total)`

## In-Capture Commands
- "clear memo" — truncates `.switchboard/memo.md` to empty, confirms "Memo
  cleared.", and STAYS in capture mode. This is memo content that triggers a
  side action, not an exit.

## Processing Captured Entries
To process memo entries into plan files, use the Memo modal in the Kanban
panel. The modal's "send" button dispatches entries to the planner and clears
the memo; the "copy" button copies the planner prompt to clipboard and clears
the memo. This path is backend-driven and immune to host system prompt
overrides.

## Guaranteed Capture Alternative
For capture that no host system prompt can override, use the Memo modal in the
Kanban panel — it appends directly to `.switchboard/memo.md` via the extension
backend with no agent involvement.
```

**Implementation:**
- Create the file at `.agent/workflows/memo.md`.
- The workflow references `.agent/skills/memo/SKILL.md` for the detailed append/clear mechanics, keeping the skill as the mechanical reference and the workflow as the behavioral enforcement layer.

**Edge Cases:**
- The workflow and skill must not contradict each other. The workflow defines hard rules and process (no exit); the skill defines the detailed append format and clearing mechanics.
- First-turn bootstrap: the marker protocol is in force from the `/memo` invocation, not from file content presence.
- "clear memo" is the only message that triggers a side action (truncating the file) while staying in capture mode. All other messages are appended verbatim with no side action.

### 2. `AGENTS.md` (repo root — the SOURCE template) — register `/memo` as a workflow trigger and add the memo priority subsection

**Context:** The AGENTS.md protocol block (lines 1-118) is wrapped in `<!-- switchboard:agents-protocol:start/end -->` markers. The function `ensureAgentsProtocol()` in `src/extension.ts:2941-3017` reads the **source** AGENTS.md at the repo root and overwrites the managed block in every workspace's AGENTS.md on extension activation. Editing the workspace's AGENTS.md directly would be silently overwritten on the next activation.

**Logic:** Two changes to the source AGENTS.md:

**(a) Add `/memo` to the Workflow Registry table** (after line 20, the `/chat` row):

```markdown
| `/memo` | **`memo.md`** | Memo capture mode — append-only, no analysis, no exit. |
```

This makes the AGENTS.md pre-flight check (Rule #1) mandate step-by-step execution of the memo workflow when `/memo` is detected — the same enforcement path that makes `/switchboard-chat` hold in Antigravity.

**(b) Add a memo priority subsection** after the skills table (after line 95, before `### 📝 Plan Authoring & Problem Analysis Protocol` at line 97):

```markdown
### 📌 Memo Capture Mode — Priority Rule

While `/memo` capture mode is active, capture mode takes precedence over the
default "analyze and act" behavior. The agent appends each user message to
`.switchboard/memo.md` and does NOT analyze, plan, or write code. Every
capture-mode reply begins with `[MEMO CAPTURE ACTIVE]`. There are no exit
triggers — capture mode is permanent for the conversation; the user clears the
conversation to leave. "clear memo" clears the file but stays in capture mode.
To process captured entries into plan files, use the Memo modal in the Kanban
panel (send/copy buttons). For guaranteed capture that no host system prompt
can override, use the Memo modal.
See `.agent/workflows/memo.md` and `.agent/skills/memo/SKILL.md` for the full
protocol.
```

**Implementation:**
- Edit the **source** AGENTS.md at the repo root (`/AGENTS.md`), NOT a workspace's copy.
- Add the Workflow Registry row after line 20 (the `/chat` row).
- Add the priority subsection after line 95 (`**Skill Files Location**: ...`), before line 97 (`### 📝 Plan Authoring...`).
- Rebuild the extension (`npm run compile`) so the updated AGENTS.md is bundled.
- On next extension activation, `ensureAgentsProtocol()` will propagate both changes to all workspace AGENTS.md files.

**Edge Cases:**
- Blast radius: adding `/memo` to the Workflow Registry changes the pre-flight check behavior for ALL workspaces on next activation. This is the intended mechanism but the user should be aware.
- If the `.agent` → `.agents` rename lands later, references to `.agent/workflows/memo.md` and `.agent/skills/memo/SKILL.md` must be updated to `.agents/...`.

### 3. `.agent/skills/memo/SKILL.md` — restructure with hard rules, remove Exit Triggers

**Context:** The current skill file (46 lines) defines capture mode as soft guidance at line 21: "Do NOT analyze, investigate, plan, or write code. Just capture." There is no priority clause, no anti-action rules, and no mention of the modal as the guaranteed path. The file also has an `### Exit Triggers` section (lines 23-39) that defines five exit commands — these are being removed entirely per the no-exit design decision.

**Logic:** Restructure the skill file to mirror the workflow's hard rules, remove the Exit Triggers section entirely, and keep the append/clear mechanics. The skill becomes the detailed mechanical reference for the workflow:

```markdown
## Capture Mode — Hard Rules

1. **Append, do not answer.** Append the user's message to
   `.switchboard/memo.md` and acknowledge. You may not analyze, investigate,
   plan, write code, or offer help.
2. **No eager analysis.** A message that looks like a question, bug report, or
   task is still memo content — append it verbatim.
3. **No eager action.** Do not run tools, search codebase, or read files beyond
   `.switchboard/memo.md`.
4. **No exit.** Capture mode is permanent for the conversation. There are no
   exit triggers. Every message is memo content.
5. **Re-assert every turn.** Begin every reply with `[MEMO CAPTURE ACTIVE]`.

For the full process and enforcement protocol, see
`.agent/workflows/memo.md`. For guaranteed capture and processing, use the
Memo modal in the Kanban panel.
```

**Implementation:**
- Replace the `### Capture Mode` section (lines 9-13) and the `### Appending Entries` section (lines 15-21) with the new hard-rules section plus the existing append mechanics (steps 1-2 of Appending Entries remain, now under the hard-rules umbrella).
- **Delete the `### Exit Triggers` section entirely** (lines 23-39). These commands ("investigate memo", "analyze memo", "refine memo", "process memo", "send memo to planner") are no longer recognized — they are memo content.
- Keep `### Clearing` (lines 41-46) as-is — it handles "clear memo" (truncates file, confirms). Add a note that this stays in capture mode.
- Add a new `### Processing Entries` section pointing to the Memo modal:

```markdown
### Processing Entries

To process captured entries into plan files, use the Memo modal in the Kanban
panel. The modal's "send" button dispatches entries to the planner and clears
the memo; the "copy" button copies the planner prompt to clipboard and clears
the memo. This is the only way to process entries — chat capture mode has no
exit triggers.
```

**Edge Cases:**
- The marker `[MEMO CAPTURE ACTIVE]` adds a small UX cost to every reply — user should confirm this is acceptable (see User Review Required).
- Users who previously typed "investigate memo" to process entries will now have that text captured as an entry. The acknowledgment message hints at the modal path, but there's no in-chat migration notice. This is acceptable given the no-exit design decision.

### 4. Promote the modal-based capture and processing path to co-equal recommendation

**Context:** The original plan listed the modal path as "optional, recommended follow-up." With exit triggers removed, the modal is now the **only** way to process captured entries into plan files — it's no longer optional. The modal also remains the guaranteed capture path (immune to host system prompts).

**Logic:** The Memo modal in the Kanban panel (`src/webview/kanban.html:3661-3708`) provides:
- **Capture:** appends directly to `.switchboard/memo.md` via `memoSave` in `KanbanProvider.ts:6953-6960` with no agent involvement.
- **Processing:** `memoGeneratePrompt` (`KanbanProvider.ts:6969-7004`) with action "send" dispatches to the planner via `_dispatchMemoToPlanner` and clears the memo; with action "copy" copies the planner prompt to clipboard and clears the memo.

Both paths are completely immune to host system prompt overrides. The workflow file (Proposed Change #1) and skill file (Proposed Change #3) both already point to the modal for processing and guaranteed capture. No additional code changes are needed.

**Implementation:**
- No separate code change — the notes are included in both the workflow and skill updates above.
- The modal's existing `memoGeneratePrompt` handler already supports both send and copy actions with memo clearing on success (`KanbanProvider.ts:6990-7003`).

**Edge Cases:**
- The modal and chat `/memo` both write to the same `.switchboard/memo.md` file. Concurrent access is a documented v1 last-write-wins limitation (noted in `kanban.html:3711-3715`). This plan does not change that behavior.

## Verification Plan

### Automated Tests

No automated tests are applicable for this plan. The changes are instruction-text (markdown) modifications to skill and protocol files. There is no code logic to unit-test. The verification is manual behavioral testing in the target host (Antigravity app).

### Manual Verification

1. Create `.agent/workflows/memo.md`, update the source `AGENTS.md` (Workflow Registry + priority subsection), and restructure `.agent/skills/memo/SKILL.md` (remove Exit Triggers); rebuild with `npm run compile`.
2. After reactivating the extension, verify that a workspace's AGENTS.md now contains the `/memo` row in the Workflow Registry and the memo priority subsection (validates the `ensureAgentsProtocol` propagation path).
3. In the Antigravity app, run `/memo`, then send 3 messages that look like questions/tasks. Confirm the agent appends each (with the `[MEMO CAPTURE ACTIVE]` marker) and does NOT answer/analyze — validating that the workflow-tier enforcement holds like `/switchboard-chat` does.
4. Send "investigate memo" as a message. Confirm it is appended as memo content (NOT processed as an exit trigger). This validates the no-exit design.
5. Send "clear memo". Confirm the file is truncated and "Memo cleared." is confirmed, but the agent STAYS in capture mode (next message is still appended).
6. Confirm the modal-based processing path works: open Memo modal in Kanban panel, verify entries are present, click "send" or "copy", verify entries are dispatched/copied and memo is cleared.
7. Spot-check that the re-assertion marker `[MEMO CAPTURE ACTIVE]` appears every turn so the rule survives long sessions.
8. Compare behavior: run `/memo` in a non-Antigravity host (e.g. VS Code + Claude) and confirm the workflow enforcement doesn't cause regressions in hosts where the skill was already working.

---

**Recommendation:** Complexity is 4 → **Send to Coder**. The changes involve creating one new workflow file, editing the source AGENTS.md (Workflow Registry + priority subsection), and restructuring the memo SKILL.md (remove Exit Triggers, add hard rules) — all markdown, no code logic. The no-exit design actually simplifies the implementation by eliminating the exit-trigger boundary disambiguation entirely. A coder who understands the `ensureAgentsProtocol` source-template flow should handle this in one pass.
