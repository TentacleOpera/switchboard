# Dev Docs Tab — In-Place Fixes

**Plan ID:** 3f2a9c7e-1b4d-4e6a-9c2f-8d5b6a1e0f42

## Goal

Fix the six concrete usability problems with the **Dev Docs** tab in `planning.html` *without* merging it into the Docs tab. Keep Dev Docs as its own surface, but bring it up to (and past) the Docs tab's baseline: a sane create flow, a configurable and non-hidden storage location, README awareness, agent-assisted authoring, git-backed sources, and clipboard import.

### Problem & background

The Dev Docs tab (`#devdocs-content`, `planning.html:3823`) is Switchboard's authoring surface for developer docs that feed the project-context sync (Dev Docs + PRD + constitution → Notion/Linear, `projectContextSync.ts`). It was added recently and, in six places, is weaker than the older Docs tab that lives beside it:

1. **A create modal that shouldn't exist.** `+ New Doc` (`planning.html:3829`) opens an in-webview HTML modal (`#new-devdoc-modal`, `planning.html:4190`) wired in `planning.js:10794-10822`. The Docs tab does the same job with a native `vscode.window.showInputBox` (`PlanningPanelProvider.ts:7285`, via the per-folder `+`). The modal is a redundant, heavier reinvention.
2. **Hidden, unchangeable location.** Docs are hardcoded to `.switchboard/devdocs/` in four sites: `_listDevDocs` (`PlanningPanelProvider.ts:8746`), `createDevDoc` (`:2535`), `_resolveDevDocPath` (`:8778`), and `projectContextSync.ts:117`. There is no setting, and a dot-folder is the wrong default — dev docs belong in a visible root `docs/`. The feature is **unreleased**, so this can be a clean break (no migration).
3. **README is ignored.** The repo README — arguably the single most important dev doc — is never listed or synced. `_listDevDocs` only walks the devdocs dir; `projectContextSync` bundles devdocs + PRD + constitution only.
4. **No agent-assist for writing.** Switchboard has ~15 "copy prompt → paste into agent" hand-offs (e.g. refine at `PlanningPanelProvider.ts:6211`, tuning at `:7098`) but none for authoring or improving a dev doc.
5. **Sources are too narrow.** Project context only flows to Notion/Linear, and dev docs can only originate from one local dot-folder. In practice dev docs live in git: in-repo, in a sibling repo/bench on disk, on git Pages, or in a git wiki.
6. **No clipboard import.** The Docs tab has clipboard import (per-folder "Import" → `importResearchDoc` → `_handleImportResearchDoc`, `PlanningPanelProvider.ts:8634`, reads `vscode.env.clipboard.readText()`). Dev Docs has no equivalent.

### Root cause

Dev Docs was built as a minimal owned CRUD store and never inherited the affordances the Docs tab already had (configurable folders, native create, clipboard import, multi-source). The fix is to port those patterns into Dev Docs and add the three genuinely new gaps (README, agent-assist, git sources) — reusing existing code paths rather than duplicating them.

## What gets built

### 1. Replace the create modal with native input
- Delete `#new-devdoc-modal` (`planning.html:4190-4208`) and its handlers (`planning.js:10794-10822`).
- `#btn-create-devdoc` posts a message (no payload) that the backend services with `vscode.window.showInputBox` for the name, plus a `vscode.window.showQuickPick` for the workspace **only when >1 root exists** (single-root skips the picker). Model on `_handleCreateLocalDoc` (`:7280`).
- Keep the `createDevDoc` backend write (slug + `# <name>` seed, `:2534-2539`); it just receives the name from the input box instead of the modal.
- House rule: input box / quick pick are fine (not confirmation gates). No `confirm()` anywhere.

### 2. User-chosen storage location, default root `docs/`
- New setting `switchboard.devDocsFolder` in `package.json` `configuration` (after `:203`): `type: string`, `scope: resource`, **default `docs`** (root-relative, visible).
- Resolve it via `vscode.workspace.getConfiguration('switchboard').get('devDocsFolder', 'docs')` at all four hardcoded sites (list, create, path-guard, sync), replacing `.switchboard/devdocs`.
- `_resolveDevDocPath` (`:8774`) guards against the resolved (configured) folder.
- **Clean break — no migration.** The feature is unreleased; `.switchboard/devdocs/` is dropped, not read-as-legacy. No `*.migrated.bak`, no dual-read.

### 3. Source-type dropdown (README / Docs / Wiki / …)
The tab's primary navigation becomes a **source-type dropdown** in the controls strip (`planning.html:3825`), modeled on the Docs tab's `docs-source-filter` (`planning.html:3561`). Selecting a type scopes the list pane to that source:
- **Docs** — the configurable `docs/` folder from fix 2 (the default/authoring source; create + edit + import here).
- **README** — the workspace root `README.md` (case-insensitive), surfaced as a first-class editable entry with its own badge in `renderDevDocsList` (`planning.js:10730`). `_resolveDevDocPath` gains a narrow allowance for exactly `<root>/README.md`.
- **Wiki** — git wiki (see fix 5; deferred / read-only to start).
- Extensible: the dropdown enum is the single place new source types (Pages, sibling repo) are added.
- `projectContextSync.ts` includes README + the docs folder in the bundle, each labeled by type.

### 4. Agent-assist authoring
- Add a per-doc "Draft/Improve with agent" strip button that copies a doc-writing prompt to clipboard (reuse the `vscode.env.clipboard.writeText` + `showTemporaryNotification` idiom, e.g. `:6211`). Prompt embeds the doc path and, for improve, the current content, then instructs the agent to write it back to that path.

### 5. Git-backed sources (surfaced through the fix-3 dropdown)
Each git source is a **type in the dropdown** (fix 3), not a separate UI:
- **5a (local, cheap):** in-repo `docs/` (fix 2) and README (fix 3) already cover the common cases. Add sibling-repo/bench folders on disk as additional selectable sources.
- **5b (remote, deferred):** **Wiki** and git Pages / other remote repo as read-only fetched snapshots, clearly marked read-only. Borrow the Docs tab's multi-source model rather than rebuilding it. Gate behind 5a landing.

### 6. Clipboard import
- Add an "Import" button to the Dev Docs controls strip (`planning.html:3825`) → posts `importDevDocFromClipboard` → backend reuses `_handleImportResearchDoc` logic (`:8634`) targeting the resolved devdocs folder (H1-derived title, 200 KB cap already present).

## Edge cases & migration

- **No migration — clean break.** The Dev Docs feature is unreleased, so `.switchboard/devdocs/` is simply replaced by the configurable `docs/` default. No dual-read, no `*.migrated.bak`, no compat shim (per house rules, unreleased dev work takes clean breaks).
- **README is a tracked repo file** — editing it writes real source. The path-guard allowance must be exactly `<root>/README.md`, nothing broader, to keep the traversal protection intact. Read-only remote sources (Wiki/Pages) must never be writable through the editor.
- **Empty `docs/`** — a fresh workspace may have no `docs/` folder; `_listDevDocs` handles a missing dir (already does via try/catch at `:8748`), and create (`:2537`) makes it with `mkdir -p`.
- **No confirmation dialogs** (house rule); `window.confirm()` is a silent no-op in the webview. Delete stays immediate.
- Verify external-change handling (`planning.js:3882`, `externalChangePending.devdocs`) still fires for README and the new default location.

## Sequencing

1. Modal → native input (1) and clipboard import (6) — cheap, self-contained, immediate wins.
2. User-chosen location, default `docs/` (2) — clean break, underpins the dropdown.
3. Source-type dropdown with Docs + README (3) — the core navigation change.
4. Agent-assist (4).
5. Git sources as dropdown types: 5a (local sibling folders), then 5b (Wiki/remote, deferred).

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, ux, backend, refactor
**Repo:** switchboard
