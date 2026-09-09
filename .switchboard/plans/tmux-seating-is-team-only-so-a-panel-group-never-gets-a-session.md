# tmux Seating Is Team-Only, So a Panel Group Never Gets a Session

## Goal

Make tmux seating apply to **any** collection of terminals, not just teams. A group assembled in the
Terminals panel — the SAVE AS GROUP arrangement, or a handful of seats opened with `+` — should get a
tmux session named for that group, with its terminals named as panes, on the same terms a team does.

### Problem analysis

**Operator statement of intent, verbatim:** *"a group is an impromptu collection of terminals you set
up in the terminals panel. I don't want tmux limited to teams."*

The tmux bridge is built and, as of the change below, reachable. But it is wired at exactly one seam,
and that seam only exists on the team path.

#### What exists

`createTmuxHeadWithDelegates` (`src/standalone/tmuxTeamSeating.ts:203`) creates a session named for
the team (`new-session -d -s <team> -n <headName>`), splits a pane per delegate, sets pane titles, and
on a restart takes the reattach branch (`hasSession` → `checkReconnect`) which **reuses the existing
panes and names** rather than creating new ones. It is wired into both hosts as the
`createHeadWithDelegates` seam — `bootstrap.ts:4006` and `TaskViewerProvider.ts:14073`.

That covers the operator's requirements 2 and 3 **for teams**, and it covers them already.

#### What does not exist

`createHeadWithDelegates` is called from `agentGroupInstantiation.ts:139` — the host-agnostic core of
*instantiate an agent group*, where "group" means a head-plus-delegates **definition authored in the
Agents tab**. That is a team.

A Terminals-panel group is a different thing entirely: a saved pane arrangement in the
`terminals.groups` setting, whose terminals were each spawned individually through
`ptyFleetService.create()` → `GoPtyFleetProjection` → the Go PTY host. That path has no tmux branch at
all. There is no setting, and no code path, that puts an individually-spawned terminal into a tmux
session.

So the shape of the defect is: **tmux ownership is decided by which instantiation path ran, not by the
operator's setting.** Start a team → tmux. Open four terminals and save them as a group → never tmux,
regardless of the toggle.

#### Why this is a design change and not a wiring fix

Two fleet services implement the same surface and a terminal belongs to exactly one:

|| | owns | created by |
| :--- | :--- | :--- |
| `GoPtyFleetProjection` | PTYs in the Go host | `ptyFleetService.create()` |
| `TmuxFleetService` | adopted/owned tmux panes | `createTmuxHeadWithDelegates`, `adopt` |

Routing single-terminal creation through tmux means choosing the backend **at create time**, and then
every consumer that resolves a terminal by name — dispatch, delivery, the liveness sweep, the panel's
pane assignments — has to keep working across both. That is the part to design, not to improvise.

### What has already been done (not part of this plan's work)

Landed while diagnosing, because the feature was unreachable at all:

- `switchboard.terminal.tmux.enabled` now defaults to **true** in all three deciding places:
  `package.json`, `bootstrap.ts:4100`, `cli.ts:4526`.
- An **Enable tmux** checkbox at the top of the Terminals panel (`terminals.html`), wired in
  `terminals.js` to read on load and persist on change.
- **The prefix lock is gone.** `getSetting`/`saveSetting` hardcoded a `switchboard.prompts.` prefix in
  both hosts (`kanbanService.ts`, and two fallback sites in `KanbanProvider.ts`), which made every
  contributed setting outside that namespace unreadable and unwritable from any UI. That is why no
  checkbox could have existed before: the key was not addressable. Keys already carrying the
  `switchboard.` namespace are now treated as absolute; relative keys are unchanged.

---

> **Superseded (2026-09-08, by shipped code — commit `e60e3982`):** "no setting can put a group in
> tmux… with one create path the group case stops being a design problem."
> **Reason:** The design change was not needed. `ptyCreateTerminal` (`bootstrap.ts:2159`) simply had no
> tmux branch, while the team path has had one at the `createHeadWithDelegates` seam since Part 4.
> Adding that branch was contained: dispatch (`triggerAction`, 6 tmux lookups) and delivery
> (`sendToTerminal`, 3) already resolve a tmux-backed seat by name, `createTmuxHeadWithDelegates`
> already reattaches by name on restart, and its delegate work is a loop over `delegateSpecs` — so a
> lone agent is a team of one. Verified live: `POST /terminals/verb/ptyCreateTerminal {"role":"coder"}`
> returned `{success:true, paneId:"%13", sessionName:"sb-team"}` and `tmux ls` went 1 → 2.
> **What remains of this plan:** ONE thing — the session is named `sb-team`, not for the group. The
> branch passes `payload.groupName || payload.teamName`, and a bare `+` create sends neither, so every
> ungrouped seat piles into one default session. The panel must send the group name on create. That is
> requirement 2 of the operator's spec and is all that is left here; changes 1, 3, 4 and 5 below are
> done or moot.

> **Superseded (2026-09-09, by code re-verification):** "The panel must send the group name on create.
> That is … all that is left here; changes 1, 3, 4 and 5 below are done or moot."
> **Reason:** The claim was stale on two counts. (1) The panel ALREADY sends the group name —
> `activeGroupName()` (`terminals.js:120`) is stamped onto every `ptyCreateTerminal` payload at all
> three call sites (`terminals.js:9151`, `9524`, `10160`). That work is done. (2) The standalone host
> RECEIVES `payload.groupName` but DROPS it: `bootstrap.ts:2196` calls `ptyFleetService.create(...)`
> with opts `{ claudeInlineRendering, hidden }` and no `tmuxSession`, so `GoPtyFleetProjection.create()`
> (`goPtyFleetProjection.ts:231`) falls back to `deriveTmuxSessionName(name || role)` — one session per
> terminal (`lc-coder-1`), not one per group. (3) The extension host has NO tmux supplement in the
> `ptyCreateTerminal` path at all: `TaskViewerProvider.handlePtyVerb` → `_ptyHostVerb` → Go child
> `f.create()` spawns a raw shell. The `GoPtyFleetProjection.create()` tmux rewrite
> (`goPtyFleetProjection.ts:218-282`) is **standalone-only**; the extension host never instantiates a
> `GoPtyFleetProjection`. So "changes 1, 3, 4 and 5 are done or moot" is false for the extension host.
> **Replaced with:** Two remaining items — (A) standalone: forward `payload.groupName || payload.teamName`
> as `tmuxSession` into `create()` at `bootstrap.ts:2196`; (B) extension: the tmux supplement does not
> exist in the extension host's `ptyCreateTerminal` path and must be added for parity. See Proposed
> Changes.

## Metadata

**Complexity:** 6
**Tags:** backend, feature
**Dependencies:** none

## User Review Required

The extension-host parity approach is a design decision (see Outstanding Questions). The standalone
fix is mechanical and needs no review.

## Complexity Audit

### Routine
- Standalone fix: add `tmuxSession: payload.groupName || payload.teamName` to the `create()` opts
  at `bootstrap.ts:2196`. One line, mirrors the team path at `bootstrap.ts:4056` which already passes
  `{ tmuxSession: teamSession }`.
- The panel already sends `groupName` (`terminals.js:9151`, `9524`, `10160`) — no panel change needed.
- `deriveTmuxSessionName` (`teamWiring.ts:250`) already sanitises a free-form group name to
  `lc-[a-z0-9_-]` and is shared by both the team and the supplement path.

### Complex / Risky
- **Extension-host parity (the real work).** The tmux supplement (`goPtyFleetProjection.ts:218-282`)
  is a TypeScript command-rewrite that runs BEFORE the Go child spawns the PTY. The extension host's
  `ptyCreateTerminal` path (`TaskViewerProvider.ts:4204` → `_ptyHostVerb` → Go child) has no such
  rewrite — it forwards the payload straight to the Go child, which spawns a raw shell
  (`main.go:144`: `exec.Command(shell, "-l")`). Giving the extension host the same supplement means
  choosing WHERE the rewrite runs: a shared helper called from both hosts, a projection layer in the
  extension host, or moving the rewrite into the Go child. Each has a trade-off (see Adversarial
  Synthesis).
- **The supplement gates on `effectiveStartupCommand`** (`goPtyFleetProjection.ts:230`). A bare `+`
  create with no agent startup command gets no tmux session even with the setting on. The plan's Goal
  says "a handful of seats opened with `+`" should get tmux — but a bare shell with no agent does not.
  This may be intended (tmux is for agent seats) or a gap; see Outstanding Questions.
- **Standalone/extension divergence is the load-bearing risk.** CLAUDE.md: "Standalone and the
  extension MUST NOT diverge. NO EXCEPTIONS." The supplement is currently standalone-only; every gate
  is green because no test exercises the extension host's `ptyCreateTerminal` path for tmux.

## Edge-Case & Dependency Audit

- **Race Conditions:** Two terminals created into the same group concurrently each call
  `GoPtyFleetProjection.create()`, which runs `tmux has-session` then `new-session`/`new-window`. The
  command wrapper uses `&&`/`||` shell logic inside ONE `exec`, so the create-or-join decision is atomic
  per seat — two concurrent seats race on `has-session`, but the loser's `new-session` fails harmlessly
  (`2>/dev/null`) and the `new-window` branch fires on the winner's session. No fleet-level lock covers
  this; the tmux-level atomicity is what holds. Verify under concurrent `+` into the same group.
- **Security:** `payload.groupName` is a wire-supplied string reaching `deriveTmuxSessionName`, which
  sanitises to `[a-z0-9_-]` and prefixes `lc-`. The session name is passed as a single argv element to
  `-s` (execFile, never shell-interpolated — `teamWiring.ts:248`). The startup command rewrite at
  `goPtyFleetProjection.ts:257-281` DOES interpolate `session`, `win`, and `inner` into a shell string
  passed to the Go child as `effectiveStartupCommand` — but `inner` is `JSON.stringify`'d and
  `session`/`win` are sanitised. Confirm no group name can break out of the `tmux ... -s ${session}`
  interpolation (the sanitiser strips everything outside `[a-z0-9_-]`, so it cannot).
- **Side Effects:** Turning the setting OFF after seats are in tmux sessions leaves orphaned tmux
  sessions (the PTYs die, the tmux sessions survive until `kill-session`). The supplement path does
  not clean up sessions on terminal close. This matches the team-path behaviour (reattach on restart)
  but means `tmux ls` accumulates `lc-*` sessions. Not a regression; flag for awareness.
- **Dependencies & Conflicts:** `createBatch` (`goPtyFleetProjection.ts:429`) calls `this.create()`
  with no `tmuxSession` — batch-created terminals fall back to `name || role`, one session each. The
  panel's `createTerminalsForRole` uses `ptyCreateTerminal` (not batch), so this is not on the panel
  path, but a batch caller that expects group seating would not get it. No conflict with the team
  path: `activeGroupName()` returns `undefined` under a team scope (`terminals.js:121`), so a team
  create sends no `groupName` and the team path's own `tmuxSession: teamSession` wins.

## Dependencies

None. The tmux supplement, `deriveTmuxSessionName`, and the panel's `activeGroupName()` all exist and
are wired (standalone). The extension host's gap is a missing call site, not a missing dependency.

## Adversarial Synthesis

Key risks: (1) the extension host has no tmux supplement in the `ptyCreateTerminal` path — the feature
is standalone-only, which is the exact divergence CLAUDE.md forbids; (2) the supplement gates on
`effectiveStartupCommand`, so a bare-shell `+` create silently gets no tmux, contradicting the Goal's
"a handful of seats opened with `+`"; (3) the plan's own success check ("opening a terminal into a
saved panel group creates a tmux session") can pass on standalone while the extension host silently
does nothing. Mitigations: extract the rewrite into a shared helper called from both hosts; decide
explicitly whether bare shells get tmux; add a per-host verification check that names the host.

## Proposed Changes

### 1. Standalone: forward the group name into the tmux session (`src/standalone/bootstrap.ts`)

- **Context:** The `ptyCreateTerminal` arm at `bootstrap.ts:2196` calls `ptyFleetService.create(...)`
  with opts `{ claudeInlineRendering, hidden }`. The panel already sends `payload.groupName`
  (`terminals.js:9151`), but it is dropped here. `GoPtyFleetProjection.create()` then falls back to
  `deriveTmuxSessionName(name || role)` — one session per terminal, not per group.
- **Logic:** Add `tmuxSession: payload.groupName || payload.teamName` to the opts object at
  `bootstrap.ts:2196`, mirroring the team path at `bootstrap.ts:4056` (`{ tmuxSession: teamSession }`).
  When `groupName` is present (a locked panel group), the session is named for the group. When absent
  (a bare `+` with no locked group, or a team-scope create), it falls through to `payload.teamName`,
  then to the existing `name || role` default.
- **Implementation:** One line in the opts literal:
  ```ts
  const terminal = await ptyFleetService.create(payload.role || 'coder', payload.name, targetCwd, payload.worktreePath, payload.parentInstanceId, undefined, {
      tmuxSession: payload.groupName || payload.teamName,
      claudeInlineRendering: configProvider.getConfigBoolean('terminal.claudeInlineRendering', true),
      hidden: payload.hidden === true
  });
  ```
- **Edge Cases:** `payload.groupName` is `undefined` for team-scope creates (`activeGroupName()`
  returns undefined under `teamScopeId`), so a team create is unaffected — its session comes from the
  `createHeadWithDelegates` seam, not this arm. Two groups whose names normalise to the same
  `lc-<slug>` collide silently; `deriveTmuxSessionName` does not detect this. Acceptable for now
  (group names are operator-chosen and visible), but log the resolved session name at create so a
  collision is diagnosable.

### 2. Extension: add the tmux supplement to the `ptyCreateTerminal` path (`src/services/TaskViewerProvider.ts`)

- **Context:** The extension host's `handlePtyVerb('ptyCreateTerminal')` (`TaskViewerProvider.ts:4204`)
  modifies the payload (adds `claudeInlineRendering`, resolves `cwd`) then forwards it to the Go child
  via `_ptyHostVerb`. The Go child (`main.go:144`) spawns a raw shell — no tmux. The
  `GoPtyFleetProjection.create()` tmux rewrite (`goPtyFleetProjection.ts:218-282`) is standalone-only;
  the extension host never instantiates a `GoPtyFleetProjection`.
- **Logic:** The extension host must apply the same startup-command rewrite the standalone host does,
  BEFORE forwarding to the Go child, so a panel-group terminal's PTY runs `tmux attach` instead of a
  bare shell. The rewrite logic (session derivation, view-session grouping, aggressive-resize,
  status-off) must not be duplicated — extract it into a shared helper and call it from both hosts.
- **Implementation:**
  1. Extract the command-rewrite block from `GoPtyFleetProjection.create()`
     (`goPtyFleetProjection.ts:218-282`) into a shared function, e.g.
     `wrapStartupCommandWithTmux(startupCommand, session, name, role): string | undefined` in
     `src/services/teamWiring.ts` (next to `deriveTmuxSessionName`).
  2. `GoPtyFleetProjection.create()` calls the helper instead of inlining the rewrite.
  3. `TaskViewerProvider.handlePtyVerb('ptyCreateTerminal')` resolves the startup command for the role
     (it already has the role; the global-file read is in `GlobalIntegrationConfigService`), derives
     the session via `deriveTmuxSessionName(payload.groupName || payload.teamName || name || role)`,
     calls the helper, and sets `payload.startupCommand` to the rewritten command before forwarding.
     The Go child's `create` does not read `startupCommand` today — it spawns `shell -l` and the
     command is injected by the TS layer. Confirm whether the Go child needs the rewritten command
     passed as a field, or whether the extension host injects it post-spawn the way
     `GoPtyFleetProjection` does (`handle.sendText` at `goPtyFleetProjection.ts:322`).
- **Edge Cases:** The extension host resolves `claudeInlineRendering` from
  `vscode.workspace.getConfiguration` (`TaskViewerProvider.ts:4230`); the tmux gate must read
  `terminal.tmux.enabled` the same way (the standalone host reads it via `configProvider` at
  `bootstrap.ts:3688`). `isTmuxAvailable()` must gate the same way — the extension host has no
  `GoPtyFleetProjection._tmuxSeatingEnabled()`; add an equivalent check. tmux absent → fall back to
  the raw startup command silently (the toggle is an intent, not a guarantee — matches the standalone
  `CreateOptions.tmuxSession` comment at `ptyFleetService.ts:225`).

### 3. Bare-shell creates: decide whether a terminal with no startup command gets tmux

- **Context:** The supplement gates on `effectiveStartupCommand` (`goPtyFleetProjection.ts:230`). A
  bare `+` create with no agent startup command gets a raw shell, no tmux — even with the setting on.
  The plan's Goal says "a handful of seats opened with `+`" should get tmux, but a bare shell has no
  command to wrap.
- **Logic:** This is a scoping decision, not a bug. tmux seating wraps the agent CLI so the board pane
  and `tmux attach` reach the same running agent. A bare shell has no agent to wrap; seating it in
  tmux would run `tmux attach` to an empty session, which is no more useful than the raw shell. The
  current gate is correct IF the operator's intent is "agent seats get tmux." If the intent is "every
  terminal gets a tmux pane regardless," the gate must drop `effectiveStartupCommand` and wrap the
  shell itself.
- **Implementation:** No code change unless the operator wants bare shells seated. Record the
  decision in Outstanding Questions.

### 4. Name reuse must hold for groups as it does for teams

- **Logic:** The supplement uses `tmux new-session -A` (attach-or-create) and `new-window -d`, so a
  restart reattaches to the existing session/window by name. This is already correct for the
  supplement path and needs no change for groups — the session is named for the group, the window for
  the terminal, and `-A` reattaches. Mirror the team reattach branch's guarantee without
  reimplementing it: the supplement's reattach is structural (tmux's own `-A`), not a separate code
  path.

### 5. One resolver, both backends

- **Logic:** Every consumer that resolves a seat by friendly name — dispatch pre-flight, prompt
  delivery, the liveness sweep, pane assignments — already works for the supplement path because the
  seat stays a fleet PTY (the Go child owns it; the tmux client is just what the PTY runs). The
  dispatch and delivery paths resolve by name and already handle tmux-backed seats (the
  `triggerAction`/`sendToTerminal` lookups the 2026-09-08 callout verified). No new resolver is
  needed; the audit is to confirm the extension host's paths resolve the same way after change 2
  lands.

## Verification Plan

### Automated Tests
- **Standalone, setting on:** opening a terminal into a saved panel group creates/joins a tmux
  session named `lc-<group-slug>`, and the pane carries the terminal's name. Verify
  `payload.groupName` reaches `GoPtyFleetProjection.create()` as `opts.tmuxSession`.
- **Standalone, setting off:** no tmux probe, no session, seats are plain PTYs.
- **Standalone, tmux unavailable + setting on:** create succeeds as a PTY, with a log line saying why.
- **Standalone, restart with a group running:** panes and names are reused (`-A` reattach), nothing
  new is created.
- **Extension, setting on:** opening a terminal into a saved panel group creates/joins a tmux session
  named `lc-<group-slug>`. This is the test that catches the divergence — it MUST run against the
  extension host, not just standalone.
- **Extension, setting off:** no tmux, raw shell.
- **Both hosts:** a seat in each backend (tmux supplement vs `terminalBackend: 'tmux'` alternative)
  resolves identically for dispatch, delivery and liveness.

### Goal Invariants
- A terminal created into a locked panel group resolves to a tmux session whose name derives from the
  group name via `deriveTmuxSessionName`, in BOTH the standalone host (`bootstrap.ts:2196`) and the
  extension host (`TaskViewerProvider.ts:4204`).
- **Negative invariant:** in the extension host, a `ptyCreateTerminal` for a panel-group terminal does
  NOT reach the Go child with an unwrapped startup command when `terminal.tmux.enabled` is on and
  tmux is available — the command is wrapped by the shared helper. (Absent this, the extension host
  silently spawns a raw shell and the Goal is unmet while every standalone check is green.)
- A team and a panel group derive their session names from the same function
  (`deriveTmuxSessionName`), so team and group naming cannot drift.
- Turning the setting off is always safe: no tmux calls, no behaviour change, in both hosts.

### Manual
- Standalone: open four terminals, SAVE AS GROUP, confirm `tmux ls` shows a session named for the
  group with four named panes; attach from an SSH client and confirm it is the same terminal the board
  drives.
- Standalone: restart the board; confirm the group reattaches with its names intact.
- Extension: repeat both checks in the VS Code extension host. This is the check that would have
  caught the standalone-only supplement.

## Outstanding Questions

- **[user]** Should a bare-shell terminal (no agent startup command) get a tmux pane when the setting
  is on? The current supplement gates on `effectiveStartupCommand` (`goPtyFleetProjection.ts:230`), so a
  bare `+` create gets no tmux. Proceeding on the assumption that tmux seating is for agent seats
  only (a bare shell has no agent to wrap); if the operator wants every terminal seated, the gate must
  drop the `effectiveStartupCommand` condition and wrap the shell itself.
- **[user]** For extension-host parity (Proposed Change 2), does the rewritten startup command get
  passed to the Go child as a payload field (requiring the Go child's `create` to read and inject it),
  or does the extension host inject it post-spawn via `sendText` the way `GoPtyFleetProjection` does
  (`goPtyFleetProjection.ts:322`)? Proceeding on the assumption that the extension host injects
  post-spawn to match the standalone projection's mechanism and avoid making the Go child
  command-aware.
