# Switchboard Docs — Content: Getting Started & Guides

## Goal

Author ~10 Markdown content pages for the Getting Started and Guides tiers of the Switchboard docs site. Content is adapted from the extension repo's README and `how_to_use_switchboard.md`, with internal links rewritten to point to the new docs page URLs, voice adapted for a public audience, and stale references removed.

## Metadata

**Complexity:** 3
**Tags:** frontend, docs, feature
**Project:** Website

## Parent Feature

This is subtask 3 of 4 in the **Switchboard Docs Section** feature. This plan covers the Getting Started + Guides content pages.

**Depends on:** Plan 2 (`switchboard-docs-2-layout-components`) — requires `DocsLayout.astro`, `DocsSidebar.astro`, `PrevNext.astro`, `CodeBlock.astro`, the `nav.ts` config, and the `.code-block` CSS styling for fenced blocks to exist.

## User Review Required

- **Voice/tone calibration:** the README's casual tone ("while drinking a beer — you only need one hand") is kept for guides. The user should confirm this voice is appropriate for the public docs site, or if a more polished tone is preferred for specific pages.
- **Pre-release feature documentation:** the triage pipeline is pre-release/hidden. The plan keeps caveats but removes UI step documentation. User should confirm this boundary is correct.

## Complexity Audit

### Routine
- Writing 10 Markdown files with content adapted from existing source files (README, how-to-use guide).
- Rewriting internal links to docs-site URLs.
- Removing stale image references (`docs/TODO_*.png`).
- Adding frontmatter (layout, title, description, prev/next) to each page.
- Wiring sequential prev/next pagination across 10 pages.

### Complex / Risky
- **Content fidelity:** ~200 internal links must be rewritten correctly. A single broken link is a 404 on the live site. The source files have anchors, relative paths, and external URLs — each needs different handling.
- **Content completeness:** every section from the source files must be represented. Silent content drops are the main risk — there's no automated check for "did we port everything."
- **Duplicate content resolution:** some topics appear in both README and how-to-use guide. The plan says "use how-to-use as primary, pull from README where thin" — judgment calls required per page.
- **Version reference cleanup:** hardcoded version numbers (`v1.7.6`) must be replaced with Releases page links. Missing one leaves stale version info on the live site.

## Scope

### In scope
- Write all Getting Started pages (2 `.md` files)
- Write all Guides pages (8 `.md` files)
- Adapt content from source files (rewrite links, adapt voice, remove stale refs)
- Wire prev/next pagination across both tiers
- Each page uses `DocsLayout` via frontmatter layout reference

### Out of scope
- Reference tier content (plan 4)
- Docs layout/components (plan 2)
- Screenshots, search, syntax highlighting (polish)

## Pages to Author

### Getting Started (2 pages)

| File path | Source | Content |
|-----------|--------|---------|
| `src/pages/docs/getting-started/installation.md` | README §Install + user manual §2 | VS Code Marketplace install, VSIX sideload from Releases page, first-time setup wizard, git ignore strategy, opening the sidebar, setup wizard command |
| `src/pages/docs/getting-started/quick-start.md` | README §Getting Started + how-to-use §1 | Set up agent team (roles overview — brief, link to Reference/agent-roles for detail), create first plan (Create Plan button, Plan Scanner, NotebookLM), run the pipeline (drag cards, copy prompts), the 7-step lifecycle flow |

### Guides (8 pages)

| File path | Source | Content |
|-----------|--------|---------|
| `src/pages/docs/guides/constitution.md` | how-to-use §2 + README §1 | Project Constitution concept, per-project PRDs, PROJECT CONTEXT toggle, Architect tab guided setup, Notion design doc integration |
| `src/pages/docs/guides/quota-optimization.md` | how-to-use §3 | Task batching, Opus/Sonnet split, pair programming modes (CLI Parallel/Hybrid/Full Clipboard), spreading work across models, NotebookLM Airlock workflow |
| `src/pages/docs/guides/features-worktrees.md` | how-to-use §5 + README §Features | Creating features, three run modes (step/orchestrate/split), worktree isolation, feature-scoped agent config, PROMOTE TO FEATURE |
| `src/pages/docs/guides/design-in-the-loop.md` | how-to-use §6 + README §3 | Google Stitch integration (auth, settings, STITCH HTML tab), Claude design import (claude.ai/design), Claude Artifacts round-trip, Inspect Mode step-by-step |
| `src/pages/docs/guides/remote-control.md` | how-to-use §4 + README §Remote Control | Linear/Notion/ClickUp remote control config, sync modes (Ingest/Full), poll/push toggles, silent syncing, Sync Health, MCP Monitor, orchestration automation mode, auto-archive |
| `src/pages/docs/guides/pm-tool-sync.md` | README §ClickUp & Linear Sync + user manual §11 | ClickUp push-only mirror (content push, move tasks, feature round-trip), Linear two-way sync (bidirectional description, status sync, feature round-trip), Notion design docs, live sync mode, auto-pull timers, operation modes |
| `src/pages/docs/guides/claude-desktop.md` | how-to-use §8-9 + README §claude.ai | Claude Desktop MCP server bridge, Connect Claude Desktop button, four slash commands (/switchboard, /switchboard-cloud, /switchboard-remote, /switchboard-memo), chaining workflows, Project Manager role + Manage button |
| `src/pages/docs/guides/memo-capture.md` | README §Memo + user manual §28 | `/switchboard-memo` mode, append-only capture to `.switchboard/memo.md`, Memo sub-tab sidebar actions, `process memo` to exit + create plans, hotkey `cmd+shift+alt+m` |

## Content Adaptation Rules

1. **Keep technical accuracy:** all settings keys (`switchboard.kanban.dbPath`, etc.), command IDs (`switchboard.openKanban`), role names, and feature descriptions stay verbatim. These are reference material — don't paraphrase technical details.
2. **Adapt voice:** the README's casual tone ("while drinking a beer — you only need one hand") is fine for guides. Keep it developer-native, direct, no marketing fluff. Trim anything that reads as internal note-taking.
3. **Rewrite links:** the source files contain internal anchors (`#1-introduction--overview`), relative file paths (`docs/how_to_use_switchboard.md`), and external URLs. Replace with docs-site URLs:
   - `docs/how_to_use_switchboard.md` → `/docs/guides/constitution` (or whichever page covers that topic)
   - `docs/switchboard_user_manual.md` → `/docs/reference/agent-roles` (or whichever reference page)
   - Internal anchors → links to the relevant docs page
   - External URLs (GitHub, Marketplace) → keep as-is
4. **Remove stale refs:** delete `docs/TODO_*.png` image references. Delete the "pre-release, currently hidden" triage section's UI instructions but keep a note that it's pre-release.
5. **Cross-link between tiers:** Getting Started pages link to Guides for deeper coverage. Guides link to Reference pages for exhaustive detail. Use relative links (`../guides/quota-optimization` or `/docs/guides/quota-optimization`).
6. **Version references:** replace hardcoded `v1.7.6` / `switchboard-1.7.6.vsix` with a link to the Releases page (`https://github.com/TentacleOpera/switchboard/releases/latest`).
7. **Frontmatter:** each page has:
   ```yaml
   ---
   layout: @layouts/DocsLayout.astro
   title: "Installation"
   description: "How to install Switchboard and set up your first workspace."
   prev:
     title: "Docs Home"
     href: "/docs/"
   next:
     title: "Quick Start"
     href: "/docs/getting-started/quick-start"
   ---
   ```
   > **Layout path:** use the `@layouts/` tsconfig alias (set up in plan 1). If Astro does not resolve aliases in Markdown `layout` frontmatter, fall back to the correct relative path: `../../../layouts/DocsLayout.astro` (pages are at `src/pages/docs/<tier>/page.md`, three directories deep from `src/`). Do NOT use `../layouts/` or `../../layouts/` — those resolve to wrong directories. See Uncertain Assumptions.

## Prev/Next Flow

Pages flow sequentially across tiers:
1. Installation → 2. Quick Start → 3. Constitution & Governance → 4. Quota Optimization → 5. Features & Worktrees → 6. Design in the Loop → 7. Remote Control → 8. PM Tool Sync → 9. Claude Desktop & claude.ai → 10. Memo Capture → (first Reference page — **plan 4 owns this cross-tier link**)

> **Cross-tier prev/next ownership:** the last Guides page (Memo Capture) should have `next: null` in this plan. Plan 4 owns wiring the Memo Capture → Agent Roles cross-tier link because plan 4 knows the final Reference page URLs. If plan 4 lands after this plan, plan 4 modifies `src/pages/docs/guides/memo-capture.md`'s frontmatter to add the `next` link. If both land in the same PR, wire it during plan 4's execution.

## Edge-Case & Dependency Audit

### Race Conditions
- None. Static Markdown content — no runtime concurrency.

### Security
- **No new attack surface:** content pages are static Markdown. No user input, no forms, no external API calls. CSP from `DocsLayout`/`BaseLayout` is inherited.
- **External links:** links to GitHub, Marketplace, and claude.ai are external. The CSP `default-src 'self'` doesn't block link navigation (it blocks resource loads, not `<a href>` clicks). No security issue.

### Side Effects
- **Source file changes:** none. This plan creates new `.md` files in `src/pages/docs/`. It does not modify the extension repo's `docs/` source files — those are read-only references.
- **nav.ts alignment:** the page URLs in these `.md` files must exactly match the entries in `nav.ts` (created by plan 2). Mismatches cause broken sidebar links.

### Dependencies & Conflicts
- **Plan 2** must be complete — requires `DocsLayout`, `DocsSidebar`, `PrevNext`, `CodeBlock`, `nav.ts`, and `.code-block` CSS for fenced blocks.
- **Plan 4** (Reference) is independent but shares the cross-tier prev/next link. Plan 4 owns wiring the Memo Capture → Agent Roles link. See Prev/Next Flow section.
- **Shared surface — `nav.ts`:** plan 2 owns it. This plan consumes it read-only. The 10 page URLs created here must match `nav.ts` entries exactly.
- **Shared surface — `src/pages/docs/guides/memo-capture.md`:** this plan creates it. Plan 4 may modify its frontmatter (to add the `next` link to Agent Roles). Ordering: this plan creates the file with `next: null`; plan 4 finalizes the cross-tier link.

## Adversarial Synthesis

Key risks: silent content drops during adaptation (~200 links to rewrite, no automated completeness check), frontmatter layout path errors (wrong relative depth breaks all 10 pages at build time), and nav.ts URL mismatches causing broken sidebar links. Mitigations: create a source-to-page coverage checklist, use the `@layouts/` alias with a verified-correct fallback path, and cross-check every page URL against `nav.ts` before merge.

## Verification Plan

### Automated Tests
- **SKIP TESTS per session directive.** No automated test suite is run. Verification is manual.

### Manual Verification
- **All pages render:** `astro build` → no errors. Each page accessible at its URL.
- **Content completeness:** every section from the source files is represented. No content dropped silently. Create a source-to-page coverage checklist.
- **Links resolve:** no 404s on internal docs links. External links (GitHub, Marketplace) point to correct URLs.
- **Prev/next:** sequential flow works across all 10 pages. First page links back to docs home. Last page (Memo Capture) has `next: null` (plan 4 wires the cross-tier link).
- **Sidebar active state:** each page highlights correctly in the sidebar.
- **Code blocks:** settings keys, command IDs, and config examples render in `.code-block` style with the dark bg/border/glow (via CSS selectors on fenced blocks, not the CodeBlock component).
- **Tables:** render with dark-theme styling, no overflow on mobile.
- **Frontmatter layout path:** verify all 10 pages build successfully with the `@layouts/` alias (or the correct relative fallback path).

## Uncertain Assumptions

- **Astro Markdown `layout` frontmatter path resolution:** it is uncertain whether Astro resolves the `@layouts/` tsconfig alias in `.md` frontmatter `layout` property. The plan provides a verified relative-path fallback (`../../../layouts/DocsLayout.astro`). The user was advised to run web research to confirm before implementation.
- **Source file section coverage:** the plan maps source sections to output pages, but it is uncertain whether every section of the README and how-to-use guide is accounted for. A manual coverage check during implementation is required.

## Dependencies

- **Plan 2** (`switchboard-docs-2-layout-components`) — must be complete. Requires `DocsLayout`, `DocsSidebar`, `PrevNext`, `CodeBlock`, and `nav.ts`.
- Plan 4 (Reference) is independent of this plan but shares the same layout components. Both can run in parallel after plan 2.

---

**Recommendation: Send to Coder.** (Complexity 3 — content adaptation is labor but not risky. The main effort is rewriting ~200 links and ensuring no content is lost.)
