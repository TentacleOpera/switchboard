# Rename "Import all to kanban" button to "Add all to Kanban"

## Goal (Problem analysis + Root Cause with cited file:line)

In planning.html's Tickets tab, the strip button that imports all loaded tickets onto the Kanban board is labelled **"Import all to kanban"**. The requested change is to relabel it **"Add all to Kanban"** to match the verb ("Add to Kanban") used elsewhere in the product UI, and to capitalize "Kanban" correctly.

Root cause / source of the label:
- `src/webview/planning.html:3545` — the only place the visible label text exists:
  ```html
  <button id="tickets-import-all-kanban" class="strip-btn" title="Import all tickets as Switchboard plans" style="display:none">Import all to kanban</button>
  ```
  The visible text is the static node text `Import all to kanban`. The `title` tooltip is a *different* phrasing ("Import all tickets as Switchboard plans") — see Edge-Case audit for the decision on it.

Confirmed that the label is **never set dynamically** in JS — `src/webview/planning.js` only toggles `style.display` and `disabled` on this button (lines 7474–7475, 7733–7734, 6432, 6459, 3866–3868); it never assigns `textContent`/`innerHTML`. So the static HTML text is the single source of truth for the visible label.

The "Add to Kanban" verb already exists in sibling UI, which is the consistency target:
- `src/webview/project.html:1363` — label "Add to Kanban board"
- `src/webview/setup.html:716` and `src/webview/setup.html:915` — help text: "use 'Add to Kanban' to promote a ticket to the board."

So renaming this button to "Add all to Kanban" aligns the bulk action with the per-ticket "Add to Kanban" wording.

## Metadata
- **Complexity:** 1
- **Tags:** ui, copy-change, planning-webview, tickets-tab, low-risk

## Complexity Audit

### Routine
- Single static-text edit in `planning.html` (line 3545).
- Rebuild webpack so `dist/webview/planning.html` is regenerated (the `dist/` copy at line 3545 is build output, do NOT hand-edit it).

### Complex/Risky
- None. No message/command name, element id, event wiring, or state is touched.

## Edge-Case & Dependency Audit

- **Element id stays the same.** `id="tickets-import-all-kanban"` is referenced in `planning.js` at lines 935, 3866, 7474, 7733 and in the comment at `planning.html:377`. Do NOT change the id — only the human-visible text node changes.
- **Message/command name stays the same.** The click handler (`planning.js:6444`) posts `{ type: 'importAllTickets', ... }` (also lines 4433, 4609, 6435, 6462). This is the backend contract — leave it as `importAllTickets`. No backend/migration impact; this is purely a label string.
- **No persisted/shipped state.** A button label is not stored anywhere (no DB `config`, no settings). No migration concerns despite the ~4,000-install base — this is display text only.
- **Dynamic text:** none. Verified `planning.js` never assigns `textContent`/`innerHTML` to this button, so the static HTML is the only label. No "Importing…"-style progress relabel exists for this button.
- **`title` tooltip:** currently "Import all tickets as Switchboard plans" — a separate phrasing from the visible label, describing what the action does (creates Switchboard plans). The issue asks to rename the **label** and "ensure consistency." Decision: update the tooltip to **"Add all tickets to the Kanban board"** so the hover text matches the new "Add … to Kanban" verb and no longer says "Import". This keeps button + tooltip consistent. (The id and message name remain unchanged.)
- **No confirmation dialog involved** — this button executes the bulk add immediately; nothing in this change adds or implies a confirm gate.
- **Other tickets-tab strip buttons** ("Link all" at `planning.html:3544`, plus sync/link wording) are unrelated actions and are intentionally left unchanged.

## Proposed Changes

### `src/webview/planning.html` (line 3545)

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

1. Apply the edit to `src/webview/planning.html:3545` only.
2. Rebuild so the change reaches the runtime copy:
   ```bash
   npm run compile
   ```
   Confirm webpack succeeds and `dist/webview/planning.html` now contains `Add all to Kanban` (it should be regenerated from `src/`).
3. Grep to confirm the old strings are gone from `src/` and `dist/`:
   ```bash
   grep -rn "Import all to kanban" src/ dist/        # expect: no matches
   grep -rn "Add all to Kanban" src/ dist/           # expect: planning.html (src + dist)
   ```
4. Confirm the wiring is intact (id + message name unchanged):
   ```bash
   grep -n "tickets-import-all-kanban" src/webview/planning.js   # expect lines 935/3866/7474/7733 unchanged
   grep -n "importAllTickets" src/webview/planning.js            # expect message type unchanged
   ```
5. Manual smoke test in the Planning panel → Tickets tab: load a Linear or ClickUp project so the button shows (`planning.js:7475` / `7734` toggle `display`), confirm it reads **"Add all to Kanban"**, hover shows the new tooltip, and clicking still performs the bulk add (posts `importAllTickets`).
