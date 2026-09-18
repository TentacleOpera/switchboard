# Rename "Import all to kanban" button to "Add all to Kanban"

## Goal (Problem analysis + Root Cause with cited file:line)

In planning.html's Tickets tab, the strip button that imports all loaded tickets onto the Kanban board is labelled **"Import all to kanban"**. The requested change is to relabel it **"Add all to Kanban"** to match the verb ("Add to Kanban") used elsewhere in the product UI, and to capitalize "Kanban" correctly.

Root cause / source of the label:
- `src/webview/planning.html:3561` — the only place the visible label text exists:
  ```html
  <button id="tickets-import-all-kanban" class="strip-btn" title="Import all tickets as Switchboard plans" style="display:none">Import all to kanban</button>
  ```
  The visible text is the static node text `Import all to kanban`. The `title` tooltip is a *different* phrasing ("Import all tickets as Switchboard plans") — see Edge-Case audit for the decision on it.

Confirmed that the label is **never set dynamically** in JS — `src/webview/planning.js` only toggles `style.display` and `disabled` on this button (lines 7635, 7894, 6596, 6623, 3939–3943); it never assigns `textContent`/`innerHTML`. So the static HTML text is the single source of truth for the visible label.

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

- **Element id stays the same.** `id="tickets-import-all-kanban"` is referenced in `planning.js` at lines 1014, 3939, 3943, 7635, 7894 and in the comment at `planning.html:377`. Do NOT change the id — only the human-visible text node changes.
- **Message/command name stays the same.** The click handler (`planning.js:6596`) posts `{ type: 'importAllTickets', ... }` (also lines 4510, 4686, 6596, 6623). This is the backend contract — leave it as `importAllTickets`. No backend/migration impact; this is purely a label string.
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
   grep -n "tickets-import-all-kanban" src/webview/planning.js   # expect lines 1014/3939/3943/7635/7894 unchanged
   grep -n "importAllTickets" src/webview/planning.js            # expect message type unchanged (4510/4686/6596/6623)
   ```
4. Manual smoke test via installed VSIX in the Planning panel → Tickets tab: load a Linear or ClickUp project so the button shows (`planning.js:7635` / `7894` toggle `display`), confirm it reads **"Add all to Kanban"**, hover shows the new tooltip, and clicking still performs the bulk add (posts `importAllTickets`).

## Recommendation
Complexity 1 → **Send to Intern**.

---

## Review Pass (2026-06-23)

### Stage 1 — Adversarial Findings
| Severity | Finding |
|---|---|
| NIT | Plan body cited stale `planning.js` line numbers (id: 992/3927/7619/7878; message: 4494/4670/6580/6607; handler: 6589; display toggles: 7620/7879) that did not match the actual file (id: 1014/3939/3943/7635/7894; message: 4510/4686/6596/6623; handler: 6596; display toggles: 7635/7894). This contradicted the plan's own "all line numbers re-verified" claim in Adversarial Synthesis. Informational only — did not mislead the implementer; the edit landed correctly. |

No CRITICAL or MAJOR code findings. The code change matches the spec exactly.

### Stage 2 — Balanced Synthesis
- **Keep:** Code change is correct and complete (visible label, tooltip, id, class, style, message contract all match spec).
- **Fix now:** Updated stale `planning.js` line citations in the plan body (Root Cause line 14, Edge-Case Audit lines 41–42, Verification Plan lines 95–98) to reflect actual line numbers.
- **Defer:** Nothing — closed complexity-1 change.

### Code Fixes Applied
- None required. The implementation in `src/webview/planning.html:3561` was already correct.

### Plan Fixes Applied
- Corrected stale `planning.js` line-number citations in three sections of this plan file to match the actual file contents (see Stage 2).

### Files Changed
- `src/webview/planning.html:3561` — visible label `Import all to kanban` → `Add all to Kanban`; tooltip `Import all tickets as Switchboard plans` → `Add all tickets to the Kanban board`. (Pre-existing implementation; confirmed correct during this review.)
- `.switchboard/plans/feature_plan_20260623140200_rename-add-all-to-kanban.md` — stale line citations corrected; this Review Pass section appended.

### Validation Results (source-only; no compile, no tests per session directives)
1. `grep -rn "Import all to kanban" src/` → **0 matches** ✓
2. `grep -rn "Import all tickets as Switchboard plans" src/` → **0 matches** ✓
3. `grep -n "Add all to Kanban" src/webview/planning.html` → **line 3561** ✓
4. `grep -n "tickets-import-all-kanban" src/webview/planning.js` → lines 1014, 3939, 3943, 7635, 7894 (id intact) ✓
5. `grep -n "importAllTickets" src/webview/planning.js` → lines 3939, 4510, 4686, 6596, 6623, 8678 (message type intact) ✓
6. Sibling UI consistency confirmed: `project.html:1363` "Add to Kanban board"; `setup.html:721` & `:925` "Add to Kanban" help text — all unchanged and consistent with the new label. ✓
7. No `textContent`/`innerHTML` assignment to `#tickets-import-all-kanban` found in `planning.js` — static HTML remains the single source of truth. ✓

### Remaining Risks
- None material. The only residual item is the manual VSIX smoke test (Verification Plan step 4), which cannot be executed in this session and is left for the user.
