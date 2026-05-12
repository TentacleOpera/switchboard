# Add Workspace Detection Logic to AGENTS.md

## Problem
When AI agents create plans, they often default to writing them in the wrong workspace. This happens because the bundled AGENTS.md (shipped with the Switchboard extension) contains no guidance on which workspace to target for plan creation. In multi-workspace setups, this causes plans for project-specific bugs to land in the wrong workspace's `.switchboard/plans/` directory.

## Root Cause
The **bundled AGENTS.md** at the switchboard repo root (`/AGENTS.md`) is the single source that `ensureAgentsProtocol()` (in `extension.ts:3343`) copies to every user workspace during setup. This file currently has no section telling AI agents how to determine which workspace a plan should be written to.

The extension's setup flow:
1. `performSetup()` (line 3554) calls `ensureAgentsProtocol(workspaceUri, extensionUri)` (line 3595)
2. `ensureAgentsProtocol()` reads the bundled `AGENTS.md` from `extensionUri` (line 3347)
3. It either creates or appends this content into the workspace's `AGENTS.md` (lines 3375-3410)

Since the bundled AGENTS.md has no workspace detection rules, every workspace gets identical content with no guidance on multi-workspace plan routing. AI agents then fall back on stale memories or assumptions about which `.switchboard/plans/` path to use.

## Solution
1. Add a **"Workspace Detection for Plan Creation"** section to the **bundled AGENTS.md** at the switchboard repo root.
2. Modify `ensureAgentsProtocol()` to **in-place update** the managed block when the bundled source has changed, instead of skipping existing installations.

## Goal
Add workspace detection rules to the bundled AGENTS.md so that AI agents in any user's multi-workspace setup correctly route plan files to the appropriate workspace. Ensure existing installations receive the update via the `ensureAgentsProtocol()` in-place update mechanism.

## Metadata
- **Tags:** workflow, documentation, reliability
- **Complexity:** 4

## User Review Required
- [ ] Confirm the workspace detection decision tree logic is correct
- [ ] Confirm fallback behavior (ask user vs. default to active workspace)

## Complexity Audit
### Routine
- Adding a new documentation section to the bundled AGENTS.md at repo root (pure text, no code)

### Complex / Risky
- Modifying `ensureAgentsProtocol()` to support in-place block updates when bundled source changes — this changes the behavior of an existing function that has test coverage. The change is well-scoped (~15 lines) but must preserve user content outside the markers and handle edge cases (empty block, whitespace differences).

## Edge-Case & Dependency Audit
- **Race Conditions:** None — AGENTS.md is a static file, no concurrent modification risk
- **Security:** None — the in-place update only replaces content between the managed block markers, never touches user content outside the markers
- **Side Effects:** The in-place update to `ensureAgentsProtocol()` will cause the managed block to be updated on next extension activation for all existing installations. This is desirable — it's the mechanism that delivers the new workspace detection section. User content outside the markers is preserved.
- **Dependencies & Conflicts:** No conflicts in CREATED or BACKLOG columns. The kanban script failed (`MODULE_NOT_FOUND` for KanbanDatabase), so dependency audit has uncertainty. Related completed work: "Fix Planning Panel Workspace Root Detection" (CODE REVIEWED), "Make Switchboard Planning Framework Agnostic" (CODE REVIEWED) — both already past the columns we check.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) The in-place update replaces the entire managed block — if a user has manually edited content inside the markers, those edits will be lost. Mitigation: the markers and docs explicitly designate this block as extension-managed; user edits should go outside the markers. (2) Whitespace/line-ending differences between bundled source and existing block could cause false-positive "changed" detection, triggering unnecessary writes. Mitigation: compare trimmed content. (3) AI agents may still rely on stale memories that override the AGENTS.md guidance. Mitigation: update stale memories at the developer level.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/AGENTS.md` (bundled source)
- **Context:** This is the **bundled AGENTS.md** that ships with the Switchboard extension. The `ensureAgentsProtocol()` function reads this file and copies/appends it to every user workspace during setup. It is the single source of truth for all deployed AGENTS.md content.
- **Logic:** Add a new section after the "📚 Available Skills" section (after line 83) titled "### 📂 Workspace Detection for Plan Creation" with the following decision tree:
  1. **Primary signal: Active IDE workspace** — If the user's active editor or focused workspace folder is within a specific workspace root, write plans to that workspace's `.switchboard/plans/` directory. This is the most reliable signal.
  2. **Secondary signal: Task content keywords** — If the active workspace signal is ambiguous (e.g., the user is in a generic file), look for project-specific keywords in the task description. This is a hint, not a rule.
  3. **Tertiary signal: `.switchboard/` existence** — Confirm the selected workspace has a `.switchboard/plans/` directory before writing. If it doesn't exist, the workspace may not be a Switchboard-managed project.
  4. **Fallback: Ask the user** — If detection is ambiguous (multiple signals conflict or no signal matches), ask the user which workspace to use. Do NOT silently default to any workspace.
- **Implementation:** Insert after line 83, before the trailing blank lines. The section must be generic — no hardcoded paths or user-specific workspace names, since this file ships to all users.
- **Edge Cases:** User has multiple workspace folders open in VS Code — the active editor's containing workspace folder is the strongest signal.

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts` — `ensureAgentsProtocol()` in-place update
- **Context:** Currently at line 3398, when both `AGENTS_BLOCK_START` and `AGENTS_BLOCK_END` markers exist, the function returns `'skipped'` and never updates the content between them. This means existing installations never receive AGENTS.md updates when the extension is upgraded.
- **Logic:** Replace the skip-on-existing logic with an in-place update:
  1. When both markers exist, extract the content between them: `targetContent.substring(blockStartIndex + AGENTS_BLOCK_START.length, blockEndIndex)`
  2. Compare the extracted content (trimmed) against `sourceContent.trimEnd()`
  3. If identical → return `{ status: 'skipped', reason: 'Switchboard protocol block already up-to-date' }`
  4. If different → rebuild the managed block with the new source, splice it into the existing content (preserving everything before `AGENTS_BLOCK_START` and after `AGENTS_BLOCK_END`), write the result, return `{ status: 'updated', reason: 'Switchboard protocol block updated to latest bundled version' }`
- **Implementation:**
  - Add `'updated'` to the `AgentsProtocolStatus` type (line 3314)
  - Replace the skip logic at line 3398 with the compare-and-update logic (~15 lines)
  - The splice: `const before = targetContent.substring(0, blockStartIndex); const after = targetContent.substring(blockEndIndex + AGENTS_BLOCK_END.length); const updated = before + managedBlock + after;`
- **Edge Cases:**
  - Whitespace differences: compare trimmed content to avoid false-positive updates
  - User edits inside markers: will be overwritten — this is by design (the block is extension-managed)
  - Empty block (markers with nothing between): should still update correctly

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/test/extension.test.ts` — new test cases
- **Context:** The existing test suite at line 77 covers create/append/skip/failure paths. Needs new tests for the update path.
- **Logic:** Add test cases:
  1. Block markers exist with old content → content is updated to match new bundled source, returns `'updated'`
  2. Block markers exist with current content → returns `'skipped'` with "up-to-date" reason
  3. Block markers exist with old content + user content outside markers → user content is preserved, only block content is updated
- **Implementation:** Add 3 new tests to the existing `suite('AGENTS.md Scaffolding Logic')`

## Verification Plan
### Automated Tests
- Add 3 new test cases to `src/test/extension.test.ts` suite "AGENTS.md Scaffolding Logic" (line 77):
  1. Block markers with stale content → returns `'updated'`, content matches new source
  2. Block markers with current content → returns `'skipped'` with "up-to-date" reason
  3. Block markers with stale content + user content outside markers → user content preserved, block updated
- Run: `npm test` or `npx mocha src/test/extension.test.ts`

### Manual Verification
  1. After updating the bundled AGENTS.md, run Switchboard setup on a fresh workspace (no existing AGENTS.md)
  2. Verify the new "Workspace Detection" section appears in the created AGENTS.md
  3. Run setup on a workspace that already has the protocol block with old content — verify the block is **updated** (not skipped)
  4. Verify user content outside the block markers is preserved after the update
  5. In a multi-workspace VS Code window, test that an AI agent reading the new section correctly routes plans based on the active editor's workspace
