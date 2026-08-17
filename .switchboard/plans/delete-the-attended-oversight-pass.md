# Delete the Attended Oversight Pass

## Goal

Remove `OversightPassService` and its three routes. Attended automation earns nothing over a schedule: it does what scheduled mode does while requiring a human to sit and watch it.

### Why

**It is the same machine as scheduled automation, minus the autonomy.** A pass resolves a queue and runs it — coding lane at WIP 1, planner lane overlapping on a cooldown — while an agent polls `GET /oversight/status` and narrates. Scheduled mode runs the same board transitions on a clock and needs nobody present. The only thing the pass adds is the requirement that you watch.

**Its two lanes are a second implementation of the orchestrator's tick.** Same shape, two codebases: one in the extension driven by an attended session, one in an agent persona driven by an interval. The pass's queue also resolves **once at start**, so a plan arriving mid-pass is invisible to it — the tick re-derives every wake, which is strictly better for any board that changes.

**It is a fourth exclusive automation mode that never appears in the mode selector.** The system already knows it is exclusive: `OversightPassService.start()` returns **409** when automation is armed (`:189`). That exclusivity is enforced in code and invisible in the UI, which is what makes it feel like a hidden mode rather than a feature.

**Name collision, for anyone reading the history.** "Oversight" names two different things — the oversight *agent* (`orchestrationConfig.enabled`, retired into agent-managed mode) and this oversight *pass*. `feature_plan_20260816150001_oversight-stops-being-a-mode.md` retired the first and deliberately protected the second. This plan retires the second. They are unrelated mechanisms that share a word.

### What this pass found — the deletion is wider than the service

The framing above is correct. What the original plan understated is the **surface area**. The pass is not a self-contained service with three routes; it is documented as a first-class capability across the control plane, and it is pinned by a generated catalog and two contract tests. Verified 2026-08-17 (*line numbers drift — anchor on symbol names*):

| Surface | Extent |
| :--- | :--- |
| `src/services/OversightPassService.ts` | 797 lines |
| `TaskViewerProvider` wiring | field `:922`, construction `:1046–1079`, `attachOversightWatcher` `:1153–1156`, three route callbacks `:3348–3363`, disposal `:22832–22833`, the persona text at `:26409–26431` |
| `extension.ts` wiring | `:1080–1083` |
| `LocalApiServer` | route docs `:315`, `:2600`, `:2632`, `:2662`; dispatch `:3898–3903` |
| **`protocol-catalog.json`** | 3 references — **generated**, gated by `catalog:check` |
| **`.agents/workflows/switchboard.md`** | **16 references** |
| **`.agents/skills/switchboard-orchestration/SKILL.md`** | **17 references** |
| **`.agents/skills/kanban_operations/SKILL.md`** | 4 references |
| **`.agents/skills/terminal-coder-dispatch/SKILL.md`** | 1 reference |
| **`.claude/` mirrors** | 5 mirrored files, gated by `scripts/check-claude-mirror.js` |
| Contract tests | `autoban-state-regression.test.js:443–450`, `unattended-batch-improvement-contract.test.js` (4 references, including constructing the service at `:200`) |

**38 control-plane references across four `.agents/` files, not "§6 and §7 of the `/switchboard` skill".** An agent reading `switchboard-orchestration/SKILL.md` after this lands would be told to call three routes that return 404. The documentation deletion is the larger half of this plan, and it has a machine gate (`catalog:check`, `check-claude-mirror.js`) that will catch a partial job.

> **Superseded:** *"**§6 and §7 of the `/switchboard` skill** — already going with `switchboard-skill-becomes-a-launcher.md`; this removes the reason to relocate them anywhere."*
> **Reason:** understates the surface by an order of magnitude and makes the deletion conditional on another plan. `switchboard.md` carries 16 references, and three *other* `.agents/` files carry 22 more between them; none of those are covered by a launcher rewrite. Leaving them documents three routes that return 404 to every agent that reads them.
> **Replaced with:** this plan owns the full control-plane sweep — all four `.agents/` files, the regenerated `protocol-catalog.json`, and the `.claude/` mirrors. If the launcher rewrite has already removed §6/§7 of `switchboard.md`, that is a smaller diff here; if it has not, this plan removes them. Either way the sweep is unconditional and this plan does not wait on anything.

## What is deleted

- **`src/services/OversightPassService.ts`** — 797 lines.
- **Three routes** on `LocalApiServer`: `POST /oversight/start`, `GET /oversight/status`, `POST /oversight/stop`, their handler wiring (`:3898–3903`) and their doc blocks (`:315`, `:2600`, `:2632`, `:2662`).
- **The `isAutomationArmed` closure** (`TaskViewerProvider.ts:1078`). Its only consumer is the pass's 409 guard (`OversightPassService.ts:189`) — grep confirms nothing else reads it. It goes with the pass.
- **The service's lifecycle wiring** in `TaskViewerProvider` (`:922`, `:1046–1079`, `:1153–1156`, `:3348–3363`, `:22832–22833`) and `extension.ts` (`:1080–1083`).
- **The durable state files** `oversight-state.md` and `oversight-log.md`, and the resume-an-interrupted-pass offer that reads them (`resumeFromDisk`, `:372`).
- **The pass persona text** embedded in `TaskViewerProvider` at `:26409–26431` — the two-lane / cooldown / durable-state instructions. This is the prose description of the machine being removed.
- **The control-plane documentation** — all 38 references across `.agents/workflows/switchboard.md`, `.agents/skills/switchboard-orchestration/SKILL.md`, `.agents/skills/kanban_operations/SKILL.md`, `.agents/skills/terminal-coder-dispatch/SKILL.md`, and their `.claude/` mirrors.
- **The three routes' entries in `protocol-catalog.json`** — by regeneration, never by hand-editing.

Check `GlobalPlanWatcherService` for the completion hook the pass registered and remove only the pass's own subscription — the watcher itself is load-bearing for plan-file completion detection and stays. Specifically: `attachOversightWatcher` (`extension.ts:1083`) drives the pass off `onPlanDiscovered`, while `setOnWorkingStateCleared` (`:1090`) is a **different consumer** that backs the browser Terminals panel's completion toast and must survive. The comment at `extension.ts:1087–1089` says so explicitly — read it before cutting.

## What replaces it

Nothing new. "Run it now while I watch" is scheduled mode with a short interval and the board open.

## Migration

> **Superseded:** *"None expected — the pass has not shipped in a released version."*
> **Reason:** `OversightPassService.ts` was added in `00d6a942` (2026-07-17), which is on `origin/main`. By this repo's own shipped test — is the commit pushed — it shipped. The repo rule is unambiguous: *"When unsure whether something shipped, assume it did and migrate."*
> **Replaced with:** the migration below, which is still small, but stated as a migration rather than as an absence of one.

**On-disk residue: two inert markdown files.** `.switchboard/oversight-state.md` and `.switchboard/oversight-log.md` become orphaned once `resumeFromDisk` is gone. Nothing reads them, nothing is broken by their presence, and they are a readable record of what the pass did. **Leave them.** Do not add a cleanup sweep for two inert markdown files, and do not archive them as `*.migrated.bak` — that convention is for state a reader would otherwise mis-parse, and nothing will read these again.

**In-flight passes are abandoned, not resumed.** An install upgrading mid-pass loses the resume offer. Concretely: a card already dispatched stays where it is, its agent keeps working, and its completion is still detected by `GlobalPlanWatcherService` — but nothing advances the *next* card in that pass's queue. The queue was only ever in `oversight-state.md`, and that file is now inert. This is an accepted one-time loss, not a bug: the window is one upgrade, the board is left in a valid state, and the user's remedy is to drag the next card or arm scheduled mode. Say it plainly in the change notes rather than pretending the window does not exist.

**No config, DB, or `integration-config.json` change.** The pass persisted nothing outside those two markdown files.

## Order — parallel

This subtask shares no code with the worktree-strategy or automation-tab subtasks — only the mode landscape. It can land at any point relative to them, with one coordination point:

**`isAutomationArmed` has two claimants.** This plan deletes it outright (the guard and its only consumer both go). `automation-tab-three-exclusive-modes.md` retargets it to read the new mode, because it deletes `orchestrationConfig.enabled` which the expression currently ORs on. Whichever lands second wins:

* **This plan first** → the expression and its consumer are gone, and the automation-tab subtask has nothing to retarget. Its note to that effect already anticipates this.
* **Automation-tab first** → the expression reads the new mode, and this plan deletes the retargeted version. Same end state.

Either order is correct. What is *not* correct is narrowing `isAutomationArmed` to a constant while `OversightPassService` still constructs — that silently disables a live double-dispatch 409.

## Metadata

**Complexity:** 5
**Tags:** refactor, backend, docs, deletion
**Project:** Browser Switchboard

## User Review Required

**None.** Three decisions taken here:

* **The control-plane sweep is in scope and unconditional.** Four `.agents/` files, the regenerated catalog, and the `.claude/` mirrors. Leaving them is worse than leaving the code — a skill that documents a 404 actively misleads every agent that reads it.
* **The two markdown files are left on disk.** Inert, readable, harmless. A cleanup pass for them is more code than the problem.
* **In-flight passes are abandoned with a stated note**, not rescued with a shim. The window is one upgrade and the board is left valid.

## Complexity Audit

* **Score:** 5 / 10

### Routine

* Deleting one self-contained 797-line service file.
* Deleting three route branches and their doc blocks from `LocalApiServer`.
* Deleting six wiring points across `TaskViewerProvider` and `extension.ts`.
* Regenerating `protocol-catalog.json`.

### Complex / Risky

* **The documentation sweep is 38 references across four files, two of which are dense.** `switchboard.md` (16) and `switchboard-orchestration/SKILL.md` (17) do not merely mention the routes — they document workflows built on them. A find-and-delete of the word "oversight" would shred surrounding prose; each reference needs reading in context, and some sections lose their reason to exist entirely rather than losing a sentence.
* **The `.claude/` mirrors are gated.** `scripts/check-claude-mirror.js` verifies `.claude/` against `.agents/`. Edit `.agents/` only and regenerate the mirrors — hand-editing either side, or editing one and not the other, fails the gate. `.claude/`, `CLAUDE.md` and `AGENTS.md` are shared surfaces; the sweep must be surgical, never wholesale.
* **Two contract tests construct or assert the deleted surface.** `unattended-batch-improvement-contract.test.js:200` passes `isAutomationArmed: () => false` into a constructor that will not exist. `autoban-state-regression.test.js:447–450` asserts the exact source text of the closure. Both go red the moment the service is deleted and both must be updated in the same change.
* **Two watcher consumers look alike and only one goes.** `attachOversightWatcher` and `setOnWorkingStateCleared` sit four lines apart in `extension.ts` and both hang off `globalPlanWatcher`. Deleting the wrong one silently kills the browser Terminals panel's completion toast — a defect with no error message anywhere.
* **`protocol-catalog.json` is generated and gated.** Hand-editing it passes review and fails `catalog:check`; forgetting it entirely leaves three routes catalogued that return 404.

## Edge-Case & Dependency Audit

### Race Conditions

* **A pass running at deletion time.** There is no runtime transition — the service is removed from the build, so there is no window in which a half-deleted engine runs. The only cross-version case is the in-flight-at-upgrade one covered under *Migration*.
* **Disposal ordering.** `this._oversightPass?.dispose()` (`:22832`) sits in the provider's disposal sweep alongside other disposables. Remove the two lines only; do not reorder the surrounding sweep, which disposes terminal-lifecycle state that is unrelated.
* **Construction ordering is load-bearing and goes away cleanly.** The comment at `:1046–1049` records that the service is constructed *before* the API server so the `/oversight/*` callbacks and the watcher attach can land in either order. Once the service is gone that constraint is gone too — but nothing else in the constructor may be reordered to "tidy up" while removing it.

### Security

* **A privilege *reduction*.** Three HTTP routes on `LocalApiServer` are removed and none added. `POST /oversight/start` accepted a body and started dispatching work; after this it 404s. No new attack surface, strictly less.
* No secrets, tokens, or credentials are involved; the pass read only the board and plan files.

### Side Effects

* **Scheduled mode is unaffected.** It shares no code with the pass — different engine, different timers, different persistence.
* **Agent-managed mode is unaffected, and loses a 409 it used to trip.** The pass's exclusivity guard was the only thing that 409'd against an armed orchestrator; with the pass gone there is nothing to guard against, because there is no longer a second in-extension dispatcher.
* **`GlobalPlanWatcherService` keeps every other consumer.** Plan-file completion detection is load-bearing for ordinary dispatches and for the browser completion toast.
* **Agents lose a documented capability.** Any agent following the current `switchboard-orchestration` skill will stop finding the oversight routes. That is the point — and it is why the doc sweep is in this plan rather than a follow-up.

### Dependencies & Conflicts

* **`src/services/OversightPassService.ts`** — deleted whole.
* **`src/services/TaskViewerProvider.ts`** — `:50` (import), `:919–922`, `:1046–1079`, `:1114`, `:1153–1156`, `:3348–3363`, `:22832–22833`, `:26409–26431`.
* **`src/services/LocalApiServer.ts`** — `:315`, `:2600`, `:2632`, `:2662`, `:3898–3903`.
* **`src/extension.ts`** — `:1080–1083` only. **Not** `:1085–1092` (`setOnWorkingStateCleared`), which is a different consumer that stays.
* **`src/services/GlobalPlanWatcherService.ts`** — `:14` names `OversightPassService` in a doc comment listing its dependants. Update the comment; change no code.
* **`protocol-catalog.json`** — regenerate via `scripts/generate-protocol-catalog.js`. Never hand-edit.
* **`.agents/workflows/switchboard.md`**, **`.agents/skills/switchboard-orchestration/SKILL.md`**, **`.agents/skills/kanban_operations/SKILL.md`**, **`.agents/skills/terminal-coder-dispatch/SKILL.md`** — the source of truth. Edit these, then regenerate the `.claude/` mirrors.
* **`src/test/autoban-state-regression.test.js`**, **`src/test/unattended-batch-improvement-contract.test.js`** — both updated in the same change.
* **Sibling subtask conflict — `isAutomationArmed`.** See *Order* above. One expression, two claimants, either order valid.

## Dependencies

* None outstanding. This plan waits on nothing; the `isAutomationArmed` coordination is an either-order note, not a blocker.

## Adversarial Synthesis

Key risks: (1) **shipping the code deletion without the doc sweep**, leaving 38 control-plane references instructing agents to call routes that 404 — the larger half of this change and the half most likely to be skipped; (2) **deleting `setOnWorkingStateCleared` instead of `attachOversightWatcher`** in `extension.ts`, four lines apart and superficially alike, silently killing the browser completion toast; (3) **hand-editing `protocol-catalog.json` or the `.claude/` mirrors** instead of regenerating, which passes review and fails the gates; (4) **narrowing `isAutomationArmed` to a constant** while its consumer still constructs, disabling a live double-dispatch 409. Mitigations: the doc sweep is enumerated file by file with reference counts; the two watcher consumers are called out by line with the distinguishing comment quoted; both generated artefacts are named as regenerate-only; the guard is deleted with its consumer, never narrowed ahead of it.

## Proposed Changes

**Build order:** (1) unwire → (2) delete the service → (3) delete the routes → (4) sweep the control plane → (5) regenerate → (6) update the tests. Unwire first so no intermediate state constructs a deleted class.

### 1. `src/extension.ts` + `src/services/TaskViewerProvider.ts` — unwire

* `extension.ts:1080–1083`: delete the `attachOversightWatcher` call and its three-line comment. **Stop there.** The next block (`setOnWorkingStateCleared`, `:1085–1092`) is the browser Terminals panel's completion toast and stays — its own comment says it is a *"distinct consumer from attachOversightWatcher above."*
* `TaskViewerProvider.ts`: delete the import (`:50`), the field and its comment (`:919–922`), the construction block (`:1046–1079`), the `attachOversightWatcher` method (`:1153–1156`), the three route callbacks (`:3348–3363`), and the disposal pair (`:22832–22833`).
* Delete `isAutomationArmed` (`:1078`) as part of the construction block — it is a property of the deps object and has no other reader.
* Delete the pass persona text at `:26409–26431` (the two-lane / cooldown / `oversight-state.md` instructions).

**Edge cases:** the comment at `:1114` refers to *"the `_oversightPass` built in the constructor"* — it goes too. Leave no tombstone comments explaining the machine that used to be here.

### 2. `src/services/OversightPassService.ts` — delete the file

`git rm` it. It is self-contained; nothing imports it after step 1.

### 3. `src/services/LocalApiServer.ts` — delete the three routes

Remove the dispatch branches at `:3898–3903` and the doc blocks at `:315`, `:2600`, `:2632`, `:2662`. The routes must be **gone**, not disabled — a route that returns a friendly "this was removed" is still a route, and the verification asserts 404.

**Edge cases:** the callback fields these routes invoked were removed in step 1; if the server's constructor takes them as options, remove the option too rather than passing `undefined`.

### 4. Control plane — the sweep

Work in `.agents/` only; the `.claude/` tree is generated from it.

* **`.agents/workflows/switchboard.md`** (16 refs) — sections built on the pass lose their reason to exist and are removed whole, not hollowed out. If the launcher rewrite has already taken §6/§7, only the residual references remain.
* **`.agents/skills/switchboard-orchestration/SKILL.md`** (17 refs) — this skill is the HTTP contract for external orchestrators. Every `/oversight/*` route, its payload shape, and any workflow that chains them comes out. An orchestrator reading this file must not learn the routes exist.
* **`.agents/skills/kanban_operations/SKILL.md`** (4 refs) — remove the references; the skill's card-move purpose is unaffected.
* **`.agents/skills/terminal-coder-dispatch/SKILL.md`** (1 ref) — one reference, remove it.

**Edge cases:** read each reference in context. Several are prose describing a workflow, not a bare route name; deleting the token and leaving the sentence produces instructions that no longer parse. Do not touch `AGENTS.md` or `CLAUDE.md` beyond any direct `/oversight/*` reference — they are shared surfaces and the sweep must be surgical.

### 5. Regenerate both generated artefacts

* `npm run catalog:generate` (`generate-protocol-catalog.js --write` + `generate-verb-allowlist.js --write`) → `protocol-catalog.json` loses its three oversight entries. `npm run catalog:check` runs the same generators without `--write` and fails on drift.
* Regenerate the `.claude/skills/` mirror from `.agents/`. `npm run mirror:check` regenerates into a temp directory using the same `generateClaudeMirror` the extension uses and diffs it against the committed mirror, so a stale mirror fails CI. It requires `npm run compile-tests` first (it loads `out/services/ClaudeCodeMirrorService.js`).

Neither file is hand-edited. If a regen produces an unexpected diff, that is a signal about step 4, not a reason to hand-correct the output.

### 6. Tests

* **`src/test/unattended-batch-improvement-contract.test.js`** — `:200` constructs `OversightPassService` with `isAutomationArmed: () => false`. Remove the construction and whatever the surrounding case asserted about the pass. If the case exists *only* to exercise the pass, remove the case; if it exercises the unattended improver and merely borrowed the pass as a harness, rewrite it against the improver directly.
* **`src/test/autoban-state-regression.test.js`** — `:443–450` asserts the exact source text of `isAutomationArmed`. Delete the assertion and its three-line comment. Add the mirror:

```js
// The attended oversight pass is DELETED, not flagged off.
for (const dead of ['OversightPassService', 'isAutomationArmed', 'attachOversightWatcher']) {
    assert.ok(
        !providerSource.includes(dead),
        `TaskViewerProvider still references the deleted oversight pass (${dead})`
    );
}
```

## Verification Plan

> **Session note:** this run was directed to skip compilation and skip automated test execution, so the checks below are written for the implementing coder, not run here.

### Automated Tests

* `POST /oversight/start`, `GET /oversight/status` and `POST /oversight/stop` all return **404** — the routes are gone, not disabled.
* No file under `src/` references `OversightPassService`, `isAutomationArmed`, `attachOversightWatcher`, `oversight-state` or `oversight-log`.
* No file under `.agents/` or `.claude/` contains `/oversight/`.
* `protocol-catalog.json` contains no oversight route, and the file matches a fresh run of `generate-protocol-catalog.js` byte-for-byte.
* `npm run catalog:check` and `npm run verb-returns:check` pass with the three routes removed.
* `npm run mirror:check` passes — the regenerated `.claude/skills/` mirror matches the committed one after the sweep.
* `extension.ts` still calls `globalPlanWatcher.getEngine().setOnWorkingStateCleared(...)` — asserted explicitly, so deleting the wrong consumer fails.
* The extension activates with no oversight wiring, and `GlobalPlanWatcherService` still fires plan-file completion for ordinary dispatches.
* `autoban-state-regression.test.js` and `unattended-batch-improvement-contract.test.js` both pass with their oversight assertions replaced.

### Manual Verification

1. `curl` each of the three routes against a running API server — all 404.
2. Scheduled mode still advances cards on its interval, unaffected.
3. Agent-managed mode still dispatches, unaffected — the 409 it used to trip no longer exists because there is nothing to guard against.
4. A workspace carrying a stale `oversight-state.md` opens normally and nothing offers to resume anything. The file is still on disk afterwards.
5. The browser Terminals panel still shows its completion toast when a dispatched agent finishes — the consumer that sits four lines from the deleted one.
6. Read `.agents/skills/switchboard-orchestration/SKILL.md` end to end as an orchestrator would: no route it names returns 404, and no workflow it describes depends on one.

## Recommendation

Complexity 5 → **Send to Coder.**

**Read the surface table before touching code.** The service is 797 self-contained lines and is the easy half. The other half is 38 references across four `.agents/` files plus two generated artefacts with gates, and skipping it ships skills that instruct agents to call routes returning 404.

**The thing to get right:** in `extension.ts`, delete `attachOversightWatcher` and *not* `setOnWorkingStateCleared`. They are four lines apart, both hang off `globalPlanWatcher`, and the wrong cut kills the browser completion toast with no error anywhere. The distinguishing comment is already in the file — read it.

**Do not** hand-edit `protocol-catalog.json` or the `.claude/` mirrors, do not add a cleanup pass for the two inert markdown files, and do not narrow `isAutomationArmed` to a constant while its consumer still constructs — delete them together.

## Completion Report

Implemented the full deletion: `OversightPassService.ts` (git rm'd), its three `LocalApiServer` routes (`/oversight/start`, `/oversight/status`, `/oversight/stop`) with handler methods and option-type doc blocks, all wiring in `extension.ts` (`attachOversightWatcher` call + comment — `setOnWorkingStateCleared` preserved as instructed) and `TaskViewerProvider.ts` (import, field, construction block with `isAutomationArmed`, `attachOversightWatcher` method, three route callbacks, disposal pair, `_buildTargetedPassPrompt` persona text, `handleDispatchManagerForSelected`), the `dispatchManagerForSelected` verb handler in `KanbanProvider.ts`, the `GlobalPlanWatcherService.ts` doc comment, and the `btn-manager-pass` UI surface across `kanban.html`, `transport.js`, `KanbanProvider.ts`, `headlessPanelHtml.ts`, and `verbSchemas.ts`. The control-plane sweep removed all 38 references across four `.agents/` files (switchboard.md §6/§6b/§7 deleted whole, switchboard-orchestration §4a deleted, kanban_operations blockquote removed, terminal-coder-dispatch reference cleaned). `protocol-catalog.json` and `src/generated/verbAllowlist.ts` regenerated via `npm run catalog:generate`; `.claude/skills/` mirror regenerated via `generateClaudeMirror`. Both contract tests updated: `autoban-state-regression.test.js` now asserts the deleted symbols are absent (the mirror from the plan), `unattended-batch-improvement-contract.test.js` lost Subtask 3 and the oversight-doc test (plus the `OversightPassService` import, vscode shim, and pass-only utilities), and `headless-feature-management-contract.test.js` lost the `updateManagerPassButton` ordering check. No issues encountered — the plan's surface table did not enumerate the `btn-manager-pass` UI button or the `dispatchManagerForSelected` verb/schema, but both were part of the oversight pass surface and were removed to avoid leaving an inert button sending a verb nobody handles.
**Addendum (review gap fix):** retargeted contract #11 in `.agents/skills/switchboard-contracts/SKILL.md` — dropped the oversight-pass framing and the dead `OversightPassService._hasOpenQuestions` source cite, retargeted to the `unattended` planner branch in `agentPromptBuilder.ts` that still emits the block; regenerated the `.claude/` mirror.

## Review Findings

Deletion is complete and correct: zero `/oversight/` references survive in `src/`, `.agents/`, `.claude/` or `protocol-catalog.json`, and the plan's headline trap was avoided — `setOnWorkingStateCleared` survives at `extension.ts:1084` while only `attachOversightWatcher` was cut. Reviewer fixed three residue items the coder left: a tombstone comment in `TaskViewerProvider.ts` still citing the deleted oversight `countEligibleTerminals` dep, a now-false "both PM dispatch paths" claim on `_deliverPromptToPmTerminal` (one caller remains, `_handleDispatchProjectManager`), and six mangled indentation sites in `kanban.html` left by the mechanical `updateManagerPassButton()` removals. Validation: `catalog:check`, `mirror:check`, `verb-returns:check` and `compile-tests` all pass, as do `unattended-batch`, `headless-feature-mgmt` and `browser-direct-terminal-helpers`; all four checks named in the plan are CI-invoked, so no gate hole. Remaining risk (accepted, not fixed): `getUnattendedPlannerTerminal` / `getUnattendedImproverTerminals` in `TaskViewerProvider.ts` are now caller-less — the oversight dep was their only consumer — but they are public and a sibling orchestration subtask may claim them, so they were left in place rather than deleted beyond this plan's scope.

## Review Findings — second pass (feature-level review, 2026-08-17)

Re-verified at the merged tree: the deletion is complete and nothing regressed. `grep -rl "/oversight/"` across `src/`, `.agents/`, `.claude/` and `protocol-catalog.json` returns nothing; `OversightPassService`, `isAutomationArmed` and `attachOversightWatcher` survive only inside the absence assertions; and the plan's headline trap remains avoided — `setOnWorkingStateCleared` is still wired at `extension.ts:1084`. `catalog:check`, `mirror:check`, `verb-returns:check`, `parity:check`, `push-routing:check` and `standalone-parity:check` all pass, as do `unattended-batch`, `headless-feature-mgmt` and `autoban-state`; all are CI-invoked, so no gate hole. One cross-plan note now resolved in this plan's favour: the `isAutomationArmed` two-claimant coordination landed in the "this plan first" order, so the sibling automation-tab plan had nothing to retarget and the guard was never narrowed to a constant. No new findings; the accepted risk stands (`getUnattendedPlannerTerminal` / `getUnattendedImproverTerminals` remain caller-less pending a sibling orchestration subtask).
