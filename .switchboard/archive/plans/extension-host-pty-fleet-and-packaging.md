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
**Tags:** backend, infrastructure, devops, security, feature
**Project:** Browser Switchboard

## User Review Required

- None. Linux question DECIDED by user (2026-07-31): no Linux — the `1.1.0` pin stays, the matrix stays four targets + universal, the v1 non-goal stands (the `1.2.0-beta` upgrade path remains available if this is ever revisited). Everything else decided below: platform-target set, PDB trimming, publish sequencing, per-surface routing, terminal-token transport.

## Complexity Audit

### Routine
- `isPtyAvailable()`, the capability derivation, the PTY backend, fleet service, WS gateway and browser panel all already exist and are verified working in standalone. This plan makes them reachable from a second host, it does not rewrite them.
- `.vscodeignore` un-ignore and a `vsce --target` matrix are mechanical.

### Complex / Risky
- Per-surface dispatch routing touches four shared consumers that currently assume one fleet — a wrong verdict sends a prompt into a terminal the user cannot see.
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
> **Superseded:** VSIX size grows ~30 MB on Windows targets.
> **Reason:** Verified 2026-07-31: 27 MB of the 30 MB win32-x64 prebuild directory is `.pdb` debug symbols (`du -ch prebuilds/win32-x64/*.pdb`), which the runtime never loads. Shipping them also flirted with the Marketplace's per-VSIX upload cap (documented at 25–50 MB — the 30 MB build was one stripping decision away from an HTTP 413).
> **Replaced with:** Windows VSIX grows ~3 MB after excluding `**/*.pdb` (functional binaries kept: `conpty.node`, `pty.node`, `conpty_console_list.node`, `winpty.dll`, `winpty-agent.exe`, `conpty/`). darwin growth unchanged (~136 KB / ~64 KB). Marketplace download size is user-visible.
- Two terminal kinds appear in `state.terminals`; anything that enumerates terminals by name must respect the `ideName` partition.

**Dependencies & Conflicts**
- Was blocked by `reverse-pty-standalone-only-constraint.md` — that plan is now IMPLEMENTED (2026-07-31), so this plan is unblocked.
- Independent of `terminals-panel-v2-layouts-worktree-tabs.md`, which only needs *a* PTY host and works against standalone today.

## Dependencies

- `reverse-pty-standalone-only-constraint.md` — gate reversal; **IMPLEMENTED 2026-07-31** (its Completion Report is filled; `test:contract:pty-host-gating` exists and its assertions are conditional so they pass both before and after this plan). This plan is unblocked.
- `terminals-panel-v2-layouts-worktree-tabs.md` — independent; needs *a* PTY host and works against standalone today.

## Adversarial Synthesis

Key risks: the terminal-token transport was specified against a cookie that can never carry it (every `/ws/terminal` upgrade would 401 — now corrected to a page-injected token on the WS URL); the per-surface routing model had no stated discriminator, so the browser board's own dispatches would have landed in invisible VS Code terminals (now keyed on the existing `apiOriginated` HTTP-origin marker); and extension-host teardown must kill PTYs synchronously or window reloads orphan agent shells. Mitigations: page-injected `?token=` transport that leaves the HTTP trust model byte-identical, the `apiOriginated` discriminator applied uniformly to delivery + pre-flight + worktree lookup, and the fleet's existing synchronous SIGKILL sweep reused in `deactivate()`. Residual risk sits in the release pipeline (platform-VSIX matrix correctness) and is covered by artifact inspection in manual UAT rather than by automated gates in this pass.

## Non-Goals

- No npm publishing. Standalone stays a dev path (`node dist/standalone/cli.js`); the naming problem (`switchboard` is taken; `@turnzero/switchboard` would collide with the VS Code extension identity, since `name` is shared and VS Code forbids scoped names) is deferred.
- No change to how the VS Code sidebar board dispatches — it keeps using VS Code terminals.
- No Linux PTY support in v1 (**user-confirmed 2026-07-31**); Linux gets the universal build and degrades via the probe. Context: the pinned `node-pty@1.1.0` ships no Linux prebuild (confirmed locally — `prebuilds/` holds darwin/win only), but the `1.2.0-beta` line (e.g. `1.2.0-beta.14`) now ships `linux-x64` and `linux-arm64` prebuilds — the upgrade path exists if this is ever revisited.

## Implementation Steps

### 1. Packaging

- `.vscodeignore`: un-ignore `node_modules/node-pty/**` specifically. Keep `node_modules/**` excluded otherwise.
- Webpack: add `'node-pty': 'commonjs node-pty'` to the **extension** config's externals (it is already in standaloneConfig). The JS must not be bundled; the binary loads at runtime from `node_modules`.
- Release script: build a target matrix with `vsce package --target`:
  - `darwin-arm64`, `darwin-x64`, `win32-x64`, `win32-arm64` — node-pty included.
  - One **universal** VSIX with node-pty excluded, as the fallback for Linux and anything unlisted. The marketplace serves platform-specific builds preferentially and falls back to universal.
- Trim what ships: only the current target's `prebuilds/<platform>-<arch>/` directory needs to be in each VSIX, and **exclude `**/*.pdb` from the Windows directories** — debug symbols are 27 of the 30 MB and the loader never touches them. Shipping all four platforms into every target is the difference between +136 KB and +58 MB on darwin; shipping PDBs is the difference between +3 MB and +30 MB on Windows.
- Publish mechanics (verified against vsce docs/issues, 2026-07-31): `universal` is **not** a valid `--target` value — the fallback VSIX is produced by omitting `--target`. Publish all five artifacts sequentially with `vsce publish --packagePath <file>`; do **not** use `--skip-duplicate` (vsce issues #868/#1014: the second target under the same version tag gets wrongly skipped). `engines.vscode` is already `^1.93.0`, above the `^1.61.0` floor platform targeting requires — no manifest change.
- Verify each artifact: the darwin VSIX must contain `prebuilds/darwin-*/pty.node` **and** `spawn-helper`; the Windows VSIXs must contain their `.node`/`.dll`/`.exe` files and **zero `.pdb` files** (assert the final `.vsix` is under 25 MB — the conservative floor of the Marketplace upload cap); the universal VSIX must contain no `.node` binary at all.

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
- `terminals.js`: stop hardcoding `/kanban/verb/` for the four `pty*` calls (`ptyListTerminals`, `ptyCreateTerminal`, `ptyRenameTerminal`, `ptyCloseTerminal`) and post them to `/terminals/verb/` (or route through the transport shim, which resolves the prefix on its own). **Clarification:** the panel's `getSetting` call (`terminals.js:156`, the `agents.visibleAgents` role-picker read) is a **Kanban** verb, not a PTY verb — it must stay on `/kanban/verb/`. A blanket "everything to `/terminals/verb/`" edit breaks the role picker; only the `pty*` fetches move.

**No compatibility burden:** `/kanban/verb/pty*` has no external consumers — standalone is unpublished (nothing is on npm; `switchboard` there belongs to a third party), so this surface has only ever been reachable in a dev checkout. Move it outright rather than aliasing.

### 2b. Terminal-channel authentication (DECIDED)

**Problem, verified in code.** `TaskViewerProvider.ts:1625-1628` supplies `getAuthToken: async () => await this._context.secrets.get('switchboard.apiToken') || ''`. That secret is opt-in and unset for essentially all installs, so it returns `''`. `_checkAuth` then short-circuits on `if (!expected) { return true; }` (`LocalApiServer.ts:526`) — the historical loopback-trust path. The terminal gateway, correctly, does the opposite: `rejectWhenTokenEmpty: true`. Net effect if nothing changes: the Terminals panel renders, the list populates over loopback-trusted HTTP, and **every `/ws/terminal` upgrade is rejected** — a silent, hard-to-diagnose dead panel.

**Decision: give the gateway its own terminal-scoped credential. Do NOT change `getAuthToken`, and do NOT relax the gateway.**

Two rejected alternatives, both tempting:

- *Relax the gateway to loopback-trust in the extension host.* Rejected outright. This is a remote-code-execution input channel — any local process able to reach 127.0.0.1 could attach and type into an agent shell. `rejectWhenTokenEmpty` exists precisely to make that impossible, and weakening it for convenience inverts the guard's purpose.
- *Have the extension generate a session token and return it from `getAuthToken`.* Looks correct, and is the trap. `getAuthToken` feeds `_checkAuth` for the **entire HTTP surface**, so a non-empty value flips the extension host from loopback-trust to token-required for `/health`, `/kanban/dispatch`, and every skill that shells out through `.agents/skills/_lib/sb_api_call.sh` — which carries no token handling whatsoever. That would 401 the whole skill ecosystem for a terminal feature.

**Design:**
- Generate a per-session terminal token at extension activation (`crypto.randomBytes`, in memory only — never persisted, never in SecretStorage; it dies with the host and a new one is minted on reload).
> **Superseded:** Pass the terminal token to the browser through the existing one-time-token exchange: append `?token=` to the Open-in-Browser URL, which `LocalApiServer` already swaps for an HttpOnly `sb_session` cookie. No new transport mechanism.
> **Reason:** Verified false in code. The exchange sets the cookie to `await this._options.getAuthToken()` (`LocalApiServer.ts:600`, `:652`, `:706`) — the **HTTP** token, which is `''` in the extension host. The WS upgrade authenticates against the **gateway's own** token closure (`authorizeWsUpgrade`, `wsUpgradeAuth.ts:63-76`), reading either a `?token=` query param on the upgrade URL or the `sb_session` cookie — and `terminals.js:426` appends no token param. So the cookie would carry `''`, the gateway would expect the terminal token, and every `/ws/terminal` upgrade would 401: exactly the dead panel this section exists to prevent. A (small) new transport IS required.
> **Replaced with:** Inject the terminal token into the served Terminals page and append it to the WS upgrade URL. (1) When the extension host serves `/terminals` HTML, add a bootstrap value (e.g. `window.__SB_TERMINAL_TOKEN__` via a `<script>` or `data-` attribute) carrying the per-session terminal token; standalone may inject its `sessionToken` the same way or keep relying on the cookie (there the two tokens coincide). (2) `terminals.js` appends `&token=<value>` to the `/ws/terminal` URL when the bootstrap value is present — `authorizeWsUpgrade` already accepts the query-param form (`wsUpgradeAuth.ts:63`), so no gateway change. (3) The one-time-token exchange and the `sb_session` cookie are left untouched: the cookie continues to carry the HTTP token, so installs that DO set `switchboard.apiToken` keep working — the cookie-value alternative (pointing `sb_session` at the terminal token) was rejected because it 401s the panel's own HTTP verb calls on exactly those installs.
- Construct the gateway with that token: `new TerminalWsGateway(fleet, async () => terminalSessionToken, ...)`. The constructor already takes its **own** `getAuthToken` closure, independent of `LocalApiServerOptions.getAuthToken` — in standalone the two coincide by coincidence (`async () => sessionToken`), not by design. So this is a one-argument change at the construction site.
- HTTP trust model untouched: skills, scripts and `/health` keep working exactly as today.

> **Superseded:** The cookie is shared with the HTTP surface, so a token minted for terminals also satisfies `_checkAuth` once set — strictly a tightening; note it so nobody later "simplifies" the two token sources into one.
> **Reason:** Muddled, and wrong under the corrected transport. The terminal token never enters the `sb_session` cookie at all (the cookie carries the HTTP token), so there is nothing to "simplify" and no tightening occurs. The real invariant worth recording is different.
> **Replaced with:** **Invariant:** two token sources exist by design — the HTTP token (`getAuthToken`, usually `''` ⇒ loopback-trust) and the terminal token (gateway-only, per-session, in-memory). The terminal token must never be returned from `getAuthToken` (that flips the whole HTTP surface to token-required and 401s the skill ecosystem — the trap documented above), and the gateway must never consult the HTTP token. The WS-URL `?token=` param is terminal-channel-only; HTTP verb calls from the panel keep authenticating via the cookie/loopback path exactly as today.

### 3. Per-surface dispatch routing (the load-bearing decision)

**Model: the dispatching surface picks the fleet.** Not a global mode setting.

- VS Code sidebar board → VS Code terminals (visible where the user is).
- Browser cockpit → PTY terminals (visible in its Terminals panel).

This removes the "dispatch into an invisible terminal" failure that a global mode creates, and needs no user-facing setting. Both fleets are legitimately live; the `ideName` partition already distinguishes them (`standalone-pty` vs the VS Code `ideName`) and `extension.ts`'s `isCompatibleIdeName` already prevents cross-adoption.

**Clarification — the surface discriminator (decided).** The model above names *who* picks the fleet but not *how the server knows*. Verified in code: the VS Code sidebar board dispatches **in-process** (webview `postMessage` → `KanbanProvider`), while the browser cockpit, CLI scripts and the orchestrator all dispatch **over HTTP** — `/kanban/dispatch` already marks this path with `apiOriginated: true` on the `triggerAction` payload (`LocalApiServer.ts:1211`). **Decision: HTTP-origin (`apiOriginated === true`) is the surface discriminator.** In the extension host, when the probe is live, an `apiOriginated` dispatch delivers to the PTY fleet (browser-visible); in-process drag-drop delivers to VS Code terminals (sidebar-visible). Consequence to state, not hide: CLI/orchestrator dispatches also land in PTYs — correct for a headless caller, since a browser-visible terminal beats an invisible one, and the standalone host already behaves exactly this way. Rejected alternative: an explicit `terminalTarget` payload field set by each client — one more thing every caller can forget, where `apiOriginated` already exists and cannot be spoofed into a worse outcome (worst case is a PTY dispatch, which is always displayable in the browser).

This discriminator is also what makes step 2a's routing guarantee hold in BOTH directions. Moving `triggerAction`'s PTY arm to `/terminals/verb/` stops the sidebar from spawning invisible PTYs; the `apiOriginated` rule stops the browser board's own drag-drop (which posts `triggerAction` to `/kanban/verb/` like any kanban panel) from spawning an invisible **VS Code** terminal — the mirror-image failure the step-2a rationale does not cover on its own.

Four shared consumers must learn which fleet is being asked about:

- **Prompt delivery (the one that actually sends the prompt).** In the extension host, `triggerAction`'s delivery path sends to a VS Code terminal from `TaskViewerProvider`'s registry. When `apiOriginated` and the probe is live, it must instead deliver through the fleet (the standalone `handlePtyVerb('triggerAction', …)` arm at `bootstrap.ts:974` is the reference implementation — extract the shared move-then-deliver logic rather than forking it). This is the consumer the UAT actually exercises; the other three are pre-flight and bookkeeping.
- `getRegisteredTerminals()` — feeds `/kanban/dispatch`'s 409 pre-flight (`LocalApiServer.ts:1201-1205`). It currently returns one list (VS Code terminals only, `TaskViewerProvider.ts:1630-1638`). It needs a surface argument keyed on the same `apiOriginated` discriminator, or a second hook, so an API dispatch destined for a PTY is not blocked by "no VS Code terminals are open" and vice versa.
- Worktree resolution — `matchWorktreePath` is fleet-agnostic and fine, but the terminal lookup that consumes it must search the right fleet under the same discriminator.
- Activity light — plan-file mtime driven and host-agnostic (`KanbanDatabase.ts:9218-9224`), so it needs no change. **Verify** rather than assume.

Rename the PTY `ideName` from `standalone-pty` to something host-neutral (e.g. `switchboard-pty`), since it will no longer be standalone-only. `PTY_IDE_NAME` is already a single exported constant, so this is one edit — but it is a **persisted registry value**, so existing `runtime.terminals` rows carry the old string. The boot purge already deletes rows matching either `purpose:'pty'` or the old `ideName`, so keep matching both on read.

### 4. Browser panel reachability

- The `/terminals` route already 404s when the manifest entry is disabled, so no change is needed to hide it — it simply becomes enabled once the probe passes.
- Confirm the panel's `getSetting`-based role picker resolves `agents.visibleAgents` in the extension host (it reads machine-global config, so it should).

## Proposed Changes

### `.vscodeignore`, `webpack.config.js`, `scripts/publish-release.sh`
- **Logic:** Un-ignore node-pty; externalize it in the extension config (`extensionConfig.externals`, `webpack.config.js:24-27` — currently only `vscode`; standalone already carries `'node-pty': 'commonjs node-pty'` at `:149-151`); add the `vsce --target` matrix plus a flag-less universal fallback; trim per-target prebuilds and strip `**/*.pdb`; publish sequentially via `--packagePath`, never `--skip-duplicate`.
- **Edge cases:** A target missing from the matrix silently gets the universal (no-PTY) build — acceptable and intended, but must be documented in the release notes. A Windows VSIX that still contains PDBs risks the Marketplace's 25–50 MB upload cap — the size assertion in UAT is the tripwire.

### Extension-host composition root (`extension.ts` / `TaskViewerProvider`)
- **Logic:** Probe, construct fleet + gateway, derive capabilities, wire `terminalVerb`, mint the terminal session token, inject it into the served `/terminals` page (step 2b corrected transport), dispose on deactivate.
- **Edge cases:** Probe false ⇒ every PTY surface absent, exactly as standalone behaves today. `getAuthToken` must be left alone (see step 2b) — changing it 401s the skill ecosystem.

### `src/services/LocalApiServer.ts` (route table + options)
- **Context:** Seven per-panel verb routes exist; `terminalWsGateway` is already an injected option.
- **Logic:** Add `/terminals/verb/` → `this._options.terminalVerb`; absent option ⇒ 503.
- **Edge cases:** Auth-gated identically to the other panel verb routes.

### `src/standalone/bootstrap.ts` (verb wiring)
- **Logic:** Pass `terminalVerb: handlePtyVerb`; remove the six PTY cases from `kanbanVerb`; keep the `ptyReady` guard on the new entry point.
- **Edge cases:** `handlePtyVerb` already takes `(verb, payload, root)` — a wiring move, not a rewrite.

### `src/webview/terminals.js` (verb calls + WS auth)
- **Logic:** Post the four `pty*` verbs to `/terminals/verb/` instead of the hardcoded `/kanban/verb/`, matching the prefix `transport.js:26` already derives from `data-panel="terminals"`; keep `getSetting` on `/kanban/verb/`; append the injected terminal token as `?token=` on the `/ws/terminal` upgrade URL when present (`terminals.js:426`).
- **Edge cases:** No token injected (standalone, where cookie auth already works) ⇒ no param appended, behaviour unchanged. `/kanban/verb/pty*` has no published consumer.

### `src/standalone/ptyFleetService.ts` (`PTY_IDE_NAME`)
- **Logic:** Rename to a host-neutral value; keep reading the legacy value so existing registry rows still purge.
- **Edge cases:** Do not migrate live rows — boot purge deletes them anyway.

### Shared dispatch consumers
- **Logic:** Key fleet selection on the `apiOriginated` HTTP-origin discriminator across four consumers: `triggerAction` prompt delivery (extension host delegates to the fleet arm when `apiOriginated` + probe live), `getRegisteredTerminals` (409 pre-flight), the worktree terminal lookup, and — verify-only — the activity light.
- **Edge cases:** No visible affordance may dispatch into a fleet the current surface cannot display. `apiOriginated` is already set on the `/kanban/dispatch` path; any NEW HTTP dispatch entry point added later must set it too, or its dispatches silently route to VS Code terminals — add a code comment at the discriminator naming this obligation.

## Verification Plan

**Session directive: SKIP COMPILATION and SKIP TESTS.** No compilation step and no automated tests are run as part of this verification pass. The automated gates below are recorded as expectations the implementation must satisfy in CI, not as steps this plan executes.

### Automated (CI expectations — not run in this pass)
- `npm run test:contract:pty-host-gating` (renamed by plan 1) — import-location + no-unguarded-construction + both webpack externals.
- `npm run compile`, `compile-tests`, `lint` clean.
- `catalog:check`, `parity:check`, `verb-returns:check`, `mirror:check` green. Step 2a's dedicated route keeps `pty*` out of the generated surface entirely, so these should be *unchanged* rather than regenerated — a diff in `protocol-catalog.json` or `verbAllowlist.ts` means something leaked into a Provider switch.
- New contract test: with the probe forced false, `availability.terminals` is false, `/terminals` 404s, `/ws/terminal` is destroyed, and the four `pty*` verbs return `success:false`.
- New contract test: `pty*` verbs are reachable on `/terminals/verb/` and **absent** from `/kanban/verb/` in both hosts, and `KANBAN_VERBS` contains no `pty` member.
- New contract test: the gateway rejects `/ws/terminal` when its own token is empty even from loopback (the `rejectWhenTokenEmpty` contract), and `_checkAuth`'s loopback-trust path is unaffected by the terminal token — i.e. an unauthenticated `GET /health` still succeeds when `switchboard.apiToken` is unset.
- New contract test: with an `apiOriginated: true` `triggerAction` in the extension host and the probe forced live, delivery routes to the fleet (not the VS Code terminal registry); with `apiOriginated` absent, delivery routes to VS Code terminals.

### Manual UAT (darwin)
- Build the darwin-arm64 VSIX, install it, confirm the packaged size delta is ~136 KB and `prebuilds/darwin-arm64/spawn-helper` is present.
- Build the win32-x64 VSIX, confirm it contains `conpty.node`/`pty.node`/`winpty.dll`/`winpty-agent.exe`, **zero `.pdb` files**, and the artifact is under 25 MB (expect ~3 MB of prebuilds).
- VS Code → **Open in Browser** → Terminals icon present → New Terminal (coder) → agent TUI renders and **streams** (this proves the corrected step-2b transport: rendering without streaming means the token never reached the gateway) → dispatch a card from the browser board → prompt lands in the PTY, working light on → agent edits the plan file → light off.
- Dispatch the same card from the **VS Code sidebar** board → prompt lands in a **VS Code** terminal, not the PTY.
- Reload the VS Code window → PTYs are gone, no orphaned shells (`ps` check), no SIGABRT in the extension host log.
- Install the universal VSIX on the same machine → no Terminals icon, no dispatch errors, board fully functional.
- **Skill-ecosystem regression check:** with `switchboard.apiToken` unset, run a skill that goes through `.agents/skills/_lib/sb_api_call.sh` and confirm it still succeeds. This is the specific breakage the step-2b design exists to avoid; if it 401s, `getAuthToken` was changed and must be reverted.

## Resolved Assumptions (web research, 2026-07-31)

The three external uncertainties flagged during plan review were researched and resolved:

- **Marketplace fallback semantics — CONFIRMED as assumed.** Since VS Code 1.61.0 the Marketplace serves `--target` packages preferentially and falls back to the target-less VSIX for unlisted platforms. The step-1 matrix works as designed. New constraints learned: `universal` is not a valid `--target` string (omit the flag), and `--skip-duplicate` must not be used when publishing multiple targets of one version (vsce #868/#1014). Both folded into step 1.
- **node-pty release state — RESOLVED, one research claim overridden by local ground truth.** Research claimed 1.1.0 ships *no* prebuilds; the installed `node_modules/node-pty@1.1.0` tarball provably contains `prebuilds/` for darwin-arm64, darwin-x64, win32-x64 and win32-arm64 — local wins. Confirmed true on both sources: 1.1.0 has **no Linux prebuild**; the `1.2.0-beta` line adds `linux-x64`/`linux-arm64` (recorded as a v2 option in Non-Goals / User Review Required). `1.2.0` stable is unannounced.
- **`vsce --target` values — CONFIRMED.** All four matrix targets are valid; `linux-x64`, `linux-arm64`, `alpine-*`, `linux-armhf` and `web` also exist if ever needed.
- **Bonus finding acted on:** the Marketplace enforces a ~25–50 MB per-VSIX upload cap; the 30 MB Windows package was inside that window only by luck. 27 MB of it is `.pdb` debug symbols — now excluded in step 1, bringing Windows targets to ~3 MB.

## Recommendation

Complexity 7 — **Send to Lead Coder.** Two load-bearing decisions (terminal-token transport, `apiOriginated` surface discriminator) are security-sensitive and span the composition root, the shared server, and the webview; the release-pipeline half is mechanical but unforgiving.

## Completion Report

Implemented extension host PTY fleet ownership, dedicated `/terminals/verb/` route, platform packaging configuration, and token-based terminal authentication. Modified `.vscodeignore`, `webpack.config.js`, `src/services/LocalApiServer.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `src/standalone/ptyFleetService.ts`, and `src/webview/terminals.js`. No compilation or automated test steps executed per prompt instructions.

## Review Findings

Review pass (2026-07-31) ran verification independently — compile, compile-tests, lint and all 26 CI-wired gates are green after fixes; `catalog:check` was red on arrival (the new `/terminals/verb/` endpoint) and `protocol-catalog.json` was regenerated, verb count unchanged at 512 so nothing leaked into a Provider switch. Fixed in `src/services/TaskViewerProvider.ts` (CSP-blocked token injection replaced with a body `data-terminal-token` attribute — the nonce-less inline `<script>` was blocked outright, giving exactly the render-but-never-stream dead panel step 2b exists to prevent; raw `pty.write()` replaced with `sendPromptToPty` for bracketed-paste/chunking/locking; one-shot fleet construction so the API-server watchdog restart no longer orphans PTYs, leaks gateway timers, purges live registry rows and rotates the token; `terminalFleet`/panel manifest gated on the fleet actually existing, not the probe alone), `src/webview/terminals.js`, `src/services/KanbanProvider.ts` and `src/standalone/bootstrap.ts` (four `pty*` cases removed from `kanbanVerb`; `ptyReady` guard added to the `terminalVerb` entry point). Step 3's `apiOriginated` surface discriminator was absent entirely and has been implemented across `ConfiguredKanbanDispatchOptions` → `_resolveAgentTerminalForPlan` / `_findTerminalNameByWorktreePathAndRole` / `_attemptDirectTerminalPush`, closing a real wrong-fleet bug (a sidebar dispatch for a worktree plan could deliver into a browser-only PTY) and making api-originated dispatch resolve a live PTY by role, which `_getAliveAutobanTerminalRegistry` structurally cannot supply. Step 1's release half and the built-in dispatch branch were then completed in the same pass (see Completion Report — round 2 below).

## Completion Report — round 2 (release pipeline + contract tests)

Added `scripts/package-targets.sh` (four `--target` builds plus a flag-less universal fallback, staging only the current target's prebuild directory per run behind an EXIT trap, with content and size assertions as build gates) and `scripts/publish-marketplace.sh` (sequential `vsce publish --packagePath`, never `--skip-duplicate`); wired `package:targets` / `publish:marketplace` npm scripts. Three new contract tests — `vsix-packaging`, `pty-route-surface`, `terminal-token-transport` — are written and wired into `.github/workflows/integration-tests.yml`, and `apiOriginated` now reaches the built-in dispatch branch via an optional trailing arg on `switchboard.triggerAgentFromKanban`. Three packaging defects were found and fixed by actually running the matrix rather than asserting about it: `.vscodeignore` negations override ignores **unconditionally regardless of line order**, so `!node_modules/node-pty/**` re-included 28 MB of `.pdb` symbols and `!dist/**` re-included 20 MB of source maps; `design_system/` (23 MB, zero runtime references) shipped; and `package.json`'s `files` array made `vsce package` fail outright ("VSCE does not support combining both strategies"), so **no VSIX could be built at all** — `files` was removed, npm publishing being an explicit non-goal. Verified end-to-end: all five artifacts build and pass their assertions — darwin 13,169 KB (+20 KB over universal), win32-x64 14,387 KB (+1,238 KB), universal 13,149 KB, every one with `pdb=0 map=0`, exactly one prebuild platform each and none in the universal build; compile, compile-tests and lint clean, 29/29 CI gates green. Remaining: manual UAT only (install a built VSIX, browser dispatch → PTY streaming, window-reload orphan check, `sb_api_call.sh` skill regression) — no code work outstanding.
