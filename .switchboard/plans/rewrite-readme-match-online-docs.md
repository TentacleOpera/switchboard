# Rewrite README to match the online docs

## Goal

Replace the drifted `README.md` with a concise README whose framing, positioning, and structure match the online documentation site, and which links out to it as the canonical reference instead of duplicating it.

### Problem Analysis

`README.md` predates the current positioning captured on the docs site — the 0→1 arc (research → plan → design → code → review), the open roster / Copy Prompt story, the project → feature → plan hierarchy, and remote boards. It's now a third, stale source of truth alongside the (soon-deleted) bundled manual and the online docs. A README should orient a GitHub visitor and funnel them to the online docs, not re-document the product.

**Root cause:** The README was authored iteratively as features shipped, accumulating per-feature sections (Constitution, Multi-Repo Control Plane, Design in the Loop, Features & worktrees, PM tool sync, etc. — see current L38–L394). It now reads as an in-repo manual rather than a landing page. The online docs site (`switchboard-site`) has since become the canonical, structured home for that content, so the README's manual-style sections are both stale *and* duplicative.

## Metadata

**Tags:** docs
**Complexity:** 3

## User Review Required

Approve the README voice/positioning — it's the repo's front door. Specifically approve the one-line pitch and the chosen differentiator list (the README must not invent positioning the site doesn't carry).

## Complexity Audit

### Routine
- Single-file rewrite of `README.md` (repo root).
- Pulling framing/voice from existing site docs (`switchboard-site/src/pages/docs/**`) — read-only reference.
- Removing two stale doc links (`README.md` L401–L402) that point at the bundled manuals the retire plan deletes.
- Adding a prominent canonical docs link.

### Complex / Risky
- Voice/positioning drift: the README can silently re-become a third source of truth if the implementer copies site *structure/content* instead of just *framing voice*. See Adversarial Synthesis.
- Cross-plan coordination: the retire-bundled-docs plan depends on this README (a) removing the bundled-manual links and (b) optionally serving as the offline fallback for `_openDocs`. Ordering and the fallback decision must be agreed.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — single-file edit, no concurrent writers expected.
- **Security:** None — no code, no secrets, no URLs invented (canonical URL is the existing `https://tentacleopera.github.io/switchboard-site/`).
- **Side Effects:** GitHub repo landing page changes for every visitor. Release artifacts (VSIX) bundle this README; it ships to installed users via the extension's README view.
- **Dependencies & Conflicts:**
  - **Depends on (for framing source):** `switchboard-site/src/pages/docs/**` — read at authoring time only; no runtime coupling.
  - **Pairs with:** `retire-bundled-docs-redirect-to-online.md`. The retire plan's `_openDocs` redirect and this README's bundled-manual link removal must land consistently. If the retire plan keeps a README offline fallback, this README must stand on its own for that purpose (no references to deleted files).

## Dependencies

- `retire-bundled-docs-redirect-to-online.md — retire bundled user docs and repoint open-docs affordances to the online site` (sibling plan; coordinate ordering and the offline-fallback decision).

## Adversarial Synthesis

**Risk Summary:** Key risk is silent re-duplication — an implementer reading "pull section headings/wording from the site" copies the site's section list into the README, recreating a third source of truth in miniature. Mitigation: README carries *tagline + arc phrasing + differentiator names + install + one canonical link* only; no site section index, no per-feature deep dives. Second risk is cross-plan drift on the offline-fallback decision; mitigate by agreeing the fallback answer with the retire plan before either lands.

## Proposed Changes

### `README.md` (repo root, full rewrite)

**Context:** Current README is ~402 lines, manual-style, with per-feature sections (L38–L394) and two bundled-manual links at L401–L402. The online docs site is now canonical.

**Logic:** Replace the whole file with a short landing-page README that mirrors the site's *positioning voice* (not its structure/content) and funnels to it.

**Implementation:**
- Top: H1 `# Switchboard` + one-line pitch matching the site's hero copy (the site frames Switchboard as "the 0→1 control plane for coding agents" / "agent orchestration with real project management"). Use the site's exact phrasing for the pitch so the two read as one voice.
- The arc, stated in one line: research → plan → design → code → review, kept legible on one board.
- Core differentiators, named exactly as the site names them (not as the current README's per-feature H3s): a project model (not a task list), the move is the dispatch, works with anything (Copy Prompt / open roster), before-the-first-line interchange. Bullet list, one line each, no deep dives.
- Install: keep the existing install block (Releases page + VSIX install + CLI install) but reconcile the versioned direct-link line — either keep it pinned to the latest release or drop the versioned direct link in favor of the Releases page link alone (Clarification: the versioned link goes stale every release; prefer the Releases page link only).
- A prominent **Full documentation → https://tentacleopera.github.io/switchboard-site/** link as its own block, above the fold if feasible.
- Links section: keep the GitHub Repository link; **remove** the two bundled-manual links (`docs/switchboard_user_manual.md`, `docs/how_to_use_switchboard.md`) — those files are deleted by the sibling retire plan.
- Length target: well under one screen on a typical GitHub render. Orient + link, not duplicate.

**Edge Cases:**
- Do **not** copy the site's section index (Getting Started / Project / Agents / Integrations / Reference / Board / Artifacts) into the README. That is the duplication the goal forbids.
- Do **not** invent positioning the site doesn't carry. If a current-README differentiator isn't reflected on the site, flag it in chat rather than keeping it in the README unilaterally.
- If the retire plan decides to keep the README as `_openDocs`'s offline fallback, the README must be self-contained enough to orient a user with no network — confirm the install + arc + differentiators block satisfies that before landing.

### `switchboard-site/src/pages/docs/**` (read-only reference)

**Context:** Source of framing/voice.

**Logic:** Read at authoring time only. No edits.

**Implementation:** Read `docs/index.astro` (hero copy) and the top of `docs/getting-started/installation.md` + `docs/getting-started/quick-start.md` for pitch/arc phrasing. Do not modify the site repo from this plan.

**Edge Cases:** None — read-only.

## Verification Plan

### Automated Tests
- None. No code path is touched.

### Manual Verification
- Open `README.md` in the GitHub web view and confirm: (a) the canonical docs link is visible without scrolling, (b) no bundled-manual links remain, (c) the pitch reads verbatim from the site hero, (d) no per-feature deep-dive sections remain.
- `grep -n "switchboard_user_manual\|how_to_use_switchboard" README.md` returns no matches.
- `grep -n "tentacleopera.github.io/switchboard-site" README.md` returns at least one match (the canonical link).
- Diff the new README against the site hero copy (`docs/index.astro` L12–L15) and confirm pitch phrasing matches.
- (Skip compilation — no code touched. Skip automated tests — none apply.)

## Definition of Done

README reflects current positioning, links to the online docs as canonical, contains no references to the deleted bundled manual, and reads consistently with the site's voice without duplicating the site's section structure. Bundled-manual links at former L401–L402 are gone.

**Recommendation:** Complexity 3 → Send to Intern.
