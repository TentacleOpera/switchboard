# Hide Triage Pipeline + Kanban Mapping/Automation Setup Sections (Pre-Release UI Gate)

## Goal

Make the half-baked ClickUp/Linear board-automation features **unreachable in the UI** so the next release can ship without testing them. This is a **UI-only, hide-only** change to `src/webview/setup.html` — no backend edits, no behavior changes, no deletions. The underlying services and config are left untouched; users simply can't open these controls.

### Problem & background

The ClickUp and Linear setup tabs expose three surfaces that drive the confusing, under-tested board-automation apparatus (triage pipeline, column mapping, automation rules — ~20 checkboxes for what should be a simple concept). The intended redesign — a single "auto-assign synced tickets to an agent" control on the planning.html Tickets tab — is a **separate future project**. In the meantime, we want to ship other improvements without shipping (or having to QA) these features. Hiding the entry points is the fastest safe gate.

**Correction to the original request:** these sections live on the **ClickUp and Linear** tabs, not Notion. Notion's setup tab (`#notion-fields`) is the remote-control flow and has no triage button, board mapping, or automation section. Hiding anything on Notion would be a no-op and would miss the live ClickUp controls. This plan therefore targets ClickUp + Linear.

## Scope

- **File:** `src/webview/setup.html` only.
- **Change type:** hide (not remove) — keep elements in the DOM so existing render/collect/disclosure JS keeps resolving them and never hits a null.
- **Method:** set `style="display:none"` on each target wrapper (inline `display:none` reliably overrides any existing inline `display`); wrap the triage button trio in a single hidden container.
- **No changes** to `.js`, services, message handlers, config schema, or the `APPLY CLICKUP/LINEAR SETTINGS` flow.

## Exact hide targets

### ClickUp tab (`#clickup-fields`)
1. **Triage block** — the button + its hint + result div (lines ~767–771):
   - `#btn-enable-triage-clickup` (L767)
   - the `.hint-text` description div immediately following (L768–770)
   - `#clickup-triage-result` (L771)
   → wrap these three in a `<div style="display:none">…</div>`.
2. **"2. Kanban Board Mapping"** — the `div.db-subsection` wrapper at **L777** (comment `<!-- Section 2: Kanban Board Mapping -->` at L776), closing at L841 → add `display:none`.
3. **"3. Kanban Automation"** — the `div.db-subsection` wrapper at **L844** (comment at L843), closing at L907 → add `display:none`.

### Linear tab (`#linear-fields`)
1. **Triage block** (lines ~964–968):
   - `#btn-enable-triage-linear` (L964)
   - the `.hint-text` description div (L965–967)
   - `#linear-triage-result` (L968)
   → wrap in a `<div style="display:none">…</div>`.
2. **"2. Kanban Board Mapping"** — the `div.db-subsection` wrapper at **L974** (comment at L973), closing at L1037 → add `display:none`.
3. **"3. Kanban Automation"** — the `div.db-subsection` wrapper at **L1040** (comment at L1039), closing at L1103 → add `display:none`.

## What stays visible / working (do NOT hide)

- **Connection/config** for both providers (token, folder/team/list selection) and the **`APPLY CLICKUP SETTINGS` / `APPLY LINEAR SETTINGS`** buttons (L766 / L963).
- **Tickets auto-sync toggle** (`.tickets-auto-sync-toggle`) — this is the ticket-sync path the future redesign builds on; leave it.
- The **Multi-Repo "mappings" tab** (`#mappings-fields`, workspace-to-database mapping) — unrelated to kanban board mapping; leave untouched.
- The **Notion tab** — untouched.

## Why hide (not remove) is safe

- **No JS breakage.** Render functions (`renderClickupMappings`, `renderClickupAutomation`, `renderLinearAutomation`), disclosure logic (`syncSectionDisclosure`), and collectors (`collectClickupMappings`, etc.) look elements up by ID. With `display:none` the elements remain in the DOM, so every `getElementById`/`querySelectorAll` still resolves — the functions just populate/read hidden nodes harmlessly.
- **No behavior change.** The hidden checkboxes retain their default (unchecked) values, so `APPLY …` collects the safe defaults (kanban sync off, automation off). Nothing new is enabled.
- **Existing users preserved.** This is UI-only: anyone who previously configured mappings/automation keeps their saved config in the DB; they just can't edit it via these panels while hidden. No data is deleted or migrated.

## Out of scope

- Deleting or refactoring the triage/automation/mapping backend (the future "simple ticket auto-assign on the Tickets tab" project).
- Any change to sync behavior, config schema, or message routing.
- The Notion tab and the Multi-Repo mapping tab.

## Verification (visual, no suite run)

1. Open Setup → **ClickUp** tab: the ENABLE TRIAGE PIPELINE button, "2. Kanban Board Mapping", and "3. Kanban Automation" sections are gone; connection fields + APPLY CLICKUP SETTINGS remain; Tickets auto-sync toggle remains.
2. Open Setup → **Linear** tab: same three surfaces gone; connection fields + APPLY LINEAR SETTINGS + Tickets auto-sync toggle remain.
3. **Notion** tab and **Multi-Repo** tab: unchanged.
4. Open the browser devtools console on the webview: no null-reference errors on load or when clicking APPLY (confirms the hidden-not-removed approach holds).

## Metadata

**Complexity:** 2
**Tags:** ui, frontend
**Repo:** switchboard
