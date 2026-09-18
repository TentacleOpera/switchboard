# The grid's unit should be an agent, not a terminal — nine terminals is worse than one terminal nine times

## Goal

Give a pane the option to render its seat as **state** rather than as terminal output, so a grid shows
one live terminal for the seat you are talking to and status for the seats you are only watching.

### Problem Analysis

**The terminal grid competes on ground it cannot win, and handicaps itself doing so.** Nine panes of a
3x3 give each seat ~40 columns of a TUI drawn for 80+. It reflows badly, it is hard to read, and it is
still judged against dedicated terminals that will always win on rendering, fonts, selection and
search. The feature gets *worse* as you add panes, which is backwards for something whose entire
pitch is "many at once".

**What no multiplexer can do is the thing Switchboard already knows.** tmux can tile nine panes; it
cannot say *"coder-2 is blocked on a decision, coder-1 finished four minutes ago, the lead is waiting
on you."* That needs a model of what an agent **is** — role, assigned plan, dispatch state, liveness,
completion — and Switchboard is the only thing holding one.

**The model exists; it has no renderer.** The pieces are already computed and scattered across
presentation code:

- `postFleetStateToShell` derives a `light` and `doneStamp` per terminal for the rail
- `renderWorkingSilence` already has the copy — *"<agent> is working — no output yet"* — and the
  `lastPrintableAt` / `lastFrameAt` / `firstFrameAt` stamps behind it
- `resolveInputState` resolves live / connecting / read-only / paste-queued
- `terminalBadges` carries DONE; the plan strip carries the assigned plan

**And the pane already has a mode axis.** `paneModes[i]` is per-slot, persisted, padded to
`getMaxSlotCount()` and never trimmed — with two values today, `'terminal'` and `'kanban'`. A third
value is an extension of a shipped abstraction, not a new concept.

**The team model already assumes this shape.** A team commits once as its head; members do not commit;
standing orders are head↔member only; one subtask goes to one clean seat, so members are numerous and
individually uninteresting minute to minute. The lead genuinely is the interlocutor and the members
genuinely are monitored. The grid is the only part of the product that does not say so.

### Root Cause

The grid's unit became the terminal because a terminal was the only renderer available when it was
built. Density then made the fleet model *less* visible rather than more, because every additional
pane bought another cramped viewport instead of another readable fact.

### Non-goals

- **Not a three-way mode picker.** `status` is not a peer of `kanban`. It is a **terminal pane with
  its output off**, and it must be presented as a toggle on a terminal pane. Peer modes in a picker
  matrix is the recurring UI failure in this codebase; do not reskin it, do not build it.
- **Do not enforce one live pane per grid.** Per-pane choice, with a solo gesture. Two leads in a 2x2
  is a real thing to want.
- **Do not infer state.** A pane must render what an agent *declared*, not what the host guessed —
  see the dependency on the report inbox, and Change 4.
- Not a replacement for the terminal. Typing needs a real terminal, full size, and that stays.
- Not remote-fleet rendering. Change 5 leaves the seam for it; it does not build it.

## Metadata

**Topic:** A pane can render its seat as state instead of as terminal output
**Complexity:** 6
**Tags:** frontend, ui, ux, feature

## User Review Required

None. Presentation (toggle, not picker), the no-enforcement decision, and the declared-over-inferred
rule are all settled above.

## Complexity Audit

### Routine

- Adding `'status'` as a third `paneModes` value — an extension of a shipped two-value abstraction.
- The per-pane output toggle and solo gesture — presentation controls on an existing pane header.
- Routing state through a single resolver function — a refactor of inline reads, no new data source.
- The status card's content layout (identity, declared report, host-derived signals) — HTML/CSS in
  the webview, reusing `renderWorkingSilence`'s copy and `terminalBadges`'s DONE stamp.

### Complex / Risky

- **The paneModes audit is the plan's entire risk surface.** Every binary test (`=== 'kanban'`,
  `!== 'kanban'`, `=== 'terminal'`) must be classified: does this site mean "not kanban", "is
  terminal", or "has a seat"? A third value inheriting the wrong branch compiles clean and silently
  misbehaves. The audit is ~23 sites, not the ~15 the original plan listed (see Change 1).
- **The restore path (`:2213`) silently coerces `'status'` to `'terminal'` on reload.** Without a
  fix, status panes do not survive a page reload — the feature works during a session and fails
  across one. This is the one site whose omission breaks a verification check (#5).
- **Seating into an unassigned status pane is unspecified.** Six free-slot tests (`:3987`, `:5578`,
  `:5589`, `:5591`, `:8637`, `:9050`) use `!== 'kanban'` and inherit "status is free" by accident.
  The plan must decide: flip to terminal on seating (consistent with the `:6630` kanban precedent),
  or skip status panes (consistent with kanban). The decision affects every seating path.
- **Working silence (`:2677`) would overlay the status card.** The guard clears only for kanban;
  a status pane falls through to terminal logic and renders "Working — no output yet" over the
  status content — the opposite of the declared-over-inferred ordering the plan mandates.
- **Two-host fleet row shape divergence.** The extension's fleet rows come from a sidecar
  `PtyFleetService`, standalone's in-process. The fields present are not guaranteed identical, and
  the status card reads them.

## Edge-Case & Dependency Audit

### Race Conditions

- **Mode toggle during a fleet poll.** `renderPaneGrid` runs on every 5 s fleet poll and on every
  badge change. A mode toggle between polls must not race the poll's re-render — the mode is read
  at render time from `paneModes[i]`, so a toggle between polls is picked up on the next render.
  No lock needed, but the status card must not assume a stable fleet row across renders.
- **Suspend/resume during seating.** If a terminal is seated into a slot whose mode just flipped
  to status, the suspend mechanism (from the prerequisite plan) and the seating path race. The
  seating path sets `paneAssignments[i]` and the suspend path reads it; the render path must see a
  consistent pair. Mitigation: the seating flip to terminal (Change 1) and the suspend are both
  driven from `renderPaneGrid`, which is serial.
- **Solo gesture vs. per-pane toggle.** The solo gesture flips other seated panes to status. If
  the operator toggles one back to terminal while the solo gesture is mid-flight, the pane ends in
  terminal — which is correct (per-pane choice wins, per the no-enforcement non-goal).

### Security

- **No new attack surface.** The status pane reads data already computed client-side
  (`fleetList`, `terminalBadges`, the report inbox). No new endpoint, no new file access, no new
  cross-frame message. The resolver (Change 5) is a local function, not a remote call.
- **Declared reports are trusted.** The inbox's frontmatter is agent-authored; a malicious agent
  could post a misleading `blocked` report. This is the inbox plan's concern, not this plan's — the
  status pane renders what was declared, which is the design's explicit contract.

### Side Effects

- **Socket suspension is the prerequisite plan's side effect, not this plan's.** This plan
  consumes the suspend mechanism; it does not modify it. The performance win is a consequence.
- **`paneModes` persistence grows.** The saved setting `terminals.paneModes` now carries
  `'status'` values. Older clients reading a persisted `'status'` would coerce it to `'terminal'`
  (`:2213`) — harmless for old clients (they don't have the feature), but the restore path must be
  fixed in the same change that adds the value.
- **Grid structure fingerprint changes.** `:6026` passes `paneModes.slice(0, slotCount)` into the
  fingerprint. A status pane changes the fingerprint, triggering a re-render. This is correct (the
  pane looks different) but means a mode toggle forces a full grid re-render, not a delta.

### Dependencies & Conflicts

- **`suspend-terminal-streams-for-panes-nobody-renders.md`** — hard prerequisite. Owns the
  suspend/resume mechanism and replay-gap reporting. This plan's Change 3 consumes it. The
  prerequisite plan's rendered-slot predicate must treat a status pane as "not rendered" (no
  terminal viewport) — verify this, do not assume.
- **`agent-reports-go-to-a-file-inbox.md`** — hard prerequisite for Change 4. Owns the
  `finished | blocked | question | status` vocabulary and the file-inbox mechanics. Without it,
  panes can only show inferred state, which is the one thing this plan must not ship.
- **`board-read-endpoints-must-survive-the-storage-topology.md`** — cited principle for Change 6
  (honest failure). The "unreachable ≠ idle" rule is the same hazard.
- **`src/webview/terminals.js`** — sole file modified. ~23 `paneModes` sites, the `:2213` restore
  path, and the `:2677` working-silence guard. No other file is touched. The change reaches both
  hosts because `terminals.js` is shared.

## Dependencies

- **`suspend-terminal-streams-for-panes-nobody-renders.md`** — hard prerequisite. A status pane is a
  pane whose terminal is suspended; that plan owns the suspend/resume mechanism and the replay-gap
  reporting this one consumes.
- **`agent-reports-go-to-a-file-inbox.md`** — hard prerequisite for Change 4. The inbox's vocabulary
  (`finished | blocked | question | status`) is what fills a pane. Without it the panes can only show
  inferred state, which is the one thing this plan must not ship.

## Both Hosts

`terminals.js` is served by both hosts — standalone via `bootstrap.ts`, and the extension via
`TaskViewerProvider.ts`'s `serveStatic` (`getShellHtml` / `getPanelsManifest` / `getPanelHtml`, with
`terminals: ptyHostReady()`). So the client change reaches both.

The extension reaches its fleet through the pty-host sidecar (`ptyHost.ts:46`) and the standalone host
in-process (`bootstrap.ts:3202`). Change 3 relies only on the suspend mechanism, which is inside the
shared gateway and client, so no seam is added at either root. Verify the pane's state content against
both — the extension's fleet rows and the standalone's come from different `PtyFleetService` instances
and the fields present are not guaranteed identical.

## Adversarial Synthesis

**Risk summary.** Key risks: (1) the restore path at `:2213` silently coerces `'status'` to
`'terminal'` on reload — the feature works in-session and fails across one, breaking Verification
#5; (2) the audit undercounts the binary-test sites by ~8, omitting the restore path, the
working-silence guard, and four free-slot tests that inherit "status is free for seating" without a
decision; (3) working silence (`:2677`) would overlay the status card, inverting the
declared-over-inferred ordering. Mitigations: fix `:2213` in the same change that adds the value
(one-line ternary); expand the audit to all ~23 sites with explicit per-site classification; extend
the `:2677` guard to clear for status panes; decide that seating into an unassigned status pane
flips it to terminal (consistent with `:6630`).

## Proposed Changes

**1. A third `paneModes` value, and the audit that makes it safe.**

Add `'status'`. The work is not the value, it is that **~23 call sites currently binary-test or
assign the mode** and many of them silently mean "terminal" for any non-`kanban` value:

> **Superseded:** ~15 call sites currently binary-test the mode
> **Reason:** A grep of `paneModes` in `terminals.js` returns 40 matches across ~23 distinct
> binary-test or assignment sites. The original audit listed 15 and omitted 8 — including the
> restore path (`:2213`), the working-silence guard (`:2677`), four free-slot tests (`:8637`,
> `:9050`, `:7731`, `:7783`), the kanban-poll guard (`:6003`), and the grid fingerprint
> (`:6026`). The omitted sites include the one that breaks persistence across reloads.
> **Replaced with:** the full ~23-site audit below, with per-site classification.

**Sites that test `!== 'kanban'` (status inherits "not kanban" — correct for some, wrong for
others):**

| Line | Code | Classification |
|------|------|----------------|
| `:3987` | `isFreeSlot`: `!paneAssignments[i] && paneModes[i] !== 'kanban'` | **Free for seating.** An unassigned status pane has no seat to show; treating it as free is correct. On seating, flip to terminal (see below). |
| `:5578` | `isFree`: `!paneAssignments[i] && paneModes[i] !== 'kanban'` | **Same as `:3987`.** Free for seating; flip on assign. |
| `:5589` | `paneModes[target] === 'kanban'` | **Correct as-is.** Tests for kanban to skip it in the displacement scan. Status panes are valid displacement targets. |
| `:5591` | `paneModes[i] !== 'kanban'` | **Same.** Non-kanban (including status) is a valid displacement target. |
| `:9050` | `!paneAssignments[i] && paneModes[i] !== 'kanban'` | **Free for Open All seating.** Same as `:3987` — flip on assign. |
| `:8637` | `paneModes[slot] === 'kanban'` | **Correct as-is.** Skips kanban slots in team seating. Status panes are valid team seating targets — flip on assign. |
| `:2677` | `paneModes[paneIndex] === 'kanban'` → clear working silence | **MUST be widened.** A status pane is not showing terminal output; the "Working — no output yet" overlay is meaningless and would cover the status card. Add `|| paneModes[paneIndex] === 'status'` to the guard. |

**Sites that test `=== 'kanban'` (status does not match — correct, no change needed):**

| Line | Code | Classification |
|------|------|----------------|
| `:854` | `paneModes[0] = 'kanban'` | **Assignment, not a test.** Solo/dock forced mode. No status in solo. |
| `:6003` | `paneModes.slice(0, slotCount).some(m => m === 'kanban')` | **Correct.** Drives kanban poll start. Status panes do not start the kanban poll. |
| `:6179` | `paneModes[paneIndex] === 'kanban'` | **Correct.** Drag-drop guard; status panes accept drops (they have a seat). |
| `:6211` | `paneModes[paneIndex] === 'kanban'` | **Correct.** Drop target guard; same as `:6179`. |
| `:6560` | `paneModes[index] !== 'kanban'` | **Correct.** Group-context menu guard; status panes are group-aware. |
| `:6619` | `paneModes[index] === 'kanban' && !assignedName` | **Correct.** Renders kanban pane only for unassigned kanban. Status panes render through the terminal/status path below. |
| `:6630` | `paneModes[index] === 'kanban' && assignedName` → flip to `'terminal'` | **Correct as-is — do NOT extend to status.** An assigned kanban pane flips to terminal because kanban is meaningless with an assignment. An assigned status pane is the feature's entire point — it MUST stay status. |
| `:7650` | `paneModes[targetIndex] === 'kanban'` → toggle back to terminal | **Correct.** Kanban toggle. Status has its own toggle (Change 2). |
| `:7731` | `paneModes[i] === 'kanban' && !paneAssignments[i]` | **Correct.** Kanban pane collection for rendering. Status panes are not kanban. |
| `:7783` | `paneModes[index] === 'kanban' && !paneAssignments[index]` | **Correct.** Renders kanban pane. Status panes render through their own path. |

**Sites that test `=== 'terminal'` (status does not match — MUST be classified):**

| Line | Code | Classification |
|------|------|----------------|
| `:6843` | `paneModes[index] === 'terminal'` (pop-out gating) | **MUST decide.** A status pane hides pop-out today. Decision: show pop-out for status panes — pop-out opens a full terminal for the seat, which is the "I need to type" escape hatch the non-goals preserve. Change to `paneModes[index] !== 'kanban'`. |

**Sites that assign a mode value:**

| Line | Code | Classification |
|------|------|----------------|
| `:6456` | `paneModes[index] = 'terminal'` | **Correct.** Kanban→terminal toggle. Status has its own toggle. |
| `:6567` | `paneModes[index] = 'kanban'` | **Correct.** Terminal→kanban toggle. |
| `:6631` | `paneModes[index] = 'terminal'` | **Correct.** Kanban-with-assignment flip. Do not extend to status. |
| `:7651` | `paneModes[targetIndex] = 'terminal'` | **Correct.** Kanban toggle-back. |
| `:5931` | pad loop: `paneModes.push('terminal')` | **Correct.** New slots default to terminal. A status pane is an operator choice, not a default. |

**Sites that restore or persist the mode:**

| Line | Code | Classification |
|------|------|----------------|
| `:2213` | `savedModes.map(m => m === 'kanban' ? 'kanban' : 'terminal')` | **SHOWSTOPPER — must fix.** A saved `'status'` is silently coerced to `'terminal'` on reload. Fix: `m === 'kanban' ? 'kanban' : m === 'status' ? 'status' : 'terminal'`. Without this, Verification #5 fails on the first reload. |
| `:2232` | `paneModes = ['terminal']` (solo) | **Correct.** Solo forces terminal. No status in solo. |
| `:2237` | `paneModes = ['kanban'` (kanban dock) | **Correct.** Dock forces kanban. No status in dock. |

**Sites that pass the array (not binary tests, but affected):**

| Line | Code | Classification |
|------|------|----------------|
| `:6026` | `paneModes.slice(0, slotCount)` → grid fingerprint | **Correct — no change needed.** A status pane changes the fingerprint, triggering a re-render. This is the right behaviour: the pane looks different, so the grid must re-render. |

**Seating into an unassigned status pane — the rule:**

An unassigned status pane is free for seating (it has no seat to show). When a terminal is seated
into it — via sidebar click (`:3987`/`:5578`), Open All (`:9050`), or team seating (`:8637`) — the
pane **flips to terminal mode**. This is consistent with the kanban precedent at `:6630`, where an
assigned kanban pane flips to terminal because the operator deliberately placed a terminal there.
The flip must happen at the seating path (set `paneModes[i] = 'terminal'` alongside
`paneAssignments[i] = name`), not at render time — `renderPaneGrid` cannot distinguish "was status
before seating" from "operator toggled to status after seating." An assigned status pane (operator
toggled after seating) is NOT free (`!paneAssignments[i]` is false) and stays status.

Each must be classified deliberately: does this site mean "not kanban", "is terminal", or "has a
seat"? A third value inheriting the wrong branch compiles clean and is exactly the class of defect
this codebase's own rules warn about. This audit **is** the plan's risk.

**2. Presentation: an output toggle, plus solo.**

On a pane with a seat, a control that turns output off (status) and on (terminal). Plus one gesture —
"make this the live pane" — that flips the other seated panes to status. No picker, no third peer
entry in any mode menu.

**3. A status pane holds no terminal socket.**

Entering status suspends the pane's terminal through the mechanism in the prerequisite plan; leaving
it resumes from `?lastSeq=` and reports a replay gap if one occurred. The performance win is a
consequence of the design, not its justification — do not implement it as a cache.

**4. Content: declared first, inferred clearly labelled.**

Render, in priority order:

- the seat's identity — role, name, brand, and the assigned plan from the plan strip
- **the latest declared report** from the inbox: `finished | blocked | question | status`, with its
  timestamp and its text
- then, and only visibly *subordinate* to the above, host-derived signals: DONE badge, time since last
  printable output, input state

The ordering is the point. `blocked` because an agent said so is a fact; "no output for 90 seconds" is
a guess, and this codebase has shipped false `blocked` notices before. A pane that presents a guess as
a fact is worse than a terminal showing raw bytes, because raw bytes are at least honest about being
raw.

**5. The pane's data comes from a resolver, not from a hardcoded local read.**

Route the pane's state through one function that answers "state for seat X", rather than reading
`fleetList` and the inbox inline. This plan implements only the local answer. It exists so a later
plan can answer for a *remote* fleet without re-opening every render site — the seam, not the feature.

**6. Honest failure, mandatory.**

A status pane whose state cannot be resolved must render **unreachable**, never idle, never empty.
`board-read-endpoints-must-survive-the-storage-topology.md` names this exact hazard — *"an unreachable
store and an empty result are indistinguishable to a caller … a clean `200 []` looks like success"*.
On a pane whose whole job is telling you what your fleet is doing, a quiet wrong answer is the
anti-feature.

## Verification Plan

1. A 3x3 with one terminal pane and eight status panes: the eight sockets are closed
   (`__sbTerminalStats()`), and the live pane is unaffected.
2. Toggle a status pane back to terminal. Output resumes from replay with scrollback intact; a long
   suspension reports a gap rather than a silent hole.
3. Solo gesture: with three seated panes, invoking it on one flips the other two to status and leaves
   unseated panes alone.
4. Two live terminal panes at once is possible — the design does not enforce a single live pane.
5. `paneModes` round trip: set a status pane in slot 5, switch layout to `1`, switch back to 3x3. The
   mode survives, as `kanban` does today.
6. A kanban pane is unaffected by the audit — every `=== 'kanban'` site behaves exactly as before.
7. Pop-out: the pop-out button's gating (`:6843`) does the right thing for a status pane — decide and
   assert which, rather than inheriting the terminal branch by accident.
8. An agent writes a `blocked` report to the inbox; the pane shows it, attributed and timestamped,
   above any host-derived signal.
9. With the inbox empty, a pane shows host-derived signals only and does not present them as
   declarations.
10. Kill the state source for one seat; its pane reads **unreachable**, not idle.
11. Density: 16 seats in status mode remain individually readable. If they do not, the pane's content
    is too heavy — fix the pane, not the ceiling.
12. **Both hosts:** run 1, 2, 5 and 8 against standalone and against the VS Code extension with its
    pty-host sidecar.

### Goal Invariants

- Assert `paneModes` accepts `'status'` and that every site listed in Change 1 was classified — no
  site left testing `!== 'kanban'` where it means "is terminal".
- Assert the restore path at `:2213` preserves `'status'` across a reload — a status pane set in
  slot 5, persisted, reloaded, is still `'status'` (not silently coerced to `'terminal'`).
- Assert seating a terminal into an unassigned status pane flips the pane to `'terminal'` at the
  seating path, not at render time.
- Assert an assigned status pane does NOT flip to `'terminal'` — the `:6630` kanban flip must not
  be extended to status.
- Assert `updateWorkingSilence` (`:2677`) clears the working-silence overlay for a status pane, not
  only for a kanban pane.
- Assert the pop-out button (`:6843`) is visible for a status pane with a seat (pop-out is the
  "I need to type" escape hatch).
- Assert a status pane has no open terminal WebSocket.
- Assert `entry.term` is not disposed when a pane enters status mode.
- Assert the status control is a per-pane toggle and that no mode *picker* offering three peers exists.
- Assert nothing enforces a maximum of one terminal-mode pane.
- Assert a declared report renders above host-derived signals when both are present.
- Assert an unresolvable state renders as unreachable and is visually distinct from idle.
- Assert the pane's state is read through a single resolver function, not inline per render site.

## Review Findings

Reviewed at CODE REVIEWED and found the feature absent: `'status'` was never assigned by any code path, so Changes 2 (toggle + solo), 4 (card content), 5 (resolver) and 6 (honest failure) had not landed, and Change 3's `suspendTerminalStream`/`resumeTerminalStream` had zero callers. Implemented all four inline in `src/webview/terminals.js` and `src/webview/terminals.html` — an `output`/`status` per-pane toggle plus a `live` solo gesture, `resolveSeatState` as the single state seam, a card ordering declared reports above host-derived signals, and an `unreachable` state fed by a new `fleetFetchFailed` flag — and wired suspend/resume into `updatePaneElement`; also fixed a `flushBatch` defect where a suspended pane's queued bytes survived the suspension and were replayed on top of the resume's replay, suppressed the false `connecting` chip and the opaque curtains a status pane would otherwise render behind, and added socket state to `__sbTerminalStats()` so Verification #1 is performable at all. Added `src/test/status-pane-mode-contract.test.js` (22 assertions, 19 of which fail against HEAD) and wired it into `package.json` and `.github/workflows/integration-tests.yml`, because the plan named no automated check for any Goal Invariant. Verification: `node --check` clean; status-pane-mode 22/22, terminal-flow-control 16/16, terminal-input-path 19/19, terminal-rename-rekey 8/8, terminal-renderer-lifecycle, panel-runtime-surface, browser-kanban-pane-order 18/18 all pass; `standalone-parity:check`, `icons:parity`, `banner:check`, `mirror:check` pass. Two failures are pre-existing at HEAD and untouched by this work: `catalog:check` drift, and `test:contract:panel-scrollbars` 4/60 red on `src/webview/command.html` (CI-wired, so CI is red at HEAD).

## Deferred Findings

- MAJOR `src/webview/command.html` — `test:contract:panel-scrollbars` is CI-wired and red at HEAD (bare `::-webkit-scrollbar` rule, thumb fallback token, `color-scheme: dark`, Firefox `@supports` block all missing), introduced by 3969f263. Out of this plan's file scope; not fixed here.
- MAJOR `protocol-catalog.json` — `catalog:check` reports drift at HEAD, verified pre-existing by re-running the gate with this change stashed. Needs `npm run catalog:generate` in a commit of its own.
- MAJOR `src/services/LocalApiServer.ts:2162` — `npm run compile-tests` fails at HEAD with TS7006 on an implicit-`any` `err`, which blocks `pretest` and therefore `npm test`. Pre-existing; not this plan's file.
- MAJOR `src/webview/terminals.js` — declarations are readable only through `GET /teams/<id>/reports`. A seat outside a spawned team writes to `.switchboard/mission-control/reports/`, for which LocalApiServer exposes no read route, so such a pane can never show a declaration. Rendered honestly ("no readable report inbox for this seat") rather than as "nothing declared", but the coverage gap is real.
- NIT `src/webview/terminals.js:10441` — `resumeTerminalStream`'s `ensureSizeVote(entry)` cannot fire: `connectTerminalSocket` clears `sizeVoteActive` and leaves the socket CONNECTING, so `fitAndReportSize` returns without sending, and `ws.onopen` re-votes anyway. Kept as the correct belt if the ordering changes.
- NIT `src/webview/terminals.js:10400` — `suspendTerminalStream` disposes the renderer without attaching a replacement, unlike `swapRenderer`, leaving xterm on its built-in DOM renderer for the duration. Harmless while the host is `display:none`.
- NIT `src/webview/terminals.js` — the team inbox lists UNCLAIMED reports only, so a declaration a head has claimed leaves the listing and the pane falls back to host-derived signals. The inbox's contract, not a defect here.
- NIT `.switchboard/plans/suspend-terminal-streams-for-panes-nobody-renders.md` — that plan is still in CREATED, but its core mechanism (suspend/resume with `?lastSeq=` replay and renderer release) now lives in this change. It needs rescoping to whatever remains: the rendered-slot predicate for panes nobody renders.
