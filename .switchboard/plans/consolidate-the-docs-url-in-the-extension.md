# Consolidate the extension's docs URL and retire the tutorial prompt

## Goal

Replace three hardcoded docs URLs with one exported constant pointing at `https://switchboard.dev/docs`, and delete the COPY TUTORIAL PROMPT button, whose job is taken over by a resident one-line docs pointer.

### Problem Analysis

The extension names the docs site in three places, with two different values, none shared:

| Site | Value |
|---|---|
| `SetupPanelProvider.ts:1470` (`docsUrl`, backs the OPEN DOCS button) | `.../docs/getting-started/installation` |
| `TaskViewerProvider.ts:14809` (`docsUrl`) | `.../docs/getting-started/installation` |
| `setup.html:2223` (inside the copied tutorial prompt) | `.../docs/getting-started/` |

All three carry `tentacleopera.github.io/switchboard-site`, which `move-the-docs-site-to-switchboard-dev.md` retires.

**The third one is already broken, in two ways.** Its prompt reads:

> Read the Switchboard docs at `https://tentacleopera.github.io/switchboard-site/docs/getting-started/` (Installation, Agents, Planning) and walk me through setup as a numbered list; ask which step I want help with first.

- The URL is a bare directory with **no index page** — no docs section has one; every real link in `nav.ts` and `DocsCardGrid.astro` targets a leaf page such as `/docs/getting-started/installation`.
- Two of the three named sections **do not exist under that path**. `getting-started/` holds Installation, Quick Start, When to Use Switchboard, Agentic Coding Apps, Headless Switchboard, Agent Auto Setup, Control Plane, Multi-Repo Setup, Plan Scanner. There is no "Agents" page there — `agents` is a *Kanban* page (`/docs/board/kanban-board/agents`) — and no "Planning" page. Quick Start, the obvious page for "walk me through setup", is not named at all.

So an agent given that prompt fetches a 404, then guesses at two sections that are somewhere else.

**And the button is now redundant.** `shrink-the-injected-agent-protocol-block.md` adds a resident rule telling every agent where the docs are. Once an agent already knows that, a button that copies a prompt telling it the same thing is a worse-formed duplicate of a rule it already has — and it is the copy that has to be kept in sync by hand.

### Root Cause

The tutorial prompt was the only mechanism available for getting docs guidance to an agent, so it encoded the instruction *and* the address *and* a reading list in one clipboard string, with nothing verifying any of the three. The resident rule replaces the instruction; the constant replaces the address; the reading list was never accurate and is better left to the docs' own navigation.

## Metadata

**Complexity:** 2
**Tags:** docs, refactor, ui

## User Review Required

- Confirm OPEN DOCS stays. It serves a human clicking through to read, which the resident rule does not replace; only the agent-facing copied prompt becomes redundant.
- Confirm the landing target for OPEN DOCS: Quick Start rather than Installation is the better destination for "how do I use this", but Installation is what both call sites use today.

## Complexity Audit

### Routine

- One exported constant, three call sites.
- Deleting the button, its click handler (`setup.html:2222-2237`), and the "Switchboard guide" hint text that describes it.

### Complex / Risky

- **Do not ship this before the domain is live.** Pointing all three sites at `switchboard.dev` while it 404s converts two working buttons into broken ones. The dependency is strict and the change is small enough to look safe out of order.
- **`setup.html` is a webview**, so the constant cannot be imported directly. Either pass it in with the existing panel state or keep the URL solely on the provider side and have the webview post a message — the pattern `btn-open-docs` already uses (`setup.html:2244` posts `openDocs`, the provider owns the URL). Prefer extending that pattern to inventing a second one.
- **Deleting the button changes a shipped UI affordance.** No state migration is needed, but the "Switchboard guide" section becomes a single button and should be re-laid out rather than left with a stray flex child.

## Edge-Case & Dependency Audit

**Migration.** None. No persisted state names these URLs; the constant is read at click time.

**Security.** Both remaining paths open an external URL. Keep them `https://` literals in code — never assembled from user input — so the change introduces no new navigation surface.

**Side effects.** `setup.html` shrinks by ~20 lines. No test currently pins the tutorial prompt string, so its deletion breaks nothing — which is also why it was able to drift into naming two non-existent sections.

**Ordering.** After the domain migration; ideally the same release wave as the resident rule, so the pointer and the buttons agree.

## Dependencies

- **Requires** `move-the-docs-site-to-switchboard-dev.md`. Hard prerequisite.
- **Pairs with** the docs-pointer rule in `shrink-the-injected-agent-protocol-block.md`, which is what makes retiring the button a simplification rather than a capability loss. If that rule is dropped, keep the button — but fix its URL and section list.

## Adversarial Synthesis

**"Keep the tutorial prompt — a copied prompt is more reliable than a resident line."** It would be, if it were correct. It currently sends an agent to a 404 and names two sections that live elsewhere, and nothing tests it. A resident line of ~124 chars carrying one URL has far less to go stale, and the shrink plan puts a size gate around it.

**"Three URL literals is not a real problem."** It is the reason the drift exists: two of the three agree and the third does not, and no gate compares them. One constant makes divergence impossible rather than unlikely.

**"Fix the prompt instead of deleting it."** Fixing it means maintaining a curated reading list against a docs site that changes — the exact coupling that produced the current wrong list. The docs' own navigation is the reading list.

## Proposed Changes

1. **Export one constant**, e.g. `SWITCHBOARD_DOCS_URL = 'https://switchboard.dev/docs'`, in a module both providers already import.
2. **Point `SetupPanelProvider.ts:1470` and `TaskViewerProvider.ts:14809` at it**, appending the specific page each needs rather than restating the origin.
3. **Delete the COPY TUTORIAL PROMPT button**, its handler, and its hint text; keep OPEN DOCS and re-lay out the section for a single button.
4. **Route OPEN DOCS through the existing `openDocs` message** so the webview never holds the URL.
5. **Add a grep gate**: no `github.io` literal anywhere in `src/`.

### Migration

None.

## Verification Plan

### Goal Invariants

- Exactly one docs-origin literal exists in `src/`, and it is `https://switchboard.dev/docs`.
- No `github.io` string remains in `src/`.
- No `src/` file contains the words "COPY TUTORIAL PROMPT".
- OPEN DOCS opens a page that resolves.

### Automated Tests

- **Single-origin gate:** assert exactly one docs-origin literal in `src/`, and no `github.io`. This is the test whose absence allowed the third URL to drift from the other two.
- **Resolvable target:** assert the constant plus each appended page path matches a real page in the `switchboard-site` docs tree. A cross-repo assertion is the only way to catch the failure that actually happened — a URL that is well-formed and points at nothing.
- **Button gone:** assert `setup.html` contains no `btn-copy-tutorial-prompt` id and no handler for it.
- **`openDocs` still wired:** assert the message is posted and handled, so removing the sibling button does not orphan the survivor.

### Manual Verification

- Click OPEN DOCS from Setup and confirm it lands on a real page.
- Confirm the "Switchboard guide" section renders correctly with one button.

## Outstanding Questions

- **[user]** Should OPEN DOCS land on Quick Start rather than Installation?
- Is the docs tree available to the test runner for the resolvable-target assertion, or does that check belong in the site repo instead? A cross-repo assertion that cannot run is worse than one placed where the content lives.
