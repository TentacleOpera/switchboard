# Dev Docs Tab — In-Place Fixes

**Plan ID:** 3f2a9c7e-1b4d-4e6a-9c2f-8d5b6a1e0f42

## Goal

Fix the six concrete usability problems with the **Dev Docs** tab in `planning.html` *without* merging it into the Docs tab. Keep Dev Docs as its own surface, but bring it up to (and past) the Docs tab's baseline: a sane create flow, a configurable and non-hidden storage location, README awareness, agent-assisted authoring, git-backed sources, and clipboard import.

### Problem & background

The Dev Docs tab (`#devdocs-content`, `planning.html:3817`) is Switchboard's authoring surface for developer docs that feed the project-context sync (Dev Docs + PRD + constitution → Notion/Linear, `src/services/remote/projectContextSync.ts`). It was added recently and, in six places, is weaker than the older Docs tab that lives beside it:

1. **A create modal that shouldn't exist.** `+ New Doc` (`planning.html:3822`) opens an in-webview HTML modal (`#new-devdoc-modal`, `planning.html:4169-4189`) wired in `planning.js:10783-10811`. The Docs tab does the same job with a native `vscode.window.showInputBox` (`PlanningPanelProvider.ts:_handleCreateLocalDoc` at `:7021`, via the per-folder `+`). The modal is a redundant, heavier reinvention.
2. **Hidden, unchangeable location.** Docs are hardcoded to `.switchboard/devdocs/` in four sites: `_listDevDocs` (`PlanningPanelProvider.ts:8477`, dir built at `:8483`), `createDevDoc` (case at `:2387`, write at `:2396`), `_resolveDevDocPath` (`:8511`, guard at `:8515-8516`), and `projectContextSync.ts:117`. There is no setting, and a dot-folder is the wrong default — dev docs belong in a visible root `docs/`. The feature is **unreleased**, so this can be a clean break (no migration).
3. **README is ignored.** The repo README — arguably the single most important dev doc — is never listed or synced. `_listDevDocs` (`:8477`) only walks the devdocs dir; `projectContextSync.ts` bundles devdocs (`:117-130`) + PRD (`:110-115`) + constitution (`:105-107`) only — no README.
4. **No agent-assist for writing.** Switchboard has ~15 "copy prompt → paste into agent" hand-offs (e.g. refine at `PlanningPanelProvider.ts:6034-6035`, diagram at `:5904-5905`) but none for authoring or improving a dev doc. (See the companion plan `dev-docs-agent-prompts.md` for the prompt text and wiring.)
5. **Sources are too narrow.** Project context only flows to Notion/Linear, and dev docs can only originate from one local dot-folder. In practice dev docs live in git: in-repo, in a sibling repo/bench on disk, on git Pages, or in a git wiki.
6. **No clipboard import.** The Docs tab has clipboard import (`importResearchDoc` case at `PlanningPanelProvider.ts:2977` → `_handleImportResearchDoc` at `:8371`, reads `vscode.env.clipboard.readText()` at `:8379`, 200 KB cap at `:8385`, H1-derived title at `:8392-8394`). Dev Docs has no equivalent.

### Root cause

Dev Docs was built as a minimal owned CRUD store and never inherited the affordances the Docs tab already had (configurable folders, native create, clipboard import, multi-source). The fix is to port those patterns into Dev Docs and add the three genuinely new gaps (README, agent-assist, git sources) — reusing existing code paths rather than duplicating them.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, ux, backend, refactor

## User Review Required

Yes. Three product-shaping decisions need a human sign-off before coding, because they change default behavior for the (small, unreleased) install base and the visible repo layout:

1. **Default storage location changes from `.switchboard/devdocs/` → root `docs/`.** This is a clean break (feature unreleased), but it moves where files land. Confirm the `docs` default and that no migration is wanted.
2. **README becomes an editable Dev Docs entry.** Editing README through this tab writes real, tracked repo source. Confirm that surfacing README as a first-class editable doc (not read-only) is intended.
3. **Git-backed remote sources (Pages / sibling repo) are deferred (5b).** The dropdown ships extensible with Docs + README + local-sibling (5a); the remote-clone write path lands later. Confirm deferral is acceptable for this delivery. (Wiki was evaluated and **cut from current scope** — see fix 3.)

## Complexity Audit

### Routine
- Deleting the `#new-devdoc-modal` HTML (`planning.html:4169-4189`) and its JS handlers (`planning.js:10783-10811`) — pure removal.
- Re-pointing `btn-create-devdoc` to post a payload-free create message; backend reuses the existing `showInputBox` idiom (`_handleCreateLocalDoc:7026`).
- Adding one `switchboard.devDocsFolder` setting to `package.json` (neighbor: `switchboard.stitch.defaultOutputFolder` at `:198-203`).
- Adding the "Import" button to the Dev Docs controls strip and a dropdown modeled on `docs-source-filter` (`planning.html:3561-3568`).
- Threading the configured folder through the four hardcoded sites — string replacement of a literal path join.
- README badge in `renderDevDocsList` (`planning.js:10702`).

### Complex / Risky
- **`_resolveDevDocPath` (`:8511`) rewrite** — currently the webview-trust guard. It must (a) check the *configured* folder instead of the hardcoded one, and (b) gain a narrow case-insensitive allowance for exactly `<root>/README.md`. Getting this wrong either opens a traversal hole or breaks README editing. Security-sensitive.
- **Clipboard-import helper extraction** — `_handleImportResearchDoc` (`:8371`) is wired to the *local-folder service* (`localFolderService`, configured folders), not the devdocs dir. "Reuse the logic" means factoring out a shared helper (read clipboard → 200 KB cap → H1 title → write to a given dir) and calling it with the configured devdocs folder, NOT calling `_handleImportResearchDoc` directly. The plan originally glossed this seam.
- **`projectContextSync.ts` config threading** — that module has no `vscode` config access; it receives `opts`. The configured `devDocsFolder` + README path must be resolved by the caller (`PlanningPanelProvider`) and passed into the sync `opts`. Two-module coordination.
- **README external-change coverage** — `externalChangePending.devdocs` fires on `devDocContent` (`planning.js:3904`), but the underlying file watcher is scoped to the devdocs dir; a root-level `README.md` may not be watched. Real risk of stale README preview after a `git pull`.
- **Git-backed remote sources (5b)** — clone/fetch + auth + commit/push-on-save plumbing. Deferred this delivery; the dropdown must be extensible so 5b is additive.

## What gets built

### 1. Replace the create modal with native input
- Delete `#new-devdoc-modal` (`planning.html:4169-4189`) and its handlers (`planning.js:10783-10811`).
- `#btn-create-devdoc` posts a message (no payload) that the backend services with `vscode.window.showInputBox` for the name (model the `validateInput` from `_handleCreateLocalDoc:7026-7035`), plus a `vscode.window.showQuickPick` for the workspace **only when >1 root exists** (single-root skips the picker — Dev Docs has no per-folder `+` button unlike the Docs tab, so the picker is the workspace selector). Model on `_handleCreateLocalDoc` (`:7021`).
- Keep the `createDevDoc` backend write (slug + `# <name>` seed, `:2387-2406`); it just receives the name from the input box instead of the modal.
- House rule: input box / quick pick are fine (not confirmation gates). No `confirm()` anywhere.

### 2. User-chosen storage location, default root `docs/`
- New setting `switchboard.devDocsFolder` in `package.json` `configuration.properties` (insert after `switchboard.stitch.defaultOutputFolder`, `:203`): `type: string`, `scope: resource`, **default `docs`** (root-relative, visible).
- Resolve it via `vscode.workspace.getConfiguration('switchboard').get('devDocsFolder', 'docs')` at all four hardcoded sites (list `_listDevDocs:8483`, create `:2396`, path-guard `_resolveDevDocPath:8515`, sync `projectContextSync.ts:117`), replacing `.switchboard/devdocs`.
- `_resolveDevDocPath` (`:8511`) guards against the resolved (configured) folder.
- **Clean break — no migration.** The feature is unreleased; `.switchboard/devdocs/` is dropped, not read-as-legacy. No `*.migrated.bak`, no dual-read.

### 3. Source-type dropdown (README / Docs / …)
The tab's primary navigation becomes a **source-type dropdown** in the controls strip (`planning.html:3818`), modeled on the Docs tab's `docs-source-filter` (`planning.html:3561-3568`). Selecting a type scopes the list pane to that source:
- **Docs** — the configurable `docs/` folder from fix 2 (the default/authoring source; create + edit + import here).
- **README** — the workspace root `README.md` (case-insensitive), surfaced as a first-class editable entry with its own badge in `renderDevDocsList` (`planning.js:10702`). `_resolveDevDocPath` gains a narrow allowance for exactly `<root>/README.md` (case-insensitive, normalized via `path.resolve` + lowercased compare on case-insensitive platforms).
- **Wiki — CUT from current scope.** Evaluated during review: wikis are cloneable git repos on all three hosts (research confirmed), but Wiki added the hardest 5b seams (per-host clone-URL resolver, GitHub cold-start 404, Bitbucket API-token auth dying July 28 2026) for marginal value — most users author in `docs/` + README. The dropdown enum remains the single extensibility point; Wiki can be re-added as a type later without a schema change if demand appears.
- Extensible: the dropdown enum is the single place new source types (Pages, sibling repo, future Wiki) are added.
- `projectContextSync.ts` includes README + the docs folder in the bundle, each labeled by type (label helper at `:135-139`).

### 4. Agent-assist authoring
- Add a per-doc "Draft/Improve with agent" strip button that copies a doc-writing prompt to clipboard (reuse the `vscode.env.clipboard.writeText` + `showTemporaryNotification` idiom, e.g. `:6034-6035`). Prompt embeds the doc path and, for improve, the current content, then instructs the agent to write it back to that path. **Full prompt text and wiring live in the companion plan `dev-docs-agent-prompts.md`.**

### 5. Git-backed sources (surfaced through the fix-3 dropdown)
Each git source is a **type in the dropdown** (fix 3), not a separate UI:
- **5a (local, cheap):** in-repo `docs/` (fix 2) and README (fix 3) already cover the common cases. Add sibling-repo/bench folders on disk as additional selectable sources.
- **5b (remote, deferred):** git Pages and other remote repos — **all writable**. The source is a local clone; save = write file → commit → push. Deferred only for the clone/fetch + auth plumbing, not because they're read-only. Borrow the Docs tab's multi-source model rather than rebuilding it. Gate behind 5a landing. (Wiki removed from 5b — see fix 3.)
  - Write path per type *(Clarification — host specifics confirmed via web research, July 2026; see §Research Findings for full detail)*: Pages → GitHub serves from a configured branch root or `/docs` folder (push-is-publish); **GitLab Pages is CI-pipeline-driven, NOT push-is-publish** — a `.gitlab-ci.yml` `pages:` job produces a `public/` artifact, so "save" may mean "queued for a pipeline run," not "live"; Bitbucket Cloud serves one site per workspace at `<workspace>.bitbucket.io` from a repo root. other repo → its own working clone. Recommended architecture (per research): one generic `GitWriteViaClone` core parameterized by `{cloneUrl, auth}` + three thin per-host modules for (a) clone URL, (b) auth object, (c) Pages publish semantics.

### 6. Clipboard import
- Add an "Import" button to the Dev Docs controls strip (`planning.html:3818`) → posts `importDevDocFromClipboard` → backend calls a **shared helper extracted from `_handleImportResearchDoc` (`:8371`)** (read `clipboard.readText()` → 200 KB cap → H1-derived title → write to a given dir), targeting the resolved devdocs folder. Do **not** call `_handleImportResearchDoc` directly — it writes via the local-folder service, not devdocs.

## Edge-Case & Dependency Audit

**Race Conditions**
- Save-while-external-change: `externalChangePending.devdocs` (`planning.js:3904`) already gates edit-mode reloads; preserve this for the new default location. For README, confirm the file watcher covers `<root>/README.md` — if not, a `git pull` can leave a stale preview without the gate firing.
- Concurrent create + list refresh: `createDevDoc` (`:2387`) makes the dir with `mkdir -p` then writes; a parallel `loadDevDocs` (`:2346`) readdir is safe (try/catch at `:8485`). No change needed.
- Clipboard import re-entrancy: mirror the `_importInProgress` guard from `_handleImportResearchDoc` (`:8372-8377`) in the shared helper.

**Security**
- `_resolveDevDocPath` (`:8511`) is the webview-trust boundary. The README allowance must be **exactly `<root>/README.md`** — compare `path.resolve(candidate)` against `path.resolve(root, 'README.md')` (case-insensitive on macOS/Windows), never a `startsWith` or wildcard. The configured-folder check replaces the hardcoded `.switchboard/devdocs` literal with `path.resolve(root, configuredFolder)`. No broadening of traversal protection.
- Doc-name sanitization: reuse `sanitizeProjectSlug` (already used at `:2395`) for the create slug; the input-box `validateInput` strips `\\/:` and `..` (`:7031`).

**Side Effects**
- Editing README writes real tracked repo source (not a Switchboard-owned file). The save path (`saveDevDoc` → `_resolveDevDocPath`) must allow README; `createDevDoc` must NOT apply to README (README is surfaced, not created).
- `_onProjectContextContentChanged` (`:8528`, debounced auto-push) fires after every dev-doc save; it will now also fire on README saves, pushing README into Notion/Linear context. Intended, but note the sync payload grows.
- Moving the default to root `docs/` changes where new files appear in the user's repo tree (visible, not hidden).

**Dependencies & Conflicts**
- Depends on the companion plan `dev-docs-agent-prompts.md` for fix 4's prompt text + button wiring (fix 4 is implemented there; this plan owns the dropdown/source model it relies on).
- Fix 3 (dropdown) must land before fix 4's `<Type>` token is meaningful.
- Fix 2 (configurable folder) must land before fix 3's Docs source and fix 6's import target resolve correctly.
- 5b depends on 5a and is out of scope for this delivery.

## Edge cases & migration

- **No migration — clean break.** The Dev Docs feature is unreleased, so `.switchboard/devdocs/` is simply replaced by the configurable `docs/` default. No dual-read, no `*.migrated.bak`, no compat shim (per house rules, unreleased dev work takes clean breaks).
- **README is a tracked repo file** — editing it writes real source. The path-guard allowance must be exactly `<root>/README.md`, nothing broader, to keep the traversal protection intact.
- **Git-backed sources are writable, but saving involves commit + push** — network and auth can fail mid-save. Surface push failures clearly and don't lose the user's edit (the local clone keeps the committed change even if push fails; a retry re-pushes). No silent data loss. (5b — deferred.)
- **Empty `docs/`** — a fresh workspace may have no `docs/` folder; `_listDevDocs` handles a missing dir (already does via try/catch at `:8485`), and create (`:2398`) makes it with `mkdir -p`.
- **No confirmation dialogs** (house rule); `window.confirm()` is a silent no-op in the webview. Delete stays immediate.
- Verify external-change handling (`planning.js:3904`, `externalChangePending.devdocs`) still fires for README and the new default location — **the README case is the open risk** (watcher scope).

## Dependencies

- `dev-docs-agent-prompts.md` (Plan ID `8b1e4d90-6c2a-47f3-a5e1-2d9f0c7b3a11`) — fix 4 prompt text + button wiring. This plan owns the fix-3 dropdown/source-type model that the agent-assist `<Type>` token reads.
- No cross-feature dependencies. Subtasks within this feature: fixes 2 → 3 → 4 (agent-prompts) → 6; 5a is parallel-safe after 2; 5b deferred.

## Adversarial Synthesis

Key risks: (1) `_resolveDevDocPath` is the security boundary and is being rewritten to accept a configured folder + a root-README allowance — a loose compare opens a traversal hole, a strict one breaks README; (2) the clipboard-import and projectContextSync seams were under-specified — both need helper extraction / opt-threading, not direct calls; (3) README external-change coverage is unverified for a root-level file outside the watched devdocs dir. Mitigations: exact `path.resolve` equality for README, case-normalized; shared clipboard helper written to the configured dir; sync opts threaded from the caller; verify/extend the watcher for README before shipping fix 3.

## Sequencing

1. Modal → native input (1) and clipboard import (6) — cheap, self-contained, immediate wins.
2. User-chosen location, default `docs/` (2) — clean break, underpins the dropdown.
3. Source-type dropdown with Docs + README (3) — the core navigation change.
4. Agent-assist (4) — implemented in the companion plan; lands after 3.
5. Git sources as dropdown types: 5a (local sibling folders), then 5b (Pages/remote, deferred).

## Proposed Changes

### `package.json`
- **Context:** The `configuration.properties` block (`:166`) holds all `switchboard.*` settings; `switchboard.stitch.defaultOutputFolder` (`:198-203`) is the exact pattern — `type: string`, `scope: resource`, relative-to-root description.
- **Logic:** Add `switchboard.devDocsFolder` immediately after `:203`.
- **Implementation:**
  ```json
  "switchboard.devDocsFolder": {
    "type": "string",
    "default": "docs",
    "description": "Root-relative folder where developer docs are stored and authored in the Dev Docs tab. Visible by default (not a dot-folder).",
    "scope": "resource"
  }
  ```
- **Edge Cases:** Empty string → treat as `docs` (the `get('devDocsFolder', 'docs')` default covers `undefined`; normalize empty to `docs` at resolution time). Absolute paths → reject and fall back to `docs` (dev docs must stay inside the workspace root).

### `src/services/PlanningPanelProvider.ts`
- **Context:** Four hardcoded `.switchboard/devdocs` sites (`:8483`, `:2396`, `:8515`, plus the sync call site) and the create modal's backend twin (`createDevDoc` at `:2387`). `_handleCreateLocalDoc` (`:7021`) is the native-create template; `_handleImportResearchDoc` (`:8371`) is the clipboard-import template (but writes via the local-folder service).
- **Logic:**
  1. Add a private resolver: `private _devDocsFolder(root: string): string { const cfg = vscode.workspace.getConfiguration('switchboard').get('devDocsFolder', 'docs') || 'docs'; const p = path.resolve(root, cfg); return p.startsWith(path.resolve(root)) ? p : path.resolve(root, 'docs'); }` — guards against absolute/escape.
  2. `_listDevDocs` (`:8477`): replace `path.join(item.workspaceRoot, '.switchboard', 'devdocs')` (`:8483`) with `this._devDocsFolder(item.workspaceRoot)`. Additionally surface README: for each workspace item, if `<root>/README.md` (case-insensitive exists check) is present, push a synthetic entry `{ path, fileName: 'README.md', title: <H1 or 'README'>, workspaceRoot, workspaceLabel, sourceType: 'readme' }`.
  3. `createDevDoc` (`:2387`): replace the hardcoded join at `:2396` with `path.join(root, this._devDocsFolderRelative(root), `${slug}.md`)`. Add multi-root `showQuickPick`: when `allRoots.length > 1`, pick a root before the name input; single-root uses `allRoots[0]`. README is never created here.
  4. `_resolveDevDocPath` (`:8511`): replace the hardcoded `devDocsDir` (`:8515`) with `path.resolve(root, this._devDocsFolderRelative(root))`; keep the `startsWith(dir + path.sep)` check. Add a README branch: `if (resolved === path.resolve(root, 'README.md')) return resolved;` with a case-insensitive compare helper for macOS/Windows. Nothing broader.
  5. New case `importDevDocFromClipboard`: call a shared helper `this._importDocFromClipboardToDir(targetRoot, this._devDocsFolder(targetRoot))` — extracted from `_handleImportResearchDoc` (`:8371-8468`) as `readClipboard → 200 KB cap → H1 title → writeFile to given dir`, preserving the `_importInProgress` re-entrancy guard and posting `importDevDocResult` back.
  6. Sync call site: where `_onProjectContextContentChanged` (`:8528`) and the sync assembly are invoked, resolve `devDocsFolder` + `readmePath` and pass them into the sync `opts` (see `projectContextSync.ts` below).
- **Edge Cases:** Configured folder outside root → clamped to `docs`. README missing → not listed. README with no H1 → title `'README'`. Multi-root create picker cancel → no-op.

### `src/services/remote/projectContextSync.ts`
- **Context:** Assembles Dev Docs + PRD + constitution (`:105-130`); `devDocsDir` hardcoded at `:117`; label helper at `:135-139`. The module receives `opts` and has no `vscode` config access.
- **Logic:** Add `devDocsDir?: string` and `readmePath?: string` to the opts interface (caller-resolved). At `:117`, use `opts.devDocsDir ?? path.join(opts.workspaceRoot, '.switchboard', 'devdocs')` (fallback keeps it callable unchanged). After the dev-docs loop, if `opts.readmePath` exists, read it and push `{ kind: 'readme', title: 'README', markdown }`. Extend the label helper (`:135-139`) with a `readme` branch → `## README — ${d.title}`.
- **Edge Cases:** Omitted opts → legacy behavior (no regression for any caller not yet updated). README absent → silently skipped (readIfExists). Keep the existing `try/catch` around the readdir.

### `src/webview/planning.html`
- **Context:** Dev Docs controls strip at `:3818-3827`; modal at `:4169-4189`; Docs tab dropdown template at `:3561-3568`.
- **Logic:**
  1. In the controls strip (`:3818`), after the workspace filter (`:3819`), add `<select id="devdocs-source-filter" class="workspace-filter-select">` with options `Docs` (default) and `README`. (Wiki cut — see fix 3; the enum is the extensibility point for future re-add.)
  2. Add `<button id="btn-import-devdoc" class="strip-btn" disabled>Import</button>` and (per companion plan) `<button id="btn-agent-devdoc" class="strip-btn" disabled>Draft with agent</button>`.
  3. Delete the entire `#new-devdoc-modal` block (`:4168-4189`).
- **Edge Cases:** Import/agent buttons disabled until a doc is selected (parity with Edit/Delete gating at `planning.js:3908-3909`).

### `src/webview/planning.js`
- **Context:** devdocs DOM refs at `:10685-10694`; `renderDevDocsList` at `:10702`; `selectDevDoc` at `:10746`; modal handlers at `:10783-10811`; message handlers at `:3892-3935`; `externalChangePending.devdocs` at `:3904`.
- **Logic:**
  1. Remove modal handlers (`:10783-10811`) and the `new-devdoc-workspace` population in `populateDevDocsAndNotebookFilters` (`:10886`).
  2. `btn-create-devdoc` → `vscode.postMessage({ type: 'createDevDoc' })` (no payload; backend does input/pick).
  3. Add `devdocs-source-filter` change handler: store `_devDocsSourceFilter`, call `renderDevDocsList` (which scopes by source type); exit edit mode if dirty (mirror `:10754`).
  4. `renderDevDocsList` (`:10702`): filter by source type; for `readme` entries render a badge (e.g. `README` pill) beside the title.
  5. Add `btn-import-devdoc` handler → `vscode.postMessage({ type: 'importDevDocFromClipboard', workspaceRoot })`.
  6. Add `importDevDocResult` message handler → refresh list + toast (mirror `importResearchDocResult`).
  7. (Companion plan) `btn-agent-devdoc` handler → post selected doc path; label toggles "Draft with agent"/"Improve with agent" by content presence.
- **Edge Cases:** Switching source type while a doc is selected and dirty → exit edit mode first (parity `:10754`). README selection sends `readDevDoc` with the root README path; backend guard must allow it.

## Verification Plan

### Automated Tests
**Out of scope for this session** per session directives (SKIP TESTS, SKIP COMPILATION). No automated test run or `npm run compile` is part of this verification pass. The implementer should add/extend webview message-handler and `_resolveDevDocPath` unit tests in a follow-up, but they are not executed here.

### Manual Verification (no compile, no test run)
1. **Setting lands:** Open Settings UI, confirm `switchboard.devDocsFolder` appears under Switchboard with default `docs` and `scope: resource`.
2. **Create flow:** Click `+ New Doc` → native `showInputBox` (no modal). Single-root skips the picker; multi-root shows `showQuickPick`. New file appears at `<root>/docs/<slug>.md` with a `# <name>` seed.
3. **Configurable location:** Set `devDocsFolder` to `documentation` → create + list + import target `documentation/`. Set to `../escape` → clamped to `docs` (no traversal).
4. **Source dropdown:** Select `Docs` → lists `docs/` files. Select `README` → lists the root `README.md` with a badge; editing it writes the real README.
5. **README path-guard:** From webview devtools, post a `readDevDoc` with `../../etc/passwd` and with `<root>/README2.md` → both rejected; `<root>/README.md` (and lowercase variants on macOS) accepted.
6. **Clipboard import:** Copy markdown with an `# H1` → Import → file written to `docs/` with H1-derived title; >200 KB clipboard → clear error toast.
7. **Sync bundle:** Save a dev doc and the README → trigger Sync Now → confirm the pushed Notion/Linear bundle includes a `## Dev Doc — …` and `## README — …` section.
8. **External change:** With README open in Dev Docs, run `git pull` that changes README → confirm the preview refreshes (or `externalChangePending` prompts). **If it does not, the watcher scope gap is confirmed and must be fixed before shipping fix 3.**
9. **No confirm gates:** Delete a dev doc → immediate, no dialog (house rule).
10. **Agent-assist button:** Present and wired per the companion plan; copies the Draft/Improve prompt to clipboard.

## Research Findings (fix 5b — resolved July 2026)

Web research was run on the deferred fix 5b (remote git-backed sources). All flagged assumptions are now resolved; key actionable findings below. **Wiki was subsequently cut from current scope (see fix 3) — the Wiki-specific findings below are retained for if/when Wiki is re-introduced as a dropdown type.** The in-scope work (fixes 1-4, 6, 5a) is unaffected and relies only on verified internal code paths — no research was needed for it.

- **Wiki clone URL — CONFIRMED + CORRECTED (retained for future Wiki re-add).** GitHub and GitLab both use the `.wiki.git` suffix appended to the repo clone URL (`https://github.com/OWNER/REPO.wiki.git`, `https://gitlab.com/NAMESPACE/PROJECT.wiki.git`). **Bitbucket Cloud does NOT** — the wiki is a sibling repo object reached via the wiki page's "Clone repository" dialog, not a `.wiki.git` suffix. → A future Wiki type would need a per-host clone-URL resolver, not a single string template.
- **Wiki writable via standard `git push` — CONFIRMED (retained).** All three hosts. No special wiki merge semantics; the generic fetch→rebase→commit→push retry loop works unchanged. Full-history clones, not shallow.
- **Wiki cold-start — GitHub-only gotcha (retained).** GitHub wiki repo does not exist server-side until a first page is saved via the web UI (clone before that → HTTP 404). GitLab/Bitbucket less consistently documented; probe with `git ls-remote`.
- **Pages serving — divergence CONFIRMED, biggest architectural seam (applies to 5b Pages type).** GitHub: push-is-publish from a configured branch root or `/docs` folder. **GitLab: NOT push-is-publish** — a `.gitlab-ci.yml` `pages:` job must run and produce a `public/` artifact; "committed" means "queued for a pipeline run," not "live." Bitbucket Cloud: one site per workspace at `<workspace>.bitbucket.io`, served from repo root, 15-min cache. → 5b's Pages type must surface publish-status per host, not assume push-is-publish.
- **Auth — CRITICAL TIME-SENSITIVE FACT (applies to 5b).** Bitbucket Cloud App Passwords are in a brownout window (June 9 – July 27, 2026) and **fully removed July 28, 2026** (22 days from today). 5b MUST target Bitbucket API tokens (static username `x-bitbucket-api-token-auth`), never App Passwords. GitHub/GitLab use PATs as the HTTPS password. OAuth2→Basic-Auth conversion differs per host (GitHub `x-oauth-basic` / `x-access-token`, GitLab `oauth2`, Bitbucket `x-token-auth`) — forces a per-host auth adapter, no host-agnostic default.
- **Sibling-repo discovery — NO VS Code API (applies to 5a).** `vscode.workspace.workspaceFolders` returns only configured folders; the built-in Git extension API (`vscode.git` exports `getAPI(1)`) exposes only repos already opened in the workspace. There is no sanctioned "list all git repos on disk" API. → 5a's sibling-repo sources must be configured-folder enumeration (user adds folders, or scan user-designated parent dirs for `.git` via Node `fs`), not auto-discovery.
- **Recommended 5b architecture (per research):** one generic `GitWriteViaClone` core (clone, stage, commit, fetch-rebase-retry, push) parameterized by `{cloneUrl, auth}`, with three thin per-host modules responsible only for (a) producing the correct clone URL for Pages/sibling, (b) producing the correct auth object, and (c) surfacing whether "committed" means "published" (GitHub/Bitbucket) or "pipeline queued" (GitLab). (Wiki would slot in as a fourth type if re-added.)
- **Flagged-unconfirmed (verify empirically before 5b ships):** No official source confirms/denies GitHub Wiki deprecation rumors — wiki docs remain actively maintained as of July 2026. (The GitHub fine-grained PAT wiki-push question is moot while Wiki is cut.)
