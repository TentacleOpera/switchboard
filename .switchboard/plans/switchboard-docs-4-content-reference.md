# Switchboard Docs — Content: Reference (Full User Manual)

## Goal

Author ~11 Markdown content pages for the Reference tier of the Switchboard docs site. Content is adapted from the extension repo's 1712-line `switchboard_user_manual.md`, split into logical pages grouped by area. This is the exhaustive reference — every setting, every command, every panel, architecture, DB schema, troubleshooting.

## Metadata

**Complexity:** 3
**Tags:** frontend, docs, feature
**Project:** Website

## Parent Feature

This is subtask 4 of 4 in the **Switchboard Docs Section** feature. This plan covers the Reference tier content pages.

**Depends on:** Plan 2 (`switchboard-docs-2-layout-components`) — requires `DocsLayout.astro`, `DocsSidebar.astro`, `PrevNext.astro`, `CodeBlock.astro`, `nav.ts`, and the `.code-block` CSS styling for fenced blocks.

**Can run in parallel with:** Plan 3 (Getting Started + Guides) — both depend only on plan 2.

## User Review Required

- **Settings page split decision:** the settings reference (§20) may be extremely long. The plan says "consider splitting into two pages (Settings + Commands). Use your judgement." The user should confirm whether a split is desired or if one long page is acceptable.
- **Pre-release triage pipeline content:** the plan keeps the triage pipeline content with a pre-release callout. The user should confirm this content should be publicly documented (even with a caveat) vs. omitted entirely until the feature ships.

## Complexity Audit

### Routine
- Writing 11 Markdown files with content ported from the 1711-line user manual.
- Rewriting internal links and anchors to docs-site URLs.
- Removing stale image references (`docs/TODO_*.png`).
- Adding frontmatter (layout, title, description, prev/next) to each page.
- Wiring sequential prev/next pagination across 11 pages.

### Complex / Risky
- **Content completeness for 1711 lines:** every section (§1–§32) must be represented somewhere. Silent drops are the primary risk — there's no automated check. A coverage checklist mapping source sections to output pages is mandatory.
- **Table rendering on mobile:** the user manual has many wide tables (roles, columns, AUTOBAN config, settings). On mobile, these overflow. The plan wraps tables in `overflow-x: auto` containers, but this must be applied consistently to every table across 11 pages.
- **Very long pages:** the Panels reference (§27) and Settings/Commands (§20-22) pages may be hundreds of lines. Readability and in-page navigation (TOC) are concerns.
- **Cross-tier link wiring:** this plan owns wiring the Memo Capture (plan 3) → Agent Roles (plan 4) prev/next link. This modifies a file created by plan 3 (`src/pages/docs/guides/memo-capture.md`). If plan 3 hasn't landed yet, the file won't exist — the link must be wired when plan 3 lands.

## Scope

### In scope
- Write all Reference pages (~11 `.md` files)
- Adapt content from `switchboard_user_manual.md` (split 32 sections into ~11 pages)
- Rewrite all internal links to docs-site URLs
- Remove stale image references (`docs/TODO_*.png`)
- Wire prev/next pagination across the Reference tier
- Wire the last Guides page's `next` link to the first Reference page

### Out of scope
- Getting Started + Guides content (plan 3)
- Docs layout/components (plan 2)
- Screenshots, search, syntax highlighting (polish)

## Pages to Author

| File path | Source sections (user manual) | Content |
|-----------|-------------------------------|---------|
| `src/pages/docs/reference/agent-roles.md` | §3 | All built-in roles table (14 roles), custom roles config, CLI startup commands, complexity routing logic (manual override → agent rec → Band B fallback) |
| `src/pages/docs/reference/autoban.md` | §4 | Built-in columns table (12 columns with IDs/labels/order/role/AUTOBAN/drag-drop), column controls, routing modes, AUTOBAN automation config table, MCP Monitor, Kanban DB (sql.js, fallback, settings) |
| `src/pages/docs/reference/planning-tools.md` | §5 | Plan creation methods (Create Plan, clipboard import, NotebookLM, unclaimed import), Plan Scanner settings (all 8 settings keys), Plan Watcher, Plan Review Panel features, Code Mapping |
| `src/pages/docs/reference/pair-programming.md` | §6 | CLI Parallel / Hybrid / Full Clipboard modes, aggressive mode setting, command |
| `src/pages/docs/reference/multi-repo.md` | §7 | Scaffold/setup/clear/refresh/reconcile/reset commands, control plane root setting, onboarding dismissal |
| `src/pages/docs/reference/projects-features.md` | §8 | Projects (create, assign, filter, delete, PRD, PROJECT CONTEXT toggle), Features (create, promote, subtasks, orchestrate, delete, three run modes, worktree dispatch routing), Constitution, legacy design doc settings |
| `src/pages/docs/reference/design-panel.md` | §9 | Six tabs detailed (STITCH, STITCH HTML, BRIEFS, HTML PREVIEWS, IMAGES, DESIGN SYSTEM), Stitch settings (5 keys), Claude design import, Artifacts round-trip, Inspect Mode (6 steps), all tab shared features |
| `src/pages/docs/reference/panels.md` | §27 | Kanban panel (all tabs: KANBAN, AGENTS, PROMPTS, AUTOMATION, REMOTE, WORKTREES, UAT, SETUP), Setup panel, Planning panel (DOCS, TICKETS, RESEARCH, NotebookLM), Project panel (KANBAN PLANS, PROJECTS, FEATURES, CONSTITUTION, SYSTEM, TUNING, ARCHITECT, REMOTE), Design panel, Status Bar Hub, Themes |
| `src/pages/docs/reference/settings-commands.md` | §20-22 | All settings reference (every `switchboard.*` key with type/default), all VS Code commands, all IDE chat commands (/switchboard, /switchboard-cloud, /switchboard-remote, /switchboard-memo, /improve-plan, /archive, /export) |
| `src/pages/docs/reference/architecture.md` | §24-26 | VS Code extension architecture, local SQLite DB, DuckDB plan archive, file protocol, git ignore integration, Kanban DB schema (tables + columns), file layout & runtime state |
| `src/pages/docs/reference/troubleshooting.md` | §23, §29, §31 | Privacy & security (local-first, SecretStorage, MIT), automated triage pipeline (pre-release caveat), troubleshooting/FAQ, migration notes (.agent/ → .agents/) |

## Content Adaptation Rules

1. **Keep everything:** the user manual is the authoritative reference. Don't summarize or trim — port it faithfully. If a section is long, it's long. Reference pages are expected to be exhaustive.
2. **Split by area, not by source section:** some source sections are short (§6 Pair Programming is 10 lines). Merge short sections into related pages rather than creating stubs. The mapping table above shows the groupings.
3. **Tables:** the user manual has many tables (roles, columns, AUTOBAN config, settings). These are critical reference content. Render as Markdown tables. Verify they look right in the dark theme and don't overflow on mobile (may need `overflow-x: auto` on table containers).
4. **Settings reference:** §20 is a long flat list of settings keys. Keep it as a table with columns: Setting Key | Type | Default | Description. If it's extremely long, consider splitting into two pages (Settings + Commands). Use your judgement based on the actual content length.
5. **Rewrite links:** same rules as plan 3. Internal anchors (`#4-the-autoban-kanban-board`) → relative links to the relevant reference page (`../reference/autoban` from another reference page, or `autoban` from within the same `reference/` directory). **Research confirmed: Astro does NOT auto-prefix root-relative links in Markdown** — use relative links between docs pages, NOT root-relative (`/docs/reference/...`). Cross-references to Guides pages use relative paths (`../guides/constitution`). External URLs (GitHub, Marketplace) stay as full URLs.
6. **Remove stale refs:** delete all `docs/TODO_*.png` image references. Delete `![...](docs/TODO_*.png)` lines entirely.
7. **Pre-release content:** the triage pipeline (§29) is marked "pre-release, currently hidden." Keep the content but add a callout/note at the top: "This feature is pre-release and not currently exposed in the UI."
8. **Version references:** the manual is dated "June 2026." Add a note at the top of the reference section: "Last updated: June 2026. Sourced from the live codebase." Don't hardcode extension version numbers.
9. **Frontmatter:** same pattern as plan 3. Use `layout: ../../../layouts/DocsLayout.astro` (explicit relative path). **Research confirmed: tsconfig path aliases (`@layouts/`) do NOT work in Markdown `layout` frontmatter.** Reference pages are at `src/pages/docs/reference/page.md` — same depth as Getting Started/Guides pages, three directories deep from `src/`. Do NOT use `../../layouts/` — that resolves to `src/pages/layouts/` which doesn't exist.

## Prev/Next Flow

Reference pages flow sequentially:
1. Agent Roles → 2. The AUTOBAN → 3. Planning Tools → 4. Pair Programming → 5. Multi-Repo → 6. Projects & Features → 7. Design Panel → 8. Panels → 9. Settings & Commands → 10. Architecture → 11. Troubleshooting

The first Reference page (Agent Roles) has `prev` pointing to the last Guides page (Memo Capture from plan 3). The last Reference page (Troubleshooting) has `next: null`.

> **Cross-tier link ownership:** THIS plan owns wiring the Memo Capture → Agent Roles link. This means modifying `src/pages/docs/guides/memo-capture.md` (created by plan 3) to add its `next` link pointing to `/docs/reference/agent-roles`. If plan 3 has already landed, modify the file directly. If plan 3 hasn't landed yet, defer this wiring until it does — the file must exist before its frontmatter can be edited.

## Edge-Case & Dependency Audit

### Race Conditions
- None. Static Markdown content — no runtime concurrency.

### Security
- **No new attack surface:** content pages are static Markdown. No user input, no forms, no external API calls. CSP inherited from `DocsLayout`/`BaseLayout`.
- **DB schema exposure:** the Architecture page documents the Kanban DB schema (tables, columns). This is public reference information about a local-first tool — no security risk (the DB is local, not networked).

### Side Effects
- **Source file changes:** none. This plan creates new `.md` files. The extension repo's `docs/switchboard_user_manual.md` is a read-only reference.
- **Cross-file modification:** this plan modifies `src/pages/docs/guides/memo-capture.md` (created by plan 3) to wire the cross-tier prev/next link. This is the only file outside this plan's own page set that it touches.
- **nav.ts alignment:** the 11 Reference page URLs must exactly match the `nav.ts` entries created by plan 2.

### Dependencies & Conflicts
- **Plan 2** must be complete — requires `DocsLayout`, `DocsSidebar`, `PrevNext`, `CodeBlock`, `nav.ts`, and `.code-block` CSS for fenced blocks.
- **Plan 3** (Getting Started + Guides) — not a hard dependency, but the cross-tier link wiring requires plan 3's Memo Capture page to exist. If plan 3 hasn't landed, defer the link wiring.
- **Shared surface — `nav.ts`:** plan 2 owns it. This plan consumes it read-only. The 11 page URLs must match.
- **Shared surface — `src/pages/docs/guides/memo-capture.md`:** plan 3 creates it, this plan modifies its frontmatter (adds `next` link). Ordering: plan 3 creates with `next: null`, plan 4 finalizes. No conflict — the modification is additive and explicitly assigned to plan 4.

## Adversarial Synthesis

Key risks: silent content drops across 1711 lines of source material (32 sections → 11 pages, no automated completeness check), table overflow on mobile across many wide reference tables, and the cross-tier link wiring creating a cross-plan file modification dependency. Mitigations: mandatory source-to-page coverage checklist, consistent `overflow-x: auto` wrappers on every table, and explicit ownership of the Memo Capture frontmatter modification assigned to this plan.

## Verification Plan

### Automated Tests
- **SKIP TESTS per session directive.** No automated test suite is run. Verification is manual.

### Manual Verification
- **All pages render:** `astro build` → no errors. Each page accessible at its URL.
- **Content completeness:** every section from the user manual (§1-§32) is represented somewhere. No section dropped. Create a coverage checklist mapping source sections to output pages.
- **Links resolve:** no 404s on internal docs links. External links (GitHub, Marketplace) correct.
- **Tables:** all tables render with dark-theme styling. No horizontal overflow on desktop. Mobile: tables scroll within `overflow-x: auto` containers.
- **Prev/next:** sequential flow across all 11 pages. First page links back to last Guides page (Memo Capture). Last page has no next.
- **Cross-tier link:** Memo Capture page's `next` link points to `/docs/reference/agent-roles`. Verify by navigating from Memo Capture → Agent Roles.
- **Sidebar active state:** each Reference page highlights correctly.
- **Code blocks:** JSON configs, command IDs, and CLI examples render with `.code-block` styling (via CSS selectors on fenced blocks).
- **Pre-release callout:** triage pipeline page has the pre-release note visible.
- **Frontmatter layout path:** verify all 11 pages build successfully with the `@layouts/` alias (or the correct relative fallback path).

## Research Findings (Confirmed)

- **Path aliases in `.md` frontmatter:** NOT supported. Use explicit relative path `../../../layouts/DocsLayout.astro` for the `layout` property.
- **Markdown cross-page links:** Astro does NOT auto-prefix root-relative links in Markdown. Use relative links between reference pages (`autoban` or `../reference/autoban`) and to Guides pages (`../guides/constitution`), NOT root-relative (`/docs/reference/...`).
- **Shiki code block styling:** fenced code blocks render via Shiki with `<pre class="astro-code">` and inline styles. Plan 2 handles the CSS targeting strategy (`.astro-code` wrapper or `astro-expressive-code`).
- **User manual section coverage:** the plan maps 32 source sections to 11 output pages, but a manual coverage check during implementation is still required to ensure no section is dropped.
- **User manual line count:** the plan says "1712-line" but the actual file is 1711 lines. Minor discrepancy — does not affect the plan.

## Dependencies

- **Plan 2** (`switchboard-docs-2-layout-components`) — must be complete.
- **Plan 3** (Getting Started + Guides) — not a hard dependency, but the last Guides page's `next` link should point to the first Reference page. If plan 3 isn't done yet, wire that link when it lands. Can run in parallel with plan 3.

---

**Recommendation: Send to Coder.** (Complexity 3 — the work is porting and restructuring 1712 lines of Markdown. Labor-intensive but mechanically straightforward. The main risk is dropping content silently — the coverage checklist mitigates that.)
