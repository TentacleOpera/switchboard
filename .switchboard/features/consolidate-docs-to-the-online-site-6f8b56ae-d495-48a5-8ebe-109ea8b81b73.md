# Consolidate docs to the online site

**Complexity:** 3

## Goal

Make the online docs site the single source of truth for Switchboard documentation. Rewrite the in-repo README to mirror the site's positioning voice and link out as canonical, and retire the two stale bundled user-facing markdown docs by deleting them and repointing every open-docs/tutorial affordance (plus the .vscodeignore re-includes) to the online site.

## How the Subtasks Achieve This

- **Rewrite README to match the online docs**: Replaces the drifted manual-style `README.md` with a concise landing-page README that mirrors the online site's positioning voice (tagline, the 0→1 arc, differentiator names) and funnels to the canonical docs URL. Removes the two bundled-manual links at `README.md` L401–L402 that the retire plan leaves dangling by design.
- **Retire the bundled user manual/guide; redirect docs affordances to the online site**: Deletes `docs/switchboard_user_manual.md` and `docs/how_to_use_switchboard.md`, repoints `SetupPanelProvider._openDocs()`, the `TaskViewerProvider` `openDocs` case, and the setup.html COPY TUTORIAL PROMPT to the online site, and removes the dead `.vscodeignore` re-includes. Leaves `how_to_plan.md` and its `implementation.html` reference untouched.

## Dependencies & sequencing

Land together or in order: **README rewrite first**, **retire second**. The retire plan's optional offline-fallback decision depends on a self-contained README existing; and the retire plan's DoD explicitly scopes README link cleanup to the sibling plan, so the README plan must land for the retire plan's cross-plan boundary to resolve cleanly. No other hard ordering constraints within either subtask.
## Subtasks
- [ ] [Retire the bundled user manual/guide; redirect docs affordances to the online site](../plans/retire-bundled-docs-redirect-to-online.md) — **PLAN REVIEWED**
- [ ] [Rewrite README to match the online docs](../plans/rewrite-readme-match-online-docs.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
