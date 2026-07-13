# Switchboard Docs — Astro Migration & Landing Page Port

## Goal

Migrate the existing Switchboard marketing site (`switchboard-site` repo) from pure static HTML to an Astro project. The landing page (`index.html`) becomes `src/pages/index.astro` with shared layout components. This is the foundation plan — all subsequent docs plans depend on it.

## Metadata

**Complexity:** 4
**Tags:** frontend, infrastructure, refactor
**Project:** Website

## Parent Feature

This is subtask 1 of 4 in the **Switchboard Docs Section** feature. This plan covers the Astro scaffold + landing page migration + deploy pipeline.

## User Review Required

- **CSP policy decision:** if Astro inlines scripts, the user must approve either externalizing (preferred) or adding `'unsafe-inline'` to `script-src` (degrades CSP posture). Flag in chat before committing to either.
- **GitHub Pages source setting:** the repo's Settings → Pages → Source must be set to "GitHub Actions" (not "Deploy from branch"). User must verify/flip this in the GitHub UI — it cannot be done from code.
- **withastro/action version:** the plan pins `withastro/action@v1`. The user should confirm this is the current stable major before the deploy workflow runs (see Uncertain Assumptions).

## Complexity Audit

### Routine
- Scaffolding the Astro project (`npm create astro`, `astro.config.mjs`, `package.json`, `tsconfig.json`).
- Moving static assets (`assets/` → `public/assets/`, `.nojekyll` → `public/.nojekyll`).
- Extracting `styles.css` → `src/styles/global.css` (mechanical copy + path adjustments).
- Creating `Header.astro` and `Footer.astro` from existing HTML blocks (cut/paste into component shell).
- Adding the GitHub Actions deploy workflow from Astro's official template.
- Updating `README.md` to reflect the new project structure.

### Complex / Risky
- **Landing page visual regression through framework migration:** `index.html` → `index.astro` must produce byte-for-byte equivalent rendered output (same sections, classes, copy, interactions). Any drift in structure, asset paths, or script behavior is a regression. This is the genuinely fiddly part — Astro's component model, script bundling, and base-path handling all touch the output.
- **CSP vs Astro script bundling:** the current CSP (`script-src 'self'`) blocks inline scripts. Astro may inline small scripts by default. If it does, either configure externalization or relax CSP — both have trade-offs that need a conscious decision.
- **Base-path asset/font resolution:** all `url()` references in CSS and `src`/`href` attributes in HTML must resolve under `/switchboard-site/`. Astro's `base` config handles this for Astro-managed assets, but hardcoded absolute paths in the migrated HTML/CSS will break. Requires a full path audit post-build.

## Scope

### In scope
- Initialize Astro project in `switchboard-site/` repo
- Move static assets (`assets/` → `public/assets/`, `.nojekyll` → `public/.nojekyll`)
- Extract `styles.css` → `src/styles/global.css` (design tokens, `@font-face`, scanline/grid, component styles)
- Create `BaseLayout.astro` (shared `<html>` shell: `<head>` with meta, CSP, fonts, OG tags, bg-grid, scanline)
- Create `Header.astro` (sticky nav, migrated from `index.html` nav block — no `Docs` link yet, that's plan 2)
- Create `Footer.astro` (migrated from `index.html` footer — docs placeholder link stays for now)
- Migrate `index.html` → `src/pages/index.astro` (HTML structure identical, `<head>` moves to BaseLayout, nav/footer move to components)
- Move `main.js` → `src/scripts/landing.js` (imported by `index.astro` only — sticky nav, smooth-scroll, IntersectionObserver reveals, lazy video load)
- Configure `astro.config.mjs` (`site: 'https://tentacleopera.github.io'`, `base: '/switchboard-site/'`)
- Add `package.json` with `astro` devDependency + `build`/`dev` scripts
- Add `tsconfig.json` (Astro's extended config)
- Add `.github/workflows/deploy.yml` (Astro's official `withastro/action` — install deps → `astro build` → deploy `dist/` to Pages)
- Update `README.md` to reflect Astro project structure

### Out of scope
- Docs layout, sidebar, components (plan 2)
- Docs content pages (plans 3 & 4)
- `Docs` nav link (plan 2)
- Search, screenshots, syntax highlighting theme (polish phase)

## Proposed Changes

### New files
- `astro.config.mjs` — Astro config with `site` + `base` for GitHub Pages subpath
- `package.json` — `astro` devDependency, `build` and `dev` scripts
- `tsconfig.json` — Astro's default extended config
- `src/layouts/BaseLayout.astro` — shared `<html>` shell
- `src/components/Header.astro` — sticky nav (migrated from index.html)
- `src/components/Footer.astro` — footer (migrated from index.html)
- `src/styles/global.css` — extracted from current `styles.css`
- `src/pages/index.astro` — landing page (migrated from `index.html`)
- `src/scripts/landing.js` — moved from `main.js`
- `.github/workflows/deploy.yml` — GitHub Actions deploy workflow

### Modified/moved files
- `index.html` → deleted (replaced by `src/pages/index.astro`)
- `styles.css` → deleted (replaced by `src/styles/global.css`)
- `main.js` → moved to `src/scripts/landing.js`
- `assets/` → moved to `public/assets/`
- `.nojekyll` → moved to `public/.nojekyll`
- `README.md` → updated for Astro structure

## Key Technical Details

### astro.config.mjs
```js
import { defineConfig } from 'astro/config';
export default defineConfig({
  site: 'https://tentacleopera.github.io',
  base: '/switchboard-site/',
});
```

### BaseLayout.astro
- `<head>`: charset, viewport, title (from props), meta description (from props), canonical, OG/Twitter tags, favicon, CSP `<meta>` (same restrictive policy), `<link rel="stylesheet" href="/styles/global.css">` (Astro resolves the base prefix)
- `<body>`: bg-grid div, scanline div, `<Header />`, `<slot />`, `<Footer />`

### Landing page migration
- The `index.astro` page preserves the exact HTML structure of the current `index.html` — all sections, copy, video slots, classes.
- The `<script>` tag importing `landing.js` uses Astro's `<script>` tag (processed and bundled by Astro).
- Verify: sticky nav, smooth-scroll, IntersectionObserver reveals, lazy video load, `prefers-reduced-motion` fallback all still work.

### CSP consideration
Astro may inline small scripts. The current CSP (`script-src 'self'`) blocks inline scripts. Check the build output:
- If Astro externalizes all scripts → CSP stays as-is.
- If Astro inlines scripts → either configure Astro to externalize, or add `'unsafe-inline'` to `script-src` (less ideal, note it in the plan completion).

### tsconfig.json — path aliases
Astro's extended config should include path aliases so Markdown content pages (plans 3 & 4) can reference layouts without fragile relative paths:
```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@layouts/*": ["src/layouts/*"],
      "@components/*": ["src/components/*"],
      "@styles/*": ["src/styles/*"],
      "@data/*": ["src/data/*"]
    }
  }
}
```
Content pages then use `layout: @layouts/DocsLayout.astro` in frontmatter instead of `../../../layouts/DocsLayout.astro` (depth-dependent, error-prone). **Verify that Astro resolves `@`-aliases in Markdown `layout` frontmatter** — if it does not, fall back to the correct relative path (`../../../layouts/DocsLayout.astro` from `src/pages/docs/<tier>/page.md`). See Uncertain Assumptions.

### Deploy workflow
Use Astro's official action:
```yaml
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: withastro/action@v1
        with:
          path: .
```
This installs deps, builds, and deploys to Pages in one step. Ensure repo Settings → Pages → Source is set to "GitHub Actions".

## Edge-Case & Dependency Audit

### Race Conditions
- None. This is a static site migration — no runtime concurrency, no server state, no async data fetching.

### Security
- **CSP relaxation risk:** if Astro inlines scripts and the decision is to add `'unsafe-inline'` to `script-src`, the CSP posture degrades. Prefer externalization. Document the decision in the plan completion notes.
- **No new attack surface:** the migration adds no forms, no user input, no external API calls. The existing CSP (`connect-src 'none'`, `base-uri 'self'`, `form-action 'none'`, `frame-ancestors 'none'`) must be preserved verbatim in `BaseLayout.astro`.

### Side Effects
- **Deploy pipeline change:** switching from static HTML deploy to Astro build → GitHub Actions deploy. The first push after merge triggers the new workflow. The old deploy mechanism (if any) should be disabled to avoid conflicts.
- **Repo structure change:** `index.html`, `styles.css`, `main.js` are deleted/moved. Any external references to these paths (CDN links, bookmarks, other repos) will break. The GitHub Pages URL stays the same (`/switchboard-site/`).

### Dependencies & Conflicts
- **No upstream code dependencies.** This is the foundation plan.
- **Downstream:** plans 2, 3, 4 all depend on this plan's outputs (`BaseLayout.astro`, `Header.astro`, `Footer.astro`, `global.css`, Astro project structure, tsconfig path aliases).
- **Node.js version:** the GitHub Actions workflow needs Node 18+ (Astro requirement). Ensure the action's Node version matches local dev.

## Adversarial Synthesis

Key risks: landing page visual regression through framework migration (structure/path/script drift), CSP conflict with Astro's script bundling, and base-path asset/font resolution failures. Mitigations: diff rendered HTML against the current static site, audit all paths post-build, and make the CSP-vs-inline-scripts decision consciously before merge.

## Verification Plan

### Automated Tests
- **SKIP TESTS per session directive.** No automated test suite is run as part of this plan's verification. The site is a static marketing page with no test infrastructure. Verification is manual (visual regression, build output inspection, network audit).

### Manual Verification
- **Visual regression:** `astro dev` → landing page renders identically to the current static site. Check every section, every class, every interaction.
- **Build output:** `astro build` → `dist/` contains `index.html`, CSS, JS, fonts, assets. `.nojekyll` present in `dist/`.
- **Self-contained check:** serve `dist/` locally → DevTools Network → zero external requests.
- **CSP:** no console violations.
- **Subpath:** all URLs include `/switchboard-site/` prefix. No 404s.
- **Mobile:** responsive layout holds. iOS Safari video autoplay (muted + playsinline).
- **Lighthouse:** ≥95 on the built output (should be unchanged — Astro ships zero JS by default).
- **Path alias verification:** confirm `@layouts/*` aliases resolve in both `.astro` imports and (if supported) Markdown `layout` frontmatter.

## Uncertain Assumptions

- **Astro Markdown `layout` frontmatter path resolution:** it is uncertain whether Astro resolves the `layout` property in `.md` frontmatter relative to the page file, relative to `src/`, or via tsconfig path aliases (`@layouts/`). The plan sets up aliases and provides a relative-path fallback, but the user was advised to run web research to confirm the exact resolution mechanism before implementation.
- **`withastro/action` version:** the plan pins `withastro/action@v1`. It is uncertain whether `v1` is the current stable major or if a newer major (v2+) has been released with breaking changes. The user was advised to run web research to confirm the latest stable version before the deploy workflow is committed.

## Dependencies

- None. This is the foundation plan. Plans 2, 3, 4 depend on this being complete.

---

**Recommendation: Send to Coder.** (Complexity 4 — the genuinely fiddly part is the landing page regression through the framework migration. Everything else is scaffolding.)
