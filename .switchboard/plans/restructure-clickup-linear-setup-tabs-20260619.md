# Restructure ClickUp & Linear Setup Tabs into a 4-Section Progressive-Disclosure Layout

## Goal

Restructure both the ClickUp and Linear setup tabs in `src/webview/setup.html` into a
clear, ordered, four-section layout with progressive disclosure, so the default happy
path is "paste API token, click apply, done," and all advanced behavior is collapsed out
of sight until explicitly opted into.

The four sections, in order, for **both** tabs:

1. **API token** — the only required step. Entering it makes the provider available as
   a source for the Tickets tab in `planning.html`.
2. **Ticket import** — the shared "Ticket Import Location" + "Enable Tickets auto-sync"
   block (feeds the Tickets/artifacts webview).
3. **Kanban board mapping** — collapsed by default behind an independent
   "Enable Kanban sync" toggle.
4. **Kanban automation** — collapsed by default behind an independent
   "Enable automation" toggle.

## Metadata

**Tags:** UI, UX, frontend
**Complexity:** 5

*Complexity rationale (Clarification):* originally scored 4. Bumped to 5 (Mixed). The bulk
is routine single-file DOM reordering that reuses existing CSS classes and leaves all
id-based logic untouched. The one moderate, well-scoped risk is the new
`syncSectionDisclosure()` auto-expand heuristic, which must avoid being triggered by
Linear's default-ON options (see Edge-Case & Dependency Audit). That single subtlety,
plus symmetric two-tab coordination, lifts it from purely-routine into Mixed territory.

## Problem

The ClickUp and Linear tabs in `src/webview/setup.html` present every option as a
flat, undifferentiated list of ~7-9 checkboxes between the API token field and a pair
of post-apply editors. The grouping does not communicate the four distinct functions
these integrations actually serve, and even the feature's designer can't tell at a
glance what each control does. The defaults happen to work, but the UI gives no signal
about which controls are essential (the token) versus advanced (everything else).

## User Review Required

Decisions the user should confirm before / during implementation:

1. **Auto-expand heuristic for Linear (NEW — raised by adversarial review).** Linear's
   `linear-option-exclude-backlog` is `checked` in markup (`setup.html:885`) and both
   `excludeBacklog` and `completeSyncEnabled` render as default-ON (`!== false`,
   `setup.html:2464` and `:2466`). A naive "open the section if any child checkbox is
   checked" rule would auto-expand §3 **and** §4 on the Linear tab on every fresh load,
   defeating the collapsed-by-default goal. **Proposed resolution:** base auto-expand on
   *configured intent*, explicitly excluding `exclude-backlog` (from §3's test) and
   `complete-sync` (from §4's test). Confirm this is acceptable.
2. **Summary/error placement.** `clickup-option-summary` + `clickup-setup-error` follow
   the apply button into §1; `clickup-mapping-summary` follows its editor into §3.
   Confirm.
3. **Master-toggle id namespace.** New disclosure toggles use a `*-disclosure-*` prefix
   (never `*-option-*`) so no collect selector can ever pick them up. Confirm.

The three previously-open product questions (`exclude-backlog` placement, collapse
semantics, apply-button position) were already resolved by the user on 2026-06-19 — see
**Resolved Decisions** at the end.

## Non-Goals / Constraints

- **Presentation-only.** This is a pure DOM reorganization. No changes to:
  - any element `id` (the collect/apply/state functions read controls by `id`, so
    reordering DOM does not affect them),
  - the `ticket-import-folder-input` / `tickets-auto-sync-toggle` classes,
  - `collectClickupApplyOptions` / `collectLinearApplyOptions` (`setup.html:2369-2400`),
  - `renderClickupOptionSummary` / `renderLinearOptionSummary` (`:2408-2482`),
  - `renderClickupMappings` / `renderClickupAutomation` (`:2574+`) or their Linear peers,
  - the apply-button click handlers (`btn-apply-clickup-config` `:3186`,
    `btn-apply-linear-config` `:3219`),
  - the message/postMessage protocol to the extension host.
- The only new JavaScript permitted is **presentation glue for the accordions**
  (show/hide a section body when its master toggle changes, and set the master toggle's
  initial open/closed state from already-rendered child state). It must not read, write,
  or transform any value sent to the extension host.
- No changes to `dist/` — source only. (`dist/webview/setup.html` is generated.)
- Both tabs get the same four-section skeleton (symmetric structure).

## Current-State Inventory (what moves where)

All ids below are preserved exactly; only their DOM container/position changes.
Line numbers verified against `src/webview/setup.html` (4560 lines) on 2026-06-19.

### Shared block (both tabs, currently duplicated verbatim, lines 643-665 and 797-819)
- `.ticket-import-folder-input` (text) + `.btn-browse-ticket-folder`
- `.tickets-auto-sync-toggle` (checkbox)
- Cross-tab mirroring is **class-based**: `querySelectorAll('.ticket-import-folder-input')`
  and `querySelectorAll('.tickets-auto-sync-toggle')` at `setup.html:3253-3270`. Because
  it keys off classes, not DOM position, **moving this block is safe**. Keep duplicated,
  keep classes. → **Section 2** in each tab. (Note: today this block sits *above* the
  token; the restructure moves it to *below* the token as §2.)

### ClickUp tab (`#clickup-fields`, lines 638-790)
- Outer wrappers `#clickup-config-section` (`:667`) and the `db-subsection` (`:668`) are
  **inert** — no JS reads them by id. Safe to keep, split, or re-nest.
- **Section 1 (token):** `clickup-token-input` (`:678`), `clickup-setup-status` (`:671`).
- **Section 3 (mapping):**
  - `clickup-option-create-folder` (`:686`)
  - `clickup-option-create-lists` (`:695`)
  - `clickup-option-create-custom-fields` (`:704`)
  - `clickup-option-exclude-backlog` (`:740`) *(import-scope filter — Resolved Decision 1)*
  - the post-apply **Column Mappings** editor: `clickup-mappings-section` (`:752`) (+
    `clickup-mapping-summary` `:751`, `clickup-mappings-list` `:763`,
    `btn-clickup-create-unmapped` `:760`, `btn-clickup-save-mappings` `:761`)
- **Section 4 (automation):**
  - `clickup-option-enable-realtime-sync` (`:713`)
  - `clickup-option-delete-sync` (`:722`)
  - `clickup-option-complete-sync` (`:731`)
  - the post-apply **Automation** editor: `clickup-automation-section` (`:765`) (+
    `clickup-option-enable-auto-pull` `:771`, `btn-clickup-add-rule` `:782`,
    `btn-clickup-save-automation` `:783`, `clickup-automation-rules-list` `:786`)
- **Apply controls:** `btn-apply-clickup-config` (`:748`) → moves to §1;
  `clickup-option-summary` (`:749`) + `clickup-setup-error` (`:750`) → follow it to §1.

### Linear tab (`#linear-fields`, lines 792-945)
- **Section 1 (token):** `linear-token-input` (`:832`), `linear-setup-status` (`:825`).
- **Section 3 (mapping):**
  - `linear-option-map-columns` (`:840`)
  - `linear-option-create-label` (`:849`)
  - `linear-option-include-projects` (`:897`) (+ `linear-browse-include-projects` `:898`)
  - `linear-option-exclude-projects` (`:909`) (+ `linear-browse-exclude-projects` `:910`)
  - `linear-option-exclude-backlog` (`:885`, **`checked` by default**) *(import-scope
    filter — Resolved Decision 1; see auto-expand caveat below)*
  - (Linear has **no** separate post-apply column-mapping editor; mapping is the
    `map-columns` checkbox only.)
- **Section 4 (automation):**
  - `linear-option-enable-realtime-sync` (`:858`)
  - `linear-option-enable-complete-sync` (`:867`, **renders ON by default** via
    `!== false` at `:2464`)
  - `linear-option-delete-sync` (`:876`)
  - the post-apply **Automation** editor: `linear-automation-section` (`:920`) (+
    `linear-option-enable-auto-pull` `:926`, `btn-linear-add-rule` `:937`,
    `btn-linear-save-automation` `:938`, `linear-automation-rules-list` `:941`)
- **Apply controls:** `btn-apply-linear-config` (`:917`) → moves to §1;
  `linear-option-summary` (`:918`) + `linear-setup-error` (`:919`) → follow it to §1.

## Complexity Audit

### Routine
- Reordering existing DOM nodes inside `#clickup-fields` and `#linear-fields` into four
  labelled section wrappers. Ids untouched, so all collect/apply/render logic continues
  to work unchanged.
- Reusing existing `db-subsection` / `subsection-header` classes for the new section
  headers (no new CSS required for the headers themselves).
- Moving the shared ticket-import block from above the token to §2 — safe because its
  mirroring is class-based (`:3253-3270`), not position-based.
- Moving each tab's single apply button + its summary/error divs up under the token.

### Complex / Risky
- **`syncSectionDisclosure()` auto-expand heuristic.** The only piece of net-new logic
  and the only load-bearing risk. It must derive "is this section already configured"
  from *intent* signals while excluding Linear's two default-ON options
  (`exclude-backlog`, `complete-sync`), or §3/§4 will auto-open on every fresh Linear
  load. See Edge-Case & Dependency Audit → Side Effects. Well-scoped (one helper, read-
  only) but must be implemented to spec, not "any child checked."

## Edge-Case & Dependency Audit

**Race Conditions**
- None of substance. The accordion glue is synchronous DOM manipulation on `change`
  events and a one-shot `syncSectionDisclosure()` call appended after the existing render
  functions. There is no async ordering hazard: `syncSectionDisclosure()` must run
  *after* `renderClickupOptionSummary` / `renderClickupMappings` / `renderClickupAutomation`
  (and Linear peers) have set child state — hook it at the tail of
  `renderClickupSetupState()` (`:2755`) and `renderLinearSetupState()` (`:2871`).

**Security**
- None. Presentation-only; no new data crosses the postMessage boundary. Tokens remain in
  the same password inputs read by the same handlers (`:3186`, `:3219`).

**Side Effects**
- **Linear default-ON options auto-expand the advanced sections (PRIMARY RISK).**
  `linear-option-exclude-backlog` is `checked` in markup (`:885`); `excludeBacklog` and
  `completeSyncEnabled` both render default-ON via `!== false` (`:2466`, `:2464`). A
  "open if any child is checked" heuristic opens §3 and §4 on Linear unconditionally.
  **Mitigation:** auto-expand keys off configured intent, **excluding** these two boxes:
  - **§3 opens** iff its post-apply editor is visible (ClickUp: `clickup-mappings-section`
    not `.hidden`) **OR** a mapping-intent option is checked — for ClickUp:
    `create-folder` / `create-lists` / `create-custom-fields`; for Linear: `map-columns` /
    `create-label` / a non-empty `include-projects` / `exclude-projects`. **`exclude-backlog`
    is NOT part of this test.**
  - **§4 opens** iff its automation editor is visible (`*-automation-section` not
    `.hidden`) **OR** a non-default automation option is checked: `enable-realtime-sync` /
    `delete-sync` / `enable-auto-pull`. **`complete-sync` is NOT part of this test** (it
    defaults ON for Linear).
- **Collapsed-but-checked options are still applied.** Confirmed safe and *intended*:
  `collectClickupApplyOptions` / `collectLinearApplyOptions` read `getElementById(...).checked`
  regardless of visibility (`:2369-2400`). Disclosure is not a kill switch (Resolved
  Decision 2). UI copy must say so.
- **Summary/error rendering location.** If left below where the apply button used to be,
  a post-apply error would render far from the button. Mitigation: option-summary + error
  divs move into §1 with the button; mapping-summary stays with its editor in §3.

**Dependencies & Conflicts**
- **Master-toggle id collision.** New disclosure toggles must use a namespace that no
  collect selector can match. Today collect uses explicit `getElementById` (safe), but to
  be future-proof, name them `clickup-disclosure-kanban` / `clickup-disclosure-automation`
  / `linear-disclosure-kanban` / `linear-disclosure-automation` — **never** `*-option-*`.
- **`dist/` drift.** Source-only change; `dist/webview/setup.html` (generated, 254 KB) will
  mismatch until the build runs. Per project convention, debug against source, not `dist/`.
- **Symmetric skeleton, asymmetric bodies.** Linear §3 has no post-apply column-mapping
  editor (mapping is the `map-columns` checkbox only); its §3 body is checkboxes + project
  filters. Expected, not a bug.

## Dependencies

- None. This is a self-contained, single-file presentation refactor with no upstream
  session prerequisites.

## Adversarial Synthesis

Key risks: (1) the `syncSectionDisclosure()` auto-expand heuristic colliding with Linear's
default-ON `exclude-backlog` (`:885`) and `complete-sync` (`:2464`), which would force §3/§4
open on every fresh Linear load and defeat the collapsed-by-default goal; (2) ambiguous
placement of the summary/error/mapping-summary divs after the apply button moves; (3) a
future selector refactor accidentally consuming the new master toggles. Mitigations: base
auto-expand on configured-intent signals that explicitly exclude the two default-ON boxes;
pin option-summary + error to §1 and mapping-summary to §3; namespace master toggles as
`*-disclosure-*`. The underlying architecture is sound — collect logic is id-based and
mirroring is class-based, so DOM reordering is genuinely safe.

## Proposed New Structure (per tab)

```
[Tab intro line]

Section 1 — API Token
  • token input + status
  • APPLY <PROVIDER> SETTINGS  (single existing apply button, moved up here)
  • option summary + error (existing divs, moved here)

Section 2 — Ticket Import   (shared block, always visible)
  • import-location folder input + BROWSE
  • Enable Tickets auto-sync toggle

Section 3 — Kanban Board Mapping   (collapsed by default)
  ▸ [ ] Enable Kanban sync           ← master toggle (*-disclosure-kanban), OFF by default
      (body, hidden until checked:)
      • mapping intent checkboxes
      • post-apply column-mappings editor (ClickUp only; still gated by setupComplete)

Section 4 — Kanban Automation   (collapsed by default)
  ▸ [ ] Enable automation            ← master toggle (*-disclosure-automation), OFF by default, independent of §3
      (body, hidden until checked:)
      • sync-behavior checkboxes (realtime/delete/complete)
      • post-apply automation-rules editor (still gated by setupComplete)
```

Notes:
- **Single apply button per tab is retained** and moved directly under the token
  (Section 1). Because the collect functions read every control by `id` regardless of
  whether its section is expanded, one apply button still commits all sections. Default
  user flow: paste token → click apply → done. Power user: expand §3/§4, change options,
  click apply again (apply remains the single commit point, as today).
- Each section gets a lightweight header consistent with existing `subsection-header` /
  `db-subsection` styling. Sections 3 and 4 are disclosure groups, not new tabs.

## Accordion Mechanics (the only new JS)

1. **Master toggle drives body visibility.** A checkbox (or styled disclosure header)
   per section, with a `*-disclosure-*` id (never `*-option-*`); on `change`, toggle the
   `hidden` class on that section's body wrapper. Default: unchecked → body hidden.
2. **Initial open/closed state derives from configured intent** (not raw checkbox state),
   so a previously-configured user isn't forced to re-expand, **and** a fresh user isn't
   forced to see advanced sections:
   - After the existing `renderClickup*` / `renderLinear*` functions run (they already
     set child checkbox `.checked` and toggle the inner editor's `.hidden`), call a small
     `syncSectionDisclosure()` helper.
   - **§3 opens** iff the column-mappings editor is visible (ClickUp) OR a *mapping-intent*
     option is checked — ClickUp: `create-folder`/`create-lists`/`create-custom-fields`;
     Linear: `map-columns`/`create-label`/non-empty `include-projects`/`exclude-projects`.
     **Exclude `exclude-backlog`** (default-ON on Linear).
   - **§4 opens** iff the automation editor is visible OR a non-default automation option
     is checked: `enable-realtime-sync`/`delete-sync`/`enable-auto-pull`.
     **Exclude `complete-sync`** (default-ON on Linear).
   - This helper only **reads** existing DOM/render state and toggles wrapper visibility +
     master-checkbox `.checked`. It never feeds the collect/apply path.
   - Hook point: append the call at the end of `renderClickupSetupState()` (`:2755`) and
     `renderLinearSetupState()` (`:2871`), without modifying what those functions compute.
3. **Composition with the post-apply editors.** The `clickup-mappings-section` /
   `*-automation-section` editors keep their own `.hidden` toggling (driven by
   `setupComplete`). They live *inside* the relevant section body. Net visibility =
   section-body-open AND editor-not-hidden — both conditions compose correctly because
   they toggle different wrapper elements.

## Default & Initial-State Behavior

- Fresh install / no saved config: Section 1 visible, Section 2 visible, Sections 3 & 4
  collapsed (master toggles unchecked) — **on both tabs**, including Linear (the
  intent-based heuristic ignores Linear's default-ON `exclude-backlog`/`complete-sync`).
- Saved config with mappings/automation previously enabled: the corresponding section
  auto-expands via `syncSectionDisclosure()`.
- The master toggles are **disclosure only** — they are not part of the apply payload
  and have no `id` that any collect function reads (and use a `*-disclosure-*` namespace
  that no selector matches). Turning a master toggle off hides the body but does **not**
  clear the child checkboxes (so an accidental collapse doesn't silently change what apply
  would send). (Resolved Decision 2.)

## Edge Cases / Risks

- **Apply reads collapsed controls.** Confirmed safe: collect functions use
  `getElementById(...).checked`, independent of visibility (`:2369-2400`). A
  collapsed-but-checked option is still applied. This is intended (matches "master toggle =
  disclosure, not a kill switch") but must be called out in the UI copy so it isn't
  surprising.
- **Linear default-ON options vs. auto-expand** — see Edge-Case & Dependency Audit →
  Side Effects (primary risk; mitigated by intent-based heuristic).
- **`exclude-backlog` placement** is Section 3 (Resolved Decision 1), but it is
  deliberately excluded from §3's auto-expand test.
- **Linear has no column-mapping editor**, so Section 3 there is checkboxes + project
  filters only — the skeleton is symmetric but Section 3's body content differs. This is
  expected, not a bug.
- **`dist/` drift:** changes must be rebuilt; reviewers comparing against `dist/` will
  see a mismatch until the build runs. (Per project note: webview bugs are source-
  specific; don't debug against `dist/`.)
- **Styling regressions:** new section headers/wrappers must reuse existing CSS vars and
  classes to avoid visual drift between tabs.

## Proposed Changes

### `src/webview/setup.html` — ClickUp tab DOM (`#clickup-fields`, 638-790)

- **Context.** Currently: intro line, shared ticket-import block (643-665), then one
  `db-subsection` holding token → 7 checkboxes → apply button → summary/error → editors.
- **Logic.** Reorder into four section wrappers (reusing `db-subsection` /
  `subsection-header`):
  - §1: `clickup-setup-status`, `clickup-token-input`, then `btn-apply-clickup-config`,
    `clickup-option-summary`, `clickup-setup-error` moved up here.
  - §2: the shared ticket-import block (folder input + auto-sync), moved below the token.
  - §3 body (behind new `clickup-disclosure-kanban`): `clickup-option-create-folder`,
    `clickup-option-create-lists`, `clickup-option-create-custom-fields`,
    `clickup-option-exclude-backlog`, and `clickup-mapping-summary` +
    `clickup-mappings-section`.
  - §4 body (behind new `clickup-disclosure-automation`):
    `clickup-option-enable-realtime-sync`, `clickup-option-delete-sync`,
    `clickup-option-complete-sync`, and `clickup-automation-section`.
- **Implementation.** Pure node-move; preserve every `id` and the
  `.ticket-import-folder-input` / `.tickets-auto-sync-toggle` / `.btn-browse-ticket-folder`
  classes. Add two `*-disclosure-*` checkboxes + body wrapper `div`s with the `hidden`
  class by default.
- **Edge Cases.** Editors keep their own `setupComplete`-driven `.hidden`; they nest
  inside the §3/§4 body wrappers so visibility composes (AND).

### `src/webview/setup.html` — Linear tab DOM (`#linear-fields`, 792-945)

- **Context.** Mirror of ClickUp, plus project-filter text inputs; **no** column-mapping
  editor. `linear-option-exclude-backlog` ships `checked` (`:885`).
- **Logic.** Same four-section reorder:
  - §1: `linear-setup-status`, `linear-token-input`, `btn-apply-linear-config`,
    `linear-option-summary`, `linear-setup-error`.
  - §2: shared ticket-import block.
  - §3 body (behind `linear-disclosure-kanban`): `linear-option-map-columns`,
    `linear-option-create-label`, `linear-option-include-projects` (+ browse),
    `linear-option-exclude-projects` (+ browse), `linear-option-exclude-backlog`.
  - §4 body (behind `linear-disclosure-automation`):
    `linear-option-enable-realtime-sync`, `linear-option-enable-complete-sync`,
    `linear-option-delete-sync`, `linear-automation-section`.
- **Implementation.** Pure node-move; preserve ids and classes; add disclosure toggles +
  hidden body wrappers.
- **Edge Cases.** §3 has no editor (mapping = checkbox). Auto-expand for §3/§4 must
  exclude `exclude-backlog` and `complete-sync` (both default-ON).

### `src/webview/setup.html` — `syncSectionDisclosure()` helper (new JS)

- **Context.** A new read-only helper, called at the tail of `renderClickupSetupState()`
  (`:2755`) and `renderLinearSetupState()` (`:2871`).
- **Logic.** For each tab, set each master toggle's `.checked` and its body's `hidden`
  class per the §3/§4 intent rules in Accordion Mechanics step 2. Also wire each master
  toggle's `change` listener to toggle its body's `hidden` class.
- **Implementation.** Reads `getElementById(...).checked` / `.value` and
  `*-section`.classList.contains('hidden'); writes only wrapper `hidden` + master-toggle
  `.checked`. Never calls collect/apply, never posts a message.
- **Edge Cases.** Must run after the render functions set child state (hence the tail
  hook). Idempotent — safe to call on every render.

## Verification Plan

> Per session directive, **automated tests and project compilation are skipped** and will
> be run separately by the user. No automated webview test harness exists in this repo.

### Automated Tests
- None added. (No webview test infrastructure exists; the session directive defers the
  test suite to the user.)

### Manual Verification (in the running extension webview)
1. **Fresh state, ClickUp:** only token (§1) + ticket-import (§2) visible; §3/§4 collapsed.
2. **Fresh state, Linear (REGRESSION GUARD):** §3/§4 **collapsed** despite
   `exclude-backlog`/`complete-sync` defaulting ON — confirms the intent-based heuristic.
3. Enter token, apply → status updates, summary + error render **in §1** (next to the
   button), no errors. Confirm this alone makes the provider available in the
   `planning.html` Tickets tab.
4. Expand §3, check intent options, apply → column-mappings editor appears (ClickUp),
   state persists across reload, and §3 auto-expands on reload.
5. Expand §4 independently of §3 → automation editor + rules behave; auto-expands on
   reload when configured.
6. Toggle ticket-import folder / auto-sync in the ClickUp tab → verify it mirrors into the
   Linear tab (and vice versa) — class-based mirroring (`:3253-3270`) preserved.
7. **Disclosure-not-killswitch:** collapse a section with checked children, click apply →
   confirm the checked options are still applied.
8. **Id-collision guard:** confirm no `*-disclosure-*` toggle id matches anything read by
   `collectClickupApplyOptions` / `collectLinearApplyOptions`.

## Resolved Decisions

These were open questions; the user accepted all three recommendations (2026-06-19):

1. **`exclude-backlog` placement** → **RESOLVED: Section 3** (Kanban board mapping /
   import scope). Not moved into Section 2. *(Implementation note: excluded from §3's
   auto-expand signal because it defaults ON on Linear.)*
2. **Collapse semantics** → **RESOLVED: disclosure-only.** The master toggle shows/hides
   the section body and does **not** clear or reset child options when collapsed. A
   collapsed-but-checked option is still sent on apply. UI copy must make this clear so
   it isn't surprising.
3. **Apply button position** → **RESOLVED: under Section 1** (directly below the token),
   to optimize the default "paste token → apply → done" flow. The single apply button
   still commits all sections.

---

**Recommendation: Send to Coder.** Complexity 5 (≤ 6). Routine single-file presentation
refactor; the one real risk (the `syncSectionDisclosure()` heuristic vs. Linear's
default-ON options) is fully specified above with a concrete mitigation.
