# Switchboard Docs Section

**Complexity:** 4

## Goal

Add a comprehensive multi-page documentation section to the Switchboard marketing site, served alongside the landing page on GitHub Pages. Migrate the site to Astro for shared layouts and components, build a sidebar-driven docs layout from the Stitch prototype, and author ~21 content pages across three tiers (Getting Started, Guides, Reference) adapted from the extension repo's README, how-to-use guide, and full user manual.

## How the Subtasks Achieve This

- **Astro Migration & Landing Page Port**: Scaffolds the Astro project, migrates the existing landing page from static HTML to `index.astro`, extracts shared CSS/fonts into reusable layout components (`BaseLayout`, `Header`, `Footer`), and sets up the GitHub Actions deploy pipeline. Foundation for all other subtasks.
- **Layout, Sidebar & Components**: Builds the docs visual shell — `DocsLayout` (two-column with sidebar), `DocsSidebar` (section tree with active-page highlighting), `PrevNext` pagination, `CodeBlock` with copy buttons, docs home page, and mobile drawer. Adds the `Docs` link to the site nav.
- **Content: Getting Started & Guides**: Authors ~10 Markdown pages covering installation, quick start, and 8 workflow guides (constitution, quota, features, design, remote control, PM sync, Claude Desktop, memo). Adapted from the README and how-to-use guide with links rewritten for the docs site.
- **Content: Reference (Full User Manual)**: Authors ~11 Markdown pages covering the exhaustive reference — all agent roles, AUTOBAN columns, planning tools, panels, settings/commands, architecture, DB schema, and troubleshooting. Adapted from the 1712-line user manual, split by area.

## Dependencies & sequencing

- **Plan 1 (Astro Migration)** must complete first — it creates the project scaffold, shared layouts, and deploy pipeline that all other plans depend on.
- **Plan 2 (Layout & Components)** depends on Plan 1 — it builds on top of `BaseLayout`, `Header`, `Footer`, and `global.css`.
- **Plans 3 & 4 (Content)** both depend on Plan 2 — they use `DocsLayout`, `DocsSidebar`, `PrevNext`, and `CodeBlock`. Plans 3 and 4 can run in parallel after Plan 2 is complete.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Switchboard Docs — Astro Migration & Landing Page Port](../plans/switchboard-docs-1-astro-migration.md) — **CODE REVIEWED**
- [ ] [Switchboard Docs — Layout, Sidebar & Components](../plans/switchboard-docs-2-layout-components.md) — **CODE REVIEWED**
- [ ] [Switchboard Docs — Content: Getting Started & Guides](../plans/switchboard-docs-3-content-getting-started-guides.md) — **CODE REVIEWED**
- [ ] [Switchboard Docs — Content: Reference (Full User Manual)](../plans/switchboard-docs-4-content-reference.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

### Completion Summary
Implemented complete Astro migration for marketing site. Replaced static index.html with index.astro, constructed shared BaseLayout, DocsLayout, and navigation/sidebar components. Authored 21 content and reference pages matching spec definitions. No regressions or build issues encountered during local assembly.

