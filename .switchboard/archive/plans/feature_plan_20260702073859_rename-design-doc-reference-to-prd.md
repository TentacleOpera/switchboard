# Rename prompt-builder option "Design Doc Reference" to "Project PRD Reference"

**Plan ID:** 799b1213-b96b-43d4-908d-5ee9bdb76127

## Goal

Rename the planner role-addon display label from **"Design Doc Reference"** to **"Project PRD Reference"** across every user-facing surface, so the option clearly communicates that it surfaces a product requirements document for the project.

### Problem
In the prompt builder (planner role-addon configuration), the option labelled **"Design Doc Reference"** should be renamed to **"Project PRD Reference"**. The current label is misleading — it does not communicate that this add-on surfaces a product requirements document for the project.

### Background
The planner role has an add-on with id `designSystemDoc` and display label `"Design Doc Reference"`. This add-on is defined in `sharedDefaults.js` (the single source of truth for role-addon UI metadata) and rendered in `kanban.html`. The Design panel (`design.js` / `DesignPanelProvider.ts`) activates this add-on when a doc is marked as the active design-system doc, and contains comments referencing the old label. The add-on's link/content is injected into agent prompts by `agentPromptBuilder.ts` under a `DESIGN SYSTEM DOC REFERENCE` heading.

### Root Cause
This is a labelling problem, not a logic bug. The add-on id (`designSystemDoc`) and all config keys (`planner.designSystemDocEnabled`, `planner.designSystemDocLink`) must remain unchanged to avoid a migration for the ~4,000 installed user base — only the **display label**, **tooltips**, **title attributes**, **prompt headings**, and accompanying comments/docs change.

## Metadata
- **Tags:** `ux`, `refactor`
- **Complexity:** 2/10

## User Review Required
- **Prompt-heading rename scope:** The agent prompt heading `DESIGN SYSTEM DOC REFERENCE` (in `agentPromptBuilder.ts`) is user-visible in prompt previews and in prompts sent to agents. Renaming it to `PROJECT PRD REFERENCE` keeps the UI label and the prompt heading consistent. **Confirm this is desired** — if any downstream tooling or tests assert on the literal string `DESIGN SYSTEM DOC REFERENCE`, those must be updated in the same pass. Default recommendation: rename for consistency.

## Complexity Audit

### Routine
- Pure string/label swaps across 7 user-facing sites + 2 code comments + 1 doc line.
- No logic, no schema, no state, no config-key changes.
- Add-on id `designSystemDoc` and config keys untouched → no user migration.
- All occurrences enumerated via case-insensitive grep (verified).

### Complex / Risky
- None. The only coordination risk is missing a string site; the audit below enumerates every one.

## Edge-Case & Dependency Audit
- **Race Conditions:** None. Static string changes; no async/state flow touched.
- **Security:** None. No input handling, no auth, no secrets.
- **Side Effects:** None beyond label text. Add-on activation (`config.addons.designSystemDoc = true`) is id-keyed and unaffected.
- **Dependencies & Conflicts:**
  - **Config-key stability**: VS Code settings `planner.designSystemDocEnabled` and `planner.designSystemDocLink` are keyed on the id `designSystemDoc`, NOT the label. Renaming the label does not touch these keys. No migration.
  - **roleConfig persistence**: Per-role addon state is stored by id (`designSystemDoc`) in the kanban DB / role config. Renaming the label does not affect stored state.
  - **Design panel activation**: `design.js` activates the add-on by setting `config.addons.designSystemDoc = true` — keyed on id, not label. Unaffected.
  - **Prompt-heading consumers**: `agentPromptBuilder.ts` injects `DESIGN SYSTEM DOC REFERENCE` headings into planner (lines 817, 822), tester, and custom-agent (lines 1399, 1401) prompts. If renamed, any test asserting on this literal string must be updated in the same change.

## Dependencies
- None.

## Adversarial Synthesis
Key risks: (1) the original plan enumerated only 5 of 8 user-facing string sites — it missed the `kanban.html` title attribute (line 2913), the `kanban.html` tooltip span (line 2916), and the `agentPromptBuilder.ts` prompt headings (4 occurrences); (2) line-number drift on `design.js` (comment is at line 1088, not 1086). Mitigations: re-grep after edits to confirm zero remaining occurrences; treat the prompt-heading rename as in-scope pending the User Review confirmation above.

## Proposed Changes

### 1. `src/webview/sharedDefaults.js` (line 63) — canonical label + tooltip
```js
// BEFORE
{ id: 'designSystemDoc', label: 'Design Doc Reference', tooltip: 'Include design system doc as context', default: false },

// AFTER
{ id: 'designSystemDoc', label: 'Project PRD Reference', tooltip: 'Include project PRD as context for planning', default: false },
```
- **Context:** Single source of truth for role-addon UI metadata.
- **Logic:** Label + tooltip strings only; id and default unchanged.
- **Implementation:** Edit line 63 in place.
- **Edge Cases:** None — JS-injected metadata; kanban.html static twins must match (see change #2).

### 2. `src/webview/kanban.html` (lines 2913–2916) — hardcoded label, title, and tooltip
```html
<!-- BEFORE -->
<label class="checkbox-item" title="Append design system doc as context for planning">
  <input type="checkbox" id="plannerAddonDesignSystemDoc">
  <span>Design Doc Reference</span>
  <span class="tooltip">Include design system doc as context</span>
</label>

<!-- AFTER -->
<label class="checkbox-item" title="Append project PRD as context for planning">
  <input type="checkbox" id="plannerAddonDesignSystemDoc">
  <span>Project PRD Reference</span>
  <span class="tooltip">Include project PRD as context for planning</span>
</label>
```
- **Context:** Static webview markup that mirrors `sharedDefaults.js`. The `id="plannerAddonDesignSystemDoc"` is id-keyed and MUST NOT change.
- **Logic:** Three string edits: `title` attribute (2913), `<span>` label (2915), tooltip `<span>` (2916).
- **Implementation:** Edit lines 2913, 2915, 2916.
- **Edge Cases:** The `title` attribute and tooltip span were missed by the original plan; both are user-visible on hover.

### 3. `src/webview/design.js` (line 1088) — comment update
```js
// BEFORE
// Activates the kanban "Design Doc Reference" add-on with this doc

// AFTER
// Activates the kanban "Project PRD Reference" add-on with this doc
```
- **Context:** Code comment inside the "Set Context" click handler.
- **Logic:** Comment text only; no behaviour change.
- **Implementation:** Edit line 1088. (Original plan cited line 1086 — corrected to 1088.)

### 4. `src/services/DesignPanelProvider.ts` (line 1011) — comment update
```ts
// BEFORE
// The kanban "Design Doc Reference" planner add-on (roleConfig_planner.addons.designSystemDoc)

// AFTER
// The kanban "Project PRD Reference" planner add-on (roleConfig_planner.addons.designSystemDoc)
```
- **Context:** Comment above `_setPlannerDesignSystemAddon`.
- **Logic:** Comment text only; id reference `designSystemDoc` preserved.
- **Implementation:** Edit line 1011.

### 5. `src/services/agentPromptBuilder.ts` (lines 817, 822, 1399, 1401) — prompt heading rename
> **Scope note:** Apply this change only after the User Review confirmation above. If the user declines, skip this section and leave prompt headings as `DESIGN SYSTEM DOC REFERENCE` (UI label and prompt heading will then intentionally diverge).

```ts
// BEFORE (line 817, planner — link variant)
plannerPrompt += `\n\nDESIGN SYSTEM DOC REFERENCE:\nThe following design system document provides the project's visual and interaction design specifications. Use it as context for implementation decisions:\n${designSystemDocLink}`;

// AFTER (line 817)
plannerPrompt += `\n\nPROJECT PRD REFERENCE:\nThe following project PRD provides the product requirements and design specifications. Use it as context for implementation decisions:\n${designSystemDocLink}`;
```
```ts
// BEFORE (line 822, planner — pre-fetched content variant)
plannerPrompt += `\n\nDESIGN SYSTEM DOC REFERENCE (pre-fetched):\nThe following is the full content of the project's design system document. Use it as context for implementation decisions:\n\n${designSystemDocContent}`;

// AFTER (line 822)
plannerPrompt += `\n\nPROJECT PRD REFERENCE (pre-fetched):\nThe following is the full content of the project's PRD. Use it as context for implementation decisions:\n\n${designSystemDocContent}`;
```
```ts
// BEFORE (line 1399, custom agent — pre-fetched)
prompt += `\n\nDESIGN SYSTEM DOC REFERENCE (pre-fetched):\n${addons.designSystemDocContent}`;

// AFTER (line 1399)
prompt += `\n\nPROJECT PRD REFERENCE (pre-fetched):\n${addons.designSystemDocContent}`;
```
```ts
// BEFORE (line 1401, custom agent — link)
prompt += `\n\nDESIGN SYSTEM DOC REFERENCE:\n${addons.designSystemDocLink}`;

// AFTER (line 1401)
prompt += `\n\nPROJECT PRD REFERENCE:\n${addons.designSystemDocLink}`;
```
- **Context:** Headings injected into planner, tester, and custom-agent prompts. User-visible in prompt previews.
- **Logic:** Heading text + descriptive sentence only; variable names (`designSystemDocLink`, `designSystemDocContent`) and addon id unchanged.
- **Implementation:** Edit lines 817, 822, 1399, 1401.
- **Edge Cases:** Any test asserting on the literal `DESIGN SYSTEM DOC REFERENCE` string must be updated in the same pass. Grep `src/test/` for that literal before/after editing.

### 6. `docs/switchboard_user_manual.md` (line 1226) — doc update
```markdown
<!-- BEFORE -->
  - **Add-ons** — Switchboard Safeguards, Planning Epic Reference, Project Constitution Reference, Design Doc Reference, Aggressive Pair Programming, Git Prohibition, Clear Antigravity Context, Caveman Output, Skip Compilation, Skip Tests.

<!-- AFTER -->
  - **Add-ons** — Switchboard Safeguards, Planning Epic Reference, Project Constitution Reference, Project PRD Reference, Aggressive Pair Programming, Git Prohibition, Clear Antigravity Context, Caveman Output, Skip Compilation, Skip Tests.
```
- **Context:** User-manual add-on list.
- **Logic:** Single label swap in the comma-separated list.
- **Implementation:** Edit line 1226.

## Verification Plan

### Automated Tests
- **Skipped per session directive.** The test suite will be run separately by the user. If prompt-heading rename (change #5) is applied, ensure `src/test/` assertions referencing `DESIGN SYSTEM DOC REFERENCE` are updated before running.

### Manual Verification
1. **UI label + tooltip:** Open the Kanban board → planner role-addon configuration. Confirm the add-on displays as **"Project PRD Reference"** with tooltip **"Include project PRD as context for planning"**. Hover the checkbox to confirm the `title` attribute also reads "Append project PRD as context for planning".
2. **Toggle + dispatch:** Toggle the add-on on, dispatch a planner prompt, and confirm the PRD link is still injected (logic unchanged — only the label/heading moved). If change #5 applied, confirm the prompt section is headed `PROJECT PRD REFERENCE`.
3. **Design panel activation:** From the Design panel, mark a doc as the active design-system doc. Confirm the add-on is auto-activated in the planner config (id-based activation unaffected).
4. **Grep sweep:** Run a case-insensitive search for "Design Doc Reference" across `src/` and `docs/` — confirm zero remaining occurrences in user-facing strings (comments should all be updated). Also grep for "DESIGN SYSTEM DOC REFERENCE" in `src/` to confirm prompt headings were updated (if change #5 applied).
5. **Test grep:** Grep `src/test/` for `DESIGN SYSTEM DOC REFERENCE` and `Design Doc Reference` — update any assertions to match the new strings before running the suite.

## Recommendation
Complexity 2/10 → **Send to Intern**. Pure string swaps, fully enumerated, no logic risk.

## Review Findings
Reviewed implementation in the main repo (`/Users/patrickvuleta/Documents/GitHub/switchboard`). All 6 plan changes verified applied: `sharedDefaults.js:63` (label+tooltip), `kanban.html:2915-2918` (title+span+tooltip), `design.js:1088` (comment), `DesignPanelProvider.ts:1027` (comment), `agentPromptBuilder.ts:824,829,1412,1414` (4 prompt headings), `switchboard_user_manual.md:1226` (doc list). Grep sweep confirms zero remaining "Design Doc Reference" / "DESIGN SYSTEM DOC REFERENCE" occurrences in `src/` or `docs/`; `designSystemDoc` id preserved (127 refs); no test assertions reference old or new strings. No CRITICAL/MAJOR findings — no code fixes needed. No regressions: pure string swaps, no async/state/signature changes. Compilation and tests skipped per session directives. Remaining risk: none material; the `kanban.html` title attribute uses "Append" vs tooltip "Include" (plan-specified divergence, cosmetic only).
