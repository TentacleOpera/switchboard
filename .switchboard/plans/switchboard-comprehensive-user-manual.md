# Switchboard Comprehensive User Manual

## Metadata
**Complexity:** 4
**Tags:** docs, feature, ui

## Goal

### Problem
The "Switchboard Tutorial" button in `setup.html` and the `pluginTutorial` handler in `TaskViewerProvider.ts` both reference `README.md` (261 lines) and optionally `docs/how_to_use_switchboard.md` (55 lines). Neither is comprehensive enough for an AI agent to give a user a thorough explanation of all Switchboard functions, panels, settings, workflows, and integrations.

### Solution
Create a new, definitive `docs/switchboard_user_manual.md` covering every feature, panel, setting, command, agent role, workflow, integration, and troubleshooting scenario. Then update all four entry points to reference this manual.

## User Review Required

Yes — the manual's content scope (which features to cover, depth of each section) should be reviewed by the user before implementation begins. The `.vscodeignore` change is a one-line config addition with no user review needed.

## Complexity Audit

### Routine
- Creating a new markdown documentation file (`docs/switchboard_user_manual.md`)
- Updating a static clipboard prompt string in `setup.html` (line 3062)
- Updating `_openDocs()` to check for the manual before falling back to README
- Updating `pluginTutorial` case to reference the manual with README fallback
- Adding a link in `README.md` (line 260)
- Adding `!docs/switchboard_user_manual.md` to `.vscodeignore` (line 45)

### Complex / Risky
- Extracting all settings keys from `setup.html` (4,522 lines) and `SetupPanelProvider.ts` (1,447 lines) — requires systematic grep and cross-referencing to ensure completeness
- Extracting all command IDs from `extension.ts` (3,388 lines) — 30+ registered commands across the file
- Token budget management — the manual at 800-1500 lines may exceed agent context windows if read in full; tutorial prompts must reference specific ToC sections

## Edge-Case & Dependency Audit

**Race Conditions:**
- None. All changes are static file modifications with no runtime concurrency concerns.

**Security:**
- No security implications. The manual is a documentation file with no executable code, no credentials, no API keys.

**Side Effects:**
- `.vscodeignore` change affects extension packaging — the manual will now be included in the `.vsix` bundle, increasing bundle size by ~30-50KB.
- `setup.html` prompt change alters what users see when they click "Copy Tutorial Prompt" — existing users may notice the prompt text changed.
- `_openDocs()` behavior change — clicking "Open Docs" now opens the manual instead of README. Users familiar with the old behavior may be briefly confused.

**Dependencies & Conflicts:**
- The manual file must exist before the code changes are useful. If code changes ship without the manual (e.g., partial deploy), the fallback to README.md covers `_openDocs()` and `pluginTutorial`, but the `setup.html` clipboard prompt will reference a non-existent file.
- `.vscodeignore` must be updated in the same PR as the manual creation, or the manual won't ship in the `.vsix`.
- No dependency on other plans or sessions.

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) `.vscodeignore` excludes `docs/**` with only `docs/how_to_use_switchboard.md` as exception — the new manual will not ship unless `.vscodeignore` is explicitly updated. (2) The 4,522-line `setup.html` makes settings extraction error-prone without systematic grep methodology. (3) The `setup.html` clipboard prompt is a static string with no runtime fallback, unlike `_openDocs()` and `pluginTutorial` which have file-existence checks. Mitigations: add `!docs/switchboard_user_manual.md` to `.vscodeignore` as a required file modification; specify grep-based extraction approach for settings and commands; document the fallback semantics difference per entry point.

## Proposed Changes

### Files to Create

### 1. `docs/switchboard_user_manual.md`
A comprehensive user manual with the following structure:

```
# Switchboard — Comprehensive User Manual

## Table of Contents
1. Introduction & Overview
   - What Switchboard is
   - How it works (high-level architecture)
   - Zero-overhead philosophy
2. Installation & First-Time Setup
   - Installing from Marketplace
   - Opening the sidebar
   - Git ignore strategy options
3. Agent Roles & Configuration
   - Planner
   - Team Lead
   - Lead Coder
   - Coder
   - Intern
   - Reviewer (Grumpy Principal Engineer)
   - Acceptance Tester
   - Analyst
   - Custom roles
   - CLI agent startup commands
   - Complexity routing & cutoff configuration
4. The AUTOBAN (Kanban Board)
   - Column controls (drag-and-drop, Move Selected, Move All)
   - Copy Prompt Selected / Copy Prompt All
   - Routing modes (CLI Triggers vs Prompt mode)
   - Complexity routing (high → Lead Coder, low → Coder)
   - AUTOBAN Automation (START AUTOBAN, agent count, timing, batch size)
5. Planning Tools & Workflows
   - Creating plans (Create Plan button)
   - Plan Scanner (auto-detect from Antigravity, Windsurf-Devin, Cursor, Claude Code, custom)
   - NotebookLM Airlock (zero-cost planning)
   - IDE Chat Commands (/switchboard-chat, /improve-plan, /archive, /export)
   - Plan Review Comments (highlight to send feedback)
   - Code Mapping
6. Pair Programming Mode
   - CLI Parallel
   - Hybrid
   - Full Clipboard
   - Aggressive mode setting
7. Multi-Repo Control Plane
   - Scaffold Control Plane
   - Set Up Control Plane
   - Shared local database
   - Reconcile Kanban Databases
   - Clear Control Plane Cache
   - Reset Kanban Database
8. Project Panel
   - Projects (mini-workspaces)
   - Epics (groups of plans, worktree dispatch routing)
   - Constitution (spec-driven governance)
   - Constitution injection mechanism
   - Append Design Doc
9. Design Panel (Google Stitch)
   - Authentication (API key vs OAuth)
   - Settings (model, creative range, output folder, project ID)
   - SecretStorage for credentials
10. Research / Local Docs Panel
    - Local research folders
    - HTML folder paths
    - Design system files
    - Antigravity Brain artifacts
11. PM Tool Sync
    - ClickUp (token setup, import, mappings, live sync)
    - Linear (token setup, import, mappings)
    - Notion (design doc fetch, cache, append to prompts)
    - Operation Modes (Coding Mode vs Board Management Mode)
    - Live Sync Mode (30-second sync, pause/resume, conflict detection)
    - Auto-Pull Timers (5/15/30/60 min)
12. NotebookLM Airlock
    - Bundle Code
    - Upload to NotebookLM
    - Import from Clipboard
13. Google Jules Integration
    - Sending low-priority tasks to Jules
    - Auto-sync (auto-commit/push before dispatch)
14. Archive System
    - DuckDB plan archive
    - Auto-archive completed tasks
    - Searching archives
15. Status Bar Hub
    - Grouped actions dropdown
    - Configurable visibility toggles
16. Themes
    - Afterburner
    - Claudify
    - Disabling cyber animation
17. Core Workflows (Deep Dive)
    - Batching
    - Pair Programming
    - Plan Review Comments
    - Code Mapping
    - Report and Send Back
    - Cross-IDE Workflows
18. Quota Economics
    - Task batching
    - Opus/Sonnet split
    - Pair programming cost savings
    - Spreading work across models
    - NotebookLM Airlock
    - Google Jules (100 free requests/day)
19. Prompt Controls
    - Stricter coder prompts
    - Inline challenge
    - Advanced reviewer mode
    - Unified team prompt rigor
20. All Settings Reference
    - Every settings.json key with description, type, and default
21. All Commands Reference
    - Every VS Code command ID with description
22. IDE Chat Commands
    - /switchboard-chat
    - /improve-plan
    - /archive
    - /export
23. Privacy & Security
    - 100% local-first
    - SecretStorage
    - No telemetry
    - MIT License
24. Architecture
    - VS Code Extension
    - Local SQLite DB
    - DuckDB Plan Archive
    - File Protocol (.switchboard/)
    - Git Ignore Integration
25. Troubleshooting / FAQ
    - Common setup issues
    - Kanban database problems
    - Sync conflicts
    - Agent not dispatching
    - Plan scanner not detecting files
    - Theme not applying
```

**Content source:** The manual should be written by synthesizing information from:
- `README.md` (existing overview)
- `docs/how_to_use_switchboard.md` (existing best practices)
- `docs/TECHNICAL_DOC.md` (technical architecture details)
- `docs/DELEGATION_WORKFLOWS_README.md` (workflow docs)
- `src/webview/setup.html` (settings UI — extract all configurable options)
- `src/services/SetupPanelProvider.ts` (setup panel logic — extract all settings keys)
- `src/services/TaskViewerProvider.ts` (kanban logic, pluginTutorial handler)
- `src/extension.ts` (command registrations)
- All `.agent/` config files, personas, workflows, skills

## Files to Modify

### 2. `src/webview/setup.html` — line 3062
Update the copied tutorial prompt to reference the new manual:

**Current:**
```javascript
const prompt = 'Please read the Switchboard README.md (located at the extension root) — specifically the "Getting started" section covering Install, Set up your agent team, Create your first plans, and Run your pipeline — and guide me through my Switchboard setup options. Present the setup steps as a numbered list and ask which one I\'d like help with first.';
```

**New:** Reference `docs/switchboard_user_manual.md` as the primary source, with README.md as secondary. Prompt should instruct the agent to read the manual and guide the user through setup options.

### 3. `src/services/SetupPanelProvider.ts` — lines 1300-1308
Update `_openDocs()` to open the new manual instead of (or in addition to) README.md:

**Current:** Opens `README.md` in markdown preview.

**New:** Check for `docs/switchboard_user_manual.md` first, fall back to `README.md` if not found.

### 4. `src/services/TaskViewerProvider.ts` — lines 9176-9200
Update `pluginTutorial` case to reference the new manual:

**Current:** Reads README.md and optionally `docs/how_to_use_switchboard.md`.

**New:** Read `docs/switchboard_user_manual.md` as primary source. Update the instruction string to reference the manual. Keep README.md as a fallback if the manual doesn't exist.

### 5. `README.md` — line 260
Add a link to the new manual:

**Current:**
```markdown
- [How to Use Switchboard (Detailed Guide)](docs/how_to_use_switchboard.md)
```

**New:** Add a second link:
```markdown
- [Comprehensive User Manual](docs/switchboard_user_manual.md)
- [How to Use Switchboard (Detailed Guide)](docs/how_to_use_switchboard.md)
```

### 6. `.vscodeignore` — line 45
**CRITICAL:** Without this change, the manual will not be bundled in the `.vsix` package. The current `.vscodeignore` excludes all `docs/**` with only `docs/how_to_use_switchboard.md` as an exception.

**Current (lines 44-45):**
```
docs/**
!docs/how_to_use_switchboard.md
```

**New:**
```
docs/**
!docs/how_to_use_switchboard.md
!docs/switchboard_user_manual.md
```

## Implementation Notes

- The manual is a **documentation-only** deliverable — no code logic changes beyond updating file path references in 5 locations (setup.html, SetupPanelProvider.ts, TaskViewerProvider.ts, README.md, .vscodeignore).
- The manual should be written in clear, agent-readable markdown. An AI agent reading it should be able to explain any Switchboard feature to a user without needing to look elsewhere.
- All settings keys should be extracted from the actual source code to ensure accuracy (not guessed).
- All command IDs should be extracted from `extension.ts` command registrations.
- The manual should include practical examples and step-by-step instructions where applicable.
- File size: expect 800-1500 lines of markdown for "everything" coverage.

## Risks & Edge Cases

- **Bundling (RESOLVED):** `.vscodeignore` line 44 excludes `docs/**` with only `!docs/how_to_use_switchboard.md` as exception. Added `!docs/switchboard_user_manual.md` as file #6 to modify. Without this, the manual will not ship in the `.vsix`.
- **Stale content:** The manual will need maintenance as features are added. Consider adding a "Last updated" date and version note at the top of the manual.
- **Token budget:** If an agent reads the full manual, it could be 800+ lines. The tutorial prompt in `setup.html` should instruct agents to read specific ToC sections (e.g., "read sections 1-3 for setup guidance") rather than the entire file at once. The `pluginTutorial` handler should similarly reference section numbers.
- **Fallback paths:** `_openDocs()` and `pluginTutorial` have runtime file-existence checks and can fall back to README.md. The `setup.html` clipboard prompt is a static string with no runtime fallback — if the manual doesn't exist in the install, the agent will fail to find it. This is acceptable because the `.vscodeignore` fix ensures the manual ships with the extension.

## Verification Plan

### Automated Tests

No automated tests required — this is a documentation-only deliverable with static file path reference updates. Verification is manual.

### Manual Verification Steps

- [ ] Manual covers every panel, setting, command, workflow, and integration listed in README
- [ ] All settings keys match actual source code (grep `switchboard.` in `extension.ts` and `SetupPanelProvider.ts`, cross-reference with `setup.html` UI elements)
- [ ] All command IDs match `extension.ts` registrations (grep `registerCommand` in `extension.ts` — 30+ commands across lines 667-1193+)
- [ ] Tutorial prompt in `setup.html` (line 3062) references the manual with specific ToC section numbers
- [ ] `_openDocs()` (lines 1300-1308) opens the manual with README fallback
- [ ] `pluginTutorial` handler (lines 9176-9200) references the manual with README fallback
- [ ] README.md (line 260) links to the new manual
- [ ] `.vscodeignore` (line 45) includes `!docs/switchboard_user_manual.md`
- [ ] Manual file exists at `docs/switchboard_user_manual.md` and is well-structured markdown

### Verification Commands

```bash
# Verify all command IDs are documented in the manual
grep -oP "registerCommand\('\K[^']+" src/extension.ts | while read cmd; do
  grep -q "$cmd" docs/switchboard_user_manual.md || echo "MISSING: $cmd"
done

# Verify all switchboard. settings keys are documented
grep -oP "switchboard\.\K[a-zA-Z.]+" src/extension.ts src/services/SetupPanelProvider.ts | sort -u | while read key; do
  grep -q "switchboard.$key" docs/switchboard_user_manual.md || echo "MISSING SETTING: switchboard.$key"
done

# Verify .vscodeignore includes the manual
grep -q 'docs/switchboard_user_manual.md' .vscodeignore && echo "OK: bundled" || echo "ERROR: not bundled"
```

## Recommendation

Complexity 4 → **Send to Coder**

## Review Findings

**Reviewer pass:** 2026-06-19. All six plan deliverables verified present and correct: manual file (840 lines), `setup.html` prompt, `SetupPanelProvider._openDocs()`, `TaskViewerProvider.pluginTutorial`, `README.md` link, `.vscodeignore` exception. All 80+ registered commands verified documented; all `package.json` settings verified documented. Two fixes applied: (1) added missing `switchboard.refresh` command to manual's All Commands Reference (MAJOR — claimed "all commands" but omitted one); (2) fixed incorrect "section 0" reference in `pluginTutorial` instruction string (NIT — ToC starts at section 1, not 0). No regression risks: all code changes are static path references with try/catch fallbacks, no signature or side-effect changes. Remaining risk: `switchboard.kanban.plansFolder` is used in code but not declared in `package.json` (hidden setting, not in manual — consistent with `package.json`-sourced approach but undocumented for users).

**Reviewer pass 2 (webview coverage):** 2026-06-19. Added new Section 26 "Webview Panels Reference" (~275 lines) to `docs/switchboard_user_manual.md` documenting all UI controls and functionality of six webviews: `implementation.html` (sidebar: onboarding wizard, quick-launch buttons, agents/terminals sub-tabs, plan actions, live activity feed), `kanban.html` (8 tabs: KANBAN, AGENTS, PROMPTS, AUTOMATION, WORKTREES, UAT, SETUP), `project.html` (4 tabs: KANBAN PLANS, EPICS, CONSTITUTION, TUNING), `design.html` (5 tabs: STITCH, BRIEFS, HTML PREVIEWS, IMAGES, DESIGN SYSTEM), `planning.html` (4 tabs: DOCS, TICKETS, RESEARCH, NotebookLM), and `setup.html` (10 tabs: Setup, Database, Control Plane, Multi-Repo, ClickUp, Linear, Notion, Plan Scanner, Theme, Status Bar + Custom Prompts modal). Also added missing Section 25 header "File Layout & Runtime State" (content existed as Architecture subsections but lacked its own header), renumbered Troubleshooting to Section 27, and updated ToC. No code changes — documentation only. No regression risk.
