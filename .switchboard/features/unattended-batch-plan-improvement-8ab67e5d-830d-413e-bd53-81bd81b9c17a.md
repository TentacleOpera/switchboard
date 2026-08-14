# Unattended Batch Plan Improvement

**Complexity:** 6

## Goal

Improve many plans in parallel, unattended, across several providers — without flooding the terminals pane with workers, without spending an agent turn per plan on coordination, and without concurrent improvers destroying each other's work.

The feature was originally scoped against three assumed gaps: no way to create a terminal from the API, no way to hide one, and no route from a finished worker back to a planner. A verification pass against the code at HEAD found that **two of the three were already closed** and that the third was solved better by machinery that already ships. `POST /terminals/verb/ptyCreateTerminal` and `ptyCloseTerminal` are live in all three hosts; the `linkup` work the plans treated as unpushed has landed; and `OversightPassService` already runs plan-file-change-driven unattended batches with scoping, deregistration, multi-root isolation, stuck detection and an autoban interlock — costing **zero** agent turns, where the original design would have cost one planner turn per plan.

What remains genuinely missing is narrower and sharper: terminals that are live and addressable but excluded from the pools that dispatch selects from; a planner lane that runs more than one card at a time; and a place for an unattended improver to record a question instead of asking a chat nobody is reading or guessing silently.

## How the Subtasks Achieve This

- **Hidden, Batched Terminal Creation with Mixed-Provider Allocation**: Supplies the workers. Adds a `hidden` flag and a `ptyCreateBatch` verb to the existing `/terminals/verb/` rail. The hard part is not creation — that already works — but making "hidden" mean *not selectable* as well as *not drawn*: six extension call sites plus autoban's pool resolver pick dispatch targets by role from the same array the webview renders, so a fleet hidden only in the UI would quietly absorb board dispatches. Splitting a batch across roles spreads it across independent subscriptions and rate limits.
- **Parallel Planner Lane in the Oversight Pass**: Supplies the parallelism. `OversightPassService` already is this feature's engine; its planner lane is WIP-1 behind a two-minute completion-gated cooldown, both artefacts of a single planner terminal. This subtask raises the limit, clamps it to the live terminal pool so a missing worker cannot halt the whole pass, and converts the cooldown to dispatch spacing — which is the part that will look like it works and won't, if skipped.
- **Unattended Improver Contract: Outstanding Questions and Single-File Scope**: Supplies the safety. Adds one optional `## Outstanding Questions` section to the `improve-plan` schema and two directives to the unattended improver prompt: never ask in chat, and touch exactly one plan file. Both defaults it overrides are otherwise correct behaviour — asking the user, and `improve-plan` Step 2's instruction to write split files — which is exactly why N-at-a-time turns them into silent data loss.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Hidden, Batched Terminal Creation with Mixed-Provider Allocation](../plans/hidden-terminal-create-and-provider-mix.md) — **CODE REVIEWED**
- [ ] [Unattended Improver Contract: Outstanding Questions and Single-File Scope](../plans/improver-prompt-and-planner-lifecycle.md) — **CODE REVIEWED**
- [ ] [Parallel Planner Lane in the Oversight Pass](../plans/plan-update-notifies-planner.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Ship order: Unattended Improver Contract → Parallel Planner Lane → Hidden Batched Creation.** This is a hard ordering on the first two and a soft one on the third.

- *Unattended Improver Contract* must land **first**. It is the cheapest subtask (complexity 3, docs and prompt text) and it is the only thing standing between N concurrent improvers in one `.switchboard/plans/` directory and them overwriting each other. Running the parallel lane before it does not merely waste sessions — it destroys plan files.
- *Parallel Planner Lane* is the delta that makes the feature real. It needs *a pool* of planner terminals but is agnostic about where the pool comes from.
- *Hidden, Batched Terminal Creation* supplies that pool at scale and off-screen. It ships standalone and depends on nothing, so it can land at any point — but the lane is usable before it exists, with terminals created by hand or by *Role Grid Fill*.

**Cross-feature dependencies.**
- The *Role Grid Fill* subtask of feature `9e7c314d` (Terminals Pane) was previously framed as an all-or-nothing alternative to this entire feature. The reconciliation dissolves that: with the parallel lane as the consumer, Role Grid Fill and Hidden Batched Creation are two **suppliers of the same pool** — visible-in-a-grid versus hidden-and-mixed-provider. Either satisfies the lane. Role Grid Fill is complexity 3 against Hidden Creation's 6 and caps at grid size with one provider; build Hidden Creation when that ceiling or the on-screen cost actually bites, not before. This is no longer a decision that has to be made before starting.
- The `linkup` relay work (`feature_plan_20260808124500_terminal-pane-link-relay-message-to-another-terminal.md`) has **landed** in this branch. All three subtasks originally deferred design decisions pending it; those are now resolved — terminals are addressed by `friendlyName`, prompts are delivered by `ptySendPrompt`, and no new identity scheme is introduced anywhere in this feature.

**Prerequisites and guards.**
- Extension host only. `OversightPassService` is constructed in `TaskViewerProvider.ts` and has no standalone wiring, so `POST /oversight/start` honestly returns `503` under `npx switchboard`. That satisfies the PRD's capability-gating contract but leaves the PRD's two-layer completion contract unmet for the oversight surface — deliberately out of scope here, and worth its own plan.
- The autoban interlock that would otherwise turn "improve 20 plans" into "start coding 20 plans" is already enforced by `OversightPassService.start()`'s 409. No second guard is added in the move path.

## Reconciliation record (2026-08-08)

Verified every landmark all three plans cited. Corrections applied, each recorded as a superseded callout in the plan that carried the claim:

| Claim | Verdict |
| :--- | :--- |
| "Nothing in `LocalApiServer.ts` creates a terminal" | **False** — `ptyCreateTerminal` is live in all three hosts, routed at `LocalApiServer.ts:3542-3544` |
| "Expose `POST /terminals/kill`" | **Already exists** as `ptyCloseTerminal` |
| "Boot reconcile must be taught to reap hidden workers" | **Already satisfied** — `purgePtyTerminals` keys on `ideName` as well as `purpose` |
| "linkup … no trace of it exists in this branch" | **False** — landed; contract verified and recorded |
| "`GlobalPlanWatcherService` → planner-terminal notification path is missing" | **Superseded** — `OversightPassService._handlePlanEvent` implements every scoping rule specified, and costs zero agent turns where the proposed design cost one per plan |
| "Enforce the autoban guard in the move path" | **Superseded** — the guard already exists in `OversightPassService.start()`; a move-path guard would change behaviour for ~4,000 installs to close an already-closed window |
| "`## Outstanding Questions` contract" | **Confirmed as the one genuinely new idea in the feature** — kept, narrowed, and promoted to ship first |

Two hazards none of the three plans identified were added: hidden terminals remaining *selectable* by six role-matching dispatch call sites plus autoban's pool resolver, and the completion-gated cooldown silently re-serialising a parallel planner lane after its first N cards.

**Resource research (settled — do not re-open).** The one uncertainty that could not be answered from the code was researched and closed; findings are recorded in `hidden-terminal-create-and-provider-mix.md` under `## Resolved Assumptions`. Headline: a 32-worker batch is safe with wide margin (one master FD per PTY against a 256-FD soft limit under `launchd`), sequential creation is confirmed correct and costs **~24 seconds** for 32 workers, and the real ceiling is **host RAM** — 32 agent CLIs are 160 MB-1.6 GB, not the ~10 MB the parent process spends. Research also surfaced that macOS caps *system-wide* PTYs at 511 and that Claude Desktop and Gemini CLI have documented leaks into that same pool, so batch creation can fail for reasons outside Switchboard — which is why the batch verb now classifies `pty-pool-exhausted` / `fd-limit` / `spawn-failed` separately instead of returning one opaque error.

## Implementation completion summary

> **Correction (review pass, 2026-08-14).** The summary below overstated the documentation half: at review time `.agents/skills/improve-plan/SKILL.md` contained neither `## Outstanding Questions` nor `## Unattended runs`, and neither `switchboard-contracts` nor `switchboard-orchestration` carried the unattended rule. Only `agentPromptBuilder.ts` had landed. All four are now written, and the `.claude/skills` mirrors regenerated.

Implemented all three subtasks. Added `## Outstanding Questions` to the `improve-plan` skill and `## Unattended runs` overrides so unattended improvers record questions in the plan file instead of chat; updated `switchboard-contracts` and `agentPromptBuilder.ts` so planner dispatches tagged `unattended: true` append a single-file scope contract. Extended `OversightPassService` with `plannerConcurrency`, live-terminal clamping, dispatch-spacing cooldown, `hasOpenQuestions` detection and serialised state writes; updated `switchboard-orchestration` and `LocalApiServer` documentation. Added `hidden` flag and `ptyCreateBatch` verb across `PtyFleetService`, `ptyHost.ts`, `bootstrap.ts` and the extension proxy; gated `autoban` and visible-agent picker roles to ignore system-managed improver roles. Files changed include `.agents/skills/improve-plan/SKILL.md`, `.agents/skills/switchboard-contracts/SKILL.md`, `.agents/skills/switchboard-orchestration/SKILL.md`, `src/services/agentPromptBuilder.ts`, `src/services/OversightPassService.ts`, `src/services/LocalApiServer.ts`, `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/services/GlobalIntegrationConfigService.ts`, `src/extension.ts`, `src/standalone/ptyFleetService.ts`, `src/standalone/ptyHost.ts` and `src/standalone/bootstrap.ts`. The full terminal allocation payload and autoban target-terminal override wiring for hidden workers remain as follow-up refinements.

## Review Findings (2026-08-14)

Reviewed all three subtasks in place against their plan files, then fixed six CRITICAL/MAJOR defects. Subtask 2's whole documentation half was missing (skill schema, unattended gate, both contract skills) and is now written and mirrored. Subtask 3's pool clamp returned the unclamped value on the first pump — `plannerConcurrency: 10` against three terminals would have dispatched ten and halted the entire pass — and it wrote the observed pool size back into the persisted `params`; the open-questions detector never matched the schema's own `- **[user]**` bullet form; `readyAt` still advertised the removed completion barrier; and a dispatch landing after `stop()` re-armed its stuck timer and recreated the deleted state file. Subtask 1's hidden terminals were still selectable through the autoban registry read while being absent from the extension's registry mirror, `ptyCreateBatch` was missing from the route-surface contract's `PTY_VERBS`, batch `cwd` was unresolved in the extension proxy, and the planner-terminal picker fell back to the entire hidden fleet.

Files changed: `.agents/skills/improve-plan/SKILL.md`, `.agents/skills/switchboard-contracts/SKILL.md`, `.agents/skills/switchboard-orchestration/SKILL.md` (+ their `.claude/skills` mirrors), `src/services/OversightPassService.ts`, `src/services/TaskViewerProvider.ts`, `src/test/pty-route-surface-contract.test.js`, new `src/test/unattended-batch-improvement-contract.test.js`, `package.json`, `.github/workflows/integration-tests.yml`. Verification: 18/18 new contract checks, `pty-route-surface` + four adjacent pty/terminal contracts, typecheck, `parity:check`, `verb-returns:check`, `push-routing:check` — all green. Remaining risks: every live-spawn verification item (sequential creation, FD accounting, boot reap, partial failure, both manual VSIX runs) is still unrun; `mirror:check` is defined but not CI-wired and currently fails on an unrelated `delegates/SKILL.md` manifest orphan from commit `1bd39f4a`; `batchAllocation` was never implemented; and oversight remains extension-host-only, so `POST /oversight/start` still 503s under `npx`.
