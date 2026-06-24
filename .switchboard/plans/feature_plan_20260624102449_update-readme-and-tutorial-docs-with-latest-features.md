# Update README and How-To Tutorial Docs with Latest Features

## Goal

The Switchboard documentation — `README.md`, `docs/how_to_use_switchboard.md`, and `docs/switchboard_user_manual.md` — is significantly out of date. Three major shipped features are completely absent from all three docs:

1. **Memo Capture Mode** (`/memo` workflow) — append-only capture mode for progressively logging issues/ideas during testing, processed into plans via the Kanban Memo modal.
2. **Automated ClickUp/Linear Triage Pipeline** — one-click "ENABLE TRIAGE PIPELINE" buttons in the Setup panel that auto-pull bugs, route them to the Ticket Updater (triage) agent, and sync verdicts back.
3. **Linear Remote Control** — drive your Kanban board from the Linear mobile app; moving a card between Linear states moves it on the board and dispatches the column's agent; comments are routed to the current column's agent.

Additionally, the Ticket Updater role description is outdated across all docs — it's described as "Updates PM tool ticket statuses" but now performs triage-only verdicts (posts a short severity/area/assessment/action/routing comment, never overwrites the ticket description).

### Problem Analysis & Root Cause

**Root cause:** These features were developed and shipped without corresponding documentation updates. The docs were last comprehensively updated around the time of the multi-repo and design-panel features. The memo workflow, triage pipeline, and remote control were added afterward and no doc pass was done.

**Evidence:**
- `README.md` (276 lines): Zero mentions of "memo", "remote", or "triage" (confirmed via grep).
- `docs/how_to_use_switchboard.md` (54 lines): Zero mentions of "memo", "remote", or "triage".
- `docs/switchboard_user_manual.md` (1418 lines): Only mentions `ticket_updater` as a role name in two table rows (lines 90, 143) with the stale description "Updates PM tool ticket statuses." No sections on memo, remote control, or triage pipeline.

## Metadata

- **Tags:** documentation, readme, user-manual, how-to, memo, remote-control, triage
- **Complexity:** 5/10
- **Files affected:** `README.md`, `docs/how_to_use_switchboard.md`, `docs/switchboard_user_manual.md`
- **Shipped state:** All three docs have shipped in released versions. Updates are additive (new sections) plus one correction (ticket_updater description). No migration needed — docs are not runtime state.

## Complexity Audit

### Routine
- Adding new sections to `README.md` for Memo, Triage Pipeline, and Remote Control.
- Adding new sections to `docs/how_to_use_switchboard.md` covering the three features in a best-practices context.
- Adding new numbered sections to `docs/switchboard_user_manual.md` with full detail (settings, commands, UI locations, workflow steps).
- Correcting the Ticket Updater role description in all three docs.

### Complex / Risky
- The user manual has a structured Table of Contents (lines 7-36) with 28 numbered sections. Adding new sections requires renumbering or appending at the end. Appending is safer to avoid renumbering churn.
- The README links to both docs at the bottom (line 275-276). These links remain valid.
- Feature details must be accurate — the implementer should read the actual source files (workflow definitions, service files, UI HTML) to document correct settings keys, commands, and workflows, not guess from context.

## Edge-Case & Dependency Audit

1. **Memo workflow details:** The memo workflow is defined in `.agents/workflows/memo.md`. The docs should explain: `/memo` enters capture mode, every message is appended verbatim to `.switchboard/memo.md`, capture mode is permanent for the conversation (clear conversation to exit), and processing is done via the Memo modal in the Kanban panel (send/copy buttons). The upcoming "process memo" command (if implemented per the related plan) should also be mentioned.
2. **Triage pipeline details:** The one-click triage setup is in `setup.html` (lines 697, 901). It creates a "Bug Triage" board with sensible defaults. The Ticket Updater agent posts a structured triage verdict (Severity, Area, Assessment, Recommended action, Routing) as a comment — never overwrites the description. This is defined in `agentPromptBuilder.ts` lines 917-940.
3. **Remote Control details:** Defined in `src/services/RemoteControlService.ts`. Features: polls Linear on a timer (30-120s), mirrors Linear state changes to Kanban columns and dispatches agents, ingests comments and routes them to the current column's agent. Config: boards to sync, silent sync, ping mode (manual/constant), ping frequency. UI is in the Kanban REMOTE tab and the toolbar remote control button. Guards: self-comment marker, state echo guard, per-card sequential queue.
4. **Settings keys:** The implementer must verify the actual settings keys from `package.json` or the source code rather than guessing. The remote config is stored in the DB config table (key `remote.config`), not in `settings.json`.
5. **Cross-references:** The README's "Core Workflows" section (line 147) and "IDE Chat Commands" subsection (line 175) should include `/memo`. The user manual's "IDE Chat Commands" section (section 22) should also include `/memo`.

## Proposed Changes

### 1. `README.md` — Add three new feature sections + fix ticket_updater description

**A. Add Memo Capture Mode to "Core Workflows" section (after line 169):**
```markdown
### Memo Capture Mode
Use `/memo` to enter append-only capture mode. Every message you send is appended verbatim to `.switchboard/memo.md` — no analysis, no action. This is ideal for logging issues, bugs, and ideas during testing without breaking your flow. Process captured entries into plan files using the Memo modal in the Kanban panel (send/copy buttons).
```

**B. Add Triage Pipeline to "Project Management & Sync" section (after line 134):**
```markdown
### Automated Triage Pipeline (ClickUp & Linear)
One-click setup in the Setup panel creates a "Bug Triage" board that auto-pulls bugs from ClickUp or Linear, routes them to the Ticket Updater agent for triage verdicts (severity, area, recommended action, routing), and syncs the verdicts back as comments on the source ticket. The agent never overwrites the ticket description — it posts a short structured comment only.
```

**C. Add Linear Remote Control as a new subsection in "Project Management & Sync" (after the triage section):**
```markdown
### Linear Remote Control
Drive your Kanban board from the Linear app on your phone. Moving a card between Linear states moves it on the board and dispatches that column's agent. Comments posted on a Linear issue are routed to the card's current column agent. Configure boards, sync mode, and ping frequency in the Kanban REMOTE tab. Toggle remote control from the toolbar button.
```

**D. Add `/memo` to the IDE Chat Commands list (after line 179):**
```markdown
- `/memo` — Enter memo capture mode (append-only issue/idea logging).
```

**E. Fix Ticket Updater role description (line 71):**
Change:
```
- **Reviewer** — Compares implementation to plans (Grumpy Principal Engineer).
```
Wait — the ticket_updater isn't listed in the README roles. Add it after the Analyst role (line 71):
```markdown
- **Ticket Updater** — Reads imported tickets and posts short triage verdicts (severity, area, recommended action) back to ClickUp/Linear as comments.
```

### 2. `docs/how_to_use_switchboard.md` — Add feature sections

**A. Add a new section after section 1 (Onboarding), e.g. "1.5. Capturing Issues with Memo":**
```markdown
## 1.5. Capturing Issues with Memo Mode

During testing or exploration, use `/memo` to enter capture mode. Each message is appended verbatim to `.switchboard/memo.md` — no analysis, no code changes, just capture. When you're done, open the Memo modal in the Kanban panel to dispatch entries to the planner or copy the planner prompt to clipboard. Clear the conversation to exit capture mode.
```

**B. Add a new section after the PM sync discussion, e.g. "7.5. Automated Triage & Remote Control":**
```markdown
## 7.5. Automated Triage & Remote Control

### One-Click Triage Pipeline
In the Setup panel, click "ENABLE TRIAGE PIPELINE" under ClickUp or Linear to auto-create a Bug Triage board. Bugs are pulled in, routed to the Ticket Updater agent, and triage verdicts are synced back as comments.

### Linear Remote Control
Drive your board from your phone via the Linear app. Configure in the Kanban REMOTE tab — select boards, set ping mode (manual/constant), and ping frequency (30-120s). Moving a Linear issue between states dispatches the corresponding Kanban column agent; comments are routed to the current column's agent.
```

### 3. `docs/switchboard_user_manual.md` — Add full detail sections + fix role description

**A. Fix Ticket Updater role description (line 90):**
Change:
```
| `ticket_updater` | Ticket Updater | Updates PM tool ticket statuses. |
```
to:
```
| `ticket_updater` | Ticket Updater | Reads imported tickets and posts short triage verdicts (severity, area, assessment, recommended action, routing) back to ClickUp/Linear as comments. Never overwrites the ticket description. |
```

**B. Add new sections at the end (before the Troubleshooting section, or as new numbered sections 29-31):**

**Section 29: Memo Capture Mode**
- What it is: append-only capture mode for progressive issue/idea logging
- How to enter: type `/memo` in your IDE chat
- Behavior: every message appended verbatim to `.switchboard/memo.md`, no analysis/action
- How to process: Memo modal in Kanban panel (send = dispatch to planner, copy = copy prompt to clipboard)
- How to exit: clear the conversation
- The Memo modal also supports direct capture without agent involvement (guaranteed capture)

**Section 30: Automated Triage Pipeline**
- What it is: one-click setup for auto-pulling bugs and routing to triage agent
- Setup: Setup panel → ClickUp or Linear section → "ENABLE TRIAGE PIPELINE (ONE-CLICK)"
- Creates a "Bug Triage" board with sensible defaults (all editable afterward)
- Ticket Updater agent posts structured verdict: Severity, Area, Assessment, Recommended action, Routing (auto/needs-human)
- Verdict is posted as a comment via `clickup_api` or `linear_api` skill — never overwrites the description
- Target: ≤120 words per verdict

**Section 31: Linear Remote Control**
- What it is: drive your Kanban board from the Linear mobile app
- How it works: polls Linear on a timer (no webhooks), mirrors state changes to Kanban columns + dispatches agents, ingests comments and routes to current column agent
- Configuration: Kanban REMOTE tab — boards to sync, silent sync, ping mode (manual/constant), ping frequency (30-120s)
- Toolbar button: toggle remote control on/off
- Guards: self-comment marker (skips own outbound comments on ingest), state echo guard (prevents re-applying a state that matches current column), per-card sequential queue (no two agents for one card simultaneously)
- Config storage: DB config table (key `remote.config`), not `settings.json`

**C. Add `/memo` to the IDE Chat Commands section (section 22).**

**D. Update the Table of Contents (lines 7-36) to include the new sections.**

## Verification Plan

1. **Grep verification:** After edits, run `grep -ci "memo\|remote\|triage" README.md docs/how_to_use_switchboard.md docs/switchboard_user_manual.md` and confirm all three files have non-zero match counts.
2. **Link check:** Verify the README links to the user manual and how-to guide still resolve (lines 275-276).
3. **Table of Contents:** Verify the user manual's ToC includes the new section numbers and that they match the actual section headings.
4. **Accuracy spot-check:** Cross-reference at least one setting key, command ID, and workflow detail against the source code to confirm the docs match reality.
5. **Markdown rendering:** Open the README on GitHub (or preview locally) and verify the new sections render correctly with proper headings and formatting.
