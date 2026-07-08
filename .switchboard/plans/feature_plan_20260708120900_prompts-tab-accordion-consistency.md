# Feature Plan: Prompts Tab Accordion Consistency — Subagent Policy & Git Safety Guardrail

## Goal

### Problem
The Prompts Tab in `kanban.html` has inconsistent section organisation. The **Git Strategy** radio group (Branch/Commit/Push) for non-planner roles is rendered as a collapsible accordion via the `group: 'git'` property and the `<details class="addon-subsection-accordion">` pattern. However, the **Subagent Policy** radio group — which is equally complex (4 options + a custom text input) — is rendered as a flat, always-expanded radio group with no collapse mechanism. The user reports this as "completely random and shitty organisation" because visually related multi-option sections are treated differently for no functional reason.

### Background
- The Prompts Tab lives at lines 2906–3130 of `src/webview/kanban.html`.
- For **non-planner roles**, add-ons are rendered dynamically by JS (`renderRoleAddons()` partition + build at lines 3635–3687). Add-ons with a `group` property become accordion sections; those without stay flat.
- For the **planner role**, add-ons are hardcoded HTML (lines 2932–3060) — no dynamic rendering, no accordion support at all.
- The accordion CSS is at lines 2412–2433 (`.addon-subsection-accordion`), using native `<details>`/`<summary>` with a rotating `▸` arrow.
- Only `gitBranchStrategy`, `gitCommitStrategy`, and `gitPushStrategy` in `sharedDefaults.js` (lines 64–84) have `group: 'git'`.

### Root Cause
1. **Non-planner roles**: the `subagentPolicy` radio descriptor is **duplicated inline across all ten roles** in `sharedDefaults.js` — planner (lines 98–103), lead (120–125), coder (143–148), reviewer (162–167), tester (175–180), intern (197–202), analyst (211–216), ticket_updater (224–229), researcher (237–242), claude_designer (255–260). **None** carry a `group` property, so the dynamic renderer treats each as a general (flat) add-on. Note: the planner descriptor (98–103) is **not** consumed by the dynamic renderer at all (the planner UI is hardcoded HTML — see #2), so editing it alone has zero UI effect.
2. **Planner role**: The Subagent Policy section (lines 3038–3057) is hardcoded HTML with no `<details>` wrapper — it cannot collapse.

## Metadata

- **Tags:** frontend, ui, ux, refactor
- **Complexity:** 4

## User Review Required

Yes — confirm before coding:
- (a) Subagent Policy should be **collapsed by default** (matching Git Strategy), not open.
- (b) The accordion header should read **"Subagent Policy"** (via the `prettyGroupLabel` mapping).
- (c) Optional discoverability question: if a non-default Subagent Policy value is persisted in `roleConfig`, should the accordion auto-open to surface it, or stay collapsed for consistency? Default decision: stay collapsed (consistency) unless the user says otherwise.

## Complexity Audit

### Routine
- Adding `group: 'subagent'` to the `subagentPolicy` addon descriptor in `sharedDefaults.js` for **all** dynamically-rendered (non-planner) roles — the existing JS renderer at lines 3663–3686 will automatically wrap it in an accordion. The descriptor is duplicated inline across 10 roles (see Root Cause #1); the change must reach all of them, or be made once via a shared constant.
- Adding a `prettyGroupLabel` mapping for `'subagent'` → `'Subagent Policy'` in the JS at line ~3658.
- Wrapping the planner Subagent Policy HTML block (lines 3038–3057) in a `<details class="addon-subsection-accordion">` + `<summary>` element.

### Complex / Risky
- Ensuring the `textInputOn: 'customSubagent'` custom text input still shows/hides correctly when nested inside a `<details>` body for the planner role. The show/hide JS (listener on the radio) must still find the input by ID — this should work since IDs are unchanged, but must be verified.

## Edge-Case & Dependency Audit

### Race Conditions
- None. Accordion open/close is a pure CSS/HTML native interaction with no async state.

### Security
- None.

### Side Effects
- Collapsing Subagent Policy by default means users must expand it to change the setting. This is consistent with Git Strategy behaviour. The `<details>` element preserves its open/closed state per session via browser default (closed on render unless `open` attribute is set).

### Dependencies & Conflicts
- The dynamic renderer's `prettyGroupLabel()` function (line ~3658) only special-cases `'git'`. A new `'subagent'` group needs a label mapping or it will render as "Subagent" (capitalised first letter) — acceptable but "Subagent Policy" is clearer.
- The planner hardcoded HTML must use the same CSS classes (`addon-subsection-accordion`, `addon-subsection-header`, `addon-subsection-body`) to match styling.

## Dependencies

- None — self-contained frontend change to `src/webview/sharedDefaults.js` and `src/webview/kanban.html`. No backend, no data migration, no other plan must land first. Independent of the sibling animation subtask (disjoint `kanban.html` regions).

## Adversarial Synthesis

Key risks: (1) the original draft edited only the planner `subagentPolicy` descriptor (line 98), which the dynamic renderer never reads — the accordion would not appear for any non-planner role unless `group: 'subagent'` reaches all nine non-planner descriptors (best via a shared `SUBAGENT_POLICY_RADIO` constant); (2) collapsing Subagent Policy by default could bury a safety-relevant setting if a non-default value is persisted in `roleConfig`. Mitigations: extract/reuse a shared `SUBAGENT_POLICY_RADIO` constant with `group: 'subagent'` referenced by all roles (single source of truth, kills the 10× duplication); verify the custom-text show/hide still works inside `<details>` (IDs unchanged → expected to pass); confirm the default renders as "Not Specified" and decide the discoverability policy in User Review Required. `group` is UI-only metadata — it cannot affect prompt output or the `useSubagentsByRole`/`noSubagentsByRole` derivations.

## Proposed Changes

---

### 1. `src/webview/sharedDefaults.js` — Add `group: 'subagent'` to subagentPolicy (all roles)

**Context (corrected)**: The `subagentPolicy` radio descriptor is duplicated **inline across all ten roles** — planner (98–103), lead (120–125), coder (143–148), reviewer (162–167), tester (175–180), intern (197–202), analyst (211–216), ticket_updater (224–229), researcher (237–242), claude_designer (255–260). None carry `group`. The dynamic renderer (`renderRoleAddons`, 3635–3687) only runs for **non-planner** roles, so the accordion goal is met only if `group: 'subagent'` is present on the **nine non-planner** descriptors. Editing only the planner descriptor (98–103) — as the original draft of this step did — has **zero UI effect** (planner UI is hardcoded HTML). Adding the tag to the planner descriptor too is harmless and keeps the data model consistent.

**Recommended implementation — extract a shared constant (mirrors `GIT_*_RADIO` at lines 64–84), one source of truth:**
```js
// Add near the GIT_*_RADIO constants (after line 84):
const SUBAGENT_POLICY_RADIO = {
    id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning',
    type: 'radio', group: 'subagent', default: 'default', options: [
        { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
        { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
        { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
        { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
    ]
};
// Then replace every inline { id: 'subagentPolicy', ... } block with: SUBAGENT_POLICY_RADIO,
```
This collapses 10 × ~6-line duplicates into one constant and makes the `group` addition a single edit. Export it if a test ever needs to reference it (none do today — see Verification).

**Alternative implementation — inline per-descriptor edit (if a refactor is out of scope):**
Add `group: 'subagent'` to all ten inline descriptors. Each has the identical opening line:
```js
// BEFORE (each of the 10 occurrences — lines 98, 120, 143, 162, 175, 197, 211, 224, 237, 255):
{ id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', options: [

// AFTER:
{ id: 'subagentPolicy', label: 'Subagent Policy', tooltip: 'Control how the agent handles subagent spawning', type: 'radio', group: 'subagent', options: [
```
⚠️ A `replace_all` of that exact opening line is safe — all 10 are byte-identical up to the `options: [` token, and no other addon shares that prefix. Verify the count is 10 after replacement.

**Safety note**: `group` is a UI-rendering hint consumed **only** by `kanban.html`'s renderer (the `addons.filter(a => !a.group)` / `a.group` partition at 3636/3640). The prompt builder (`agentPromptBuilder.ts` 1507–1510) and `KanbanProvider.ts` (4643–4673) read the **selected value** (`addons.subagentPolicy === 'noSubagents'` etc.), never the `group` metadata. Adding `group` cannot change prompt output or the `useSubagentsByRole`/`noSubagentsByRole`/`customSubagentNameByRole` derivations.

---

### 2. `src/webview/kanban.html` — Add `prettyGroupLabel` mapping for 'subagent'

**Context**: Line ~3658, the `prettyGroupLabel` helper only maps `'git'` → `'Git Strategy'`.

**Implementation**:
```js
// BEFORE:
function prettyGroupLabel(g) {
    if (g === 'git') return 'Git Strategy';
    return g.charAt(0).toUpperCase() + g.slice(1);
}

// AFTER:
function prettyGroupLabel(g) {
    if (g === 'git') return 'Git Strategy';
    if (g === 'subagent') return 'Subagent Policy';
    return g.charAt(0).toUpperCase() + g.slice(1);
}
```

---

### 3. `src/webview/kanban.html` — Wrap planner Subagent Policy in accordion

**Context**: Lines 3038–3057 contain the planner's hardcoded Subagent Policy radio group. Wrap the entire `<div class="addon-radio-group">` in a `<details>` accordion.

**Implementation**:
```html
<!-- BEFORE (line 3038): -->
<div class="addon-radio-group" style="margin-top:8px;">
  <span class="addon-label" style="font-weight:600;margin-bottom:4px;display:block;">Subagent Policy</span>
  ... radio labels ...
</div>

<!-- AFTER: -->
<details class="addon-subsection-accordion">
  <summary class="addon-subsection-header">Subagent Policy</summary>
  <div class="addon-subsection-body" style="display:flex;flex-direction:column;gap:8px;padding:8px 12px;">
    <!-- radio labels (remove the now-redundant span.addon-label header) -->
    <label class="checkbox-item" title="Let the execution platform decide subagent behavior">
      <input type="radio" name="plannerSubagentPolicy" value="default" checked>
      <span>Not Specified</span>
    </label>
    <label class="checkbox-item" title="Explicitly instruct the agent not to spawn or invoke any subagents">
      <input type="radio" name="plannerSubagentPolicy" value="noSubagents">
      <span>No Subagents</span>
    </label>
    <label class="checkbox-item" title="Instruct the agent to use parallel subagents when handling multiple plans">
      <input type="radio" name="plannerSubagentPolicy" value="useSubagents">
      <span>Yes (Use Subagents)</span>
    </label>
    <label class="checkbox-item" title="Instruct the agent to use a specific custom subagent" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
      <input type="radio" name="plannerSubagentPolicy" value="customSubagent">
      <span>Custom Subagent</span>
      <input id="plannerAddonCustomSubagentName" type="text" placeholder="Custom subagent name..." style="margin-left:8px;padding:2px 6px;border-radius:4px;border:1px solid var(--vscode-input-border, #ccc);background:var(--vscode-input-background, #fff);color:var(--vscode-input-foreground, #000);display:none;font-size:11px;width:150px;">
    </label>
  </div>
</details>
```

**Note**: Remove the `<span class="addon-label">Subagent Policy</span>` header line since the `<summary>` now serves as the header.

---

### 4. `dist/webview/kanban.html` (release-only — NOT a dev step)

Per project rules, `dist/` is NOT used during development or testing — `src/` is the source of truth and the webview is served from source during dev. `dist/webview/kanban.html` is regenerated by `npm run compile` only when producing a release VSIX. Do NOT manually edit it, and do NOT run a build as part of dev verification (this session skips compilation).

## Verification Plan

### Manual Verification
- [ ] Open the Prompts Tab, select a non-planner role (e.g. coder) — Subagent Policy appears as a collapsed accordion with "Subagent Policy" header and `▸` arrow
- [ ] Repeat for each non-planner role that carries `subagentPolicy` (lead, coder, reviewer, tester, intern, analyst, ticket_updater, researcher, claude_designer) — all show the accordion (confirms the group tag reached every descriptor)
- [ ] Click the accordion — it expands to show the 4 radio options + custom text input
- [ ] Select "Custom Subagent" — the text input appears (show/hide still works inside accordion)
- [ ] Select the planner role — Subagent Policy appears as a collapsed accordion matching the same style
- [ ] Expand planner accordion — all 4 radio options visible, custom text input show/hide works (IDs unchanged, listener still resolves `plannerAddonCustomSubagentName`)
- [ ] Verify Git Strategy accordion still works for non-planner roles (no regression)
- [ ] Verify accordion state persists within session (collapsing/expanding works repeatedly)
- [ ] If the shared-constant refactor is used: confirm exactly 10 inline `subagentPolicy` blocks were replaced and no orphan inline copy remains

### Automated Tests
- Skipped this session per directive (no `npm run compile`, no `npm test`). Note for a future CI pass: `agent-prompt-builder-subagents.test.js` exercises the prompt-builder value path (`useSubagentsEnabled` / `subagentPolicy === 'noSubagents'`), not the `ROLE_ADDONS.group` metadata, so adding `group` is not expected to regress it.

## Files Changed

- `src/webview/sharedDefaults.js` — add `group: 'subagent'` to `subagentPolicy` (all 10 roles; preferred: extract a shared `SUBAGENT_POLICY_RADIO` constant and reference it everywhere)
- `src/webview/kanban.html` — `prettyGroupLabel` mapping for `'subagent'` + planner hardcoded HTML wrapped in `<details class="addon-subsection-accordion">`
- `dist/webview/kanban.html` — regenerated at VSIX release time only (not a dev artefact)
