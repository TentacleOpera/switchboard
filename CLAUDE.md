# Switchboard — agent rules

## NEVER add confirmation dialogs. NO EXCEPTIONS.

Delete buttons delete immediately. No `confirm()`, no `window.confirm()`, no modal `showWarningMessage`, no two-click patterns, no "Are you sure?". The user has demanded this repeatedly. Buttons are deliberately hard to misclick.

Also a hard technical reason: `window.confirm()` is a **silent no-op in VS Code webviews** (sandboxed iframe without `allow-modals` — it always returns `false`). Any confirm gate added to `src/webview/planning.js`, `src/webview/kanban.html`, etc. makes the button do *literally nothing*. This exact bug broke the kanban delete-plan button (fixed 2026-06-11).

If you find a confirm gate in this codebase, it is a bug — remove it. Multi-choice decision dialogs (e.g. 3-way conflict resolution) are allowed; plain confirm gates are not.

## Build

- `npm run compile` (webpack) builds to `dist/` — the extension runs from `dist/extension.js` and serves webviews from `dist/webview/`. Always rebuild after editing `src/webview/*`.

## Misc

- Dev-only project, single user: no migrations, no backwards-compat shims — prefer clean breaks.
