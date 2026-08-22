# Move the docs site to switchboard.dev

## Goal

Serve the Switchboard docs from `https://switchboard.dev/docs` instead of `https://tentacleopera.github.io/switchboard-site/docs`, so the product has a stable URL that can be named in resident agent instructions and printed in the UI without encoding the hosting arrangement.

### Problem Analysis

The site (`switchboard-site` repo, Astro) is configured for GitHub Pages under a project path:

```
site: 'https://tentacleopera.github.io',
base: '/switchboard-site/',
```
(`astro.config.mjs:5-6`)

Every docs URL therefore carries both the account name and the repo name. Two consequences:

**It is not a citable address.** A resident instruction telling an agent where the docs are (see `shrink-the-injected-agent-protocol-block.md`) would bake `tentacleopera.github.io/switchboard-site` into ~4,000 users' `CLAUDE.md` files. Any later move invalidates every copy, and the injected block is regenerated only when the extension next syncs.

**The path prefix is hardcoded 233 times.** `grep -c '/switchboard-site/'` over `src/` returns **233 occurrences across many files**, including `Footer.astro`, `BaseLayout.astro`, and most docs pages under `src/pages/docs/`. These are literal strings, not `BASE_URL` interpolations — there are 46 `BASE_URL` usages across 8 files that *would* follow a config change automatically, but the 233 literals will not. This is the migration's real content, and it is the class of change that produces silent 404s: a wrong link still renders, still looks like a link, and fails only when clicked.

### Root Cause

`base` was set once for project-pages hosting, and links were then written by hand against the deployed URL rather than through `BASE_URL`. Each hardcoded path was individually correct at the time. Nothing enforced the interpolated form, so the config setting stopped being the single source of the prefix long ago.

## Metadata

**Complexity:** 4
**Tags:** docs, infrastructure, devops

## User Review Required

- **Confirmed scope: same site, same hosting, custom domain only.** Nothing about the build, the content structure, or the deployment changes. `switchboard.dev` points at the existing GitHub Pages deployment of this repo. That settles what were three open questions in an earlier revision.
- **DNS and domain ownership are yours, not this plan's.** The plan covers repo changes: `astro.config.mjs`, `public/CNAME`, `robots.txt`, and the 233 literals. Registering the domain, adding DNS records, and enabling the custom domain in repo settings are manual steps outside the diff. For an apex domain that means A/AAAA records to GitHub's Pages IPs (or an ALIAS/ANAME if the registrar supports it); a `www` host would be a CNAME to `tentacleopera.github.io`.
- **`deploy.yml` needs no change** — verified: it is `withastro/action@v6` with `path: .` and does not pin a base or artifact path. The base lives only in `astro.config.mjs`.

## Complexity Audit

### Routine

- `astro.config.mjs`: `site: 'https://switchboard.dev'`, `base: '/'`.
- `public/CNAME` containing `switchboard.dev` — the file does not exist yet and GitHub Pages requires it, or the custom domain resets on each deploy.
- `public/robots.txt`: the `Sitemap:` line currently names `https://tentacleopera.github.io/switchboard-site/sitemap-index.xml`.

### Complex / Risky

- **233 hardcoded `/switchboard-site/` literals.** A blind find-and-replace to `/` is wrong in at least two ways: it would rewrite prose mentions of the repo name (the repo is still called `switchboard-site`), and any `//`-producing replacement yields a protocol-relative URL that resolves to a different host entirely. Replace `/switchboard-site/` → `/` only in link position, and enumerate the prose exclusions rather than trusting a regex.
- **`base: '/'` changes what `BASE_URL` expands to**, so the 46 interpolated usages silently start producing correct output while the 233 literals silently start producing 404s. Both look the same in source. The only reliable check is crawling the built output, not reading the diff.
- **A 404 after this migration is invisible without a link checker.** The site has no link-checking gate today. Adding one is in scope for this plan, because otherwise the verification is "someone clicked around".
- **The site root already exists**, so no new landing page is needed: `src/pages/index.astro` serves `/`, and `src/pages/docs/index.astro` serves `/docs`. With `base: '/'` the resident instruction's `switchboard.dev/docs` resolves without any content change — which is what makes this a config-and-links migration rather than a restructure.
- **The extension names the old URL in three places** (`setup.html:2223`, `TaskViewerProvider.ts:14809`, `SetupPanelProvider.ts:1470`). Those are handled by `consolidate-the-docs-url-in-the-extension.md`, not here, but the two must not ship far apart: the extension pointing at a dead domain is the same failure as the docs pointing at a dead path.

## Edge-Case & Dependency Audit

**Migration.** None required — settled. The domain is registered before this ships, so the resident docs pointer never faces a 404, and GitHub's automatic project-path-to-custom-domain redirect covers old URLs in already-shipped versions. One live check of that redirect, then nothing to build. (The shipped-state rule still applies to the address; it is simply satisfied by the platform rather than by code.)

**Security.** A custom domain needs HTTPS enforced in Pages settings; verify the certificate provisions before announcing the URL. Do not leave the domain resolving over plain HTTP, and do not name it in agent instructions until TLS is live.

**Side effects.** Search rankings and any existing external links point at the old URL. The redirect is what preserves them.

**Ordering.** Strict prerequisite for both dependents. Nothing downstream may name `switchboard.dev` until it serves the docs over HTTPS.

## Dependencies

- **Blocks** `consolidate-the-docs-url-in-the-extension.md` — the extension should point at the new domain in the same release wave, not before it exists.
- **Blocks** the docs-pointer rule in `shrink-the-injected-agent-protocol-block.md`. That plan's other three rules are independent: if this slips, ship three rules and add the fourth later rather than holding the reduction or shipping a pointer to a 404.

## Adversarial Synthesis

**"Just use the github.io URL in the instruction — it works today."** It works and it is wrong to bake in: it encodes an account name and a repo name into ~4,000 users' `CLAUDE.md` files, regenerated only on next sync. The reason to own the domain is precisely that the resident instruction cannot be recalled.

**"233 replacements is too much churn for a URL change."** The churn already happened, spread over months of writing links by hand. This plan pays it once and — with the link checker — makes the next such change cheap. The alternative is that the prefix stays un-owned and the next move costs 233 edits again.

**"Do the extension and the site together in one plan."** They ship from different repos on different cadences: the site deploys on merge, the extension on a VSIX release. One plan spanning both would have to hold the site behind the slower of the two.

## Proposed Changes

1. **`astro.config.mjs`** → `site: 'https://switchboard.dev'`, `base: '/'`.
2. **Add `public/CNAME`** containing `switchboard.dev`.
3. **`public/robots.txt`** → sitemap at `https://switchboard.dev/sitemap-index.xml`.
4. **Rewrite the 233 `/switchboard-site/` literals** in link position to `/`, enumerating and excluding prose references to the repo name.
5. **No `deploy.yml` change** — recorded as a deliberate no-op so a reviewer does not go looking. `withastro/action@v6` with `path: .` reads the base from `astro.config.mjs`.
6. **Add a link-checking gate** over the built output, failing on any internal 404. This is the change that makes items 1–4 verifiable rather than hopeful, and it also catches the pre-existing breakage found earlier: the bare directory `/docs/getting-started/` has no index page — no docs section does — so that URL 404s today.
7. **No transition work.** The platform redirect covers old URLs; verify it once and move on.

### Migration

The old project-pages URL must keep resolving because three shipped extension versions name it. Confirm the Pages redirect covers it; if not, keep the project deployment alive during the transition.

## Verification Plan

### Goal Invariants

- `https://switchboard.dev/docs/getting-started/installation` serves the installation page over HTTPS.
- No internal link in the built output 404s.
- No `/switchboard-site/` string remains in link position anywhere in `src/`.
- The old URL still reaches the docs.

### Automated Tests

- **Link checker over the built site**, failing on any internal 404. Must run on the *built* output: the source diff cannot distinguish a `BASE_URL` expansion from a stale literal, which is the specific reason this migration is risky.
- **No stale prefix:** assert no `/switchboard-site/` in link position in `src/`, with the prose exclusions listed explicitly rather than pattern-matched.
- **Config coherence:** assert `CNAME` content matches the `site` host in `astro.config.mjs`. These drifting apart is how a custom domain silently reverts on deploy.
- **Sitemap host:** assert `robots.txt`'s sitemap URL matches the configured `site`.
- **Directory-index check:** assert every docs *section* path either serves a page or is not linked anywhere. This pins the pre-existing bug rather than carrying it across the move.

### Manual Verification

- Load the old URL and confirm it redirects to the new domain.
- Confirm HTTPS is enforced and the certificate is valid before anything names the domain.

## Outstanding Questions

- **Resolved — same site, same Pages hosting, custom domain only.** Items 1–4 are unaffected; item 5 is a confirmed no-op.
- **Resolved — the structure already fits.** `src/pages/index.astro` serves the root and `src/pages/docs/index.astro` serves `/docs`, so with `base: '/'` the string `https://switchboard.dev/docs` in the shrink plan's resident rule is correct as written. No content restructure, and no second decision about where docs live.
- ~~Is `switchboard.dev` registered?~~ **Settled:** it is registered before this ships to users, so nothing downstream needs a fallback.
- Does the Pages old-path redirect actually fire once the custom domain is set? Documented behaviour, but the migration argument above rests on it and it can only be checked live.
