# tmux Bridge Part 2: Standalone Dispatch Integration

## Goal

Wire the Part 1 tmux transport into standalone Switchboard so tmux panes become real dispatch targets: discoverable, registerable in `runtime.terminals`, visible to the `/kanban/dispatch` pre-flight, and reachable from `sendToTerminal` and `triggerAction`. Gated behind an opt-in setting that defaults off.

### Problem Analysis

**Core problem.** Part 1 delivers a `TerminalBackend` that can write into tmux panes, but nothing calls it. Standalone's terminal seam is still the inert stub at `src/standalone/hostServices.ts:323-347`, and every path that resolves a dispatch target in standalone goes to the PTY fleet exclusively.

**The three chokepoints.** A working transport is not enough; a tmux pane has to pass three gates that all currently answer "PTY only":

1. **Registration.** `runtime.terminals` in the kanban DB is the registry every surface reads. PTY rows are tagged `ideName: 'switchboard-pty'` + `purpose: 'pty'` and merge-preserved (`ptyFleetService.ts:183-210`). tmux rows do not exist, so no UI or API can name a pane.
2. **Dispatch pre-flight.** `POST /kanban/dispatch` calls `getRegisteredTerminals()` and returns **409 "No terminal agent is live right now"** (`LocalApiServer.ts:1206`) when it comes back empty. In standalone that function is `ptyFleetService.listActive().map(t => t.friendlyName)` (`bootstrap.ts:1297`) — a live tmux pane is invisible to it, so dispatch 409s even though a valid target exists.
3. **Resolution.** `handlePtyVerb`'s `sendToTerminal` (`bootstrap.ts:1106-1115`) and `triggerAction` (`bootstrap.ts:1027-1104`) resolve targets against the PTY fleet and create a PTY when none matches. Neither can see or reach a tmux pane.

**Root cause of the safety hazard this introduces.** Every existing dispatch target is a process Switchboard started, so it knows what is running there. A tmux pane is a pane the *user* started, running whatever they left in it. Pasting an 8 KB dispatch prompt into a pane sitting at a `bash` prompt executes it as shell commands. That is the defining risk of this plan and the reason adoption is explicit and opt-in rather than automatic discovery.

**Why `runtime.terminals` needs care.** The registry ships in released versions with ~4,000 installs. Per `CLAUDE.md`, shipped state must be migrated and never clobbered: tmux rows are additive, must be tagged so the extension's `isCompatibleIdeName` partition (`extension.ts:551-559`) and `PtyFleetService`'s merge loop (`ptyFleetService.ts:191`) both leave them alone, and must not cause an older Switchboard reading the same DB to mishandle rows it does not understand.

## Dependencies

**Requires Part 1 complete.** This plan consumes `TMUX_IDE_NAME`, `isTmuxAvailable()`, `listTmuxPanes()`, `TmuxTerminalBackend`, `TmuxTerminalHandle` and `sendPromptToTmux()`.

- `tmux-bridge-1-transport-layer — tmux Bridge Part 1: Transport Layer`

## Metadata

**Tags:** backend, standalone, terminals, dispatch, feature
**Complexity:** 7

## User Review Required

Three decisions are asserted here as defaults and should be confirmed:

1. **Adoption is explicit, never automatic.** Switchboard will not register a pane just because it exists. The user adopts a pane via a verb (or by titling it to match a configured pattern, which defaults to empty = matches nothing). Rationale: automatic adoption plus a dispatch equals arbitrary command execution in a shell the user was using for something else.
2. **A bare-shell pane is refused by default.** `tmuxAdoptPane` checks `pane_current_command` against a **shell blacklist** regex (`/^(bash|zsh|fish|sh|dash|ksh|csh|tcsh)$/`) and refuses unless `force: true`. This is a guard, not a confirmation dialog — it returns an error the caller can retry with `force`, and there is no prompt. Note: the existing `isCliAgent` regex at `terminalUtils.ts:220` (`/\b(copilot|gemini|agy|claude|windsurf|cursor|cortex)\b/i`) tests **terminal names**, not process names — it is not applicable here. The PTY delivery path's `CLI_AGENT_REGEX` was deleted (confirm CR is now unconditional). The bare-shell guard needs its own shell-blacklist regex applied to `pane_current_command` (the foreground process name from `list-panes`), not a repurposed terminal-name regex.
3. **`triggerAction` never auto-creates a tmux pane.** The PTY path creates a terminal when none matches (`bootstrap.ts:1027-1104`); the tmux path resolves only, unless `switchboard.terminal.tmux.autoCreate` is on (default false). Creating windows in someone's tmux session unprompted is surprising in a way creating a Switchboard-owned PTY is not.

## Complexity Audit

### Routine
- Config keys in `package.json` `contributes.configuration`, read through `vscode.workspace.getConfiguration('switchboard')` — which already works in standalone via the file-backed `StandaloneConfiguration` proxy (`vscodeShim.ts:192-216`), so no host-specific config plumbing is needed.
- Union in `getRegisteredTerminals()` (`bootstrap.ts:1297`).
- `dispatchedIde: TMUX_IDE_NAME` on the dispatch-info write, mirroring `bootstrap.ts:1087`.

### Complex / Risky
- **Registry reconcile, not purge.** `PtyFleetService.purgePtyTerminals()` (`ptyFleetService.ts:269-287`) can delete every PTY row on boot because PTYs die with the process. tmux panes **outlive Switchboard restarts**, so the tmux equivalent must reconcile — drop rows whose `paneId` is gone from `list-panes`, keep the rest — and must still complete before the API server accepts requests, for the same reason as the PTY purge: a ghost row satisfies the dispatch pre-flight and produces a 409-free dispatch into nothing.
- **Sync seam construction vs async probe.** `createHeadlessHostSeams(workspaceRoot)` is synchronous (`hostServices.ts:314`) but `isTmuxAvailable()` is async. The probe has to happen in `bootstrap.ts` (which already awaits `ptyReady`) and be handed in.
- **Resolution precedence between two fleets.** PTY and tmux friendly names can normalize to the same agent key. Getting the order and the tie-break wrong sends a prompt to the wrong agent — the same class of bug the `apiOriginated` discriminator exists to prevent in the extension host (`TaskViewerProvider.ts:18492-18497`).
- **Verb rail placement.** PTY verbs live on `/terminals/verb/` **only**, and that is pinned by `src/test/pty-route-surface-contract.test.js:26-29` plus a generated allowlist. tmux verbs must follow the same rail and get the same pinning, or the contract test's sibling will not catch a future drift.
- **The bare-shell guard** — see User Review Required.

## Edge-Case & Dependency Audit

### Security
- **Prompt-into-shell execution.** The headline risk. Mitigations, in order: opt-in setting (default off) → explicit adoption → bare-shell refusal without `force` → newline flattening for non-CLI-agent panes (Part 1). None of these is sufficient alone; all four ship together.
- **Verb input validation.** `paneId` must match `/^%\d+$/` at the verb boundary, before it reaches the backend, so a malformed id fails with a 4xx rather than deep inside an argv. Aliases go through the same `_isValidAgentName`-equivalent validation the PTY rename path uses.
- **Registry as an injection vector.** `worktreePath` for a tmux row comes from `pane_current_path` — a directory the user `cd`'d to, not a Switchboard-validated worktree. Do not feed it into worktree-matching logic (`matchWorktreePath`) without the same `path.resolve` + containment check the PTY path applies.

### Race Conditions
- A pane is killed between reconcile and dispatch → resolution fails at `send-keys` time. Surface as "terminal not found", and drop the stale row so the next pre-flight is honest.
- Two hosts (standalone + extension) writing `runtime.terminals` concurrently → the existing merge-not-clobber discipline (`ptyFleetService.ts:183-210`) is the pattern to copy exactly; tmux writes must skip rows whose `ideName !== TMUX_IDE_NAME` rather than rebuilding the map.
- A pane renamed in tmux while adopted → the friendly name in the registry goes stale. Reconcile refreshes names on each pass; `paneId` is the identity, never the name.

### Side Effects
- Turning the setting on makes previously-invisible panes appear as dispatch targets in every surface that reads the registry (board target pickers, `/health`'s `terminals[]` array at `LocalApiServer.ts:3333-3346`). That is the intent — no new UI is needed — but it means the setting change alone visibly alters the board.
- `/health` gains tmux entries in `terminals` and a larger `terminalCount`. Anything asserting on those numbers will shift.

### Dependencies & Conflicts
- **No migration needed for the feature itself** — it has never shipped, so it takes a clean break per `CLAUDE.md`. **But `runtime.terminals` has shipped**, so the new rows are additive-and-tagged only: preserve unknown/legacy keys, never rebuild the map, never assume a prior reconcile ran.
- An older Switchboard reading a DB containing tmux rows must not choke. `isCompatibleIdeName('switchboard-tmux', 'Visual Studio Code')` returns `false` (`extension.ts:551-559`), so the extension already filters them out — verify this rather than assume it, since a `false` there is what makes the rows inert for old clients.
- Extension-host integration is **out of scope**. The seam makes it a later, small change (a tmux fallback on `VscodeTerminalBackend`'s miss path); this plan does not touch `TaskViewerProvider.ts`.

## Proposed Changes

### Phase 1: Config surface

`package.json` → `contributes.configuration`:

| Key | Type | Default | Purpose |
|---|---|---|---|
| `switchboard.terminal.tmux.enabled` | boolean | `false` | Master gate. Off = zero behaviour change. |
| `switchboard.terminal.tmux.socketName` | string | `""` | `-L <name>`; empty = default socket. |
| `switchboard.terminal.tmux.socketPath` | string | `""` | `-S <path>`; takes precedence over `socketName`. |
| `switchboard.terminal.tmux.paneTitlePattern` | string | `""` | Auto-adopt panes whose `pane_title` matches. Empty = matches nothing. |
| `switchboard.terminal.tmux.autoCreate` | boolean | `false` | Allow `triggerAction` to create a pane when none resolves. |

`switchboard.terminal.clearBeforePrompt` and `.clearBeforePromptDelay` are reused as-is — no new keys.

### Phase 2: `src/standalone/tmuxFleetService.ts` (new)

Modelled on `PtyFleetService`, but for panes Switchboard does *not* own — so no spawn/reap lifecycle, no SIGTERM escalation, no `disposeAll()` that kills anything.

```ts
export class TmuxFleetService {
    constructor(workspaceRoot: string, db: KanbanDatabase, backend: TmuxTerminalBackend) {}

    /** Panes currently adopted AND still alive. Feeds getRegisteredTerminals(). */
    listActive(): AdoptedPane[];

    /** Explicit adoption. Refuses a bare shell unless force. */
    async adopt(paneId: string, role: string, alias?: string, force?: boolean): Promise<AdoptedPane>;

    /** Unregister — never kills the pane. */
    async release(paneId: string): Promise<void>;

    /** Drop rows whose paneId is gone; refresh names/paths for the rest.
     *  Must be awaited before the API server accepts requests. */
    async reconcile(): Promise<{ dropped: number; kept: number }>;

    get(nameOrPaneId: string): TmuxTerminalHandle | undefined;
    onDidChange(cb: (e: { type: 'adopted' | 'released' | 'renamed'; paneId: string }) => void): void;
}
```

Registry rows written through the same merge discipline as `ptyFleetService.updateRegistryState()`:

```ts
{
    ideName: TMUX_IDE_NAME,       // 'switchboard-tmux'
    purpose: 'tmux',
    role,
    friendlyName,
    pid: pane_pid,
    paneId,                        // the stable identity
    worktreePath: pane_current_path,
    status: 'active',
    lastSeen: <iso>,
}
```

The merge loop must `continue` past any entry whose `ideName !== TMUX_IDE_NAME` — the mirror of `ptyFleetService.ts:191` — so PTY and VS Code rows survive untouched.

`reconcile()` replaces the purge concept. Adoption is persisted, so a restart re-adopts panes that still exist; that is a feature (a user's `coder-1` pane survives a Switchboard restart), and it is precisely why a blind purge would be wrong.

### Phase 3: Seam wiring

**`src/standalone/hostServices.ts`** — `createHeadlessHostSeams` gains an optional second parameter so the call is backwards-compatible:

```ts
export function createHeadlessHostSeams(
    workspaceRoot: string,
    opts?: { terminalBackend?: TerminalBackend }
): HostSeams {
    return {
        pathConfig,
        terminal: opts?.terminalBackend ?? { /* existing inert no-op stub, unchanged */ },
        …
    };
}
```

The stub stays exactly as-is for the disabled/unavailable case, comment included — it is still the correct answer when there is no tmux.

**`src/standalone/bootstrap.ts`** — after the existing `ptyReady` probe:

```ts
const tmuxEnabled = vscode.workspace.getConfiguration('switchboard')
    .get<boolean>('terminal.tmux.enabled', false);
const tmuxReady = tmuxEnabled && await isTmuxAvailable(socket);

let tmuxFleetService: TmuxFleetService | undefined;
if (tmuxReady) {
    const backend = new TmuxTerminalBackend(socket);
    tmuxFleetService = new TmuxFleetService(workspaceRoot, db, backend);
    await tmuxFleetService.reconcile();   // BEFORE the server accepts requests
}
```

The `await` placement matters for the same reason `purgePtyTerminals` must be awaited pre-server: ghost rows pass the dispatch pre-flight.

**`getRegisteredTerminals()`** (`bootstrap.ts:1297`) — union, de-duplicated on normalized name with PTY winning a collision:

```ts
getRegisteredTerminals: () => [
    ...ptyFleetService.listActive().map(t => t.friendlyName),
    ...(tmuxFleetService?.listActive().map(t => t.friendlyName) ?? []),
],
```

This is the single change that unblocks `POST /kanban/dispatch`'s 409 gate.

### Phase 4: Dispatch resolution

**`sendToTerminal`** (`bootstrap.ts:1106-1115`) — PTY first, then tmux, then the existing get-or-create *for PTY only*:

```
1. ptyFleetService.get(name) || normalized match  → sendPromptToPty
2. tmuxFleetService?.get(name) || normalized match → sendPromptToTmux
3. PTY get-or-create (existing behaviour, unchanged)
```

PTY-first mirrors the extension's reasoning (`TaskViewerProvider.ts:18492-18497`): when two fleets normalize to the same agent key, prefer the one the calling surface can actually display. The browser panel renders PTYs; tmux panes are invisible to it.

**`triggerAction`** (`bootstrap.ts:1027-1104`) — insert a tmux arm into the existing resolution ladder (worktree+role → worktree → role), keeping PTY precedence at each rung. On a tmux match:

```ts
await sendPromptToTmux(handle, prompt, { clearBeforePrompt, clearBeforePromptDelayMs });
await db.updateDispatchInfoByPlanFile({
    routedTo, dispatchedAgent,
    dispatchedIde: TMUX_IDE_NAME,      // mirrors bootstrap.ts:1087
    dispatchedTerminal,
});
```

then the existing card-move + `broadcastWs('moveCards' | 'showStatusMessage')` path, unchanged. The create-if-missing fallback stays PTY-only unless `tmux.autoCreate` is set.

### Phase 5: Verbs

New verbs on **`/terminals/verb/`** only — never `/kanban/verb/`, per `pty-route-surface-contract.test.js:26-29`:

| Verb | Body | Returns |
|---|---|---|
| `tmuxListPanes` | — | `{ panes: [{ paneId, friendlyName, sessionName, windowName, currentCommand, currentPath, pid, adopted, role? }] }` |
| `tmuxAdoptPane` | `{ paneId, role, alias?, force? }` | `{ adopted: { … } }` or an error naming the bare-shell refusal |
| `tmuxReleasePane` | `{ paneId }` | `{ released: true }` — never kills |
| `tmuxClearPane` | `{ name }` | `{ cleared: true }` |

All guarded on `tmuxReady`, exactly as the PTY verbs are guarded on `ptyReady` (`bootstrap.ts:1300-1303`) — an unguarded call from a page loaded before a restart must not surface as an unhandled spawn exception. Register in the generated allowlist alongside the PTY verbs.

### Phase 6: `src/test/tmux-route-surface-contract.test.js` (new)

Sibling to `pty-route-surface-contract.test.js`:

1. tmux verbs are reachable on `/terminals/verb/` and **absent** from `/kanban/verb/`.
2. tmux verbs appear in the generated allowlist.
3. Every tmux verb is `tmuxReady`-guarded.
4. `getRegisteredTerminals()` unions both fleets and de-duplicates PTY-first.
5. Registry writes preserve non-tmux rows (feed a map containing a `switchboard-pty` row and a `Visual Studio Code` row; assert both survive a tmux write).
6. `isCompatibleIdeName('switchboard-tmux', <any vscode appName>)` is `false`, so old extension hosts filter the rows out.
7. `reconcile()` drops rows for absent panes and keeps rows for present ones — asserting it is *not* a blanket purge.
8. `tmuxReleasePane` issues no `kill-pane`.

## Files Changed

- `package.json` — five `switchboard.terminal.tmux.*` config keys.
- `src/standalone/tmuxFleetService.ts` — **new.** Adoption, release, reconcile, registry writes.
- `src/standalone/hostServices.ts` — `createHeadlessHostSeams` accepts an optional `terminalBackend`; inert stub retained as the fallback.
- `src/standalone/bootstrap.ts` — tmux probe + fleet construction + pre-server `reconcile()`; `getRegisteredTerminals()` union; tmux arms in `sendToTerminal` and `triggerAction`; four new verbs in `handlePtyVerb`.
- `src/test/tmux-route-surface-contract.test.js` — **new.**
- Generated verb allowlist — regenerate to include the tmux verbs.

## Verification Plan

1. **Setting off (default)** — tmux running with panes; `enabled: false` → `/terminals/verb/tmuxListPanes` is unavailable, `/health` `terminals[]` is unchanged, dispatch behaves exactly as today. Zero-diff for existing users.
2. **Setting on, no tmux installed** — `tmuxReady` false, no fleet constructed, verbs unavailable, no error at boot, standalone starts normally.
3. **Setting on, tmux running, nothing adopted** — `tmuxListPanes` lists panes with `adopted: false`; `/health` `terminals[]` shows only PTYs; `POST /kanban/dispatch` with no PTY still 409s. Discovery alone must not create targets.
4. **Adopt a CLI-agent pane** — a pane running `claude`, `tmuxAdoptPane {paneId, role:'coder'}` → succeeds; `/health` lists it; `runtime.terminals` gains one `switchboard-tmux` row.
5. **Adopt a bare shell** — a `bash` pane → refused with a clear error; retry with `force: true` → succeeds. No dialog either way.
6. **Dispatch to an adopted pane** — move a card to trigger `triggerAction` → prompt arrives in the tmux pane as one atomic paste; card moves; `dispatchedIde` reads `switchboard-tmux` in the DB.
7. **Dispatch pre-flight** — one adopted tmux pane, zero PTYs → `POST /kanban/dispatch` succeeds instead of 409ing. This is the gate the plan exists to open.
8. **PTY precedence** — a PTY and an adopted pane both named `coder-1` → dispatch lands in the PTY; the browser panel shows it.
9. **Registry coexistence** — with a PTY and an adopted pane live, `runtime.terminals` holds both rows, correctly tagged, neither clobbering the other. Then start the VS Code extension against the same DB → it registers its own terminals and both other row sets survive.
10. **Old-client inertness** — with tmux rows present, the extension host's terminal list shows no tmux entries (the `isCompatibleIdeName` filter), and nothing errors.
11. **Reconcile across restart** — adopt two panes, kill one, restart standalone → the dead row is dropped, the live one is still adopted and dispatchable without re-adopting.
12. **Ghost-row pre-flight** — kill an adopted pane, restart, and hit `POST /kanban/dispatch` immediately at boot → must 409 rather than dispatch into nothing, proving `reconcile()` completed before the server accepted requests.
13. **Release is non-destructive** — `tmuxReleasePane` → row gone, pane still alive and usable.
14. **`autoCreate` off** — dispatch to a role with no matching pane and no PTY → no tmux window created.
15. **Non-default socket** — a server on `-L alt` with `socketName: 'alt'` → panes discoverable; unset → invisible.

### Automated Tests

The eight contract tests in Phase 6, all against a mocked backend so CI needs no tmux. Plus:
- Unit tests for `TmuxFleetService.reconcile()`: all-present, all-absent, mixed, and empty-registry cases.
- Unit tests for `adopt()`'s bare-shell guard: each of `bash`/`zsh`/`fish`/`sh` refused; `claude`/`copilot`/`gemini` accepted; `force` overrides.
- A `getRegisteredTerminals()` union test covering the PTY-wins collision case.
- One integration test guarded on `isTmuxAvailable()`, skipping cleanly without tmux.

## Adversarial Synthesis

Three failure modes are worth pre-empting. **First**, the dispatch pre-flight is the least obvious blocker: a fully working transport plus registry still 409s at `LocalApiServer.ts:1206` until `getRegisteredTerminals()` unions the fleets, and that failure looks like "tmux integration doesn't work" rather than "one array is missing a spread". **Second**, copying `purgePtyTerminals` instead of writing a reconcile would silently delete every adoption on each boot — the feature would appear to work in a single session and forget everything on restart, which reads as flakiness rather than a design error. **Third**, resolution precedence: if tmux is checked before PTY, a name collision routes prompts into a pane the browser panel cannot show, and the user watches an empty terminal while the agent runs somewhere invisible — the standalone analogue of exactly what `apiOriginated` was introduced to prevent. Mitigations: verification step 7 targets the pre-flight specifically, contract test 7 asserts reconcile is not a purge, and verification step 8 plus contract test 4 pin PTY-first.

## Risks

- **Prompt-into-shell execution is the defining risk.** Four independent mitigations ship together (opt-in default-off, explicit adoption, bare-shell refusal, newline flattening). Weakening any one of them — particularly making adoption automatic via a default `paneTitlePattern` — turns a dispatch into arbitrary command execution in a pane the user was using for something else.
- **`pane_current_command` is a snapshot.** The bare-shell guard reads what is running *at adoption time*. A user who adopts a `claude` pane, exits the CLI, and leaves a bash prompt has an adopted pane that now executes prompts. There is no watch on this; re-checking at send time would help and is worth considering during implementation.
- **`runtime.terminals` is shipped state with ~4,000 installs.** A registry write that rebuilds rather than merges destroys PTY and VS Code rows for anyone running multiple hosts against one DB. The merge loop at `ptyFleetService.ts:183-210` is the pattern to copy literally, not to reinterpret.
- **Reconcile timing is load-bearing.** If `reconcile()` is not awaited before the server accepts requests, a stale row satisfies the 409 gate and the dispatch reports success while going nowhere — the exact failure `purgePtyTerminals`'s await ordering exists to prevent.
- **`/health` shape shifts.** `terminals[]` and `terminalCount` grow when panes are adopted. Any external monitor asserting on those values will see a change.
- **Verb rail drift.** tmux verbs on `/kanban/verb/` would break the deliberate separation that `pty-route-surface-contract.test.js` pins. The sibling contract test is what keeps a future edit from quietly widening the rail.

## Recommendation

**Complexity: 7 → Send to Lead Coder**

The individual edits are small and the seam absorbs most of the design pressure, but the change is spread across five files and three of the touch points are subtle in ways that fail quietly rather than loudly: the pre-flight union, the reconcile-vs-purge distinction, and resolution precedence. The bare-shell guard and the opt-in default are security-relevant defaults rather than preferences and should be confirmed at review, not adjusted during coding.
