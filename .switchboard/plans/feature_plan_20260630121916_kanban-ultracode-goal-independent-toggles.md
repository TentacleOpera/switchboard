# Make Ultracode & Goal Epic Workflow Buttons Independently Toggleable

## Goal

Make the **Ultracode** (`#btn-epic-ultracode`) and **Goal** (`#btn-epic-goal`) epic-workflow toggle buttons in `kanban.html` independently toggleable, so both directives can be active simultaneously (ultracode prefix + `/goal` slash command prepended to the same epic prompt). This requires converting the single tri-state `epicWorkflowMode` string into two independent booleans across all three layers (webview state, message protocol, backend persistence + prompt building), with a migration path for the legacy `epic_workflow_mode` config key that has shipped to ~4,000 installs.

### Problem
In `kanban.html`, the **Ultracode** (`#btn-epic-ultracode`) and **Goal** (`#btn-epic-goal`) epic-workflow toggle buttons are mutually exclusive — enabling one disables the other. The user expects both to be independently toggleable so that both directives can be active at once (ultracode prefix + `/goal` slash command prepended to the same epic prompt).

### Background Context
The two buttons live in the kanban top bar (`kanban.html:2490-2495`) and control whether epic prompts get a directive prepended at dispatch time. The prepend logic lives in `KanbanProvider.ts:3246-3260` inside `generateUnifiedPrompt`: when the primary plan is an epic and `role !== 'planner'`, it reads the `epic_workflow_mode` config and prepends either the ultracode prefix or the `/goal` command.

### Root Cause
The entire feature is built around a **single tri-state string** `epicWorkflowMode` with values `'none' | 'ultracode' | 'goal'`:

1. **Webview state** (`kanban.html:4205`): `let epicWorkflowMode = 'none';` — one variable holds exactly one mode.
2. **Toggle handler** (`kanban.html:4218-4223`): `setEpicWorkflowMode(mode)` does `epicWorkflowMode = (epicWorkflowMode === mode) ? 'none' : mode;` — clicking a button either selects that mode (replacing the other) or resets to `none`. There is no path where both are active.
3. **UI update** (`kanban.html:4206-4217`): each button's `is-active` class is gated on `epicWorkflowMode === '<mode>'`, so only one can ever show active.
4. **Backend persistence** (`KanbanProvider.ts:5741-5751`): stores a single `epic_workflow_mode` config key; validates against `VALID_EPIC_WORKFLOW_MODES = new Set(['none','ultracode','goal'])`.
5. **Prompt building** (`KanbanProvider.ts:3250-3258`): `if (mode === 'ultracode') ... else if (mode === 'goal') ...` — an `else if`, so only one directive is ever prepended.

Because the state model is "pick one of three," independent toggling is impossible at every layer.

## Metadata
- **Tags:** `frontend`, `backend`, `ui`, `feature`, `refactor`
- **Complexity:** 5

## User Review Required
Yes — the migration strategy for the legacy `epic_workflow_mode` config key should be reviewed before implementation. The approach below reads the legacy key as the source of truth on every load until the new boolean keys are confirmed present, then persists the migrated values. The legacy key is left in place (harmless, enables rollback). Confirm this migration approach is acceptable.

## Complexity Audit

### Routine
- Replacing a single state variable with two booleans in the webview (`kanban.html`).
- Updating the UI toggle function to set `is-active`/`is-off` classes independently per button — directly mirrors the existing `updateCliToggleUi` pattern (`kanban.html:4196-4202`).
- Updating click listeners to call two independent toggle functions instead of one tri-state setter.
- Removing the `VALID_EPIC_WORKFLOW_MODES` constant (only 2 references: declaration at line 54, usage at line 5743 — both replaced by new code).
- Updating the message handler case to read two boolean fields instead of one string field.

### Complex / Risky
- **Data migration of `epic_workflow_mode`**: The legacy tri-state config key has shipped to ~4,000 installs and may hold `'ultracode'` or `'goal'` on existing boards. The new code must read the legacy key and translate it into the new two-boolean representation so users don't lose their existing toggle state. The migration must be idempotent and robust against partial-write crashes.
- **Prompt-building order**: When both directives are active, `/goal` MUST remain at position-zero for the host to parse it as a slash command. Order: `${GOAL_EPIC_PREFIX}\n${ULTRACODE_EPIC_PREFIX}\n\n${built}`.
- **Message protocol backward compatibility**: Both the webview→backend (`setEpicWorkflowMode`) and backend→webview (`epicWorkflowModeState`) messages change shape from `{ mode }` to `{ ultracode, goal }`. Legacy `mode` field must be tolerated on incoming messages.

## Edge-Case & Dependency Audit
- **Migration of `epic_workflow_mode`**: Existing boards may have `epic_workflow_mode = 'ultracode'` or `'goal'` persisted in the kanban DB config table. On load, the new code reads the legacy key as the source of truth when the new boolean keys are absent, translates it into both booleans, and persists the new keys. The legacy key is left in place (harmless, enables rollback). `getConfig` returns `null` for absent keys (confirmed: `KanbanDatabase.ts:3093-3102`), so absence detection is reliable.
- **Partial-migration crash recovery**: If the process crashes between writing `epic_ultracode_enabled` and `epic_goal_enabled` (two separate `setConfig` calls), the migration must re-trigger on the next load. The improved migration logic checks whether the legacy key exists AND either new key is absent — if so, it re-derives both booleans from the legacy key and re-persists. This makes the migration self-healing.
- **`/goal` position-zero requirement** (`KanbanProvider.ts:3254-3257`): When both directives are active, `/goal` MUST come before the ultracode prefix and before any safeguard/authorization wall, or the host won't parse it as a slash command. Order: `${GOAL_EPIC_PREFIX}\n${ULTRACODE_EPIC_PREFIX}\n\n${built}`.
- **Planner role skip** (`KanbanProvider.ts:3247`): The `role !== 'planner'` guard must be preserved — these are execution-mode directives that would hijack the improve-plan workflow.
- **Message protocol**: The webview→backend message `setEpicWorkflowMode` and the backend→webview `epicWorkflowModeState` both carry a single `mode` string. Both must change to carry two booleans. Keep backward compatibility by tolerating the old `mode` field on incoming messages (translate to booleans).
- **`VALID_EPIC_WORKFLOW_MODES`** (`KanbanProvider.ts:54`): Currently validates the tri-state. Remove it; the new validation is per-boolean. Only 2 references exist (declaration + usage in handler), both replaced by new code.
- **State push on board load** (`_postEpicWorkflowModeState`, called at lines 1370, 2300, 2448): Must push both booleans (plus migrate from legacy key on first read). All three call sites pass `resolvedWorkspaceRoot` and require no changes.
- **No other consumers**: grep confirms `epic_workflow_mode` is only read in `KanbanProvider.ts` (config: 4 matches) and `kanban.html` (UI: 12 matches) — no other files depend on it.

## Dependencies
- None — this plan is self-contained and touches only `src/webview/kanban.html` and `src/services/KanbanProvider.ts`.

## Adversarial Synthesis
Key risks: (1) the legacy `epic_workflow_mode` config key has shipped to ~4,000 installs and must be migrated without data loss, (2) the `/goal` prefix must remain at position-zero when both directives are active or the host won't parse it as a slash command, (3) the message protocol changes shape across two layers and must tolerate the legacy `mode` field. Mitigations: the migration reads the legacy key as source-of-truth when either new key is absent (self-healing against partial-write crashes), the prompt-building logic explicitly orders `/goal` before the ultracode prefix, and both message directions carry backward-compatible fallbacks for the old `{ mode }` shape.

## Proposed Changes

### File: `src/webview/kanban.html`

**1. Replace the single state variable with two booleans (around line 4204-4205):**

```js
// Epic workflow toggles: independently toggleable (both can be active at once)
let epicUltracodeEnabled = false;
let epicGoalEnabled = false;
```

**2. Replace `updateEpicWorkflowToggleUi` (lines 4206-4217):**

```js
function updateEpicWorkflowToggleUi() {
    const ucBtn = document.getElementById('btn-epic-ultracode');
    const goalBtn = document.getElementById('btn-epic-goal');
    if (ucBtn) {
        ucBtn.classList.toggle('is-active', epicUltracodeEnabled);
        ucBtn.classList.toggle('is-off', !epicUltracodeEnabled);
    }
    if (goalBtn) {
        goalBtn.classList.toggle('is-active', epicGoalEnabled);
        goalBtn.classList.toggle('is-off', !epicGoalEnabled);
    }
}
```

**3. Replace `setEpicWorkflowMode` (lines 4218-4223) with two independent togglers:**

```js
function toggleEpicUltracode() {
    epicUltracodeEnabled = !epicUltracodeEnabled;
    updateEpicWorkflowToggleUi();
    postKanbanMessage({ type: 'setEpicWorkflowMode', ultracode: epicUltracodeEnabled, goal: epicGoalEnabled });
}

function toggleEpicGoal() {
    epicGoalEnabled = !epicGoalEnabled;
    updateEpicWorkflowToggleUi();
    postKanbanMessage({ type: 'setEpicWorkflowMode', ultracode: epicUltracodeEnabled, goal: epicGoalEnabled });
}
```

**4. Update the message handler (lines 6294-6296) to accept the new payload shape with legacy fallback:**

```js
case 'epicWorkflowModeState':
    if (typeof msg.ultracode === 'boolean') {
        epicUltracodeEnabled = msg.ultracode;
        epicGoalEnabled = !!msg.goal;
    } else {
        // Legacy fallback: translate tri-state mode to booleans
        epicUltracodeEnabled = msg.mode === 'ultracode';
        epicGoalEnabled = msg.mode === 'goal';
    }
    updateEpicWorkflowToggleUi();
    break;
```

**5. Update the click listeners (lines 7037-7042):**

```js
document.getElementById('btn-epic-ultracode')?.addEventListener('click', toggleEpicUltracode);
document.getElementById('btn-epic-goal')?.addEventListener('click', toggleEpicGoal);
```

### File: `src/services/KanbanProvider.ts`

**6. Remove `VALID_EPIC_WORKFLOW_MODES` (line 54) — no longer needed for validation; the new handler uses boolean checks.**

**7. Update `_postEpicWorkflowModeState` (lines 2720-2727) to read two keys with self-healing legacy migration:**

The migration logic reads the legacy `epic_workflow_mode` key as the source of truth whenever either new boolean key is absent from the config table. This handles: (a) first load after upgrade (both new keys absent), (b) partial-migration crash recovery (one new key absent), and (c) fresh installs (legacy key absent, new keys absent → defaults to both false). After deriving the booleans, it persists both new keys so subsequent loads skip the migration branch.

```ts
private async _postEpicWorkflowModeState(workspaceRoot: string): Promise<void> {
    const db = this._getKanbanDb(workspaceRoot);
    let ultracode = false;
    let goal = false;
    if (db && await db.ensureReady()) {
        const ucRaw = await db.getConfig('epic_ultracode_enabled');
        const goalRaw = await db.getConfig('epic_goal_enabled');
        if (ucRaw !== null && goalRaw !== null) {
            // New keys already present — use them directly
            ultracode = ucRaw === 'true';
            goal = goalRaw === 'true';
        } else {
            // Migration needed: either first load or partial-write crash recovery.
            // The legacy tri-state key is the source of truth.
            const legacy = (await db.getConfig('epic_workflow_mode')) || 'none';
            ultracode = legacy === 'ultracode';
            goal = legacy === 'goal';
            // Persist migrated values so future loads skip this branch
            await db.setConfig('epic_ultracode_enabled', ultracode ? 'true' : 'false');
            await db.setConfig('epic_goal_enabled', goal ? 'true' : 'false');
        }
    }
    this._panel?.webview.postMessage({ type: 'epicWorkflowModeState', ultracode, goal });
}
```

**8. Update the `setEpicWorkflowMode` message handler (lines 5741-5751) to persist two booleans (with legacy `mode` tolerance):**

```ts
case 'setEpicWorkflowMode': {
    // New shape: { ultracode: boolean, goal: boolean }
    // Legacy shape: { mode: 'none'|'ultracode'|'goal' } — tolerated for back-compat
    let ultracode: boolean;
    let goal: boolean;
    if (typeof msg.ultracode === 'boolean') {
        ultracode = msg.ultracode;
        goal = !!msg.goal;
    } else {
        const mode = String(msg.mode || 'none');
        ultracode = mode === 'ultracode';
        goal = mode === 'goal';
    }
    const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const db = wsRoot ? this._getKanbanDb(wsRoot) : undefined;
    if (db && await db.ensureReady()) {
        await db.setConfig('epic_ultracode_enabled', ultracode ? 'true' : 'false');
        await db.setConfig('epic_goal_enabled', goal ? 'true' : 'false');
    }
    this._panel?.webview.postMessage({ type: 'epicWorkflowModeState', ultracode, goal });
    break;
}
```

**9. Update the prompt-building prepend logic (lines 3247-3260) to prepend both, with `/goal` at position-zero:**

```ts
const primaryPlan = plans[0];
if (primaryPlan && primaryPlan.isEpic && role !== 'planner') {
    const db = this._getKanbanDb(workspaceRoot);
    if (db && await db.ensureReady()) {
        const ultracode = (await db.getConfig('epic_ultracode_enabled')) === 'true';
        const goal = (await db.getConfig('epic_goal_enabled')) === 'true';
        if (goal || ultracode) {
            let prefix = '';
            // /goal must be position-zero for the host to parse it as a slash command.
            if (goal) { prefix += `${GOAL_EPIC_PREFIX}\n`; }
            if (ultracode) { prefix += `${ULTRACODE_EPIC_PREFIX}\n\n`; }
            return `${prefix}${built}`;
        }
    }
}
return built;
```

**Clarification (not a new requirement):** The prompt-building site at `KanbanProvider.ts:3250` reads the config directly via `db.getConfig`. After migration, the new keys (`epic_ultracode_enabled`, `epic_goal_enabled`) are always present, so this read is reliable. If for any reason both new keys are absent (e.g., migration was skipped because the DB wasn't ready), `getConfig` returns `null`, `=== 'true'` evaluates to `false`, and no prefix is prepended — a safe no-op default.

## Verification Plan

### Automated Tests
No automated tests are run as part of this session (test suite will be run separately by the user). The following manual verification steps should be performed after implementation:

1. **Both active**: Enable Ultracode, then enable Goal. Confirm both buttons show `is-active` simultaneously. Dispatch an epic prompt (copy or CLI) and confirm the prepended text is `/goal\nThis is an epic with multiple subtasks. Activate your ultracode workflow.\n\n<prompt body>` — `/goal` at position-zero, ultracode prefix after.
2. **Single active**: Enable only Ultracode → prompt gets only the ultracode prefix. Enable only Goal → prompt gets only `/goal` at position-zero.
3. **Both off**: Disable both → prompt body is unchanged (no prefix).
4. **Toggle independence**: With both active, disable Ultracode → Goal stays active. Disable Goal → Ultracode stays active (if it was on).
5. **Persistence**: Reload the kanban board. Confirm both toggle states restore correctly from the new config keys.
6. **Legacy migration (ultracode)**: On a board with `epic_workflow_mode = 'ultracode'` (pre-upgrade), confirm the first load migrates to `epic_ultracode_enabled = 'true'`, `epic_goal_enabled = 'false'`, and the Ultracode button shows active.
7. **Legacy migration (goal)**: On a board with `epic_workflow_mode = 'goal'` (pre-upgrade), confirm the first load migrates to `epic_ultracode_enabled = 'false'`, `epic_goal_enabled = 'true'`, and the Goal button shows active.
8. **Legacy migration (none/fresh)**: On a board with `epic_workflow_mode = 'none'` or no legacy key, confirm both buttons remain inactive and no prefix is prepended.
9. **Partial-migration recovery**: Manually delete `epic_goal_enabled` from the config table (simulating a crash between the two `setConfig` calls). Reload. Confirm the migration re-triggers from the legacy key and restores the correct state.
10. **Planner skip**: Confirm neither directive is prepended when dispatching with `role === 'planner'`, regardless of toggle state.

**Compilation**: Skipped per session directives. The project is assumed to be in a pre-compiled state. TypeScript type errors in `KanbanProvider.ts` should be checked separately by the user via `npm run compile`.

---

**Recommendation:** Complexity is 5 (mixed: majority routine webview/boolean changes with one moderate, well-scoped risk — the data migration). **Send to Coder.**
