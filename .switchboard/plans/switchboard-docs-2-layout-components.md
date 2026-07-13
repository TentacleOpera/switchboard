# Switchboard Docs — Layout, Sidebar & Components

## Goal

Build the docs page layout and shared components on top of the Astro project scaffolded in plan 1. This creates the visual shell that all docs content pages (plans 3 & 4) will populate: a sidebar navigation with active-page highlighting, prev/next pagination, code blocks with copy buttons, and a docs index page. Also adds the `Docs` link to the site nav and replaces the footer placeholder.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, ux, feature
**Project:** Website

## Parent Feature

This is subtask 2 of 4 in the **Switchboard Docs Section** feature. This plan covers the docs layout shell and components.

**Depends on:** Plan 1 (`switchboard-docs-1-astro-migration`) — requires the Astro project, `BaseLayout.astro`, `Header.astro`, `Footer.astro`, `global.css`, and tsconfig path aliases to exist.

## User Review Required

- **Prev/next at tier boundaries:** the plan recommends sequential flow across tiers (last Getting Started page → first Guides page → ... → last Guides page → first Reference page). The user should confirm this reading flow is desired vs. stopping prev/next at tier boundaries.
- **docs.css vs global.css:** the plan resolves to a separate `src/styles/docs.css` (imported by `DocsLayout`) so the landing page doesn't load docs CSS. User should confirm this separation is preferred over one global stylesheet.

## Complexity Audit

### Routine
- Creating `DocsLayout.astro` (extends `BaseLayout` with a two-column wrapper).
- Creating `PrevNext.astro` (flex row with conditional prev/next links).
- Creating `CodeBlock.astro` (pre/code wrapper with copy button).
- Adding `Docs` link to `Header.astro` and replacing the footer placeholder.
- Creating `src/pages/docs/index.astro` (three tier cards).
- Writing `src/data/nav.ts` (central nav config array).

### Complex / Risky
- **DocsSidebar active-state matching:** `Astro.url.pathname` may have trailing slashes. Normalization logic must handle the docs index (`/docs/`) specially. Off-by-one or trailing-slash bugs will cause the wrong page to highlight.
- **Mobile drawer accessibility:** the hamburger toggle needs `aria-expanded`, `aria-label`, focus management, and Escape/outside-click dismissal. Incomplete a11y is a real risk — this is the most interaction-heavy component.
- **CodeBlock copy button in secure context:** `navigator.clipboard.writeText()` requires HTTPS or localhost. GitHub Pages is HTTPS so it works, but a fallback for older browsers or non-secure contexts is needed.
- **Fenced code block styling for Markdown pages:** Markdown content pages (plans 3 & 4) use fenced code blocks (```lang), not the `CodeBlock.astro` component. The `.code-block` CSS must be applied to `pre > code` elements within `.docs-article` via CSS selectors, not just to the component's output. Without this, all code blocks in content pages will render unstyled.

## Scope

### In scope
- `DocsLayout.astro` — extends `BaseLayout` with a two-column layout (sidebar + main content + prev/next)
- `DocsSidebar.astro` — section tree with active-page highlighting, sticky positioning, independent scroll
- `PrevNext.astro` — prev/next pagination at the bottom of each docs page
- `CodeBlock.astro` — code block with hover-reveal copy button (tiny inline script)
- Docs-specific CSS in a separate `src/styles/docs.css` (sidebar, code-block, tables, prev/next, mobile drawer) — imported by `DocsLayout.astro` only, so the landing page doesn't load docs CSS unnecessarily
- `src/pages/docs/index.astro` — docs home page with tier cards (Getting Started, Guides, Reference)
- `src/data/nav.ts` — central nav config array (section names, page titles, URLs, ordering)
- Add `Docs` link to `Header.astro` (between `Features` and `GitHub`)
- Update `Footer.astro` — replace "Docs — placeholder for later" with real `Docs` link → `/docs/`
- Mobile sidebar drawer (hamburger toggle below 768px)

### Out of scope
- Docs content pages (plans 3 & 4)
- Search (Pagefind — polish phase)
- Syntax highlighting theme (Shiki — polish phase)
- Screenshots

## Visual Design Reference

The Stitch docs prototype (`d9bf1d93…html` in `.switchboard/stitch/switchboard-landing-page-62484982/`) is the visual reference. Key elements to reproduce:

- **Sidebar:** fixed-width (~256px), left of main content. Section headings in `font-code-label` style (uppercase, tracked, muted). Nav links with `.nav-link` styling — hover: cyan text + glow; active: cyan text, left border, subtle cyan bg.
- **Main content:** max-width ~720px for readability. Article with `<h1>` page title, prose sections, code blocks, tables, blockquotes.
- **Code blocks:** `.code-block` style — `#0b0f0f` bg, `1px solid #1d2323` border, cyan glow box-shadow, inset shadow. Copy button appears on hover (top-right, `content_copy` icon or text "Copy").
- **Prev/next:** flex row at bottom, border-top separator. Left: arrow_back + page title. Right: page title + arrow_forward. Cyan accent on hover.
- **Mobile:** sidebar hidden below 768px, replaced by a hamburger button that toggles a drawer overlay.

## Proposed Changes

### New files
- `src/layouts/DocsLayout.astro` — two-column docs layout
- `src/components/DocsSidebar.astro` — sidebar nav with active state
- `src/components/PrevNext.astro` — pagination component
- `src/components/CodeBlock.astro` — code block with copy button
- `src/pages/docs/index.astro` — docs home page
- `src/data/nav.ts` — nav config array

### Modified files
- `src/components/Header.astro` — add `Docs` nav link
- `src/components/Footer.astro` — replace docs placeholder with real link
- `src/styles/docs.css` — new file, docs-specific styles (imported by `DocsLayout.astro`)

## Component Specs

### DocsLayout.astro
```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
import DocsSidebar from '../components/DocsSidebar.astro';
import PrevNext from '../components/PrevNext.astro';

const { title, description, prev, next } = Astro.props;
---
<BaseLayout title={title} description={description}>
  <div class="docs-layout">
    <DocsSidebar currentPage={Astro.url.pathname} />
    <main class="docs-main">
      <article class="docs-article">
        <slot />
      </article>
      <PrevNext prev={prev} next={next} />
    </main>
  </div>
</BaseLayout>
```

### DocsSidebar.astro
- Reads the nav tree from `src/data/nav.ts`
- Compares each entry's URL against `currentPage` prop to set `.active` class
- Three sections: GETTING STARTED, GUIDES, REFERENCE
- Sticky positioning: `position: sticky; top: <header height>; height: calc(100vh - <header height>); overflow-y: auto;`
- Mobile: hidden by default, toggled via a button that adds `.sidebar--open` class

### nav.ts structure
```ts
export const docsNav = [
  {
    section: 'Getting Started',
    pages: [
      { title: 'Installation', href: '/docs/getting-started/installation' },
      { title: 'Quick Start', href: '/docs/getting-started/quick-start' },
    ],
  },
  {
    section: 'Guides',
    pages: [
      { title: 'Constitution & Governance', href: '/docs/guides/constitution' },
      { title: 'Quota Optimization', href: '/docs/guides/quota-optimization' },
      // ... 6 more
    ],
  },
  {
    section: 'Reference',
    pages: [
      { title: 'Agent Roles', href: '/docs/reference/agent-roles' },
      // ... 9 more
    ],
  },
];
```
Full page list is in the nav config below.

> **Completeness requirement:** `nav.ts` MUST list all 21 pages — 2 Getting Started + 8 Guides + 11 Reference — matching exactly the file paths defined in plans 3 and 4. The sidebar will show broken/missing links if any page is omitted. The full list is derivable from plans 3 & 4's page tables. The sidebar must render all entries even before content pages exist (links will 404 until plans 3 & 4 land, which is expected).

### PrevNext.astro
- Receives `prev` and `next` props (each `{ title, href }` or `null`)
- Renders a flex row with left/right links
- If `prev` is null, left side is empty (or shows nothing). Same for `next`.

### CodeBlock.astro
- Receives `code` and optional `language` props
- Renders `<div class="code-block"><pre><code>...</code></pre></div>` with a copy button
- Copy button: a `<button>` with a tiny `<script>` that calls `navigator.clipboard.writeText()`. Astro processes and bundles the script.
- If Shiki is configured (polish phase), syntax highlighting goes here. For now, plain monospace with the `.code-block` styling.
- **Critical for Markdown content pages:** plans 3 & 4 author `.md` pages that use fenced code blocks (```lang), NOT the `CodeBlock.astro` component (Astro components can't be used inline in `.md` files). **Research confirmed: Astro renders fenced code blocks via Shiki by default, wrapping them in `<pre class="astro-code">` with inline styles.** Standard CSS `pre > code` overrides will FAIL due to Shiki's inline style specificity. To style fenced blocks:
  - Target the `.astro-code` wrapper class for container styling (padding, borders, margins, background override).
  - Use `!important` on token color overrides to beat Shiki's inline styles, OR disable Shiki (`markdownSyntaxHighlighting: false` in `astro.config.mjs`) and style plain `<pre><code>` with the `.code-block` CSS.
  - **Recommended:** consider `astro-expressive-code` integration (replaces Shiki, provides built-in copy buttons, code frames, and CSS-variable theming — no inline styles to fight). This would also give fenced blocks the copy-button feature without custom JS.
  - The `CodeBlock.astro` component is for `.astro` pages only (e.g. the docs index); the CSS/integration approach covers all Markdown content.

### Docs index page (`/docs/`)
- Three cards/sections: Getting Started, Guides, Reference
- Each card has a short description and links to the pages in that tier
- Styled to match the landing page's card aesthetic (dark surface, border, accent on hover)

## Edge-Case & Dependency Audit

### Race Conditions
- None. Static site — no runtime concurrency. The copy button's `navigator.clipboard.writeText()` is async but single-user, single-action.

### Security
- **Clipboard API:** `navigator.clipboard.writeText()` only writes to clipboard (no read). No security risk. Requires secure context (HTTPS — GitHub Pages satisfies this).
- **No new attack surface:** docs components add no forms, no user input, no external API calls. CSP from `BaseLayout` is inherited.

### Side Effects
- **Header modification:** adding the `Docs` link changes the nav on ALL pages (landing + docs). The landing page's nav gains a new link — verify it doesn't break the sticky nav layout or mobile hamburger.
- **Footer modification:** replacing the placeholder link changes the footer on all pages.
- **CSS load:** `docs.css` is imported by `DocsLayout` only. The landing page (which uses `BaseLayout` directly) should NOT load `docs.css`. Verify no unintended CSS bleed.

### Dependencies & Conflicts
- **Plan 1** must be complete — requires `BaseLayout.astro`, `Header.astro`, `Footer.astro`, `global.css`, Astro project structure, and tsconfig path aliases.
- **Plans 3 & 4** depend on this plan — they use `DocsLayout`, `DocsSidebar`, `PrevNext`, `CodeBlock`, `nav.ts`, and the `.code-block` CSS styling for fenced blocks.
- **Shared surface — `Header.astro`:** plan 1 creates it, plan 2 modifies it (adds `Docs` link). No conflict — plan 2's modification is additive.
- **Shared surface — `Footer.astro`:** plan 1 creates it, plan 2 modifies it (replaces placeholder). No conflict — plan 2's modification is the intended replacement.
- **Shared surface — `nav.ts`:** plan 2 creates and owns it. Plans 3 & 4 consume it read-only. The page list in `nav.ts` must exactly match the pages created by plans 3 & 4.
- **Markdown links and base path — CRITICAL:** **Research confirmed: Astro does NOT auto-prefix root-relative links in Markdown** (`[Docs](/docs)` → will 404 under `/switchboard-site/`). Content pages (plans 3 & 4) that use root-relative Markdown links like `[Agent Roles](/docs/reference/agent-roles)` will break. Options: (a) use relative links between pages (`../reference/agent-roles`), (b) add a remark plugin to prefix links with `BASE_URL`, or (c) hardcode the full `/switchboard-site/docs/...` prefix. **Recommendation:** use relative links between docs pages (option a) — they're the least fragile and don't require build-time processing. The `nav.ts` sidebar links are rendered in `.astro` components where `BASE_URL` can be applied programmatically, so those are fine.

## Adversarial Synthesis

Key risks: fenced code blocks in Markdown content pages rendering unstyled (because `CodeBlock.astro` can't be used in `.md` files — CSS selectors on `pre > code` are required), mobile drawer accessibility gaps (aria, focus, dismissal), and active-state matching bugs from trailing-slash inconsistency. Mitigations: add `.docs-article pre > code` CSS selectors to `docs.css`, implement full a11y on the drawer, and normalize pathnames before comparison.

## Verification Plan

### Automated Tests
- **SKIP TESTS per session directive.** No automated test suite is run. Verification is manual.

### Manual Verification
- **Docs index page:** renders at `/docs/` with three tier cards, all links point to real URLs (even if pages don't exist yet — they'll 404 until plans 3 & 4 land, which is fine for this plan's scope).
- **Sidebar:** renders with all three sections and all 21 page titles from `nav.ts`. Active state highlights correctly when navigating between pages (test with at least 2 placeholder pages).
- **Prev/next:** renders correctly with props. Handles null prev (first page) and null next (last page) gracefully.
- **CodeBlock component:** renders with copy button. Copy button works (clipboard contains the code text). Button appears on hover, hides on mouse leave.
- **Fenced code block CSS:** create a temporary `.md` page with a fenced code block, verify it renders with `.code-block` styling (dark bg, border, glow). Remove the temp page after verification.
- **Mobile:** sidebar collapses below 768px. Hamburger button toggles drawer. Drawer is dismissible (Escape, outside-click).
- **Self-contained:** no external requests introduced by docs components.
- **Accessibility:** keyboard-tab through sidebar links with visible focus rings. Heading order logical. Drawer button has `aria-expanded`.
- **CSS isolation:** landing page does NOT load `docs.css`. Check DevTools Network tab on the landing page.

## Research Findings (Confirmed)

- **Shiki fenced code block styling:** Astro renders fenced blocks via Shiki with `<pre class="astro-code">` and inline styles. CSS `pre > code` overrides fail due to inline specificity. Target `.astro-code` wrapper or use `!important`, or disable Shiki, or use `astro-expressive-code` integration (recommended — provides copy buttons and CSS-variable theming).
- **Markdown links and base path:** Astro does NOT auto-prefix root-relative links in Markdown. Use relative links between docs pages (`../reference/agent-roles`) to avoid 404s under the `/switchboard-site/` subpath.
- **Path aliases in `.md` frontmatter:** NOT supported (confirmed in plan 1's research). Content pages use relative paths for `layout` frontmatter.

## Dependencies

- **Plan 1** (`switchboard-docs-1-astro-migration`) — must be complete. Requires `BaseLayout.astro`, `Header.astro`, `Footer.astro`, `global.css`, and the Astro project structure.
- Plans 3 & 4 depend on this plan being complete (they use `DocsLayout`, `DocsSidebar`, `PrevNext`, and `CodeBlock`).

---

**Recommendation: Send to Coder.** (Complexity 3 — straightforward component work. The mobile drawer is the only fiddly bit.)
