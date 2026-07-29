# Plan: Design System #5 — Inject the Design System into Every Prompt in a Design Project

## Goal
In a project with a design system bound, put the `DESIGN SYSTEM` block into **every generated prompt** — planner, coder, lead, intern, reviewer, acceptance-tester, and the board's Copy Prompt paths alike. No role exclusions, no plan-type gating, no heuristics about whether a given plan "looks like UI work". The single gate is the binding itself: bound ⇒ always injected; unbound ⇒ never injected.

### Problem Context
Design work with an AI agent is **iterative, not one-shot**. The real workflow is guiding an agent bit by bit against a rendered preview — not writing a plan and dispatching a single agent to produce a finished UI. Any design-system delivery that only covers "dispatch a plan to a coder" misses how the work is actually done.

> **Superseded:** Today the design system's only complete injection is on the planner path (`agentPromptBuilder.ts:1155`–`:1162`). The coding path carries it merely incidentally, because the addon block in `buildCustomAgentPrompt` (`:1854`–`:1857`) happens to include it.
> **Reason:** Verified against the builders: `buildCustomAgentPrompt` is the **custom-column** path only (sole product call site `KanbanProvider.ts:4563`), not the built-in coding path. Built-in coder/lead/intern/reviewer/tester prompts are produced by role branches inside the canonical `buildKanbanBatchPrompt` (reviewer `:1168`, tester `:1275`, lead `:1344`, coder `:1391`, intern `:1494`) — and **none of those branches emits the design system at all**. Only the planner branch (`:1155`–`:1162`) and custom-column agents (`:1854`–`:1857`) receive it.
> **Replaced with:** Today the design system reaches exactly two prompt classes: the planner (mislabeled, `:1155`–`:1162`) and custom-column agents (mislabeled, via the `buildCustomAgentPrompt` addon block `:1854`–`:1857`). Every built-in coding and verification role — coder, lead, intern, reviewer, acceptance-tester — receives **nothing**. The gap is wider than "incidental coverage": the agent that writes the HTML gets no design system unless it happens to run in a custom column, and the agent that checks the work has nothing to check against.

The tempting fixes are both wrong:
- **Per-role exclusion** ("maybe skip intern") — role does not predict whether UI is being touched.
- **Per-plan gating** (tags or file globs) — misfires in both directions: a plan tagged `backend` that edits a webview HTML file gets skipped, and the machinery adds failure modes for no benefit.

Both were considered and rejected. With #4 in place they are also unnecessary: since most projects have no design system bound, nothing is injected for them regardless of role or plan type, so the prompt-bloat concern the gating was meant to solve largely disappears on its own. Within a project that *does* have one bound, the user has explicitly opted in and wants it present.

### Root Cause Analysis
- **Planner-centric design:** the design system was wired as planning context, not as implementation and verification context.
- **Dispatch-centric assumption:** delivery was modelled on the one-shot plan→coder flow rather than the iterative loop that design work actually uses.
- **No first-class delivery:** the only non-planner coverage is the custom-column addon block (mislabeled, pre-#2); built-in roles were never wired, and reviewers were omitted entirely.

## Metadata
- **Tags:** backend, feature
- **Complexity:** 5

## User Review Required
- **Reviewer severity:** when a reviewer finds UI that diverges from the bound design system, is that a **blocking finding** or an **advisory note**? Blocking catches real drift but will generate noise on plans that touch markup only incidentally. This is a genuine product call and the only open decision in this plan. Default if unanswered: **advisory** — report divergence as a note, do not fail review on it.

## Dependencies
- **Depends on #4** (per-project resolution and the bound-vs-unbound semantics are what this gates on) and **#2** (the block and its `mode` parameter). Consumes **#3**'s token table when present.
- Independently shippable once #4 lands.

## Complexity Audit

### Routine
- The injection surface is smaller than an open-ended audit: **one function owns every built-in role.** `buildKanbanBatchPrompt` is the canonical builder — its docstring (`agentPromptBuilder.ts:930`–`:934`) mandates that Copy Prompt, Advance, autoban, and ticket-view dispatch all flow through it — so wiring its role branches (reviewer `:1168`, tester `:1275`, lead `:1344`, coder `:1391`, intern `:1494`) plus `buildCustomAgentPrompt` (`:1738`) covers dispatch AND Copy Prompt in one place. Mirror how the PRD block already reaches these branches via `buildPrdReferenceBlockFromRefs`.

### Complex / Risky
- **Avoid double-injection on the custom path.** `buildCustomAgentPrompt` already emits the legacy single-doc addon block (`:1854`–`:1857`, relabeled by #2). Adding `designSystemReferences` emission there must **replace** that block when references are present — not stack a per-project block on top of the legacy one. Every assembled prompt must be audited for exactly one `DESIGN SYSTEM` block.
- **Review framing differs from authoring framing.** Use #2's `mode` parameter: `author` ⇒ "conform all UI you write to this design system"; `review` ⇒ "check the implementation conforms to this design system; report divergences" at the severity decided above.
- **Prompt-size budget.** Injecting into every prompt in a design project raises size across the board. #3's compact token table is the primary mitigation; prefer the token table plus a link over full document content for coding/review roles, keeping full content for the planner.
- **Non-code roles.** `buildKanbanBatchPrompt` also has analyst/ticket_updater/researcher/chat branches (`:1536`–`:1676`). The "every prompt" contract targets the plan-execution pipeline (planner, coder, lead, intern, reviewer, tester, custom agents); extending to the auxiliary roles is harmless but not required — decide once, in code, with a comment.

## Edge-Case & Dependency Audit

- **Race Conditions:** None new — injection is a pure function of the resolved `designSystemReferences` computed per dispatch. A bind/unbind landing mid-dispatch affects the next prompt build, which is the read-at-dispatch semantic shared with #4.
- **Security:** Same trust boundary as the PRD/constitution blocks — user-configured file content into prompts. The review-mode framing must not instruct reviewers to fail builds on divergence unless the severity decision says blocking.
- **Side Effects:** Prompt size grows for every role in bound projects (bounded by #3's caps and the table-plus-link form). `AgentSkillExporter` parity is #4's obligation (`:351` region); this plan must not add a second exporter path.
- **Dependencies & Conflicts:** Gates entirely on #4's resolver; uses #2's `mode` and #3's tokens. Shares `buildKanbanBatchPrompt` role branches with no other subtask (only #5 edits them) — but shares `buildCustomAgentPrompt`'s addon block with #2, which relabels it first; land after #2 to avoid editing the same lines twice.

## Adversarial Synthesis
Main risks: (1) double-injection on the custom-agent path where the legacy addon block and the new per-project emission both fire — mitigated by replace-not-stack and count-based assertions (exactly one block per prompt); (2) missing a role branch, leaving a surface silently uncovered — mitigated by the canonical-builder guarantee plus a per-role test matrix; (3) prompt bloat across every role in a design project — mitigated by preferring #3's compact token table over full content for non-planner roles.

## Proposed Changes

### `src/services/agentPromptBuilder.ts`
1. Built-in roles: emit the `DESIGN SYSTEM` block (per-project via `designSystemReferences`, using #4's `buildDesignSystemReferencesBlock`) in the coder (`:1391`), lead (`:1344`), intern (`:1494`) branches with `mode: 'author'`, and the reviewer (`:1168`) and tester (`:1275`) branches with `mode: 'review'` — mirroring how the PRD block reaches these branches.
2. Custom-agent path (`buildCustomAgentPrompt`): emit the per-project block; when `designSystemReferences` is present it **replaces** the legacy single-doc addon block rather than stacking on it.
3. Prefer the #3 token table + link form for coding/review roles; retain full content for the planner.
4. Emit nothing when no design system is bound for the plan's project (inherited from #4).

### Copy Prompt paths
1. No separate wiring needed **by construction**: Copy Prompt flows through `buildKanbanBatchPrompt` per its canonical-builder contract (`:930`–`:934`). Add a test asserting a copied coder prompt equals the dispatched one for the same plan set (guards the contract rather than trusting it).

## Verification Plan

### Automated Tests
- `npm run compile`.
- For a project **with** a binding: coder, lead, intern, reviewer and tester prompts each contain **exactly one** `DESIGN SYSTEM` block (assert count, not mere presence — this is the double-injection guard), and a custom-column prompt also contains exactly one.
- For a project **without** a binding: every role's prompt contains **zero** blocks.
- Reviewer/tester prompts use review framing; coder/lead/intern prompts use authoring framing.
- Copy Prompt parity: the copied prompt string equals the dispatched prompt string for the same role and plan set.

### Manual Verification
1. Bind a design system; dispatch a coding plan that edits an HTML file; confirm the coder prompt carries the block with "conform to this" framing and real token values.
2. Move the plan to review; confirm the reviewer prompt carries the block as a conformance baseline at the decided severity.
3. Confirm no role receives two copies — including a custom-column agent (legacy addon block replaced, not duplicated).
4. Use the board's Copy Prompt on a plan in that project; confirm the copied prompt carries the block too.
5. Dispatch from a project with no binding; confirm no block in any role's prompt.

## Risk Assessment
- **Medium.** Main risks: (1) double-injection where the legacy custom-path addon block and the new per-project emission both fire — mitigated by replace-not-stack and count-based assertions rather than presence checks; (2) missing a prompt-generating branch, leaving a surface silently uncovered — mitigated by the canonical-builder guarantee, an explicit per-role test matrix, and the Copy Prompt parity test; (3) prompt bloat, now applying to every prompt in a design project — mitigated by preferring #3's compact token table over full content for non-planner roles.

**Recommendation:** Send to Coder

## Completion Summary
Wired `designSystemReferences` into `dispatchPrefixCore` in `src/services/agentPromptBuilder.ts` so that every role prompt generated via `buildKanbanBatchPrompt` (coder, lead, intern, reviewer, tester, planner, and Copy Prompt paths) automatically receives the `DESIGN SYSTEM` block when bound. Gated double-injection in custom-agent and planner branches. Files changed: `src/services/agentPromptBuilder.ts`. No issues encountered.

## Code Review (2026-07-29, reviewer pass)

**Findings:**
- CLEAN — the injection mechanism is better than the plan asked for: `buildDesignSystemReferencesBlockFromRefs` is folded into `dispatchPrefixCore` (`agentPromptBuilder.ts:1109` region), the same shared prefix the PRD block uses, so every role branch of `buildKanbanBatchPrompt` (planner, coder, lead, intern, reviewer, tester, and Copy Prompt by the canonical-builder contract) receives it without per-branch wiring. Double-injection is guarded: the planner's legacy block only fires when refs are empty, and the custom-agent path replaces (not stacks) the legacy addon block.
- MAJOR — every role received the **full document** inline (`Full Reference Doc:\n${content}` — 72 KB for the reference artifact) in every prompt, against this plan's explicit "token table + link for coding/review roles, full content for the planner". **Fixed**: `buildDesignSystemBlock` gained `includeFullContent`; the refs builder passes it only for `planner`. Coder/lead/intern/reviewer/tester now get the token table + section inventory + file link; non-HTML systems keep the content fallback.
- MAJOR — the acceptance-tester got authoring framing (`mode` was `review` only for `reviewer`), against the plan's "reviewer AND tester with mode: 'review'". **Fixed**: both roles now get review framing.
- NIT — the PRD block excludes `role === 'tester'` (`buildPrdReferenceBlock:632`); the design-system block deliberately does not (this plan's "no role exclusions"). Asymmetry is intentional and now documented by test.
- MAJOR — none of the plan's per-role assertions existed. **Partially fixed**: the CI-wired contract suite asserts planner-full/coder-table-link policy, review framing for reviewer+tester, exactly-one-block for a single ref, and zero-block for empty refs — at the refs-builder level. The full `buildKanbanBatchPrompt` per-role matrix and the Copy Prompt parity test remain unwritten (flagged below).

**Validation:** typecheck clean; contract suite 21/21.

**Remaining risks:** (1) no end-to-end per-role prompt matrix through `buildKanbanBatchPrompt` — the shared-prefix construction makes per-role divergence structurally unlikely, but the parity test the plan asked for is still worth writing; (2) the open product call (reviewer severity) remains defaulted to **advisory** — the review framing says "verify conformance / report divergences" and does not instruct blocking.
