# Fix: Prompts tab layout — group ungrouped prompts first, make git subsections accordions, add option descriptions

**Plan ID:** a1b2c3d4-1258-4a04-9f04-promptsLayout1258

## Goal

The Prompts tab in `kanban.html` lays out role add-ons in a single flat dump inside `#roleAddonsGroup`. Every checkbox and radio group (Switchboard Safeguards, Pair Programming, Git Safety Guardrail, Git Branch Strategy, Git Commit Strategy, Git Push Strategy, Phone-a-Friend, Caveman Output, etc.) is rendered one-after-another with no visual grouping. This makes the page excessively long and hard to scan, and the git strategy radio groups (Branch / Commit / Push) sit inline with unrelated checkboxes.

The user wants three layout rules applied:

1. **Any prompt not belonging to a subsection should go in the first set of prompts** — i.e. ungrouped/general add-ons render first, in a single top group, before any subsection.
2. **Subsections like Git Branch, Git Commit, Git Push etc. should be accordions** to reduce page length. Each git strategy radio group gets its own collapsible accordion (collapsed by default), so the three git groups no longer consume vertical space unless opened.
3. **Prompt options within a subheader need a descriptive text** — each option inside an accordion subsection must show its tooltip/description as visible helper text beneath the label, not only on hover.

### Problem / background / root cause

The add-ons are injected into a single container by `renderRoleAddons()` in `kanban.html:3385-3500`. The function iterates `ROLE_ADDONS[role]` (defined in `sharedDefaults.js:88+`) and appends each addon to `#roleAddonsGroup` as either a `.checkbox-item` label or an `.addon-radio-group` wrapper. There is no grouping concept — every addon is a sibling in the same `.checkbox-group` div (`kanban.html:3063-3065`).

**Root cause:** `renderRoleAddons()` has no notion of "subsections". It renders a flat list. The git strategy radios (`GIT_BRANCH_STRATEGY_RADIO`, `GIT_COMMIT_STRATEGY_RADIO`, `GIT_PUSH_STRATEGY_RADIO` in `sharedDefaults.js:64-85`) are just three entries in the array, so they render inline with the checkboxes. Option descriptions live only in the `title` attribute (hover tooltip) — see `kanban.html:3439` (`label.title = opt.tooltip || ''`) — so they are invisible without hovering.

## Metadata

**Tags:** frontend, webview, kanban, prompts-tab, ux, layout, accordion
**Complexity:** 4

## User Review Required

No — pure UI layout refactor. No behavior change to emitted prompts, no data migration, no default/option changes. Saved-config keys and addon IDs are untouched. Safe to implement directly. (The sibling subtask — git strategy defaults — is the one carrying a stale-value migration; this plan has none.)

## Complexity Audit

### Routine
- Adding a `group`/`subsection` field to addon metadata in `sharedDefaults.js` so the renderer can bucket addons (e.g. `group: 'git'` on the three git radios; no group = general). Pure data change.
- Updating `renderRoleAddons()` in `kanban.html` to (a) partition addons into "general" (no group) and named subsections, (b) render general addons first in the existing flat list, (c) render each named subsection as a collapsible `<details>`/accordion.
- Surfacing option `tooltip` text as visible helper text under each radio option label.

### Complex / Risky
- **Accordion styling.** The webview uses VS Code CSS variables and existing `.db-subsection` / `.subsection-header` patterns. The accordion must match the existing visual language (use `<details>`/`<summary>` styled to match `.subsection-header`, or reuse the existing `.db-subsection` collapsible pattern if one exists). Verify the collapsed/expanded state does not break the existing `refreshPreview()` flow — radio changes inside an accordion still trigger `saveRoleConfig` + `refreshPreview` (`kanban.html:3474-3498`).
- **Custom-agent fallback.** `kanban.html:3392-3418` builds an inline addon array for custom agents that duplicates the git radios. This must also receive the `group` field so custom-agent roles get the same accordion treatment.
- **Planner role.** The planner config is rendered via static HTML (`kanban.html:2888-3016`), not `renderRoleAddons()`. The planner's addons are already inside `.db-subsection` blocks (Workflow File, Add-ons). This plan targets the non-planner `#roleAddonsGroup` path. Do not restructure the planner static HTML in this plan — out of scope.
- **No data migration.** Addon IDs and saved config keys are unchanged; only rendering/grouping changes. Existing `roleConfigs` persist correctly.

## Edge-Case & Dependency Audit

- **Roles with no git radios.** Roles like `researcher`, `analyst`, `ticket_updater` have no git addons (`sharedDefaults.js` ROLE_ADDONS). For these, no git accordion renders — only the general group. The renderer must handle "no subsections" gracefully (just render the general list, no accordions).
- **Roles with only git radios and no general addons.** If a role's addon list contains only grouped items, the "general" group should not render an empty header. Skip the general section header when it has zero items.
- **Accordion default state.** Git strategy accordions should be **collapsed by default** (the user's goal is to reduce page length). The selected radio value is still applied from saved config (`kanban.html:3431` reads `roleConfigs[role]?.addons?.[addon.id] ?? addon.default`), so collapsing does not lose state.
- **Option descriptive text.** Each radio option already has a `tooltip` string (e.g. `sharedDefaults.js:66` "Do all work on the current branch; do NOT create new branches or worktrees"). Render this as a `<span class="addon-option-desc">` below the option label. Keep the `title` attribute too for hover parity.
- **`dist/webview/kanban.html`** is a build artifact. Edit `src/` only; the build copies it. Confirm the build step regenerates dist.
- **No dependency on Issue 2.** This plan is purely layout/grouping. Issue 2 (git defaults + incremental removal) touches the same `sharedDefaults.js` radio definitions but is independent. If both land, coordinate that the `group: 'git'` field and the default/option changes do not conflict — they edit different fields of the same objects.

## Dependencies

- No session dependencies. Sibling subtask `feature_plan_20260707125920_git-strategy-defaults-notspecified-remove-incremental` edits the same `sharedDefaults.js` radio objects and the same `kanban.html` custom-agent fallback block, but different fields (`default` / `options` vs `group`). Recommended landing order: **sibling first** (defaults + `incremental` removal), then this plan (layout) — see the feature's `## Dependencies & sequencing`. Landing in that order (or in a single PR) eliminates the merge-conflict surface on the shared object literals.

## Adversarial Synthesis

Key risks: (1) the `renderAddon()` helper extraction can silently break the `customSubagent` text-input toggle if `textInputsToToggle` is hoisted out of per-addon scope; (2) the `subagentPolicy` radio in the general group shares that same text-input wiring and is not covered by the verification steps; (3) cited CSS anchor line numbers may be stale. Mitigations: keep `textInputsToToggle` per-addon inside the helper (clarified in §2), add a customSubagent verification step, and anchor CSS by selector name not line number.

## Proposed Changes

### 1. `src/webview/sharedDefaults.js` — add `group` field to git radio definitions

Tag the three git strategy radios with `group: 'git'` so the renderer can bucket them into a collapsible subsection. General addons (no `group`) render first.

```js
/* BEFORE — sharedDefaults.js:64-85 */
const GIT_BRANCH_STRATEGY_RADIO = {
    id: 'gitBranchStrategy', label: 'Git Branch Strategy', tooltip: '...', type: 'radio', default: 'current', options: [ ... ]
};
const GIT_COMMIT_STRATEGY_RADIO = {
    id: 'gitCommitStrategy', label: 'Git Commit Strategy', tooltip: '...', type: 'radio', default: 'whenDone', options: [ ... ]
};
const GIT_PUSH_STRATEGY_RADIO = {
    id: 'gitPushStrategy', label: 'Git Push Strategy', tooltip: '...', type: 'radio', default: 'noPush', options: [ ... ]
};

/* AFTER */
const GIT_BRANCH_STRATEGY_RADIO = {
    id: 'gitBranchStrategy', label: 'Git Branch Strategy', tooltip: '...', type: 'radio', default: 'current', group: 'git', options: [ ... ]
};
const GIT_COMMIT_STRATEGY_RADIO = {
    id: 'gitCommitStrategy', label: 'Git Commit Strategy', tooltip: '...', type: 'radio', default: 'whenDone', group: 'git', options: [ ... ]
};
const GIT_PUSH_STRATEGY_RADIO = {
    id: 'gitPushStrategy', label: 'Git Push Strategy', tooltip: '...', type: 'radio', default: 'noPush', group: 'git', options: [ ... ]
};
```

Also add `group: 'git'` to the three git radios in the custom-agent fallback array (`kanban.html:3398-3413`).

### 2. `src/webview/kanban.html` — `renderRoleAddons()` partition + accordion rendering

Refactor `renderRoleAddons()` (`kanban.html:3385-3500`) to partition addons before rendering:

```js
function renderRoleAddons(role) {
    const group = document.getElementById('roleAddonsGroup');
    const desc = document.getElementById('roleAddonsDesc');
    if (!group || !desc) return;
    group.innerHTML = '';

    let addons = ROLE_ADDONS[role] || [];
    // ... existing custom-agent fallback (add group:'git' to the git radios there) ...

    if (addons.length === 0) {
        desc.textContent = 'No add-ons available for this role.';
        return;
    }
    desc.textContent = `Build the ${role.charAt(0).toUpperCase() + role.slice(1)} prompt with add-on instructions:`;

    // Partition: general (no group) first, then named subsections (preserve order).
    const general = addons.filter(a => !a.group);
    const subsections = [];
    const seen = new Set();
    addons.forEach(a => {
        if (a.group && !seen.has(a.group)) { seen.add(a.group); subsections.push(a.group); }
    });

    // 1) Render general addons as the first set (flat, no header if empty).
    if (general.length > 0) {
        const generalWrap = document.createElement('div');
        generalWrap.className = 'addon-general-group';
        general.forEach(addon => renderAddon(addon, role, generalWrap));
        group.appendChild(generalWrap);
    }

    // 2) Render each named subsection as a collapsed accordion.
    subsections.forEach(groupName => {
        const items = addons.filter(a => a.group === groupName);
        const details = document.createElement('details');
        details.className = 'addon-subsection-accordion';
        // collapsed by default
        const summary = document.createElement('summary');
        summary.className = 'addon-subsection-header';
        summary.textContent = prettyGroupLabel(groupName); // 'git' -> 'Git Strategy'
        details.appendChild(summary);
        const body = document.createElement('div');
        body.className = 'addon-subsection-body';
        items.forEach(addon => renderAddon(addon, role, body));
        details.appendChild(body);
        group.appendChild(details);
    });
}
```

Extract the existing per-addon rendering (checkbox vs radio vs file) into a `renderAddon(addon, role, container)` helper so both the general group and accordion bodies use the same logic. Preserve all existing event listeners (`saveRoleConfig`, `refreshPreview`, text-input toggle for `customSubagent`).

**Clarification (scoping — critical):** the existing radio branch declares `textInputsToToggle` INSIDE the per-addon scope (`kanban.html:3436`) and wires it through the `change` listener (`3480-3495`) to toggle the custom-subagent text input. The `renderAddon(addon, role, container)` helper renders ONE addon, so `textInputsToToggle` MUST remain declared inside the helper (per-addon closure) — never hoisted to the container or the caller. Hoisting it would share one toggle array across multiple radio groups and silently break the `customSubagent` text-input show/hide/clear logic for every role. The `subagentPolicy` radio (general group, `sharedDefaults.js:121-126`) also uses `textInputOn: 'customSubagent'`, so this wiring is exercised in the general group too — not only in git accordions.

### 3. `src/webview/kanban.html` — show option descriptive text under each radio option

In the radio-option rendering (currently `kanban.html:3436-3445`), append the `tooltip` as visible helper text:

```js
/* BEFORE — kanban.html:3440-3442 */
label.innerHTML = `
    <input type="radio" name="addon_${role}_${addon.id}" value="${opt.value}" ${currentValue === opt.value ? 'checked' : ''}>
    <span>${opt.label}</span>
`;

/* AFTER */
label.innerHTML = `
    <input type="radio" name="addon_${role}_${addon.id}" value="${opt.value}" ${currentValue === opt.value ? 'checked' : ''}>
    <span class="addon-option-label">${opt.label}</span>
    ${opt.tooltip ? `<span class="addon-option-desc">${opt.tooltip}</span>` : ''}
`;
```

### 4. `src/webview/kanban.html` — accordion + option-desc CSS

Add styles near the existing `.prompts-tab` / `.addon-radio-group` / `.addon-label` rules (anchor by selector name — the cited line numbers `1142-1151` / `2235` are approximate and may drift):

```css
.addon-subsection-accordion {
    border: 1px solid var(--vscode-panel-border, #333);
    border-radius: 6px;
    margin: 8px 0;
    background: var(--vscode-editor-background, transparent);
}
.addon-subsection-accordion > summary.addon-subsection-header {
    cursor: pointer;
    padding: 8px 12px;
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    list-style: none;
    user-select: none;
}
.addon-subsection-accordion > summary.addon-subsection-header::-webkit-details-marker { display: none; }
.addon-subsection-accordion > summary.addon-subsection-header::before {
    content: '▸'; margin-right: 8px; transition: transform 0.15s ease; display: inline-block;
}
.addon-subsection-accordion[open] > summary.addon-subsection-header::before { transform: rotate(90deg); }
.addon-subsection-body { padding: 8px 12px 12px; }
.addon-option-desc {
    display: block;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    margin: 2px 0 6px 22px;
    line-height: 1.4;
}
```

## Verification Plan

1. **Manual (installed VSIX):**
   - Open Kanban → Prompts tab. Select **Lead Coder** role.
   - Confirm the general add-ons (Switchboard Safeguards, Pair Programming, Inline Challenge, Accurate Coding, Git Safety Guardrail, Phone-a-Friend, Clear Antigravity Context, Caveman Output, Suppress Walkthrough, Skip Compilation, Skip Tests, Subagent Policy, Worktrees Per Plan, Workflow File) render first as a flat group.
   - Confirm a **Git Strategy** accordion appears below the general group, **collapsed by default**.
   - Click to expand — confirm Git Branch, Git Commit, Git Push radio groups are inside, each option showing its descriptive text beneath the label (e.g. under "Current Branch": "Do all work on the current branch; do NOT create new branches or worktrees").
2. **State preservation:** Change a git radio inside the accordion; confirm the preview updates (`refreshPreview`) and the choice persists after switching roles and returning.
3. **Roles with no git radios:** Select Researcher/Analyst — confirm no Git Strategy accordion renders and only the general group shows. No empty accordion header.
4. **Custom agent:** Configure a custom agent; confirm it gets the Git Strategy accordion (the fallback array at `kanban.html:3396-3418` was updated with `group: 'git'`).
5. **Page length:** Confirm the Prompts tab is visibly shorter for Lead/Coder/Intern roles with the git accordions collapsed.
6. **CustomSubagent text-input toggle (regression guard):** Select **Lead Coder** → Subagent Policy = **Custom Subagent** (this radio lives in the new general group, `sharedDefaults.js:121-126`). Confirm the custom-subagent name text input appears, accepts input, persists across role switches, and clears when a non-text option is reselected. This guards the `renderAddon()` helper extraction against accidentally hoisting `textInputsToToggle` out of per-addon scope.
7. **Build (release only):** Per `CLAUDE.md`, `dist/` is NOT used during development or testing — all testing is via an installed VSIX, and `dist/` staleness is never a verification gate. A webview build is only needed when producing a VSIX for release; do not flag `dist/` staleness during review. (Compilation is skipped this session per directive.)

### Automated Tests

None — verification is manual via an installed VSIX, per project convention (`dist/` is not used in dev; automated tests are skipped this session per directive).

## Recommendation

**Complexity 4 → Send to Coder.** Single-file (`kanban.html`) layout refactor plus a data-only `group` field in `sharedDefaults.js`; reuses existing radio/checkbox rendering logic. The one moderate risk — the `renderAddon()` helper extraction preserving `textInputsToToggle` per-addon scope — is now called out explicitly in §2 and guarded by verification step 6. Land after the sibling defaults plan (see `## Dependencies`).

**Stage Complete:** LEAD CODED

## Review Findings

Reviewed commit `04fa5e9`. Files changed: `src/webview/kanban.html` (renderAddon helper extraction, general/subsection partition, collapsed `<details>` git accordion, visible `.addon-option-desc` helper text, accordion CSS) and the `group: 'git'` tag on the git radios in `sharedDefaults.js` + the custom-agent fallback. Verified the critical concern: `textInputsToToggle` stays per-addon inside `renderAddon` (kanban.html:3484), and `saveRoleConfig` serialises the `roleConfigs` object rather than scraping the DOM, so relocating radios into `<details>` cannot lose state. Accordion CSS vars (`--border-color`/`--panel-bg2`/`--text-secondary`) are all defined in kanban.html, so styling themes correctly. No CRITICAL/MAJOR findings — only NITs (per-render helper redeclaration, option-desc now also shows on general-group `subagentPolicy` radios); no code fixes applied; compile/tests skipped per session directive.

**Stage Complete:** CODE REVIEWED
