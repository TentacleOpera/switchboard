# Board Collapse 08 — Create Five Features From Loose Plans

## Goal

Gather five clusters of loose plans — each of which is one problem designed several times — into five features with a stated landing order, and remove the feature shells left empty by earlier subtasks.

### Problem analysis

Thirty-odd loose plans on the board are not independent work. Eight of them describe one seat lifecycle; four describe one prompt-delivery problem; eight rewrite the same `/switchboard` workflow file; eight touch one memo file; four restructure one dock. Because each was authored as a separate symptom, no file states the order, and two pairs propose the same edit twice.

This subtask is deliberately last of the decision work: it needs the surviving card set settled by Board Collapse 01 through 06, because a feature must be created from cards that will still exist.

## Execution rules

1. Feature creation and membership go through `.agents/skills/kanban_operations/create-feature.js`, `assign-to-feature.js` and `remove-from-feature.js`, or the board. **Never SQL.**
2. **Order matters:** create the new feature and assign its members *before* removing an emptied feature, so no subtask is ever orphaned.
3. Per the column rule, a feature and its subtasks share one column. Create each feature in the column its members already occupy; where members differ, use the least-advanced.
4. **No git working-tree operation** while this runs. Commits are fine.
5. Do not touch `src/`.

## Metadata

- **Complexity:** 6
- **Tags:** board-hygiene, features, sequencing

## Proposed Changes

### 1. Feature: A seat is released when its work is accepted

Nine cards, currently eight loose plans plus two re-homed by decision 8 and 9. Landing order:

1. *An idempotent completion skips the clear, so a seat that reported its own done is never stood down* — separates the write from its consequences.
2. *A column move orphans the dispatch holder* (rescoped to the server-side release fix) — repairs 571 measured stranded rows.
3. *The lead's acceptance post is the only thing that releases a seat, and it silently releases nothing* — surfaces `cleared:false`.
4. *A feature dispatch seats exactly one lead — make it an invariant, not an outcome*.
5. *The dispatch curtain is armed from intent, not from a clear that actually runs*.
6. *The after-clear standing-orders block is a task-less prompt*.
7. *Status panes render an empty model — nothing records what a seat is working on*.
8. *Team lead escalation must exhaust cheap recovery* (the single recovery ladder, per decision 9).
9. *Completion Directive Becomes a Standing Order* — last, per decision 8.

Note in the feature file that *Status panes* records this cluster as one class: a seat given work must have a holder whatever route the work took.

### 2. Feature: Prompt delivery is patient

Four cards. Prerequisite outside the feature: *Two stores hold agent startup commands* must land first, because it supplies the command provenance the family re-derivation reads.

1. *A seat's CLI family is derived once at spawn and frozen* — owns the `clearReadiness.ts` unknown-arm change (unknown takes the longest, Devin, constants).
2. *Prompt delivery should be patient, not precise* — keeps the per-delivery floor and the awaitable orientation relay; **delete its duplicate edit** of the same unknown arm, which the sibling owns.
3. *A delay setting must not be able to defeat known-CLI readiness detection*.
4. *Explain the seat-clear session-restart toll where seat CLIs are configured*.

### 3. Feature: The /switchboard front door

Eight cards across four features today. Landing order:

1. *`/switchboard` accepts any board on the shared port and adopts the wrong workspace* — merge *Orchestrator adopt call drops workspaceRoot* into it; both fix the adopt call's workspace scoping and both edit the same workflow file.
2. The merged liveness plan from Board Collapse 09 (dead versus wedged).
3. *The /switchboard front door arms against an endpoint that does not exist*.
4. *Replace the Mission Control persona with a run sheet* (carrying the recovery rung from decision 9).
5. *Make standalone the first-class entry point*.
6. One CLI menu plan merging *Split the CLI Front-Door Menu into GUI and CLI Branches* with the navigable-console work whose refactor half is already Completed.

Then: remove feature *The Launcher Must Know It Is The Right Board, And A Live One*, and feature *Two Endpoint Corrections* — its other subtask, *Terminal Buffer Snapshot API*, detaches to a loose plan in Planned. *Mission Control* keeps the ready flag and the supervision subtask. *Standalone Distribution* keeps npm publish and attach.

### 4. Feature: Memo

Eight cards across four features. Landing order:

1. *The memo modal never updates in standalone, because only one host watches the file* — the watcher re-arm.
2. One merged plan creating `src/services/memoFile.ts` with both the append verb and the prefix-consume: merge *Reviewer Risks Reach the Memo Through a Sentence* and *Process Memo Clears the Whole File but Only Ever Read the Panel's Copy of It*. All three memo subtasks currently propose creating that same module with a "whichever lands first creates it" rule, which is a merge hazard; one plan creates it.
3. *The Memo Panel Protects Your Typing by Throwing Away Everything an Agent Appended* — the dirty guard, on top of that module.
4. The three geometry fixes: close-button overlap, dead space below the memo, dismiss after Copy Prompt.
5. *Memo Is the One Surface That Exists Only in the Cramped Column — Give It an Editor Tab* — last, with a note that the parent-posting behaviour added by the dismiss and dead-space plans is a no-op in an editor tab, where the frame is its own parent.

Then remove features *Memo modal geometry in the shell modal host* and *The Memo File Is a Shared Append Target*.

### 5. Feature: The dock

Four cards. Verified at HEAD: `shell.html` still has two dock tabs, Agent and Kanban, so nothing here has landed.

1. *A dock frame does not know it is a dock*.
2. *The agent dock becomes three tabs — Agent, CLI, Fleet* — fold in the loose *The Agent Dock Opens Below The Top-Right Cluster Instead Of Displacing It*, rewriting its collision analysis against three tabs rather than the two it currently assumes.
3. *Extract the terminal viewport out of the 13,000-line Terminals panel*.
4. *The dock becomes its own document — one `/dock` page, three tabs, one iframe*.

Then remove features *The dock is contained and becomes three tabs* and *The dock stops being the Terminals panel*.

## Verification Plan

- Five features exist, each with the subtasks listed above and a Dependencies section stating the landing order.
- Every subtask's column equals its feature's column.
- For each removed feature, `GET /kanban/plans` shows zero cards still carrying its `featureId`; no orphans.
- No card appears in two features.
- Feature files list exactly the subtasks the database links to them (run `reconcile-features.js` and confirm it reports no drift).
- `git status` shows only `.switchboard/` changes.
