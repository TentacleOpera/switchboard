# Claude CLI Seats Have No Scrollbar And No Jump-To-Latest: It Enters The Alternate Screen And Grabs The Mouse

## Goal

Restore normal scrollback behaviour in Claude CLI panes — a working viewport scrollbar, a working wheel, and a functioning "↓ latest" pill — so a Claude seat behaves like every other CLI seat in the terminals grid.

### Problem analysis

In the terminals grid, every CLI seat gets a scrollbar, wheel scrolling, and the "↓ latest (N)" pill when output arrives while the operator is scrolled up. Claude CLI seats get none of it: the pane shows only the live screen, the scrollbar never appears, the wheel does nothing (or is consumed), and the pill never becomes visible. It reads as if Claude is overriding the pane's layout.

### Root cause — measured, not inferred

Captured by spawning the real CLI on a `node-pty` master (100×30) in a **trusted** workspace and recording every byte it wrote before the first prompt. The DEC private modes it sets, in order:

```
?25h  ?1049h  ?1000h  ?1002h  ?1003h  ?1006h  ?25l  ?2004h  ?1004h  ?2031h
```

Two of those are decisive.

**1. `\x1b[?1049h` — Claude Code enters the alternate screen buffer at startup.**

xterm.js's alternate buffer has **no scrollback, by design**. Consequences in this panel:

- `.xterm-viewport`'s `scrollHeight` equals its `clientHeight`, so the browser renders **no scrollbar thumb** — nothing to drag, nothing for the wheel to move.
- `attachJumpToLatest`'s counter (`src/webview/terminals.js:6815-6826`) computes
  ```js
  behind = Math.max(0, buf.baseY - buf.viewportY);   // terminals.js:6820
  ```
  In the alt buffer `baseY` and `viewportY` are both permanently `0`, so `behind` is always `0`, `btn.classList.toggle('visible', behind > 0)` (6824) never adds the class, and the pill is **structurally unreachable**. Both of its event sources — the viewport DOM `scroll` listener (6844) and `term.onScroll` (6850) — fire correctly; there is simply never anything to report.

For contrast, the same capture run in an **untrusted** directory — where Claude stops at the trust prompt and never reaches its REPL — sets no `?1049h` at all (`?25h ?25l ?2004h ?1004h ?2031h` only). The alt screen arrives with the interactive UI, which is why every Claude seat in a real workspace shows the symptom and nothing else does.

**2. `\x1b[?1000h ?1002h ?1003h ?1006h` — Claude Code also grabs mouse reporting.**

This panel already documents exactly what that does, at `src/webview/terminals.js:6057-6070`:

> *"the wheel goes to the app instead of the viewport (1000/1002/1003 all set the WHEEL bit — event masks 19/23/31) and xterm disables its own SelectionService, so a click can neither start nor clear a selection. That is the 'stuck, can't scroll, can't deselect' report."*

That comment sits above `REARMABLE_DEC_MODES` (`terminals.js:6074`), which exists to **re-assert** these modes after a reconnect so the pane matches the app's belief. It was never intended to counteract them — and it cannot, because the app genuinely is in mouse-reporting mode. So the second half of the symptom is a known, documented behaviour that simply had no owner.

A related consequence worth noting: `applyServerModes` deliberately refuses to write `?1049h` into a freshly-built xterm (`terminals.js:6097-6125` — *"switches it to an EMPTY alt buffer and hides the scrollback the replay just wrote — a blank pane, worse than the bug"*). So after a reconnect a Claude pane is in the normal buffer while the app believes it is in the alternate one — a second, quieter inconsistency the same root cause produces.

**3. What is NOT the cause.** The capture shows `\x1b[3J` (erase-scrollback) count **0** and `\x1b[2J` count **1** (the alt-screen entry clear). Claude is not wiping scrollback, and the single `\x1b[2J` is a consequence of `?1049h`, not an independent mechanism.

### The fix

Claude Code ships documented environment opt-outs — confirmed against Anthropic's published env-var reference and changelog, not merely inferred from the binary. Strings extracted from the shipped binary include:

```
CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN
CLAUDE_CODE_DISABLE_MOUSE
CLAUDE_CODE_DISABLE_MOUSE_CLICKS
CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL
```

Re-running the identical capture with `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 CLAUDE_CODE_DISABLE_MOUSE=1` yields:

```
?25h  ?25l  ?2004h  ?1004h  ?2031h
```

No `?1049h`, no mouse-tracking modes. The CLI renders inline in the normal buffer, so xterm accumulates scrollback, the viewport scrolls, and `baseY - viewportY` becomes meaningful again.

Switchboard's injection point is `PtyFleetService.create()`, which builds the child environment at `src/standalone/ptyFleetService.ts:181-190`, and the comment at `178-180` already documents the mandatory `...process.env` spread.

> **Superseded:** *"Switchboard owns exactly one clean injection point for this: `PtyFleetService.create()`."*
> **Reason:** The injection *point* is singular, but the service that owns it is constructed at **two** sites with different capabilities, and the original plan's configuration design only worked at one of them. `src/standalone/bootstrap.ts:1629` builds `new PtyFleetService(workspaceRoot, db, sessionToken)` in-process alongside a `configProvider`; `src/standalone/ptyHost.ts:43` builds `new PtyFleetService(workspaceRoot)` inside a **separate child process** that the extension host spawns, with no database, no token and no configuration access whatsoever. Every PTY seat created from the VS Code extension host goes through that second one. A design that reads config inside the service reaches only the standalone host, leaving the extension host's seats unfixed while every gate reports success — the "migrated-but-unreachable" half of the PRD's two-layer completion contract.
> **Replaced with:** Resolve the flag **host-side**, where configuration is actually readable, and pass it to `create()` through the existing `CreateOptions` parameter. This is the pattern the repo already uses for exactly this problem: `TaskViewerProvider.ts:2138-2143` injects `clearBeforePrompt`/`clearBeforePromptDelayMs` into the `ptySendPrompt` payload precisely because the pty child cannot read `vscode.workspace.getConfiguration`. See Proposed Changes §1–§3.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, backend, ui, bugfix, reliability
- **Project:** Browser Switchboard
- **Feature:** b34dfbb3-d1f1-406e-ad95-459e38ceef81

## User Review Required

None. The behaviour trade (pane scrolling instead of Claude's in-app virtual scroll) is the reported ask, and it ships behind a default-on setting an operator can flip. The one design decision — resolve the flag host-side rather than in the service — is forced by `ptyHost.ts` having no config access, not a preference.

## Complexity Audit

### Routine

- Adding two environment variables to the `switchboardEnv` construction in `PtyFleetService.create()`.
- Registering one boolean setting in `package.json`.

### Complex / Risky

- **Two construction sites, one with no configuration access.** `ptyHost.ts:43` runs in a child process spawned by the extension host and can read neither `vscode.workspace.getConfiguration` nor the standalone `configProvider`. The flag must therefore arrive as data on the `ptyCreateTerminal` payload from each host, and **both** hosts' arms must inject it (`TaskViewerProvider.handlePtyVerb` and `bootstrap.ts:1102-1125`). Wiring only one is the classic Layer-2 gap: the fix works over `npx` and silently does nothing in VS Code, or vice versa.
- **Spread order determines who wins, and the original reasoning had it backwards.** See Edge-Case item 5. `env: { ...process.env, ...switchboardEnv }` (`ptyFleetService.ts:189`) makes `switchboardEnv` the **winner**, not the loser.
- **Trading one behaviour for another.** In-app scrolling, mouse click-to-position and Claude's own virtual scroll are features the alt screen and mouse tracking provide. Turning them off makes the *pane* scroll instead of the *app*. That is the behaviour the user asked for and the behaviour every other seat has, but it is a real trade — it must be an explicit, reversible setting, not a silent hardcode.
- **Env is fixed at spawn.** Toggling the setting cannot affect a running seat. The setting description must state that it applies to newly-created terminals, and verification must restart a seat.
- **Applying it to the wrong seats — resolved as: apply unconditionally.**

  > **Superseded:** *"Gate on the seat actually running a Claude CLI, and fall back to setting them unconditionally only if the role→CLI mapping is not available at create time."*
  > **Reason:** The plan never implemented this gate anywhere in Proposed Changes, so it stood as an unresolved contradiction between two of its own sections — the kind a coder resolves by guessing. It is also unimplementable as stated: edge-case item 8 of this same plan establishes that **seats spawn a shell, not a CLI** — the operator or a startup command launches `claude` later, possibly minutes later, possibly never, possibly a different CLI than the role suggests. There is no reliable role→CLI fact at `create()` time to gate on.
  > **Replaced with:** Set the two variables unconditionally when the setting is on. The plan's own audit already establishes this is harmless — other CLIs ignore unrecognised `CLAUDE_CODE_*` variables — and env inheritance is what makes the fix work at all for a CLI started after the shell. State it once, explicitly, so no coder re-litigates it.

## Edge-Case & Dependency Audit

### Race Conditions

1. **None specific to this change.** Environment is materialised once, synchronously, inside `create()` before `backend.create()` is called. There is no window in which a seat exists with a partially-built environment.

### Security

2. **The variables are static literals, never caller-supplied.** They must be added host-side or in `create()`, never read off the `ptyCreateTerminal` payload as free-form env — that would let any caller holding the API token (every pty child is handed one) inject arbitrary environment into a spawned shell. Pass a **boolean**, and let `create()` map it to the two fixed key/value pairs. This mirrors the existing treatment of `delegates` and `startupCommand`, both of which are deliberately host-resolved and stripped from the wire (`TaskViewerProvider.ts:2106-2115`, `bootstrap.ts:1109-1118`).

### Side Effects

3. **Version floor, and drift.** Research (2026-08-12) confirms both variables are **documented and supported**, not internal flags — `CLAUDE_CODE_DISABLE_MOUSE` in the fullscreen-rendering guide and env-var reference, `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` added in **v2.1.132** and present in the changelog, the env-var reference and the settings JSON schema. Both accept `"1"`/`"true"` to enable the opt-out. Neither is deprecated, though Anthropic publishes no SemVer guarantee for individual CLI env flags.

   Two consequences. **(a) A version floor exists:** on Claude Code older than v2.1.132 the alternate-screen variable is simply unrecognised and the seat keeps today's behaviour. That is the intended graceful degradation, not a failure — but it means "the fix did nothing" on an old CLI is expected, and the capture harness (§5) is how you tell that apart from a wiring bug. **(b) Drift insurance exists:** if the variable is ever dropped, the documented equivalents are the `/tui default` in-session slash command and `"tui": "default"` in `~/.claude/settings.json`. Both are rejected as the *primary* mechanism here — they mutate the operator's own Claude config rather than one seat's environment, so they are neither per-seat nor reversible by a Switchboard setting — but they are the fallback to reach for if the env var disappears.
4. **`CLAUDE_CODE_DISABLE_MOUSE` vs `CLAUDE_CODE_DISABLE_MOUSE_CLICKS` — `DISABLE_MOUSE` is the correct one, confirmed.** `DISABLE_MOUSE` disables *all* mouse tracking including **scroll-wheel capture**, which is precisely the half of the symptom that sends the wheel to the app instead of the viewport. `DISABLE_MOUSE_CLICKS` (documented, added v2.1.195) is deliberately narrower: it disables clicks, drags and hover while **preserving wheel capture** — i.e. it would leave the wheel bug intact. Do not substitute it. If both were set, `DISABLE_MOUSE` takes precedence anyway, so setting both is redundant noise. `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL` (documented) disables virtualised transcript rendering to work around blank-region artifacts — unrelated to this defect and not needed; leave it alone.
5. **An operator-set value must win — and the original code comment asserted the opposite of what the code does.**

   > **Superseded:** Placing the two keys inside `switchboardEnv`, with the comment *"process.env is spread FIRST below, so an operator who has already set either variable keeps their value; these are defaults, not overrides."*
   > **Reason:** Exactly inverted. `ptyFleetService.ts:189` is `env: { ...process.env, ...switchboardEnv }` — `process.env` is spread first and `switchboardEnv` **overwrites** it. Anything placed in `switchboardEnv` is an override, not a default, so the proposed code would have clobbered an operator's `CLAUDE_CODE_DISABLE_MOUSE` while its own comment claimed the reverse. The plan's `disableClaudeAltScreen` getter partially compensated by checking only `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, leaving `CLAUDE_CODE_DISABLE_MOUSE` unprotected, and coupling the two variables' fates for no stated reason.
   > **Replaced with:** Apply the defaults as a distinct **lower-precedence layer** in the spread: `env: { ...claudeDefaults, ...process.env, ...switchboardEnv }`. Now `process.env` genuinely wins per-variable, each variable independently, with no getter-side special-casing. `switchboardEnv` keeps its existing highest-precedence position so seat identity still always wins.

6. **Existing env keys must be preserved.** `switchboardEnv` already carries `SWITCHBOARD_TERMINAL`, `SWITCHBOARD_AGENT_INSTANCE_ID` and conditionally `SWITCHBOARD_API_TOKEN`. The `...process.env` spread is mandatory (`ptyFleetService.ts:178-180`: *"a partial map replaces the whole environment and the shell launches with no PATH/HOME/SHELL"*). Add a layer; never rebuild the map.
7. **Reconnect path.** With the alt screen gone, the gateway never observes mode 1049 for these seats, so `modes[1049]` stays `undefined` and `applyServerModes`' conditional arm (`modes[1049] === false && inAlt`, `terminals.js:6125`) stays dormant. *(The original plan said "never recorded as `true`"; the accurate statement is "never recorded at all" — the arm tests for `false`, so the distinction matters.)* Confirm no regression in the reconnect replay.
8. **The seat's shell may not launch Claude at all.** Seats spawn a shell; the CLI is started by a startup command or by the operator. Env vars set at spawn are inherited by whatever runs later, so this works regardless of when `claude` starts — and is the reason the per-seat gate was dropped (see Complexity Audit).
9. **`REARMABLE_DEC_MODES` still re-arms `2004`/`1004`** (bracketed paste and focus reporting), which Claude still sets. That is correct and must keep working — prompt delivery depends on bracketed paste.
10. **Do not attempt a client-side workaround.** Filtering `?1049h` out of the byte stream in `terminalWsGateway` or `terminals.js` would desynchronise xterm's parser from the app's belief about its own screen state, and `applyServerModes`' existing comment (6097-6125) already documents the class of damage that causes. The env opt-out is the supported mechanism.

### Dependencies & Conflicts

11. **Scope is the PTY fleet in both hosts.** The scrollbar and the "↓ latest" pill are xterm/`terminals.js` features that exist only in the browser cockpit's PTY panes — but that panel is served by `LocalApiServer` under **both** hosts (`headlessPanelHtml.ts:388-410`), and the extension host's PTY seats come from the `ptyHost.ts` child. Both are in scope. VS Code's own `createTerminal` seats (`TaskViewerProvider.ts:4712, 9362, 9682, 24845`) have VS Code's native scrollback and are **out of scope**.
12. **`CLI_AGENT_REGEX` must not be repurposed.** `ptyPromptDelivery.ts:3` and `terminalUtils.ts:149` use a shared-looking regex for confirm-Enter behaviour. This change needs no Claude detection at all now (see the unconditional decision above), so there is nothing to be tempted by — but if a future variant reintroduces gating, it must not reuse that regex and change prompt-submission behaviour as a side effect. The sibling subtask *Snappier PTY Prompt Delivery…* renames adjacent numeric constants in that file but leaves the regex untouched; no conflict.
13. **No file overlap with the three webview subtasks.** This subtask touches `ptyFleetService.ts`, `ptyHost.ts`, `bootstrap.ts`, `TaskViewerProvider.ts` and `package.json`. The other three touch `terminals.js` / `terminals.html`. It can land in parallel with them — but see the sequencing note: land it after the kanban-scroll CSS fix so a `FitAddon` regression cannot be misattributed.
14. **`package.json` is shared with the sibling *Snappier PTY Prompt Delivery…*,** which registers `switchboard.terminal.ptyClearBeforePromptDelay` in the same `configuration` block. Serialise the two edits or expect a merge conflict in a JSON object — mechanical, but noisy.

## Dependencies

- **Sibling subtask (soft ordering):** *Kanban-Mode Pane In terminals.html Cannot Scroll Its Card List* — lands first, so pane-geometry regressions and scrollback regressions cannot be confused during verification.
- **Sibling subtask (file contention):** *Snappier PTY Prompt Delivery With A Dispatch Progress Chip In The Pane Header* — both edit `package.json`'s configuration contribution; serialise.
- No external session dependencies.

## Adversarial Synthesis

**Risk summary.** The largest risk is not the env change itself but its **reach**: `PtyFleetService` is constructed in two places, one of them a config-blind child process, so a service-internal configuration read fixes the standalone host and silently does nothing for every extension-host PTY seat while all gates stay green. The second risk is precedence — `switchboardEnv` is spread last and therefore overrides `process.env`, the opposite of what the original code comment claimed, so a naive placement would clobber an operator's own `CLAUDE_CODE_*` values. Mitigations: resolve the flag host-side and pass a boolean through `CreateOptions` (never raw env off the wire), inject it in **both** hosts' `ptyCreateTerminal` arms, and apply the defaults as a distinct lowest-precedence spread layer so `process.env` wins per-variable.

## Proposed Changes

### 1. `src/standalone/ptyFleetService.ts` — accept the flag and layer the env correctly

Extend `CreateOptions` (currently `68-71`):

```ts
export interface CreateOptions {
    /** When true, the terminal is excluded from render lists and role-based dispatch pools. */
    hidden?: boolean;
    /**
     * Render Claude CLI inline in the normal screen buffer instead of the alternate
     * one, so the terminal PANE's own scrollbar and jump-to-latest pill work.
     *
     * A BOOLEAN, never an env map: this arrives from an HTTP payload, and every pty
     * child holds an API token, so accepting free-form environment here would let any
     * caller inject arbitrary variables into a spawned shell. The two concrete
     * variables are fixed literals below. Same reasoning that makes `delegates` and
     * `startupCommand` host-resolved rather than caller-supplied.
     *
     * Resolved HOST-side because this service is also constructed inside ptyHost.ts's
     * child process (ptyHost.ts:43), which has no vscode API and no configProvider.
     */
    claudeInlineRendering?: boolean;
}
```

Then in `create()`, replace lines `181-190`:

```ts
        const switchboardEnv: Record<string, string> = {
            SWITCHBOARD_TERMINAL: name,
            SWITCHBOARD_AGENT_INSTANCE_ID: agentInstanceId,
            ...(this.apiToken ? { SWITCHBOARD_API_TOKEN: this.apiToken } : {}),
        };

        // Claude Code enters the ALTERNATE SCREEN (\x1b[?1049h) and grabs mouse
        // reporting (\x1b[?1000h ?1002h ?1003h ?1006h) the moment its REPL starts.
        // Measured on a node-pty master, not inferred.
        //
        // The alt buffer has no scrollback in xterm.js, so the pane gets no scrollbar
        // and attachJumpToLatest's `baseY - viewportY` (terminals.js:6820) is pinned
        // at 0 — the "↓ latest" pill can never become visible. Mouse reporting then
        // routes the wheel to the app and disables xterm's SelectionService; that half
        // is already documented at terminals.js:6057-6070 as the "stuck, can't scroll,
        // can't deselect" report.
        //
        // These two env vars make the CLI render inline in the normal buffer instead.
        // Verified: with both set the startup stream contains no ?1049h and no mouse
        // modes. We do NOT filter the bytes client-side — that would desync xterm's
        // parser from the app's own belief about its screen state (see applyServerModes,
        // terminals.js:6097-6125).
        //
        // Set UNCONDITIONALLY when enabled, not gated on the seat's role: a seat spawns
        // a SHELL, and `claude` is started later by a startup command or by the operator,
        // so there is no reliable role→CLI fact at this point. Other CLIs ignore
        // unrecognised CLAUDE_CODE_* variables.
        const claudeEnvDefaults: Record<string, string> = opts?.claudeInlineRendering
            ? {
                CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
                CLAUDE_CODE_DISABLE_MOUSE: '1',
            }
            : {};

        const rawHandle = this.backend.create({
            name,
            cwd: effectiveCwd,
            // Spread order is load-bearing THREE times over:
            //   1. claudeEnvDefaults FIRST — these are DEFAULTS. An operator who has
            //      already exported either variable keeps their own value, per variable,
            //      because process.env overwrites this layer.
            //   2. process.env SECOND and MANDATORY — ptyBackend.ts:89 does
            //      `options.env || process.env`, so a partial map replaces the WHOLE
            //      environment and the shell launches with no PATH/HOME/SHELL.
            //   3. switchboardEnv LAST so the seat identity always wins.
            env: { ...claudeEnvDefaults, ...process.env, ...switchboardEnv } as Record<string, string>,
        });
```

### 2. `src/standalone/bootstrap.ts` — resolve the setting in the standalone host

In the `ptyCreateTerminal` arm (`1102-1125`), extend the `create()` call at line 1119:

```ts
                    const terminal = await ptyFleetService.create(
                        payload.role || 'coder', payload.name, targetCwd, payload.worktreePath,
                        payload.parentInstanceId, undefined,
                        {
                            hidden: payload.hidden === true,
                            // HOST-resolved, never from the wire — see CreateOptions.
                            claudeInlineRendering: configProvider.getConfigBoolean('terminal.claudeInlineRendering', true)
                        }
                    );
```

Apply the same option to the `ptyCreateBatch` arm (`1127+`) so batch-created seats are not silently left on the old behaviour.

### 3. `src/services/TaskViewerProvider.ts` — inject it for the extension host's pty child

`ptyHost.ts` cannot read configuration, so the extension host must resolve and forward it, exactly as it already does for `clearBeforePrompt` at `2138-2143`. In `handlePtyVerb`'s `ptyCreateTerminal` block (`2101-2131`), beside the existing `delegates` overwrite:

```ts
                // Host-resolved, like `delegates` above: the pty child (ptyHost.ts)
                // runs in a separate process with no vscode API, so a config read
                // inside PtyFleetService would reach the standalone host only and
                // leave every extension-host seat unfixed.
                payload = {
                    ...payload,
                    claudeInlineRendering: vscode.workspace
                        .getConfiguration('switchboard')
                        .get<boolean>('terminal.claudeInlineRendering', true)
                };
```

and in `src/standalone/ptyHost.ts`'s `ptyCreateTerminal` arm (`69-80`), pass it through to `create()`:

```ts
                const terminal = await fleet.create(
                    payload.role || 'coder',
                    payload.name,
                    payload.cwd,
                    payload.worktreePath,
                    payload.parentInstanceId,
                    undefined,
                    {
                        hidden: payload.hidden === true,
                        // Boolean off the wire, resolved by whichever host proxied us.
                        // Defaults to true if absent so a caller that predates this
                        // field still gets the fixed behaviour.
                        claudeInlineRendering: payload.claudeInlineRendering !== false
                    }
                );
```

Mirror the same pass-through in `ptyHost.ts`'s `ptyCreateBatch` arm.

### 4. `package.json` — register the setting

Beside the existing `switchboard.terminal.*` block (315-326):

```json
        "switchboard.terminal.claudeInlineRendering": {
          "type": "boolean",
          "default": true,
          "description": "Run Claude CLI seats in the normal screen buffer so the terminal pane's own scrollbar and jump-to-latest work. Turn off to keep Claude's in-app scrolling and mouse support. Applies to newly created terminals only — environment is fixed when a seat spawns, so restart a seat after changing this."
        }
```

### 5. Keep the capture harness

Preserve the `node-pty` capture script used to diagnose this as a repo script (e.g. `scripts/capture-cli-modes.js`), so the next time a CLI changes its startup sequence the answer takes one command rather than a bisect. It spawns a CLI on a pty, records the raw stream, and prints every DEC private mode in order plus counts of `\x1b[2J` / `\x1b[3J`.

## Uncertain Assumptions

None outstanding. The one open question — whether the two `CLAUDE_CODE_*` variables are supported public configuration or internal flags — was researched on 2026-08-12 and resolved: **both are documented and supported**, `DISABLE_ALTERNATE_SCREEN` from v2.1.132. The findings (version floor, `DISABLE_MOUSE` vs `DISABLE_MOUSE_CLICKS` precedence and scope, and the `"tui": "default"` fallback) are folded into Side Effects items 3–4 above.

## Verification Plan

1. **Reproduce, measured.** Before the change, run the capture harness against `claude` in a trusted workspace. Confirm the mode list contains `?1049h ?1000h ?1002h ?1003h ?1006h`. This is the baseline.
2. **Confirm the opt-out at the source.** Re-run with `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 CLAUDE_CODE_DISABLE_MOUSE=1`. Confirm the mode list reduces to `?25h ?25l ?2004h ?1004h ?2031h` — no `?1049h`, no mouse modes.
3. **The reported bug, end to end — standalone host.** With the change built, run `npx switchboard`, create a **new** Claude seat and let it produce more than a screenful of output. Confirm: a scrollbar appears on `.xterm-viewport`; the wheel scrolls the pane; scrolling up shows `↓ latest (N)` with N incrementing as output arrives; clicking the pill returns to the bottom.
4. **The same, end to end — extension host.** Repeat step 3 from the VS Code extension's terminals panel, whose seats are created through the `ptyHost.ts` child process. **This is the step that catches a one-host wiring gap**, and it must pass independently of step 3 — a fix that works only over `npx` is incomplete.
5. **Parity with another CLI.** Do the same on a gemini/codex seat. The two panes must behave identically.
6. **Selection works.** Click-drag inside the Claude pane to select text, then click elsewhere to clear it. Both must work — mouse reporting was disabling `SelectionService`.
7. **Batch creation is covered.** Create seats via `ptyCreateBatch` (the bulk-create path) rather than one at a time; confirm those seats also render inline. A `create()`-only wiring leaves batch seats on the old behaviour.
8. **Existing seats are unaffected until restarted.** Confirm a Claude seat created *before* the change still shows the old behaviour, and that killing and recreating it fixes it. The setting description says this.
9. **Setting off restores the old behaviour.** Set `switchboard.terminal.claudeInlineRendering` to `false`, create a new Claude seat, and confirm `?1049h` returns (re-run the harness against that seat's captured stream, or observe the missing scrollbar). Verify in **both** hosts.
10. **Operator override wins, per variable.** Launch the host with only `CLAUDE_CODE_DISABLE_MOUSE=0` exported. Confirm the seat inherits `CLAUDE_CODE_DISABLE_MOUSE=0` (the operator's value) **and** `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` (our default) — this is the direct test of the three-layer spread. `echo $CLAUDE_CODE_DISABLE_MOUSE; echo $CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` in the seat.
11. **Environment is intact.** In a new seat, run `echo $PATH; echo $HOME; echo $SWITCHBOARD_TERMINAL; echo $SWITCHBOARD_AGENT_INSTANCE_ID`. All must be populated — this is the `...process.env` spread regression the comment at `ptyFleetService.ts:178-180` warns about.
12. **No env injection from the wire.** POST a `ptyCreateTerminal` with a hostile `claudeInlineRendering` value and with extra env-shaped fields; confirm only the boolean is honoured and no arbitrary variable reaches the shell (`env | grep -c EVIL` = 0).
13. **Prompt delivery still works.** Dispatch a plan to a Claude seat. Bracketed paste (`?2004`) must still be active and the prompt must submit correctly — `REARMABLE_DEC_MODES` still re-arms `2004`/`1004`.
14. **Reconnect replay.** With a Claude seat scrolled up, reload the cockpit page. Confirm the scrollback replay lands, the pane is in the normal buffer, no blank-pane state occurs, and the jump-to-latest pill reflects the restored position.

### Automated Tests

- **`src/test/pty-route-surface-contract.test.js`** already asserts the shape of the pty create/dispatch surface. Extend it with a **both-hosts injection assertion**: `TaskViewerProvider.ts`'s `ptyCreateTerminal` block and `bootstrap.ts`'s `ptyCreateTerminal` arm must each resolve `terminal.claudeInlineRendering` host-side, and `ptyHost.ts` must pass `claudeInlineRendering` through to `fleet.create`. This is the exact gap that would otherwise ship as a green one-host fix, and it is a genuine property of the source text.
- **Spread-order assertion** in the same file: `ptyFleetService.ts` must contain `{ ...claudeEnvDefaults, ...process.env, ...switchboardEnv }` in that order. The precedence is the whole operator-override argument and is invisible to any behavioural test that does not set a host env var.
- **`package.json` assertion:** `switchboard.terminal.claudeInlineRendering` exists with `default: true`.
- **Regression suites to run before merge** (not run during planning, per session directive): `src/test/pty-route-surface-contract.test.js` and `src/test/terminal-open-all-seating-contract.test.js` — both exercise the PTY create/dispatch surface this change touches.

## Recommendation

**Complexity 5 → Send to Coder.** The edit itself is a handful of lines, but it spans five files across two hosts and one child process, and its two failure modes are both silent: wiring one host leaves half the install base unfixed with every gate green, and getting the spread order wrong clobbers operator environment while appearing to work. The verification plan is built to catch exactly those two.

---

## Completion report (2026-08-13)

Implemented across six files. `ptyFleetService.ts` gained `claudeInlineRendering?: boolean` appended to `CreateOptions` (which had drifted and now also carries `_isTeamMember`, so the block was extended rather than replaced), the `claudeEnvDefaults` map setting `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` and `CLAUDE_CODE_DISABLE_MOUSE` to `'1'`, and the three-layer spread `{ ...claudeEnvDefaults, ...process.env, ...switchboardEnv }`; `createBatch` gained a matching trailing parameter threaded into its inner `create()`. Both silent failure modes this plan names were checked directly rather than assumed: the wiring is complete on **both hosts and both arms** — `TaskViewerProvider.handlePtyVerb` and `bootstrap.ts` each resolve the setting host-side for `ptyCreateTerminal` *and* `ptyCreateBatch`, and `ptyHost.ts` forwards `payload.claudeInlineRendering !== false` in both arms — and the positional argument lands in the correct slot of `createBatch`'s signature from both callers. Only a boolean crosses the wire; no `payload.env` path reaches `create()`, so the injection vector stays closed.

`package.json` registers `switchboard.terminal.claudeInlineRendering` (boolean, default true) beside the sibling subtask's key, with the legacy `clearBeforePromptDelay` untouched at 2000; the file re-parses as valid JSON and all five touched TypeScript files parse clean. §5 turned out to be a **create, not a preserve** — `scripts/capture-cli-modes.js` did not exist in the repo — so the harness was written fresh and parses, though it has not been run. None of the 14 manual verification steps were executed under this dispatch's SKIP TESTS / SKIP COMPILATION directives; step 4 (extension-host end-to-end, the one that catches a one-host gap) and step 10 (per-variable operator override) are the two most worth running first. Note the version floor from Side Effects item 3 still applies: on Claude Code older than v2.1.132 the alternate-screen variable is unrecognised and a seat keeps today's behaviour, which is graceful degradation rather than a wiring bug — the new harness is how to tell those apart.

## Review Findings (2026-08-14)

The env layering, the boolean-only wire contract and the two verb arms in both hosts were all correct, but the plan's own dominant risk — **reach** — was only half closed: `create()` has far more entry points than `ptyCreateTerminal`/`ptyCreateBatch`, and every one of them was unwired. `spawnDelegates` created team members with `{ _isTeamMember: true }` and no flag (both hosts), and in standalone the board-dispatch auto-create (`bootstrap.ts:1511`), send-by-name auto-create (`1558`), memo→planner (`1680`) and agent-group head (`1776`) all called `create()` with no options — so those seats spawned on Claude's alternate screen with no pane scrollbar while every gate stayed green; separately, `TaskViewerProvider.ts:11313` calls `_ptyHostVerb('ptyCreateTerminal')` *below* `handlePtyVerb`, bypassing its injection, so extension-host group heads ignored an operator who turned the setting off. Fixed by adding a host-injected `setClaudeInlineRenderingResolver` consulted in `create()` via `??` (explicit `false` from a verb arm still wins), recording the resolved value on `ExtendedTerminalHandle` so `spawnDelegates` hands each member the head's decision, installing the resolver in `bootstrap.ts` beside the fleet construction, and adding the missing boolean to the agent-group payload — files changed: `ptyFleetService.ts`, `bootstrap.ts`, `TaskViewerProvider.ts`. The plan's three `### Automated` proposals were also unimplemented; all are now in the CI-invoked `pty-route-surface-contract.test.js`, extended to cover the new reach paths (both hosts' resolution counts, the resolver install, the ptyHost pass-through in both arms, delegate inheritance, the `{ ...claudeEnvDefaults, ...process.env, ...switchboardEnv }` spread order, `DISABLE_MOUSE` and not `DISABLE_MOUSE_CLICKS`, no `payload.env`, and `default: true`). Verification: `tsc -p tsconfig.test.json` clean, pty/terminal contract suites green except the pre-existing `terminal-focus-affordance` failure (`entry.inputDropNoticed` is absent at HEAD too); remaining risks are the unchanged v2.1.132 version floor and the 14 manual end-to-end steps — step 4 (extension host) and step 10 (per-variable operator override) first, and now also a delegate seat, since that path was the gap.
