# Closing a Terminal Closes Its tmux Session, and Nothing Ever Closes Itself

## Goal

Every tmux session Switchboard created is visible in the Terminals panel — the sidebar and
the tmux tab — including sessions with no seat behind them. Closing a terminal closes its tmux
session; closing a team closes the team's sessions. **Nothing is ever closed automatically, on
any signal, ever.** The operator sees all of it and decides.

### Problem analysis

Sessions accumulate without bound and nothing shows the operator that they have. Measured on
this host 2026-09-12: **18 tmux sessions against 5 live seats**, and `lc-coding-team` alone held
**15 windows for 4 seats** — three full generations plus three stray `bash` windows. 35 `devin`
processes were resident. The operator had no surface that showed any of this; the board's
Terminals panel lists seats, and a session with no seat is invisible there.

Two concrete defects produce it.

**1. Closing a terminal does not close its tmux session.** `ptyCloseTerminal` reaches
`fleet.close()` (`cmd/switchboard-pty-host/main.go:573`), which deletes the terminal from the
fleet maps, calls `killProcessTree(t)` and closes the pty. It never issues `kill-session`.
Verified: closing all four Coding seats through the verb left `lc-coding-team` running with its
15 windows and its `devin` processes alive. So "close" means "stop rendering it" — the session
keeps running and drops out of every surface at the same moment, which is the worst of both.

> **Superseded:** The tmux tab does not list sessions. `listTmuxSessions` is referenced by no webview file at all. The backend can enumerate what is running and nothing asks it to.
>
> **Reason:** This diagnosis is factually wrong. The tmux tab IS wired and DOES list sessions. `terminals.js:501` calls `fetch('/terminals/verb/tmuxListSessions', ...)`, and `renderTmuxSessions()` (`terminals.js:539`) renders the results into `#tmux-sessions-list` (`terminals.html:3183`). The tab shows one row per team with window count, attach command (copy-only), a copy-only `tmux kill-session` command string, and a "Build 4-up grid" button. The `tmuxListSessions` verb is handled in both composition roots (`TaskViewerProvider._handleTmuxVerb:1822` for the extension, `bootstrap.ts:3773` for standalone). The real gaps are: (a) the kill command is copy-only — no executable close control; (b) no `#{session_attached}` indicator is shown; (c) the sidebar (Agents tab) does not show seatless sessions. The tab lists; it just can't close and doesn't show attached status.
>
> **Replaced with:** The tmux tab lists sessions but cannot close them. The kill command is a copy-only string (`terminals.js:563`); the operator must paste `tmux kill-session -t <base>` into a shell manually. No `#{session_attached}` indicator is shown — the `PANE_FORMAT` (`tmuxBackend.ts:237`) does not include it, and `TmuxTeamSession` has no `attached` field. The sidebar lists seats from the fleet, not sessions from tmux, so a session with no live seat is invisible there. The backend can enumerate and the tab can display, but neither can close, and neither shows whether a human is attached.

Together: sessions are created freely, closing a seat does not remove one, and the operator must `tmux ls` in a shell to discover the sprawl. The tmux tab shows the count but offers no executable close, and the sidebar shows only seats — so a seatless session is invisible in the primary panel.

### Root cause

tmux sessions deliberately outlive the board — that is the durability property the seating design
is built on, and it is correct. But "outlives the board" was allowed to mean "outlives everything,
answerable to nothing". No surface owns the list and no operator action ends one.

### Non-goals

- **Automatic closing. Of anything. On any signal.** See the invariant below — this is the
  load-bearing constraint of this plan, not a preference.
- **Changing the durability property.** A board restart must still leave every session untouched.
  The only thing that closes a session is an operator closing it.
- **Changing seat creation, the control-mode chain, or the grouped base/view topology.** A seat
  legitimately costs a base session plus a grouped view; that is what keeps each seat's pane
  pinned to its own window and is out of scope here.

## Metadata

- **Complexity:** 6
- **Tags:** terminals, tmux, ux, standalone

## User Review Required

None.

## The invariant that outranks every other line in this plan

**No code path may close a tmux session except an operator action in the Terminals panel.**

Not a sweep, not a timer, not a startup reconciliation, not a "no seat references this" check, not
an idle-CPU threshold, not an age threshold. There is no heuristic anywhere in this plan and none
may be added to it.

This is written this strongly because the alternative was tried by hand on 2026-09-12 and
destroyed a session an operator was actively working in. The reasoning was *"the board's fleet
does not list this seat, so nobody is using it."* Every input to that judgement was wrong in a way
that looked right:

- The fleet registry had been emptied by a pty-host crash earlier that day — a **known** failure,
  diagnosed the same morning. Registry absence meant "the registry lost its state", never
  "the seat is gone".
- `#{session_attached}` was **1** on the session. A client was connected. It was printed and read
  past.
- The agent was idle at ~0.75% CPU, which is indistinguishable from a human thinking.

Every cheap signal available — seat absence, silence, low CPU, age — reads identically for
"finished" and "someone is mid-sentence". That is why the answer is an operator action and not a
better heuristic.

## Complexity Audit

### Routine

- Adding `tmuxViewSession` string field to the Go `terminal` struct (`main.go:27`) and passing it in the `ptyCreateTerminal` payload from `goPtyFleetProjection.ts:312`.
- Adding `tmux kill-session -t <view>` to `fleet.close()` (`main.go:573`) behind a `controlMode` check.
- Adding a `tmuxKillSession` verb to `_handleTmuxVerb` (`TaskViewerProvider.ts:1813`) and the standalone verb handler (`bootstrap.ts:3773`), both calling a shared `killTmuxSession()` in `tmuxBackend.ts`.
- Appending `tmux kill-session -t <base>` to `closeTeam()` (`terminals.js:10428`) after the per-member fan-out.
- Adding `#{session_attached}` to `PANE_FORMAT` (`tmuxBackend.ts:237`), surfacing it through `TmuxPane` → `listTmuxSessions` → `TmuxTeamSession`, and rendering it in `renderTmuxSessions` (`terminals.js:539`).

### Complex / Risky

- **Data race on `sessionTarget`.** The Go host's `terminal.sessionTarget` (`main.go:72`) is publish-only — written in `publish()` on the read goroutine, no lock. The plan avoids this by adding a new `tmuxViewSession` field set once at create time under `f.mu`, never modified. `sessionTarget` must NOT be used by `fleet.close()`.
- **Composition-root divergence.** The per-seat close path differs structurally between hosts: standalone goes through `GoPtyFleetProjection.kill()` (`goPtyFleetProjection.ts:480`) → Go host; extension goes through `_ptyHostVerb()` (`TaskViewerProvider.ts:672`) → Go host directly. The Go host's `fleet.close()` is the common denominator — putting `kill-session` there covers both. But the `tmuxKillSession` verb (for the tmux tab close control) must be wired in both `_handleTmuxVerb` and the standalone verb handler.
- **`#{session_attached}` is a new field through four layers** (`PANE_FORMAT` → `TmuxPane` → `TmuxTeamSession` → render), not a wiring job. Each layer must be extended; a shortcut at any layer produces a silent default (the fallback rule in AGENTS.md).
- **The invariant test must distinguish executable `kill-session` calls from display strings.** `renderTmuxSessions` (`terminals.js:563`) already contains the literal string `tmux kill-session -t ${base}` as a copy-only command shown to the operator. A naive grep for `kill-session` false-positives on this display string.
- **Last-window-close destroys the entire group (research-confirmed pre-existing hazard).** Grouped sessions share one window list; emptying it through any member calls `server_destroy_session_group()`, killing base and all views. An agent exiting its last shell takes down the team. This is existing tmux behavior, not introduced by this plan. Mitigation (`remain-on-exit on` on the base) is a seat-creation change — a non-goal here, documented as a follow-up.
- **Target resolution uses prefix matching by default.** All `kill-session` calls must use the `=` exact-match prefix (for names) or `#{session_id}` (for team close) to prevent `-t lc-coding-team` matching `lc-coding-team-coder-1`. Both the Go host (`exec.Command`) and the TS side (`run(['kill-session', '-t', '=' + name])`) must apply this.
- **Team close must kill by `#{session_id}`, not name.** The group name outlives the founding session (research confirmed: after killing the base, `#{session_group}` still reports the name but no session by that name exists). Team close must enumerate sessions via `list-sessions -F '#{session_group}:#{session_id}'` and kill by ID. Additionally, issue 5180 (pre-3.8) can transiently block sibling targeting during sequential kills — the verb must tolerate "can't find session" and retry.
- **Unqualified tmux commands from inside a seat may hit a sibling (tmux issue 521).** `cmd_find_best_session_with_window()` resolves by `activity_time`, not `$TMUX`. Switchboard's close path is unaffected (runs from Go host with explicit `-t`), but agents issuing unqualified tmux commands may operate on sibling seats. Pre-existing hazard, documented for awareness.

## Edge-Case & Dependency Audit

### Race Conditions

- **`sessionTarget` vs `fleet.close()`.** `sessionTarget` is publish-only (written on the read goroutine in `publish()`, `main.go:454`). `fleet.close()` runs on the verb-handler goroutine. Reading `sessionTarget` from `close()` is a data race. Mitigation: use a new `tmuxViewSession` field set at create time under `f.mu`, never modified after.
- **View session killed while another seat is re-seating.** An operator closes seat A; simultaneously the board re-seats seat B into the same team. If the re-seat creates a new view session, killing A's view does not affect B's. If the re-seat reuses A's view session name (unlikely — the derivation includes the role), the kill would destroy B's session. Mitigation: the view session name is per-seat (`${session}-${suffix}` where suffix is role-derived, `goPtyFleetProjection.ts:264`), so two seats with different roles get different view names. Same-role re-seats use the collision counter (`${role}-${n}`), producing a different friendlyName and thus a different view suffix. The race is theoretical but the naming makes it safe.
- **Unqualified tmux commands from inside a seat may act on a sibling seat (tmux issue 521, confirmed live on 3.4).** When a command client runs inside a pane, `cmd_find_best_session_with_window()` builds a list of every session containing that window and picks the one with the most recent `activity_time` — not the session in `$TMUX`. An agent running `tmux kill-session` or `tmux split-window` without an explicit `-t` may operate on a sibling seat. **Switchboard's close path is not affected** — `fleet.close()` runs `exec.Command("tmux", ...)` from the Go host process, not from inside a pane, and always passes an explicit `-t` target. But agents themselves may issue unqualified tmux commands. This is a pre-existing hazard of the grouped-session topology, not introduced by this plan. A follow-up should inject an explicit target into agent-issued tmux commands or set a per-session `@switchboard_session_id` user option the agent's wrapper reads.

### Security

- **`tmux kill-session -t <name>` reaches tmux argv.** The session name must be validated against `TMUX_SESSION_NAME_RE` (`^lc-[a-z0-9_-]+$`, `tmuxBackend.ts:379`) before interpolation, the same validation `buildTmuxGrid` already applies (`tmuxBackend.ts:402`). The Go host's `kill-session` must use `exec.Command("tmux", "kill-session", "-t", "=" + name)` — argv array, no shell, no interpolation. The `=` prefix forces exact-match targeting (research confirmed: `target-session` tries prefix matching by default, which can kill the wrong session — `-t lc-coding-team` could match `lc-coding-team-coder-1`).

### Side Effects

- **Killing a view session detaches any human attached to it.** If `#{session_attached}` is 1 on the view, a human is mid-session. The per-seat close is an operator action (they clicked close), so this is intentional — but the tmux tab close control must show `#{session_attached}` so the operator knows before closing.
- **Killing the base session kills all grouped views.** `tmux kill-session -t <base>` takes every grouped view with it. The team close (§2) and the tmux tab close control (§3) must make this clear in the UI — "Close team session (kills all views)" not just "Close."
- **Spurious `%window-close` on view kill (confirmed by research, non-issue for Switchboard).** Killing a view session sends spurious `%window-close` notifications to control clients attached to the *base* session, for windows that still exist. In Switchboard's architecture, the board's control-mode clients are attached to *view* sessions (`exec tmux -u -CC attach -t ${view}`, `goPtyFleetProjection.ts:309`), not the base. The base is attached by the operator's SSH client, which is not in control mode and does not parse control protocol. The Go host's parser (`main.go:508-516`) forwards `%window-close` to the browser via `broadcastControl`, but the browser does not handle `window-close` events (no handler in `terminals.js`). So the spurious notification is received by the operator's SSH client (harmless — it renders as nothing) and forwarded to a browser that ignores it. No action needed.
- **Last-window-close destroys the entire group (confirmed by research, pre-existing risk).** Grouped sessions share one window list. Emptying it — by closing the last window through *any* group member — calls `server_destroy_session_group()`, not `server_destroy_session()`, killing base and all views simultaneously. If an agent exits its last shell, the entire team dies. This is existing tmux behavior, not introduced by this plan. Mitigation (`remain-on-exit on` on the base session) is a seat-creation change, which is a non-goal here. The plan documents this as a known risk; a follow-up should set `remain-on-exit on` on the base session at creation time so an agent exiting its shell does not take down the team.
- **`new-session -t <group>` spawns a transient window (confirmed by research).** Joining a group always creates a real initial window and shell process, then synchronizes it away and destroys it. Control clients observe `%unlinked-window-add` followed by `%unlinked-window-close`. The transient window ID appears in the notification stream the Go host's parser (`controlmode.go`) processes. This is a seat-creation side effect, not introduced by this plan, but the parser must tolerate these transient notifications (it already does — `%unlinked-window-add` and `%unlinked-window-close` are in `knownControlTypes`, `controlmode.go:128-130`).

### Dependencies & Conflicts

- `seat-a-team-into-a-switchboard-owned-tmux-session.md:64` already specifies "a team stop must `kill-session` to clean up" — this plan implements that specification.
- `tmux-windows-duplicate-on-re-seat-and-nothing-reaps-orphaned-sessions.md` addresses the window-duplication problem on re-seat. This plan does not address duplication; it addresses closing. The two plans are complementary — this plan makes closing work, that plan makes re-seating not duplicate.
- The `PANE_FORMAT` change (adding `#{session_attached}`) shifts field indices. `listTmuxPanes` (`tmuxBackend.ts:282`) checks `fields.length < 9` — adding a field makes it 11, and the parser must be updated to read the new index. Any other consumer of `listTmuxPanes` that hardcodes field indices must be audited.

## Dependencies

- None. This plan is self-contained.

## Adversarial Synthesis

Key risks: (1) the original plan misdiagnosed the tmux tab as unwired — it IS wired, so §3 is "add close control + attached indicator" not "wire the tab"; (2) the Go host needs a new `tmuxViewSession` field set at create time — `sessionTarget` is publish-only and racing with `close()` is a data race; (3) per-seat close must kill the view only, not collapse the base — base collapse fights the invariant and duplicates grouping logic in Go; (4) the invariant test must scope to executable `kill-session` calls, not display strings; (5) research confirmed `kill-session -t <view>` kills only that session and the group survives — the plan's Approach A is sound; (6) research found a pre-existing hazard: closing the last window through any group member destroys the entire group — documented as a known risk, mitigation is a follow-up (`remain-on-exit on`); (7) research found spurious `%window-close` on view kill — non-issue for Switchboard (control clients are on views, not the base; browser doesn't handle `window-close`); (8) `destroy-unattached keep-group` was considered and rejected — it violates the invariant (automatic close on detach) and has a sharp edge (destroys already-detached sessions immediately); (9) research found tmux issue 521: unqualified tmux commands from inside a grouped pane resolve by activity time, not `$TMUX` — Switchboard's close path is unaffected (runs from Go host with explicit `-t`) but agents may hit sibling seats; (10) team close must kill by `#{session_id}` not name — the group name outlives the founding session, and issue 5180 (pre-3.8) can transiently block sibling targeting during sequential kills; (11) `#{session_group_attached}` is a simpler single-read alternative for team-level occupancy than aggregating per-member `session_attached`. Mitigations: supersede diagnosis #2 and §1's architecture; add `tmuxViewSession` at create time; kill the base only on explicit team/tab close; scope the test to `exec.Command` / `run()` call sites; use `=name` exact-match for per-seat close and `#{session_id}` for team close; tolerate "can't find session" on sequential team-close kills.

## Proposed Changes

### 1. `fleet.close()` kills the view session (`cmd/switchboard-pty-host/main.go:573`)

> **Superseded:** When the terminal being closed is tmux-backed, issue `kill-session` for its view session after tearing down the pty, and `kill-session` for the base session when no other view remains grouped to it. The seat's view session name is already derived deterministically (`deriveTmuxSessionName`), so no new state is needed to find it.
>
> **Reason:** Three problems. (1) The Go host's `terminal` struct has no tmux session name field; `sessionTarget` (`main.go:72`) is learned from control-mode `%session-changed` at runtime and is publish-only (no lock) — reading it from `fleet.close()` is a data race. (2) `deriveTmuxSessionName` is a TypeScript function (`teamWiring.ts:268`); the Go host cannot call it. (3) The base-collapse ("kill the base when no other view remains") requires querying tmux for group membership, duplicating the TS-side grouping logic (`listTmuxSessions`, `tmuxBackend.ts:328`) in Go, in a language with no existing tmux shell-out helper. Additionally, collapsing a shared resource (the team base) as a side-effect of a per-seat action fights the plan's own invariant.
>
> **Replaced with:** Per-seat close kills the view session only. The base is killed by explicit team close (§2) or the tmux tab close control (§3) — both operator actions on the team/session, not side-effects of a per-seat close.

**Implementation:**

- Add a `tmuxViewSession` string field to the `terminal` struct (`main.go:27`), set from the `ptyCreateTerminal` payload at create time (`main.go:218`), under `f.mu`. This field is write-once (set at create, never modified) — no race with `publish()`.
- In `fleet.close()` (`main.go:573`), after `killProcessTree(t)` and before `t.file.Close()`, if `t.controlMode && t.tmuxViewSession != ""`, issue `exec.Command("tmux", "kill-session", "-t", "=" + t.tmuxViewSession).Run()`. The `=` prefix forces exact-match targeting (research confirmed: bare prefix matching can kill the wrong session — `-t lc-coding-team` could match `lc-coding-team-coder-1`). Swallow the error (the session may already be gone — a non-tmux terminal or a session that exited independently). Use `exec.Command` with an argv array — no shell, no interpolation.
- The standalone host passes `tmuxViewSession` in the `ptyCreateTerminal` payload. `GoPtyFleetProjection.create()` (`goPtyFleetProjection.ts:312`) already derives `const view = ${session}-${suffix}` at line 264; add `tmuxViewSession: view` (or `tmuxViewSession: usesControlMode ? view : ''`) to the payload object at line 312-323.
- The extension host does not set `controlMode` (confirmed: `main.go:53` comment — "the extension host never sets it"), so `tmuxViewSession` is empty for extension terminals and `fleet.close()` skips the `kill-session`. No extension-side change needed for the per-seat close.

**Edge cases:**
- A non-tmux terminal (`controlMode == false`) triggers no `kill-session` — unaffected.
- A tmux terminal whose view session already exited (the agent process died, tmux cleaned up): `kill-session` returns "no such session"; the error is swallowed.
- A tmux terminal whose `tmuxViewSession` is empty (the field was not passed — e.g., an older create payload from before this change): no `kill-session`, no crash. The field is empty, the check fails, `close()` proceeds as before.

### 2. A team close kills the team's base session

Closing a team from the Terminals panel closes each member's view session (via §1's per-seat close, which `closeTeam()` already fans out — `terminals.js:10436`) and then the team's base session. This is the case `seat-a-team-into-a-switchboard-owned-tmux-session.md` already names — "a team stop must `kill-session` to clean up" — which was specified and never implemented.

**Implementation:**

- After the `teamFanOut` loop in `closeTeam()` (`terminals.js:10436`), resolve the team's sessions by **session ID**, not by name. Research confirmed two hazards with name-based targeting in a group: (a) the group name outlives the founding session — after killing the base, `#{session_group}` still reports `lc-coding-team` but no session by that name exists, so a subsequent `kill-session -t =lc-coding-team` fails; (b) issue 5180 (fixed in 3.8 only) can leave grouped sessions as unusable command targets during sequential kills. Killing by `#{session_id}` (`$N`) sidesteps both.
- The `tmuxKillSession` verb (see §3) should accept either a session name or a session ID. For team close, call it with session IDs resolved via `list-sessions -F '#{session_group}:#{session_id}'`, filtering to the team's group. This is the portable form the report recommends (works on 3.3a–3.7c; `kill-session -g` requires 3.7+ which the Pi likely does not run):
  ```
  tmux list-sessions -F '#{session_group}:#{session_id}' \
    | grep "^${group}:" | cut -d: -f2 \
    | while read -r id; do tmux kill-session -t "$id"; done
  ```
  In TS: `run(['list-sessions', '-F', '#{session_group}:#{session_id}'])`, filter lines starting with `${group}:`, extract the session ID, call `run(['kill-session', '-t', id])` for each. Swallow "can't find session" on later iterations (issue 5180: a session killed earlier in the loop may transiently block targeting of its siblings on pre-3.8 tmux).
- The UI label for team close should make clear that it kills the base (and thus all remaining grouped views): "Close team (kills all sessions)" not just "Close team."

**Edge cases:**
- The base session may already be gone (all views were killed and someone manually killed the base): the verb swallows "can't find session."
- Stray windows in the base session (the 3 stray `bash` windows from the problem analysis): `kill-session` by ID kills the session and all its windows, including strays. This is the correct behavior — the operator is closing the team, and strays are part of the team session.
- Sequential kill on pre-3.8 tmux (issue 5180): killing one group member may transiently make siblings unusable as command targets. Killing by session ID (not name) and tolerating "can't find session" on retry handles this. The `tmuxKillSession` verb should retry once on "can't find session" before giving up, since the target may become usable on the next tick.

### 3. The tmux tab gets an executable close control and an attached indicator (`src/webview/terminals.html:3163`, `src/webview/terminals.js:539`)

The tmux tab already lists sessions (one row per team, `renderTmuxSessions` at `terminals.js:539`). The kill command is currently a copy-only string (`terminals.js:563`). This change replaces the copy-only kill with an executable close button, and adds a `#{session_attached}` indicator to each row.

**Implementation — close control:**

- Replace the copy-only `killRow` (`terminals.js:573-577`) with a close button: `<button class="tmux-close-btn" data-close-session="${escapeHtml(base)}">Close session</button>`. The button calls the new `tmuxKillSession` verb via `fetch('/terminals/verb/tmuxKillSession', { method: 'POST', body: JSON.stringify({ name: base }) })`, then refreshes the list (`fetchTmuxSessions()` → `renderTmuxSessions()`). The `tmuxKillSession` verb applies `=name` exact-match targeting internally (see §3 verb implementation).
- The close button label for a team base should warn: "Close session (kills all views)" — killing the base takes every grouped view with it.

**Implementation — `tmuxKillSession` verb (both composition roots):**

- New verb `tmuxKillSession` in `_handleTmuxVerb` (`TaskViewerProvider.ts:1813`): accepts either a session name (validated against `validateTmuxSessionName` (`tmuxBackend.ts:382`)) or a session ID (`$N` format, passed through without validation since tmux assigns it). Calls a new `killTmuxSession(target, socket)` function in `tmuxBackend.ts`, returns `{ success: true }` or `{ success: false, error }`.
- New `killTmuxSession(target: string, socket?: TmuxSocket)` in `tmuxBackend.ts`: if `target` starts with `$` (session ID), calls `run(['kill-session', '-t', target], socket)` directly. Otherwise calls `run(['kill-session', '-t', '=' + target], socket)` for exact-name matching. Swallows "can't find session" / "no such session" errors, returns `boolean`. The `=` prefix for names forces exact-match targeting (research confirmed: `target-session` tries session ID, then exact name, then unique prefix, then glob — a bare prefix can match the wrong session).
- Mirror verb in the standalone handler (`bootstrap.ts:3773`): same validation, same `killTmuxSession()` call. Both hosts share the `tmuxBackend.ts` function — the verb handler is the seam that must be wired in both.

**Implementation — `#{session_attached}` indicator (four layers):**

1. `PANE_FORMAT` (`tmuxBackend.ts:237`): add `'#{session_attached}'` as the 11th field (after `'#{session_group}'`).
2. `TmuxPane` interface (`tmuxBackend.ts:32`): add `sessionAttached: string;` (tmux returns a decimal string: `"0"`, `"1"`, `"2"`, or empty string when no session is in scope — treat empty and `"0"` as equivalent, per research).
3. `listTmuxPanes` (`tmuxBackend.ts:283`): read `fields[10]` into `sessionAttached`. Update the `fields.length < 9` guard to `< 11`.
4. `listTmuxSessions` (`tmuxBackend.ts:328`): surface `attached` on `TmuxTeamSession` — set it to `true` if ANY member session of the group has `sessionAttached` that is non-empty and not `"0"` (a human attached to any view or the base). Research confirmed: `list-panes -a` emits one row per pane per group member, so the same pane appears multiple times with different `sessionAttached` values (the base row shows the base's count, the view row shows the view's count). The existing grouping logic in `listTmuxSessions` already deduplicates members by `sessionName`, so the aggregation across group members is the correct approach.
5. `TmuxTeamSession` interface (`tmuxBackend.ts:312`): add `attached: boolean;`.
6. `renderTmuxSessions` (`terminals.js:559`): show an attached indicator in each row — e.g., a dot or label "attached" when `team.attached` is true. This is the one fact that tells an operator a human is inside a session before they close it.
7. `_handleTmuxVerb` (`TaskViewerProvider.ts:1822`) and the standalone handler (`bootstrap.ts:3773`): include `attached` in the `tmuxListSessions` response payload.

> **Simpler alternative: `#{session_group_attached}`.** Research found that `#{session_group_attached}` sums `s->attached` across all group members in a single format read — no client-side aggregation needed. Adding it to `PANE_FORMAT` instead of (or alongside) `#{session_attached}` would let `listTmuxSessions` set `attached = (groupAttached !== "0")` directly, without iterating members. This is the report's recommendation #6. The trade-off: `#{session_group_attached}` gives team-level occupancy (any member attached), not per-session detail. For the tmux tab (which shows one row per team), team-level is exactly what is needed. Consider using `#{session_group_attached}` as the primary field and `#{session_attached}` as a secondary field if per-session detail is later needed.

> **Alternative considered: `list-sessions -F` instead of extending `PANE_FORMAT`.** Research recommends `list-sessions -F '#{session_id} #{session_name} #{session_attached} #{session_group}'` as giving one row per session with no duplication — cleaner than `list-panes -a` for per-session data. The existing `listTmuxSessions` is built on `listTmuxPanes` and already handles the duplicate rows by grouping on `sessionGroup`. Switching to `list-sessions` would require a parallel parsing path and a second tmux invocation. The `PANE_FORMAT` extension is the smaller, more consistent change for this plan. If the duplicate-row handling proves fragile in practice, switching to `list-sessions -F` is the fallback — it eliminates the deduplication logic entirely. A third option from the report: `refresh-client -B` subscriptions on a format, reported via `%subscription-changed` at most once a second, replacing polling — but this adds protocol-parsing work and is out of scope for this plan.

**Edge cases:**
- `#{session_attached}` is per-session; a group has multiple sessions (base + views). The indicator should show "attached" if ANY member has a client — the operator needs to know before closing the base (which kills all views).
- A session with `session_attached == 0` but an agent process still running: the indicator shows "not attached," which is correct — no human client is connected, only the agent process. The operator can close safely.

### 4. The sidebar shows seatless sessions too

A session with no seat currently appears nowhere in the sidebar (Agents tab). It must appear, visibly marked as having no seat, with the same close control. The count in the panel header reflects sessions, not just seats, so sprawl is visible without opening the tmux tab.

**Implementation:**

- `renderSidebarList()` (`terminals.js:5324`) currently renders from `fleetList` (the fleet's terminal list). After the fleet list is fetched, also fetch `tmuxListSessions` and merge: for each `TmuxTeamSession`, find matching seats in `fleetList` by matching the session's window names against terminal friendlyNames. Sessions whose windows have no matching live seat are "seatless."
- Render seatless sessions as sidebar rows with a "no seat" marker and a close button (same `tmuxKillSession` verb as §3).
- The panel header count (`sidebar-header`, `terminals.html:3036`) should show "N sessions" (from `tmuxListSessions`) alongside "N seats" (from `fleetList`), so sprawl is visible without opening the tmux tab.

**Edge cases:**
- `tmuxListSessions` returns only `lc-` prefixed groups (`tmuxBackend.ts:338`). The operator's own tmux sessions (non-`lc-`) are not shown — this is correct, the board does not publish sessions it didn't create.
- A team with some live seats and some seatless windows: the live seats appear as normal sidebar rows; the seatless windows appear as "no seat" rows under the same team. The operator sees the full picture.

### 5. Both composition roots

> **Superseded:** `listTmuxSessions` and the close path are reached through `TaskViewerProvider` (`:1823`) and `tmuxBackend.ts`, which both hosts share, and the close verb is the Go host's. The wiring must be present in both `src/extension.ts` and `src/standalone/bootstrap.ts`; a panel that lists sessions on one host and not the other reproduces the invisibility on the other host. The standalone host is the primary target, but the seam is registered in both.
>
> **Reason:** The `tmuxListSessions` verb is ALREADY wired in both roots (`TaskViewerProvider._handleTmuxVerb:1822` for extension, `bootstrap.ts:3773` for standalone) — the plan's claim that it needs wiring is stale. The per-seat close path (`fleet.close()` in the Go host) is the common denominator for both hosts — the extension never sets `controlMode` (`main.go:53`), so its terminals are raw and `fleet.close()` skips `kill-session` for them. The new `tmuxKillSession` verb (§3) is the one seam that must be wired in both roots, because both hosts can list sessions (the tmux server is shared) and the operator may close a session from either host's tmux tab.
>
> **Replaced with:** The `tmuxListSessions` verb is already wired in both roots — no change needed. The per-seat `kill-session` lives in the Go host's `fleet.close()` (shared by both hosts; the `controlMode` flag gates it — extension terminals are raw, standalone tmux seats are control-mode). The new `tmuxKillSession` verb must be added to both `_handleTmuxVerb` (`TaskViewerProvider.ts:1813`) and the standalone verb handler (`bootstrap.ts:3773`), both calling the shared `killTmuxSession()` in `tmuxBackend.ts`. The `tmuxViewSession` field is passed in the `ptyCreateTerminal` payload by `GoPtyFleetProjection.create()` (`goPtyFleetProjection.ts:312`), which is standalone-only (the extension doesn't use `GoPtyFleetProjection` for creates — it goes through `_ptyHostVerb` directly, and doesn't set `controlMode`).

## Verification Plan

### Automated Tests

1. **New** `src/test/tmux-session-close-contract.test.js`, wired as
   `test:contract:tmux-session-close` **and invoked from `.github/workflows/integration-tests.yml`**
   (defining it in `package.json` alone is not a gate). Asserts: `fleet.close()` issues
   `kill-session` for a control-mode terminal's `tmuxViewSession`; a non-control-mode terminal
   triggers no `kill-session`; the `tmuxKillSession` verb validates the session name and issues
   `kill-session`; an invalid name is rejected.
2. **The invariant, as a test:** assert that `kill-session` is reachable only from (a) `fleet.close()`
   in the Go host (the per-seat close path) and (b) `killTmuxSession()` in `tmuxBackend.ts` (the
   `tmuxKillSession` verb, called by the tmux tab close control and team close). **No timer, sweep,
   interval, or startup reconciliation may call `killTmuxSession()` or issue `tmux kill-session`.**
   The test must scope to executable call sites (`exec.Command("tmux", "kill-session", ...)` in Go;
   `run(['kill-session', ...]` in `tmuxBackend.ts`) — NOT to the display string `tmux kill-session -t ${base}`
   in `renderTmuxSessions` (`terminals.js:563`), which is a copy-only command shown to the operator.
   This is the gate that stops an automatic reaper being added later by someone who thinks it is
   an improvement.
3. Source-text assertion that `renderTmuxSessions` (`terminals.js:539`) renders an attached
   indicator from `team.attached`, and that the close button calls the `tmuxKillSession` verb (not
   a copy-to-clipboard fallback).
4. Source-text assertion that `PANE_FORMAT` (`tmuxBackend.ts:237`) includes `#{session_attached}`,
   that `TmuxPane` has `sessionAttached`, and that `TmuxTeamSession` has `attached`.
5. Source-text assertion that `closeTeam()` (`terminals.js:10428`) calls `tmuxKillSession` for the
   base session after the per-member fan-out.
6. Regression: `test:contract:tmux-view-chrome`, `test:contract:tmux-backend`,
   `test:contract:pty-host-blackbox` stay green (rebuild the host binaries first — the blackbox
   suite spawns from `dist/`).
7. `npm run compile-tests` before any `test:contract:*` run.

### Goal Invariants

- Closing a terminal in the panel leaves **zero** view sessions behind for that seat — the seat's
  view session is gone from `tmux ls`. (The base session is shared and persists until team close or
  tmux tab close — this is by design, not a leak.)
- Closing a team leaves zero sessions for that team — base and all views — verified with `tmux ls`.
- A board restart closes **nothing** — session count and agent pids are identical across it.
- Every `lc-` session `tmux ls` reports is present in the tmux tab, including seatless ones.
- Every `lc-` session with no live seat is present in the sidebar, marked "no seat."
- No automatic close exists: `killTmuxSession()` and `exec.Command("tmux", "kill-session", ...)`
  are reachable only from the operator close paths (`fleet.close()` and the `tmuxKillSession` verb).

## Resolved Assumptions

The following were confirmed by web research against the tmux source (`tmux/tmux` at `e880cf6`, 3.8-dev) and live tests on tmux 3.4:

- **`tmux kill-session -t <view>` on a grouped view session kills only that session.** Confirmed: `cmd_kill_session_exec()` calls `server_destroy_session(s)` + `session_destroy(s, 1, ...)` with no group awareness. `session_destroy()` calls `session_group_remove()` for the one session, then walks winlinks calling `window_remove_ref()`. Shared windows survive because every other group member holds its own winlink reference. Verified live on 3.4: after killing `view1`, `base` and `view2` retained both windows with unchanged PIDs.
- **`#{session_attached}` is valid in `list-panes -a -F`.** Confirmed: `cmd_list_panes_server()` iterates sessions and every pane row goes through `format_defaults()` with a non-NULL session, so every session-scoped format is available. Returns a decimal string (`"0"`, `"1"`, `"2"`); empty string when no session is in scope (treat empty and `"0"` as equivalent).
- **The group survives killing one member.** Confirmed: `session_group_remove()` removes one entry from the TAILQ and frees the `session_group` struct only when `TAILQ_EMPTY`. Killing down to a single member leaves `session_grouped=1` with `session_group_size=1`.
- **No version differences in the single-session kill path.** Confirmed: `cmd_kill_session_exec()`'s `else` branch is byte-identical from 3.0a through 3.8-dev.
- **`kill-session -g` (kill whole group) requires tmux 3.7+.** The Pi likely runs 3.5a (Raspberry Pi OS trixie). Team close must enumerate and kill each member individually, not use `-g`.
- **`list-panes -a` emits one row per pane per group member.** Confirmed: a two-window base with two views produces six rows for two real panes. The same `pane_id` appears multiple times with different `session_attached` values. The existing `listTmuxSessions` grouping logic handles this by deduplicating on `sessionName`.
- **Target resolution uses prefix matching by default.** Confirmed: `target-session` tries session ID, then exact name, then unique prefix, then glob. The `=` prefix forces exact match for name-based targeting. For team close, killing by `#{session_id}` (`$N`) is safer — it sidesteps prefix matching, the group-name-outlives-session trap, and rename races.
- **Unqualified tmux commands from inside a grouped pane resolve by activity time, not `$TMUX` (tmux issue 521).** Confirmed live on 3.4: a shell spawned by session `$0` ran `tmux display-message -p '#S'` and got `$1` (sibling session with newer activity). `cmd_find_best_session_with_window()` ranks by `activity_time`, not by `$TMUX` session ID. Switchboard's close path is unaffected (runs from the Go host, not inside a pane, with explicit `-t`), but agents issuing unqualified tmux commands may hit sibling seats. Pre-existing hazard, not introduced by this plan.
- **`new-session -t <group>` spawns a transient window.** Confirmed: joining a group always creates a real initial window and shell, then synchronizes it away. Control clients observe `%unlinked-window-add` / `%unlinked-window-close`. The Go host's parser already handles these (`controlmode.go:128-130`).
- **`destroy-unattached keep-group` on an already-detached session destroys it immediately.** Confirmed: `server_check_unattached()` runs on the next option change and sees zero attached clients. The option must be set while a client is attached, or at session creation. A webview reload or network blip that briefly detaches would evaporate the seat — another reason this mechanism was rejected.
- **Issue 5180 (3.8 fix): grouped sessions left as unusable command targets while being killed.** Confirmed via CHANGES entry. On pre-3.8 tmux, killing one group member may transiently block targeting of its siblings. Team close must tolerate "can't find session" on sequential kills and retry.

### Considered and rejected: `destroy-unattached keep-group`

Research found that `destroy-unattached keep-group` (tmux 3.4+) auto-destroys a view session when its last client detaches, leaving the base alive as the group's last member — no explicit `kill-session` needed. This was considered as the primary per-seat cleanup mechanism and **rejected** for two reasons. (1) It violates this plan's invariant: "No code path may close a tmux session except an operator action in the Terminals panel." `destroy-unattached` closes the view on the "last client detached" signal — that is an automatic close, not an operator action. (2) Research found a sharp edge: setting `destroy-unattached` on an **already-detached** session destroys it immediately, because `server_check_unattached()` runs on the next option change and sees zero attached clients. A webview reload or network blip that briefly detaches the control client would evaporate the seat. The explicit `kill-session` in `fleet.close()` (triggered by the operator clicking close) is the correct mechanism: it is synchronous, works on every tmux version, and the close decision stays in Switchboard where it is observable.

## Uncertain Assumptions

The following remain uncertain after research; the user was advised to confirm them before implementation:

- The exact tmux version on the target Pi. Raspberry Pi OS bookworm ships 3.3a (no `keep-group`), trixie ships 3.5a. This plan does not depend on 3.4+ features (explicit `kill-session` works on all versions), but a follow-up setting `remain-on-exit on` on the base session should confirm the version first.

## Outstanding Questions

- **[user]** Should the per-seat close also collapse the base when it is the last view, or is
  leaving the base for explicit team close / tmux tab close acceptable? — proceeding on the
  assumption that per-seat close kills the view only (the base is a shared team resource, and
  collapsing it as a side-effect of a per-seat action fights the plan's invariant).

## Implementation Summary

Implemented all five sections. Go host (`main.go`): added `tmuxViewSession` field (write-once at create under `f.mu`), `fleet.close()` now takes `killTmuxView bool` — `ptyCloseTerminal` passes `true` (kills the seat's VIEW session via `exec.Command("tmux","kill-session","-t","="+view)`), `dispose()` passes `false` (process exit never kills sessions). TypeScript projection (`goPtyFleetProjection.ts`): passes `tmuxViewSession: view` in the create payload. tmuxBackend (`tmuxBackend.ts`): added `killTmuxSession()` (validates name, `=` exact-match; `$N` IDs pass through; swallows "can't find session"), `killTmuxSessionGroup()` (enumerates group members by `$N` session ID via `list-sessions -F '#{session_group}\x1f#{session_id}'`, kills each), `#{session_attached}` in `PANE_FORMAT`, `sessionAttached` on `TmuxPane`, `attached` on `TmuxTeamSession`. Both composition roots (`TaskViewerProvider.ts` + `bootstrap.ts`): wired `tmuxKillSession` and `tmuxKillSessionGroup` verbs, `attached` in `tmuxListSessions` response. Webview (`terminals.js` + `terminals.html`): executable close button on the tmux tab (calls `tmuxKillSession`), attached badge, `closeTeam()` calls `tmuxKillSessionGroup` after the per-member fan-out, sidebar shows seatless sessions with "no seat" marker and close control, session count in the sidebar header. Contract test (`tmux-session-close-contract.test.js`): pins the invariant (kill-session reachable only from `fleet.close()` and `killTmuxSession`/`killTmuxSessionGroup`), the `killTmuxView` gate, the `$N` session ID targeting, the attached indicator, the close control, and the team-close fan-out order. Compilation and tests skipped per user directive.

## Review Findings

Sections 1, 3, 4 and 5 verified present and correctly wired in both composition roots; §2 (team close) was broken. `killTmuxSessionGroup` split `list-sessions` output on a raw `\x1f`, but tmux vis-escapes that separator and returns the four literal characters `\037` — measured again here on tmux 3.4, the exact trap `splitPaneFields` exists for and which this file's own comment warns against ("Do not 'simplify' it back to a bare split"). Every row failed the `parts.length < 2` guard, `ids` came back empty, and team close killed nothing while returning 0 and reporting success; fixed by routing the parse through `splitPaneFields`. The §1 per-seat kill is correct and — contrary to this plan's spec — correctly NOT gated on `controlMode`, since control mode was later turned off wholesale and that gate had silently disabled close-on-close entirely. The invariant test was real but half-scoped: it pinned where `kill-session` is issued inside `tmuxBackend.ts` and `main.go`, and never checked who CALLS `killTmuxSession()` — so the sibling subtask's boot reaper, a startup sweep, passed it unchanged; I extended it to pin the caller set per composition root. Files changed: `src/standalone/tmuxBackend.ts`, `src/standalone/bootstrap.ts`, `src/test/tmux-session-close-contract.test.js`; verification: `compile-tests` clean, `go build`/`go vet` clean, `tmux-session-close` and `tmux-backend` green.

## Deferred Findings

- CRITICAL — this plan's Goal Invariant ("No automatic close exists ... not a sweep, not a timer, not a startup reconciliation") is violated by the sibling subtask's boot reaper, shipped in the same commit. Narrowed with an attached-client veto, not resolved; escalated on `20ff27e9` for the author to decide which plan wins. `src/standalone/bootstrap.ts:4577`
- MAJOR — `killTmuxSessionGroup` matches on `#{session_group}`, which is EMPTY for an ungrouped session. A solo seat (`lc-planner-1`, no group after the solo-seat change) can never be closed by the group path; only `tmuxKillSession` reaches it. Team close is unaffected, but the tmux tab's per-session control is now the only route for solo seats. `src/standalone/tmuxBackend.ts:519`
- MAJOR — `listTmuxPanes` now drops any row with fewer than 11 fields. If a tmux build ever omits `#{session_attached}` from `list-panes -a -F`, every pane is dropped and the tmux tab, the sidebar's seatless rows and the reaper's session list all go silently empty rather than failing loudly. Verified present on 3.4; unverified below that. `src/standalone/tmuxBackend.ts:283`
- MAJOR — the §2 retry the plan specifies for tmux issue 5180 ("the verb should retry once on 'can't find session'") was not implemented; `killTmuxSessionGroup` tolerates the error but never retries, so a transiently-unusable sibling on pre-3.8 tmux is skipped rather than killed. `src/standalone/tmuxBackend.ts:525`
- NIT — `remain-on-exit on` on the base session, documented in this plan as the follow-up mitigation for "an agent exiting its last shell destroys the whole group", is still not set at seat creation. `src/services/goPtyFleetProjection.ts:409`
