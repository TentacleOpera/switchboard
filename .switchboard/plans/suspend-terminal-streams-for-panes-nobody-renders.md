# A terminal you cannot see keeps streaming, parsing and holding a renderer

## Goal

Make the rendered-slot predicate the authority over which terminals hold a live socket, so a
terminal that no pane renders is suspended and resumed from the gateway's replay ring — and the cost
of the grid scales with what is **on screen** rather than with every seat the operator has ever
opened.

> **Superseded:** *"Stop feeding pty output to terminals that are not in a rendered pane, and resume
> them from the gateway's replay ring on reattach."*
> **Reason:** the suspend/resume **mechanism** shipped in `a870fa8e` as part of
> `the-grid-renders-agents-not-terminals.md` — that plan needed it for its status panes and could not
> wait. `suspendTerminalStream` / `resumeTerminalStream` exist, are correct, and are exercised.
> **Replaced with:** the goal above. What is missing is not the mechanism but its **only real
> trigger**: today the sole caller is the status-mode branch in `updatePaneElement`, so a terminal is
> suspended when the operator asks for it and never when the grid simply stops rendering it. The
> original motivating case — narrowing a 3x3 to a single pane — still leaves eight sockets streaming.

### Problem Analysis

**The mechanism landed; the predicate did not.** `a870fa8e` added, in `terminals.js`:

- `suspendTerminalStream(entry)` — withdraws the size vote on the open socket, closes `entry.ws`
  keeping `entry.lastSeq`, clears the pending batch, releases the renderer holder, and leaves
  `entry.term` and its buffer intact.
- `resumeTerminalStream(entry)` — reattaches a renderer, reconnects through `connectTerminalSocket`
  (which appends `&lastSeq=` whenever `entry.lastSeq > 0`), and re-casts the size vote.
- `flushBatch` declines to write for a suspended entry, and `__sbTerminalStats()` reports
  `suspended` and `wsState` so a closed socket is observable from the console.

**Its only caller is the status toggle.** `grep suspendTerminalStream` returns the definition and one
call site — the `isStatusPane` branch of `updatePaneElement`. Nothing consults visibility. So every
cost this plan was written about is still paid the moment the reason is a *layout* rather than an
operator's explicit choice:

1. **The WebSocket stays open.** `renderPaneGrid` drops surplus panes with
   `paneGridEl.removeChild(paneGridEl.lastElementChild)` and the comment is explicit: the terminal
   container "goes with the subtree and is left detached … and stays referenced by `terminalsMap`".
   No suspend runs on that path.
2. **The VT parser keeps running.** `flushBatch` now guards on `entry.disposed || entry.suspended ||
   !entry.term`. A detached container is none of those, so `term.write()` keeps parsing frames into
   buffers nobody is looking at.
3. **A WebGL context stays held.** The renderer holder's `release()` is reached from teardown and
   from `suspendTerminalStream`; neither runs for a pane the layout dropped.
4. **The detach timer cannot reclaim any of it, by design.** The reconcile's trailing loop tests
   `paneAssignments.includes(name)` — a **bare** include, not a slice — and `paneAssignments` is
   padded to `getMaxSlotCount()` and deliberately never trimmed. A terminal parked in slot 5 while
   the layout is `1` is therefore still *assigned*, takes the `cancelDetachTimer` branch, and keeps
   its `.active` class. That padding is correct and must stay; it simply means the assignment array
   cannot answer "is anyone looking at this".

**And the mechanism now has two potential drivers of one flag.** `entry.suspended` is a bare boolean
with no record of *why* it is set. Once a visibility predicate can also set it, "the operator turned
this pane's output off" and "the layout stopped rendering this pane" become indistinguishable — and
the pane that comes back on screen while still in status mode would have its socket silently
reopened by the very predicate meant to close sockets. That is this codebase's standing hazard in its
usual shape: one value, two causes, no way to tell them apart after the fact.

### Root Cause

The view lifecycle was designed to keep xterm scrollback across a view switch, and **preserving the
xterm was conflated with preserving the stream**. `a870fa8e` separated them in code but wired the
separation to the one caller that plan needed. The remaining defect is narrower and different in
kind: there is no single place that answers *"is anyone rendering this terminal?"*, so the answer is
re-derived ad hoc — by the fit ladder (correctly, with a slice), by the detach loop (with a bare
include), and by nothing at all on the streaming path.

### Non-goals

- **Do not destroy views.** A 3x3 → 1 → 3x3 round trip must stay instant, which is what the padded
  `paneAssignments` protects. Suspension closes a socket; it never disposes an xterm.
- **Do not narrow `paneAssignments`.** The padding is deliberate and documented; the rendered-slot
  question is answered by slicing at read time, not by trimming the array.
- **Do not re-implement suspend or resume.** They shipped and they are correct. This plan adds their
  trigger and, in doing so, removes the ad-hoc call the status-pane change left in
  `updatePaneElement`.
- **Not a fix for the visible pane's latency.** Compression, idle-frame suppression and echo
  quantization are separate plans.
- No new gateway constructor argument or setter — see Both Hosts.

## Metadata

**Topic:** The rendered-slot predicate decides which terminals hold a live socket
**Complexity:** 3

> **Superseded:** Complexity 6
> **Reason:** Changes 2, 3 and 4 of the original plan — the socket teardown, the `?lastSeq=` resume
> and the replay-gap surfacing — are shipped. What remains is one predicate function, one call site
> in the reconcile, and the deletion of one ad-hoc call. The risk is concentrated in a single
> question (who owns `entry.suspended`) rather than spread across a new mechanism.

**Tags:** terminals, performance, webview, standalone, remote

## User Review Required

None. The predicate, its ownership of `entry.suspended`, its placement in the reconcile and the
gap-reporting behaviour are all specified below.

## Dependencies

None outstanding. `?lastSeq=` resume, the replay ring, `replayGap` detection and `writeReplay` all
ship today, and so — as of `a870fa8e` — do `suspendTerminalStream` and `resumeTerminalStream`.

`the-grid-renders-agents-not-terminals.md` no longer depends on this plan: it consumed the mechanism
by building it. The dependency now runs the other way. This plan **takes over** the status pane's
suspend call, so it must leave that feature working — a status pane is a pane the predicate reports
as not-live, and it must stay suspended while it is on screen.

## Both Hosts

`TerminalWsGateway` is constructed at **two** composition roots and both must keep working:

- **standalone** — in-process, `bootstrap.ts`, gated on `ptyReady`
- **extension** — a separate pty-host sidecar, `ptyHost.ts`; the terminals page is told where to
  connect via `data-pty-host-origin="ws://127.0.0.1:<port>"` (`TaskViewerProvider.ts`)

`terminals.js` is shared by both, so a change confined to it reaches both hosts with no wiring — the
same property that let `a870fa8e` ship the mechanism to both roots without touching either.
**That is the reason this plan must not add a constructor argument or a setter.** Those have two call
sites and `ptyHost.ts` is demonstrably the one that gets forgotten: `setBindPolicy` is wired in
`bootstrap.ts` and nowhere in `ptyHost.ts` today.

The predicate reads only client-side state (`paneAssignments`, `effectiveLayout`, `paneModes`, the
container's box), so the two hosts' differing fleet-row shapes cannot make it disagree.

## Proposed Changes

**1. One predicate, and it is the authority.**

Add `isTerminalRendered(name)` in `terminals.js`. A terminal is *live* when **all three** hold:

- its name appears in `paneAssignments.slice(0, getSlotCount(effectiveLayout))` — the slice is the
  existing precedent, and `startFitLadder`'s comment states it is load-bearing precisely because
  `paneAssignments` is padded;
- `isRendered(entry.container)` — the container has a box, which a pane the reconcile dropped does
  not;
- `paneModes[<that slot>] !== 'status'` — a status pane renders a card, not a viewport, so it is not
  rendering the terminal even though its slot is on screen.

The third clause is what makes this function the single owner of `entry.suspended`. There is no
second reason a terminal can be suspended, so nothing has to record which reason applied.

**2. Drive suspend and resume from the reconcile's trailing loop.**

`renderPaneGrid` already ends with a loop over `terminalsMap` that arms and cancels detach timers.
Extend that loop: for each entry, `isTerminalRendered(name) ? resumeTerminalStream(entry) :
suspendTerminalStream(entry)`. Both are already idempotent, so the loop is safe to run on every
reconcile — including the 5 s fleet poll.

Placement is load-bearing and must not move: the loop runs **after** the per-slot
`updatePaneElement` calls, which is the only point at which containers have been appended or dropped
and `.active` has been set. Evaluating `isRendered` before that reads the previous frame's geometry
and suspends the pane that is about to be shown.

Leave the detach-timer arm/cancel exactly as it is. It keys on the bare
`paneAssignments.includes(name)` on purpose — an off-screen but assigned terminal must keep its view
— and conflating the two predicates is how a 3x3 → 1 → 3x3 round trip starts rebuilding xterms.

**3. Delete the ad-hoc call the status-pane change left behind.**

`updatePaneElement`'s `isStatusPane` branch calls `suspendTerminalStream(entry)` directly, and its
terminal branch calls `resumeTerminalStream(entry)` after adding `.active`. Both go, replaced by the
predicate's third clause. Two call sites deciding one flag is the ownership problem this plan exists
to close; leaving them in place while adding the predicate is strictly worse than either alone.

The `.active` class handling stays where it is — that is presentation, not stream state.

**4. The replay gap already reports itself; assert it, do not rebuild it.**

`connectTerminalSocket`'s hello handler sets `entry.replayGap` from the frame and calls
`markReplayGap`, which is reached by the resume path because resume reconnects through that same
function. Nothing new is needed.

One consequence must be pinned rather than discovered: `markReplayGap` calls `renderPaneGrid()`,
which now evaluates the predicate. A resume that lands on an evicted ring therefore re-enters the
reconcile. `suspendTerminalStream` and `resumeTerminalStream` both early-return on their own flag, so
the re-entry terminates on the first pass — but that idempotency is now load-bearing rather than
merely tidy, and a change that removes it turns a scrollback gap into a render loop.

**5. Leave the sidebar and rail unchanged.**

Liveness, badges and the activity light are driven by `fleetList` / `ptyListTerminals` polling and WS
pushes, not by a terminal's own socket. A suspended seat must still show its light — verify, do not
assume.

## Verification Plan

### Automated

Extend `src/test/status-pane-mode-contract.test.js`, or add a sibling suite wired into
`package.json` and `.github/workflows/integration-tests.yml` the same way. Source contracts are the
only automated instrument here: the pane grid has no runtime harness, and every failure mode below is
silent.

1. `isTerminalRendered` exists and tests all three clauses — the **sliced** assignment lookup,
   `isRendered`, and `paneModes[...] !== 'status'`.
2. The suspend/resume call sites in `updatePaneElement` are **gone**, and the only callers are inside
   the reconcile's trailing loop.
3. That loop appears **after** the `updatePaneElement` loop in source order.
4. The detach-timer arm/cancel still keys on the **bare** `paneAssignments.includes(name)`, not on
   the predicate — a slice there would start destroying off-screen views.
5. `suspendTerminalStream` and `resumeTerminalStream` still early-return on `entry.suspended`, and
   neither disposes `entry.term`.
6. No new argument on `new TerminalWsGateway(...)` at either composition root.

### Manual

7. Open nine terminals in a 3x3, then switch to layout `1`. Eight entries report
   `suspended: true` and a closed or absent `wsState` in `__sbTerminalStats()`, and the gateway's
   client count for those terminals drops.
8. Switch back to 3x3. All eight panes repopulate from replay, scrollback intact, no visible reset.
9. `bytesWritten` in `__sbTerminalStats()` stops advancing for a suspended entry and resumes after
   reattach.
10. Suspend a seat, let it produce more than `MAX_SCROLLBACK_BYTES` of output, then resume. The pane
    reports a replay gap rather than rendering a seamless-looking hole — and the grid settles instead
    of re-rendering repeatedly.
11. A suspended seat's sidebar activity light, DONE badge and plan strip continue to update.
12. Type into a pane immediately after it resumes; input is delivered, not dropped by
    `notifyInputDropped`.
13. WebGL: suspend eight of nine seats and confirm `liveWebglContexts` falls; resume and confirm the
    panes come back on WebGL rather than silently on canvas (`isWebgl` in stats).
14. **Status panes still work.** A pane toggled to status stays suspended while fully on screen, and
    toggling it back to output resumes it — the regression the ownership change could introduce.
15. **Both hosts:** run 7-10 and 14 against `switchboard local` (in-process gateway) and against the
    VS Code extension with its pty-host sidecar.

### Goal Invariants

- Assert one function answers "is anyone rendering this terminal", and that suspend/resume are
  called from exactly one place.
- Assert the predicate slices `paneAssignments` to `getSlotCount(effectiveLayout)` — a bare
  `.includes()` matches a terminal parked off-screen and the suspension never fires.
- Assert a status pane is reported not-live by the predicate, so its socket closes without any
  call in `updatePaneElement`.
- Assert `entry.term` is NOT disposed on suspend — a 3x3 → 1 → 3x3 round trip still needs no rebuild.
- Assert the reconnect on resume carries `lastSeq` > 0 when frames were received before suspension.
- Assert `paneAssignments` is still padded to `getMaxSlotCount()` and is never trimmed by this change.
- Assert the detach timer's predicate is unchanged, and that an off-screen assigned terminal keeps
  its view.
- Assert `suspendTerminalStream` / `resumeTerminalStream` remain idempotent — `markReplayGap` calls
  `renderPaneGrid`, so a lost idempotency is a render loop, not a wasted call.
- Assert no new argument on `new TerminalWsGateway(...)` at either composition root.

## Rescope Note (2026-09-03)

Rescoped after the reviewer pass on `the-grid-renders-agents-not-terminals.md` (commit `a870fa8e`),
which implemented and wired this plan's Changes 2, 3 and 4 in order to ship status panes. This file
now covers only what that commit did not: the rendered-slot predicate, its single call site, and the
transfer of `entry.suspended`'s ownership away from `updatePaneElement`. Nothing was dropped as
unwanted — the removed scope is removed because it is done.
