# Rewrite README to match the online docs

## Goal

Replace the drifted `README.md` with a concise README whose framing, positioning, and structure match the online documentation site, and which links out to it as the canonical reference instead of duplicating it.

### Problem Analysis

`README.md` predates the current positioning captured on the docs site — the 0→1 arc (research → plan → design → code → review), the open roster / Copy Prompt story, the project → feature → plan hierarchy, and remote boards. It's now a third, stale source of truth alongside the (soon-deleted) bundled manual and the online docs. A README should orient a GitHub visitor and funnel them to the online docs, not re-document the product.

## Dependencies

Pairs with the docs-retirement plan (after it, the README is the single in-repo doc, and may serve as `_openDocs`'s offline fallback). Use the online docs (`switchboard-site/src/pages/docs`) as the source of framing so the two stay consistent.

## Metadata

**Tags:** docs, marketing, cleanup
**Complexity:** 3

## User Review Required

Approve the README voice/positioning — it's the repo's front door.

## Proposed Changes

- Rewrite `README.md` to mirror the online docs' framing:
  - one-line pitch (run the whole build 0→1, concept to shipped);
  - the arc (research → plan → design → code → review, kept legible on one board);
  - the core differentiators, matching the site: a project model (not a task list), the move is the dispatch, works with anything (Copy Prompt / open roster), before-the-first-line interchange;
  - install (`npx switchboard` for the browser board + the VS Code extension);
  - a prominent **Full documentation → https://tentacleopera.github.io/switchboard-site/** link.
- Keep it short: **orient + link, don't duplicate.** Pull section headings/wording from `switchboard-site/src/pages/docs` so the README and site read as one voice.
- Remove any references to the deleted bundled manual. If the docs-retirement plan keeps a README offline fallback, make sure the README stands on its own for that purpose.

### Repo
switchboard (extension). Cross-reference: switchboard-site docs for framing.

## Definition of Done
README reflects current positioning, links to the online docs as canonical, contains no references to the deleted bundled manual, and reads consistently with the site.
