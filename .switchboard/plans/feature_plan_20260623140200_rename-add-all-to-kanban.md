# Rename "Import all to kanban" button to "Add all to Kanban"

## Goal (Problem analysis + Root Cause with cited file:line)

In planning.html's Tickets tab, the strip button that imports all loaded tickets onto the Kanban board is labelled **"Import all to kanban"**. The requested change is to relabel it **"Add all to Kanban"** to match the verb ("Add to Kanban") used elsewhere in the product UI, and to capitalize "Kanban" correctly.

Root cause / source of the label:
- `src/webview/planning.html:3561` — the only place the visible label text exists:
  ```html
  <button id="tickets-import-all-kanban" class="strip-btn" title="Import all tickets as Switchboard plans" style="display:none">Import all to kanban</button>
  ```
  The visible text is the static node text `Import all to kanban`. The `title` tooltip is a *different* phrasing ("Import all tickets as Switchboard plans") — see Edge-Case audit for the decision on it.

Confirmed that the label is **never set dynamically** in JS — `src/webview/planning.js` only toggles `style.display` and `disabled` on this button (lines 7620, 7879, 6577, 6604, 3927–3929); it never assigns `textContent`/`innerHTML`. So the static HTML text is the single source of truth for the visible label.

The "Add to Kanban" verb already exists in sibling UI, which is the consistency target:
- `src/webview/project.html:1363` — label "Add to Kanban board"
- `src/webview/setup.html:721` and `src/webview/setup.html:925` — help text: "use 'Add to Kanban' to promote a ticket to the board."

So renaming this button to "Add all to Kanban" aligns the bulk action with the per-ticket "Add to Kanban" wording.

## Metadata
- **Complexity:** 1
- **Tags:** ui, ux, frontend

## User Review Required
- No user review required. Both the visible-label rename and the tooltip reword are confirmed in scope (user confirmed 2026-06-23).

## Complexity Audit

### Routine
- Single static-text edit in `planning.html` (line 3561).
- Optional companion tooltip reword on the same element (same line).
- No build/compile step required — `src/` is the source of truth; `dist/` is build output and is NOT used during development or testing (per project `CLAUDE.md`). The change is verified via an installed VSIX, not by auditing `dist/`.

### Complex / Risky
- None. No message/command name, element id, event wiring, or state is touched.

## Edge-Case & Dependency Audit

- **Element id stays the same.** `id="tickets-import-all-kanban"` is referenced in `planning.js` at lines 992, 3927, 7619, 7878 and in the comment at `planning.html:377`. Do NOT change the id — only the human-visible text node changes.
- **Message/command name stays the same.** The click handler (`planning.js:6589`) posts `{ type: 'importAllTickets', ... }` (also lines 4494, 4670, 6580, 6607). This is the backend contract — leave it as `importAllTickets`. No backend/migration impact; this is purely a label string.
- **No persisted/shipped state.** A button label is not stored anywhere (no DB `config`, no settings). No migration concerns despite the ~4,000-install base — this is display text only.
- **Dynamic text:** none. Verified `planning.js` never assigns `textContent`/`innerHTML` to this button, so the static HTML is the only label. No "Importing…"-style progress relabel exists for this button.
- **`title` tooltip:** currently "Import all tickets as Switchboard plans" — a separate phrasing from the visible label. Confirmed in scope: update the tooltip to **"Add all tickets to the Kanban board"** so the hover text matches the new "Add … to Kanban" verb and no longer says "Import". This keeps button + tooltip consistent. (The id and message name remain unchanged.)
- **No confirmation dialog involved** — this button executes the bulk add immediately; nothing in this change adds or implies a confirm gate.
- **Other tickets-tab strip buttons** ("Link all" at `planning.html:3560`, plus sync/link wording) are unrelated actions and are intentionally left unchanged.

## Dependencies
- None. No prerequisite sessions or plans.

## Adversarial Synthesis

Key risks: stale line-number citations could send the implementer to wrong locations; inventing non-allowed tags violates the workflow schema; a `npm run compile`/`dist/` audit step would violate the project `CLAUDE.md` rule that `dist/` is not used in dev/testing. Mitigations: all line numbers re-verified against current `src/`; tags restricted to the allowed list; the build/compile verification step removed in favor of source-only grep + manual VSIX smoke test.

## Proposed Changes

### `src/webview/planning.html` (line 3561)

Before:
```html
<button id="tickets-import-all-kanban" class="strip-btn" title="Import all tickets as Switchboard plans" style="display:none">Import all to kanban</button>
```

After:
```html
<button id="tickets-import-all-kanban" class="strip-btn" title="Add all tickets to the Kanban board" style="display:none">Add all to Kanban</button>
```

Changes:
1. Visible text: `Import all to kanban` → `Add all to Kanban`.
2. `title` tooltip: `Import all tickets as Switchboard plans` → `Add all tickets to the Kanban board` (consistency with the new verb).
3. `id`, `class`, and `style` are untouched.

No changes to `src/webview/planning.js` (id and message name preserved).

No changes to `project.html` / `setup.html` (they already use "Add to Kanban").

## Verification Plan

> Per session directives: SKIP COMPILATION and SKIP TESTS. Per `CLAUDE.md`: do NOT audit or flag `dist/` staleness — `src/` is the source of truth and runtime testing is via an installed VSIX, not the repo's `dist/`.

### Automated Tests
- None required (pure copy change; test suite run separately by the user).

### Source-only verification (no build, no dist audit)
1. Apply the edit to `src/webview/planning.html:3561` only.
2. Grep to confirm the old visible string is gone and the new one is present in `src/`:
   ```bash
   grep -rn "Import all to kanban" src/        # expect: no matches
   grep -rn "Add all to Kanban" src/           # expect: src/webview/planning.html:3561
   ```
3. Confirm the wiring is intact (id + message name unchanged):
   ```bash
   grep -n "tickets-import-all-kanban" src/webview/planning.js   # expect lines 992/3927/7619/7878 unchanged
   grep -n "importAllTickets" src/webview/planning.js            # expect message type unchanged (4494/4670/6580/6607)
   ```
4. Manual smoke test via installed VSIX in the Planning panel → Tickets tab: load a Linear or ClickUp project so the button shows (`planning.js:7620` / `7879` toggle `display`), confirm it reads **"Add all to Kanban"**, hover shows the new tooltip, and clicking still performs the bulk add (posts `importAllTickets`).

## Recommendation
Complexity 1 → **Send to Intern**.
