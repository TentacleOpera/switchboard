# Retire the bundled user manual/guide; redirect docs affordances to the online site

## Goal

Delete the outdated bundled docs (`docs/switchboard_user_manual.md`, `docs/how_to_use_switchboard.md`) and repoint every "open docs" / "tutorial" affordance in the extension to the online documentation site, so there is a single source of truth.

### Problem Analysis

The extension ships two local markdown docs that have drifted stale now that the canonical documentation lives online at `https://tentacleopera.github.io/switchboard-site/docs/`. Several UI affordances still point at the local manual:

- **`SetupPanelProvider._openDocs()`** (`src/services/SetupPanelProvider.ts` ~L1555) opens `docs/switchboard_user_manual.md` in a markdown preview, falling back to `README.md`.
- **setup.html "Switchboard guide"** section (L585–588) has a **COPY TUTORIAL PROMPT** button whose handler (L3444–3455) builds a prompt instructing the agent to read `docs/switchboard_user_manual.md` (sections 2/3/5).
- **setup.html `btn-open-docs`** (L3466) → posts an `openDocs` message.
- **`TaskViewerProvider`** also handles an `openDocs` case (~L11289) — confirm and repoint.

Leaving these pointed at soon-deleted/stale files gives users wrong or missing guidance.

## Dependencies

Pairs with the README-rewrite plan (`_openDocs`'s README fallback and the online site are the replacement targets). Land together or after it.

## Metadata

**Tags:** docs, cleanup, frontend, backend
**Complexity:** 3

## Non-Goals / Hard Constraints

- **DO NOT delete or modify `.agents/rules/how_to_plan.md`, and DO NOT touch the reference to it in implementation.html (L3309–3310).** That prompt tells the *planner agent* to read the internal planning framework — it is not a user tutorial and is explicitly out of scope. Only the two user-facing docs named in "Delete" below are removed. If discovery surfaces other `how_to_plan.md` references, leave every one of them untouched.

## User Review Required

None — the scope is fixed above. (Only the two bundled user-facing docs are deleted; `how_to_plan.md` and all planning-framework references stay.)

## Proposed Changes

### Step 0 — Discovery (do first)
Grep both webviews **and** their providers for every reference to the two deleted basenames, plus "tutorial", "guide", "manual", and "openDocs". List them all before editing so none is missed.

### Delete
- `docs/switchboard_user_manual.md`
- `docs/how_to_use_switchboard.md`

### Redirect `openDocs` → online site
- `SetupPanelProvider._openDocs()`: replace the local-manual preview + README fallback with an external open — `vscode.env.openExternal(vscode.Uri.parse('https://tentacleopera.github.io/switchboard-site/docs/getting-started/installation'))` (or the docs root). Remove the now-dead stat/preview logic.
- `TaskViewerProvider` `openDocs` case (~L11289): point to the same online docs URL.

### Redirect the tutorial prompt
- setup.html COPY TUTORIAL PROMPT handler (L3445): rewrite the copied prompt to reference the online docs instead of the local manual — e.g. *"Read the Switchboard docs at https://tentacleopera.github.io/switchboard-site/docs/getting-started/ (Installation, Agents, Planning) and walk me through setup as a numbered list; ask which step I want help with first."* Keep the button label.

### Repo
switchboard (extension).

## Edge-Case & Dependency Audit
- **Published extension / migrations:** these docs are shipped, but they are read-only *reference content* — deleting them is a clean break for the feature (no user data at risk). The only runtime dependency is `_openDocs`'s `stat` check; replacing it removes the dependency. No data migration needed.
- **Offline users:** external-URL docs need a browser/network. Acceptable now that the site is canonical. Optionally keep a single README pointer line as a last-resort offline fallback (coordinate with the README plan).

## Definition of Done
Both files gone; every open-docs/tutorial affordance opens or references the online site; no dangling references to the deleted files anywhere in `src/`; extension compiles.
