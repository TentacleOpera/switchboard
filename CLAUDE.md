# Switchboard — agent rules

## NEVER add confirmation dialogs. NO EXCEPTIONS.

Delete buttons delete immediately. No `confirm()`, no `window.confirm()`, no modal `showWarningMessage`, no two-click patterns, no "Are you sure?". The user has demanded this repeatedly. Buttons are deliberately hard to misclick.

Also a hard technical reason: `window.confirm()` is a **silent no-op in VS Code webviews** (sandboxed iframe without `allow-modals` — it always returns `false`). Any confirm gate added to `src/webview/planning.js`, `src/webview/kanban.html`, etc. makes the button do *literally nothing*. This exact bug broke the kanban delete-plan button (fixed 2026-06-11).

If you find a confirm gate in this codebase, it is a bug — remove it. Multi-choice decision dialogs (e.g. 3-way conflict resolution) are allowed; plain confirm gates are not.

## Build

- `npm run compile` (webpack) builds to `dist/`, but **`dist/` is NOT used during development or testing**. All testing is done via an installed VSIX — nothing is served from the repo's `dist/` directory. Do NOT audit, check, or flag `dist/` staleness during reviews or verification. Treat `src/` as the source of truth. `npm run compile` is only needed when producing a VSIX for release.

## Users & migrations

- **Published extension, ~4,000 installs**, many on much older versions. The dividing line is whether the state **shipped in a released version**:
  - State/files/settings that exist in any released version MUST be migrated on change: import before deleting, archive legacy files as `*.migrated.bak` rather than unlinking, preserve unknown/legacy keys instead of dropping them, and never assume a prior migration "already ran" for the install base.
  - Features that have only ever existed in unreleased dev work can take clean breaks — no migrations, no compat shims.
- When unsure whether something shipped, assume it did and migrate — a no-op migration costs nothing; a missing one destroys user data.
