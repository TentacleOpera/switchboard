# Switchboard Comprehensive User Manual

## Metadata
**Complexity:** 4
**Tags:** docs, feature, ui

## Goal

### Problem
The "Switchboard Tutorial" button in `setup.html` and the `pluginTutorial` handler in `TaskViewerProvider.ts` both reference `README.md` (261 lines) and optionally `docs/how_to_use_switchboard.md` (55 lines). Neither is comprehensive enough for an AI agent to give a user a thorough explanation of all Switchboard functions, panels, settings, workflows, and integrations.

### Solution
Create a new, definitive `docs/switchboard_user_manual.md` covering every feature, panel, setting, command, agent role, workflow, integration, and troubleshooting scenario. Then update all four entry points to reference this manual.

## Files to Create

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

## Implementation Notes

- The manual is a **documentation-only** deliverable — no code logic changes beyond updating file path references in 4 locations.
- The manual should be written in clear, agent-readable markdown. An AI agent reading it should be able to explain any Switchboard feature to a user without needing to look elsewhere.
- All settings keys should be extracted from the actual source code to ensure accuracy (not guessed).
- All command IDs should be extracted from `extension.ts` command registrations.
- The manual should include practical examples and step-by-step instructions where applicable.
- File size: expect 800-1500 lines of markdown for "everything" coverage.

## Risks & Edge Cases

- **Bundling:** The `docs/` folder must be included in the `.vscodeignore` allowlist so the manual ships with the extension. Need to verify `.vscodeignore` doesn't exclude `docs/`.
- **Stale content:** The manual will need maintenance as features are added. Consider adding a "Last updated" date and version note.
- **Token budget:** If an agent reads the full manual, it could be 800+ lines. The tutorial prompt should instruct agents to read relevant sections rather than the entire file at once.
- **Fallback paths:** All three code entry points should gracefully fall back to README.md if the manual file is missing (e.g., older extension install).

## Validation

- [ ] Manual covers every panel, setting, command, workflow, and integration listed in README
- [ ] All settings keys match actual source code
- [ ] All command IDs match `extension.ts` registrations
- [ ] Tutorial prompt in `setup.html` references the manual
- [ ] `_openDocs()` opens the manual (with README fallback)
- [ ] `pluginTutorial` handler references the manual (with README fallback)
- [ ] README.md links to the new manual
- [ ] `.vscodeignore` allows `docs/switchboard_user_manual.md` to be bundled
