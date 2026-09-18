# Board Collapse 09 — Consolidate the Test Gates and the Remaining Clusters

## Goal

Reduce six overlapping test-gate features to two, and settle the five smaller clusters: multi-agent planning, liveness and CPU, terminals.js contention, and four duplicated pairs.

### Problem analysis

**Test gates.** Nineteen subtasks across six features are trying to make CI mean something, and they overlap heavily. Two subtasks of *Red contract gate triage* fix the same two gates with the same code. Both subtasks of *Red gate triage at HEAD* fix the same mirror drift, and the second says so. The source-regex pin audit appears in four different cards. The `seat-safeguards` gate is claimed by three cards carrying three different measurements: one says it pins 7 call sites with 2 composed and must not be re-baselined, another says it asserts 7 but finds 12 and should be left alone, a third lists it among 15 suites to fix.

**Liveness.** Three filesystem artefacts — the port file, a heartbeat file and a unix socket — answer one question. Two plans call each other complementary while both editing the same region of the standalone bootstrap.

**Measure before optimising.** Four terminal-stream optimisation plans propose changes whose value is unmeasured, while a fifth plan exists specifically to measure them and records a machine freeze that disconfirms one of their premises.

**terminals.js.** About 25 cards in ten features edit one 13,000-line file. The viewport extraction moves roughly 1,700 lines by cited line range, so any small plan landing on either side of it invalidates the ranges.

## Execution rules

1. Card operations go through the board or `.agents/skills/kanban_operations/*.js`. **Never SQL.**
2. Create features and assign members before removing an emptied feature.
3. **No git working-tree operation** while this runs. Commits are fine.
4. Do not touch `src/`.

## Metadata

- **Complexity:** 6
- **Tags:** board-hygiene, ci, tests, terminals

## Proposed Changes

### 1. Test gates: six features to two

**Feature: Red at HEAD.** One deduplicated list of what is actually failing, in this order: `staging-column`, `feature-file-subtask-link`, the two control-plane test harness failures (`control-plane-migration.test.js:324`, `control-plane-repo-scope.test.js:152`), `seat-safeguards`, then the remaining suites blocking the integration-tests job.

- Delete *Triage four red contract gates at HEAD* — a near-duplicate of *Triage remaining red contract gates*, same two gates, same `viaDirectFile` fix.
- Delete *Triage three red checks at clean HEAD* — its own text notes the overlap with *Triage five red gates at HEAD*.
- The `mirror:check` item disappears from every triage card; Board Collapse 02 removed the gate.
- **One owner for `seat-safeguards`:** *Two reviewer→coder relays pass `promptComposed: true`* owns that gate's count and re-pins it after fixing the mis-binned site. The other two cards must state that they do not touch it. Its inventory grows by one if the remote-dispatch seam lands, so cross-reference that.

**Feature: Gates that mean something.** The reachability ratchet, the source-span helper, the pin-behaviour sweep, the composition-root parity gate (which inherits the option-supply assertion from the card Board Collapse 01 deleted), the dark control-plane test wiring, the BDD runner, the `kanbanColumnDerivation` fix, and the `vscode-test` local launch fix.

- Delete *Audit source-pin regexes for first-clause anchoring false-reds* — duplicate of *Source-Regex Test Assertions Must Pin Behaviour, Not Spelling*, which carries a mutation-validation rule the other lacks.
- Sequence: the source-span helper lands **last** among the test-file changes, because it migrates files the triage cards own.
- Note the shared contention: five or more cards add a `test:contract:*` script to `package.json` and a step to `integration-tests.yml`.

Then remove the emptied feature shells among *Red contract gate triage*, *Red gate triage at HEAD*, *CI Gates That Fail For the Right Reason*, *Every test file runs, and a red test is visible* and *The Test Gates Tell the Truth*, folding survivors into the two new features.

### 2. Multi-agent planning: two features to one

- Keep *The multi-agent planning team plans as a team* as the surviving feature.
- Merge in *Multi-Agent Planning 02 — Divergence Map* and *03 — Adjudication Round* as follow-on subtasks.
- Delete *Multi-Agent Planning 01 — Fan-In Dispatch*. The fan-out head prompt in the surviving feature does the same job through the shipped team mechanism, and 01's investigators are coder-role seats the standing-order work would wrongly reach.
- Remove the emptied *Multi-Agent Planning Runs* feature.

### 3. Liveness, and measure before optimising

- **Merge** *Sandbox-Surviving Board Liveness via a Unix Domain Socket* and *A detached board can spin at 100% CPU holding its port* into one plan: the launcher can distinguish dead from alive-but-not-serving. Both already call each other complementary and both edit the same bootstrap region. The merged plan supplies the liveness step of the front-door feature in Board Collapse 08.
- Correct the merged plan's framing: *Attribute Switchboard's CPU before optimising it* records a freeze observed in attached mode, which disconfirms the wedged plan's detach-specific premise. Also pull forward the `stop` ungating, which that plan notes has not shipped.
- *Attribute Switchboard's CPU before optimising it* lands **before** any terminal-stream optimisation. Move to Backlog until it has: *A keystroke echo waits on two frame boundaries it does not need* and *An idle seat that animates its cursor bills every viewer a frame twelve times a second*.
- *A terminal you cannot see keeps streaming* stays in Planned; Board Collapse 01 rescoped it to the one remaining predicate.

### 4. terminals.js: a landing rule, not a merge

- Write into the viewport-extraction plan: **every small terminals plan lands before the extraction**, and the extraction re-cites its line ranges at coding time rather than trusting those in the file. Its own section map is already noted as stale.
- **Merge** the two pane-header plans — *The Terminal Pane Header Shows the CLI Brand and the Handle, But No Longer Shows the Agent Role* and *A Team Lead's Terminal Header Names The Feature It Was Dispatched* — into one plan about what a pane header shows.
- ~~Re-link the missing fourth subtask~~ **CORRECTED 2026-09-04 during execution.** `b48afe52` is **not orphaned**: it carries this feature's id and always has. It sits in **Coder Coded** because it has been worked, which is why it fell outside the New-and-Planned survey and looked absent. Nothing to re-link. The feature is left column-mixed on purpose — dragging a coded card back to Planned to satisfy containment would destroy real progress, and containment exists to stop a feature being *formed* mixed, not to undo work in flight. Recorded in the feature file.

### 5. The smaller pairs

- **Copy feedback.** Merge *Copy-prompt button "copied" feedback fires late and flashes green* with *Copy Dispatch Prompt must not flash "Copied!" on every card's coder-prompt button* into one plan on the copy-prompt handler.
- **Ticket images.** Create feature **Tickets images** from *Tickets Panel: Inline Images Are Blank On First View* and *Refetch Leaves Inline Images Blank Until Second Click*, currently in two different tickets features.
- **Embedded ticket subtasks.** *Replace embedded subtask content with file references* wins. *Prune Deleted Subtasks From A Ticket's Embedded Checklist* becomes its migration-strip step. *Reconcile and Delete Stale Local Ticket Markdown Files* gains a cross-reference so its deletion probe skips the subtask files the replace plan creates.
- **Star and priority.** A star is a boolean; priority is a level. *The CLI is a peer control surface* and *Board control instructions* each define a bare `star` action that cannot express what *Agents can set a card's priority level* adds to the same endpoint. Add the level argument to both, and reconcile their two different line citations for the same handler.

## Verification Plan

- Two test-gate features exist; the other four shells are gone with no orphaned subtasks.
- Exactly one active plan claims the `seat-safeguards` gate; the other two state that they do not touch it.
- No active plan names `mirror:check` as a gate to repair.
- One active plan covers board liveness; the CPU attribution plan precedes the two parked optimisation plans, which sit in `BACKLOG`.
- The viewport-extraction plan states the landing rule; one plan covers the pane header; `b48afe52` is linked to its feature and shares its column.
- `reconcile-features.js` reports no drift between feature files and database links.
- `git status` shows only `.switchboard/` changes.
