# Prompts tab: corral feature-only add-ons into a "Features" accordion

## Goal

In the kanban **Prompts** tab, it is not clear how a dispatch prompt is built **differently for a feature vs. an individual plan**, and several feature-only add-on checkboxes sit loose among the general per-plan controls (the "worktrees" checkbox being the one the user called out as floating). Add a collapsible **"Features"** accordion section — matching the existing **Subagent Policy** and **Git Strategy** accordions — that groups the add-ons which only take effect when the dispatched card is a *feature* (a card with subtasks). This makes the feature-vs-plan distinction visible and de-clutters the flat checkbox list.

### Problem analysis & root cause

The Prompts tab renders a role's add-ons as a flat list, then appends any grouped controls as collapsed `<details>` accordions. The grouping is driven purely by an add-on's `group` field:

- `renderRoleAddons` (`src/webview/kanban.html:3435-3693`) partitions add-ons into "general" (no `group`) rendered flat first (`:3640-3660`), then one collapsed `<details class="addon-subsection-accordion">` per distinct `group` value (`:3669-3692`). `prettyGroupLabel` (`:3663-3667`) maps a group key to its header text. Today only `git` and `subagent` groups exist (defined on the Git/Subagent radios in `src/webview/sharedDefaults.js:64-93`).
- The **feature-only** add-ons currently carry **no `group`**, so they render flat among the general per-plan controls, invisibly mixed in:
  - `staggeredImplementation` — appends per-subtask notes to the *feature file* (`sharedDefaults.js:123` lead, `:142` coder, `:182` intern). Feature-only.
  - `applyFeatureDirectives` — custom-agent opt-in to the board's feature ultracode/goal prefix (`kanban.html:3466`). Feature-only.
  - `writeFeatureDescriptionIfEmpty` — planner backfill of feature-file sections (`kanban.html:3035-3039`, a **static** planner checkbox — the planner block is hand-written HTML, not `ROLE_ADDONS`-driven). Feature-only.
- `useWorktreesPerPlan` ("Worktrees Per Plan", `sharedDefaults.js:127/146/186`, custom-agents `kanban.html:3464`) is **dual-purpose**: its tooltip already says it governs "each plan (and, for a feature dispatch, each subtask)". Because it affects plan dispatch too, it is *not* feature-only.

**Root cause of the confusion:** feature-only add-ons are not visually segregated from per-plan add-ons, and there is no in-UI signal that they are inert for single-plan dispatch. The fix is a **UI-only reorganization** that reuses the existing `group` accordion mechanism — no change to config keys, storage, or prompt construction.

**Key safety property (verified):** the `group` field only affects *which container an add-on renders in* (`kanban.html:3640-3692`). It does not change the saved config key (`roleConfig_<role>.addons.<id>`) or how the backend consumes it. A repo-wide search confirms `.group` / `group:` is referenced **only** in the webview render partition and the shared radio definitions — no prompt builder (`KanbanProvider.generateUnifiedPrompt`, `agentPromptBuilder.buildKanbanBatchPrompt`) reads it. So grouping is behaviourally inert for the produced prompt — it only relocates controls in the panel.

## Metadata

- **Tags:** frontend, ui, refactor
- **Complexity:** 3/10
- **Affected files:** `src/webview/sharedDefaults.js`, `src/webview/kanban.html`
- **Out of scope (deliberate):** the board-level **ultracode/goal** toggles (`btn-feature-ultracode` / `btn-feature-goal`, `kanban.html:2621-2624`) are feature-only but live on the KANBAN toolbar and persist to **DB config** (`feature_ultracode_enabled` / `feature_goal_enabled`), a different storage model from per-role `roleConfig`. Folding a DB-config control into a per-role `roleConfig` accordion would mix storage layers and invite state bugs — excluded here; can be a follow-up.

## User Review Required

- **Interpretation of the "floating worktrees checkbox" complaint (recommendation: relabel, do not relocate).** The user pointed at the worktrees checkbox as the floating control. This plan does **not** move it into the Features accordion, because `useWorktreesPerPlan` is dual-purpose — it governs single-plan dispatch as well as feature-subtask dispatch, so hiding it in a *features-only* accordion would conceal a plan-relevant control. Instead the plan **relabels** it to `Agent-Managed Worktrees (plans + feature subtasks)` so its dual scope is self-evident, and it stays in the general set among the other general checkboxes (it is not alone). Recommended as-is; flagged only because it concerns the user's own words — if the user actually wants the control *relocated* rather than *clarified*, say so and the approach changes.

## Complexity Audit

### Routine
- Reuses an existing, shipped rendering mechanism (the `group` → accordion partition already ships for `git` and `subagent`).
- The dynamic-role change is a one-word `group: 'features'` tag on three add-on definitions plus one `prettyGroupLabel` line.
- The only hand-written piece is wrapping the single static planner checkbox in a matching `<details>` block (copy of the existing Subagent Policy accordion markup two elements below it).
- No backend, no config schema, no prompt-builder changes; no migration.

### Complex / Risky
- None. The single behavioural nuance (an ON-by-default control hidden inside a collapsed accordion) is identical to how the shipped git/subagent accordions already behave and is addressed by the caption. See Edge-Case & Dependency Audit.

## Edge-Case & Dependency Audit

### Race Conditions
- None. Rendering is fully synchronous; the only state write per control is the existing per-change `saveRoleConfig(role)` → `refreshPreview()` path, unchanged by this plan.

### Security
- None. No new user inputs. The added caption text is static and set via `textContent` (step 2c) or authored directly in HTML (step 3) — not interpolated, no injection surface. (`renderAddon` uses `innerHTML` for labels/tooltips, but those are developer-authored constants and are untouched here.)

### Side Effects
- **Collapsed-by-default hides ON-by-default add-ons.** `writeFeatureDescriptionIfEmpty` defaults ON (`sharedDefaults.js:107`). Inside a collapsed accordion it's hidden-but-active — identical to how the git/subagent accordions already behave, and acceptable. A one-line caption inside the Features accordion body tells users these are feature-scoped so an ON-but-collapsed control isn't surprising. Note the caption lives *inside* the collapsed body, so it only informs users who expand — the visible signal for non-expanders is the **"Features"** header itself, which is the intended trade-off (and matches the existing accordions).
- **Prompt output is unchanged.** Because each add-on's config key is unchanged, the generated prompt is byte-identical before/after for both single-plan and feature dispatch (verified: `group` is not consumed by any prompt builder).
- **Relabel is display-only.** Renaming `useWorktreesPerPlan`'s label and `writeFeatureDescriptionIfEmpty`'s presentation changes no `id`, config key, or default.

### Dependencies & Conflicts
- **Planner is static HTML, not `ROLE_ADDONS`.** `writeFeatureDescriptionIfEmpty` is a hand-written `<label>` (`kanban.html:3035-3039`), so it can't be grouped via the `group` field — it must be wrapped in a static `<details class="addon-subsection-accordion">` mirroring the Subagent Policy accordion at `:3041-3062`. **Preserve the input's `id="plannerAddonWriteFeatureDescriptionIfEmpty"`** — the config-load seed (`kanban.html:3402`) and the change-listener loop (`initPromptsTabListeners`, `kanban.html:4312-4329`) both bind it via `getElementById`, which is structure-independent. Wrapping it in `<details>` (collapsed or open) leaves the element in the DOM and queryable, so neither binding breaks. **Replace** the flat label — do not leave the flat label *and* add the accordion (double-render / duplicate-id hazard).
- **Custom agents use an inline fallback list, not `ROLE_ADDONS`.** `applyFeatureDirectives` is defined in the `custom_agent_` fallback array inside `renderRoleAddons` (`kanban.html:3466`), so its `group: 'features'` must be added there, not in `sharedDefaults.js`. (`staggeredImplementation` is not in the custom fallback and is unaffected for custom agents — correct, it was never offered there.)
- **Two definition sites must stay consistent.** `useWorktreesPerPlan`'s relabel must be applied in both `sharedDefaults.js` (lead/coder/intern) and the `kanban.html` custom-agent fallback so all roles read the same label.
- **Accordion ordering is first-seen, not last.**

  > **Superseded:** "Group ordering: general add-ons render first, then accordions in first-seen order — `features` will appear after `git`/`subagent` for code roles, which is fine."
  > **Reason:** Verified against the actual role arrays in `sharedDefaults.js`. For lead/coder/intern the order is: git radios (`GIT_*_STRATEGY_RADIO`) → `staggeredImplementation` → `SUBAGENT_POLICY_RADIO`. Since subsections render in **first-seen** order and `staggeredImplementation` (soon `group:'features'`) appears **before** `SUBAGENT_POLICY_RADIO`, the Features accordion renders **between** Git Strategy and Subagent Policy — not after both.
  > **Replaced with:** For code roles the accordion order is **Git Strategy → Features → Subagent Policy**. For custom agents (no subagent group) it is **Git Strategy → Features**. For the planner the two static accordions are ordered by hand: **Features → Subagent Policy** (per step 3). This ordering is cosmetic and acceptable; if a different order is ever desired for code roles, move `staggeredImplementation`'s array position relative to `SUBAGENT_POLICY_RADIO`.

- **No new group-key collisions.** `prettyGroupLabel` currently handles `git` and `subagent`; add a `features` case.
- **Config compatibility:** because the config key per add-on is unchanged, existing saved `roleConfig_<role>` values (including users on older versions) keep working — grouping reads the same `addons.<id>`. No migration needed.
- **`npm run compile`** only needed for a VSIX release; dev/testing runs the installed VSIX. `src/` is source of truth.

## Dependencies

- None. Self-contained UI change; no session dependencies.

## Adversarial Synthesis

**Key risks:** (1) an ON-by-default control (`writeFeatureDescriptionIfEmpty`) becomes hidden inside a collapsed accordion — but this matches the shipped git/subagent pattern and the visible "Features" header + caption mitigate it; (2) the static planner wrap must *replace* the flat label, not duplicate it, to avoid a duplicate `id`; (3) the two label-definition sites for `useWorktreesPerPlan` must stay in sync. **Mitigations:** preserve the planner input `id` verbatim, do a replace (not add), keep both label sites identical, and rely on the fact that `group` is behaviourally inert for prompts (verified — no backend consumer). Everything else is a pure reuse of a proven mechanism.

## Proposed Changes

### 1. `src/webview/sharedDefaults.js` — tag the feature-only dynamic add-ons with `group: 'features'`

For `staggeredImplementation` in **lead** (`:123`), **coder** (`:142`), and **intern** (`:182`), add `group: 'features'`:

```js
{ id: 'staggeredImplementation', label: 'Staggered Implementation', group: 'features', tooltip: 'After completing each subtask, append a brief summary to the feature file\'s ## Implementation Notes section so the next subtask has context from prior work', default: false },
```

Relabel `useWorktreesPerPlan` (lead `:127`, coder `:146`, intern `:186`) — **label only**, keep `id`/default and leave it ungrouped (general):

```js
{ id: 'useWorktreesPerPlan', label: 'Agent-Managed Worktrees (plans + feature subtasks)', tooltip: 'Opt into agent-managed orchestration: the agent uses its native subagent/orchestration capabilities to process each plan (and, for a feature dispatch, each subtask) in an isolated git worktree, then reviews and merges. Off = the agent implements plans/subtasks directly — no worktrees, no subagents.', default: false },
```

### 2. `src/webview/kanban.html` — group custom-agent add-on, add the header label + Features caption

**(a)** In the `custom_agent_` fallback list, add `group: 'features'` to `applyFeatureDirectives` (`:3466`):

```js
{ id: 'applyFeatureDirectives', label: 'Apply Feature Ultracode/Goal Directives', group: 'features', tooltip: 'When dispatched on a feature, prepend the board\'s ultracode//goal directives (as for Lead/Coder/Intern)', default: false }
```

Also relabel the custom-agent `useWorktreesPerPlan` (`:3464`) to match step 1 (label only).

**(b)** Add a `features` case to `prettyGroupLabel` (`:3663-3667`):

```js
function prettyGroupLabel(g) {
    if (g === 'git') return 'Git Strategy';
    if (g === 'subagent') return 'Subagent Policy';
    if (g === 'features') return 'Features';
    return g.charAt(0).toUpperCase() + g.slice(1);
}
```

**(c)** Add a one-line caption to the top of the `features` accordion body so complaint #1 (feature-vs-plan clarity) is answered in-place. In the subsection render loop (`:3669-3692`), after creating `body` and before the `items.forEach` (currently `:3687`):

```js
const body = document.createElement('div');
body.className = 'addon-subsection-body';
body.style.display = 'flex';
body.style.flexDirection = 'column';
body.style.gap = '8px';
if (groupName === 'features') {
    const cap = document.createElement('div');
    cap.className = 'addon-subsection-caption';
    cap.style.opacity = '0.75';
    cap.style.fontSize = '11px';
    cap.textContent = 'These add-ons only take effect when the dispatched card is a feature (has subtasks). They are ignored for single-plan dispatch.';
    body.appendChild(cap);
}
items.forEach(addon => renderAddon(addon, role, body));
```

### 3. `src/webview/kanban.html` — wrap the static planner feature add-on in a Features accordion

Replace the flat `writeFeatureDescriptionIfEmpty` label (`:3035-3039`) with a `<details>` accordion mirroring the Subagent Policy accordion immediately below it (`:3041-3062`). **Keep the input id unchanged. Replace the flat label — do not leave it in place alongside the new accordion (duplicate id).**

```html
<details class="addon-subsection-accordion">
  <summary class="addon-subsection-header">Features</summary>
  <div class="addon-subsection-body" style="display:flex;flex-direction:column;gap:8px;padding:8px 12px;">
    <div class="addon-subsection-caption" style="opacity:0.75;font-size:11px;">These add-ons only take effect when the dispatched card is a feature (has subtasks). They are ignored for single-plan dispatch.</div>
    <label class="checkbox-item" title="When dispatched against a feature, backfill missing ## Goal, ## How the Subtasks Achieve This, and ## Dependencies & sequencing sections in the feature file">
      <input type="checkbox" id="plannerAddonWriteFeatureDescriptionIfEmpty">
      <span>Write Feature Description If Empty</span>
      <span class="tooltip">When dispatched against a feature, backfill missing ## Goal, ## How the Subtasks Achieve This, and ## Dependencies & sequencing sections in the feature file</span>
    </label>
  </div>
</details>
```

Place this `<details>` where the flat label was (before the Subagent Policy `<details>`), so the planner shows two sibling accordions: **Features**, then **Subagent Policy**.

## Verification Plan

> Session directive: **SKIP COMPILATION** and **SKIP TESTS** — verification below is manual against the installed VSIX (`src/` is source of truth; nothing is served from `dist/`).

### Manual verification
1. **Code roles.** Prompts tab → select **Coder** (and Lead, Intern). Confirm a collapsed **Features** accordion appears — for code roles the accordion order is **Git Strategy → Features → Subagent Policy** — containing **Staggered Implementation**; confirm `Agent-Managed Worktrees (plans + feature subtasks)` remains a general (ungrouped) checkbox.
2. **Planner.** Select **Planner**. Confirm a **Features** accordion containing **Write Feature Description If Empty**, sitting *before* the existing **Subagent Policy** accordion; expand it and confirm the caption renders.
3. **Custom agent.** Select a custom agent. Confirm **Apply Feature Ultracode/Goal Directives** appears inside the Features accordion (order **Git Strategy → Features**; no Subagent group for custom agents).
4. **State round-trips.** Toggle Staggered Implementation / Write Feature Description on, reload the panel, re-open the accordion, and confirm the state persisted (proves the config key is unchanged by grouping). Toggle Write Feature Description off and confirm it stays off (guards the ON-default seed at `:3402`).
5. **Prompt unchanged.** With identical add-on selections before/after this change, confirm the generated prompt preview (`#promptPreview`) is byte-identical for both a single-plan and a feature dispatch — grouping must not alter prompt construction.
6. **Listener intact.** Confirm the planner **Write Feature Description If Empty** checkbox still saves after being wrapped in `<details>` (id-based `getElementById` binding preserved; `initPromptsTabListeners` at `:4312`).
7. **No regressions:** Git Strategy and Subagent Policy accordions still render and function; caption only shows for the Features group.

### Automated Tests
- Skipped per session directive (**SKIP TESTS**). Note: an existing regression test `src/test/prompts-tab-move-regression.test.js` references `renderRoleAddons`; if the implementer chooses to run it later, confirm the partition-loop edit (step 2c) did not disturb its expectations. No new automated tests required for a UI-only render change.

---

**Recommendation:** Complexity 3/10 → **Send to Intern.**

**Completion Report:** Implemented the Features accordion for feature-only add-ons in the Prompts tab. Tagged `staggeredImplementation` with `group: 'features'` in `src/webview/sharedDefaults.js` for lead, coder, and intern; relabeled `useWorktreesPerPlan` in both `sharedDefaults.js` and the `kanban.html` custom-agent fallback. Added `group: 'features'` to `applyFeatureDirectives` in `kanban.html`, added a `features` case to `prettyGroupLabel`, and added a caption inside the dynamic Features accordion. Replaced the static planner `Write Feature Description If Empty` flat label with a matching `<details>` Features accordion, preserving the input id. Files changed: `src/webview/sharedDefaults.js` and `src/webview/kanban.html`. No compilation or tests were run per the session directive; `git diff --check` and `npx eslint src/webview/sharedDefaults.js` passed. No issues encountered.

## Review Findings

Reviewed the committed implementation (commit `846be32`, files `src/webview/sharedDefaults.js` and `src/webview/kanban.html`) against all 7 plan steps — every change is present and correct: `staggeredImplementation` tagged `group: 'features'` in lead/coder/intern, `useWorktreesPerPlan` relabeled at all four definition sites, `applyFeatureDirectives` grouped in the custom-agent fallback, `prettyGroupLabel` `features` case added, dynamic caption injected, and the static planner checkbox wrapped in a matching `<details>` (flat label replaced, `id` preserved, placed before Subagent Policy). Regression analysis confirmed `group` is not consumed by any prompt builder (grep of `src/services` found zero add-on `.group` reads), no duplicate `id`s, the config-load seed (`kanban.html:3430`) and listener loop (`:4348`) both bind via `getElementById` with null-checks so the `<details>` wrap is safe, and accordion ordering is correct (Git Strategy → Features → Subagent Policy for code roles; Git Strategy → Features for custom agents; Features → Subagent Policy for planner). Verification: `node --check src/webview/sharedDefaults.js` passed; compilation and tests skipped per session directive. Remaining risks: (1) NIT — the caption text is duplicated between static HTML (`:3060`) and dynamic JS (`:3720`), so a future wording change must touch both; (2) NIT — `addon-subsection-caption` has no dedicated CSS rule (inline-styled only), consistent with plan intent but less maintainable. No code fixes applied — implementation is plan-compliant and regression-free.
