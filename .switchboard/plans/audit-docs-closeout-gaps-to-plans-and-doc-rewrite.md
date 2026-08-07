# Doc-Parity Audit — Closeout: Convert Gaps to Plans and Rewrite the Standalone Doc

## Metadata

**Complexity:** 4
**Tags:** audit, standalone, parity, documentation
**Project:** Browser Switchboard

## Goal

Turn the completed claim register into action: validate it is trustworthy, dedupe every gap against existing plans, write plans for what remains, group them into a feature, and rewrite the stale standalone documentation page from evidence. This subtask converts an audit into a work list and a truthful doc.

### Problem analysis

The six section subtasks produce verdicts. On their own that is a spreadsheet. This subtask produces the two things the audit was actually for: **a complete, deduplicated list of standalone gaps with plans attached**, and **a standalone doc that matches reality**.

It also carries the audit's own quality gate. A register that is confidently wrong is worse than no register, because it would licence another "parity is complete" claim — exactly the failure this whole effort exists to end. The validation step below runs before any plan is written; if the register fails it, sections go back for re-audit rather than forward into planning.

`getting-started/headless-switchboard.md` is rewritten here and **only** here. It was written when standalone was substantially less capable and describes limits that no longer hold — it claims standalone columns "reflect *your configured* set" (contradicted by `src/standalone/bootstrap.ts:341`) and scopes the remaining gap to "Automation and the Orchestrator," which is not accurate. It contributed no requirements to any section audit, by design. It is an output.

## User Review Required

None.

## Complexity Audit

### Routine
- Writing plans from confirmed gaps.
- Grouping them into a feature.

### Complex / Risky
- **Validating the register before acting on it.** Running the quality gate after writing plans wastes the planning effort and, worse, embeds bad verdicts into the work list. It runs first.
- **Deduplication against existing plans.** The seven plans under **Standalone Push-Path Parity** already cover the transport class and the fabricated payload fields. Many board and getting-started findings will map onto them. A duplicate plan for an already-planned gap wastes a coding pass and fragments the fix; link instead.
- **Distinguishing gap classes.** `GAP` (never ported), `PARTIAL` (works incompletely), `GATED` (capability-dependent) and blocked-untestable rows need different dispositions. A `GATED` row is not a defect. A blocked row is not a verdict at all and must go back for testing, not into a plan.
- **Plan sizing.** The gap list may be large. Applying the repo's sizing rule — split when there are 3+ distinct deliverables or 2+ independently-shippable phases — matters here, or this produces one unusable mega-plan.
- **Rewriting the doc honestly.** The rewritten page must describe what standalone does *today*, with remaining gaps stated plainly rather than minimised. Writing it aspirationally recreates the exact problem: a doc that reads as a completeness claim while gaps remain open.

## Edge-Case & Dependency Audit

**Race Conditions** — none.

**Security** — the register must contain no credential values; confirm before any part of it informs a public doc rewrite.

**Side Effects**
- The rewritten doc is public-facing. It should not be published until the gaps it describes are accurately stated — an inaccurate rewrite is worse than the stale page it replaces.

**Dependencies & Conflicts**
- Overlaps the **Standalone Push-Path Parity** feature by design; the dedupe step is where that is resolved.

## Dependencies

- **All six section subtasks** — `reference`, `board`, `getting-started`, `project`, `artifacts`, and the combined `pm-tools`/`integrations`/`agents`. The register must be complete before this runs.

## Implementation

### 1. Validate the register

Run the quality gate across every section. Any failure sends that section back for re-audit before proceeding:

- Every one of the 62 files has a recorded line-coverage figure, and every figure is 100%.
- No `LIVE` verdict on a user-facing feature rests on evidence class C alone.
- Zero rows cite verb reachability, a `{success:true}` response, a landed DB write, or the presence of a handler as evidence.
- The register header names a commit SHA and build artefact, and that build is from current `src`.
- Every runtime verdict names the host it was observed in.
- No row cites `headless-switchboard.md` as its basis.
- Independently re-verify a random 10% of `LIVE` verdicts across the whole register.
- Every blocked row is either resolved or explicitly escalated — none silently counted as audited.

### 2. Deduplicate

- For each `GAP` / `PARTIAL`, search existing plans — especially the seven under Standalone Push-Path Parity — and link where covered.
- Produce the residual list: confirmed gaps with no existing plan.

### 3. Write plans

- Write a plan per residual gap, applying the repo's sizing rule rather than batching unrelated gaps together.
- Group them into a feature so sequencing is decided against the full picture.

### 4. Rewrite the standalone doc

**File:** `~/Documents/GitHub/switchboard-site/src/pages/docs/getting-started/headless-switchboard.md`

- Rewrite from the register: what standalone actually does, and what is genuinely editor-only, stated plainly.
- Every claim in the rewritten page must trace to a `LIVE` row. No claim may be aspirational.
- Where gaps remain open, say so rather than omitting them.

## Proposed Changes

### `.switchboard/plans/*` (new, count unknown until the register exists)
- **Logic:** One plan per residual confirmed gap.

### Switchboard feature (new)
- **Logic:** Groups the residual gap plans for sequencing.

### `switchboard-site/.../getting-started/headless-switchboard.md`
- **Logic:** Rewritten from evidence.
- **Edge Cases:** Every claim traces to a `LIVE` row; open gaps stated, not omitted.

## Verification Plan

1. The register passes every item of the step-1 quality gate; any section that failed was re-audited and re-passed.
2. The 10% independent re-verification was performed across the whole register, not per section.
3. Every `GAP` / `PARTIAL` row links either an existing plan or a newly written one — zero unattributed.
4. No new plan duplicates an existing Standalone Push-Path Parity plan.
5. `GATED` rows are not planned as defects; blocked rows are resolved or escalated, not planned.
6. Every claim in the rewritten doc traces to a specific `LIVE` register row.
7. The rewritten doc states remaining gaps explicitly.
8. The register contains no credential values.

## Recommendation

Complexity 4 → **Send to Lead Coder.** Mechanically light, but it is the gate that decides whether the audit's output can be trusted — and it is the last place a false "parity is complete" could enter.
