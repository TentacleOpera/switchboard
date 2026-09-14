# Move the docs site to labcom.dev

> **RENAMED 2026-09-12.** The site is **labcom.dev**, not switchboard.dev — this follows *One Name End to End: Switchboard Becomes LABCOM, and the CLI Becomes `lc`* (PLAN REVIEWED), which does not itself name a domain. Every `switchboard.dev` reference in the body below has been updated. The plan's **title and filename deliberately still say `switchboard-dev`**: renaming the file would purge this card and re-import it as a new one, losing its column and history. Read the title as the card's identity, not as the target domain.

> **MERGED 2026-09-14.** The memo plan `memo-the-docs-site-has-two-pages-for-one-feature-and-no-link-check.md` was folded into this plan during feature review. Its Changes 1 (two pages for one feature), 2 (moved-tab description), and 3 (no link check) are all `switchboard-site` repo work and the link-check gate was already proposed here (Proposed Change 6) — the two plans overlapped on exactly that gate. Change 4 (release-notes surface) does not serve this feature's goal and is deferred to the **Plan-Authoring Contract** feature (see Outstanding Questions). The memo plan file was `git rm`'d; all four findings survive here.

## Goal

Serve the Switchboard docs from `https://labcom.dev/docs` instead of `https://tentacleopera.github.io/switchboard-site/docs`, so the product has a stable URL that can be named in resident agent instructions and printed in the UI without encoding the hosting arrangement.

### Problem Analysis

The site (`switchboard-site` repo, Astro) is configured for GitHub Pages under a project path:

```
site: 'https://tentacleopera.github.io',
base: '/switchboard-site/',
```
(`astro.config.mjs:5-6`)

Every docs URL therefore carries both the account name and the repo name. Two consequences:

**It is not a citable address.** A resident instruction telling an agent where the docs are (see `shrink-the-injected-agent-protocol-block.md`) would bake `tentacleopera.github.io/switchboard-site` into ~4,000 users' `CLAUDE.md` files. Any later move invalidates every copy, and the injected block is regenerated only when the extension next syncs.

**The path prefix is hardcoded 325 times.** `grep -rco '/switchboard-site/'` over `src/` returns **325 occurrences across 66 files** (counted 2026-09-14; the count drifts as pages are edited, so re-run it before the rewrite rather than trusting this number), including `Footer.astro`, `BaseLayout.astro`, and most docs pages under `src/pages/docs/`. These are literal strings, not `BASE_URL` interpolations — there are 46 `BASE_URL` usages across 8 files that *would* follow a config change automatically, but the 325 literals will not. This is the migration's real content, and it is the class of change that produces silent 404s: a wrong link still renders, still looks like a link, and fails only when clicked.

### Root Cause

`base` was set once for project-pages hosting, and links were then written by hand against the deployed URL rather than through `BASE_URL`. Each hardcoded path was individually correct at the time. Nothing enforced the interpolated form, so the config setting stopped being the single source of the prefix long ago.

## Metadata

**Complexity:** 5
**Tags:** docs, infrastructure, devops

## User Review Required

- **Confirmed scope: same site, same hosting, custom domain only.** Nothing about the build, the content structure, or the deployment changes. `labcom.dev` points at the existing GitHub Pages deployment of this repo. That settles what were three open questions in an earlier revision.
- **DNS and domain ownership are yours, not this plan's.** The plan covers repo changes: `astro.config.mjs`, `public/CNAME`, `robots.txt`, and the 325 literals. Registering the domain, adding DNS records, and enabling the custom domain in repo settings are manual steps outside the diff. For an apex domain that means A/AAAA records to GitHub's Pages IPs (or an ALIAS/ANAME if the registrar supports it); a `www` host would be a CNAME to `tentacleopera.github.io`.
- **`deploy.yml` needs no change** — verified: it is `withastro/action@v6` with `path: .` and does not pin a base or artifact path. The base lives only in `astro.config.mjs`.
- **Which page is canonical for Create Plans?** *(merged from memo)* — `create-plans.md` or `web-agents.md`. Default assumption: `web-agents.md` (full walkthrough), `create-plans.md` is removed (site has not launched, no redirect needed).

## Complexity Audit

### Routine

- `astro.config.mjs`: `site: 'https://labcom.dev'`, `base: '/'`.
- `public/CNAME` containing `labcom.dev` — the file does not exist yet and GitHub Pages requires it, or the custom domain resets on each deploy.
- `public/robots.txt`: the `Sitemap:` line currently names `https://tentacleopera.github.io/switchboard-site/sitemap-index.xml`.

### Complex / Risky

- **325 hardcoded `/switchboard-site/` literals** (re-count before editing; the number drifts). A blind find-and-replace to `/` is wrong in at least two ways: it would rewrite prose mentions of the repo name (the repo is still called `switchboard-site`), and any `//`-producing replacement yields a protocol-relative URL that resolves to a different host entirely. Replace `/switchboard-site/` → `/` only in link position, and enumerate the prose exclusions rather than trusting a regex.
- **`base: '/'` changes what `BASE_URL` expands to**, so the 46 interpolated usages silently start producing correct output while the 325 literals silently start producing 404s. Both look the same in source. The only reliable check is crawling the built output, not reading the diff.
- **A 404 after this migration is invisible without a link checker.** The site has no link-checking gate today. Adding one is in scope for this plan, because otherwise the verification is "someone clicked around".
- **The site root already exists**, so no new landing page is needed: `src/pages/index.astro` serves `/`, and `src/pages/docs/index.astro` serves `/docs`. With `base: '/'` the resident instruction's `labcom.dev/docs` resolves without any content change — which is what makes this a config-and-links migration rather than a restructure.
- **The extension names the old URL in three places** (`setup.html:2386`, `TaskViewerProvider.ts:15906`, `SetupPanelProvider.ts:1720`). Those are handled by `consolidate-the-docs-url-in-the-extension.md`, not here, but the two must not ship far apart: the extension pointing at a dead domain is the same failure as the docs pointing at a dead path.

## Edge-Case & Dependency Audit

**Migration.** None required. labcom.dev has not launched — no shipped version names it and no external links point at it — so this is a clean cutover, not a migration. The old `github.io` URL is the current deployment; once the custom domain is live it simply stops being the canonical address. No redirect preservation is needed because nothing has been launched at the new domain yet. (Per the shipped-state rule, the dividing line is whether state shipped in a released version; the new domain has not.)

**Security.** A custom domain needs HTTPS enforced in Pages settings; verify the certificate provisions before announcing the URL. Do not leave the domain resolving over plain HTTP, and do not name it in agent instructions until TLS is live.

**Side effects.** The old `github.io` URL stops being the canonical address. Since labcom.dev has not launched, there are no external links or search rankings at the new domain to preserve — this is a clean cutover, not a redirect migration.

**Ordering.** Strict prerequisite for both dependents. Nothing downstream may name `labcom.dev` until it serves the docs over HTTPS.

## Dependencies

- **Blocks** `consolidate-the-docs-url-in-the-extension.md` — the extension should point at the new domain in the same release wave, not before it exists.
- **Blocks** the docs-pointer rule in `shrink-the-injected-agent-protocol-block.md`. That plan's other three rules are independent: if this slips, ship three rules and add the fourth later rather than holding the reduction or shipping a pointer to a 404.

## Adversarial Synthesis

**"Just use the github.io URL in the instruction — it works today."** It works and it is wrong to bake in: it encodes an account name and a repo name into ~4,000 users' `CLAUDE.md` files, regenerated only on next sync. The reason to own the domain is precisely that the resident instruction cannot be recalled.

**"233 replacements is too much churn for a URL change."** The churn already happened, spread over months of writing links by hand — it is 325 now and still growing. This plan pays it once and — with the link checker — makes the next such change cheap. The alternative is that the prefix stays un-owned and the next move costs 325 edits again.

**"Do the extension and the site together in one plan."** They ship from different repos on different cadences: the site deploys on merge, the extension on a VSIX release. One plan spanning both would have to hold the site behind the slower of the two.

## Proposed Changes

1. **`astro.config.mjs`** → `site: 'https://labcom.dev'`, `base: '/'`.
2. **Add `public/CNAME`** containing `labcom.dev`.
3. **`public/robots.txt`** → sitemap at `https://labcom.dev/sitemap-index.xml`.
4. **Rewrite the 325 `/switchboard-site/` literals** in link position to `/`, enumerating and excluding prose references to the repo name. Re-count before editing; the number drifts.
5. **No `deploy.yml` change** — recorded as a deliberate no-op so a reviewer does not go looking. `withastro/action@v6` with `path: .` reads the base from `astro.config.mjs`.
6. **Add a link-checking gate** over the built output, failing on any internal 404. This is the change that makes items 1–4 verifiable rather than hopeful, and it also catches the pre-existing breakage found earlier: the bare directory `/docs/getting-started/` has no index page — no docs section does — so that URL 404s today. *(Merged from the memo plan `memo-the-docs-site-has-two-pages-for-one-feature-and-no-link-check.md` Change 3 — that plan and this one both proposed the same gate; this plan owns it.)*
7. **No transition work.** labcom.dev has not launched, so there is no redirect to preserve — clean cutover, not a migration.
8. **Canonicalise the Create Plans / Web Agents duplication** *(merged from memo Change 1)*. `src/pages/docs/artifacts/create-plans.md` and `src/pages/docs/integrations/web-agents.md` both document the same feature, and both are listed in `src/data/nav.ts` (`:83` Create Plans, `:115` Web Agents — line numbers drift). `create-plans.md` already says "see Web Agents for the full walkthrough", so it is the signpost and `web-agents.md` is the canonical page. Since the site has not launched, just remove the duplicate and keep one in the nav — no redirect needed. This is an author decision (which page is canonical) — see User Review Required.
9. **Correct the moved-tab description** *(merged from memo Change 2)*. A docs page describes Create Plans as an Artifacts tab; it moved to `connections.html` (labelled "Web Agents") on 2026-08-05 (`3753e3ef`), at `:249` and `:312`. `planning.html` no longer owns it. Correct this instance here. The general fix — "a docs plan reads current webview HTML before writing" — belongs with the **Plan-Authoring Contract** feature, not this one; record it there, not here.
10. **Release-notes surface — deferred, not this plan** *(merged from memo Change 4)*. No `CHANGELOG` exists in either the extension or the site repo, and no release/changelog entry is in the site nav. A docs plan elsewhere carries a release-note step that cannot be executed. This is a process/template concern, not a site-repo change, and does not serve this feature's goal ("one docs URL"). It belongs with the **Plan-Authoring Contract** feature — see Outstanding Questions.

### Migration

None. labcom.dev has not launched — no shipped version names it and no external links point at it — so the old `github.io` URL simply stops being canonical when the custom domain goes live. No redirect to preserve, no transition window to maintain.

## Verification Plan

### Goal Invariants

- `https://labcom.dev/docs/getting-started/installation` serves the installation page over HTTPS.
- No internal link in the built output 404s.
- No `/switchboard-site/` string remains in link position anywhere in `src/`.
- Exactly one nav entry documents Create Plans; the other page is removed (negative: not two; positive: one canonical page resolvable).
- No docs page describes Create Plans as an Artifacts tab.

### Automated Tests

- **Link checker over the built site**, failing on any internal 404. Must run on the *built* output: the source diff cannot distinguish a `BASE_URL` expansion from a stale literal, which is the specific reason this migration is risky.
- **No stale prefix:** assert no `/switchboard-site/` in link position in `src/`, with the prose exclusions listed explicitly rather than pattern-matched.
- **Config coherence:** assert `CNAME` content matches the `site` host in `astro.config.mjs`. These drifting apart is how a custom domain silently reverts on deploy.
- **Sitemap host:** assert `robots.txt`'s sitemap URL matches the configured `site`.
- **Directory-index check:** assert every docs *section* path either serves a page or is not linked anywhere. This pins the pre-existing bug rather than carrying it across the move.
- **Single canonical page for Create Plans** *(merged from memo)*: assert `nav.ts` lists exactly one of `create-plans` / `web-agents` for that feature, and the other is absent from `src/pages/` (removed, not redirected — the site has not launched).
- **Moved-tab description correct** *(merged from memo)*: assert no docs page under `src/pages/docs/` describes Create Plans as an Artifacts tab; the canonical page names the Connections panel's Web Agents tab.

### Manual Verification

- Confirm HTTPS is enforced and the certificate is valid before anything names the domain.
- Confirm the canonical Create Plans page describes the Web Agents tab in `connections.html`, not an Artifacts tab.

## Outstanding Questions

- **Resolved — same site, same Pages hosting, custom domain only.** Items 1–4 are unaffected; item 5 is a confirmed no-op.
- **Resolved — the structure already fits.** `src/pages/index.astro` serves the root and `src/pages/docs/index.astro` serves `/docs`, so with `base: '/'` the string `https://labcom.dev/docs` in the shrink plan's resident rule is correct as written. No content restructure, and no second decision about where docs live.
- ~~Is `labcom.dev` registered?~~ **Settled:** it is registered before this ships to users, so nothing downstream needs a fallback.
- **[user] Which page is canonical for Create Plans — `create-plans.md` or `web-agents.md`?** *(merged from memo Change 1)* — proceeding on the assumption that `web-agents.md` is canonical (it holds the full walkthrough; `create-plans.md` already defers to it) and `create-plans.md` is removed (the site has not launched, so no redirect is needed).
- **[deferred] Release-notes surface** *(merged from memo Change 4)* — no `CHANGELOG` exists in either repo and a docs plan elsewhere carries a release-note step that cannot execute. This does not serve this feature's goal and belongs with the **Plan-Authoring Contract** feature (decide there feature: create a release-notes surface, or delete the step from the plan template). Not actioned here; recorded so the finding is not lost.
