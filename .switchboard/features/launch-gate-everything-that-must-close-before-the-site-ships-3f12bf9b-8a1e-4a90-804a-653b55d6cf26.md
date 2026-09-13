# Launch Gate: Everything That Must Close Before the Site Ships

**Complexity:** 4

## Goal

The defects that make the board unreliable, make the GUI show errors that are not true, or make the first run leak a secret. Ordered: the seating chain first (it both misroutes prompts and silently detaches every seat), then Mission Control (it cannot start, and it gates the site MISSIONS screenshot), then the two GUI-visible defects, then the security chain in its forced order — curl in generated prompts, the CSRF guard, and only then the token deletion.

## How the Subtasks Achieve This

- **Every Prompt to a Team Seat Is Delivered to the Previous Generation's Agent**: Fixes the tmux seating chain that blocks on `new-session -A -d` (which attaches instead of detaching), so prompts reach the seat's own window instead of an orphaned previous-generation agent. Restores correct prompt delivery to all team seats.
- **Mission Control Reads Its Protocols From a Directory Nothing Writes To**: Replaces the hardcoded `.agents/protocols/<name>/SKILL.md` path in the kickoff builder with `ProtocolService.resolveProtocol`, so Mission Control starts with its real runsheet and shared-logic text instead of an apology prompt telling the agent its instructions are missing.
- **The Standing Orders Tab Hydrates Once, Over the One Channel That Can Fail**: Gives the Standing Orders tab a second hydration channel (typed HTTP response body) so it recovers from a dropped WebSocket, and makes the red "no database" line tell the truth about which failure actually occurred.
- **One Shell Load Builds the Board Fourteen Times, Then Discards Half of Them**: Coalesces the fourteen per-connection board builds at shell load into two or three scoped snapshots, so opening the shell stops saturating the host for 2.75 seconds and blocking every other caller (including `/health`).
- **The Host Still Types curl Into Every Lead Prompt**: Replaces seven generated curl strings in lead/team prompts with CLI calls, deletes the port-discovery prose, and migrates the stored standing-order rows to the CLI form — so agents never construct URLs or discover ports by hand.
- **The Host Mirrors Every Turn-End Into an Inbox With No Reader and No Listener**: Moves the host's turn-end reports from a gitignored, write-only file directory into the existing `plan_events` table, giving them a query, referential integrity, and retention for the first time.
- **Starting the Board Prints One Address, Never a Token, and Opens Nothing**: Stops minting and printing a pointless immortal token on every launch, prints one address per serve mode, and deletes the auto-open that starts an orphaned browser nobody looks at. Phase 2 deletes the token machinery entirely after the CSRF guard lands.

## Dependencies & sequencing

- **Seating chain first (Every Prompt to a Team Seat…)**: independent, touches only `goPtyFleetProjection.ts`. Ships first because it both misroutes prompts and silently detaches every seat — every other team-flow verification assumes prompts land in the right pane.
- **Mission Control protocols and turn-end mirror are independent of each other**: the turn-end mirror no longer waits on the Mission Control protocols plan (the file mirror has no reader in any configuration, so the record moves to `plan_events` regardless). The protocols plan has a User Review decision (keep or delete Mission Control) that is self-contained and does not gate any other subtask. Both can proceed in parallel.
- **GUI-visible defects (Standing Orders tab, Shell Load) are independent**: both touch `KanbanProvider.ts` and `bootstrap.ts` but at distinct functions. Can proceed in parallel with each other and with the Mission Control pair.
- **curl in lead prompts must land before the external CSRF guard**: this subtask removes curl from generated prompts; the CSRF guard (external, Tailnet feature) then adds the `X-Switchboard-Client` header requirement. If the guard lands first, every lead prompt breaks. Within this feature, the curl subtask is independent of all other subtasks.
- **Token deletion is phased**: Phase 1 (stop printing, stop auto-open, mode-based address) is independent and ships now. Phase 2 (delete token machinery) depends on the external CSRF guard landing first, and transitively on the curl subtask (which must precede the guard). Phase 2 cannot complete within this feature alone — it waits on an external dependency.
- **Shared files are non-conflicting**: `bootstrap.ts`, `KanbanProvider.ts`, `TaskViewerProvider.ts`, `terminals.js`, and `standingOrderFragments.ts` are each touched by multiple subtasks but at distinct functions/lines — no merge-order constraint arises from file sharing.

## Team Dispatch Instructions

### Every Prompt to a Team Seat Is Delivered to the Previous Generation's Agent

- **Seat:** Intern (complexity 3 — tmux pty work is tricky; verify inside a real pty, not a plain shell)
- **Acceptance:**
  - After a re-seat, `tmux list-windows` shows one window per seat with no duplicate names.
  - Each view session's current window is its own seat's window id (assert with `display-message -p '#{window_id}'`, not by name).
  - A review request to `Coding-intern` appears in the live pane and nowhere else.
  - A delivery whose target window is not the seat's own returns a failure, not `success: true`.
- **Must not touch:** Reaping the previous generation belongs with `tmux-windows-duplicate-on-re-seat` — note it here, do not implement it in this subtask.

### Mission Control Reads Its Protocols From a Directory Nothing Writes To

- **Seat:** Intern (complexity 2)
- **Acceptance:**
  - With `.agents/protocols/` empty and the control plane seeded, starting Mission Control produces a kickoff prompt containing the runsheet and shared-logic text — not the "workflow is incomplete" string.
  - `deliveryMode: 'self'` selects the external runsheet and `'host'` the internal one, both resolving.
  - With a protocol deliberately removed, the start fails with an error naming it, and no terminal is launched.
  - Both hosts (extension path and `startMissionControlFromKanban`) behave identically.
- **Must not touch:** None specified. (Operator decision recorded: keep and fix Mission Control — the delete path is off the table.)

### The Standing Orders Tab Hydrates Once, Over the One Channel That Can Fail

- **Seat:** Intern (complexity 2)
- **Acceptance:**
  - Opening STANDING ORDERS shows the four orders and no red line, including on first activation after page load with the WS artificially blocked.
  - Killing and restarting the host with the board page open: the tab recovers without a manual tab switch.
  - A genuinely unresolved workspace root shows a message naming that cause, not the database.
  - No extra `getStandingOrders` round trips on add / update / delete.
- **Must not touch:** Leave the three write verbs' response bodies untyped — the double-dispatch hazard the `:14077` comment names applies to writes, not reads.

### One Shell Load Builds the Board Fourteen Times, Then Discards Half of Them

- **Seat:** Intern (complexity 3)
- **Acceptance:**
  - Count `db.getBoard` calls across one shell load: 14 before, 3 or fewer after.
  - A connection declaring `design` receives its 0.3 KB without any board query running.
  - The 14-panel burst measurement beats the baseline: wall time, CPU, and `/health` median all improve (current baseline: 2751 ms wall, 2.63 s CPU, `/health` at 758 ms median).
  - Two connections declaring different scopes still receive correctly scoped snapshots — coalescing must not collapse undeclared, null, and named-project into one.
  - WS count still returns to baseline when a tab closes.
- **Must not touch:** Do not change the up-front fourteen-iframe mount (change 4 is out of scope — changes 1 and 2 make it affordable, they do not remove it).

### The Host Still Types curl Into Every Lead Prompt

- **Seat:** Intern (complexity 3)
- **Acceptance:**
  - A generated lead prompt for a batch and for a feature contains no `curl`, `$BASE`, or `api-server-port.txt`.
  - A lead stages a subtask and messages a coder using only what its prompt tells it, on a host where `curl` is not on PATH.
  - `GET /terminals/standing-orders` returns rows carrying the CLI form, and the Standing Orders tab flags nothing as stale.
  - The ratchet test fails when a `curl` string is reintroduced into any listed file.
  - Phone-a-Friend and the completion signal still fire end to end.
- **Must not touch:** Do not retire the external-agent pull surface (`EXTERNAL_AGENT_PULL_INSTRUCTION`) — that belongs with `switchboard-next-a-seat-asks-for-its-own-card`, not here.

### The Host Mirrors Every Turn-End Into an Inbox With No Reader and No Listener

- **Seat:** Coder (complexity 4)
- **Acceptance:**
  - A full dispatch → turn-end cycle writes a `plan_events` row with a relative `plan_id` and no file under `.switchboard/mission-control/reports/`.
  - The row is present whether or not a Mission Control is armed and whether or not a pty host is running.
  - Both hosts produce identical rows (assert it, do not assume from reading the two sites).
  - `switchboard reports --kind blocked` lists blocked turn-ends with each card's current column.
  - `RetentionService` prunes these rows on its normal schedule.
- **Must not touch:** Do not bulk-delete the existing 190 report files (triage in change 5 first). Do not build `GET /mission-control/reports` or a claim route. Do not fix the other file/DB twins (`job_instructions`, `job_runs`, `board_move_requests`) — noted in change 6, out of scope.

### Starting the Board Prints One Address, Never a Token, and Opens Nothing

- **Seat:** Intern (complexity 3)
- **Acceptance:**
  - `grep` the startup output of all three invocations for `token=` — zero matches.
  - `switchboard tailnet` prints exactly the tailnet URL; `switchboard local` prints exactly the loopback URL; bare `switchboard` prints neither.
  - No browser process after any serve invocation; the console menu's explicit `[1] Open in Browser` choice still opens one.
  - `--no-open`, `--detach`, and `local --detach` / `tailnet --detach` all still start cleanly.
  - Phase 2: a cross-site `text/plain` POST to a mutating verb is rejected with the token path gone — the CSRF guard, not a credential, refuses it.
- **Must not touch:** Keep the inline open at `cli.ts:2646` (behind the explicit menu choice). Keep `--no-open` parsing as a no-op so existing aliases and `--detach` do not break.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The Standing Orders Tab Hydrates Once, Over the One Channel That Can Fail](../plans/the-standing-orders-tab-hydrates-once-over-the-one-channel-that-can-fail.md) — **CODE REVIEWED** — ID: 9fe3046b-7256-4292-84d2-c7ba79b492de
- [ ] [One Shell Load Builds the Board Fourteen Times, Then Discards Half of Them](../plans/one-shell-load-builds-the-board-fourteen-times-then-discards-half.md) — **CODE REVIEWED** — ID: 7ff55c0c-3fae-4df8-8570-b0127529c0c4
- [ ] [Starting the Board Prints One Address, Never a Token, and Opens Nothing](../plans/starting-the-board-prints-where-to-reach-it-and-opens-nothing.md) — **CODE REVIEWED** — ID: 2580a5cb-2ba4-4624-a772-14da1cb77dc8
- [ ] [The Host Still Types curl Into Every Lead Prompt](../plans/the-host-still-types-curl-into-every-lead-prompt.md) — **CODE REVIEWED** — ID: 2d22baeb-e9ae-4436-8a17-05d5f728bd98
- [ ] [The Host Mirrors Every Turn-End Into an Inbox With No Reader and No Listener](../plans/171-blocked-reports-nobody-can-read.md) — **CODE REVIEWED** — ID: 56e50bc2-6cc2-47f8-a1f2-b9551209f07e
- [ ] [Mission Control Reads Its Protocols From a Directory Nothing Writes To](../plans/mission-control-reads-its-protocols-from-a-directory-nothing-writes.md) — **CODE REVIEWED** — ID: 5372655c-4c2a-4157-9a9a-e43d601ec6f2
<!-- END SUBTASKS -->

## Completion Summary

All six subtasks completed and posted by the Coding team (head: Coding; worked by Coding-intern and Coding-coder-1) on 2026-09-13. The turn-end mirror moved host reports into `plan_events` behind a `switchboard reports` CLI joined to each card's current column; Mission Control now resolves its protocols through `ProtocolService.resolveProtocol` in both hosts and fails loudly, naming the missing protocol, before any terminal is launched; the Standing Orders tab hydrates over both the WS push and a typed verb-body channel with a tri-state availability gate that names the actual refusal; one shell load coalesces fourteen concurrent board builds into two via scope-and-surface-keyed in-flight snapshots, with non-kanban panels receiving a 0.3 KB common-only snapshot; all seven generated curl strings were replaced with CLI invocations behind a no-curl ratchet contract; and startup prints one address per serve mode, never a token, and opens nothing (Phase 1 — token-machinery deletion awaits the external CSRF guard). Verified per subtask: `npm run compile-tests` clean, and the mission-control-tick, ws-surface-scoping, cross-client-scope, no-curl-in-generated-prompts, batch-move-team-prompt, drive-mode-prompt-overhaul, wsl-detection, tailscale-bind, loopback-hostname, and standalone-parity suites all green.


## Review Findings

All six subtasks reviewed in place at `17cbc519`; each subtask plan carries its own findings and deferred list. Seven MAJOR findings were fixed across `src/standalone/bootstrap.ts` (an empty-snapshot bail that dropped the theme entry for ten of the fourteen panels), `src/standalone/cli.ts` (`switchboard service` — the Pi appliance's own launch path — printed no address at all), `src/services/LocalApiServer.ts` (`GET /kanban/reports` answered a malformed `limit` or `kind` with a silent empty board — reproduced live), three docblocks in `KanbanDatabase.ts`/`TaskViewerProvider.ts`/`bootstrap.ts` that claimed `plan_id` is a relative path while the writer resolves it to a UUID, the bundled orchestration protocol's `from: system` field that no row carries plus its Reports-channel section having been written into the generated copy only, `src/test/mission-control-tick-and-reports-contract.test.js` (red at HEAD on an assertion pinning a head-prompt mirror `cb3da221` deliberately retired), and `.github/workflows/integration-tests.yml` (the no-curl ratchet was defined but never invoked by CI — the exact green-while-incomplete hole). The turn-end mechanism was verified against the live host, not the diff: `GET /kanban/reports` returns 85 rows joined to their cards' current columns with zero orphans. Verification: `npm run compile-tests` clean, and `no-curl-in-generated-prompts`, `mission-control-tick`, `ws-surface-scoping`, `cross-client-scope`, `batch-move-team-prompt`, `drive-mode-prompt-overhaul`, `wsl-detection`, `tailscale-bind`, `loopback-hostname`, `link-presets-mirror`, `wshub-reaper` and `standalone-parity:check` all green. Two of the six subtasks (the shell-load speedup and the startup output) have no automated check that discriminates on their core claim, and neither manual measurement was executed here, so those two verdicts are provisional — passing the suites above is not evidence that a shell load got faster or that a boot prints no token.

## Deferred Findings

- MAJOR — `src/services/bundledProtocols.ts` vs `.agents/skills/switchboard-orchestration/SKILL.md`: three endpoint-table rows added to the skill by `12f5d56d` were never ported to the bundled copy, so `test:contract:board-read-endpoints` is red at HEAD. Pre-existing and owned by the in-flight teams work, not by this feature.
- MAJOR — `npm run catalog:check` is red at HEAD: `protocol-catalog.json` was generated 2026-09-10 and the tree has moved 45+ commits since (arm counts 664→674). Regenerating it here would bake another agent's uncommitted working-tree state into a generated artifact, so it was deliberately left at its HEAD content.
- MAJOR — `test:contract:standing-orders-marker` and `test:contract:standing-orders-definitions` are red with the in-flight teams changes in the working tree (`agentGroupInstantiation.ts`, `configJsonBridge.ts`, `goPtyFleetProjection.ts` and eight modified test files). Not this feature's code.
- NIT — `test:contract:panel-runtime-surface` is red on `memo.html`'s `connect-src` directive, a file no commit in this feature touched.
- Per-subtask NITs are listed under each subtask plan's own `## Deferred Findings`.
