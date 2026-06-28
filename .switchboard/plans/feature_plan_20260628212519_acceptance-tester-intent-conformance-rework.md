# Rework the Acceptance Tester into an Intent-Conformance Reviewer

## Goal

Rework the `tester` role so it judges code against **product intent and the spirit of the plan** — not the literal letter of the plan — and so it sources that intent from the **current** project-context system (per-project PRD + workspace constitution) instead of the legacy Notion "Planning Epic" design doc it was originally built around.

### Core problem & background

The `tester` role ("Acceptance Tested" kanban column) was written long before `project.html` / the Project panel introduced first-class, locally-authored **PRDs** (`.switchboard/projects/<slug>/prd.md`) and **constitutions** (`CONSTITUTION.md`). The role was wired to the old global design-doc mechanism (`planner.designDocLink`, content pulled from Notion via `_resolveGlobalDesignDoc`, `KanbanProvider.ts:2808`). It has since been *half*-patched — the dispatch gate (`KanbanProvider.ts:3027-3037`) no longer hard-requires the Notion doc and accepts a project PRD — but the role's actual prompt was never modernized. Three concrete defects result:

1. **The tester's own requirements block is still Notion-only.** `agentPromptBuilder.ts:757-762` builds `designDocBlock` exclusively from `designDocContent`/`designDocLink` and labels it "PLANNING EPIC REFERENCE (pre-fetched from Notion)". When only a new-system PRD exists, the tester instruction "Use the attached Design Doc / PRD as the authoritative requirements baseline" (`agentPromptBuilder.ts:732,736`) points at a baseline that **is not attached** to the tester section. The PRD reaches it only through the generic, all-roles prefix block `buildPrdReferenceBlock` (`agentPromptBuilder.ts:321-336`, folded into `dispatchPrefixCore` at `:530-531`), framed as "must be respected throughout this work" — i.e. ambient context, not the acceptance yardstick.

2. **The constitution never reaches the tester.** `_resolveConstitution` (`KanbanProvider.ts:2823`) is only invoked in the `planner` branch (`:3012-3014`). The `tester` branch (`:3027-3037`) never resolves or passes `constitutionContent`. So the user's requirement — "a PRD *or at least a project constitution*" — cannot currently be satisfied by the constitution.

3. **The prompt enforces the letter, not the spirit.** `testerBase` (`agentPromptBuilder.ts:729-740`) is a compliance checklist ("assess the actual code changes against the product requirements, fix material requirement gaps"). Nothing directs the tester to judge user-facing behavior/outcomes, to tolerate implementation deviations that still satisfy intent, or to flag the inverse — code that satisfies the plan's letter but misses what the product actually needed. That intent axis is precisely what distinguishes the tester from the plan-letter `reviewer` (`agentPromptBuilder.ts:637-647`); today they overlap.

### Root cause

The dispatch-gate reconciliation was done (accept PRD as an alternative to the Notion doc) but the **role prompt and the option-resolution for that role** were never migrated. The tester still treats the legacy global design doc as its primary, named baseline and is blind to the constitution.

## Metadata

- **Tags:** [backend, refactor]
- **Complexity:** 6
- **Repo:** switchboard

## User Review Required

- **Public-facing name of the role/column.** The behavior is no longer "acceptance testing" (it writes/runs no acceptance suites); it is requirements/intent conformance review with fix-and-verify. Recommendation: **keep the internal role id `tester` and the kanban column id `ACCEPTANCE TESTED` unchanged** (both are shipped state — renaming the ids touches the routing map, `_generatePromptForColumn`, autoban/dispatch derivation, persisted board configs, and ~8 regression tests, and risks breaking older installs' boards), and change only the **user-facing label + the role's self-description in the prompt** to "Product Acceptance" (or "Intent Review"). Confirm the chosen display name. This is the one genuine product call; everything else below is decided.

## Complexity Audit

### Routine
- Rewriting the `testerBase` / `intro` prompt strings (`agentPromptBuilder.ts:729-749`).
- Adding a tester-specific acceptance-baseline block builder, parallel to the existing `designDocBlock`.

### Complex / Risky
- Changing a **shipped dispatched-prompt** path and the tester's **dispatch gate** (`KanbanProvider.ts:3027-3037`) — must preserve back-compat for installs still on the legacy Notion design doc (per migration rules).
- Avoiding **double-injection** of the PRD: it already arrives via the shared `dispatchPrefixCore` prefix for all roles; the new tester-specific baseline block must not duplicate it confusingly.

## Edge-Case & Dependency Audit

- **Race Conditions:** PRD/constitution files can be mid-write from a concurrent Project-tab save; reads are already wrapped (`_resolveProjectPrd` `:2888-2893`, `_resolveConstitution` `:2827-2832`) — reuse those, do not add new unguarded reads.
- **Security:** None new. PRD path is slug-sanitized (`prdUtils.ts` `sanitize`), no traversal. Content is injected verbatim (already true today).
- **Side Effects:** The dispatch gate currently throws when no baseline exists; broadening it changes *when* dispatch fails. Must keep a clear, actionable error.
- **Dependencies & Conflicts:**
  - Double-PRD: `buildPrdReferenceBlock` (shared prefix) vs the new tester baseline block. Decision: in the **tester** branch, suppress/own the PRD framing so it appears **once**, as the acceptance baseline (see Proposed Changes).
  - Constitution is workspace-level and currently planner-gated by `planner.constitutionEnabled`. For the tester, treat the constitution as **always-included supplementary invariants when the file exists**, independent of the planner toggle (the planner toggle governs planner prompts, not acceptance criteria). State this explicitly in code comments.
  - Legacy `designDocContent`/`designDocLink` must remain a **fallback** baseline (back-compat), not be deleted.

## Dependencies

- None (no other in-flight plan blocks this).

## Adversarial Synthesis

Key risks: (1) double-injecting the PRD into the tester prompt (ambient prefix + new baseline block) — mitigated by having the tester branch own PRD framing and the shared prefix skip it for `tester`; (2) breaking installs on the legacy Notion design doc — mitigated by keeping `designDoc*` as an explicit fallback tier and a no-op migration posture; (3) "intent over letter" being read as license to ignore the plan — mitigated by scoping intent-judgement to *user-facing outcomes* while still requiring the plan's acceptance criteria be met.

## Proposed Changes

### `src/services/KanbanProvider.ts` — tester option resolution (`:3027-3037`)

- **Context:** Currently resolves only the legacy design doc and throws unless `designDocLink || prdEnabled`.
- **Logic:** Establish a 3-tier baseline and pass all available tiers to the prompt:
  1. **Primary:** per-project PRD — already resolved into `resolvedOptions.prd*` at `:2991-2998` (no change needed there).
  2. **Supplementary:** workspace constitution — resolve it here for the tester regardless of `planner.constitutionEnabled`: `const { constitutionLink, constitutionContent } = await this._resolveConstitution(workspaceRoot, true);` and assign to `resolvedOptions.constitution*`.
  3. **Fallback:** legacy design doc — keep resolving `_resolveGlobalDesignDoc` and assigning `designDoc*`.
- **Gate:** throw only when **none** of {`prdEnabled`, `constitutionContent`, `designDocLink`} is present. Update the message to point at the PRD authoring UI **and** the constitution, dropping the Notion-first framing: e.g. "Acceptance review requires a product baseline: author a PRD for the active project (Projects tab) or a CONSTITUTION.md, or attach a legacy Planning Epic in Setup."
- **Edge cases:** "No Project" boards have no PRD (`_resolveProjectPrd` returns `{}`); the constitution then becomes the baseline — desired.

### `src/services/agentPromptBuilder.ts` — tester role prompt (`:721-775`)

- **Context:** Reframe from literal compliance to intent conformance, and source the baseline from PRD → constitution → legacy doc.
- **Logic / Implementation:**
  - Rewrite `intro` + `testerBase` (`:729-749`) so the role self-describes as **Product Acceptance / Intent Review** and is told to:
    - Judge whether the change **delivers the product intent and the spirit of the plan**, as experienced by the end user — not whether it matches the plan line-by-line.
    - Treat the **PRD as the primary intent baseline**, the **constitution as inviolate invariants**, and the **plan as the implementation record** (not the yardstick).
    - Explicitly flag **both** directions: requirements/intent not met, **and** code that satisfies the plan's letter but misses the product's intent.
    - Permit implementation deviations from the plan that **still satisfy intent** (do not "fix" these); fix only genuine intent/requirement gaps; then verify.
    - One-line contrast so it doesn't duplicate the reviewer: "The reviewer already checked code-vs-plan; you check code-vs-intent."
  - Replace the Notion-only `designDocBlock` (`:757-762`) with a precedence-ordered **acceptance-baseline block** built from, in order: `prdContent`/`prdLink` (label "PRODUCT REQUIREMENTS (PRD) — primary acceptance baseline"), then `constitutionContent`/`constitutionLink` (label "PROJECT CONSTITUTION — inviolate invariants"), then `designDocContent`/`designDocLink` (label "LEGACY DESIGN DOC (fallback baseline)"). Consider extracting a small helper `buildAcceptanceBaselineBlock(options)`.
  - **De-dupe the PRD:** since `tester` will now own the PRD baseline framing, make `buildPrdReferenceBlock` return `''` for `role === 'tester'` (one-line guard at `:322`), so the PRD appears once, as the acceptance baseline, not also in the ambient prefix.
- **Edge Cases:** all three baselines absent is now impossible (gated in KanbanProvider), but keep the block builder tolerant of empties.

### Tests

- Update tester-related expectations and add coverage (see Verification Plan). Note the WARNING at `agentPromptBuilder.ts:657-659` about string-coupled replacements — the reviewer block uses literal `.replace()` on its base; ensure the tester rewrite doesn't introduce the same fragility, or update any coupled assertions in tandem.

## Verification Plan

### Automated Tests
- Add/extend a prompt-generation unit test (cf. `src/test/kanban-prompt-generation-unit.test.js`) asserting, for `role === 'tester'`:
  - PRD present → baseline block labelled as the **primary acceptance baseline**, and the ambient `buildPrdReferenceBlock` PRD does **not** also appear (no double-injection).
  - PRD absent + constitution present → constitution is the baseline; no throw.
  - All baselines absent → dispatch resolution throws with the new message.
  - Prompt text contains the intent/spirit framing and the reviewer-contrast line; legacy "PLANNING EPIC REFERENCE (pre-fetched from Notion)" is no longer the primary label.
- Run the existing tester/reviewer regression suites (`kanban-prompt-generation-unit`, `kanban-card-prompt-labels-regression`, `planning-copy-labels-regression`) to confirm no role/column-id churn.
- `npm run compile` for type-check (TS only; `dist/` is not used for testing).

---
**Recommendation:** Complexity 6 → **Send to Coder.**
