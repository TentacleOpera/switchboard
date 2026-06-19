# Constitution and Tuning Webview

## Goal

Create a new dedicated webview (tuning.html) with two tabs to support project constitution management and plan-based tuning workflows:
- **Constitution tab**: Surface and edit project constitution.md files with an interview-based builder skill
- **Tuning tab**: Provide agent prompts for reviewing completed plans and extracting adversarial insights

### Problem Analysis & Root Cause

Switchboard lacks first-class support for project constitutions — project-specific invariants that should be automatically surfaced during planning. Additionally, the adversarial review workflow generates valuable insights about recurring issues, but there's no mechanism to extract and apply these insights to improve project governance documents.

**Current state (as of plan review):** Constitution infrastructure is **already partially implemented**:
- `constitutionUtils.ts` provides `getConstitutionPath()` for path resolution
- `KanbanProvider._resolveConstitution()` reads constitution files and passes content to prompt builder
- `agentPromptBuilder.ts` already injects `constitutionContent`/`constitutionLink` into planner prompts (Phase 4 — DONE)
- `.agent/skills/constitution_builder.md` already exists with interview-based builder process (Phase 2.4 — DONE)
- `project.html` (project panel) already has a fully functional **Constitution tab** with file discovery, preview, editing, saving, builder invocation, watcher, and addon toggle (Phase 2 — DONE in project panel, not in a separate tuning.html)
- `PlanningPanelProvider.ts` already handles all constitution message types: `loadConstitutionFiles`, `readConstitutionFile`, `saveConstitutionFile`, `getConstitutionStatus`, `toggleConstitutionAddon`, `invokeConstitutionBuilder`, `invokeConstitutionUpdater`, `copyConstitutionPrompt`, `copyConstitutionUpdatePrompt`, `deleteConstitutionFile`, `setConstitutionPath`

**What remains genuinely new:**
1. The **Tuning tab** concept — reviewing completed plans and extracting adversarial insights
2. The **tuning skill** (`.agent/skills/tuning.md`)
3. A **new webview** to host the Tuning tab (or adding it to the existing project panel)
4. The `planner.constitutionEnabled` config setting is referenced in code but **missing from `package.json`** configuration schema

The proposed solution addresses the remaining gaps by:
1. Creating a dedicated tuning webview (or adding a Tuning tab to the existing project panel)
2. Providing a tuning workflow that leverages existing review data to improve governance
3. Adding the missing `planner.constitutionEnabled` config to `package.json`

## Metadata

**Complexity:** 5

**Tags:** ui, feature, docs

## User Review Required

**Yes** — The implementer must decide whether to:
- **Option A**: Add the Tuning tab to the existing `project.html` project panel (alongside Kanban Plans, Epics, Constitution), OR
- **Option B**: Create a separate `tuning.html` webview with both Constitution and Tuning tabs (duplicating constitution UI from project panel)

**Recommendation**: Option A is strongly preferred — it avoids code duplication, reuses the existing constitution infrastructure, and follows the established pattern of the project panel as the governance hub. The plan below is written for Option A but includes notes for Option B if the user prefers a separate panel.

## Complexity Audit

### Routine
- Adding a Tuning tab button to `project.html` shared-tab-bar (following existing Kanban/Epics/Constitution pattern)
- Adding `#tuning-content` div with prompt cards UI
- Adding message handlers for `invokeTuningSkill` in `PlanningPanelProvider.ts`
- Creating `.agent/skills/tuning.md` skill file
- Adding `switchboard.openTuning` command to `package.json` (only if Option B)
- Adding `planner.constitutionEnabled` boolean config to `package.json` (filling a gap in existing code)

### Complex / Risky
- Tuning skill logic for extracting meaningful patterns from adversarial review sections across multiple plan files — requires parsing markdown, identifying recurring themes, and generating actionable recommendations
- If Option B: Duplicating constitution UI in a new webview introduces maintenance burden and potential drift between two implementations of the same feature

## Proposed Changes

### Phase 1: Add Tuning Tab to Project Panel (Option A — Recommended)

> **Already implemented — skip:** Phases 2 (Constitution Tab), 4 (Constitution Prompt Injection), and 5.1 (Constitution message handlers) are **fully implemented** in the existing codebase:
> - Constitution tab UI in `project.html` (lines 1020-1022: shared-tab-bar with Constitution button)
> - Constitution file discovery, preview, editing, saving in `project.js`
> - All constitution message handlers in `PlanningPanelProvider.ts` (lines 2630-2905)
> - Constitution builder skill at `.agent/skills/constitution_builder.md`
> - Constitution prompt injection in `agentPromptBuilder.ts` (lines 530-533) and `KanbanProvider.ts` (lines 2558-2567)
> - Constitution file watcher in `PlanningPanelProvider.ts` (lines 851-905)
>
> If Option B is chosen (separate `tuning.html`), these phases would need to be re-implemented in the new webview — this is **not recommended** as it duplicates working code.

#### 1.1 Add Tuning Tab Button to Project Panel

**File**: `src/webview/project.html`

**Context**: The project panel already has a `shared-tab-bar` (line 1019) with three tabs: Kanban Plans, Epics, Constitution. Add a fourth tab.

**Logic**: Add a new `<button class="shared-tab-btn" data-tab="tuning">TUNING</button>` after the Constitution tab button (line 1022).

**Implementation**:
```html
<button class="shared-tab-btn active" data-tab="kanban">KANBAN PLANS</button>
<button class="shared-tab-btn" data-tab="epics">EPICS</button>
<button class="shared-tab-btn" data-tab="constitution">CONSTITUTION</button>
<button class="shared-tab-btn" data-tab="tuning">TUNING</button>
```

**Edge Cases**: Tab bar already has `overflow-x: auto` so additional tab won't break layout.

#### 1.2 Add Tuning Content Area

**File**: `src/webview/project.html`

**Context**: Each tab has a corresponding content div (e.g., `#kanban-content`, `#epics-content`, `#constitution-content`). Add `#tuning-content`.

**Logic**: Add a new content div with prompt cards layout, hidden by default (shown when tab is active).

**Implementation**:
```html
<div id="tuning-content" class="tab-panel" style="display: none;">
    <div class="tuning-cards-container">
        <!-- Prompt cards populated by project.js -->
    </div>
</div>
```

Add CSS for tuning cards (reuse `.planning-card` pattern from `planning.html` lines 419-530):
```css
.tuning-cards-container {
    padding: 16px;
    overflow-y: auto;
    flex: 1;
}
.tuning-card {
    border: var(--card-border);
    border-radius: 6px;
    padding: 16px;
    background: var(--card-bg);
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-shadow: var(--shadow-md);
    margin-bottom: 16px;
}
```

**Edge Cases**: Ensure tab switching logic in `project.js` handles the new `tuning` tab name.

#### 1.3 Add Tuning Tab Logic to project.js

**File**: `src/webview/project.js`

**Context**: `project.js` handles tab switching via `data-tab` attributes and message passing to `PlanningPanelProvider`.

**Logic**:
- Add tab switch handler for `tuning` tab (follow existing pattern for `kanban`/`epics`/`constitution`)
- On tab activation, send `{ type: 'loadTuningPrompts' }` message to extension
- Render prompt cards in `#tuning-content`
- On "Start Conversation" click, send `{ type: 'invokeTuningSkill', promptId: '...', params: {...} }` message

**Edge Cases**: Handle empty state when no plans exist in `.switchboard/plans/`.

### Phase 2: Tuning Skill

#### 2.1 Create tuning.md Skill File

**File**: `.agent/skills/tuning.md` (new file)

**Content**:
- Skill that reviews completed plans and extracts insights
- Capabilities:
  - Read plans from `.switchboard/plans/`
  - Filter by status (Done) or date range
  - Extract adversarial review notes (Grumpy sections — look for `## Adversarial Synthesis` or `### Stage 1` or `Grumpy` in plan files)
  - Identify recurring patterns across plans
  - Generate recommendations for AGENTS.md or CONSTITUTION.md
- Output format:
  - Summary of findings (recurring issues, frequency, severity)
  - Specific recommendations with plan references
  - Proposed edits (diff-style or direct suggestions for AGENTS.md/CONSTITUTION.md)

**Implementation detail (Clarification)**: The skill should use `grep_search` or `read_file` to scan plan files for `## Adversarial Synthesis` sections, extract the risk summaries, and cluster them by theme (e.g., race conditions, missing error handling, validation gaps).

### Phase 3: Tuning Message Handlers

#### 3.1 Add Tuning Handlers to PlanningPanelProvider

**File**: `src/services/PlanningPanelProvider.ts`

**Context**: `PlanningPanelProvider` already handles all constitution messages (lines 2630-2905). Add tuning handlers in the same `_handleMessage` switch statement.

**Logic**: Add cases for:
- `loadTuningPrompts` — returns list of available tuning prompt cards
- `invokeTuningSkill` — dispatches tuning skill to an agent terminal (follow `invokeConstitutionBuilder` pattern at lines 2830-2841)

**Implementation**:
```typescript
case 'invokeTuningSkill': {
    const promptId = msg.promptId;
    const params = msg.params || {};
    const promptText = buildTuningPrompt(promptId, params, workspaceRoot);
    // Reuse terminal dispatch pattern from invokeConstitutionBuilder
    const terminal = /* find or create terminal */;
    await sendRobustText(terminal, promptText);
    break;
}
```

**Edge Cases**: Handle case where no plans directory exists or no completed plans are found.

### Phase 4: Add Missing `planner.constitutionEnabled` Config

#### 4.1 Add Config to package.json

**File**: `package.json`

**Context**: `KanbanProvider.ts` (line 2774) and `PlanningPanelProvider.ts` (line 2657) both reference `config.get<boolean>('planner.constitutionEnabled', false)` but this setting is **not defined** in `package.json` contributes.configuration.properties. It works (defaults to `false`) but is invisible to users in VS Code settings UI.

**Logic**: Add the missing config property alongside existing planner settings (after `planner.designSystemDocLink` at line 319).

**Implementation**:
```json
"switchboard.planner.constitutionEnabled": {
    "type": "boolean",
    "default": false,
    "description": "When enabled, injects the project's CONSTITUTION.md content into all planner prompts as inviolate rules and invariants.",
    "scope": "resource"
}
```

**Edge Cases**: None — this is a gap fill, not new functionality. Existing code already reads this setting; it just wasn't visible in the config schema.

### Phase 5: Command Registration (Only if Option B — Separate Webview)

> **Skip if Option A** (recommended). The Tuning tab is accessible via the existing `switchboard.openProjectPanel` command.

#### 5.1 Register openTuning Command

**File**: `package.json` (commands array) and `src/extension.ts`

**Changes**:
- Add command `switchboard.openTuning` to `package.json` commands array
- Register command in `extension.ts` following the `openProjectPanel` pattern (lines 816-820)
- Create `TuningPanelProvider` class or extend `PlanningPanelProvider`

## Edge-Case & Dependency Audit

**Race Conditions**:
- Tuning skill reads plan files while an agent may be simultaneously writing to them — use read-only file access and handle `ENOENT` gracefully
- Constitution file watcher in `PlanningPanelProvider` (lines 851-905) already debounces file change events; tuning tab should not add additional watchers that could conflict

**Security**:
- Constitution content is injected into planner prompts — if constitution contains malicious prompt injection text, it could manipulate agent behavior. Mitigation: constitution is authored by the project owner, same trust level as AGENTS.md
- Tuning skill reads plan files from `.switchboard/plans/` — no path traversal risk since it reads from a fixed directory

**Side Effects**:
- Adding `planner.constitutionEnabled` to `package.json` makes the setting visible in VS Code settings UI — users who previously relied on the `false` default may now explicitly enable it, changing planner prompt behavior
- Tuning skill dispatches to an agent terminal — reuses existing `sendRobustText` pattern, no new side effects

**Dependencies & Conflicts**:
- Tuning tab depends on existing `project.html`/`project.js` tab infrastructure — no new dependencies
- Tuning skill depends on plan files existing in `.switchboard/plans/` with `## Adversarial Synthesis` sections — plans without these sections are silently skipped
- `planner.constitutionEnabled` config has no conflicts — it's a gap fill for code that already reads this setting
- No new npm dependencies required

## Dependencies

- `src/services/PlanningPanelProvider.ts` — existing constitution message handlers and tab infrastructure
- `src/webview/project.html` — existing shared-tab-bar pattern
- `src/webview/project.js` — existing tab switching logic
- `src/services/agentPromptBuilder.ts` — existing constitution prompt injection (no changes needed)
- `src/services/KanbanProvider.ts` — existing `_resolveConstitution()` (no changes needed)
- `src/services/constitutionUtils.ts` — existing `getConstitutionPath()` (no changes needed)
- `.agent/skills/constitution_builder.md` — existing skill (no changes needed)
- `package.json` — add missing config property

## Adversarial Synthesis

Key risks: (1) Plan duplicates already-implemented constitution infrastructure — Option A eliminates this risk by reusing the project panel. (2) Tuning skill pattern extraction may produce low-quality recommendations if plan files lack structured adversarial sections. (3) Missing `planner.constitutionEnabled` config is a latent bug — users can't discover or toggle the feature from settings UI. Mitigations: Option A recommended; tuning skill should gracefully handle plans without adversarial sections; config gap fill is trivial and safe.

## Verification Plan

### Automated Tests

> **SKIP COMPILATION** and **SKIP TESTS** per session directives. The following tests are defined for reference but will be run separately by the user.

**Unit tests** (to be written):
- Test that `project.html` renders 4 tab buttons when loaded
- Test that `#tuning-content` div exists and is hidden by default
- Test that tab switching to `tuning` shows `#tuning-content` and hides others
- Test that `invokeTuningSkill` message handler dispatches to terminal with correct prompt text
- Test that `planner.constitutionEnabled` config is present in `package.json` schema

**Integration tests** (to be written):
- Test that opening project panel shows Tuning tab
- Test that clicking Tuning tab loads prompt cards
- Test that clicking "Start Conversation" on a tuning card dispatches to an agent terminal
- Test that tuning skill reads plans from `.switchboard/plans/` and extracts adversarial sections

**Manual verification checklist**:
- [ ] Project panel opens with 4 tabs: Kanban Plans, Epics, Constitution, Tuning
- [ ] Tuning tab shows prompt cards when activated
- [ ] Tuning skill dispatches to agent terminal with correct prompt
- [ ] `planner.constitutionEnabled` appears in VS Code settings UI under Switchboard
- [ ] Existing Constitution tab functionality is unaffected by the new Tuning tab
- [ ] Tab switching between all 4 tabs works correctly
- [ ] Tuning tab handles empty plans directory gracefully

## Remaining Risks

1. **Constitution location ambiguity**: If both workspace and control plane have constitutions, need clear precedence rules — **already mitigated** by `constitutionUtils.getConstitutionPath()` which checks globalState for custom paths before falling back to `CONSTITUTION.md` at workspace root
2. **Tuning skill complexity**: Extracting meaningful patterns from adversarial reviews may require iterative refinement — start with simple grep-based extraction and improve over time
3. **Prompt token budget**: Constitution content adds to prompt size — **already mitigated** by `agentConfig.ts` (line 211) which truncates content >50,000 chars
4. **Constitution builder interview quality**: The skill needs good question design — **already addressed** by existing `constitution_builder.md` skill with structured interview process
5. **Tab bar overflow**: Adding a 4th tab may cause horizontal overflow on narrow screens — **already mitigated** by `overflow-x: auto` on `.shared-tab-bar` (line 538)

---

**Recommendation**: Complexity 5 → **Send to Coder**
