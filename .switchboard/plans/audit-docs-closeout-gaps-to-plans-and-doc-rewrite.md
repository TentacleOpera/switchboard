# Doc-Parity Audit — Closeout: Convert Gaps to Plans and Rewrite the Standalone Doc

## Metadata

**Complexity:** 4
**Tags:** audit, standalone, parity, documentation
**Project:** Browser Switchboard

## Goal

Turn the completed claim register into action: validate it is trustworthy, dedupe every gap against existing plans, write plans for what remains, group them into a feature, and rewrite the standalone documentation page from evidence. This subtask converts an audit into a work list and a truthful doc.

### Problem analysis

The six section subtasks produce verdicts. On their own that is a spreadsheet. This subtask produces the two things the audit was actually for: **a complete, deduplicated list of standalone gaps with plans attached**, and **a standalone doc that matches reality**.

It also carries the audit's own quality gate. A register that is confidently wrong is worse than no register, because it would licence another "parity is complete" claim — exactly the failure this whole effort exists to end. The validation step below runs **before** any plan is written; if the register fails it, sections go back for re-audit rather than forward into planning.

### The corpus arithmetic — get this right or the gate is unfalsifiable

The first draft of this plan gated on "every one of the **62** files," while the section subtasks between them covered only 60. The gate could never pass as written. The verified corpus:

| Section | Files | Lines |
|---|---|---|
| `reference` | 6 | 788 |
| `board` | 11 | 775 |
| `getting-started` | 9 | 594 |
| `project` | 12 | 480 |
| `artifacts` | 14 | 462 |
| `pm-tools` + `integrations` + `agents` | 9 | 456 |
| **Total markdown** | **61** | **3555** |

`src/pages/docs/` also contains one non-markdown page, `index.astro` (68 lines) — a hero and card-grid nav page with no feature claims. **This subtask records it once as `N/A` with that reason**, so the corpus is fully accounted for: 61 audited markdown files + 1 `N/A` nav page = 62 files total.

`headless-switchboard.md` (106 lines) **is** among the 61 — the first draft's exclusion of it was reversed and it is now audited in the `getting-started` section (see that subtask for the audited-but-never-cited rule). It remains this subtask's rewrite target.

### The doc rewrite premise — corrected

`getting-started/headless-switchboard.md` is rewritten here and **only** here. The first draft justified the rewrite by calling the page stale — "written when standalone was substantially less capable," describing "limits that no longer hold." **That is wrong in both directions.** The page was last revised **2026-08-01** (`5a13705`, *"Docs: document the browser PTY terminal fleet, correct headless parity claims"*), and its error runs the opposite way: it is **over-confident**. It asserts that standalone columns "reflect *your configured* set, not the built-in default" — contradicted by `src/standalone/bootstrap.ts:405` and `:434`, which emit `DEFAULT_KANBAN_COLUMNS` — and scopes the entire remaining gap to "Automation and the Orchestrator."

The rewrite job is therefore **not** "loosen outdated limits." It is: *take a page of confident capability claims written without runtime evidence, and correct every one the register shows to be false.* Because the page is now audited, this subtask starts from its own `GAP`-against-the-doc rows rather than from a fresh reading.

## User Review Required

None.

## Complexity Audit

### Routine
- Writing plans from confirmed gaps.
- Grouping them into a feature.

### Complex / Risky
- **Validating the register before acting on it.** Running the quality gate after writing plans wastes the planning effort and, worse, embeds bad verdicts into the work list. It runs first.
- **Deduplication against existing plans.** The **Standalone Push-Path Parity** feature has **three** subtasks — `standalone-push-parity-guard.md`, `standalone-state-builders-delegate-to-getfullstatemessages.md`, and `restore-backlog-view-to-standalone-host.md`. Five earlier plans were merged into the delegation plan on 2026-08-07 and **no longer exist as files**; a register row linking one of them is a stale link to fix, not a plan to open. `standalone-kanban-column-parity-audit.md` separately owns next-column resolution divergence. Many board and getting-started findings map onto these four. A duplicate plan for an already-planned gap wastes a coding pass and fragments the fix; link instead.
- **Distinguishing gap classes.** `GAP` (never ported), `PARTIAL` (works incompletely), `GATED` (capability-dependent) and `BLOCKED` (could not be exercised) need different dispositions. A `GATED` row is not a defect. A `BLOCKED` row is **not a verdict at all** and must go back for testing or be escalated — never into a plan and never counted as audited.
- **Plan sizing.** The gap list may be large. Applying the repo's sizing rule — split when there are 3+ distinct deliverables or 2+ independently-shippable phases — matters here, or this produces one unusable mega-plan.
- **Rewriting the doc honestly.** The rewritten page must describe what standalone does *today*, with remaining gaps stated plainly rather than minimised. Writing it aspirationally recreates the exact problem: a doc that reads as a completeness claim while gaps remain open. The current page is the cautionary example — it is a week old and already over-claims.

## Edge-Case & Dependency Audit

**Race Conditions** — none.

**Security** — the register must contain no credential values, no one-time tokens and no session-cookie values; confirm before any part of it informs a public doc rewrite.

**Side Effects**
- The rewritten doc is public-facing. It should not be published until the gaps it describes are accurately stated — an inaccurate rewrite is worse than the page it replaces.
- Writing plans and grouping them into a feature mutates the board. Do this against the real workspace, not the audit's scratch workspace — the residual plans are real work.

**Dependencies & Conflicts**
- Overlaps the **Standalone Push-Path Parity** feature by design; the dedupe step is where that is resolved.

## Dependencies

- **All six section subtasks** — `reference`, `board`, `getting-started`, `project`, `artifacts`, and the combined `pm-tools`/`integrations`/`agents`. The register must be complete before this runs.

## Implementation

### 1. Validate the register

Run the quality gate across every section. Any failure sends that section back for re-audit before proceeding:

- **Corpus accounting:** all **61** markdown files carry a recorded line-coverage figure and every figure is 100%; per-section file and line totals match the table above and sum to 3555; `index.astro` is recorded once as `N/A`.
- No `LIVE` verdict on a user-facing feature rests on evidence class C alone.
- Zero rows cite verb reachability, a `{success:true}` response, a landed DB write, or the presence of a handler as evidence.
- Every state-changing row records **both** a post-settle and a post-reload observation.
- The register header names a commit SHA and **both** build artefacts (the `dist` build behind `npx switchboard` and the VSIX behind "Open in Browser"), and both were produced from that commit.
- Every runtime verdict names the host it was observed in.
- No row cites `headless-switchboard.md` as the basis for a verdict anywhere in the register — its own rows are the sole exception, and those are verdicts *about* it.
- No row asserts a root cause that was not independently confirmed against the tree at audit time. In particular, no row attributes a failure to "provider pushes have no sink in standalone" — that claim is false.
- Independently re-verify a random 10% of `LIVE` verdicts **across the whole register**, not per section.
- Every `BLOCKED` row is either resolved or explicitly escalated — none silently counted as audited.

### 2. Deduplicate

- For each `GAP` / `PARTIAL`, search existing plans and link where covered. Start with:
  - `standalone-state-builders-delegate-to-getfullstatemessages.md` — columns/visibility/ordering, routing config, CLI triggers, theme, repo scope, control-plane mode, workspace-selection fields.
  - `standalone-kanban-column-parity-audit.md` — wrong next column on advance/move.
  - `restore-backlog-view-to-standalone-host.md` — unbounded queue growth / undrained webview messages.
  - `standalone-push-parity-guard.md` — absence of a CI number for a parity class.
- Repair any row linking one of the five merged-away files; repoint it to the delegation plan.
- Produce the residual list: confirmed gaps with no existing plan.

### 3. Write plans

- Write a plan per residual gap, applying the repo's sizing rule rather than batching unrelated gaps together.
- Group them into a feature so sequencing is decided against the full picture.

### 4. Rewrite the standalone doc

**File:** `~/Documents/GitHub/switchboard-site/src/pages/docs/getting-started/headless-switchboard.md`

- Start from the page's own audited rows — every claim already carries a verdict.
- Correct every claim the register shows to be false. The columns claim (`"reflect your configured set"`) is a known one; do not assume it is the only one.
- Every claim in the rewritten page must trace to a `LIVE` row. No claim may be aspirational.
- Where gaps remain open, say so rather than omitting them — including gaps whose fixing plans exist but have not landed.

## Proposed Changes

### `.switchboard/audits/standalone-extension-parity.md`
- **Logic:** One `N/A` row added for `index.astro`; stale plan links repaired.

### `.switchboard/plans/*` (new, count unknown until the register exists)
- **Logic:** One plan per residual confirmed gap, sized per the repo rule.

### Switchboard feature (new)
- **Logic:** Groups the residual gap plans for sequencing.

### `switchboard-site/.../getting-started/headless-switchboard.md`
- **Logic:** Rewritten from evidence, starting from its own audited rows.
- **Edge Cases:** Every claim traces to a `LIVE` row; open gaps stated, not omitted; no claim carried over unverified from the current text.

## Verification Plan

1. The register passes every item of the step-1 quality gate; any section that failed was re-audited and re-passed.
2. The corpus arithmetic reconciles: 61 markdown files at 100% coverage, per-section totals matching the table, 3555 lines, plus `index.astro` as one `N/A` row.
3. The 10% independent re-verification was performed across the whole register, not per section.
4. Every `GAP` / `PARTIAL` row links either an existing plan or a newly written one — zero unattributed.
5. No row links one of the five merged-away Push-Path Parity files.
6. No new plan duplicates `standalone-state-builders-delegate-to-getfullstatemessages.md`, `standalone-push-parity-guard.md`, `restore-backlog-view-to-standalone-host.md`, or `standalone-kanban-column-parity-audit.md`.
7. `GATED` rows are not planned as defects; `BLOCKED` rows are resolved or escalated, not planned.
8. Every claim in the rewritten doc traces to a specific `LIVE` register row.
9. The rewritten doc states remaining gaps explicitly, including those with plans that have not yet landed.
10. The register contains no credential, token or cookie values.

## Recommendation

Complexity 4 → **Send to Lead Coder.** Mechanically light, but it is the gate that decides whether the audit's output can be trusted — and it is the last place a false "parity is complete" could enter.
