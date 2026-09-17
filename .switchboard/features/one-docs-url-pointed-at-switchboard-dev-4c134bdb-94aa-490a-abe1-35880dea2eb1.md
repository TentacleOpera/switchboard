# One docs URL, pointed at labcom.dev

> **RENAMED 2026-09-12.** The site is **labcom.dev**, not switchboard.dev — this follows *One Name End to End: Switchboard Becomes LABCOM, and the CLI Becomes `lc`* (PLAN REVIEWED), which does not itself name a domain. Every `switchboard.dev` reference in the body below has been updated. The plan's **title and filename deliberately still say `switchboard-dev`**: renaming the file would purge this card and re-import it as a new one, losing its column and history. Read the title as the card's identity, not as the target domain.

**Complexity:** 5

## Goal

Consolidate the extension's docs URL into a single constant and retire the tutorial prompt, then move the docs site to labcom.dev. Order matters: consolidating first means the domain move is a one-line change, where doing it the other way round edits every call site twice.

## How the Subtasks Achieve This

- **Consolidate the extension's docs URL and retire the tutorial prompt**: collapses the scattered docs links into a single constant (in a module both composition roots' shared providers import) and drops the tutorial prompt that duplicates them. The two providers (`SetupPanelProvider`, `TaskViewerProvider`) are wired by both the standalone host and the extension, so this is shared work, not legacy-host-only.
- **Move the docs site to labcom.dev**: repoints the site config at the new domain, rewrites the 325 hardcoded path literals, and adds the link-checking gate the site has never had. Also absorbs the memo plan's site findings — canonicalising the duplicate Create Plans / Web Agents pages and correcting the moved-tab description — since they are the same repo and the link checker was already in scope here.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Consolidate the extension's docs URL and retire the tutorial prompt](../plans/consolidate-the-docs-url-in-the-extension.md) — **PLAN REVIEWED** — ID: 31dc334a-cd8f-4420-babb-65da087a7dab
- [ ] [Move the docs site to labcom.dev](../plans/move-the-docs-site-to-switchboard-dev.md) — **PLAN REVIEWED** — ID: e5c23780-8e2e-4384-b3ab-a4382bf62cdf
<!-- END SUBTASKS -->

## Dependencies & sequencing

Ordered. **Move the site first, then consolidate the extension URL.** The site must be live at `labcom.dev` over HTTPS before the extension's constant points at it — otherwise two working OPEN DOCS buttons become broken ones. With the domain live and one constant in place, the domain is a single edit; done the other way round, every call site is edited twice. The newly imported Mission Control dock plan already expects to read the docs URL from the constant this feature establishes rather than carrying its own literal.

The memo plan's site findings (duplicate pages, moved-tab description, link check) merged into the site-move subtask — same repo, and the link checker was already in scope there. The memo's release-notes-surface finding does not serve this feature's goal and is deferred to the *Plan-Authoring Contract* feature (recorded in the site-move plan's Outstanding Questions).

## Team Dispatch Instructions

### Consolidate the extension's docs URL and retire the tutorial prompt

- **Seat:** Intern (Complexity 2 — single constant extraction, three call sites, one button deletion; reuses the existing `openDocs` message pattern).
- **Acceptance:**
  - Exactly one docs-origin literal exists in `src/`, and it is `https://labcom.dev/docs`; no `github.io` string remains in `src/`.
  - No `src/` file contains the words "COPY TUTORIAL PROMPT"; `setup.html` has no `btn-copy-tutorial-prompt` id or handler.
  - The `openDocs` message is still posted and handled (OPEN DOCS not orphaned by the sibling button's removal).
  - OPEN DOCS opens a page that resolves (manual click).
- **Must not touch:** None specified. (Constraint is ordering, not files: do not ship before the domain is live — see the site-move subtask.)

### Move the docs site to labcom.dev

- **Seat:** Coder (Complexity 5 — multi-file literal rewrite across 66 files, config/CNAME/robots changes, a new link-check CI gate, plus the merged content canonicalisation; the literal-rewrite class is the one that produces silent 404s).
- **Acceptance:**
  - `https://labcom.dev/docs/getting-started/installation` serves the installation page over HTTPS.
  - No internal link in the built output 404s (link-check gate passes on built site, not just source diff).
  - No `/switchboard-site/` string remains in link position anywhere in `src/`; `CNAME` content matches the `site` host in `astro.config.mjs`.
  - Exactly one nav entry documents Create Plans; the other page is removed (site has not launched, no redirect); no docs page describes Create Plans as an Artifacts tab.
- **Must not touch:** `deploy.yml` (deliberate no-op — `withastro/action@v6` reads the base from `astro.config.mjs`). The extension repo's docs URLs are handled by the sibling subtask, not here.

