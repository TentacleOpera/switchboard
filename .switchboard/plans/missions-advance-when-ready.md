# A Mission Advances To Its Next Member When The Held One Completes

## Goal

Give a mission an **advance-when-ready** mode: when the member it is holding is declared
complete, the mission immediately dispatches its next member, instead of waiting for an
operator to press Launch again. One launch runs the whole mission, member by member, at the
pace the agents actually finish.

### The problem, and the root cause

`launchMission` (`KanbanProvider.ts:14487`) dispatches exactly one item and returns. It
resolves a coding head, calls `apiServer.dispatchNextFromQueue({ workspaceRoot, from:
headTerminal })`, refreshes the board, and stops. A mission with five members therefore
needs five Launch presses, each one timed by the operator noticing that the previous member
finished.

Nothing re-dispatches, because nothing is watching for the finish. `mission.runState` is
**derived** from member state rather than stored — `in-flight` means some member has
`dispatched_at` and no `completed_at` — so the transition out of `in-flight` happens as a
side effect of a `completed_at` write in a completely different code path
(`POST /kanban/task/complete`) with no notification. `mcStopMission`
(`KanbanProvider.ts:9989`) shows the same derivation from the other side: it stops a mission
by clearing the holder, not by writing a status.

The root cause is that missions were built as a manual dispatch primitive on top of the
queue, at a time when repeated dispatch was the queue schedule's job. With the queue
schedule retired (`retire-autoban-and-batch-size.md`), nothing advances work
automatically at all — and the shape for saying a mission *should* advance itself already
exists, unused: `MissionRunConfig { missionId, flavour: 'unattended' | 'operations' }`
(`autobanState.ts:121-126`) with `normalizeMissionRunConfig` (`:153`). Both are defined and
unit-tested with **zero production consumers**.

## Metadata
- **Complexity:** 5
- **Tags:** backend, api, feature, reliability

## No migration

Clean break. `MissionRunConfig` has never had a production writer, so there is no persisted
value to preserve and no legacy shape to accept. CLAUDE.md's migration rule is waived for
this release.

## Scope: both composition roots

The trigger lives in `LocalApiServer`'s completion handler (shared), but the dispatch it
calls reaches out through `this._apiServer.dispatchNextFromQueue` and mission reads go
through `KanbanProvider`. If auto-advance is added as an option hook on
`LocalApiServerOptions`, it must be wired in **both** `TaskViewerProvider.ts` and
`bootstrap.ts`. An unwired `Promise`-returning hook is indistinguishable from a working one
— that is the precedent CLAUDE.md records for the four queue seams. Missions are reachable
in standalone today, so an extension-only wiring means the feature silently does nothing
for every npx user.

## Implementation

1. **Give `MissionRunConfig` a writer and a home.** It needs to be readable per mission at
   completion time. Two options — decide and comment the choice:
   - a column on the `missions` table (`KanbanDatabase.ts:638` — the table already carries
     `ready`, `team`, `max_extra_worktrees`), or
   - the existing `MissionRunConfig` blob keyed by `missionId`.
   The table column is preferred: mission run mode is mission data, and reading it in the
   completion path is then one query against a row already being resolved.
2. **The trigger is the completion post, after the commit.** In
   `_handleKanbanTaskComplete` (`LocalApiServer.ts:2364`), once `completed_at` is written
   and the response is ready, resolve whether the completed plan is a member of a mission in
   advance-when-ready mode, and if so dispatch its next member.
   - **After the write, never before.** `completed_at` is what frees the team; dispatching
     before that commit lands means the in-flight scan still sees the team holding work and
     the dispatch 409s.
   - **Not from a client event.** A fleet poll or webview relay noticing the state change can
     beat the commit. The handler is the only place that knows the write happened.
3. **Readiness is "the mission left in-flight", not "a completion arrived".** A mission can
   hold more than one member, and the in-flight scan deliberately checks every candidate
   rather than stopping at the first (`LocalApiServer.ts:1936`). Re-derive `runState` after
   the write and advance only when it is no longer `in-flight`. Reuse the extracted in-flight
   helper from `team-dispatched-state-reaches-the-rail.md` rather than writing a second
   predicate — one definition of in-flight, three consumers.
4. **Advance by calling the same path Launch calls.** `dispatchNextFromQueue({ workspaceRoot,
   from: headTerminal })`, with the head resolved the same way `launchMission` resolves it
   (`resolveCodingHeadFromGroups`, falling back to `getAliveCodingTerminalNames`). This is
   deliberate reuse, not convenience: that path already goes through `_queueNextChain`
   (`LocalApiServer.ts:61`), which serialises select → in-flight check → dispatch across
   *every* caller, and it already honours `terminal.clearBeforePromptDelay` — the clear
   settles before the prompt is sent (`TaskViewerProvider.ts:6518`, `:22160`). **Do not build
   a second dispatch path**; a shortcut loses both the serialisation and the clear delay.
5. **Refuse rather than loop.** If the dispatch is refused, record the reason and stop
   advancing that mission. Do not retry on a timer — the whole point of this mode is that
   completion is the clock. A refusal is a condition the operator needs to see, not one to
   spin on.
6. **Surface the mode in the Mission Control panel** beside the mission's existing controls,
   and show when a mission is auto-advancing versus waiting for a Launch press.

## Edge cases

- **The last member.** When the completed member is the mission's last, the mission is done
  — do not attempt a dispatch that will find nothing, and do not leave the mission reading
  as in-flight. `runState === 'completed'` is already derived; let it be.
- **Completion-post idempotency.** The endpoint is explicitly idempotent: *"a repeat call
  with the same `planId` returns the existing record without re-writing `completed_at`"*
  (`LocalApiServer.ts:2358`). A repeat call must therefore **not** advance a second time.
  Gate the advance on the write having actually happened, not on the handler having been
  reached — leads do post twice.
- **A documented invariant changes here.** The same contract block says *"No dispatch, no
  column move."* This makes completion trigger a dispatch. That is deliberate, and it must
  stay gated on the mission's opt-in mode so a completion outside advance-when-ready behaves
  exactly as it does today. Update the contract comment; leaving it stale is worse than the
  change.
- **`mcStopMission` mid-flight.** Stop clears the holder via `releaseDispatchHolder` without
  a completion post, so the mission leaves `in-flight` without passing through the trigger.
  Correct — stop must not advance. Confirm the trigger cannot fire from a release.
- **The head terminal died between dispatch and completion.** Head resolution can return a
  different terminal than the one that was dispatched to, or nothing. No live coding
  terminal means refuse per step 5, with the same message `launchMission` uses.
- **`maxExtraWorktrees > 0`.** `launchMission` refuses outright because run provisioning is
  not built (`KanbanProvider.ts:14513`). Auto-advance must refuse identically rather than
  advancing into a tree the operator did not choose.
- **A member shared by two missions.** One `completed_at` could satisfy the readiness test
  for both. Decide explicitly — advance each mission that is now free, or refuse when
  membership is ambiguous. Advancing both is defensible; doing it accidentally is not.
- **Two missions advancing at once.** Safe by construction: both go through
  `_queueNextChain`, so the second re-reads a queue the first has drained.
- **A mission whose members are all complete before launch.** Derived `runState` is
  `completed`; the mode is inert. Do not special-case it.

## Verification plan

1. `npm run compile` clean.
2. Confirm the option hook (if used) is wired in both composition roots before testing
   behaviour — read both files.
3. A three-member mission in advance-when-ready: launch once, post completion on each member
   in turn, confirm the next dispatches each time with no operator action, and that the
   mission reads `completed` after the third.
4. The same mission **not** in advance-when-ready: launch once, post completion, confirm
   nothing dispatches — today's behaviour is unchanged.
5. Post the same completion twice; confirm exactly one advance.
6. Move a card between columns without completing it; confirm no advance (only `completed_at`
   releases).
7. A mission holding two members: complete one, confirm no advance while the other is held;
   complete the second, confirm the advance fires once.
8. `mcStopMission` mid-flight; confirm no advance.
9. Kill the coding head, then post completion; confirm a recorded refusal, no retry loop, and
   a message the operator can act on.
10. Set `maxExtraWorktrees` to 1; confirm auto-advance refuses with the same message Launch
    gives.
11. Both hosts — extension VSIX and standalone `npx`.
