# Update README and How-To Tutorial Docs with Latest Features

## Goal

The Switchboard documentation — `README.md`, `docs/how_to_use_switchboard.md`, and `docs/switchboard_user_manual.md` — is significantly out of date. Three major shipped features are completely absent from all three docs:

1. **Memo Capture Mode** (`/memo` workflow) — append-only capture mode for progressively logging issues/ideas during testing, processed into plans via the Memo sub-tab in the sidebar.
2. **Automated ClickUp/Linear Triage Pipeline** — one-click "ENABLE TRIAGE PIPELINE" buttons in the Setup panel that auto-pull bugs, route them to the Ticket Updater (triage) agent, and sync verdicts back.
3. **Linear Remote Control** — drive your Kanban board from the Linear mobile app; moving a card between Linear states moves it on the board and dispatches the column's agent; comments are routed to the current column's agent.

Additionally, the Ticket Updater role description is outdated across all docs — it's described as "Updates PM tool ticket statuses" but now performs triage-only verdicts (posts a short severity/area/assessment/action/routing comment, never overwrites the ticket description).

**Workflow file inconsistency:** The shipped workflow file `.agents/workflows/memo.md` and the protocol file `AGENTS.md` both repeatedly reference a "Memo modal in the Kanban panel" — a UI element that does not exist. The actual memo UI is a sub-tab in the sidebar (`implementation.html`, line 1605). These files are the source of truth that agents read during capture mode, so the incorrect location text is propagated into agent responses and was the original source of the same error in this plan. Both files must be corrected as part of this documentation pass.

### Problem Analysis & Root Cause

**Root cause:** These features were developed and shipped without corresponding documentation updates. The docs were last comprehensively updated around the time of the multi-repo and design-panel features. The memo workflow, triage pipeline, and remote control were added afterward and no doc pass was done.

**Evidence:**
- `README.md` (276 lines): Zero mentions of "memo", "remote", or "triage" (confirmed via grep).
- `docs/how_to_use_switchboard.md` (54 lines): Zero mentions of "memo", "remote", or "triage".
- `docs/switchboard_user_manual.md` (1418 lines): Only mentions `ticket_updater` as a role name in the roles table (line 90, stale description "Updates PM tool ticket statuses.") and in the Kanban column table (line 143, column row — no description text). No sections on memo, remote control, or triage pipeline.

## Metadata

- **Tags:** docs
- **Complexity:** 5/10
- **Files affected:** `README.md`, `docs/how_to_use_switchboard.md`, `docs/switchboard_user_manual.md`, `.agents/workflows/memo.md`, `AGENTS.md`
- **Shipped state:** All five files have shipped in released versions. Updates are additive (new sections) plus corrections (ticket_updater description, memo UI location in workflow/protocol files). No data migration needed — docs and workflow files are not runtime state. Workflow files are canonical extension definitions that are overwritten on version change (`extension.ts` line 3300), so fixing the source propagates to users on the next extension update. `AGENTS.md` is updated via `ensureAgentsProtocol` with boundary markers.

## User Review Required

Yes — the implementer must verify all feature details (settings keys, command IDs, UI locations, workflow steps) against the live source code before writing prose. The corrections below (especially the Memo UI location) should be reviewed by the user to confirm the intended documentation scope. No code changes are involved; this is a documentation-only plan.

## Complexity Audit

### Routine
- Adding new sections to `README.md` for Memo, Triage Pipeline, and Remote Control.
- Adding new sections to `docs/how_to_use_switchboard.md` covering the three features in a best-practices context.
- Adding new numbered sections to `docs/switchboard_user_manual.md` with full detail (settings, commands, UI locations, workflow steps).
- Correcting the Ticket Updater role description in all three docs.
- Adding `/memo` to the IDE Chat Commands lists in the README and user manual.
- Adding memo settings (`switchboard.memo.hotkey`, `switchboard.statusBar.showMemoButton`) to the user manual's All Settings Reference table.
- Fixing "Memo modal in the Kanban panel" → "Memo sub-tab in the sidebar" in `.agents/workflows/memo.md` (7 occurrences) and `AGENTS.md` (1 occurrence).

### Complex / Risky
- The user manual has a structured Table of Contents (lines 7-36) with 28 numbered sections. Adding new sections requires renumbering or appending at the end. Appending is safer to avoid renumbering churn, but placing feature documentation after the Troubleshooting/FAQ section (currently section 28) is unconventional. The implementer should insert the new sections before Troubleshooting (renumbering Troubleshooting to 31) OR accept the append-at-end approach — the user should decide.
- The README links to both docs at the bottom (line 275-276). These links remain valid.
- Feature details must be accurate — the implementer should read the actual source files (workflow definitions, service files, UI HTML) to document correct settings keys, commands, and workflows, not guess from context.

## Edge-Case & Dependency Audit

1. **Memo workflow details:** The memo workflow is defined in `.agents/workflows/memo.md`. The docs should explain: `/memo` enters capture mode, every message is appended verbatim to `.switchboard/memo.md`, and processing is done via the Memo sub-tab in the sidebar (Copy Prompt / Send to Planner buttons) or via the `process memo` chat command. **Correction:** The original plan referred to a "Memo modal in the Kanban panel" — this is inaccurate. The Memo UI is a sub-tab labeled "Memo" within the "Agents & Terminals" tab area of the sidebar (`implementation.html`, line 1605). It has three buttons: **Clear**, **Copy Prompt**, and **Send to Planner**. There is no memo UI in the Kanban panel (`kanban.html` has zero memo references). The Memo sub-tab also supports direct capture without agent involvement (guaranteed capture via the textarea, which saves to `.switchboard/memo.md` through the extension backend).
2. **`process memo` exit command:** The current `.agents/workflows/memo.md` (56 lines) defines a `process memo` chat command as the sole chat-based exit from capture mode. Sending exactly `process memo` (case-insensitive, whitespace-trimmed, as the entire message) exits capture mode and creates one plan file per memo entry in `.switchboard/plans/`. The memo file is NOT cleared by this path — clear it via the Memo sub-tab to avoid duplicates on re-run. This is also documented in `AGENTS.md` line 21 ("Exit with `process memo`") and line 100. The docs must document this command. The original plan incorrectly stated "no exit triggers" — this has been corrected.
3. **Workflow file inconsistency — `.agents/workflows/memo.md`:** This shipped workflow file contains 7 references to "Memo modal in the Kanban panel" (lines 28, 44, 47, 52, 53, 56, and one in the Process Memo Command section). The actual memo UI is the Memo sub-tab in the sidebar. Since this file is read by agents during capture mode, the incorrect text propagates into agent responses. The file is bundled with the extension and overwritten on version change (`extension.ts` line 3300: "Workflow files are canonical extension definitions — always overwrite on version change"), so fixing the source propagates to users automatically on the next update. All 7 occurrences must be replaced with "Memo sub-tab in the sidebar".
4. **Protocol file inconsistency — `AGENTS.md`:** Line 100 contains "The Memo modal in the Kanban panel remains as an alternative processing path." Same incorrect location. The file is bundled at the repo root and scaffolded into workspaces via `ensureAgentsProtocol` with boundary markers (`extension.ts` lines 2965-3000). The managed block between `<!-- switchboard:agents-protocol:start -->` and `<!-- switchboard:agents-protocol:end -->` is updated when the source changes. Fix the 1 occurrence.
5. **Memo settings:** Two settings exist in `package.json` that are not documented anywhere: `switchboard.memo.hotkey` (default `cmd+shift+alt+m`, opens the memo tab) and `switchboard.statusBar.showMemoButton` (default `false`, shows a dedicated memo button in the status bar). These must be added to the user manual's All Settings Reference table (section 20).
6. **Triage pipeline details:** The one-click triage setup is in `setup.html` (lines 697, 901). It creates a "Bug Triage" board with sensible defaults. The Ticket Updater agent posts a structured triage verdict (Severity, Area, Assessment, Recommended action, Routing) as a comment — never overwrites the description. This is defined in `agentPromptBuilder.ts` lines 917-940. The verdict target is ≤120 words. The agent resolves the provider ticket ID from the plan metadata ("**ClickUp Task ID:**" or "**Linear Issue ID:**" line) and posts via the `clickup_api` or `linear_api` skill.
7. **Remote Control details:** Defined in `src/services/RemoteControlService.ts`. Features: polls Linear on a timer (30-120s), mirrors Linear state changes to Kanban columns and dispatches agents, ingests comments and routes them to the current column's agent. Config: boards to sync, silent sync, ping mode (manual/constant), ping frequency. UI is the REMOTE tab in the Kanban panel (`kanban.html` line 2469) and the toolbar remote control button (`btn-remote-control`, line 2493). Guards: self-comment marker, state echo guard (with 5-minute TTL), per-card sequential queue. Comment cursor is advanced only after dispatch (reload-safe). First-encounter cursor seeding prevents replaying entire comment history on first start.
8. **Settings keys:** The remote config is stored in the DB config table (key `remote.config`), not in `settings.json`. The user manual should document this explicitly since all other config is in `settings.json`. The `RemoteConfig` interface fields: `boards` (string[]), `silentSync` (boolean), `pingMode` ('constant' | 'manual'), `pingFrequencySeconds` (30-120, default 60).
9. **Cross-references:** The README's "Core Workflows" section (line 147) and "IDE Chat Commands" subsection (line 175) should include `/memo`. The user manual's "IDE Chat Commands" section (section 22, lines 737-744) should also include `/memo`.
10. **Evidence correction:** The original plan stated the user manual mentions `ticket_updater` "in two table rows (lines 90, 143) with the stale description." Line 90 is the roles table with the stale description. Line 143 is the Kanban column table (`| TICKET UPDATER | Ticket Updater | 9000 | ticket_updater | No | Prompt |`) — this row contains no description text, only the column mapping. Only line 90 needs the description correction.

## Dependencies

None — this is a documentation-only plan with no code dependencies.

## Adversarial Synthesis

Key risks: (1) The original plan's repeated references to a "Memo modal in the Kanban panel" are factually wrong — the memo UI lives in the sidebar, not the Kanban panel; documenting the wrong location would mislead ~4,000 users. (2) The same error exists in the shipped workflow file `.agents/workflows/memo.md` (7 occurrences) and `AGENTS.md` (1 occurrence) — these are the source files agents read during capture mode, so the incorrect text propagates into agent responses and was the original source of the error in this plan. Both must be fixed. (3) Two shipped memo settings (`switchboard.memo.hotkey`, `switchboard.statusBar.showMemoButton`) are absent from the plan entirely and would remain undocumented. (4) The `process memo` exit command exists in the shipped workflow file but was not documented in the original plan. (5) The user manual section-numbering strategy (append after Troubleshooting vs. insert before) needs a user decision. Mitigations: all corrections are incorporated into the Proposed Changes below; the implementer is directed to verify every detail against source code before writing.

## Proposed Changes

### 1. `README.md` — Add three new feature sections + fix ticket_updater description

**A. Add Memo Capture Mode to "Core Workflows" section (after line 169):**
```markdown
### Memo Capture Mode
Use `/memo` to enter append-only capture mode. Every message you send is appended verbatim to `.switchboard/memo.md` — no analysis, no action. This is ideal for logging issues, bugs, and ideas during testing without breaking your flow. Process captured entries into plan files using the Memo sub-tab in the sidebar (Copy Prompt or Send to Planner buttons), or send `process memo` in chat to exit capture mode and create one plan per entry. You can also open the Memo tab directly with the `switchboard.memo.hotkey` keybinding (default `cmd+shift+alt+m`).
```

**B. Add Triage Pipeline to "Project Management & Sync" section (after line 134, i.e. after Operation Modes and before Live Sync Mode):**
```markdown
### Automated Triage Pipeline (ClickUp & Linear)
One-click setup in the Setup panel creates a "Bug Triage" board that auto-pulls bugs from ClickUp or Linear, routes them to the Ticket Updater agent for triage verdicts (severity, area, recommended action, routing), and syncs the verdicts back as comments on the source ticket. The agent never overwrites the ticket description — it posts a short structured comment only (target ≤120 words).
```

**C. Add Linear Remote Control as a new subsection in "Project Management & Sync" (after the triage section):**
```markdown
### Linear Remote Control
Drive your Kanban board from the Linear app on your phone. Moving a card between Linear states moves it on the board and dispatches that column's agent. Comments posted on a Linear issue are routed to the card's current column agent. Configure boards, sync mode, and ping frequency in the Kanban REMOTE tab. Toggle remote control from the toolbar button. Config is stored in the Kanban database (key `remote.config`), not in `settings.json`.
```

**D. Add `/memo` to the IDE Chat Commands list (after line 179):**
```markdown
- `/memo` — Enter memo capture mode (append-only issue/idea logging).
```

**E. Fix Ticket Updater role description — add it after the Analyst role (line 71):**
The ticket_updater is not listed in the README roles. Add it:
```markdown
- **Ticket Updater** — Reads imported tickets and posts short triage verdicts (severity, area, recommended action) back to ClickUp/Linear as comments.
```

### 2. `docs/how_to_use_switchboard.md` — Add feature sections

**A. Add a new section after section 1 (Onboarding), e.g. "1.5. Capturing Issues with Memo":**
```markdown
## 1.5. Capturing Issues with Memo Mode

During testing or exploration, use `/memo` to enter capture mode. Each message is appended verbatim to `.switchboard/memo.md` — no analysis, no code changes, just capture. When you're done, either open the Memo sub-tab in the sidebar (Agents & Terminals tab → Memo sub-tab) to dispatch entries to the planner or copy the planner prompt to clipboard, or send `process memo` in chat to exit capture mode and create one plan per entry. You can also open the Memo tab directly via the `switchboard.memo.hotkey` keybinding (default `cmd+shift+alt+m`).
```

**B. Add a new section after the PM sync discussion, e.g. "7.5. Automated Triage & Remote Control":**
```markdown
## 7.5. Automated Triage & Remote Control

### One-Click Triage Pipeline
In the Setup panel, click "ENABLE TRIAGE PIPELINE" under ClickUp or Linear to auto-create a Bug Triage board. Bugs are pulled in, routed to the Ticket Updater agent, and triage verdicts (severity, area, assessment, recommended action, routing — ≤120 words) are synced back as comments. The agent never overwrites the ticket description.

### Linear Remote Control
Drive your board from your phone via the Linear app. Configure in the Kanban REMOTE tab — select boards, set ping mode (manual/constant), and ping frequency (30-120s). Moving a Linear issue between states dispatches the corresponding Kanban column agent; comments are routed to the current column's agent. Toggle from the toolbar remote control button. Config stored in the Kanban DB, not `settings.json`.
```

### 3. `docs/switchboard_user_manual.md` — Add full detail sections + fix role description + add settings

**A. Fix Ticket Updater role description (line 90):**
Change:
```
| `ticket_updater` | Ticket Updater | Updates PM tool ticket statuses. |
```
to:
```
| `ticket_updater` | Ticket Updater | Reads imported tickets and posts short triage verdicts (severity, area, assessment, recommended action, routing) back to ClickUp/Linear as comments. Never overwrites the ticket description. |
```

**B. Add new sections (numbered 29-31). Insert before the Troubleshooting section (section 28) and renumber Troubleshooting to 31, OR append after Troubleshooting as 29-31 — user to decide. The content below assumes insertion before Troubleshooting:**

**Section 29: Memo Capture Mode**
- What it is: append-only capture mode for progressive issue/idea logging
- How to enter: type `/memo` in your IDE chat, or open the Memo sub-tab directly via the `switchboard.memo.hotkey` keybinding (default `cmd+shift+alt+m`)
- Behavior: every message appended verbatim to `.switchboard/memo.md`, no analysis/action. Every reply begins with `[MEMO CAPTURE ACTIVE]`.
- How to process: Memo sub-tab in the sidebar (Agents & Terminals tab → Memo sub-tab). **Send to Planner** = dispatch entries to the planner and clear the memo; **Copy Prompt** = copy the planner prompt to clipboard and clear the memo; **Clear** = clear the memo without processing.
- How to exit: send exactly `process memo` (case-insensitive, as the entire message) to exit capture mode and create one plan file per entry in `.switchboard/plans/`. The memo file is NOT cleared by this path — clear it via the Memo sub-tab to avoid duplicates on re-run. To leave without processing, clear the conversation.
- The Memo sub-tab also supports direct capture without agent involvement — type into the textarea and it saves automatically to `.switchboard/memo.md` via the extension backend (guaranteed capture, immune to host system prompt overrides)
- Settings: `switchboard.memo.hotkey` (default `cmd+shift+alt+m`), `switchboard.statusBar.showMemoButton` (default `false`)

**Section 30: Automated Triage Pipeline**
- What it is: one-click setup for auto-pulling bugs and routing to triage agent
- Setup: Setup panel → ClickUp or Linear tab → "⚡ ENABLE TRIAGE PIPELINE (ONE-CLICK)"
- Creates a "Bug Triage" board with sensible defaults (all editable afterward)
- Ticket Updater agent posts structured verdict: Severity (blocker/high/normal/low), Area (1-2 tags), Assessment (1-2 sentence root-cause hypothesis), Recommended action (concrete next step), Routing (auto/needs-human)
- Verdict is posted as a comment via `clickup_api` or `linear_api` skill — never overwrites the description
- Target: ≤120 words per verdict
- The agent resolves the provider ticket ID from the plan metadata ("**ClickUp Task ID:**" or "**Linear Issue ID:**" line)

**Section 31: Linear Remote Control**
- What it is: drive your Kanban board from the Linear mobile app
- How it works: polls Linear on a timer (no webhooks), mirrors state changes to Kanban columns + dispatches agents, ingests comments and routes to current column agent
- Configuration: Kanban REMOTE tab (`kanban.html` line 2469) — boards to sync (multi-select), silent sync (keep mirroring while pinging is off), ping mode (manual/constant), ping frequency (30-120s, default 60)
- Toolbar button: `btn-remote-control` (line 2493) — toggle remote control on/off
- Guards: self-comment marker (skips own outbound comments on ingest), state echo guard with 5-minute TTL (prevents re-applying a state that matches current column), per-card sequential queue (no two agents for one card simultaneously)
- Comment cursor: advanced only AFTER dispatch completes (reload-safe); first-encounter cursor seeding prevents replaying entire comment history on first start
- Config storage: DB config table (key `remote.config`), not `settings.json`. `RemoteConfig` fields: `boards` (string[]), `silentSync` (boolean), `pingMode` ('constant' | 'manual'), `pingFrequencySeconds` (30-120, default 60)
- Per-poll card cap: 100 cards (most-recently-updated first; remainder deferred to next cycle)

**C. Add `/memo` to the IDE Chat Commands section (section 22, after line 744):**
```markdown
- **`/memo`** — Enter memo capture mode. Appends each message verbatim to `.switchboard/memo.md` without analysis or action. Process entries via the Memo sub-tab in the sidebar, or send `process memo` to exit and create one plan per entry. Clear the conversation to leave without processing.
```

**D. Add memo settings to the All Settings Reference table (section 20, after line 569):**
```markdown
| `switchboard.memo.hotkey` | string | `cmd+shift+alt+m` | — | Hotkey to open the memo tab (requires window reload to take effect) |
| `switchboard.statusBar.showMemoButton` | boolean | false | window | Show a dedicated memo button in the status bar |
```

**E. Update the Table of Contents (lines 7-36) to include the new sections.**

### 4. `.agents/workflows/memo.md` — Fix incorrect UI location references

This shipped workflow file contains 7 references to "Memo modal in the Kanban panel" — a UI element that does not exist. The actual memo UI is the Memo sub-tab in the sidebar. Since agents read this file during capture mode, the incorrect text propagates into agent responses.

**Replace all 7 occurrences of "Memo modal in the Kanban panel" with "Memo sub-tab in the sidebar":**
- Line 28: "Memo modal in the Kanban panel remains the alternative processing path." → "Memo sub-tab in the sidebar remains the alternative processing path."
- Line 44: "clear it via the Memo modal in the Kanban panel." → "clear it via the Memo sub-tab in the sidebar."
- Line 45: "The user can clear it via the Memo modal if desired." → "The user can clear it via the Memo sub-tab if desired."
- Line 47: "The Memo modal in the Kanban panel remains the alternative processing path" → "The Memo sub-tab in the sidebar remains the alternative processing path"
- Line 52: "clear it via the Memo modal to avoid duplicates on re-run." → "clear it via the Memo sub-tab to avoid duplicates on re-run."
- Line 53: "Memo modal (Kanban panel):" → "Memo sub-tab (sidebar):" and "The modal's "send" button" → "The sub-tab's "send" button"
- Line 56: "use the Memo modal in the Kanban panel — it appends directly" → "use the Memo sub-tab in the sidebar — it appends directly"

**Propagation:** Workflow files are canonical extension definitions, overwritten on version change (`extension.ts` line 3300). Fixing the source propagates to users automatically on the next extension update — no manual migration needed.

### 5. `AGENTS.md` — Fix incorrect UI location reference

Line 100 contains: "The Memo modal in the Kanban panel remains as an alternative processing path (backend-driven, immune to host system prompt overrides)."

**Change to:** "The Memo sub-tab in the sidebar remains as an alternative processing path (backend-driven, immune to host system prompt overrides)."

**Propagation:** `AGENTS.md` is bundled at the repo root and scaffolded into workspaces via `ensureAgentsProtocol` with boundary markers. The managed block between `<!-- switchboard:agents-protocol:start -->` and `<!-- switchboard:agents-protocol:end -->` is updated when the source changes. Users get the fix on next setup/extension update.

## Verification Plan

### Automated Tests

No automated tests are applicable — this is a documentation-only change with no code modifications. The test suite (unit, integration, e2e) is unaffected and will be run separately by the user.

### Manual Verification

1. **Grep verification:** After edits, run `grep -ci "memo\|remote\|triage" README.md docs/how_to_use_switchboard.md docs/switchboard_user_manual.md` and confirm all three files have non-zero match counts.
2. **Link check:** Verify the README links to the user manual and how-to guide still resolve (lines 275-276).
3. **Table of Contents:** Verify the user manual's ToC includes the new section numbers and that they match the actual section headings.
4. **Accuracy spot-check:** Cross-reference at least one setting key, command ID, and workflow detail against the source code to confirm the docs match reality. Specifically verify:
   - `switchboard.memo.hotkey` default value in `package.json` (line 699)
   - `switchboard.statusBar.showMemoButton` in `package.json` (line 702)
   - Triage verdict format in `agentPromptBuilder.ts` (lines 930-937)
   - `RemoteConfig` fields in `RemoteControlService.ts` (lines 23-32)
   - Memo UI buttons in `implementation.html` (lines 1633-1635: Clear, Copy Prompt, Send to Planner)
5. **Markdown rendering:** Open the README on GitHub (or preview locally) and verify the new sections render correctly with proper headings and formatting.
6. **Memo location accuracy:** Confirm all references in all five files say "Memo sub-tab in the sidebar" (not "Memo modal in the Kanban panel") — the original plan's wording was incorrect.
7. **Workflow file fix verification:** Run `grep -r "Memo modal in the Kanban panel" .agents/workflows/memo.md AGENTS.md` and confirm zero matches after edits.
8. **`process memo` documentation:** Confirm the user manual's Memo Capture Mode section (section 29) documents the `process memo` exit command, including that it creates one plan per entry and does NOT clear the memo file.

---

## Reviewer Pass — Completed 2026-06-24

### Stage 1: Grumpy Adversarial Findings

| Severity | File:Line | Finding |
|----------|-----------|---------|
| NIT | `docs/how_to_use_switchboard.md:64` | Section numbered "4" instead of plan's suggested "7.5". Correct deviation — file only had 3 sections; "7.5" was a plan-author guess based on incorrect file structure assumptions. Sequential numbering is correct. |
| NIT | `README.md:72` vs `docs/switchboard_user_manual.md:93` | Ticket Updater field list is concise in README ("severity, area, recommended action") vs full in manual ("severity, area, assessment, recommended action, routing"). Intentional tiered detail per plan's proposed text (line 102). Not a defect. |
| NIT | `docs/switchboard_user_manual.md` ToC | Plan labeled new sections "29-31" but also said "renumber Troubleshooting to 31" — internally contradictory. Implementation correctly used 28-30 for new sections, 31 for Troubleshooting. Correct resolution. |

**No CRITICAL findings. No MAJOR findings.**

### Stage 2: Balanced Synthesis

- **Keep as-is:** All five files. Implementation faithfully matches plan proposed changes with sensible deviations where plan suggestions were based on incorrect file-structure assumptions.
- **Fix now:** Nothing — no CRITICAL/MAJOR findings, no code fixes required.
- **Defer:** Nothing — all plan requirements met.

### Stage 3: Code Fixes Applied

None — documentation-only plan, implementation is complete and correct.

### Stage 4: Verification Results

| Check | Result |
|-------|--------|
| Grep `memo\|remote\|triage` in 3 docs | README=8, how_to=7, manual=31 — all non-zero ✓ |
| `Memo modal in the Kanban panel` in `memo.md` + `AGENTS.md` | 0 matches ✓ |
| `Memo sub-tab` in `AGENTS.md` | 1 match (line 100) ✓ |
| Stale `Updates PM tool ticket statuses` in docs | 0 matches ✓ |
| README links resolve | Both targets exist ✓ |
| ToC anchors match section headings | Sections 28-31 all match ✓ |
| `switchboard.memo.hotkey` default | `cmd+shift+alt+m` (`package.json:699`) ✓ |
| `switchboard.statusBar.showMemoButton` | `false`, scope `window` (`package.json:702-706`) ✓ |
| Triage verdict format | 5 fields, ≤120 words, comment-only (`agentPromptBuilder.ts:930-940`) ✓ |
| `RemoteConfig` fields + clamp | boards/silentSync/pingMode/pingFrequencySeconds, 30-120s (`RemoteControlService.ts:23-38, 118`) ✓ |
| Memo UI buttons | Clear/Copy Prompt/Send to Planner (`implementation.html:1633-1635`) ✓ |
| REMOTE tab + button | `kanban.html:2469, 2493` ✓ |
| Triage buttons | `setup.html:697, 901` ✓ |
| `process memo` documented in manual section 28 | Lines 1402-1403, includes "NOT cleared" note ✓ |

### Files Changed (by implementer, verified by reviewer)

- `README.md` — Added Memo Capture Mode, Triage Pipeline, Linear Remote Control sections; added `/memo` to chat commands; added Ticket Updater role.
- `docs/how_to_use_switchboard.md` — Added section 1.5 (Memo) and section 4 (Triage & Remote Control).
- `docs/switchboard_user_manual.md` — Fixed Ticket Updater description (line 93); added sections 28-30; added `/memo` to chat commands (line 750); added memo settings to settings table (lines 573-574); updated ToC (lines 36-39); renumbered Troubleshooting to 31.
- `.agents/workflows/memo.md` — Replaced all 7 "Memo modal in the Kanban panel" references with "Memo sub-tab in the sidebar".
- `AGENTS.md` — Replaced 1 "Memo modal in the Kanban panel" reference with "Memo sub-tab in the sidebar" (line 100).

### Remaining Risks

None — all plan requirements are met, all source-code spot-checks pass, and the "Memo modal" location error has been fully purged from both canonical source files.
