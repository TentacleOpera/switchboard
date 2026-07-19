# Consolidate docs to the online site

**Complexity:** 3

## Goal

Make the online docs site the single source of truth for Switchboard documentation. Rewrite the in-repo README to mirror the site's positioning voice and link out as canonical, and retire the two stale bundled user-facing markdown docs by deleting them and repointing every open-docs/tutorial affordance (plus the .vscodeignore re-includes) to the online site.

## How the Subtasks Achieve This

- **Rewrite README to match the online docs**: Replaces the drifted manual-style `README.md` with a concise landing-page README that mirrors the online site's positioning voice (tagline, the 0→1 arc, differentiator names) and funnels to the canonical docs URL. Removes the two bundled-manual links at `README.md` L401–L402 that the retire plan leaves dangling by design.
- **Retire the bundled user manual/guide; redirect docs affordances to the online site**: Deletes `docs/switchboard_user_manual.md` and `docs/how_to_use_switchboard.md`, repoints `SetupPanelProvider._openDocs()`, the `TaskViewerProvider` `openDocs` case, and the setup.html COPY TUTORIAL PROMPT to the online site, and removes the dead `.vscodeignore` re-includes. Leaves `how_to_plan.md` and its `implementation.html` reference untouched.

## Dependencies & sequencing

Land together or in order: **README rewrite first**, **retire second**. The retire plan's optional offline-fallback decision depends on a self-contained README existing; and the retire plan's DoD explicitly scopes README link cleanup to the sibling plan, so the README plan must land for the retire plan's cross-plan boundary to resolve cleanly. No other hard ordering constraints within either subtask.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Retire the bundled user manual/guide; redirect docs affordances to the online site](../plans/retire-bundled-docs-redirect-to-online.md) — **INTERN CODED**
- [ ] [Rewrite README to match the online docs](../plans/rewrite-readme-match-online-docs.md) — **INTERN CODED**
<!-- END SUBTASKS -->

---

## Completion Report

Both subtasks landed together. **README rewrite:** replaced the ~402-line manual-style `README.md` with a 44-line landing page mirroring the online site's voice (hero pitch "Run the whole build 0 to 1. Concept to shipped.", the 0→1 arc, four site-named differentiators), a prominent canonical docs link, a trimmed install block (Releases page + VSIX + CLI, versioned direct link dropped), and no bundled-manual links. **Retire bundled docs:** deleted `docs/switchboard_user_manual.md` and `docs/how_to_use_switchboard.md`, repointed `SetupPanelProvider._openDocs()`, the `TaskViewerProvider` `openDocs` case, and the setup.html COPY TUTORIAL PROMPT string to `https://tentacleopera.github.io/switchboard-site/docs/`, and removed the two dead `.vscodeignore` re-includes. Files changed: `README.md`, `.vscodeignore`, `src/services/SetupPanelProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/setup.html`, plus the two deleted docs. One deviation from the plan's snippet: the `openExternal` seam is typed `(url: string)` and parses the Uri internally, so both providers pass the URL string directly rather than the plan's `vscode.Uri.parse(...)` (avoids a type mismatch); `how_to_plan.md` and its `implementation.html` reference were left untouched as required.

