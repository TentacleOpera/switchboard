# Source-Text Contract Suite — Clear the Red Queue and Stop Spans Rotting Silently

**Complexity:** 7

## Goal

Return the CI contract suite to green and remove the mechanism that keeps taking it red. Six of the eight red run-steps are source-text contracts that assert over an incidental property of the source — a renamed adjacent constant, the first break statement, a latched flag that was deliberately deleted, a bare substring ban — so every legitimate refactor reports the improvement as a violation, and each red step halts a single-job workflow with zero continue-on-error. Three subtasks re-author the failing assertions to defend intent rather than implementation shape; the fourth replaces the hand-rolled span primitive that lets a failed marker lookup return a plausible-looking span instead of throwing. Grouped because they are one class of defect: the repairs without the primitive invite the next rot, and the primitive without the repairs leaves CI red.

## How the Subtasks Achieve This

- **Two CI contracts extract a span that no longer exists**: re-anchors the pane-fit tail marker (`DEFAULT_ROLES` to `NO_ROLE`, renamed five months ago) and bounds the memo `workspaceChanged` arm by the next `case '` instead of the first `break;`, then retires the dead marker from two prose sites. Clears run-steps 65 and 76.
- **Three CI contracts pin implementations that were deliberately replaced**: re-authors the memo verb's now-unreachable seam-first lever, the deleted `inputDropNoticed` latch probe, and the narrowed `if (!isKnown)` refetch regex. Zero production edits — the entire diff is three test files. Clears run-steps 64, 78 and 80.
- **A whole-file regex in the WS surface-scoping contract false-positives on a debug log**: scopes the `msg.surface` ban to non-diagnostic lines, extracts the predicate so the real check and its fixtures share one implementation, and pins it with in-suite fixtures so a silently-weakened predicate fails the build. Clears run-step 94, the last of the eight.
- **55 hand-rolled source-span extractions treat a failed marker lookup as a valid span**: adds `at()` (a guarded `indexOf`) and `span()` (marker-pair sugar with inversion, degeneracy and generic-end-marker rejection), a self-test, and a ratchet gate. This is the subtask that stops the class recurring, and it closes the largest silent mode — the 51 fixed-window sites whose assertions can pass while matching nothing at all.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A whole-file regex in the WS surface-scoping contract false-positives on a debug log](../plans/ws-surface-scoping-false-positive-blocks-ci-tail.md) — **PLAN REVIEWED** — ID: 25c68f2b-f66c-4a5a-bade-c015c5222d6d
- [ ] [Two CI contracts extract a span that no longer exists — a renamed declaration and a guard clause silently emptied their assertion windows](../plans/ci-contract-span-rot-memo-binding-and-pane-fit.md) — **PLAN REVIEWED** — ID: 74738725-1e30-413f-87ac-b419796364d1
- [ ] [Three CI contracts pin implementations that were deliberately replaced — the code moved on and the assertions did not](../plans/ci-contracts-pinning-superseded-designs-memo-verb-terminal-input-shell-strip.md) — **PLAN REVIEWED** — ID: 60288750-f436-47ca-a456-aba55b673bb0
- [ ] [55 hand-rolled source-span extractions treat a failed marker lookup as a valid span — one silently swallows the file, another silently collapses to nothing](../plans/source-span-extraction-guard-shared-helper.md) — **PLAN REVIEWED** — ID: f944fb1d-b9a3-4b51-bd84-80462fda37d0
<!-- END SUBTASKS -->

## Dependencies & sequencing

- The three repair subtasks are **mutually independent** and target disjoint test files; the plans verify this against each other explicitly. Parallelise freely.
- **`source-span-extraction-guard-shared-helper` must land last.** It has a hard ordering dependency on the span-rot subtask (it migrates that subtask's *corrected* memo span onto the shared helper, so landing first would fix one file twice and destroy the other's negative-control fixture), and it also touches `shell-terminal-strip` and `ws-surface-scoping` — two of its nine dual-population files — so it should follow the other two repairs as well.
- **External blocker:** none of these change what CI *does* until the `delegates` manifest entry lands in the *.claude/skills Mirror* feature. `mirror:check` is run-step 11 and halts the job before any of these are reached. Each is still independently correct and permanently removes a step from the blocking queue.
- The shared-helper subtask self-recommends a three-phase split (helper plus gate, then the 62 marker-bounded sites, then the 94 index-derived sites). Worth honouring at dispatch time rather than landing it as one diff.
- Standing hazard across all four: a deleted assertion and a repaired one look identical from the outside — both green. The negative controls each plan specifies are the only acceptance signal.

