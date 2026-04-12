# Visual Kanban Structure Reordering Plan

## Goal
The goal is to replace the confusing numeric "Kanban Order" fields with a visual drag-and-drop interface in a new "Kanban Structure" section within the Setup UI.

Clarification: This change centralizes column ordering in one place without changing the underlying Kanban workflow stages, the meaning of existing columns, or the fixed-anchor behavior of `CREATED` and `COMPLETED`.

## Metadata
**Tags:** frontend, backend, UI
**Complexity:** 7

## User Review Required

> [!IMPORTANT]
> - **Fixed Anchors**: The "New" and "Completed" columns will remain fixed at the start and end of the list. All other active columns (Planned, Built-in agent roles, and Custom Agents) will be reorderable.
> - **State Management**: Order overrides for built-in roles will now be persisted in the workspace state, making them fully customizable per project.
> - **Clarification:** The persisted drag payload should only contain the reorderable middle sequence; `CREATED` and `COMPLETED` must never be rewritten from the webview.
> - **Clarification:** Removing the raw numeric inputs means newly added custom Kanban agents should append to the end of the current reorderable sequence by default until the user drags them elsewhere.

## Complexity Audit
### Routine
- `src/services/agentConfig.ts`: Expand `KanbanColumnBuildOverrides`, add `reweightSequence(orderedIds: string[])`, and teach `buildKanbanColumns()` to consume a general override map instead of a one-off Team Lead override.
- `src/services/KanbanProvider.ts`: Replace the current single `kanban.teamLeadKanbanOrder` read/write path with a generalized built-in order override map and keep the board refresh behavior identical.
- `src/services/SetupPanelProvider.ts`: Add message routing for `updateKanbanStructure` and any companion hydration message needed to paint the structure list.
- `src/services/TaskViewerProvider.ts`: Add a focused persistence method that rewrites built-in order overrides plus `state.customAgents[*].kanbanOrder`, then refreshes the board and reposts setup state.
- `src/webview/setup.html`: Add a new accordion, remove the Team Lead/custom-agent numeric fields, and render a drag-and-drop list driven by existing setup-panel state.
- `src/test/agent-config-drag-drop-mode.test.js`: Add unit coverage for `reweightSequence()` and for `buildKanbanColumns()` honoring persisted built-in overrides.

### Complex / Risky
- **Mixed persistence model:** Built-in columns live in VS Code workspace state, while custom agent order lives in `.switchboard/state.json`. The implementation must update both stores from one drag gesture without producing a half-applied sequence.
- **Hydration and autosave drift:** `src/webview/setup.html` currently recomputes signatures from `collectSetupSavePayload()` and hydrates from separate `startupCommands`, `visibleAgents`, `customAgents`, and `teamLeadRoutingSettings` messages. The new structure list needs a canonical ordering payload so drag state does not flicker or serialize stale order data.
- **Hidden-column semantics:** The reorder UI intentionally hides disabled columns, but hiding must not destroy their stored position. A temporarily hidden Acceptance Tester or Team Lead column should reappear in its prior relative location when re-enabled.
- **Board-behavior coupling:** Column order affects rendering and any code paths that depend on the sorted column list. Reordering must not break special-case transitions such as `CREATED -> PLAN REVIEWED`, coded columns flowing to `CODE REVIEWED`, or `CODE REVIEWED -> ACCEPTANCE TESTED`.
- **Active-plan merge risk:** Another active Planned item already targets `src/webview/setup.html` and `src/services/TaskViewerProvider.ts`; this plan needs explicit conflict notes so the eventual implementation is sequenced cleanly.

## Edge-Case & Dependency Audit
- **Race Conditions:** The drag UI must update local webview state immediately for responsiveness, but the extension side still needs to validate and persist the sequence atomically. Use a dedicated `updateKanbanStructure` path instead of piggybacking on `saveStartupCommands`, then repost canonical structure data after persistence so autosave hydration cannot reorder the list back to stale values.
- **Security:** Do not trust the webview payload. `TaskViewerProvider.handleUpdateKanbanStructure(sequence)` should reject unknown IDs, duplicate IDs, and attempts to reorder `CREATED` or `COMPLETED`. Only IDs derived from the current workspace's built-in columns plus `includeInKanban` custom agents should be accepted.
- **Side Effects:** Reweighting should keep wide numeric gaps (for example `100` increments) so future inserts remain stable and existing sort behavior continues to work. Keep legacy Team Lead order behavior compatible by treating any previously stored `kanban.teamLeadKanbanOrder` value as an input until the generalized override map is written.
- **Dependencies & Conflicts:** `switchboard-get_kanban_state` succeeded. Active Planned items are: (1) **Restore Targeted Gitignore Strategy as Default for Workspace Exclusion System** — direct merge conflict risk because that plan explicitly edits `src/webview/setup.html` and `src/services/TaskViewerProvider.ts`; coordinate or land sequentially. (2) **Persona Protocol Hardening** — no code overlap; it only targets `.agent/personas/switchboard_operator.md`. Historical filenames under `.switchboard/plans/` also indicate nearby prior work (`reverse_kanban_card_sort_order.md`, `disable_team_lead_column_by_default_and_add_routing_options.md`, `make_team_lead_column_visibility_consistent_with_other_agents.md`), so current repository code should be treated as the baseline source of truth rather than any older assumptions.

## Adversarial Synthesis
### Grumpy Critique
This plan is one slippery UI refactor away from becoming a state-corruption machine. Right now the system gets away with a dumb numeric field because the write path is obvious: user types a number, it lands in one place, and the board sorts. The second you add drag-and-drop, you have three moving targets: built-in columns in workspace state, custom agents in `.switchboard/state.json`, and a webview that already hydrates itself from multiple asynchronous messages. If you do not define one canonical ordering model, users will drag Reviewer above Coder, the UI will look right for five seconds, then hydration will snap it back, or worse, only half the order will persist.

And the current plan was dangerously hand-wavy about retrieval. You cannot just add `updateKanbanStructure` and call it done. How does the webview know the current built-in order on load? How does a hidden Team Lead column preserve its spot when toggled back on? What happens when a custom agent is removed but its stale order weight still exists in overrides? What if the drag payload contains duplicate IDs because the DOM got out of sync? Pretending those are implementation details is how you ship a feature that looks polished in a demo and quietly trashes workspace configuration in real use.

The other red flag is cross-plan conflict. There is already an active Planned gitignore/settings plan touching the same setup webview and `TaskViewerProvider` autosave plumbing. If this implementation lands without an explicit sequencing strategy, you are begging for merge conflicts in the exact code that already has the most brittle hydration logic. This is not a “just add a list” change; it is a cross-layer state model change, and it deserves to be treated like one.

### Balanced Response
The critique is fair, so the implementation should revolve around a single canonical structure model instead of ad hoc UI state. The safest shape is: backend computes the ordered structure, backend validates any reordered sequence, backend persists both storage targets, and backend reposts the authoritative structure to the webview after every successful save. That keeps drag-and-drop as a presentation layer over existing persisted order values rather than inventing a second source of truth.

The plan below closes the underspecified gaps by adding an explicit retrieval/hydration path, server-side sequence validation, legacy Team Lead compatibility, and hidden-column preservation rules. It also calls out the active `setup.html` / `TaskViewerProvider.ts` overlap with the gitignore plan so implementation can be sequenced instead of merged blindly. With those constraints in place, this is still a meaningful cross-cutting change, but it is bounded: one canonical ordering helper, one persistence method, one UI list, one unit-test expansion, and a manual verification flow that specifically exercises hidden columns, custom agents, persistence, and board refresh behavior.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks where practical, and keep the final implementation aligned to the exact file paths and symbols below. The key hardening rule is that the extension owns the canonical order and the webview only renders and submits validated sequences.

### Low-Complexity Implementation Steps
1. **Normalize the canonical order model**
   - In `src/services/agentConfig.ts`, define the shared helper(s) that can convert a visual sequence into sortable numeric weights.
   - In `src/services/KanbanProvider.ts`, load and persist a generalized built-in order override map from workspace state.
   - In `src/services/TaskViewerProvider.ts`, expose a read method that packages the current ordered Kanban structure for the setup webview.
2. **Replace legacy numeric inputs with one visual entry point**
   - In `src/webview/setup.html`, add a `Kanban Structure` accordion.
   - Remove the Team Lead numeric order field and the custom-agent modal numeric order field from the visible UI.
   - Update `saveCustomAgentDraft()` so new Kanban agents append to the current end-of-list by default instead of reading a manual number input.
3. **Expand unit coverage around ordering math**
   - Extend `src/test/agent-config-drag-drop-mode.test.js` so helper coverage includes built-in overrides plus gap-preserving reweighting.
   - Keep tests narrow and deterministic: they should assert ordering behavior, not DOM interaction.

### High-Complexity Implementation Steps
1. **Create a canonical backend-driven structure payload**
   - Backend computes the structure from `buildKanbanColumns()`, current visible-agent settings, and current custom-agent definitions.
   - The payload distinguishes fixed anchors (`CREATED`, `COMPLETED`) from reorderable items and excludes hidden/non-Kanban rows from the reorder gesture.
   - The webview always re-renders from this canonical payload after load and after every save.
2. **Persist drag reordering across both storage systems atomically**
   - Built-in IDs update a workspace-state override map (for example `kanban.orderOverrides`).
   - Custom-agent IDs update `state.customAgents[*].kanbanOrder` in `.switchboard/state.json`.
   - Hidden reorderable columns keep their previous stored weights so a visibility toggle does not erase prior ordering intent.
3. **Keep board behavior and refresh paths stable**
   - `KanbanProvider` continues to be the only place that converts config into rendered column order.
   - Existing special transition logic in `TaskViewerProvider` remains intact; only the column sort order changes.
   - After persistence, trigger the existing Kanban refresh path and repost setup-panel state so both the sidebar board and setup UI converge immediately.

### [Component] Agent Configuration Logic

#### [MODIFY] `src/services/agentConfig.ts`
- Expand `KanbanColumnBuildOverrides` to support a general map of order overrides: `orderOverrides: Record<string, number>`.
- Update `buildKanbanColumns` to apply these overrides to built-in columns.
- Add a helper function `reweightSequence(orderedIds: string[]): Record<string, number>` to generate a new set of weights (with gaps) based on a visual sequence.
- **Context:** This file already owns the canonical default columns and the sort order used by both the Kanban board and setup-related code. The new visual reorder feature should not duplicate ordering rules anywhere else.
- **Logic:**
  1. Preserve `DEFAULT_KANBAN_COLUMNS` as the default source of labels, roles, kinds, and fallback order.
  2. Replace the special-case `teamLeadOrder` override with a general `orderOverrides` map keyed by column ID (`PLAN REVIEWED`, `TEAM LEAD CODED`, `LEAD CODED`, `CODER CODED`, `INTERN CODED`, `CODE REVIEWED`, `ACCEPTANCE TESTED`).
  3. Keep custom-agent ordering sourced from `CustomAgentConfig.kanbanOrder`; built-in overrides should never overwrite custom agent weights.
  4. Export `reweightSequence()` so both persistence code and tests use the same weighting strategy.
  5. Keep weight gaps wide (for example `100` between successive items) so appending a new custom agent or restoring a hidden column does not require immediate global renumbering.
- **Clarification:** Treat `CREATED` and `COMPLETED` as fixed anchors. They should retain their hardcoded orders (`0` and `9999`) and never participate in `reweightSequence()` input.
- **Clarification:** The helper should deduplicate input IDs defensively so a bad UI payload cannot assign two weights to the same column ID.
- **Implementation sketch:**

```ts
export interface KanbanColumnBuildOverrides {
    orderOverrides?: Record<string, number>;
}

export function reweightSequence(orderedIds: string[]): Record<string, number> {
    const STEP = 100;
    const seen = new Set<string>();
    const weights: Record<string, number> = {};

    orderedIds.forEach((id, index) => {
        if (!id || seen.has(id)) {
            return;
        }
        seen.add(id);
        weights[id] = (index + 1) * STEP;
    });

    return weights;
}

export function buildKanbanColumns(
    customAgents: CustomAgentConfig[],
    overrides: KanbanColumnBuildOverrides = {}
): KanbanColumnDefinition[] {
    const defaultColumns = DEFAULT_KANBAN_COLUMNS.map((column) => {
        const override = overrides.orderOverrides?.[column.id];
        return {
            ...column,
            order: typeof override === 'number' ? override : column.order
        };
    });

    const customColumns = customAgents
        .filter((agent) => agent.includeInKanban)
        .map(/* existing mapping, still driven by agent.kanbanOrder */);

    return [...defaultColumns, ...customColumns]
        .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}
```

- **Edge Cases Handled:** Duplicate IDs in the submitted sequence, gaps collapsing too tightly, and accidental mutation of fixed anchors are all blocked at the helper layer before UI or board code consumes the result.

### [Component] Kanban Provider State Bridge

#### [MODIFY] `src/services/KanbanProvider.ts`
- **Clarification:** This file is an implied touchpoint because it currently reads and writes the only built-in order override (`kanban.teamLeadKanbanOrder`) and is the authoritative source for board refreshes.
- **Context:** `KanbanProvider._buildKanbanColumns()` is the shared bridge between stored settings and rendered board order. The generalized visual ordering feature should flow through that same bridge.
- **Logic:**
  1. Add a private `_kanbanOrderOverrides: Record<string, number>` field initialized from `this._context.workspaceState.get('kanban.orderOverrides', {})`.
  2. Fold any legacy `_teamLeadKanbanOrder` value into the override map when building columns so existing workspaces keep their Team Lead placement until the new UI saves an updated order.
  3. Add `getKanbanOrderOverrides()` / `setKanbanOrderOverrides()` helpers (or equivalent private/public methods) so `TaskViewerProvider` can persist built-in weights without directly touching extension context state.
  4. Ensure `setKanbanOrderOverrides()` schedules the same board refresh path currently used by `setTeamLeadKanbanOrder()`.
- **Clarification:** Retain `getTeamLeadRoutingSettings().complexityCutoff`; only the dedicated order field becomes legacy. If keeping `kanbanOrder` in that response for backward compatibility, source it from the effective override for `TEAM LEAD CODED`.
- **Implementation sketch:**

```ts
private _kanbanOrderOverrides: Record<string, number>;

private _buildKanbanColumns(customAgents: CustomAgentConfig[]): KanbanColumnDefinition[] {
    const effectiveOverrides = {
        ...this._kanbanOrderOverrides
    };

    if (
        typeof this._teamLeadKanbanOrder === 'number'
        && effectiveOverrides['TEAM LEAD CODED'] === undefined
    ) {
        effectiveOverrides['TEAM LEAD CODED'] = this._teamLeadKanbanOrder;
    }

    return buildKanbanColumns(customAgents, { orderOverrides: effectiveOverrides });
}
```

- **Edge Cases Handled:** Existing Team Lead-only configurations stay intact, board refresh behavior remains centralized, and later code can read one effective built-in override map instead of inventing ad hoc ordering rules.

---

### [Component] Setup Webview UI

#### [MODIFY] `src/webview/setup.html`
- **New Section**: Add a "Kanban Structure" accordion section.
- **Drag-and-Drop List**: Implement a vertical list of active columns (badges/tiles) with drag handles.
- **Dynamic Preview**: The list will automatically hide columns that are toggled off in the "Agent Visibility" section.
- **Persistence**: When the order is changed via drag-and-drop, send an `updateKanbanStructure` message to the extension containing the new ID sequence.
- **Cleanup**: Remove or hide the raw "Kanban position/order" numeric inputs from the Orchestration and Custom Agent modals to reduce confusion.
- **Context:** The webview currently exposes numeric ordering in two separate places (`team-lead-kanban-order` and `custom-agent-order`) and already maintains client-side setup state (`lastVisibleAgents`, `lastCustomAgents`, autosave signatures). The new UI should extend that existing state model instead of creating a second configuration pathway.
- **Logic:**
  1. Add DOM containers such as `kanban-structure-toggle`, `kanban-structure-fields`, and `kanban-structure-list` near the existing agent/custom-agent controls so ordering is configured where visibility and agent membership already live.
  2. Add a new webview state variable (for example `lastKanbanStructure = []`) representing the canonical ordered payload returned by the extension.
  3. Render fixed anchor rows for `New` and `Completed` as visually locked items. Render only the middle active sequence as draggable rows.
  4. When visibility changes or custom agents are added/removed, re-render the structure list from canonical state and client-side visibility filters so the preview updates immediately.
  5. Replace `customAgentOrderInput` usage in `saveCustomAgentDraft()` with append-at-end logic: when creating a new `includeInKanban` custom agent, assign an order just after the current largest reorderable weight; when editing an existing agent, preserve its existing weight until it is dragged.
  6. Remove the Team Lead numeric field from `collectSetupSavePayload()` so the new structure message is the only ordering write path.
- **Clarification:** The drag payload should contain only reorderable IDs in visual order, for example:

```js
vscode.postMessage({
    type: 'updateKanbanStructure',
    sequence: ['PLAN REVIEWED', 'LEAD CODED', 'CODER CODED', 'custom_agent_docs', 'CODE REVIEWED']
});
```

- **Clarification:** Because the setup panel loads from backend state asynchronously, `renderKanbanStructureList()` should no-op gracefully until both `lastKanbanStructure` and the current visibility/custom-agent state are available.
- **Clarification:** Keep the drag implementation dependency-free; native HTML5 drag events are sufficient and match the rest of this static webview.
- **Implementation sketch:**

```html
<div class="startup-section">
    <div class="startup-toggle" id="kanban-structure-toggle">
        <div class="section-label">Kanban Structure</div>
        <span class="chevron" id="kanban-structure-chevron">▶</span>
    </div>
    <div class="startup-fields" id="kanban-structure-fields" data-accordion="true">
        <div id="kanban-structure-list"></div>
        <div class="hint-text">Drag active middle columns to change board order. New and Completed stay fixed.</div>
    </div>
</div>
```

```js
function renderKanbanStructureList() {
    const fixedStart = lastKanbanStructure.find((item) => item.id === 'CREATED');
    const fixedEnd = lastKanbanStructure.find((item) => item.id === 'COMPLETED');
    const middle = lastKanbanStructure.filter((item) => !item.fixed && item.visible !== false);

    // Render locked anchors + draggable middle rows.
}
```

- **Edge Cases Handled:** Hidden agent columns disappear without losing stored order, stale numeric inputs stop competing with drag order, and new custom agents land in a predictable append position until explicitly reordered.

---

### [Component] Extension Services

#### [MODIFY] `src/services/SetupPanelProvider.ts`
- Add a handler for the `updateKanbanStructure` message.
- Forward the new sequence to `TaskViewerProvider`.
- **Context:** This provider already routes all setup-webview messages to `TaskViewerProvider`; the new ordering workflow should follow the same pattern.
- **Logic:**
  1. Add a new `case 'updateKanbanStructure':` branch in `_handleMessage(message)`.
  2. Forward `message.sequence` to `this._taskViewerProvider.handleUpdateKanbanStructure(message.sequence)`.
  3. After success, repost setup-panel state (or a focused `kanbanStructure` message) and refresh the main UI so the sidebar and setup panel stay in sync.
- **Clarification:** If the validation fails, surface the error via the existing `Setup panel error:` path instead of silently swallowing a bad drag payload.

#### [MODIFY] `src/services/TaskViewerProvider.ts`
- Implement `handleUpdateKanbanStructure(sequence: string[])`.
- This will use the re-weighting logic to update `kanbanOrder` for custom agents and the new `orderOverrides` for built-in roles in the workspace state.
- Ensure the Kanban board refreshes immediately after the save.
- **Context:** `TaskViewerProvider` already owns setup-panel hydration (`postSetupPanelState()`), custom-agent reads/writes (`getCustomAgents()`, `handleSaveStartupCommands()`), and the handoff to `KanbanProvider` for board behavior. This is the right place to coordinate the mixed persistence write.
- **Logic:**
  1. Build the current canonical structure from `getCustomAgents()`, `getVisibleAgents()`, and `_buildKanbanColumnsForWorkspace(customAgents)`.
  2. Validate `sequence` against the currently reorderable active IDs: no unknown IDs, no duplicates, no fixed anchors.
  3. Call `reweightSequence(sequence)` to compute new weights.
  4. Split the resulting weights into:
     - built-in overrides persisted through `KanbanProvider.setKanbanOrderOverrides(...)`
     - custom-agent `kanbanOrder` updates written through `updateState(...)`
  5. Preserve hidden or currently omitted reorderable items by leaving their existing stored weights unchanged.
  6. Call `postSetupPanelState()` and trigger the existing board refresh command/path so the sidebar reflects the new order immediately.
- **Clarification:** Add a companion read path such as `handleGetKanbanStructure()` or extend `postSetupPanelState()` to post a `kanbanStructure` message. Retrieval is required so persisted built-in overrides are visible when the setup panel opens.
- **Clarification:** Keep legacy handling of `teamLeadKanbanOrder` in `handleSaveStartupCommands()` only for backward compatibility with stale webview bundles; the new source UI should stop sending it.
- **Implementation sketch:**

```ts
public async handleUpdateKanbanStructure(sequence: string[], workspaceRoot?: string): Promise<void> {
    const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (!resolvedRoot) {
        return;
    }

    const customAgents = await this.getCustomAgents(resolvedRoot);
    const visibleAgents = await this.getVisibleAgents(resolvedRoot);
    const structure = this._buildSetupKanbanStructure(customAgents, visibleAgents);
    const reorderableIds = structure.filter((item) => item.reorderable).map((item) => item.id);

    validateSequence(sequence, reorderableIds);
    const weights = reweightSequence(sequence);

    await this.updateState(async (state) => {
        state.customAgents = parseCustomAgents(state.customAgents).map((agent) => ({
            ...agent,
            kanbanOrder: weights[agent.role] ?? agent.kanbanOrder
        }));
    });

    await this._kanbanProvider?.setKanbanOrderOverrides(
        Object.fromEntries(
            Object.entries(weights).filter(([id]) => !id.startsWith('custom_agent_'))
        ),
        resolvedRoot
    );

    await this.postSetupPanelState(resolvedRoot);
    await vscode.commands.executeCommand('switchboard.refreshUI');
}
```

- **Edge Cases Handled:** Invalid drag payloads are rejected server-side, hidden columns keep their prior weights, custom and built-in persistence stay coordinated, and the webview always receives canonical ordering after a save.

### [Component] Setup State Hydration Payload

#### [MODIFY] `src/services/TaskViewerProvider.ts` and `src/webview/setup.html`
- **Clarification:** The original plan implicitly required a read path for the current visual structure, but did not name it. Add one explicitly.
- **Context:** `postSetupPanelState()` already posts `startupCommands`, `visibleAgents`, `customAgents`, and `teamLeadRoutingSettings`. The new drag UI needs an ordered structure payload as well.
- **Logic:**
  1. Define a shape such as:

```ts
interface SetupKanbanStructureItem {
    id: string;
    label: string;
    role?: string;
    kind: string;
    fixed: boolean;
    reorderable: boolean;
    visible: boolean;
}
```

  2. Post `kanbanStructure` from `postSetupPanelState()` after `visibleAgents` and `customAgents` so the webview has the inputs it needs.
  3. In `setup.html`, store the payload and re-render the structure list in the `window.addEventListener('message', ...)` switch.
- **Clarification:** This should be a focused message; do not overload `teamLeadRoutingSettings` with unrelated structure data.
- **Edge Cases Handled:** Initial panel load, reopened setup panels, and visibility/custom-agent edits all share the same canonical render source.

### [Component] Verification Coverage

#### [MODIFY] `src/test/agent-config-drag-drop-mode.test.js`
- Update `src/test/agent-config-drag-drop-mode.test.js` to verify that order overrides are correctly applied during column building.
- Verify that `reweightSequence` handles gaps correctly even with many columns.
- **Context:** This file already exercises `parseCustomAgents()` and `buildKanbanColumns()`, so it is the narrowest existing place to add ordering coverage without inventing a new test harness.
- **Logic:**
  1. Add a test that passes `orderOverrides` for built-in IDs and asserts the returned sorted order changes accordingly.
  2. Add a test that `reweightSequence(['PLAN REVIEWED', 'LEAD CODED', 'CODER CODED'])` returns monotonically increasing weights with deterministic gaps.
  3. Add a test that duplicate IDs are ignored or rejected according to the chosen helper contract.
  4. Keep existing drag-drop-mode assertions unchanged so the feature expansion does not regress custom-agent column metadata.
- **Clarification:** Webview drag interaction itself can remain manual-verification territory; the automated tests should focus on deterministic ordering logic.

## Verification Plan

### Automated Tests
- Run `npm run lint` to catch TypeScript/JS changes in `src/services/agentConfig.ts`, `src/services/KanbanProvider.ts`, `src/services/SetupPanelProvider.ts`, `src/services/TaskViewerProvider.ts`, and `src/webview/setup.html`.
- Run `npm run compile` to ensure the extension and bundled webview still build after removing the numeric-order fields and adding the new structure payload.
- Run `npm test` so the existing extension test suite picks up the expanded `src/test/agent-config-drag-drop-mode.test.js` coverage.

### Manual Verification
1. Open the **Setup** panel.
2. Expand the new **Kanban Structure** section.
3. Confirm `New` is shown first and `Completed` is shown last as fixed, non-draggable anchors.
4. Drag "Reviewer" to come before "Coder".
5. Toggle "Acceptance Tester" on in the visibility section and verify it appears in the reordering list without displacing the fixed anchors.
6. Toggle "Acceptance Tester" back off, then on again, and verify it returns to its previously stored relative position.
7. Add a custom agent with **Show as Kanban column** enabled and verify it appears at the end of the reorderable middle sequence by default.
8. Drag that custom agent between two built-in columns and verify the Kanban board columns reflect the new order immediately.
9. Refresh VS Code and verify the custom order persists.
10. Reopen the Setup panel and verify there are no remaining editable numeric Kanban order inputs in the Team Lead or custom-agent flows.

## Reviewer Addendum (2026-04-11)
### Stage 1 - Grumpy Critique
- **CRITICAL:** None. The shared ordering path now actually runs through `agentConfig`, `KanbanProvider`, `TaskViewerProvider`, and `setup.html` instead of four competing little fiefdoms.
- **MAJOR:** None. The drag-order feature is wired through the intended persistence bridge, and the fixed anchors remain protected in the live app path.
- **NIT:** The fixed-anchor guarantee still relies on upstream sanitization before `buildKanbanColumns()` sees overrides. That's acceptable in the current call graph, but the canonical builder itself is not independently hostile to a caller that passes anchor overrides by hand.

### Stage 2 - Balanced Response
- **Keep:** The generalized `orderOverrides` model, `reweightSequence()`, setup hydration payload, and immediate refresh path are all the right architecture.
- **Fix now:** Nothing. I did not find a material implementation gap that warranted code changes during this review.
- **Defer:** If this ordering API ever gets broader reuse, hardening `buildKanbanColumns()` itself against `CREATED`/`COMPLETED` overrides would be a worthwhile defense-in-depth follow-up.

### Fixed Items
- None.

### Files Changed During Review
- `.switchboard/plans/brain_d0af6b8e9d4ebeb25e1a1e589f9466909476ce67f72b582d06a5fefbfefcce85.md` (review addendum only)

### Validation Results
- `npm run compile`
- `node src/test/team-lead-routing-options-regression.test.js`
- Manual compiled-module check against `out/services/agentConfig.js` for `reweightSequence()` and built-in `orderOverrides`

### Remaining Risks
- Direct future callers of `buildKanbanColumns()` could still pass anchor overrides unless that helper is hardened locally, but the current persisted path sanitizes them first.

## Reviewer Addendum (2026-04-11)
### Stage 1 - Grumpy Critique
- **CRITICAL:** None. The shared ordering path now actually runs through `agentConfig`, `KanbanProvider`, `TaskViewerProvider`, and `setup.html` instead of four competing little fiefdoms.
- **MAJOR:** None. The drag-order feature is wired through the intended persistence bridge, and the fixed anchors remain protected in the live app path.
- **NIT:** The fixed-anchor guarantee still relies on upstream sanitization before `buildKanbanColumns()` sees overrides. That's acceptable in the current call graph, but the canonical builder itself is not independently hostile to a caller that passes anchor overrides by hand.

### Stage 2 - Balanced Response
- **Keep:** The generalized `orderOverrides` model, `reweightSequence()`, setup hydration payload, and immediate refresh path are all the right architecture.
- **Fix now:** Nothing. I did not find a material implementation gap that warranted code changes during this review.
- **Defer:** If this ordering API ever gets broader reuse, hardening `buildKanbanColumns()` itself against `CREATED`/`COMPLETED` overrides would be a worthwhile defense-in-depth follow-up.

### Fixed Items
- None.

### Files Changed During Review
- `.switchboard/plans/brain_d0af6b8e9d4ebeb25e1a1e589f9466909476ce67f72b582d06a5fefbfefcce85.md` (review addendum only)

### Validation Results
- `npm run compile`
- `node src/test/team-lead-routing-options-regression.test.js`
- Manual compiled-module check against `out/services/agentConfig.js` for `reweightSequence()` and built-in `orderOverrides`

### Remaining Risks
- Direct future callers of `buildKanbanColumns()` could still pass anchor overrides unless that helper is hardened locally, but the current persisted path sanitizes them first.
