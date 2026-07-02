# Hide Triage Pipeline + Kanban Mapping/Automation Setup Sections (Pre-Release UI Gate)

**Plan ID:** f4a8b2c6-9d3e-4a1b-8f5c-2e7d6a5b4c91

## Goal

Make the half-baked ClickUp/Linear board-automation features **unreachable in the UI** so the next release can ship without testing them. This is a **UI-only, hide-only** change to `src/webview/setup.html` — no backend edits, no behavior changes, no deletions. The underlying services and config are left untouched; users simply can't open these controls.

### Problem & background (root cause)

The ClickUp and Linear setup tabs expose three surfaces that drive the confusing, under-tested board-automation apparatus (triage pipeline, column mapping, automation rules — ~20 checkboxes for what should be a simple concept). The intended redesign — a single "auto-assign synced tickets to an agent" control on the planning.html Tickets tab — is a **separate future project**. In the meantime, we want to ship other improvements without shipping (or having to QA) these features. Hiding the entry points is the fastest safe gate.

**Root cause:** these controls shipped into the setup UI before their behavior was validated end-to-end, and they expose enough surface area (~20 checkboxes across mapping + automation + triage) that QA-ing them blocks the release of unrelated improvements. The gate is UI-level because the backend is harmless when its controls are never toggled — the risk is a user enabling a half-baked automation, not the code existing.

**Correction to the original request:** these sections live on the **ClickUp and Linear** tabs, not Notion. Notion's setup tab (`#notion-fields`) is the remote-control flow and has no triage button, board mapping, or automation section. Hiding anything on Notion would be a no-op and would miss the live ClickUp controls. This plan therefore targets ClickUp + Linear.

## Metadata

**Complexity:** 2
**Tags:** ui, frontend

## User Review Required

No — pure UI hide with no product-scope decisions. The set of hidden surfaces and the set of
preserved surfaces are both explicitly enumerated below; there is no judgment call left open.

## Complexity Audit

### Routine
- Adding `display:none` to inline `style` attributes on six target wrappers/elements in one HTML file.
- All target line ranges verified exact against current source (ClickUp L767-771, L777-841, L844-907; Linear L964-968, L974-1037, L1040-1103).
- No JS, no services, no config schema, no message handlers touched.

### Complex / Risky
- None. The only verification is visual + a devtools console null-reference check.

## Edge-Case & Dependency Audit

- **Race Conditions:** none — static HTML; no runtime state involved.
- **Security:** none — UI visibility only; no auth, no data exposure change.
- **Side Effects:**
  - Hidden checkboxes are no longer user-toggleable. On reload with **saved DB config**,
    render functions (`renderClickupMappings`, `renderLinearAutomation`) may pre-populate
    disclosure checkboxes from saved state inside the hidden sections. This is safe: `APPLY
    CLICKUP/LINEAR SETTINGS` re-collects the **same saved state** and re-applies it — no new
    feature is enabled. The safety guarantee is "no new enablement," NOT "checkboxes are
    unchecked" (they may be pre-checked from saved config on reload).
  - Parent `display:none` wins over any child un-hide: even if JS removes the `hidden` class
    from a body div inside a hidden section, the section wrapper's `display:none` hides the
    entire subtree. Verified: `.db-subsection` (setup.html:220-223) has no `display` rule, so
    inline `display:none` wins trivially.
- **Dependencies & Conflicts:** none — isolated to `src/webview/setup.html`.

## Dependencies

- None. Independent UI gate.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the original "wrap the triage trio in a new `<div>`" method
inserts a DOM node in a plan titled "hide-only, no DOM changes" — refined to inline
`display:none` per-element for consistency with the section 2/3 approach (zero new nodes);
(2) the "hidden checkboxes retain unchecked defaults" reasoning was only true on first load —
corrected to "APPLY re-collects saved state, no new enablement," since render functions may
pre-check from DB config on reload (outcome still safe); (3) JS-safety claim verified — triage
listeners use `?.addEventListener` (L3454/3463) and the `triagePipelineResult` handler guards
with `if (btn)`/`if (resultEl)` (L4780-4782), and hidden elements still resolve via
`getElementById`. Mitigations: inline-per-element hide, corrected safety reasoning, verified
null-guard coverage.

## Proposed Changes

### `src/webview/setup.html`

**Context:** The ClickUp tab (`#clickup-fields`) and Linear tab (`#linear-fields`) each expose
three pre-release surfaces: a triage-pipeline button + hint + result div, a "Kanban Board
Mapping" section, and a "Kanban Automation" section. All six targets verified at exact line
ranges against current source. The `.db-subsection` class (L220-223) defines only
`padding-bottom` + `border-bottom` — no `display` rule — so inline `display:none` wins cleanly.

**Logic — hide method (inline per-element, no DOM restructuring):**
For each target, append `display:none;` to the element's existing inline `style` attribute.
This is consistent across all six targets, inserts zero new DOM nodes, and matches the
"hide-not-remove" intent. (The original "wrap the triage trio in a new div" approach also works
— `display:none` removes the wrapper from layout entirely so there's no spacing shift — but it
adds a structural node unnecessarily; inline-per-element is cleaner.)

**ClickUp tab (`#clickup-fields`):**
1. **Triage block** (L767-771) — add `display:none;` to each of the three elements' inline style:
   - `#btn-enable-triage-clickup` (L767): `style="margin-top: 8px;"` → `style="margin-top: 8px; display:none;"`
   - `.hint-text` description div (L768-770): `style="margin-top:6px;"` → `style="margin-top:6px; display:none;"`
   - `#clickup-triage-result` (L771): append `display:none;` to its existing inline style.
   - **Do NOT hide** `#clickup-option-summary` (L772) or `#clickup-setup-error` (L773) — they stay visible.
2. **"2. Kanban Board Mapping"** — the `div.db-subsection` wrapper at **L777** (comment `<!-- Section 2: Kanban Board Mapping -->` at L776), closing at L841 → append `display:none;` to its inline `style`.
3. **"3. Kanban Automation"** — the `div.db-subsection` wrapper at **L844** (comment at L843), closing at L907 → append `display:none;` to its inline `style`.

**Linear tab (`#linear-fields`):**
1. **Triage block** (L964-968) — add `display:none;` to each of the three elements' inline style:
   - `#btn-enable-triage-linear` (L964): `style="margin-top: 8px;"` → `style="margin-top: 8px; display:none;"`
   - `.hint-text` description div (L965-967): `style="margin-top:6px;"` → `style="margin-top:6px; display:none;"`
   - `#linear-triage-result` (L968): append `display:none;` to its existing inline style.
   - **Do NOT hide** `#linear-option-summary` (L969) or `#linear-setup-error` (L970) — they stay visible.
2. **"2. Kanban Board Mapping"** — the `div.db-subsection` wrapper at **L974** (comment at L973), closing at L1037 → append `display:none;` to its inline `style`.
3. **"3. Kanban Automation"** — the `div.db-subsection` wrapper at **L1040** (comment at L1039), closing at L1103 → append `display:none;` to its inline `style`.

**Edge Cases:**
- Disclosure checkboxes (`clickup-disclosure-kanban` L783, `clickup-disclosure-automation` L850, and the Linear equivalents) live inside the hidden sections. When hidden, they're unchecked by default on first load; on reload with saved config they may be pre-checked by render functions — either way the parent `display:none` hides the whole subtree, and `APPLY` re-collects saved state (no new enablement).
- Triage button event listeners (L3454/3463) use `?.addEventListener` — attaching a listener to a hidden button is harmless (never clicked). The `triagePipelineResult` message handler (L4780-4782) writes to hidden result divs via guarded `if (resultEl)` — harmless (writes to hidden DOM).
- No new `confirm()`/`window.confirm()` introduced (none needed). CLAUDE.md confirm-ban respected.

## What stays visible / working (do NOT hide)

- **Connection/config** for both providers (token, folder/team/list selection) and the **`APPLY CLICKUP SETTINGS` / `APPLY LINEAR SETTINGS`** buttons (L766 / L963).
- **Tickets auto-sync toggle** (`.tickets-auto-sync-toggle`) — this is the ticket-sync path the future redesign builds on; leave it.
- The **Multi-Repo "mappings" tab** (`#mappings-fields`, workspace-to-database mapping) — unrelated to kanban board mapping; leave untouched.
- The **Notion tab** (`#notion-fields`) — untouched; it has no triage/mapping/automation surfaces.
- `#clickup-option-summary`, `#clickup-setup-error`, `#linear-option-summary`, `#linear-setup-error` — stay visible (error/summary feedback must remain reachable).

## Why hide (not remove) is safe

- **No JS breakage.** Render functions (`renderClickupMappings`, `renderClickupAutomation`, `renderLinearAutomation`), disclosure logic (`syncSectionDisclosure`), and collectors (`collectClickupMappings`, etc.) look elements up by ID. With `display:none` the elements remain in the DOM, so every `getElementById`/`querySelectorAll` still resolves — the functions just populate/read hidden nodes harmlessly. Verified: triage listeners use `?.addEventListener` (L3454/3463) and the result handler guards with `if (btn)`/`if (resultEl)` (L4780-4782).
- **No behavior change.** The hidden checkboxes retain their saved DB state on reload (unchecked on first load, possibly pre-checked from saved config on reload). `APPLY …` re-collects the same saved state and re-applies it — nothing new is enabled, nothing existing is disabled.
- **Existing users preserved.** This is UI-only: anyone who previously configured mappings/automation keeps their saved config in the DB; they just can't edit it via these panels while hidden. No data is deleted or migrated.

## Out of scope

- Deleting or refactoring the triage/automation/mapping backend (the future "simple ticket auto-assign on the Tickets tab" project).
- Any change to sync behavior, config schema, or message routing.
- The Notion tab and the Multi-Repo mapping tab.

## Verification Plan

### Automated Tests
- **SKIP for this session** per session directives. This is a UI-visibility-only change with no
  logic; no unit/integration tests apply. Tests to author for a separate run (optional, low value):
  - A DOM-structure assertion that the six target elements carry `display:none` in their inline style.
  - A regression guard that `getElementById` still resolves all six IDs after the hide (confirms hide-not-remove).

### Manual / Static Verification (this session)
- **Compilation SKIP** per session directives (HTML-only change, no TS compiled).
- Static cross-check (done during review): all six target line ranges verified exact against
  current `src/webview/setup.html` source; `.db-subsection` CSS (L220-223) confirmed to have no
  `display` rule; triage listener null-guards (L3454/3463/4780-4782) confirmed.
- Pre-merge checklist: grep for any new `confirm(`/`window.confirm` — forbidden per CLAUDE.md (none introduced).

### Visual verification (post-implementation, no suite run)
1. Open Setup → **ClickUp** tab: the ENABLE TRIAGE PIPELINE button, "2. Kanban Board Mapping", and "3. Kanban Automation" sections are gone; connection fields + APPLY CLICKUP SETTINGS remain; Tickets auto-sync toggle remains; option-summary + setup-error divs remain.
2. Open Setup → **Linear** tab: same three surfaces gone; connection fields + APPLY LINEAR SETTINGS + Tickets auto-sync toggle + option-summary + setup-error remain.
3. **Notion** tab and **Multi-Repo** tab: unchanged.
4. Open the browser devtools console on the webview: no null-reference errors on load or when clicking APPLY (confirms the hidden-not-removed approach holds).

## Acceptance
- On the ClickUp tab, the triage button + hint + result, "2. Kanban Board Mapping", and "3. Kanban Automation" are not visible; APPLY CLICKUP SETTINGS, connection fields, tickets-auto-sync toggle, option-summary, and setup-error remain.
- On the Linear tab, the same three surfaces are not visible; APPLY LINEAR SETTINGS, connection fields, tickets-auto-sync toggle, option-summary, and setup-error remain.
- Notion tab and Multi-Repo mappings tab are unchanged.
- No devtools console errors on load or on clicking either APPLY button.
- No new DOM nodes inserted (inline `display:none` per-element, not wrapper insertion).

## Recommendation

Complexity 2 → **Send to Intern.** Six inline `display:none` additions in one HTML file, all
targets verified at exact line ranges. No logic, no JS, no backend.
