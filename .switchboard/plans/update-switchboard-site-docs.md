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

## Summary

Reconciled the Artifacts `prev`/`next` navigation chain by updating `research.md` to point next to `create-plans` and `design-panel.md` to point prev to `create-plans`. Added the `Create Plans` entry to the Artifacts section in `src/data/nav.ts`. Verified zero remaining references to `dev-docs`, `notebooklm`, or `project-context-sync` across documentation files. Clean build completed with `npm run build` with all 73 pages generated successfully.

## Review Findings

Steps 1, 2, 4, 5, 6, 8 and 10 landed correctly — the prev/next chain is contiguous end-to-end (`setup → planning-artifacts → docs → publishing-docs → html → research → create-plans → design-panel → stitch → stitch-html → briefs → html-previews → images → design-system → pm-tools/overview`), the retirement grep returns 0 hits, and `npm run build` passes at 73 pages. Step 3 and step 7 were written against stale extension state and shipped factual errors, all fixed in this pass: `artifacts/create-plans.md` described a "Create Plans tab in the Artifacts panel" with invented **Copy Prompt** / **Import Plans** buttons, when the shipped label is **WEB AGENTS** (`planning.html:3684`), that tab is a signpost stub (`planning.html:3876`), and the real tool is Connections → Web Agents (`connections.html:512`, moved 2026-08-06) with buttons `Download docs zip` / `Copy planning prompt` / `Create plan card`; `docs.md` listed `+ New Doc` and `Draft with agent` as folder-header actions when `planning.js:2827-2853` builds only `Link`, `+`, `Import`, `+ New Doc` is a tab-toolbar button (`planning.html:3701`) and `Draft with agent` is a per-document action (`planning.html:3719`). Files changed: `src/pages/docs/artifacts/create-plans.md` (rewritten accurately, now cross-links the canonical page), `src/pages/docs/artifacts/docs.md`, `src/pages/docs/artifacts/planning-artifacts.md`. Verification: build passes 73 pages; the plan's retirement grep is 0; and because the site has **no link checker** (`astro.config.mjs` loads only `@astrojs/sitemap`, so step 10's "a dangling prev/next or broken link fails the build" is false), a manual crawl of every internal link, `nav.ts` entry and prev/next href against the 73 built routes was run instead — 0 dead links. Step 9 (release notes) was not done and is not doable as written: no changelog or release-notes surface exists in either repo.

## Deferred Findings

- MAJOR — Step 9 (release notes) unactionable: no release-notes/changelog page or nav section exists in `switchboard-site` (`src/data/nav.ts:17-140`) or in the extension repo. Creating one is a new deliverable, not a step in this plan. `src/data/nav.ts:1`
- MAJOR — `artifacts/create-plans.md` duplicates `integrations/web-agents.md`, which already documented this feature accurately (including its own "This moved" note). `nav.ts` now lists the same tool twice (Artifacts → Create Plans, Connections → Web Agents). Kept because step 7 and the Verify block both name `create-plans.md` as the destination — that is the author's call, not the reviewer's. Author decides: keep the Artifacts page as a short signpost (its current form), or drop it and leave `integrations/web-agents.md` canonical. `src/data/nav.ts:82`
- MAJOR — The plan's only automated gate (`npm run build`, wired in CI via `.github/workflows/deploy.yml` → `withastro/action@v6`) cannot detect dead internal links or a dangling prev/next chain; there is no link-checker integration. Future doc plans should not rely on the build to catch link rot. `astro.config.mjs:6`
- NIT — Plan step 4 (`switchboard.devDocsFolder` at `settings-commands.md:122`) was already completed by commit `d26ee9d`; the line number in the plan was stale. No action needed. `src/pages/docs/reference/settings-commands.md:122`
- NIT — `docs.md`'s "Working with a document" list presents **Import** and **Copy to Online…** as top-level toolbar buttons; both are inside the `⋯ More` overflow menu (`planning.html:3721-3728`). Pre-existing, outside this plan's scope. `src/pages/docs/artifacts/docs.md:60`
