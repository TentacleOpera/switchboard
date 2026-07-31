# Extension-Host PTY Fleet + Platform Packaging

## Goal

Let the VS Code extension host own a PTY fleet, so clicking **Open in Browser** gives the full first-class terminal experience without requiring a separate standalone process. Two halves: ship `node-pty` inside the VSIX across platforms, and route dispatch per surface so VS Code terminals and PTY terminals coexist without ambiguity.

Depends on `reverse-pty-standalone-only-constraint.md` landing first — the current repo records and a green CI gate forbid this work.

### Problem analysis / root cause

The PTY fleet exists and is verified working, but only in the standalone host, which has no distribution channel: nothing is published to npm, and `switchboard` on npm belongs to a third party. Marketplace users therefore cannot reach terminals at all. Meanwhile `terminalDispatch: true` is already set in the extension host (`TaskViewerProvider.ts:1831`), so the extension-hosted browser board **already dispatches** to VS Code terminals — what it cannot do is *display* them, because no stable VS Code API exposes terminal output (`onDidWriteTerminalData` is proposed-only; shell integration surfaces command output, not a raw stream, so an interactive agent TUI does not fit it). Owning the PTY is the only way to render terminals in the browser.

Two constraints make this more than a flag flip:

1. **Packaging.** `.vscodeignore` excludes `node_modules/**` wholesale, and the VSIX ships only `dist` + static assets. node-pty is a native module and cannot be webpack-bundled. Verified prebuild sizes: darwin-arm64 136 KB, darwin-x64 64 KB, win32-x64 30 MB, win32-arm64 28 MB, **linux none** (node-pty 1.1.0 ships no Linux prebuild; `latest` is still 1.1.0 and the 1.2.0 line is on its fourteenth beta). So a single universal VSIX carrying every platform would grow by ~58 MB, almost all of it Windows.
2. **Two fleets in one workspace.** Today `getRegisteredTerminals`, worktree resolution and the activity light all assume a single fleet. With both VS Code terminals and PTYs live, every dispatch has to decide which kind it means.

### Directive (2026-07-31, supersedes standalone-only)

PTY terminals are available in both hosts. Rationale: the marketplace is the only real distribution channel, and an owned terminal surface enables layouts, per-worktree tabs and completion messages that VS Code's panel cannot provide.

## Metadata

**Complexity:** 7
**Tags:** backend, infrastructure, packaging, feature
**Project:** Browser Switchboard

## User Review Required

- None. Platform-target set and the per-surface routing model are decided below.

## Complexity Audit

### Routine
- `isPtyAvailable()`, the capability derivation, the PTY backend, fleet service, WS gateway and browser panel all already exist and are verified working in standalone. This plan makes them reachable from a second host, it does not rewrite them.
- `.vscodeignore` un-ignore and a `vsce --target` matrix are mechanical.

### Complex / Risky
- Per-surface dispatch routing touches three shared consumers that currently assume one fleet — a wrong verdict sends a prompt into a terminal the user cannot see.
- The extension host has a real `TerminalBackend` already (`VscodeTerminalBackend`); adding a second backend means the seam now has two live implementations in one process for the first time.
- Extension-host teardown: PTYs are children of the extension host, so `deactivate()` must dispose them or a window reload orphans agent processes. Standalone solved this via `instance.stop()`; the extension has no equivalent wiring yet.
- Platform-specific VSIX publishing is a release-pipeline change; getting the fallback wrong means some platform gets no installable extension at all.

## Edge-Case & Dependency Audit

**Race Conditions**
- Window reload during an active PTY: extension host dies, PTYs die with it. Same as VS Code terminals today (they also die on reload), so this is parity, not a regression — but it must be *stated* so nobody treats it as a bug.
- `deactivate()` is not guaranteed to complete async work. The dispose path must be synchronous-safe, mirroring the fleet service's `exit`-handler reaper.

**Security**
- The browser cockpit's terminal channel is RCE-grade. The gateway keeps `rejectWhenTokenEmpty: true`, which it already does. **The extension host has no token by default — see step 2b for the resolved design.** This is not a hypothetical: verified that `getAuthToken` returns `secrets.get('switchboard.apiToken') || ''` (`TaskViewerProvider.ts:1625-1628`), an opt-in secret that is empty for essentially every install, so `/ws/terminal` would be rejected 100% of the time and every terminal would render but never stream.

**Side Effects**
- VSIX size grows ~30 MB on Windows targets. Marketplace download size is user-visible.
- Two terminal kinds appear in `state.terminals`; anything that enumerates terminals by name must respect the `ideName` partition.

**Dependencies & Conflicts**
- Blocked by `reverse-pty-standalone-only-constraint.md`.
- Independent of `terminals-panel-v2-layouts-worktree-tabs.md`, which only needs *a* PTY host and works against standalone today.

## Non-Goals

- No npm publishing. Standalone stays a dev path (`node dist/standalone/cli.js`); the naming problem (`switchboard` is taken; `@turnzero/switchboard` would collide with the VS Code extension identity, since `name` is shared and VS Code forbids scoped names) is deferred.
- No change to how the VS Code sidebar board dispatches — it keeps using VS Code terminals.
- No Linux PTY support in v1 (no prebuild exists); Linux gets the universal build and degrades via the probe.

## Implementation Steps

### 1. Packaging

- `.vscodeignore`: un-ignore `node_modules/node-pty/**` specifically. Keep `node_modules/**` excluded otherwise.
- Webpack: add `'node-pty': 'commonjs node-pty'` to the **extension** config's externals (it is already in standaloneConfig). The JS must not be bundled; the binary loads at runtime from `node_modules`.
- Release script: build a target matrix with `vsce package --target`:
  - `darwin-arm64`, `darwin-x64`, `win32-x64`, `win32-arm64` — node-pty included.
  - One **universal** VSIX with node-pty excluded, as the fallback for Linux and anything unlisted. The marketplace serves platform-specific builds preferentially and falls back to universal.
- Trim what ships: only the current target's `prebuilds/<platform>-<arch>/` directory needs to be in each VSIX. Shipping all four into every target is the difference between +136 KB and +58 MB on darwin.
- Verify each artifact: the darwin VSIX must contain `prebuilds/darwin-*/pty.node` **and** `spawn-helper`; the universal VSIX must contain no `.node` binary at all.

### 2. Extension-host fleet construction

- Construct `PtyFleetService` in the extension host, gated on `isPtyAvailable()`. Reuse the existing service unchanged — it takes `(workspaceRoot, db)` and has no VS Code dependency.
- Derive `terminalFleet` and `availability.terminals` from the probe, exactly as `bootstrap.ts` does. `terminalDispatch` stays `true` (already is) — it now means "this host can dispatch", which is true either way.
- Construct `TerminalWsGateway` only when the probe passes, and inject it via `LocalApiServerOptions.terminalWsGateway` so `/ws/terminal` routes. Left undefined, the upgrade router destroys the path — the behaviour that ships today.
- Register the four `pty*` verbs on a **dedicated `/terminals/verb/` route** — see step 2a. Do NOT add them to `KanbanProvider`'s switch, and never hand-edit the generated allowlist (that broke `catalog:check` and `verb-returns:check` once already in this feature).
- Dispose on `deactivate()`: kill every live handle synchronously. `disposeAll()` is async and `deactivate()` cannot reliably await it — use the same synchronous SIGKILL sweep the fleet's `exit` handler uses.

### 2a. Move the PTY verbs onto their own route (DECIDED)

The four `pty*` verbs currently ride `/kanban/verb/` and are served by `bootstrap.ts`'s own switch, which works only because the standalone switch consults no allowlist. In the extension host the same request reaches `KanbanProvider.handleServiceVerb`, whose first act is `if (!KANBAN_VERBS.has(verb))` (`KanbanProvider.ts:7227`) — so they would be rejected.

**Decision: add a dedicated `/terminals/verb/` route backed by a new `terminalVerb` option on `LocalApiServerOptions`.** Rejected alternative: adding `pty*` arms to `KanbanProvider`'s `switch (msg.type)` so the catalog generator picks them up.

Rationale:

1. **The prefix already exists by convention.** `transport.js:26` computes `routePrefix = panel === 'kanban' ? '/kanban/verb' : '/${panel}/verb'`, and `terminals.html` carries `data-panel="terminals"` — so `/terminals/verb` is *already* the route this panel's transport shim would use. The present code hardcoding `/kanban/verb/` and bypassing the shim is the anomaly, not the fix.
2. **It keeps PTY verbs out of the generated surface entirely.** No catalog entries, no `KANBAN_VERBS` members, so `catalog:check` / `parity:check` / `verb-returns:check` are untouched. `verb-returns:check` in particular reconciles case-label counts against allowlist size and trips when they diverge.
3. **It makes per-surface routing structural instead of disciplinary.** The VS Code sidebar board posts to `/kanban/verb/`. If PTY verbs exist only on `/terminals/verb/`, the sidebar *cannot* spawn a terminal it has no way to display — the guarantee is enforced by routing rather than by a convention a future change can quietly break.
4. **It mirrors five existing precedents** (`designVerb`, `setupVerb`, `planningVerb`, `taskViewerVerb`, and the `/project/` + `/memo/` routes), so both hosts wire it the same way.

Work items:
- `LocalApiServer`: add `pathname.startsWith('/terminals/verb/')` alongside the existing seven routes, dispatching to `this._options.terminalVerb`. Absent option ⇒ 503, matching how the other panel verbs behave in a host that does not wire them.
- `bootstrap.ts`: pass `terminalVerb: handlePtyVerb` and delete the six PTY cases from `kanbanVerb`. `handlePtyVerb` is already a standalone function taking `(verb, payload, root)`, so this is a wiring move, not a rewrite. Keep the `ptyReady` guard on the new entry point.
- Extension host: wire the same `terminalVerb` to its own fleet.
- `terminals.js`: stop hardcoding `/kanban/verb/` and post to `/terminals/verb/` (or route through the transport shim, which resolves the prefix on its own).

**No compatibility burden:** `/kanban/verb/pty*` has no external consumers — standalone is unpublished (nothing is on npm; `switchboard` there belongs to a third party), so this surface has only ever been reachable in a dev checkout. Move it outright rather than aliasing.

### 2b. Terminal-channel authentication (DECIDED)

**Problem, verified in code.** `TaskViewerProvider.ts:1625-1628` supplies `getAuthToken: async () => await this._context.secrets.get('switchboard.apiToken') || ''`. That secret is opt-in and unset for essentially all installs, so it returns `''`. `_checkAuth` then short-circuits on `if (!expected) { return true; }` (`LocalApiServer.ts:503`) — the historical loopback-trust path. The terminal gateway, correctly, does the opposite: `rejectWhenTokenEmpty: true`. Net effect if nothing changes: the Terminals panel renders, the list populates over loopback-trusted HTTP, and **every `/ws/terminal` upgrade is rejected** — a silent, hard-to-diagnose dead panel.

**Decision: give the gateway its own terminal-scoped credential. Do NOT change `getAuthToken`, and do NOT relax the gateway.**

Two rejected alternatives, both tempting:

- *Relax the gateway to loopback-trust in the extension host.* Rejected outright. This is a remote-code-execution input channel — any local process able to reach 127.0.0.1 could attach and type into an agent shell. `rejectWhenTokenEmpty` exists precisely to make that impossible, and weakening it for convenience inverts the guard's purpose.
- *Have the extension generate a session token and return it from `getAuthToken`.* Looks correct, and is the trap. `getAuthToken` feeds `_checkAuth` for the **entire HTTP surface**, so a non-empty value flips the extension host from loopback-trust to token-required for `/health`, `/kanban/dispatch`, and every skill that shells out through `.agents/skills/_lib/sb_api_call.sh` — which carries no token handling whatsoever. That would 401 the whole skill ecosystem for a terminal feature.

**Design:**
- Generate a per-session terminal token at extension activation (`crypto.randomBytes`, in memory only — never persisted, never in SecretStorage; it dies with the host and a new one is minted on reload).
- Pass it to the browser through the existing one-time-token exchange: append `?token=` to the Open-in-Browser URL, which `LocalApiServer` already swaps for an HttpOnly `sb_session` cookie (`LocalApiServer.ts:576-585`). No new transport mechanism.
- Construct the gateway with that token: `new TerminalWsGateway(fleet, async () => terminalSessionToken, ...)`. The constructor already takes its **own** `getAuthToken` closure, independent of `LocalApiServerOptions.getAuthToken` — in standalone the two coincide by coincidence (`async () => sessionToken`), not by design. So this is a one-argument change at the construction site.
- HTTP trust model untouched: skills, scripts and `/health` keep working exactly as today.

**Consequence to accept:** the cookie is shared with the HTTP surface, so a token minted for terminals also satisfies `_checkAuth` once set. That is strictly a tightening (loopback-trust callers still pass via the empty-`expected` path since `getAuthToken` is unchanged), but note it so nobody later "simplifies" the two token sources into one.

### 3. Per-surface dispatch routing (the load-bearing decision)

**Model: the dispatching surface picks the fleet.** Not a global mode setting.

- VS Code sidebar board → VS Code terminals (visible where the user is).
- Browser cockpit → PTY terminals (visible in its Terminals panel).

This removes the "dispatch into an invisible terminal" failure that a global mode creates, and needs no user-facing setting. Both fleets are legitimately live; the `ideName` partition already distinguishes them (`standalone-pty` vs the VS Code `ideName`) and `extension.ts`'s `isCompatibleIdeName` already prevents cross-adoption.

Three shared consumers must learn which fleet is being asked about:

- `getRegisteredTerminals()` — feeds `/kanban/dispatch`'s 409 pre-flight (`LocalApiServer.ts:1186-1191`). It currently returns one list. It needs a surface argument, or a second hook, so an API dispatch destined for a PTY is not blocked by "no VS Code terminals are open" and vice versa.
- Worktree resolution — `matchWorktreePath` is fleet-agnostic and fine, but the terminal lookup that consumes it must search the right fleet.
- Activity light — plan-file mtime driven and host-agnostic (`KanbanDatabase.ts:9218-9224`), so it needs no change. **Verify** rather than assume.

Rename the PTY `ideName` from `standalone-pty` to something host-neutral (e.g. `switchboard-pty`), since it will no longer be standalone-only. `PTY_IDE_NAME` is already a single exported constant, so this is one edit — but it is a **persisted registry value**, so existing `runtime.terminals` rows carry the old string. The boot purge already deletes rows matching either `purpose:'pty'` or the old `ideName`, so keep matching both on read.

### 4. Browser panel reachability

- The `/terminals` route already 404s when the manifest entry is disabled, so no change is needed to hide it — it simply becomes enabled once the probe passes.
- Confirm the panel's `getSetting`-based role picker resolves `agents.visibleAgents` in the extension host (it reads machine-global config, so it should).

## Proposed Changes

### `.vscodeignore`, `webpack.config.js`, `scripts/publish-release.sh`
- **Logic:** Un-ignore node-pty; externalize it in the extension config; add the `vsce --target` matrix plus a universal fallback; trim per-target prebuilds.
- **Edge cases:** A target missing from the matrix silently gets the universal (no-PTY) build — acceptable and intended, but must be documented in the release notes.

### Extension-host composition root (`extension.ts` / `TaskViewerProvider`)
- **Logic:** Probe, construct fleet + gateway, derive capabilities, wire `terminalVerb`, mint the terminal session token, dispose on deactivate.
- **Edge cases:** Probe false ⇒ every PTY surface absent, exactly as standalone behaves today. `getAuthToken` must be left alone (see step 2b) — changing it 401s the skill ecosystem.

### `src/services/LocalApiServer.ts` (route table + options)
- **Context:** Seven per-panel verb routes exist; `terminalWsGateway` is already an injected option.
- **Logic:** Add `/terminals/verb/` → `this._options.terminalVerb`; absent option ⇒ 503.
- **Edge cases:** Auth-gated identically to the other panel verb routes.

### `src/standalone/bootstrap.ts` (verb wiring)
- **Logic:** Pass `terminalVerb: handlePtyVerb`; remove the six PTY cases from `kanbanVerb`; keep the `ptyReady` guard on the new entry point.
- **Edge cases:** `handlePtyVerb` already takes `(verb, payload, root)` — a wiring move, not a rewrite.

### `src/webview/terminals.js` (verb calls)
- **Logic:** Post to `/terminals/verb/` instead of the hardcoded `/kanban/verb/`, matching the prefix `transport.js` already derives from `data-panel="terminals"`.
- **Edge cases:** None external — `/kanban/verb/pty*` has no published consumer.

### `src/standalone/ptyFleetService.ts` (`PTY_IDE_NAME`)
- **Logic:** Rename to a host-neutral value; keep reading the legacy value so existing registry rows still purge.
- **Edge cases:** Do not migrate live rows — boot purge deletes them anyway.

### Shared dispatch consumers
- **Logic:** Teach `getRegisteredTerminals` and the terminal lookup which fleet a dispatch targets.
- **Edge cases:** No visible affordance may dispatch into a fleet the current surface cannot display.

## Verification Plan

### Automated
- `npm run test:contract:pty-host-gating` (renamed by plan 1) — import-location + no-unguarded-construction + both webpack externals.
- `npm run compile`, `compile-tests`, `lint` clean.
- `catalog:check`, `parity:check`, `verb-returns:check`, `mirror:check` green. Step 2a's dedicated route keeps `pty*` out of the generated surface entirely, so these should be *unchanged* rather than regenerated — a diff in `protocol-catalog.json` or `verbAllowlist.ts` means something leaked into a Provider switch.
- New contract test: with the probe forced false, `availability.terminals` is false, `/terminals` 404s, `/ws/terminal` is destroyed, and the four `pty*` verbs return `success:false`.
- New contract test: `pty*` verbs are reachable on `/terminals/verb/` and **absent** from `/kanban/verb/` in both hosts, and `KANBAN_VERBS` contains no `pty` member.
- New contract test: the gateway rejects `/ws/terminal` when its own token is empty even from loopback (the `rejectWhenTokenEmpty` contract), and `_checkAuth`'s loopback-trust path is unaffected by the terminal token — i.e. an unauthenticated `GET /health` still succeeds when `switchboard.apiToken` is unset.

### Manual UAT (darwin)
- Build the darwin-arm64 VSIX, install it, confirm the packaged size delta is ~136 KB and `prebuilds/darwin-arm64/spawn-helper` is present.
- VS Code → **Open in Browser** → Terminals icon present → New Terminal (coder) → agent TUI renders and is interactive → dispatch a card from the browser board → prompt lands in the PTY, working light on → agent edits the plan file → light off.
- Dispatch the same card from the **VS Code sidebar** board → prompt lands in a **VS Code** terminal, not the PTY.
- Reload the VS Code window → PTYs are gone, no orphaned shells (`ps` check), no SIGABRT in the extension host log.
- Install the universal VSIX on the same machine → no Terminals icon, no dispatch errors, board fully functional.
- **Skill-ecosystem regression check:** with `switchboard.apiToken` unset, run a skill that goes through `.agents/skills/_lib/sb_api_call.sh` and confirm it still succeeds. This is the specific breakage the step-2b design exists to avoid; if it 401s, `getAuthToken` was changed and must be reverted.

## Completion Report

(To be filled in by the implementing agent.)
