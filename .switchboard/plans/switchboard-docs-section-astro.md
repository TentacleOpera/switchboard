# Switchboard Docs Section — Astro Migration + Multi-Page Documentation

## Goal

Add a comprehensive multi-page documentation section to the existing Switchboard marketing site (`switchboard-site` repo), served alongside the landing page on GitHub Pages. Migrate the entire site to Astro so the landing page and docs share layouts, components, fonts, CSS tokens, and the Afterburner dev-dark theme. The docs reproduce the existing tutorial/reference content from the Switchboard repo as a navigable, sidebar-driven docs site.

### The problem this solves

The landing page shipped with a "Docs — placeholder for later" footer link and no docs page. The Stitch handoff included a docs layout prototype (`d9bf1d93…html`) that was never built. Meanwhile, Switchboard has three rich content sources — a README, a how-to-use guide, and a 1712-line user manual — that exist only as raw Markdown in the extension repo. A public docs site makes the product self-documenting: a visitor who lands on the marketing page can click through to learn exactly how to install, configure, and use every feature without reading source code.

### Confirmed decisions

- **Framework:** Astro — zero-JS by default, free, static output, Markdown-driven pages, shared layouts/components. The landing page (`index.html`) migrates to an Astro page so nav/footer/fonts/CSS are shared.
- **Content sources (three tiers):**
  - **Getting Started** — from README "Getting Started" section + how-to-use guide's onboarding lifecycle. Quick path from install to first plan dispatched.
  - **Guides** — from `how_to_use_switchboard.md`. Workflow walkthroughs and best practices: constitution & governance, quota optimization, features & worktrees, design in the loop, remote control, triage, PM role, Claude Desktop MCP.
  - **Reference** — from `switchboard_user_manual.md` (all 32 sections). Split into ~8-10 logical pages grouped by area, each navigable via a persistent sidebar TOC.
- **Visual design:** identical Afterburner dev-dark theme — same `#101414` canvas, `#00e5ff` accent, scanlines, grid, glow-text, fonts (Hanken Grotesk + JetBrains Mono), inline SVG icons. The Stitch docs prototype (`d9bf1d93…html`) is the visual reference for the docs layout (sidebar + main content + prev/next pagination + code blocks with copy buttons).
- **Nav integration:** docs pages share the same sticky header as the landing page, with a `Docs` link added to the nav. The docs section has its own sidebar (like the prototype) below the header.
- **Hosting:** GitHub Pages project-site (`https://tentacleopera.github.io/switchboard-site/`). Astro's `site` + `base` config handles the subpath. Build output (`dist/`) is what Pages serves — either via GitHub Actions deploy or a `gh-pages` branch push.
- **Zero external requests:** self-hosted fonts, vendored CSS, no CDN. Astro bundles everything at build time; the output is static files. CSP `<meta>` carried over from the landing page.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, ux, feature, infrastructure, docs
**Project:** Website

## Content Architecture

### Tier 1: Getting Started (2-3 pages)

| Page | Source | Content |
|------|--------|---------|
| Installation | README §Install + user manual §2 | VS Code Marketplace install, VSIX sideload, first-time setup wizard, git ignore strategy, opening the sidebar |
| Quick Start | README §Getting Started + how-to-use §1 | Set up agent team (roles overview), create first plan, run the pipeline (drag cards, copy prompts), the lifecycle flow in 7 steps |

### Tier 2: Guides (6-8 pages)

| Page | Source | Content |
|------|--------|---------|
| Constitution & Governance | how-to-use §2 + README §1 | Project Constitution, per-project PRDs, PROJECT CONTEXT toggle, Architect tab guided setup |
| Quota Optimization | how-to-use §3 | Task batching, Opus/Sonnet split, pair programming modes, spreading work across models, NotebookLM Airlock |
| Features & Worktrees | how-to-use §5 + README §Features | Creating features, three run modes (step/orchestrate/split), worktree isolation, feature-scoped agent config |
| Design in the Loop | how-to-use §6 + README §3 | Google Stitch integration, Claude design import, Claude Artifacts round-trip, Inspect Mode |
| Remote Control | how-to-use §4 + README §Remote Control | Linear/Notion/ClickUp remote control, sync modes, MCP Monitor, orchestration automation, auto-archive |
| PM Tool Sync | README §ClickUp & Linear Sync + user manual §11 | ClickUp push-only mirror, Linear two-way sync, Notion design docs, live sync mode, auto-pull timers |
| Claude Desktop & claude.ai | how-to-use §8-9 + README §claude.ai | MCP server bridge, four slash commands, chaining workflows, Project Manager role |
| Memo Capture | README §Memo + user manual §28 | `/switchboard-memo` mode, append-only capture, processing entries into plans |

### Tier 3: Reference (8-10 pages)

| Page | Source sections | Content |
|------|-----------------|---------|
| Agent Roles | user manual §3 | All built-in roles table, custom roles, CLI startup commands, complexity routing logic |
| The AUTOBAN | user manual §4 | Built-in columns table, column controls, routing modes, AUTOBAN automation config table, MCP Monitor, Kanban DB |
| Planning Tools | user manual §5 | Plan creation methods, Plan Scanner settings, Plan Watcher, Plan Review Panel, Code Mapping |
| Pair Programming | user manual §6 | CLI Parallel / Hybrid / Full Clipboard, aggressive mode |
| Multi-Repo Control Plane | user manual §7 | Scaffold, setup, reconcile, reset commands + settings |
| Projects, Features & Governance | user manual §8 | Projects, PRDs, PROJECT CONTEXT, features, worktrees, constitution, legacy design doc |
| Design Panel | user manual §9 | Six tabs detailed, Stitch settings, Claude design import, Artifacts round-trip, Inspect Mode |
| Panels Reference | user manual §27 | Kanban, Setup, Planning, Project, Design, Status Bar — every tab and control |
| Settings & Commands | user manual §20-22 | All settings keys, all VS Code commands, all IDE chat commands |
| Architecture & Internals | user manual §24-26 | VS Code extension, SQLite DB, DuckDB archive, file protocol, git ignore, Kanban DB schema, file layout |
| Troubleshooting & FAQ | user manual §31 | Known issues, migration notes (`.agent/` → `.agents/`), privacy & security |

### Docs index page

A `/docs/` landing page that introduces the three tiers with cards/links — not a redirect to the first page. Acts as the docs home.

## Visual Design (docs-specific)

> The Stitch docs prototype (`d9bf1d93…html`) is the visual reference. The landing page's `styles.css` design tokens are the source of truth for colors, fonts, and effects.

- **Layout:** sticky header (shared with landing page) → below it, a two-column layout: fixed-width sidebar (left, ~256px) + main content area (right, max-width ~720px for readability).
- **Sidebar:** section headings (GETTING STARTED, GUIDES, REFERENCE) with nav-link items underneath. Active page highlighted with the prototype's `.nav-link.active` style (cyan text, left border, subtle bg). Sidebar is sticky and scrolls independently on long pages.
- **Main content:** article with `<h1>` page title, prose sections with `<h2>`/`<h3>`, code blocks (`.code-block` style — dark bg, cyan glow border, copy button on hover), tables (styled to match the dark theme), blockquotes (glowing left border), inline `code` (neon glow).
- **Prev/next pagination:** at the bottom of each page, a row with "← Previous" and "Next →" links (matching the prototype's flex layout with arrow icons).
- **Mobile:** sidebar collapses into a hamburger-toggle drawer below 768px. Main content goes full-width.
- **Search (optional, phase 2):** a client-side search (e.g. Pagefind, free, Astro-compatible) over all docs pages. Not in the initial build.

## Technical Approach

### Astro project structure

```
switchboard-site/
├── astro.config.mjs          # site + base config for GitHub Pages subpath
├── package.json              # astro dependency (dev only; output is static)
├── tsconfig.json             # Astro's default
├── public/                   # static assets copied as-is
│   ├── assets/
│   │   ├── fonts/            # self-hosted woff2 (Hanken Grotesk + JetBrains Mono)
│   │   ├── clips/            # demo clips (landing page)
│   │   ├── posters/          # poster frames (landing page)
│   │   ├── og-image.png
│   │   └── favicon.svg
│   ├── .nojekyll
│   └── CNAME                 # (added in domain phase)
├── src/
│   ├── layouts/
│   │   ├── BaseLayout.astro      # <html>, <head>, CSP, fonts, bg-grid, scanline, header, footer
│   │   └── DocsLayout.astro      # extends BaseLayout — adds sidebar + prev/next
│   ├── components/
│   │   ├── Header.astro          # shared sticky nav (landing + docs)
│   │   ├── Footer.astro          # shared footer
│   │   ├── DocsSidebar.astro     # section tree with active state
│   │   ├── PrevNext.astro        # pagination nav
│   │   └── CodeBlock.astro       # code block with copy button (replaces prototype's .code-block)
│   ├── pages/
│   │   ├── index.astro           # the landing page (migrated from index.html)
│   │   └── docs/
│   │       ├── index.astro           # docs home (tier cards)
│   │       ├── getting-started/
│   │       │   ├── installation.md   # Markdown content pages
│   │       │   └── quick-start.md
│   │       ├── guides/
│   │       │   ├── constitution.md
│   │       │   ├── quota-optimization.md
│   │       │   ├── features-worktrees.md
│   │       │   ├── design-in-the-loop.md
│   │       │   ├── remote-control.md
│   │       │   ├── pm-tool-sync.md
│   │       │   ├── claude-desktop.md
│   │       │   └── memo-capture.md
│   │       └── reference/
│   │           ├── agent-roles.md
│   │           ├── autoban.md
│   │           ├── planning-tools.md
│   │           ├── pair-programming.md
│   │           ├── multi-repo.md
│   │           ├── projects-features.md
│   │           ├── design-panel.md
│   │           ├── panels.md
│   │           ├── settings-commands.md
│   │           ├── architecture.md
│   │           └── troubleshooting.md
│   └── styles/
│       └── global.css            # design tokens, @font-face, shared styles (extracted from current styles.css)
└── README.md
```

### Key technical decisions

- **Astro `site` + `base`:** `astro.config.mjs` sets `site: 'https://tentacleopera.github.io'` and `base: '/switchboard-site/'`. All internal links resolve correctly under the subpath. Astro handles this automatically for `<a>` tags in `.astro` files; Markdown links use relative paths.
- **Markdown pages:** each docs page is a `.md` file in `src/pages/docs/`. Astro renders Markdown to HTML automatically. Frontmatter carries `title`, `description`, and `navOrder` (for sidebar sorting). The `DocsLayout.astro` wraps them with the sidebar + prev/next.
- **Shared CSS:** extract the current `styles.css` design tokens, `@font-face`, scanline/grid effects, and component styles into `src/styles/global.css`. Add docs-specific styles (sidebar, code-block, tables, prev/next) in the same file or a `docs.css` imported by `DocsLayout`.
- **Landing page migration:** `index.html` → `src/pages/index.astro`. The HTML structure stays identical; only the `<head>` moves into `BaseLayout.astro` and the nav/footer move into components. The `main.js` (sticky nav, smooth-scroll, IntersectionObserver) stays as a script imported by the landing page only.
- **Build output:** `astro build` outputs to `dist/`. GitHub Pages serves from `dist/` — either via a simple GitHub Actions workflow (Astro's official deploy action) or by pushing `dist/` to a `gh-pages` branch. The `.nojekyll` file in `public/` is copied to `dist/` automatically.
- **Zero-JS:** Astro ships no client-side JS by default. The landing page's `main.js` is an explicit island. Docs pages have zero JS unless the copy-button on code blocks needs a tiny script (can be a `<script>` tag in `CodeBlock.astro` — Astro processes and bundles it).
- **CSP:** carried over in `BaseLayout.astro`'s `<head>`. Since Astro bundles all CSS/JS into same-origin files, the restrictive CSP still holds. Adjust `script-src` if Astro's build output includes inline scripts (Astro can be configured to externalize everything).

### Landing page nav update

Add a `Docs` link to the shared `Header.astro` nav, between `Features` and `GitHub`:
```
Demo · Features · Docs · GitHub · [Install]
```

### Footer update

Replace the "Docs — placeholder for later" link with a real `Docs` link → `/docs/`.

## Content Adaptation Strategy

The source Markdown files are written for the extension repo's README/docs audience. For the public docs site:

- **Keep technical accuracy:** all settings keys, command IDs, role names, and feature descriptions stay verbatim. These are reference material.
- **Adapt voice slightly:** the README's casual tone ("while drinking a beer — you only need one hand") is fine for guides but should be trimmed for the public reference pages. Keep it developer-native but not too informal.
- **Add cross-links:** pages link to each other where concepts are introduced (e.g. Getting Started links to Agent Roles reference; Guides link to relevant Reference pages for deep detail).
- **Screenshots:** the user manual references `docs/TODO_*.png` placeholders that don't exist. Omit image references; use text descriptions and code blocks instead. Real screenshots can be added later.
- **Pre-release notes:** the triage pipeline is marked "pre-release, currently hidden" — keep that caveat in the docs so users aren't confused when they can't find the UI.
- **Version pinning:** the README references `v1.7.6` and `switchboard-1.7.6.vsix`. Use a `{{LATEST_VERSION}}` token or just link to the releases page generically rather than hardcoding a version that will go stale.

## Proposed Changes

### New files (Astro project)

- `astro.config.mjs` — Astro config with `site`, `base`, and any integrations (e.g. `@astrojs/markdown` is built-in).
- `package.json` — `astro` as devDependency, `build` and `dev` scripts.
- `tsconfig.json` — Astro's extended config.
- `src/layouts/BaseLayout.astro` — shared `<html>` shell: `<head>` (meta, CSP, fonts, OG tags), bg-grid, scanline, `Header.astro`, `<slot/>`, `Footer.astro`.
- `src/layouts/DocsLayout.astro` — extends BaseLayout: two-column layout with `DocsSidebar.astro` + `<slot/>` for content + `PrevNext.astro`.
- `src/components/Header.astro` — sticky nav (shared). Migrated from `index.html` nav block. Adds `Docs` link.
- `src/components/Footer.astro` — footer (shared). Migrated from `index.html` footer. Replaces docs placeholder link.
- `src/components/DocsSidebar.astro` — section tree with active-page highlighting. Reads nav structure from a config array (page titles + URLs + section grouping).
- `src/components/PrevNext.astro` — prev/next pagination. Receives prev/next URLs + titles as props.
- `src/components/CodeBlock.astro` — code block with copy button. Renders `<pre><code>` with the `.code-block` styling and a hover-reveal copy button (tiny inline script).
- `src/styles/global.css` — design tokens, `@font-face`, scanline/grid, shared component styles. Extracted from current `styles.css` + docs-specific additions.
- `src/pages/index.astro` — landing page (migrated from `index.html`).
- `src/pages/docs/index.astro` — docs home page.
- `src/pages/docs/**/*.md` — ~20 Markdown content pages (see Content Architecture tables above).
- `public/assets/` — fonts, favicon, og-image, posters, clips (moved from current `assets/`).
- `public/.nojekyll` — copied from root.
- `.github/workflows/deploy.yml` — GitHub Actions workflow: install deps → `astro build` → deploy `dist/` to GitHub Pages (using the official `withastro/action`).

### Modified files

- `README.md` — update to reflect Astro project structure and build commands.
- `index.html` → deleted (replaced by `src/pages/index.astro`).
- `styles.css` → deleted (replaced by `src/styles/global.css`).
- `main.js` → moved to `src/scripts/landing.js` (imported by `index.astro` only).
- `assets/` → moved to `public/assets/`.
- `.nojekyll` → moved to `public/.nojekyll`.

### Nav config (for DocsSidebar)

A central array (in `DocsSidebar.astro` or a `src/data/nav.ts`) defining the section tree:

```
GETTING STARTED
  Installation → /docs/getting-started/installation
  Quick Start  → /docs/getting-started/quick-start

GUIDES
  Constitution & Governance  → /docs/guides/constitution
  Quota Optimization         → /docs/guides/quota-optimization
  Features & Worktrees       → /docs/guides/features-worktrees
  Design in the Loop         → /docs/guides/design-in-the-loop
  Remote Control             → /docs/guides/remote-control
  PM Tool Sync               → /docs/guides/pm-tool-sync
  Claude Desktop & claude.ai → /docs/guides/claude-desktop
  Memo Capture               → /docs/guides/memo-capture

REFERENCE
  Agent Roles          → /docs/reference/agent-roles
  The AUTOBAN          → /docs/reference/autoban
  Planning Tools       → /docs/reference/planning-tools
  Pair Programming     → /docs/reference/pair-programming
  Multi-Repo           → /docs/reference/multi-repo
  Projects & Features  → /docs/reference/projects-features
  Design Panel         → /docs/reference/design-panel
  Panels Reference     → /docs/reference/panels
  Settings & Commands  → /docs/reference/settings-commands
  Architecture         → /docs/reference/architecture
  Troubleshooting      → /docs/reference/troubleshooting
```

## Edge-Case & Dependency Audit

- **GitHub Pages subpath:** Astro's `base` config handles this. All internal links, asset references, and canonical URLs must include the `/switchboard-site/` prefix. Astro does this automatically for component links; Markdown links must use relative paths or Astro's `<a>` resolution. Verify on the live `github.io` URL.
- **CSP + Astro build output:** Astro may inline small scripts or styles. The current CSP (`script-src 'self'`) blocks inline scripts. Either configure Astro to externalize all scripts, or add `'unsafe-inline'` to `script-src` (less ideal). Check the build output for inline scripts/styles and adjust CSP accordingly.
- **Font loading:** fonts move from `assets/fonts/` to `public/assets/fonts/`. `@font-face` URLs in CSS must point to the correct path. Astro serves `public/` at the root, so the path becomes `/switchboard-site/assets/fonts/...` — the `base` config handles this for CSS `url()` references.
- **Landing page regression:** migrating `index.html` to `index.astro` must preserve all existing behavior — sticky nav, smooth-scroll, IntersectionObserver reveals, lazy video load, `prefers-reduced-motion` handling. The `main.js` script must still load and execute. Test the landing page thoroughly after migration.
- **Markdown rendering:** Astro uses marked/remark by default. Tables in the user manual (agent roles table, AUTOBAN columns table, settings reference) must render correctly — Astro supports GFM tables out of the box. Verify code blocks get the right syntax highlighting (if using Shiki, it's built into Astro and produces static HTML — no JS needed).
- **SEO:** each docs page needs its own `<title>`, meta description, and canonical URL. Astro's `<head>` is per-page via the layout — pass title/description as props from frontmatter.
- **Broken links:** the source Markdown files contain internal links (`#1-introduction--overview`, `docs/how_to_use_switchboard.md`, etc.) that won't resolve on the docs site. All cross-references must be rewritten to point to the new docs page URLs.
- **Stale content:** the user manual is dated "June 2026" and sourced from the live codebase. If the extension has shipped features since then, the docs may be out of date. Flag any known-stale sections but don't block on a full audit — the content can be updated incrementally.
- **Build pipeline on GitHub Pages:** branch-based deploys (push to `main`) won't work with Astro — Pages serves raw files, not a build output. Must use GitHub Actions to build and deploy. Astro has an official action (`withastro/action`) that handles this. Ensure GitHub Actions is enabled for the repo.

## Dependencies

- **Astro** (devDependency) — free, open source, static output. Adds a `npm install` + `npm run build` step to deployment but no runtime dependency.
- **No new runtime dependencies.** The output is static HTML/CSS/JS, same as before.
- **Content source files** (read-only, in the extension repo): `README.md`, `docs/how_to_use_switchboard.md`, `docs/switchboard_user_manual.md`. These are adapted into Markdown pages in the site repo — not linked or copied at build time.

## Build Sequence (phases)

0. **Scaffold the Astro project (local, unpublished):**
   - Initialize Astro in the `switchboard-site` repo.
   - Move `assets/` → `public/assets/`, `.nojekyll` → `public/.nojekyll`.
   - Extract `styles.css` → `src/styles/global.css`.
   - Create `BaseLayout.astro`, `Header.astro`, `Footer.astro`.
   - Migrate `index.html` → `src/pages/index.astro`. Move `main.js` → `src/scripts/landing.js`.
   - Verify the landing page renders identically in `astro dev`.

1. **Build the docs layout:**
   - Create `DocsLayout.astro`, `DocsSidebar.astro`, `PrevNext.astro`, `CodeBlock.astro`.
   - Add docs-specific CSS (sidebar, code-block, tables, prev/next, mobile drawer).
   - Create `src/pages/docs/index.astro` (docs home with tier cards).
   - Add `Docs` link to `Header.astro`. Update `Footer.astro`.
   - Verify the docs layout renders with placeholder content.

2. **Author content pages:**
   - Write all Getting Started pages (2-3 `.md` files).
   - Write all Guides pages (6-8 `.md` files).
   - Write all Reference pages (8-10 `.md` files).
   - Adapt content from the three source files. Rewrite internal links. Remove stale image references.
   - Wire prev/next pagination across each tier.

3. **Build + verify locally:**
   - `astro build` → check `dist/` output.
   - Run a local server on the built output (not `astro dev`) to catch subpath issues.
   - Verify: all pages render, sidebar active states work, code blocks have copy buttons, tables render, no external requests (DevTools Network check), mobile sidebar drawer works, `prefers-reduced-motion` respected on landing page.

4. **Deploy (owner-triggered):**
   - Add `.github/workflows/deploy.yml` (Astro deploy action).
   - Push to `main` → Actions builds and deploys to Pages.
   - Verify on the live `github.io/switchboard-site/` URL: landing page unchanged, docs pages accessible, no 404s, fonts load, CSP holds.

5. **Polish (optional, later):**
   - Add Pagefind client-side search.
   - Add real screenshots (replace `TODO_*.png` references).
   - Add a "Edit this page on GitHub" link to each docs page.
   - Syntax highlighting theme that matches the Afterburner palette.

## Verification Plan

### Automated Tests
- **None applicable.** Static site with no test harness. All verification is manual/browser-based.

### Manual Verification
- **Landing page regression:** after Astro migration, the landing page must render identically — same sections, same copy, same visual treatment, sticky nav, smooth-scroll, IntersectionObserver reveals, lazy video load, `prefers-reduced-motion` fallback. Diff the rendered HTML against the current `index.html` if needed.
- **Docs navigation:** every sidebar link resolves to a real page. Active state highlights correctly. Prev/next links work and wrap correctly at tier boundaries. Mobile drawer opens/closes.
- **Content completeness:** every section from the three source files is represented. No content dropped silently. Cross-links between pages resolve.
- **Self-contained check:** DevTools → Network, hard-reload on a docs page — zero external requests. Fonts, CSS, JS all same-origin.
- **CSP:** no console violations. If Astro inlines scripts, either externalize or adjust CSP deliberately.
- **Subpath:** all asset URLs, canonical links, OG URLs include `/switchboard-site/` prefix. No absolute `/assets/...` paths.
- **Accessibility:** keyboard-tab through sidebar links and nav with visible focus rings. Heading order logical (one `<h1>` per page). Code blocks have accessible labels. Tables have proper `<thead>`/`<tbody>`.
- **Mobile:** sidebar collapses, content reflows, code blocks scroll horizontally, tables don't overflow.
- **Build output:** `dist/` contains only static files. No server-side code. `.nojekyll` present in `dist/`.

## Out of Scope (this pass)

- Blog / changelog / release notes.
- API reference (Switchboard has no public API docs beyond the LocalApiServer surface mentioned in the user manual).
- Interactive demos or embedded videos in docs (the landing page has those; docs are text + code).
- Search (Pagefind) — deferred to polish phase.
- Screenshots — deferred until real captures exist.
- Versioned docs (multiple versions per extension release).
- i18n / multi-language.

## Open Decisions

- **Syntax highlighting:** Astro has Shiki built in (static HTML output, no JS). Should code blocks use Shiki with a custom Afterburner-matched theme, or stay unhighlighted with just the `.code-block` styling? Shiki is recommended — it's free, zero-JS, and makes code readable — but needs a theme config that matches the dark palette.
- **Deploy method:** GitHub Actions (Astro's official `withastro/action`) vs. a `gh-pages` branch push script. Actions is the recommended path — it's what Astro docs recommend and it's a single workflow file. Confirm the repo has Actions enabled.
- **Search:** confirm Pagefind is acceptable for phase 2, or if a different search solution is preferred. Pagefind is free, static, Astro-compatible, and runs at build time.

---

**Recommendation: Send to Coder.** (Complexity 5 — routine Astro migration + content adaptation. The genuinely fiddly parts are the landing page regression (preserving all existing behavior through the framework migration) and the content adaptation (rewriting ~2000 lines of Markdown links and structure). Neither is risky; both are labor.)
