# Deferred review findings become a structured record

## Goal

Give the reviewer's deferred findings a machine-readable home, so that "what we chose not to fix" survives the card's advance instead of dissolving into a prose summary nobody reads.

### Problem Analysis

The reviewer already does this work. Its Stage 2 is explicitly a triage — *"synthesize Stage 1 into actionable fixes — what to keep, what to fix now, what can defer"* (`agentPromptBuilder.ts:1866`) — and its final step requires *"a brief structured summary: list findings by severity with file:line references, fixes applied, and remaining risks"* (`:1871`). So the deferred set is generated on every review pass.

Where it lands is the problem. `COMPLETION_STEP_COMPACT` (`:1051`) says: *"Update the original plan file by appending a brief summary (≤ 5 sentences) under `## Review Findings` — list files changed, validation results, and remaining risks."* `COMPLETION_STEP_FULL` (`:1049`) appends the same content unstructured. Either way the deferred items are prose inside a five-sentence blob, mixed with files-changed and validation results.

**And the one thing that reads that section uses it to move past it.** The `reconcile` scheduler preset scans plan files for *"a NEW `## Completion Report` or `## Review Findings` section that was not present on the previous reconcile pass"* (`schedulerPresets.ts:90`) — and treats its appearance purely as the signal to advance the card forward. So the mechanism that detects the deferred findings is the mechanism that buries them: section appears, card advances, risk archives with the plan.

**The only escalation path is pathological.** In delegation mode the reviewer is told that *"if after 5 rounds the same critical issues persist, stop — report to <lead> that the plan is badly scoped and a new plan is needed for the remaining work"* (`:1848`). That covers repeated failure to fix. It does not cover the ordinary case: review passed, three real risks deferred, nothing records them as outstanding.

**Prose is also the wrong shape for the consumer.** A deferred finding needs a severity and a location to be actionable later. Both already exist in the reviewer's own summary format — `file:line` references and CRITICAL/MAJOR/NIT tags — and both are discarded when the finding is compressed into the plan-file blob.

### Root Cause

The completion report was designed as a **signal**, not a record: its stated purpose is that *"this edit signals task completion to the kanban board — the file watcher detects it and clears the card's working-state light."* Everything in it is incidental to that signal, so no part of it was given a shape anything could consume. Deferred findings inherited that shape by being written into the same place.

## Metadata

**Complexity:** 3
**Tags:** reliability, agents, backend

## Settled Design

- **The empty case is stated, never omitted.** An explicit "no deferred findings" is what separates "the reviewer found nothing outstanding" from "the reviewer did not answer the question". Omission would leave a consumer unable to tell a clean pass from a skipped step — the same ambiguity `SKIP_DISCLOSURE_STEP` exists to close elsewhere.
- **Severity reuses CRITICAL/MAJOR/NIT verbatim** from Stage 1. A NIT deferred forever is fine; a deferred CRITICAL is the thing worth surfacing, and a second scale would lose that distinction while inviting translation errors between the two.
- **The tester's "remaining requirement gaps" share this section.** They are the same class of thing under another name, and one concept gets one vocabulary.

## Complexity Audit

### Routine

- A new heading in the completion step's instruction, with one item per line.
- Keeping the existing `## Review Findings` section for the summary prose it already carries.

### Complex / Risky

- **The completion edit is a load-bearing signal, and this plan touches its instruction.** `COMPLETION_STEP_FULL` / `COMPLETION_STEP_COMPACT` carry the `COMPLETION REPORT:` sentinel that `ensureCompletionDirective` (`:1061`) checks for idempotently, precisely so *"the completion handshake [stays] present for code-touching roles even when a `replace`-mode defaultPromptOverride wipes the composed base."* Adding a section must not disturb that sentinel or the watcher behaviour keyed to the edit.
- **`reconcile` must keep working unchanged.** It scans for the section *appearing*. Adding a second section next to it is additive, but the preset's prompt text is described as *"load-bearing — this text is unchanged from the retired scheduler surface"* (`schedulerPresets.ts:76-78`), so it should not be edited as part of this plan even though it is the natural consumer later.
- **Two completion steps, not one.** Compact and full modes are selected by `reviewerCompactPlanUpdateEnabled`. Both need the section, or the record exists only under one setting — the sort of split that reads as working until a user with the other setting reports nothing.
- **The tester writes the same kind of report.** Its step 5 is *"Update the original plan with files changed, validation results, and remaining requirement gaps"* (`:1969`). Requirement gaps are the same class of thing under another name; deciding now whether they share the section avoids two vocabularies for one concept.

## Edge-Case & Dependency Audit

**Migration.** None. The section is additive; plans written before it simply lack it, and any consumer must treat absence as unknown rather than empty.

**Security.** Neutral. Agent-written content into a plan file, as today. Rendered as text wherever it is displayed, never HTML.

**Side effects.** Slightly longer completion reports. The compact mode's *"≤ 5 sentences"* budget applies to the summary prose and should not be read as a budget for the itemised list, or a reviewer with four deferred findings will drop some to stay inside it — worth stating explicitly in the instruction.

**Ordering.** Ships alone and is useful alone: even with no consumer, a structured deferred set is a better record than a prose blob. It is a **precondition** for `completion-testing-stage-checks-acceptance-criteria.md`, which reads it.

## Dependencies

- **Precondition for** `completion-testing-stage-checks-acceptance-criteria.md`.
- Independent of the missions, automation and worktree work.

## Adversarial Synthesis

**"The findings are already in the plan file — this is cosmetic."** They are in the file as prose, with severity and location compressed out. The consumer this enables has to distinguish a deferred CRITICAL from a deferred NIT; it cannot do that from a five-sentence summary, and asking a later agent to re-derive severity from prose reintroduces the judgment the reviewer already made.

**"Just have the reviewer write follow-up plan files directly."** The reviewer is the worst-placed judge of whether a finding deserves a plan: it has spent its entire context on one diff and has no view of the roadmap. It should record; something with more context should decide. This is also the failure mode `goal-invariant-verification-and-review-escalation.md` documents — competent local judgment that still inverted the goal.

**"Add a DB column instead of a file section."** The plan file is what the reviewer already edits, what the watcher already reacts to, and what a cloud or DB-less agent can write. A DB column would need a new write path for the one actor that cannot reach the DB.

## Proposed Changes

1. **Add a dedicated deferred-findings section** to the completion report, itemised one finding per line, each carrying its Stage 1 severity and its `file:line`.
2. **State the empty case explicitly** rather than omitting the section, so absence means "not answered" and never "nothing found".
3. **Apply it to both completion steps** — compact and full — and scope the compact mode's sentence budget to the prose summary only.
4. **Decide the tester's "remaining requirement gaps"** into the same section or an adjacent one, so one concept has one vocabulary.
5. **Leave `reconcile` untouched** in this plan; its consumption is the next plan's business.

### Migration

None — additive. Consumers must treat a missing section as unknown, not empty.

## Verification Plan

### Goal Invariants

- Every review pass produces a deferred-findings section, including when the set is empty.
- Each item carries a severity and a location.
- The `COMPLETION REPORT:` sentinel and the watcher's completion signal are unchanged.

### Automated Tests

- **Both completion modes carry the section:** assert it in the compact and the full step text. A test covering one mode passes while half of users get nothing.
- **The sentinel survives:** assert `COMPLETION REPORT:` is still present and that `ensureCompletionDirective` still recognises the composed text — the guard exists for `replace`-mode overrides, so a broken sentinel fails silently and only for those users.
- **The empty case is explicit:** assert the instruction requires a stated "none" rather than allowing omission.
- **The compact budget does not bound the list:** assert the ≤ 5 sentence limit is scoped to the prose summary in the instruction text.
- **`reconcile`'s prompt is byte-identical:** assert this change did not edit it, since its wording is load-bearing and unchanged from the retired scheduler surface.

## Outstanding Questions

None.
