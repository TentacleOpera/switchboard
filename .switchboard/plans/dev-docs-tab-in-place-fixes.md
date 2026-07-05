# Dev Docs Tab — In-Place Fixes

**Plan ID:** 3f2a9c7e-1b4d-4e6a-9c2f-8d5b6a1e0f42

## Goal

Fix the six concrete usability problems with the **Dev Docs** tab in `planning.html` *without* merging it into the Docs tab. Keep Dev Docs as its own surface, but bring it up to (and past) the Docs tab's baseline: a sane create flow, a configurable and non-hidden storage location, README awareness, agent-assisted authoring, git-backed sources, and clipboard import.

### Problem & background

The Dev Docs tab (`#devdocs-content`, `planning.html:3823`) is Switchboard's authoring surface for developer docs that feed the project-context sync (Dev Docs + PRD + constitution → Notion/Linear, `projectContextSync.ts`). It was added recently and, in six places, is weaker than the older Docs tab that lives beside it:

1. **A create modal that shouldn't exist.** `+ New Doc` (`planning.html:3829`) opens an in-webview HTML modal (`#new-devdoc-modal`, `planning.html:4190`) wired in `planning.js:10794-10822`. The Docs tab does the same job with a native `vscode.window.showInputBox` (`PlanningPanelProvider.ts:7285`, via the per-folder `+`). The modal is a redundant, heavier reinvention.
2. **Hidden, unchangeable location.** Docs are hardcoded to `.switchboard/devdocs/` in four sites: `_listDevDocs` (`PlanningPanelProvider.ts:8746`), `createDevDoc` (`:2535`), `_resolveDevDocPath` (`:8778`), and `projectContextSync.ts:117`. There is no setting. Users don't want authored docs buried in a dot-folder.
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

### 2. Configurable, non-hidden storage location
- New setting `switchboard.devDocsFolder` in `package.json` `configuration` (after `:203`): `type: string`, `scope: resource`, **default `.switchboard/devdocs`** (back-compat), description steering users toward a visible path like `docs/`.
- Resolve it via `vscode.workspace.getConfiguration('switchboard').get('devDocsFolder', '.switchboard/devdocs')` at all four hardcoded sites (list, create, path-guard, sync).
- `_resolveDevDocPath` (`:8774`) must allow both the configured folder **and** the legacy default, so the security guard still passes for pre-existing docs.

### 3. README pickup
- `_listDevDocs` injects the workspace README (root `README.md`, case-insensitive) as a first-class, editable entry tagged as the repo README (distinct badge in `renderDevDocsList`, `planning.js:10730`).
- `_resolveDevDocPath` gains a narrow allowance for `<root>/README.md` (it currently rejects anything outside devdocs).
- `projectContextSync.ts` includes the README in the bundle (labeled `README`).

### 4. Agent-assist authoring
- Add a per-doc "Draft/Improve with agent" strip button that copies a doc-writing prompt to clipboard (reuse the `vscode.env.clipboard.writeText` + `showTemporaryNotification` idiom, e.g. `:6211`). Prompt embeds the doc path and, for improve, the current content, then instructs the agent to write it back to that path.

### 5. Git-backed sources (largest; own sub-phases)
- **5a (local, cheap):** promote the location setting to an **array** of dev-doc source folders so in-repo and sibling-repo/bench paths on disk both work. `_listDevDocs` iterates all configured folders (dedup, per-source label). Reuses fix 2.
- **5b (remote, deferred):** read-only fetched sources for git Pages / wiki / other remote repo — imported as snapshots, clearly marked read-only. Borrow the Docs tab's multi-source model (`docs-source-filter`) rather than rebuilding it. Gate behind 5a landing.

### 6. Clipboard import
- Add an "Import" button to the Dev Docs controls strip (`planning.html:3825`) → posts `importDevDocFromClipboard` → backend reuses `_handleImportResearchDoc` logic (`:8634`) targeting the resolved devdocs folder (H1-derived title, 200 KB cap already present).

## Edge cases & migration

- **`.switchboard/devdocs/` is shipped state** (published extension, ~4k installs). Per house rules: when the location setting changes, **never drop** existing docs — `_listDevDocs` reads the legacy default in addition to the configured folder so nothing disappears; any move is copy-then-archive (`*.migrated.bak`), never unlink.
- **Default stays `.switchboard/devdocs`** to avoid a silent relocation on upgrade; surfacing a visible path is opt-in via the setting. (Open decision: default *new/empty* workspaces to `docs/`. Flagged, not assumed.)
- **README is a tracked repo file** — editing it writes real source. The path-guard allowance must be exactly `<root>/README.md`, nothing broader, to keep the traversal protection intact.
- **No confirmation dialogs** (house rule); `window.confirm()` is a silent no-op in the webview. Delete stays immediate.
- Verify external-change handling (`planning.js:3882`, `externalChangePending.devdocs`) still fires for README and non-default locations.

## Sequencing

1. Modal → native input (1) and clipboard import (6) — cheap, self-contained, immediate wins.
2. Configurable location + migration (2) — underpins 5.
3. README pickup (3).
4. Agent-assist (4).
5. Git sources: 5a (local multi-folder), then 5b (remote, deferred).

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, ux, backend, refactor
**Repo:** switchboard
