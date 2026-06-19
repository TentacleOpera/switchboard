# Tuning Tab — Adversarial Insight Extraction & Governance Feedback

## Goal

Add a "TUNING" tab to the existing `project.html` webview that enables agents to learn from their mistakes by extracting recurring problem patterns from adversarial review sections in completed/reviewed plans, storing them as individual insight documents, and feeding them back into project governance files (CONSTITUTION.md, AGENTS.md, CLAUDE.md).

## Problem Analysis

Switchboard's adversarial review workflow generates valuable critique data — "Stage 1 — Grumpy Adversarial Findings" and "Stage 2 — Balanced Synthesis" sections — inside plan files that have passed through the reviewer workflow. Currently, these insights are buried inside individual plan files and never aggregated or acted upon. There is no mechanism to:

1. **Extract** recurring problem patterns across multiple reviewed plans
2. **Persist** individual insights as standalone, referenceable documents
3. **Link** insights to governance files so future planning cycles can avoid repeated mistakes
4. **Trigger** an agent to review all insights and propose governance updates

This means the same architectural mistakes, missed edge cases, and prompt-design flaws get repeated across plans because the feedback loop is broken.

## Metadata

**Tags:** ui, feature, docs, refactor

**Complexity:** 6

## User Review Required

Yes — the tuning skill's extract and governance prompts are AI-invoked via clipboard paste. The user must review generated insights for accuracy and relevance before marking them "applied." Governance file updates proposed by the skill must be reviewed before integration into CONSTITUTION.md, AGENTS.md, or CLAUDE.md.

## Complexity Audit

### Routine
- Adding a `TUNING` tab button to the shared tab bar in `project.html` (mechanical, follows existing pattern)
- Adding tuning tab content area HTML (mirrors constitution tab structure)
- Adding CSS selectors for tuning IDs alongside existing constitution selector groups
- Adding element references and event listeners in `project.js` (mirrors constitution pattern)
- `InsightManager.ts` file I/O operations (list, read, delete — standard `fs` operations)
- Message handler cases in `PlanningPanelProvider.ts` (follows existing constitution handler pattern)
- Insight status update (read file, replace `**Status:**` line, write back)

### Complex / Risky
- Plan source resolution across both Kanban DB (active) and Archive DB (archived) with in-memory column filtering
- Adversarial section parser must handle multiple review section formats (Stage 1, Stage 2, Adversarial Synthesis fallback) — existing `reviewSectionPattern` only matches Stage 1
- Insight file watcher setup (new watcher pattern, must avoid infinite refresh loops)
- Multi-workspace insight aggregation with workspace origin tracking
- Clipboard-based skill invocation with large plan lists (overflow mitigation needed)
- Insight deduplication guidance in extract prompt (clustering criteria for AI agent)

## Edge-Case & Dependency Audit

**Race Conditions:**
- Insight file watcher may trigger during agent-driven insight creation, causing concurrent read/refresh. Mitigation: debounce watcher refresh by 400ms (same as constitution watcher pattern at `PlanningPanelProvider.ts:885`).
- Multiple agent sessions writing insights to the same workspace simultaneously could create duplicate files. Mitigation: the extract prompt instructs the agent to check existing insights before creating new ones.

**Security:**
- Insight files may contain quoted plan content with sensitive information. No special access control needed — insights live in `.switchboard/insights/` which is already covered by the `_SERVER_DENY_LIST` at `PlanningPanelProvider.ts:97`.
- Governance file updates are proposed as diffs in the preview pane — user must explicitly review and apply them manually. No automatic file mutation.

**Side Effects:**
- `updateInsightStatus` modifies insight files on disk — triggers file watcher refresh. This is expected behavior (same as constitution save → refresh cycle).
- `deleteInsight` removes files from disk — irreversible. No confirmation dialog specified in the plan; consider adding one.

**Dependencies & Conflicts:**
- Depends on existing `populateWorkspaceDropdowns()` function — guard clause must be updated to include `tuningWorkspaceFilter` or the function returns early.
- Depends on `_kanbanWorkspaceItems` being populated before tuning tab is activated — this happens via `fetchKanbanPlans` response, which is sent on tab activation.
- `ArchiveManager.queryArchive()` requires `switchboard.archive.dbPath` to be configured. If not set, `isConfigured` returns false and only Kanban DB plans are scanned. The extract prompt should note this limitation.
- No conflicts with existing tab infrastructure — the shared tab bar and content switching are generic via `data-tab` attributes.

## Adversarial Synthesis

Key risks: phantom kanban columns (`INTERN CODED`, `ACCEPTANCE TESTED` don't exist in `VALID_KANBAN_COLUMNS`), parser regex mismatch (existing `reviewSectionPattern` only matches Stage 1, not Stage 2 or `## Adversarial Synthesis`), missing insight file watcher (inconsistent with Constitution tab auto-refresh), and underspecified multi-workspace aggregation. Mitigations: use actual column names from `VALID_KANBAN_COLUMNS`, implement independent regex for Stage 2 and fallback patterns, add `_setupInsightsWatcher()` mirroring constitution watcher, and include workspace origin in insight list items.

## Current State

- `project.html` has three tabs: KANBAN PLANS, EPICS, CONSTITUTION — using a shared tab bar (`.shared-tab-btn` / `.shared-tab-content` with `data-tab` attributes)
- `project.js` handles tab switching and message passing to the extension host
- `PlanningPanelProvider.ts` handles messages from the project panel via `_handleMessage(message, true)`
- `KanbanDatabase.ts` stores plans with `kanban_column` values: `CREATED`, `BACKLOG`, `CONTEXT GATHERER`, `PLAN REVIEWED`, `LEAD CODED`, `CODER CODED`, `CODE REVIEWED`, `CODED`, `COMPLETED` — and `status` (`active`, `archived`, `completed`, `deleted`). The full valid set is defined in `VALID_KANBAN_COLUMNS` at `KanbanDatabase.ts:617`
- `ArchiveManager.ts` archives completed plans to a DuckDB database (path configured via `switchboard.archive.dbPath`). Archived plans store metadata (plan_id, session_id, topic, plan_file, kanban_column, status, etc.) but the plan `.md` files may still exist on disk or may have been moved/removed after archiving
- `WorkspaceIdentityService.ts` provides `getMappingsFromIndex()` which returns Switchboard workspace mappings (parent workspace + child workspace folders). These are the "Switchboard parent workspaces" — distinct from VS Code workspace folders
- The Kanban tab's workspace dropdown is populated from `_kanbanWorkspaceItems` (sent via `fetchKanbanPlans` response), each item has `{ workspaceRoot, label }`. This is the pattern to mirror for the tuning tab's workspace selector
- Plan files in `.switchboard/plans/` contain "Reviewer Pass" sections with "Stage 1 — Grumpy Adversarial Findings" and "Stage 2 — Balanced Synthesis" subsections
- `ArchiveManager.parseReviewSeverity()` already exists and parses review sections for severity counts — can be referenced for section detection patterns
- `.switchboard/reviews/` directory exists but is empty
- No existing tuning or insight infrastructure exists in the codebase

## Implementation Plan

### Phase 1: Insight Storage & Data Model

#### 1.1 Insight Storage Location

**Directory**: `.switchboard/insights/` (new directory, sibling to `plans/` and `reviews/`)

Each insight is a standalone markdown file with this structure:

```markdown
# [Insight Title]

## Metadata
**Created:** [date]
**Source Plans:** [list of plan filenames that contributed this pattern]
**Severity:** [recurring | critical | minor]
**Status:** [open | applied | dismissed]

## Problem Pattern
[Description of the recurring issue observed across plans]

## Evidence
- **[plan-filename.md]**: [specific quote or paraphrase from the adversarial section]
- **[plan-filename.md]**: [specific quote or paraphrase]

## Recommendation
[Suggested rule or invariant to add to governance files]

## Suggested Governance Target
[CONSTITUTION.md | AGENTS.md | CLAUDE.md | .cursor/rules/]
```

**Naming convention**: `insight_[YYYYMMDD]_[short-slug].md` (e.g., `insight_20260619_missing-error-handling.md`)

#### 1.2 Insight Discovery Helper

**File**: `src/services/InsightManager.ts` (new file)

**Responsibilities**:
- `listInsights(workspaceRoot: string)`: Scan `.switchboard/insights/` directory, return array of insight metadata (filename, title, severity, status, source plans, governance target)
- `readInsight(workspaceRoot: string, filename: string)`: Read full insight content
- `deleteInsight(workspaceRoot: string, filename: string)`: Delete an insight file
- `getInsightsDirectory(workspaceRoot: string)`: Return the `.switchboard/insights/` path, creating it if needed

### Phase 2: Plan Source Resolution & Tuning Skill

#### 2.1 Plan Source Resolution

The tuning skill needs to find plans that have been through adversarial review. These plans can be in multiple places:

**Active plans** (in Kanban DB):
- Query `KanbanDatabase.ts` for plans where `kanban_column IN ('PLAN REVIEWED', 'CODE REVIEWED', 'CODED', 'COMPLETED')` — these columns indicate the plan has been through at least one review or implementation cycle. Note: `getBoard(workspaceId)` returns ALL plans for a workspace; column filtering must be applied in-memory on the returned array. Use `getCompletedPlans(workspaceId)` to additionally get plans with `status = 'completed'` regardless of column
- The `plan_file` field gives the relative path to the `.md` file, resolved against the workspace root

**Archived plans** (in DuckDB archive via `ArchiveManager.ts`):
- Query the archive DB: `SELECT plan_id, topic, plan_file, kanban_column, status, workspace_id FROM plans WHERE kanban_column IN ('PLAN REVIEWED', 'CODE REVIEWED', 'CODED', 'COMPLETED') OR status = 'completed'`
- The `plan_file` field is a relative path — the `.md` file may still exist on disk in `.switchboard/plans/`. If the file no longer exists, the plan is skipped (we can only extract insights from plans whose review sections are still readable)
- Use `ArchiveManager.queryArchive()` (read-only SELECT) to retrieve the list, then attempt to read each plan file from disk

**Workspace scoping**:
- The user selects a Switchboard parent workspace from the dropdown (see Phase 3)
- The extension resolves the workspace root and queries both the Kanban DB and Archive DB for that workspace
- If "All Workspaces" is selected, iterate over all Switchboard workspace roots and aggregate results

#### 2.2 Tuning Skill Definition

**File**: `.agent/skills/tuning.md` (new skill)

**Skill capabilities**:
1. **Extract mode**: 
   - Receive a list of plan file paths (resolved by the extension from Kanban DB + Archive DB for the selected workspace)
   - Read each plan file and parse adversarial review sections
   - Identify recurring patterns (similar problem categories, repeated edge case misses, recurring prompt-design issues)
   - Create individual insight `.md` files in `.switchboard/insights/` — one per distinct pattern
   - Check existing insights before creating new ones — if a similar pattern exists, append evidence to the existing insight instead of duplicating
2. **Governance mode**: Read all existing insights with status 'open', propose specific edits to governance files (CONSTITUTION.md, AGENTS.md, CLAUDE.md)

**Skill prompt structure**:
- Accept parameters: `mode` (extract | governance), `workspaceRoot` (the selected Switchboard workspace), `planFiles` (array of plan file paths to scan)
- In extract mode: read each plan file, parse review sections, cluster patterns, write insight files to `{workspaceRoot}/.switchboard/insights/`
- In governance mode: read all open insights from `{workspaceRoot}/.switchboard/insights/`, propose governance file updates with diff-style suggestions

**Extract prompt template** (copied to clipboard):
```
Run the tuning skill in extract mode for workspace: {workspaceRoot}

Scan the following plan files for adversarial review sections ("Stage 1 — Grumpy Adversarial Findings" and "Stage 2 — Balanced Synthesis"):
{planFilesList}

For each plan, extract the review findings. Then cluster recurring problem patterns across plans using these criteria:
  - Same problem category (e.g., missing error handling, race conditions, prompt-design flaws, unvalidated assumptions)
  - Same severity level (recurring vs critical vs minor)
  - Same governance target (CONSTITUTION.md vs AGENTS.md vs CLAUDE.md)
For each distinct pattern, create an insight .md file in {workspaceRoot}/.switchboard/insights/ using the insight template. If an existing insight covers the same pattern (same category AND similar description), append new evidence to it instead of creating a duplicate. When appending, update the Source Plans list and add new evidence entries.
```

**Governance prompt template** (copied to clipboard):
```
Run the tuning skill in governance mode for workspace: {workspaceRoot}

Read all insight files in {workspaceRoot}/.switchboard/insights/ with status 'open'. Review the insights and propose specific edits to governance files (CONSTITUTION.md, AGENTS.md, CLAUDE.md) to address the recurring patterns. Present proposed changes as diffs.
```

#### 2.3 Plan Review Section Parser

**File**: `src/services/InsightManager.ts` (add to existing file)

**Function**: `extractAdversarialSections(planContent: string): { stage1: string, stage2: string } | null`

Parse plan markdown for:
- `## Reviewer Pass` section containing `### Stage 1 — Grumpy Adversarial Findings` and `### Stage 2 — Balanced Synthesis`
- Also check for `## Adversarial Synthesis` as a fallback pattern (some plans use this header instead)
- Reference `ArchiveManager.parseReviewSeverity()` for existing section-detection regex patterns (`reviewSectionPattern` at line 239 of ArchiveManager.ts). The existing regex is `/^#{1,4}\s+(?:Review Results|Stage 1|Grumpy.*?Review|Adversarial.*?Review|Code Review)/im` — this matches "Stage 1" and "Grumpy...Review" headings but NOT "Stage 2 — Balanced Synthesis" or "## Adversarial Synthesis" (no "Review" after "Synthesis"). The parser must implement its own regex for Stage 2 and the Adversarial Synthesis fallback. Suggested patterns:
  - Stage 1: `/^#{1,4}\s+(?:Stage 1|Grumpy.*?Findings|Adversarial.*?Findings)/im`
  - Stage 2: `/^#{1,4}\s+(?:Stage 2|Balanced.*?Synthesis)/im`
  - Fallback: `/^#{1,4}\s+Adversarial Synthesis/im`
- Return extracted text or null if no review sections found

### Phase 3: Tuning Tab UI

#### 3.1 Add Tuning Tab Button

**File**: `src/webview/project.html`

**Changes**:
- Add `<button class="shared-tab-btn" data-tab="tuning">TUNING</button>` to the `.shared-tab-bar` after the Constitution tab button
- The existing tab switching JS in `project.js` will handle activation automatically (it uses `data-tab` attribute generically)

#### 3.2 Tuning Tab Content Area

**File**: `src/webview/project.html`

**Structure** (follows the same list-pane + preview-pane pattern as other tabs):

```html
<!-- Tuning tab -->
<div id="tuning-content" class="shared-tab-content">
    <div class="controls-strip">
        <select id="tuning-workspace-filter">
            <option value="">All Workspaces</option>
        </select>
        <button id="btn-run-tuning-extract" class="strip-btn" title="Scan reviewed plans and extract adversarial insights">Extract Insights</button>
        <button id="btn-run-tuning-governance" class="strip-btn" title="Review all insights and propose governance file updates">Propose Governance Updates</button>
        <button id="btn-refresh-insights" class="strip-btn" title="Refresh insight list">Refresh</button>
        <select id="tuning-insight-filter">
            <option value="">All Insights</option>
            <option value="open">Open</option>
            <option value="applied">Applied</option>
            <option value="dismissed">Dismissed</option>
        </select>
    </div>
    <div class="content-row">
        <div id="tuning-list-pane">
            <div class="sidebar-toggle-row">
                <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
            </div>
            <div class="empty-state">No insights yet. Run "Extract Insights" to scan reviewed plans.</div>
        </div>
        <div class="preview-panel-wrapper">
            <div class="cyber-scanlines"></div>
            <div id="tuning-preview-pane" class="tuning-preview-pane">
                <div id="tuning-preview-content">
                    <div class="empty-state">Select an insight to preview</div>
                </div>
                <textarea id="tuning-editor" class="markdown-editor"></textarea>
            </div>
        </div>
    </div>
</div>
```

**Workspace selector**: The `#tuning-workspace-filter` dropdown is populated from the same `_kanbanWorkspaceItems` data already sent in the `fetchKanbanPlans` response. Each item has `{ workspaceRoot, label }`. This mirrors how the Kanban and Epics tabs populate their workspace dropdowns via `populateWorkspaceDropdowns()` at `project.js:462`. **Critical**: Update the guard clause from `if (!kanbanWorkspaceFilter || !epicsWorkspaceFilter) return;` to also check `tuningWorkspaceFilter` (e.g. `if (!kanbanWorkspaceFilter || !epicsWorkspaceFilter || !tuningWorkspaceFilter) return;`), then add a third `appendChild` line in that function to also populate `#tuning-workspace-filter`. The `tuningWorkspaceFilter` element reference must be declared alongside the other element references at the top of `project.js` (around line 111-150).

**CSS**: Reuse existing patterns — `#tuning-list-pane` mirrors `#constitution-list-pane`, `#tuning-preview-pane` mirrors `#constitution-preview-pane`, `.insight-item` mirrors `.constitution-file-item`. Add CSS selectors for `#tuning-list-pane`, `#tuning-preview-pane`, `#tuning-preview-content` alongside the existing constitution selectors (they already share styling via grouped selectors — just add the tuning IDs to those groups).

#### 3.3 Tuning Tab JavaScript

**File**: `src/webview/project.js`

**Changes**:

1. **Tab activation handler**: Add `else if (activeTab === 'tuning')` block to the tab click handler that sends `vscode.postMessage({ type: 'loadInsights', workspaceRoot: tuningWorkspaceFilter ? tuningWorkspaceFilter.value : '' })`

2. **Workspace filter**: Add `tuningWorkspaceFilter` element reference (mirroring `kanbanWorkspaceFilter`). Add change handler that sends `vscode.postMessage({ type: 'loadInsights', workspaceRoot: tuningWorkspaceFilter.value })`. Populate from `_kanbanWorkspaceItems` in `populateWorkspaceDropdowns()` (add third `appendChild` alongside kanban and epics)

3. **Sidebar state**: Add `tuningListCollapsed` to the `state` object and `applySidebarState` / `toggleSidebarCollapsed` functions (mirroring constitution pattern)

4. **Insight list rendering**: Add `renderInsightList(insights)` function that:
   - Clears `#tuning-list-pane` (keeping sidebar toggle row)
   - Creates `.insight-item` elements for each insight (mirroring `.constitution-file-item` pattern)
   - Each item shows: title, severity badge, status badge, source plan count, and workspace label (when in "All Workspaces" mode, show the workspace origin for each insight)
   - Each insight item must store its `workspaceRoot` in a `data-workspace-root` attribute so actions (mark applied, dismiss, delete) can send the correct workspace root even in aggregated view
   - Click handler calls `selectInsight(filename, workspaceRoot)`

5. **Insight preview**: Add `selectInsight(filename)` function that:
   - Sends `vscode.postMessage({ type: 'readInsight', filename, workspaceRoot: tuningWorkspaceFilter ? tuningWorkspaceFilter.value : '' })` 
   - On response, renders markdown in `#tuning-preview-content`

6. **Button handlers**:
   - `btn-run-tuning-extract` click → `vscode.postMessage({ type: 'runTuningExtract', workspaceRoot: tuningWorkspaceFilter ? tuningWorkspaceFilter.value : '' })`
   - `btn-run-tuning-governance` click → `vscode.postMessage({ type: 'runTuningGovernance', workspaceRoot: tuningWorkspaceFilter ? tuningWorkspaceFilter.value : '' })`
   - `btn-refresh-insights` click → `vscode.postMessage({ type: 'loadInsights', workspaceRoot: tuningWorkspaceFilter ? tuningWorkspaceFilter.value : '' })`

7. **Message listeners**: Add cases to the `window.addEventListener('message', ...)` handler:
   - `insightsLoaded` → `renderInsightList(payload.insights)`
   - `insightContent` → render markdown in preview pane
   - `tuningExtractComplete` → refresh insight list, show summary in preview pane (includes count of plans scanned, insights created/updated)
   - `tuningGovernanceComplete` → show proposed governance updates in preview pane

8. **Insight actions**: Per-insight action buttons in the preview pane:
   - "Copy Link" — copies insight file path to clipboard for referencing in agent conversations
   - "Mark Applied" — sends `vscode.postMessage({ type: 'updateInsightStatus', filename, status: 'applied' })`
   - "Dismiss" — sends `vscode.postMessage({ type: 'updateInsightStatus', filename, status: 'dismissed' })`
   - "Delete" — sends `vscode.postMessage({ type: 'deleteInsight', filename })`

### Phase 4: Extension-Side Message Handlers

#### 4.1 Message Handler Registration

**File**: `src/services/PlanningPanelProvider.ts`

Add message handler cases in `_handleMessage()` (within the `isProject: true` branch):

- **`loadInsights`**: Accept `workspaceRoot` from message. If empty ("All Workspaces"), iterate all Switchboard workspace roots and aggregate. Call `InsightManager.listInsights(workspaceRoot)`, post `{ type: 'insightsLoaded', insights }` back
- **`readInsight`**: Accept `workspaceRoot` and `filename`. Call `InsightManager.readInsight(workspaceRoot, filename)`, post `{ type: 'insightContent', content }` back
- **`runTuningExtract`**: Accept `workspaceRoot`. Resolve plan file list (see 4.2), copy extract prompt to clipboard, post `{ type: 'tuningExtractComplete', planCount, insightCount }` back
- **`runTuningGovernance`**: Accept `workspaceRoot`. Copy governance prompt to clipboard, post `{ type: 'tuningGovernanceComplete' }` back
- **`updateInsightStatus`**: Accept `workspaceRoot`, `filename`, `status`. Read insight file, update `**Status:**` line, write back, refresh list
- **`deleteInsight`**: Accept `workspaceRoot`, `filename`. Call `InsightManager.deleteInsight(workspaceRoot, filename)`, refresh list

#### 4.2 Plan Resolution & Skill Invocation

**File**: `src/services/PlanningPanelProvider.ts`

For `runTuningExtract`:

1. **Resolve plan files to scan**:
   - If `workspaceRoot` is provided (specific workspace selected):
       - Query `KanbanDatabase` for that workspace: `getBoard(workspaceId)` returns all plans (filter in-memory to `kanban_column IN ('PLAN REVIEWED', 'CODE REVIEWED', 'CODED', 'COMPLETED')`) + `getCompletedPlans(workspaceId)` for `status = 'completed'` plans
     - Query `ArchiveManager.queryArchive()` for archived plans in that workspace with the same column filter. Check `ArchiveManager.isConfigured` first — if false, skip archive query and note the limitation in the extract prompt
     - For each plan, resolve `plan_file` to an absolute path and check if the `.md` file exists on disk
   - If `workspaceRoot` is empty ("All Workspaces" selected):
     - Iterate over all Switchboard workspace roots (from `_kanbanWorkspaceItems` / `getMappingsFromIndex()`)
     - Repeat the above for each workspace
   - Collect all existing plan file paths into an array

2. **Copy extract prompt to clipboard**:
   - Build the prompt string using the template from 2.2, injecting `{workspaceRoot}` and `{planFilesList}`
   - Copy to clipboard via `vscode.env.clipboard.writeText()`
   - Show a toast/notification: "Tuning extract prompt copied to clipboard. Paste it into your agent chat."
   - Post `{ type: 'tuningExtractComplete', planCount: planFiles.length }` back to webview

For `runTuningGovernance`:
   - Build the governance prompt using the template from 2.2, injecting `{workspaceRoot}`
   - Copy to clipboard
   - Show notification
   - Post `{ type: 'tuningGovernanceComplete' }` back

**Why clipboard-based**: This mirrors the Constitution tab's "Copy Build Prompt" pattern. The user pastes the prompt into their agent chat, the agent runs the tuning skill, creates insight files, and the user clicks "Refresh" to see them. This avoids complex session-dispatch logic and is consistent with existing UX.

**Clipboard overflow mitigation**: If the resolved plan file list exceeds 50 entries, write the list to a temp file (e.g. `{workspaceRoot}/.switchboard/insights/_plan_list_{timestamp}.txt`) and reference the temp file path in the extract prompt instead of inlining all paths. This prevents clipboard/token overflow for workspaces with many reviewed plans. Clean up temp files older than 24 hours on next extract invocation.

### Phase 5: Insight File Watcher

#### 5.1 Setup Insights Watcher

**File**: `src/services/PlanningPanelProvider.ts`

Add `_setupInsightsWatcher()` method mirroring `_setupConstitutionWatcher()` at line 851. This watcher monitors `.switchboard/insights/` directories across all workspace roots so the tuning tab auto-refreshes when an agent creates or modifies insight files on disk.

**Implementation**:
- Add `_insightsWatchers: vscode.FileSystemWatcher[]` and `_insightsWatchDebounce: NodeJS.Timeout | undefined` private fields
- For each workspace root, watch `{root}/.switchboard/insights/*.md` via `RelativePattern`
- On create/change/delete events, debounce 400ms (same as constitution watcher), then re-post `loadInsights` message to project panel
- Call `_setupInsightsWatcher()` alongside `_setupConstitutionWatcher()` during panel initialization and workspace root changes
- Dispose watchers properly in `dispose()` method

### Phase 6: CSS Integration

#### 6.1 Add Tuning IDs to Existing CSS Groups

**File**: `src/webview/project.html` (CSS section)

Add `#tuning-list-pane`, `#tuning-preview-pane`, `#tuning-preview-content`, `.insight-item` to the existing CSS selector groups that already cover `#constitution-list-pane`, `#constitution-preview-pane`, `#constitution-preview-content`, `.constitution-file-item`.

This is mechanical — find each grouped selector that includes constitution IDs and add the tuning equivalents. Key selector groups to update:
- `#kanban-list-pane, #epics-list-pane, #constitution-list-pane` → add `#tuning-list-pane`
- `#constitution-preview-pane` → add `#tuning-preview-pane`
- `#constitution-preview-content` → add `#tuning-preview-content`
- `.constitution-file-item` → add `.insight-item`
- Cyber theme variants for the above
- Markdown preview styling groups (h1-h6, p, li, pre, code, blockquote, table, etc.)

## Edge Cases

1. **No reviewed plans exist**: Extract button shows notification — "No plans with adversarial review sections found in [workspace]"
2. **No insights exist yet**: Tuning tab shows empty state with instructions to run "Extract Insights"
3. **Insights directory doesn't exist**: `InsightManager` creates `.switchboard/insights/` on first access
4. **Plan has no review section**: Parser returns null, plan is skipped during extraction
5. **Archived plan file missing from disk**: Plan is skipped — only plans with readable `.md` files can contribute insights. The archive DB metadata is used to find candidates, but the file must exist to extract review content
6. **Duplicate insights**: Tuning skill should check existing insights before creating new ones — if a similar pattern already exists, append evidence to the existing insight instead of creating a duplicate
7. **Multi-workspace**: Insights are per-workspace (stored in each workspace's `.switchboard/insights/`). "All Workspaces" aggregates insights across all Switchboard workspaces in the list pane
8. **Workspace selector empty**: If no Switchboard workspace mappings are configured, fall back to the current VS Code workspace root
9. **Insight file manually edited**: The preview pane should reflect file state on refresh; edit mode can be added later
10. **Large number of plans to scan**: The extract prompt includes the full list of plan file paths — if this exceeds clipboard/token limits, consider batching or writing the list to a temp file and referencing it in the prompt
11. **Large number of insights**: List pane should be scrollable (already handled by existing `overflow-y: auto` pattern)

## Dependencies

- Existing `project.html` tab infrastructure (shared tab bar, tab content switching)
- Existing `project.js` message passing patterns and `_kanbanWorkspaceItems` workspace list
- Existing `PlanningPanelProvider.ts` message handler routing
- Existing `KanbanDatabase.ts` for querying active/completed plans by column and workspace (`getBoard()`, `getCompletedPlans()`)
- Existing `ArchiveManager.ts` for querying archived plans via DuckDB (`queryArchive()` with SELECT, `isConfigured` check)
- Existing `WorkspaceIdentityService.ts` for resolving Switchboard parent workspace mappings (`getMappingsFromIndex()`)
- Existing `ArchiveManager.parseReviewSeverity()` for reference on review section detection patterns (line 239)
- Existing markdown rendering in webview (shared utils)
- New `.agent/skills/tuning.md` skill file
- New `src/services/InsightManager.ts` service

## Proposed Changes

### `src/webview/project.html`
- **Context**: Add TUNING tab to shared tab bar and tuning content area to container div
- **Logic**: Add `<button class="shared-tab-btn" data-tab="tuning">TUNING</button>` after Constitution tab button (line 1022). Add `#tuning-content` div with controls strip, list pane, and preview pane after Constitution content div (after line 1133)
- **Implementation**: HTML structure mirrors Constitution tab — workspace filter dropdown, extract/governance/refresh buttons, insight filter dropdown, list pane with sidebar toggle, preview pane with markdown editor
- **Edge Cases**: Ensure tab button is not `active` by default (kanban remains active). Ensure `#tuning-content` does not have `active` class on load

### `src/webview/project.js`
- **Context**: Add tuning tab JS handling — element refs, tab activation, workspace filter, sidebar state, insight list rendering, preview, button handlers, message listeners, insight actions
- **Logic**: Mirror Constitution tab pattern. Add `tuningWorkspaceFilter` element ref (~line 111). Update `populateWorkspaceDropdowns()` guard clause (line 462) to include `tuningWorkspaceFilter`. Add `tuningListCollapsed` to state object (line 41). Add `else if (activeTab === 'tuning')` to tab click handler (line 9). Add `renderInsightList()`, `selectInsight()`, message listener cases, and button handlers
- **Implementation**: Each insight item stores `data-workspace-root` for action routing in aggregated view. Actions (mark applied, dismiss, delete) send workspace root from the insight item's data attribute, not from the filter dropdown
- **Edge Cases**: Null-safe element references. Guard against missing `tuningWorkspaceFilter` in message handlers

### `src/services/InsightManager.ts` (new file)
- **Context**: New service for insight file CRUD and adversarial section parsing
- **Logic**: `listInsights()` scans `.switchboard/insights/` dir, parses metadata from each `.md` file (title, severity, status, source plans, governance target). `readInsight()` returns full content. `deleteInsight()` removes file. `getInsightsDirectory()` ensures dir exists. `extractAdversarialSections()` parses plan content for Stage 1, Stage 2, and Adversarial Synthesis fallback using independent regex patterns
- **Implementation**: Use `fs.readdirSync` / `fs.readFileSync` / `fs.unlinkSync`. Parse metadata via regex on `**Status:**`, `**Severity:**`, `**Source Plans:**` lines. Return `null` from `extractAdversarialSections()` if no review sections found
- **Edge Cases**: Directory doesn't exist → create via `fs.mkdirSync({ recursive: true })`. Malformed insight file → skip with warning log. Plan with no review section → return null

### `src/services/PlanningPanelProvider.ts`
- **Context**: Add message handlers for tuning tab and insight file watcher
- **Logic**: Add 6 new message handler cases in `_handleMessage()` (lines ~2630+): `loadInsights`, `readInsight`, `runTuningExtract`, `runTuningGovernance`, `updateInsightStatus`, `deleteInsight`. Add `_setupInsightsWatcher()` method mirroring `_setupConstitutionWatcher()` (line 851). Add watcher fields and dispose logic
- **Implementation**: `runTuningExtract` resolves plans from Kanban DB (`getBoard` + in-memory column filter) and Archive DB (`queryArchive` with `isConfigured` check), builds extract prompt, copies to clipboard. `updateInsightStatus` reads file, replaces `**Status:**` line via regex, writes back. Watcher debounces 400ms and re-posts `loadInsights`
- **Edge Cases**: Archive DB not configured → skip archive query, note in prompt. Plan file missing on disk → skip. Clipboard overflow (>50 plans) → write plan list to temp file

### `.agent/skills/tuning.md` (new file)
- **Context**: New skill definition for the tuning workflow
- **Logic**: Define extract mode (scan plans, cluster patterns, create insight files) and governance mode (read open insights, propose governance file edits as diffs). Include clustering criteria and deduplication instructions
- **Implementation**: Skill prompt templates as defined in Phase 2.2. Include insight file template structure
- **Edge Cases**: No review sections found in any plan → report zero insights. Existing insight covers same pattern → append evidence, don't duplicate

## Verification Plan

### Automated Tests

> **Note**: Per session directives, automated tests are NOT run as part of this plan. The test suite will be run separately by the user. The following checklist documents what should be verified.

**Unit Tests** (to be written and run separately):
- `InsightManager.listInsights()` — scans `.switchboard/insights/` directory, returns correct metadata array
- `InsightManager.readInsight()` — returns full file content for valid filename
- `InsightManager.deleteInsight()` — removes file from disk, throws for non-existent file
- `InsightManager.getInsightsDirectory()` — creates directory if missing, returns correct path
- `InsightManager.extractAdversarialSections()` — parses Stage 1 from plan content with `### Stage 1 — Grumpy Adversarial Findings`
- `InsightManager.extractAdversarialSections()` — parses Stage 2 from plan content with `### Stage 2 — Balanced Synthesis`
- `InsightManager.extractAdversarialSections()` — parses `## Adversarial Synthesis` fallback pattern
- `InsightManager.extractAdversarialSections()` — returns null for plan with no review sections

**Integration Tests** (to be written and run separately):
- `PlanningPanelProvider._handleMessage('loadInsights')` — returns insight list for specific workspace
- `PlanningPanelProvider._handleMessage('loadInsights')` — aggregates across all workspaces when workspaceRoot is empty
- `PlanningPanelProvider._handleMessage('runTuningExtract')` — resolves plans from Kanban DB with correct column filter
- `PlanningPanelProvider._handleMessage('runTuningExtract')` — resolves plans from Archive DB when configured
- `PlanningPanelProvider._handleMessage('runTuningExtract')` — skips Archive DB when not configured
- `PlanningPanelProvider._handleMessage('updateInsightStatus')` — updates status line and refreshes list
- `PlanningPanelProvider._handleMessage('deleteInsight')` — removes file and refreshes list
- `PlanningPanelProvider._setupInsightsWatcher()` — triggers refresh on file create/change/delete

**Manual Verification** (perform after implementation):
- Open project panel, verify TUNING tab button appears after CONSTITUTION
- Click TUNING tab, verify empty state displays
- Verify workspace dropdown populates with same items as Kanban/Epics tabs
- Click "Extract Insights", verify clipboard contains prompt with plan file paths
- Click "Propose Governance Updates", verify clipboard contains governance prompt
- After agent creates insight files, click "Refresh", verify insights appear in list
- Click an insight, verify content renders in preview pane
- Click "Mark Applied", verify status updates and list refreshes
- Click "Delete", verify file removed and list refreshes
- Toggle sidebar, verify collapse/expand works
- Switch to cyber theme, verify tuning tab styles apply

## Testing Checklist

- [ ] TUNING tab button appears in project.html tab bar
- [ ] Clicking TUNING tab shows the tuning content area and hides other tabs
- [ ] Tuning tab empty state displays correctly when no insights exist
- [ ] Workspace dropdown populates from `_kanbanWorkspaceItems` (same data as Kanban/Epics tabs)
- [ ] Selecting a specific workspace filters insights to that workspace
- [ ] "All Workspaces" option aggregates insights across all Switchboard workspaces
- [ ] "Extract Insights" button resolves plan files from Kanban DB + Archive DB, copies tuning prompt to clipboard
- [ ] Extract prompt includes the correct list of plan file paths for the selected workspace
- [ ] Extract prompt includes plans from `PLAN REVIEWED`, `CODE REVIEWED`, `CODED`, `COMPLETED` columns and `completed` status
- [ ] Extract prompt includes archived plans (from DuckDB) whose `.md` files still exist on disk
- [ ] "Propose Governance Updates" button copies governance prompt to clipboard
- [ ] Insight list populates after `loadInsights` message
- [ ] Clicking an insight shows its content in the preview pane
- [ ] Insight severity and status badges render correctly
- [ ] "Mark Applied" updates insight status and refreshes list
- [ ] "Dismiss" updates insight status and refreshes list
- [ ] "Delete" removes insight file and refreshes list
- [ ] "Copy Link" copies insight file path to clipboard
- [ ] Sidebar collapse/expand works for tuning tab
- [ ] Cyber theme styles apply to tuning tab elements
- [ ] `InsightManager.listInsights()` correctly scans `.switchboard/insights/`
- [ ] `InsightManager.readInsight()` returns file content
- [ ] `extractAdversarialSections()` correctly parses Stage 1 and Stage 2 from plan files
- [ ] `extractAdversarialSections()` also handles `## Adversarial Synthesis` fallback pattern
- [ ] Tuning skill creates insight files with correct metadata structure
- [ ] Multi-workspace insight discovery works correctly
- [ ] Archived plans with missing `.md` files are skipped gracefully
- [ ] Plan resolution handles both Kanban DB (active) and Archive DB (archived) sources

## Remaining Risks

1. **Insight quality**: The tuning skill's ability to identify truly recurring patterns (vs. one-off issues) depends on prompt quality — may need iterative refinement
2. **Prompt-based invocation**: Copy-to-clipboard approach requires manual paste step; could be automated later with direct session dispatch
3. **Insight deduplication**: Detecting whether a new insight overlaps with an existing one is non-trivial — the skill must compare pattern descriptions semantically
4. **Governance file targeting**: The skill needs to understand which governance file is appropriate for each insight type (e.g., coding standards → CLAUDE.md, project invariants → CONSTITUTION.md)
5. **Stale insights**: As governance files are updated, some insights may become "applied" but the system won't auto-detect this — user must manually mark them
6. **Archive DB not configured**: If `switchboard.archive.dbPath` is not set, `ArchiveManager.isConfigured` returns false — only active plans from Kanban DB will be scanned. The extract prompt should note this limitation
7. **Large plan list in prompt**: If many plans qualify, the plan file list in the extract prompt could be very long. May need to write the list to a temp file and reference it, or batch the extraction across multiple agent invocations
8. **Cross-workspace patterns**: When "All Workspaces" is selected, the same problem pattern may appear in different workspaces. The skill should create one insight per pattern, noting which workspaces it appeared in

## Review Findings

**Reviewed:** 2026-06-19. Stage 1 adversarial review found 2 MAJOR and 3 NIT issues. Stage 2 synthesis fixed 2 MAJOR + 1 NIT; deferred 2 NITs as low-risk.

**Files changed:**
- `src/webview/project.js` — Fixed `insightContent` handler to clear preview pane on empty content (delete flow); fixed `insightLinkCopied` to target Copy Link button instead of Extract button.
- `src/services/PlanningPanelProvider.ts` — Added 24h temp file cleanup for `_plan_list_*.txt` files in `runTuningExtract` handler before creating new temp file.

**Validation:** Typecheck and tests skipped per session directives. Regression analysis: traced delete/copy-link/extract execution paths, verified no double-triggers, race conditions, or orphaned references. File watcher debounce (400ms) prevents refresh storms. Temp file cleanup is wrapped in try/catch — failures don't block extract flow.

**Remaining risks:** `updateInsightStatus` silently no-ops if `**Status:**` line missing from insight file (deferred — low risk since insights are template-generated). Dynamic `require('./ArchiveManager')` instead of static import (deferred — style only, no circular dependency).

---

**Recommendation**: Complexity is 6 (Medium — multi-file changes, moderate logic). **Send to Coder**.
