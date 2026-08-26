# Dev Docs Tab — In-Place Fixes Feature

**Complexity:** 6

## Goal

Bring the Dev Docs tab up to (and past) the older Docs tab's baseline by fixing its six usability gaps in place — without merging the two surfaces. The feature groups the structural fixes (modal removal, configurable + visible storage, README awareness, git-backed sources, clipboard import) with the agent-assist prompt hand-off that depends on them, because the agent prompts read the source-type dropdown the structural work introduces. Together they make Dev Docs a first-class, configurable, agent-friendly authoring surface whose output (now including README) feeds the project-context sync to Notion/Linear.

## How the Subtasks Achieve This

- **Dev Docs Tab — In-Place Fixes**: Owns the six structural fixes — replaces the in-webview create modal with native `showInputBox`/`showQuickPick`, moves storage from a hidden `.switchboard/devdocs/` to a configurable root `docs/` (new `switchboard.devDocsFolder` setting, clean break since the feature is unreleased), adds a source-type dropdown (Docs/README; Wiki evaluated and cut from current scope) modeled on the Docs tab's `docs-source-filter` that surfaces the root `README.md` as a first-class editable entry, adds clipboard import via a shared helper extracted from the Docs tab's `_handleImportResearchDoc`, and stages git-backed sources (5a local sibling-repo now, 5b remote Pages deferred). This defines the navigation, storage, and import surface that the agent hand-off sits on, and rewrites the `_resolveDevDocPath` webview-trust guard to accept the configured folder + an exact `<root>/README.md` allowance.
- **Dev Docs — Agent-Assist Prompts**: Owns fix 4 — the Draft and Improve prompt templates and the per-doc "Draft with agent"/"Improve with agent" strip button that copies a ready-to-paste prompt to the clipboard, mirroring the existing refine hand-off (`clipboard.writeText` + `showTemporaryNotification`). It contributes the authoring assistance that makes Dev Docs agent-friendly, reads the source-type `<Type>` token from the structural plan's dropdown, and reuses the validated `_devDocSelected` path so no new traversal surface is introduced.

## Dependencies & sequencing

- **Cross-feature dependencies:** None. This feature is self-contained; no work from other features must land first.
- **Shipping order within this feature:**
  1. `Dev Docs Tab — In-Place Fixes` fixes 1 (modal → native input) and 6 (clipboard import) and 2 (configurable `docs/` folder) first — cheap, self-contained, and fix 2 underpins the dropdown.
  2. Then fix 3 (source-type dropdown with Docs + README) — the core navigation change, which also provisions the `btn-agent-devdoc` element and the `_devDocsSourceFilter` state.
  3. Then `Dev Docs — Agent-Assist Prompts` — it reads the fix-3 `<Type>` token and relies on the validated `_devDocSelected` path, so it must land after fixes 2 and 3.
  4. Fix 5a (local sibling-repo sources) is parallel-safe after fix 2; fix 5b (remote Pages/sibling-clone, commit/push-on-save) is deferred and gated behind 5a. (Wiki was evaluated and cut from current scope — the dropdown enum remains the extensibility point for future re-add.)
- **Prerequisites / guards:** `_resolveDevDocPath` (the webview-trust boundary) must be rewritten to accept the configured folder + an exact case-insensitive `<root>/README.md` allowance before fix 3 ships; the file-watcher scope must be confirmed/extended for root-level README before fix 3 ships (external-change coverage is the open risk). The Dev Docs feature is unreleased, so the storage-location change is a clean break — no migration, no `*.migrated.bak`.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Dev Docs Tab — In-Place Fixes](../plans/dev-docs-tab-in-place-fixes.md) — **CODE REVIEWED** — ID: 04a0b320-23a2-4545-95fe-b9f4f66a2915
- [ ] [Dev Docs — Agent-Assist Prompts](../plans/dev-docs-agent-prompts.md) — **CODE REVIEWED** — ID: d879cffa-8e1c-4a5f-b582-4cfbbab9624b
<!-- END SUBTASKS -->

