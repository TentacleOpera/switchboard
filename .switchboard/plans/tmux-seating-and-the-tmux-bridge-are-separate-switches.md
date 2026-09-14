# tmux Seating and the tmux Bridge Are Separate Switches

## Goal

The two unrelated tmux features are independently controllable, so an operator can keep
the one they want without the one they don't — and so the question "do we keep seating?"
can actually be answered by trying it.

### Problem analysis

There are **two** tmux features in this codebase and **one** switch for both.

**Feature 1 — the bridge (adoption).** The board writes into tmux panes it does not own.
`src/standalone/tmuxBackend.ts` states it in its header: implement the `TerminalBackend`
seam "so Switchboard can write text into tmux panes it does not own." Part 2
(`tmuxFleetService.ts`) registers adopted panes in `runtime.terminals` tagged
`ideName: 'switchboard-tmux'`, and `startTmuxReconcilePoll` keeps them honest against the
live pane list. This is the feature tmux was introduced for, and it is the subject of the
already-written plan `tmux-bridge-2-standalone-dispatch-integration`.

**Feature 2 — seating.** The board wraps its **own** seats' startup command in a
`new-session` / `new-window` / `exec tmux -u attach` chain
(`src/services/goPtyFleetProjection.ts:270-494`), so board-created agents live inside tmux
sessions the board creates and then does not track.

**They share one config key.** Both read `terminal.tmux.enabled`, both defaulting `true`:

- `src/standalone/bootstrap.ts:4022` — `setTmuxSeatingResolver(() => configProvider.getConfigBoolean('terminal.tmux.enabled', true))` gates **seating**.
- `src/standalone/bootstrap.ts:4487` — `const tmuxEnabled = configProvider.getConfigBoolean('terminal.tmux.enabled', true)` gates construction of the **bridge** fleet and socket.
- `src/standalone/cli.ts:4917` — `cfg.getConfigBoolean('terminal.tmux.enabled', true)` gates the **WSL discovery hint**, which is a bridge concern (it warns that tmux pane dispatch is unavailable on native Windows).

So there is currently **no way to have one without the other**. Turning the switch off to
stop seating also deletes pane adoption, dispatch to adopted panes, and the reconcile poll.
Turning it on to get adoption also opts every seat into a chain that ends in `exec tmux
attach`. The panel presents this as a single checkbox labelled for seating
(`src/webview/terminals.js:929`, `switchboard.terminal.tmux.enabled`), so the bridge is
governed by a control that does not mention it.

### Root cause

Seating and adoption were built at different times against the same name. The bridge landed
first and took `terminal.tmux.enabled` as its master gate. Seating later moved into the Go
host (see `tmux Belongs in the Go Host`) and reused the nearest existing switch rather than
introducing its own. Nothing forced the question, because a single boolean that reads
`tmux: on/off` looks complete until you want exactly one half of it.

### Non-goals

- **Deciding whether to keep seating.** This plan deliberately does not settle that. It
  makes the decision *reversible and testable*, which it currently is not.
- **Changing seating's behaviour.** No change to the chain, the reuse branch, or session
  lifecycle. Separate plans.

## Metadata

**Tags:** config, terminals, tmux, standalone
**Complexity:** 3

## User Review Required

None. Both new keys default `false` — tmux is off until the operator turns it on. The
single shared key `terminal.tmux.enabled` is unreleased and is deleted, not migrated.

## Complexity Audit

### Routine

- Adding two config keys and pointing three reads at them (two in `bootstrap.ts`, one in `cli.ts`).
- Deleting the unreleased `terminal.tmux.enabled` key and its reads.
- Splitting one panel checkbox into two and reworking the surrounding heading.

### Complex / Risky

- None.

## Edge-Case & Dependency Audit

### Race Conditions

- The panel writes are fire-and-forget through `saveSetting`; a host read racing a panel write is the pre-existing behaviour of every contributed setting and is not changed by this plan.

### Security

- No new auth surface. The two keys are operator config read by the host process; the panel write path is the existing `saveSetting` channel, already gated by the host's auth.

### Side Effects

- Flipping `seating` off mid-run does not retro-seat or unseat running PTYs — the resolver is read live at `create()` time (`goPtyFleetProjection.ts:270`), so the change takes effect for the next seat, not running ones. This is the existing behaviour of the single switch and is preserved.
- Flipping `bridge` off mid-run does not tear down an already-constructed `TmuxFleetService` — the fleet is built once at boot (`bootstrap.ts:4487`). The toggle is a boot-time gate, not a live switch. The panel hint at `terminals.js:934` already says as much for seating; the bridge toggle should carry the same "takes effect after restart" caveat.

### Dependencies & Conflicts

- The `tmux-bridge-2-standalone-dispatch-integration` plan targets the bridge feature; this plan must land first or be reconciled with it, since both touch `bootstrap.ts:4487` and the bridge fleet construction.

## Dependencies

- `tmux-bridge-2-standalone-dispatch-integration` — the bridge feature's own plan; touches the same `bootstrap.ts:4487` fleet construction site. Sequence this plan first, or coordinate the diff.
- `tmux Belongs in the Go Host` — already shipped; established that seating is a standalone-only property of the PTY command, which is why the extension wires no seating resolver.

## Adversarial Synthesis

Key risks: (1) a third consumer of the shared key (`cli.ts:4917`, the WSL hint) was missed by the original plan and would have kept reading a deleted key; (2) the original plan assumed a migration for a shipped key that is in fact unreleased, inventing a partial-write hazard that does not exist. Mitigations: repoint all three consumers at the new keys; delete the shared key outright since nothing shipped.

## Proposed Changes

### 1. Two keys, three consumers, both off by default

Introduce `terminal.tmux.bridge.enabled` and `terminal.tmux.seating.enabled`, both
defaulting `false`. Point the three consumers of `terminal.tmux.enabled` at the new keys
and delete the shared key:

- `bootstrap.ts:4022` (seating resolver) → `terminal.tmux.seating.enabled`, default `false`
- `bootstrap.ts:4487` (bridge fleet + socket construction) → `terminal.tmux.bridge.enabled`, default `false`
- `cli.ts:4917` (WSL discovery hint) → `terminal.tmux.bridge.enabled`, default `false`

> **Superseded:** "Point `bootstrap.ts:4479` at the first and `bootstrap.ts:4014` at the second."
> **Reason:** The original plan named only two consumers and missed `cli.ts:4917`, the WSL discovery hint, which reads the bridge gate. Line numbers were also off: the seating resolver call is at `:4022` (not `:4014`, which is a comment), and the bridge gate is at `:4487` (not `:4479`).
> **Replaced with:** Point all three consumers at the new keys as listed above. Re-resolve each line number before editing — the file drifts.

### 2. Delete `terminal.tmux.enabled` — clean break

`terminal.tmux.enabled` is unreleased (no shipped version carries it), so per `CLAUDE.md`
it takes a clean break: delete the key and its reads, no migration, no compat shim, no
preserved fossil row. The existing `terminalBackend` → `terminal.tmux.enabled` migration at
`bootstrap.ts:4449-4465` is also unreleased and is deleted alongside it — there is no
shipped install that stored `terminalBackend: 'tmux'` to migrate from.

### 3. The panel exposes both, under a reworked heading

`src/webview/terminals.js` and `src/webview/terminals.html` — the single checkbox at
`terminals.js:929` / `terminals.html:211` becomes two, labelled for what they actually do.
Both default unchecked. The comment block at `terminals.js:911-926` documents a past bug
where the checkbox wrote a key the host did not read; both new toggles must be verified
against the key the host actually reads, not merely against a green save.

**Heading rework, not just checkbox duplication.** The current HTML heading at
`terminals.html:208` is `<h2>tmux seating</h2>`, and the checkbox sits under it. Dropping a
second toggle for the bridge under the same "tmux seating" heading reproduces the original
defect — a control that does not mention what it governs. The heading must become neutral
(e.g. `tmux`) and each toggle gets its own one-line label: one for seating, one for the
bridge (pane adoption + dispatch). The bridge toggle's hint should carry the "takes effect
after restart" caveat, mirroring the seating hint at `terminals.js:934`.

### 4. Standalone only — do not wire this into the extension

`CLAUDE.md` (2026-09-14): the extension host is being removed in a **hard cutover** — it ships
once alongside everything else and never has to interoperate with the new host. A feature is
never blocked, narrowed or deferred to preserve extension-host behaviour, and **new code must
not be written into the legacy host to keep it compatible.** The staged removal is the board
feature *VS Code Becomes a Sidebar, and Stops Being a Second Host* — Stages 1, 2, 2b and 3 are
all in **PLAN REVIEWED**, none built, so the extension is still a live host today.

**The distinction that matters here:** shared code is not legacy-host code. A fix that lands in a
module both roots already consume reaches the extension for free and is not throwaway. What is
forbidden is *new extension-specific wiring* added so the legacy host keeps pace.

For this plan that resolves cleanly, because **seating is already standalone-only** AND **the
extension wires no tmux gate at all.** *A Pty-Host Death Empties the Board* records it:
`setTmuxSeatingResolver` is called from `src/standalone/bootstrap.ts` alone (noted there as
`:3964`; measured at `:4022` on 2026-09-14 — re-resolve before editing), and "the extension does
not wire `setTmuxSeatingResolver`", so its seats are not tmux-backed at all. A grep of
`src/extension.ts` for `terminal.tmux.enabled` returns zero config reads (one comment mentions
`sendPromptToTmux`, but no gate is wired) — the extension has no bridge gate either.

So:

1. **`terminal.tmux.seating.enabled` is a standalone key.** Do not add the toggle to any extension surface. The extension never seated; there is nothing there to switch off.
2. **`terminal.tmux.bridge.enabled` is a standalone key.** The extension does not read `terminal.tmux.enabled` for pane adoption today, so there is no extension bridge gate to repoint. Wiring one is precisely the throwaway compatibility work the rule forbids.
3. **State in the PR** that the extension was deliberately not updated, and why. A reviewer checking the no-divergence rule needs to see this was a decision, not an omission. The extension wires neither gate; that is the intended state, not a divergence.

## Verification Plan

### Automated Tests

- **Contract** — with `seating: false, bridge: true`, a created seat's `startupCommand`
  contains no `tmux` substring, **and** `tmuxListSessions` still answers and an adopted pane
  is still dispatchable. This is the pair that is impossible today and is the whole point.
- **Contract** — with `seating: true, bridge: false`, the reconcile poll does not run and no
  adopted rows are written.
- **Contract** — with both keys absent (fresh install), no tmux fleet is constructed, no
  seat is tmux-wrapped, and the WSL hint does not fire.
- **Contract (parity)** — the standalone host resolves both new keys; the extension is
  unchanged (reads neither new key). This is not "both roots wire both gates" — the extension
  wires neither by design (§4). Parity here means: no extension behaviour changes, and the
  standalone host's two gates are independently controllable.

Run `npm run compile-tests` before any `test:contract:*` script.

### Goal Invariants

1. Seating can be turned off while pane adoption and dispatch keep working.
2. The standalone host wires both gates (`seating` at `bootstrap.ts:4022`, `bridge` at `bootstrap.ts:4487` and `cli.ts:4917`); the extension wires neither, deliberately per §4. Stated explicitly in the PR description.
3. `terminal.tmux.enabled` is absent from the codebase after the change (deleted, not migrated).
