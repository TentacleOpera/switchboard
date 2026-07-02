# Rename prompt-builder option "Design Doc Reference" to "Project PRD Reference"

## Goal

### Problem
In the prompt builder (planner role-addon configuration), the option labelled **"Design Doc Reference"** should be renamed to **"Project PRD Reference"**. The current label is misleading — it does not communicate that this add-on surfaces a product requirements document for the project.

### Background
The planner role has an add-on with id `designSystemDoc` and display label `"Design Doc Reference"`. This add-on is defined in `sharedDefaults.js` (the single source of truth for role-addon UI metadata) and rendered in `kanban.html`. The Design panel (`design.js` / `DesignPanelProvider.ts`) activates this add-on when a doc is marked as the active design-system doc, and contains comments referencing the old label.

### Root Cause
This is a labelling problem, not a logic bug. The add-on id (`designSystemDoc`) and all config keys (`planner.designSystemDocEnabled`, `planner.designSystemDocLink`) must remain unchanged to avoid a migration for the ~4,000 installed user base — only the **display label** and accompanying comments/docs change.

## Metadata
- **Tags**: `prompt-builder`, `planner`, `label`, `ux`, `no-migration`
- **Complexity**: 1/10

## Complexity Audit
**Routine.** A pure string rename in two source files plus comment/doc updates. No logic, no schema, no state. The addon id and config keys are untouched, so no user migration is required. The only risk is missing a label occurrence; the audit below enumerates all of them.

## Edge-Case & Dependency Audit
- **Config-key stability**: The VS Code settings `planner.designSystemDocEnabled` and `planner.designSystemDocLink` are keyed on the id `designSystemDoc`, NOT the label. Renaming the label does not touch these keys. No migration.
- **roleConfig persistence**: Per-role addon state is stored by id (`designSystemDoc`) in the kanban DB / role config. Renaming the label does not affect stored state.
- **Design panel activation**: `design.js` activates the add-on by setting `config.addons.designSystemDoc = true` — keyed on id, not label. Unaffected.
- **All label occurrences** (from grep):
  - `src/webview/sharedDefaults.js:63` — the canonical label definition (UI source of truth).
  - `src/webview/kanban.html:2915` — a hardcoded `<span>` label (must match sharedDefaults).
  - `src/webview/design.js:1086` — a code comment.
  - `src/services/DesignPanelProvider.ts:1011` — a code comment.
  - `docs/switchboard_user_manual.md:1226` — user-facing documentation.
- **Tooltip**: The tooltip "Include design system doc as context" should also be updated to reflect the new label.

## Proposed Changes

### 1. `src/webview/sharedDefaults.js` (line 63) — canonical label + tooltip
```js
// BEFORE
{ id: 'designSystemDoc', label: 'Design Doc Reference', tooltip: 'Include design system doc as context', default: false },

// AFTER
{ id: 'designSystemDoc', label: 'Project PRD Reference', tooltip: 'Include project PRD as context for planning', default: false },
```

### 2. `src/webview/kanban.html` (line 2915) — hardcoded span label
```html
<!-- BEFORE -->
<span>Design Doc Reference</span>

<!-- AFTER -->
<span>Project PRD Reference</span>
```

### 3. `src/webview/design.js` (line 1086) — comment update
```js
// BEFORE
// Activates the kanban "Design Doc Reference" add-on with this doc

// AFTER
// Activates the kanban "Project PRD Reference" add-on with this doc
```

### 4. `src/services/DesignPanelProvider.ts` (line 1011) — comment update
```ts
// BEFORE
// The kanban "Design Doc Reference" planner add-on (roleConfig_planner.addons.designSystemDoc)

// AFTER
// The kanban "Project PRD Reference" planner add-on (roleConfig_planner.addons.designSystemDoc)
```

### 5. `docs/switchboard_user_manual.md` (line 1226) — doc update
Update any user-facing reference from "Design Doc Reference" to "Project PRD Reference".

## Verification Plan
1. **Manual**: Open the Kanban board → planner role-addon configuration. Confirm the add-on now displays as **"Project PRD Reference"** with the updated tooltip.
2. **Manual**: Toggle the add-on on, dispatch a planner prompt, and confirm the design-system-doc link is still injected (logic unchanged — only the label moved).
3. **Manual**: From the Design panel, mark a doc as the active design-system doc. Confirm the add-on is auto-activated in the planner config (id-based activation unaffected).
4. **Grep**: Run a case-insensitive search for "Design Doc Reference" across `src/` and `docs/` — confirm zero remaining occurrences in user-facing strings (comments should all be updated).
