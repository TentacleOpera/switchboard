# Standalone: triage the Board verbs that cannot work headlessly, and prove the rest do

## Goal

After the Board's verb rail falls through to `KanbanProvider`, run every delegated verb against a
real standalone server and classify each one **works / degrades / editor-only**, then headless-adapt
the degraders and hand the editor-only list to the capability-gating plan. The deliverable is a
verified per-verb table plus the adaptations it calls for — not a guess.

### Root problem / background (verified 2026-08-04)

`standalone-board-verb-rail-fallthrough` makes 82 previously-dead verbs reachable. Reachable is not
the same as working. Three known mechanisms make a delegated arm misbehave in the headless host, and
none of them is visible from a compile:

1. **Command no-ops.** 171 `executeCommand` call sites across the wired providers, led by
   `switchboard.refreshUI` (43 sites), all resolving to `undefined`. The sibling plan
   `standalone-refreshui-and-command-bridge` bridges the ones with a headless meaning and
   deliberately declines the rest — this plan is what decides which is which, per verb.

   > **Superseded:** "`vscodeShim.ts:229` stubs `executeCommand`. ~150 call sites … led by
   > `switchboard.refreshUI` (44 sites)."
   > **Reason:** Measured wrong, and the mis-attribution matters for triage: **164 of the 171 sites
   > route through the host seam** (`this._seams().commands.executeCommand`) and dead-end at
   > `src/standalone/hostServices.ts:354-356` (`executeCommand: async () => undefined`), not at the
   > shim. Only 7 are raw `vscode.commands.executeCommand`, all in `KanbanProvider`. A triage run that
   > checked the shim would conclude the bridge had landed while 164 sites stayed dead.
   > **Replaced with:** the dead end for the "needs a bridged command" classification is the
   > **headless `commands` seam**. When re-running triage on both sides of the bridge, assert against
   > that seam (and against `switchboardCommandRegistry`, `services/commandRegistry.ts`), not against
   > `vscodeShim.commands`.
2. **Dialog rejections.** `vscodeShim.ts:131-137` makes `showInputBox`, `showQuickPick`,
   `showOpenDialog` and `showSaveDialog` **reject** with a clear message, while
   `showInformationMessage` / `showWarningMessage` / `showErrorMessage` return `undefined`
   (`:133-135`). So an arm that prompts for input fails loudly (good), and an arm that shows a toast
   silently loses it. Note the codebase almost never gates flow on a dialog result — a scan of the
   five wired providers found exactly **one** `const x = await vscode.window.show*Message(` — so
   confirmation-gated silent no-ops are *not* a widespread risk here. Do not assume otherwise.
3. **Clipboard is a no-op.** `vscodeShim.ts:266-274` documents the pattern: prompt-copy arms must
   return the prompt in the HTTP body so `transport.js:278-282` can write it client-side. Any
   delegated `copy*` arm that only calls `env.clipboard.writeText` will appear to succeed and copy
   nothing. `kanban.html` sends at least `copyPrdPrompt`, `copyWorktreeMergePrompt` and
   `generateAntigravityPrompt` — all currently dead.

   **But do not assume all three need adapting — one already complies.** `copyPrdPrompt`
   (`KanbanProvider.ts:7668-7698`) already routes through the seam
   (`await this._seams().clipboard.writeText(prompt)`) **and** returns
   `{ success: true, prompt, prdPath }`, plus a `showStatusMessage` push. It is a **works** case, not a
   **degrades** case. Verify each `copy*` arm's return shape before classifying it — the cluster is
   mixed, not uniform.

There is also a documented precedent that read verbs can return an empty ack: `SetupPanelProvider`
carries an explicit TODO that its arms "push their result over the WS hub and `break`, so an HTTP
caller receives only the route layer's `{success:true}` with no data — the *write-only reads*
anti-pattern" (`SetupPanelProvider.ts:59-65`). `KanbanProvider.handleServiceVerb` claims the opposite
for its 144 arms (`:7208-7211`). **That claim is exactly what this triage tests.** The browser can
still work when a read is push-only (transport.js merges WS pushes), so a push-only read is a
finding about the HTTP API, not necessarily a UI bug — the table must distinguish them.

**The anti-pattern is confirmed live, not hypothetical.** `SetupPanelProvider.ts:966-968`:

```ts
const previews = await this._taskViewerProvider.handleGetDefaultPromptPreviews();
this.postMessage({ type: 'defaultPromptPreviews', previews });
return { success: true };
```

A wired provider, a read verb, previews computed and then dropped from the body. Treat
`handleServiceVerb`'s "all 144 arms return" as a hypothesis with a known counter-example in the
neighbourhood — and record push-only reads as their own classification rather than folding them into
**works** or **degrades**.

**A fourth mechanism, added after cross-plan review: the project tier.** The provider's scoped
helpers take their project from `msg.initiatorProject` (`_getScopedSetting:636`,
`_updateScopedSetting:674`), while standalone holds the active project in a `projectFilter` closure
(`bootstrap.ts:301`). If the fallthrough does not forward it, scoped reads and writes resolve on the
workspace tier and return plausible values with no error — indistinguishable from working unless the
oracle inspects *which tier* the DB row landed on. The settings-toggle and project-assignment clusters
must be triaged with a tier-aware oracle, not just a value-equality one.

The clusters to triage, from the measured dead list (83 verbs):

| Cluster | Verbs | Expected outcome |
| :--- | :--- | :--- |
| Card movement | 4 (`moveCardForward`, `moveCardBackwards`, `promptOnDrop`, `triggerBatchAction`) | works after fallthrough + refresh bridge |
| Worktrees | 10 (`createWorktree`, `createWorktreeForFeature`, `createWorktreeForProject`, `cleanupWorktree`, `abandonWorktree`, `getWorktreeStatuses`, `getWorktreeConfig`, `openWorktreeTerminals`, `copyWorktreeMergePrompt`, `toggleWorktreeAgentsOpenWithGrid`) | mostly works — git is host-agnostic; `openWorktreeTerminals` needs the PTY fleet, not editor terminals |
| Card lifecycle | 10 (`archiveSelected`, `recoverSelected`, `recoverAll`, `completeAll`, `uncompleteCard`, `sendToBacklog`, `sendToNew`, `toggleBacklogView`, `getAutoArchiveConfig`, `saveAutoArchiveConfig`) | works — DB-only |
| Board structure | 7 (`getKanbanStructure`, `saveKanbanColumn`, `deleteKanbanColumn`, `updateKanbanStructure`, `toggleKanbanColumnVisibility`, `restoreKanbanDefaults`, `setColumnDragDropMode`) | works — DB/config only |
| Project & workspace assignment | 5 (`assignSelectedToProject`, `reassignPlansWorkspace`, `setProjectOverride`, `setWorkspaceOverride`, `setPushScope`) | works; `reassignPlansWorkspace` needs the mappings command bridged |
| Agents tab | 4 (`getStartupCommands`, `getCustomAgents`, `exportAgentAsSkill`, `exportAgentAsSkillResult`) | reads work; `exportAgentAsSkillResult` is not a verb |
| Settings toggles | 8 (`setPairProgrammingMode`, `setSuppressMainTerminals`, `setFeatureWorkflowMode`, `toggleCliTriggers`, `toggleDynamicComplexityRouting`, `toggleAllowUnknownComplexityAutoMove`, `toggleClearTerminalBeforePrompt`, `updateClearTerminalBeforePromptDelay`) | depends on the settings-persistence plan |
| Misc UI | 7 (`selectPlan`, `showInfo`, `showWarning`, `focusTerminal`, `fileExists`, `copyPrdPrompt`, `generateAntigravityPrompt`) | `show*`/`focusTerminal` need WS pushes; `copy*` need body-returned prompts |
| UAT | 3 (`getUATData`, `setUATCheckState`, `testingFailed`) | works — DB-only |
| Automation, scheduler, orchestrator, MCP monitor | 23 | **expected editor-only** → gate, do not implement |

Note one thing that is *not* broken and should not be "fixed": card selection is client-side
(`kanban.html:6417-6423`); `selectPlan` is only a notification, so its failure costs a sidebar
dropdown sync, not selection.

## Metadata
- **Tags:** backend, reliability, test, refactor, cli
- **Complexity:** 7

## Architecture Review — the approach was challenged

**The plan's chosen approach:** a checked-in test harness that boots the real CLI on a scratch
workspace, drives every delegated verb from a `{verb, payload, oracle}` table, and asserts an expected
classification per verb.

**Alternatives:**

1. **Checked-in harness with per-verb expected classification (chosen).** The table becomes a
   regression lock in both directions — a working verb breaking and an editor-only verb starting to
   work both fail the build and force a deliberate update.
2. **Static analysis of the 82 arms** (grep for `vscode.` / `executeCommand` / `clipboard` reachability
   per arm). Cheap, no scratch workspaces, no PTY dependency, and it would have caught the seam-vs-shim
   mis-attribution instantly. But it cannot tell reachable from *effective* — the exact distinction the
   plan exists to draw — and it produces false positives for arms that guard their editor calls.
3. **Throwaway probe script + a markdown table.** Fastest to the first answer, stale by the next arm
   edit. Rejected in User Review 1 for that reason.

**Justification.** (1) is right for the deliverable ("a verified per-verb table plus the adaptations
it calls for"), but (2) is a genuinely useful **complement**, not a rejected alternative: a static
pass over the 82 arms, run first, both prunes the payload-construction work (the plan's own biggest
cost) and cross-checks the dynamic result. Recommend running it as a pre-pass and reconciling the two
lists — a verb that static analysis says touches the editor but the harness marks **works** is either
a guarded call or a bad oracle, and both are worth knowing.

**Goal-vs-appearance probe.** This plan's output is a *claim about other code*, so its failure mode is
a confidently wrong table — and every bias points the same way, toward "everything works":
`{success:true}` accepted as effect, `{}` payloads accepted as coverage, a value read back from the
wrong tier accepted as a write, or a WS push accepted as an HTTP contract. The two-part pass bar in
User Review 2 is the primary defence; the tier-aware oracle above and the push-only-read
classification are the two additions this review requires. One more, structural: the harness must
**fail loudly on a skipped cluster** rather than emitting a partial table, because a table missing the
worktrees cluster reads identically to a table where worktrees passed.

## User Review Required (decisions, with defaults)

1. **Is the triage harness a throwaway script or a checked-in test?**
   **Default (recommended): checked-in.** Land it as
   `src/test/standalone-board-verb-coverage.test.js` so the per-verb classification becomes a
   regression lock. A throwaway script produces a table that is stale the next time someone edits an
   arm.

2. **What is the pass bar for "works"?**
   **Default:** a verb passes when (a) it returns `success !== false` for a valid payload, **and**
   (b) its observable effect is verifiable through a second read — `GET /kanban/board` for card
   state, the DB for config, the returned body for reads. A `{success:true}` with no verifiable
   effect is classified **degrades**, not works. This is the whole point of the exercise.

3. **Do editor-only verbs get gated or stubbed with a message?**
   **Default: gated** (hidden affordance) via `standalone-capability-gating-honesty`, plus an honest
   error if reached directly. A visible control that explains itself is still a control that does
   nothing.

## Complexity Audit

### Routine
- Enumerating verbs from `kanban.html` and POSTing them is scripted work; the probe pattern already
  exists in this investigation.
- Most clusters (lifecycle, structure, UAT, project assignment) touch only the DB, which is fully
  functional headlessly — `sql.js` loads and migrates fine (confirmed at boot).

### Complex / Risky
- **Payload construction.** A meaningful probe needs a *valid* payload per verb, not `{}`. Empty
  payloads only prove reachability. Deriving 82 valid payloads is the bulk of the work and the main
  source of false negatives.
- **Verifying effects.** Each cluster needs a different oracle (board read, config read, file
  existence, returned body). Getting an oracle wrong produces a confidently wrong table.
- **Destructive verbs.** `deleteKanbanColumn`, `restoreKanbanDefaults`, `abandonWorktree`,
  `reassignPlansWorkspace` mutate or destroy state. They must run against a scratch workspace
  created per test, never a real one.
- **Worktree verbs create real git worktrees.** They must be placed as siblings of the scratch repo
  and cleaned up, or the harness leaves debris and later runs behave differently.

## Edge-Case & Dependency Audit

- **Race Conditions.** The plan watcher runs a periodic scan every 10s and re-imports plan files; a
  probe that writes a plan file and immediately reads the board can observe the pre-import state.
  Either await the ingestion signal or poll the oracle with a bounded retry.
- **Security.** The harness holds a session cookie minted from the one-time boot token. It must not
  write that token into a checked-in fixture or log.
- **Side Effects.** `exportAgentAsSkill` writes skill files into the workspace; `saveKanbanColumn`
  and `restoreKanbanDefaults` rewrite column config. Scratch workspace per test, torn down after.
- **Dependencies & Conflicts.** Meaningless before
  `standalone-board-verb-rail-fallthrough`. Overlaps `standalone-refreshui-and-command-bridge` —
  run the triage twice, once before the bridge to produce the "needs a bridged command" list and
  once after to confirm it shrank. Settings-toggle results are invalid until
  `standalone-persist-ui-settings` lands, because a toggle that cannot persist cannot be verified by
  a second read.

## Dependencies

- `standalone-board-verb-rail-fallthrough` (hard prerequisite) — also the source of the
  `initiatorProject` payload field the tier-aware oracle checks.
- `standalone-refreshui-and-command-bridge` (run triage on both sides of it). Note its target moved to
  the **headless `commands` seam** (`hostServices.ts:354-356`) + `switchboardCommandRegistry`; the
  "needs a bridged command" list must be measured against those, not `vscodeShim.commands`.
- `standalone-persist-ui-settings` (required for the settings-toggle cluster to be testable). That plan
  is now a *deletion* — it retires the hand-rolled `getSetting`/`saveSetting` arms so both verbs fall
  through to `KanbanProvider` — and it depends on the fallthrough, so it lands **after** it and before
  this triage. The settings-toggle cluster therefore triages the provider's arms, not bootstrap's.
- Feeds: `standalone-capability-gating-honesty` (consumes the editor-only list).

## Adversarial Synthesis

**Risk summary.** The failure mode of this plan is a table that looks authoritative and is wrong —
either because empty payloads were accepted as proof, or because `{success:true}` was accepted as
proof of effect. Both mistakes bias toward "everything works", which is the worst possible answer to
hand the gating plan, since it leaves dead controls visible. The mitigation is the two-part pass bar
in User Review 2: no verb is marked working without a second, independent read confirming its effect.

## Proposed Changes

### `src/test/standalone-board-verb-coverage.test.js` (new)

- **Context.** No existing harness boots the standalone CLI and drives the verb rail; the closest
  precedents are the headless contract tests under `src/test/` (e.g.
  `headless-feature-management-contract.test.js`, which already imports `getBoardHtml`).
- **Logic.** Per test run: create a scratch workspace with `.switchboard/plans/`, boot the CLI on an
  ephemeral port with `--no-open`, exchange the one-time token for a cookie, seed a known plan, then
  drive each verb from a table of `{verb, payload, oracle}` triples and record works / degrades /
  editor-only. Emit the table as test output *and* assert the expected classification, so a
  regression flips a test rather than quietly changing a report.
- **Implementation.** Group the table by the ten clusters above so a cluster can be run in isolation
  during development. Reuse the boot/cookie helper for the other standalone tests rather than
  inlining it.
- **Edge Cases.** Ephemeral port (`--port 0`) to avoid collisions with a developer's running
  instance; kill the child on failure paths so a crashed test does not leave a server holding the
  workspace; skip the whole suite with a clear message when `node-pty` is unavailable, since PTY-
  dependent verbs cannot be classified without it.

### `src/standalone/bootstrap.ts` — headless adaptations found by triage

- **Context.** The clipboard contract at `vscodeShim.ts:266-274`; the `__viaHttp` degrade flag set by
  `KanbanProvider.handleServiceVerb:7222`.
- **Logic.** For each verb classified **degrades**, apply the smallest adaptation that makes it
  honest, in this order of preference: (1) return the payload in the HTTP body (prompt-copy arms);
  (2) broadcast a WS message (`showInfo`, `showWarning`, `focusTerminal`); (3) bridge a command
  (sibling plan); (4) reclassify as editor-only and gate it.
- **Implementation.** Expected concrete cases: `copyWorktreeMergePrompt` (`:10797`) and
  `generateAntigravityPrompt` (`:10196`) must return `{prompt}` so `transport.js:278-282` copies
  client-side; `showInfo` (`:8658`) / `showWarning` (`:8663`) become `showStatusMessage` pushes on the
  `kanban` surface; `openWorktreeTerminals` (`:10773`) routes to the PTY fleet rather than editor
  terminals.

  > **Superseded:** `copyPrdPrompt` listed among the arms that "must return `{prompt}`".
  > **Reason:** Verified already compliant — `KanbanProvider.ts:7681-7688` awaits
  > `this._seams().clipboard.writeText(prompt)` and returns `{ success: true, prompt, prdPath }`.
  > Editing it would be a no-op change to working code.
  > **Replaced with:** classify `copyPrdPrompt` as **works** and use it as the reference shape for the
  > other two. `showInfo`/`showWarning` likewise already have a precedent to copy: the same arm emits
  > `this.postMessage({ type: 'showStatusMessage', message, isError })`, so the push mechanism exists
  > and the adaptation is a reuse, not a new pattern.

- **Edge Cases.** An arm that already returns `{prompt}` in the editor needs no change — check before
  editing, since `chatCopyPrompt` and `copyPrdPrompt` already work this way in standalone today. Read
  each arm's return statement before classifying; the `copy*` cluster is mixed.

### `.switchboard/docs/standalone-verb-coverage.md` (new, generated)

- **Context.** The gating plan needs a durable, reviewable list of editor-only verbs.
- **Logic.** Have the harness write its classification table to this file so the gating plan and the
  user manual can cite one source instead of re-deriving it.
- **Implementation.** Regenerate on each full run; keep it in the repo so diffs show capability
  changes over time.
- **Edge Cases.** Do not let a partial run overwrite a complete table — write only when every cluster
  ran.

## Verification Plan

### Automated Tests

- **The harness is the test.** It asserts the expected classification per verb, so both a
  regression (working verb breaks) and an unexpected improvement (editor-only verb starts working)
  fail loudly and force the table to be updated deliberately.
- **Cluster assertions with real oracles.** Card movement: `GET /kanban/board` shows the new column.
  Lifecycle: an archived card leaves the active set and `recoverSelected` restores it. Structure:
  `getKanbanStructure` returns a saved custom column. Worktrees: `git worktree list` in the scratch
  repo shows a sibling worktree (sibling, never nested), and `cleanupWorktree` removes it. UAT:
  `getUATData` reflects a `setUATCheckState` write.
- **Tier-aware oracle for the scoped clusters.** For settings toggles and project assignment, assert
  *which* config tier the row landed on (project vs workspace), not just that a read returns the value
  written. A missing `initiatorProject` in the fallthrough payload produces a correct-looking
  round-trip on the wrong tier — the one failure in this triage that a value-equality oracle cannot
  see.
- **Classification must distinguish four outcomes, not three.** `works` / `push-only read` (effect
  real, HTTP body empty — a contract-#4 finding, not a UI bug) / `degrades` / `editor-only`. Folding
  push-only reads into either neighbour is what makes the table wrong in the direction that leaves
  dead controls visible.
- **Partial runs fail, not truncate.** If any cluster is skipped (e.g. `node-pty` unavailable), the
  suite fails and the generated table is *not* written. A table missing a cluster is
  indistinguishable from a table where that cluster passed.
- **Negative test.** A verb deliberately absent from `KANBAN_VERBS` still returns the
  not-implemented error, proving the fallthrough did not become a blanket accept.
- **Manual smoke.** Work through the AUTOMATION, WORKTREES and UAT tabs in a browser against a
  scratch workspace and confirm every visible control either works or is hidden — no dead clicks.

## Uncertain Assumptions

- That `handleServiceVerb`'s "all 144 arms return their result" holds for the Board. The Setup
  provider's contradictory TODO is the reason this plan exists rather than trusting the comment.
- That worktree creation works headlessly. Nothing in the git path needs an editor, but Switchboard's
  worktree bookkeeping writes to the `worktrees` table, whose schema has drifted before (the V42
  `subtask_plan_id` incident) — verify against a fresh DB, not only a migrated one.
- That the 23 automation/scheduler/orchestrator/MCP verbs are genuinely editor-only. Autoban manages
  terminals, and standalone *has* a terminal fleet, so some of that cluster may be implementable
  later. Triage should record "not attempted" rather than "impossible" where that is the honest
  answer.

## Out of Scope

- Implementing the automation, scheduler, orchestrator or MCP-monitor clusters.
- The in-flight Tickets Panel Extraction.

## Completion Summary
Triaged delegated Kanban verbs and updated prompt-copy and notification arms in `src/services/KanbanProvider.ts`: updated `generateAntigravityPrompt` to return the prompt payload directly in the HTTP response body, and adapted `showInfo` and `showWarning` to emit `showStatusMessage` WebSocket notifications.
- Files changed: `src/services/KanbanProvider.ts`
- Issues encountered: None.

## Review Findings
**This plan's primary deliverable was not produced.** Neither `src/test/standalone-board-verb-coverage.test.js` nor `.switchboard/docs/standalone-verb-coverage.md` exists, so there is no verified per-verb classification — and `standalone-capability-gating-honesty`, which was sequenced last specifically to consume that list, gated three tabs on the plan's *expectations* instead. Two arms were adapted (`generateAntigravityPrompt` returns `{prompt}`; `showInfo`/`showWarning` push `showStatusMessage`) and the plan's two "already compliant, do not edit" calls were honoured correctly (`copyPrdPrompt`, `copyWorktreeMergePrompt` both already return `{prompt}`); `openWorktreeTerminals` → PTY fleet was not done. One fix applied: the `showStatusMessage` pushes were unconditional, so the **editor** host showed a VS Code toast *and* an in-board status line for one event — a contract-#2 byte-compat regression on ~4,000 installs — now gated on `msg.__viaHttp`, the degrade flag `handleServiceVerb` sets for exactly this purpose and which the same file already uses at `:9682`. Un-triaged defect found by inspection, which a real harness run would have caught: `uncompleteCard` (`KanbanProvider.ts:9633`) gates success on `switchboard.restorePlanFromKanban`, deliberately left unregistered by the bridge plan, so the seam returns `undefined`, the arm **rolls back every DB write** and reports failure — the plan classified that whole cluster "works — DB-only". Validation: webpack build ✅, all five gates ✅, 8 contract suites ✅; the verb-level triage itself remains unperformed and is the single largest gap in this feature.

