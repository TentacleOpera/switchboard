# Update switchboard-site docs for the Docs-tab / Create Plans / NotebookLM changes

## Metadata
- **Complexity:** 2
- **Tags:** docs
- **Project:** Website

## What this does

All the **switchboard-site** (Astro docs) edits that accompany the four `switchboard`-extension subtasks of the "Docs-first external planning intake" feature. Consolidated into one plan because they all touch the same Artifacts doc set and its `prev`/`next` chain — reconciling that chain in one pass is far safer than three extension plans coordinating page-by-page.

**Single repo: `switchboard-site` only.** No extension code. Land this **with or after** the extension subtasks, since it documents behaviour they ship.

## Steps (all paths under `switchboard-site/src/pages/docs/`)

1. **Delete `artifacts/dev-docs.md`** — the Dev Docs tab is gone (merged into Docs).
2. **`artifacts/planning-artifacts.md`** — remove "dev docs" from the `description` frontmatter (line 4); delete the Dev Docs tabs-table row (line 25); reword line 34 to drop the Dev Docs reference (Research writes to your chosen docs folder; plan imports create cards on the board).
3. **`artifacts/docs.md`** — document the merged tab's new affordances: `+ New Doc` and `Draft with agent` in "The sidebar" (~line 27); note the Docs tab is now the single home for markdown docs (incl. what the old Dev Docs tab held) and the source filter lists sources only. Do NOT invent a folder-role concept — docs are undifferentiated.
4. **`reference/settings-commands.md`** — delete the `switchboard.devDocsFolder` row from the settings table (line 122).
5. **Delete `artifacts/notebooklm.md`** — the NotebookLM export is removed.
6. **`integrations/remote-boards.md`** — remove the ClickUp-row clause "No Project Context Sync either." (line 25 — **prose, the build won't catch it**); delete the "Project Context Sync" section (lines 56–63: heading, the two bullets, the "source of truth…" line). Keep "Sync Health" above and "Provider-specific setup" below.
7. **Add `artifacts/create-plans.md`** — a new page describing the Create Plans tab: the source picker (zip / public link / platform-via-MCP), and the docs-not-code / behaviour-first principle (point an agent at your docs, get back a high-level plan, paste it onto the board).
8. **Reconcile the Artifacts prev/next chain in ONE pass, against the final page set** — with `dev-docs.md` and `notebooklm.md` gone and `create-plans.md` added, walk the Artifacts sequence and fix every `prev`/`next` frontmatter so the chain is contiguous end-to-end. Do this once, after steps 1/5/7, not incrementally per deletion.
9. **Release notes** — call out the NotebookLM removal explicitly and point users to the Create Plans tab as the replacement for "get context to an agent for planning."
10. **Build** — `cd switchboard-site && npm run build`. A dangling `prev`/`next` chain or a broken internal link fails the build.

## Watch out
- **Line 25 of `remote-boards.md` is prose, not a link** — the Astro build will NOT flag it; edit it by hand.
- **Do the chain reconciliation once, against the final set of pages** (both deletions + the new page applied) so there is exactly one contiguous prev/next order — don't repoint incrementally and leave a half-fixed chain.
- Internal doc links use the `/switchboard-site/` base and must be relative (`../page`, `../../section/page`) or they 404. `nav` lives in `src/data/nav.ts`; prev/next in each page's frontmatter.
- Before building, grep the whole `switchboard-site/src/pages/docs/` tree for `dev-docs`, `notebooklm`, and `project-context-sync` references and repoint/remove any stragglers.

## Verify
- `cd switchboard-site && npm run build` passes — no dead links, no broken prev/next chain.
- `grep -rn "dev-docs\|notebooklm\|project-context-sync" switchboard-site/src/pages/docs/` → 0 hits.
- `create-plans.md` renders and sits in the Artifacts nav; the prev/next chain walks end-to-end with no gaps.
- `dev-docs.md` and `notebooklm.md` 404 / are absent from the nav.
