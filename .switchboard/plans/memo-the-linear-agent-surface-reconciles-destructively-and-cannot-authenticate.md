# The Linear Agent Surface Reconciles Destructively, Never Ends a Session, and Cannot Authenticate at All

## Goal

The Linear integration that landed in `e5086a75` must stop deleting work a human did in Linear, must end what it starts, and must be reachable — today the OAuth flow refuses on a default-empty client id, so the whole agent surface is unusable.

### Problem analysis

Nine reviewer findings from `.switchboard/memo.md`, all on the commit that landed the Linear agent surface, all verified against HEAD, and **none owned by any active board card**. They are filed together because one of them gates three others.

The through-line is a reconciler written as if Switchboard were the only writer. Linear is a collaborative tool; people draw relations and assign issues by hand, and the reconcile pass treats anything it did not create as drift to be removed.

## Metadata

- **Complexity:** 6
- **Tags:** integrations, linear, data-loss, bugfix

## User Review Required

Change 6 is an author decision the original plan left open. The rest are defects.

## Proposed Changes

### 1. Relation reconcile deletes hand-drawn links, with no provenance

`LinearSyncService.ts:4091-4105` deletes any `blocks` relation where `managedIssueIds.has(rel.blockedIssueId)` and no matching desired edge exists in `plan_dependencies`. Nothing distinguishes a relation Switchboard created from one a person drew in Linear.

A user who links two issues by hand loses that link on the next poll, silently.

### 2. Milestone membership reconcile has the same shape

`LinearSyncService.ts:3976-3985` iterates `existingIssueIdsInMilestone` and calls `updateIssueMilestone(existingId, null)` for anything absent from the mission member set. An issue placed in the milestone by hand is unassigned on the next poll.

**Changes 1 and 2 share one fix**: a provenance record, sitting alongside `mission_milestones` (V66), of which relations and memberships Switchboard created. Reconcile only over its own. Take the next free migration version at implementation time; do not reserve one.

### 3. An ended mission leaves a live milestone

`deleteMissionMilestone` is defined at `KanbanDatabase.ts:11838` and called nowhere in `src/`. `updateProjectMilestone`'s input type (`LinearSyncService.ts:3716`) accepts only name, description, target date and sort order, so there is no completion field to set even if something wanted to.

Missions accumulate milestones in Linear with nothing ever closing them.

### 4. Assigned-issue polling has no scope and no claim

`LinearRemoteProvider.ts:381-393` loops `fetchAssignedIssues()` and imports anything lacking a `findPlanByLinearIssueId` row. There is no project, team or board filter, and no cross-host claim mechanism.

An issue delegated to the app actor anywhere in the workspace creates a local plan, and two machines running Switchboard both import it.

### 5. Agent sessions are never invalidated, and the narration has no callers

`_agentSessionsByIssue` (`LinearSyncService.ts:4122`) has exactly one write (`:4284`) and one read (`:4319`) — no expiry, no delete, no re-check of session state. A session ended in Linear is posted into until the process restarts.

Its counterpart: `postAgentActivity` is defined at `LinearSyncService.ts:4327` and `LinearRemoteProvider.ts:475` and declared optional on `RemoteProvider.ts:204`, and a repo-wide grep finds only the definitions and the internal delegation. **No dispatch or lifecycle path calls it.** The plumbing for narrating agent activity was built and never connected.

One card: session lifecycle, covering both invalidation and the emit sites.

### 6. Team-destination write-back invents a completion definition **[decision]**

`LinearAutomationService.ts:743-747` — when a rule has no `finalColumn` and its destination is a team, completion is hardcoded to `col === 'DONE' || col === 'COMPLETED'`. The originating plan explicitly left "what counts as complete when the worker is a team" undecided, and the code answered it silently.

Decide it, and make the answer visible in configuration rather than in a literal.

### 7. Nothing can authenticate — and this gates everything above

`package.json:209-211` declares `switchboard.linear.oauthClientId` with `"default": ""`, and `LinearSyncService.ts:85` and `:94` read it and refuse, telling the operator to register an app. No app is registered.

**This is the ordering constraint for the whole feature.** Changes 4, 5 and 6 describe behaviour that cannot currently run. Either register the app and ship the id, or state plainly that the agent surface is unavailable and gate the UI on it, so it is not a silent dead end.

### 8. The Linear integration suite is red and fail-fasts the runner

`npm run test:integration:linear` fails at `linear-sync-service.test.js:149` with the harness logging "Database file does not exist (not auto-creating)", and the runner stops there — so `test:integration:all` never reaches any Linear suite.

Same root cause as the dark-control-plane-tests card in *Gates that mean something*, but a different file set. State the dependency rather than merging; that card is scoped to three named control-plane files and would not fix this.

## Verification Plan

1. Draw a `blocks` relation by hand between two managed issues. It survives a poll.
2. Assign an issue to a mission milestone by hand. It survives a poll.
3. End a mission. Its milestone is closed or removed, and `deleteMissionMilestone` has a caller.
4. An issue assigned to the app actor outside the mapped project does not create a local plan; two hosts do not both import the same issue.
5. A session ended in Linear stops receiving posts without a restart, and `postAgentActivity` has at least one lifecycle caller.
6. Team-destination completion reads a configured value; `grep -n "'DONE'" src/services/LinearAutomationService.ts` finds no hardcoded pair.
7. With no OAuth app registered, the agent surface reports itself unavailable rather than failing per action.
8. `npm run test:integration:linear` runs to completion, and `test:integration:all` reaches the suites after it.
