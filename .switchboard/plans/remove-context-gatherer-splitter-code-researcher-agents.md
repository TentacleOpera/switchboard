# Remove Context Gatherer, Splitter, and Code Researcher Agents

## Goal

Delete three built-in agent roles — `gatherer` (Context Gatherer), `splitter` (Splitter Agent), and `code_researcher` (Code Researcher) — from the extension entirely. These roles exist as premature abstractions: gatherer duplicates "just move the card to Planner," splitter duplicates the pair programming feature, and code researcher duplicates what the Planner agent already does by default. Their presence in the Agents tab adds cognitive overhead without adding value, working against the principle that core features must be simple.

**Root cause:** These roles were added to handle preparation and decomposition steps that the existing workflow already covers. They survive as dead weight in the type system, UI, prompt builder, and providers.

## Migration

These three columns were hidden by default (`hideWhenNoAgent: true`, all `false` in default visibility). A small subset of users may have enabled them and left cards in these columns. On first activation after upgrade, migrate any stranded cards:

- Cards in `CONTEXT GATHERER` → move to `PLAN REVIEWED`
- Cards in `CODE_RESEARCHER` → move to `PLAN REVIEWED`
- Cards in `SPLITTER` → move to `PLAN REVIEWED`

Migration should run once during extension activation (version-gated or always-safe idempotent check). Archive the gatherer persona file as `.agents/personas/gatherer.md.migrated.bak` rather than deleting it (per migration policy for shipped content).

## Implementation Steps

### Step 1 — Type system (`src/services/agentConfig.ts`)
- Remove `'gatherer' | 'splitter' | 'code_researcher'` from the `BuiltInAgentRole` union type.
- Remove entries from `BUILT_IN_AGENT_LABELS`: `gatherer`, `splitter`, `code_researcher`.
- Remove three column definitions from the built-in columns array: `CONTEXT GATHERER` (order 50), `CODE_RESEARCHER` (order 95), `SPLITTER` (order 110).

### Step 2 — Shared defaults (`src/webview/sharedDefaults.js`)
- Remove `gatherer: false`, `splitter: false`, `code_researcher: false` from the default visibility state.
- Remove the three full role config blocks (splitter, code_researcher, gatherer) from the default role configuration object.
- Remove the three addon configuration blocks from the role add-ons section.
- Remove `splitter` and `code_researcher` from `PROMPT_OVERRIDE_EXCLUDED_KEYS`.
- Remove `{ key: 'gatherer', label: 'Context Gatherer' }`, `{ key: 'code_researcher', label: 'Code Researcher' }`, `{ key: 'splitter', label: 'Splitter Agent' }` from the agent labels metadata array.

### Step 3 — Kanban UI (`src/webview/kanban.html`)
- Remove the three visibility checkbox blocks from the Agents tab (gatherer, code_researcher, splitter — lines ~2706–2726).
- Remove the three `<option>` entries from the role selector dropdown (gatherer, code_researcher, splitter — lines ~2792–2795).
- Remove the three entries from the agent description map (lines ~3211–3213).
- Remove the splitter action button from the PLAN REVIEWED column header (lines ~4612–4614).
- Remove `updateSplitterButtonVisibility()` function and all calls to it (lines ~4980–4982, ~6462, ~6663).
- Remove the three column-to-role mapping entries from the kanban column map (lines ~7848–7850).

### Step 4 — Prompt builder (`src/services/agentPromptBuilder.ts`)
- Remove the `if (role === 'gatherer')` prompt branch (lines ~1169–1174).
- Remove the `if (role === 'splitter')` prompt branch (lines ~1088–1147).
- Remove the `if (role === 'code_researcher')` prompt branch (lines ~1051–1088).
- Remove `gatherer`, `splitter`, `code_researcher` from the column-to-role mapping switch (lines ~1302–1305).
- Update the error message in `buildKanbanBatchPrompt` to remove these three role names from the listed built-in roles (line ~1284).
- Remove the three roles from any role-list arrays used for validation.

### Step 5 — KanbanProvider (`src/services/KanbanProvider.ts`)
- Remove the `case 'splitterSelected'` message handler block (lines ~6769–6795).
- Remove `splitter` and `orchestrator`-adjacent entries from the roles arrays (lines ~2579, ~2659).
- Remove `gatherer: false`, `splitter: false`, `code_researcher: false` from visible-agents state initialization (lines ~4363–4367).
- Remove the three `_getRoleConfig` calls and config extraction blocks for splitter, code_researcher, gatherer (lines ~3263–3298).
- Remove the three roles from the non-execution roles condition (lines ~4008–4009).
- Remove any column-to-role mapping entries for these three (lines ~3042, ~3046 conditional branches).

### Step 6 — TaskViewerProvider (`src/services/TaskViewerProvider.ts`)
- Remove `case 'CONTEXT GATHERER': return 'gatherer'`, `case 'CODE_RESEARCHER': return 'code_researcher'`, `case 'SPLITTER': return 'splitter'` from the column-to-role switch (lines ~2020–2023).
- Remove the single-card dispatch branches for these three roles (lines ~2055–2090).
- Remove these roles from any role-list arrays (line ~2639).

### Step 7 — PlanningPanelProvider (`src/services/PlanningPanelProvider.ts`)
- Remove `gatherer: false`, `splitter: false`, `code_researcher: false` from the default visibility state (lines ~8285–8286).
- Remove the `else if (role === 'gatherer')` dispatch branch (line ~15897).

### Step 8 — implementation.html (`src/webview/implementation.html`)
- Remove `gatherer: false` from the `visibleAgents` object (line 3713). Leave the remaining keys untouched.

### Step 9 — Migration code
Add a one-time migration in the extension activation path (likely `extension.ts` or the KanbanProvider init):
- For each workspace with a kanban state, check for cards in `CONTEXT GATHERER`, `CODE_RESEARCHER`, and `SPLITTER` columns.
- Move any found cards to `PLAN REVIEWED`.
- This check is idempotent — once those column IDs are removed from built-in definitions, the migration guard can remain in place safely.

### Step 10 — Persona file
- Rename `.agents/personas/gatherer.md` → `.agents/personas/gatherer.md.migrated.bak`.

### Step 11 — Tests (5 files)
Update to remove references to the deleted roles:
- `src/test/kanban-default-prompt-previews.test.js` — remove visible-agents assertions for these three keys.
- `src/services/__tests__/KanbanProvider.test.ts` — remove column definition tests and agent config tests for these roles.
- `src/services/__tests__/agentPromptBuilder.test.ts` — remove prompt-building tests for gatherer, splitter, code_researcher.
- `src/test/agent-prompt-builder-subagents.test.js` — remove subagent policy tests for these roles.
- `src/test/minimal-prompt.test.js` — remove any references to these three roles.

## Out of Scope

- `.switchboard/plans/*.md` files that document past features for these agents — leave as historical record.
- User-stored role configuration data in VS Code workspace/global state — silently ignored once the keys are gone; no cleanup needed.

## Metadata

**Complexity:** 6  
**Tags:** refactor, frontend, backend, ui
