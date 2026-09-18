# Deterministic Port Selection So Discovery Never Depends On A File

## Goal

Make the LocalApiServer's listen port **deterministic and probeable** in both hosts, so that finding a running Switchboard never requires `.switchboard/api-server-port.txt` to exist. Replace the ephemeral-port fallback with a bounded walk over a small fixed range (7777 → 7780), and make CLI discovery probe that range before consulting the file. The file keeps being written — it becomes advisory rather than load-bearing.

### Problem Analysis & Root Cause

**Observed failure (measured on the home lab box, 2026-09-01).** Switchboard was running and healthy — pid 1307298, `cli.js tailnet --no-open`, answering on port 7777:

```json
{"service":"switchboard","status":"ok","port":7777,"pid":1307298,
 "roots":["/home/patrick/switchboard"],"selectedWorkspaceRoot":"/home/patrick/switchboard"}
```

Yet `switchboard status` reported **"No running Switchboard instance found for this workspace."** So did `token show`. Both `.switchboard/api-server-port.txt` and `.switchboard/api-server.pid` were absent. Whether they were never written or deleted later is unknown — the server log records neither, and this plan does not depend on the answer.

**Three defects compose into it.**

**1. Discovery gives up before it probes — `src/standalone/cli.ts:417`.**

```ts
async function findRunningInstance(workspaceRoot: string): Promise<number | null> {
    const portFile = path.join(workspaceRoot, '.switchboard', 'api-server-port.txt');
    if (!fs.existsSync(portFile)) return null;   // ← hard bail
    const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
    if (isNaN(port)) return null;
    if (await probeHealth(port)) return port;
    return null;
}
```

`probeHealth` sits one line below the bail and is never reached when the file is missing. `/health` already returns everything discovery needs to both find the server *and* prove it is the right one: `service`, `port`, `pid`, and the `roots` array. The file caches a single integer that an HTTP round trip recovers in milliseconds.

**2. The standalone host falls back to an unguessable port — `src/standalone/cli.ts:2805`.**

```ts
let listenPort = args.port;                      // default 7777 (parseArgs:142)
if (typeof listenPort === 'number' && listenPort > 0 && !(await isPortFree(listenPort))) {
    console.warn(`[switchboard] Port ${listenPort} is in use, falling back to an ephemeral port.`);
    listenPort = 0;                              // ← OS-assigned, ~28,000 possibilities
}
```

This is the one branch that genuinely justifies the file: once the port is ephemeral, nothing but the file records it. The pre-boot probe itself is correct and must be preserved — the comment above it explains why (a catch-and-retry around `startHeadlessSwitchboard` would strand a half-built instance's fs watchers and DB handle, then stack a second engine on the same plan files). Only the *destination* of the fallback changes.

**3. The extension host is ALWAYS ephemeral — and this is the real gap.**

`src/services/TaskViewerProvider.ts:3788` constructs `new LocalApiServer({ ... })` and passes **no `port` option at all**. `src/services/LocalApiServer.ts:784` then does:

```ts
this._port = options.port || 0; // 0 ⇒ random port; non-zero lets tests/CLI bind a fixed port
```

So the VS Code extension has never used 7777 — it binds a random ephemeral port on every start. For the extension, the port file is not a cache of a knowable value; it is the **only** record that exists. Fixing standalone alone would leave the two composition roots on opposite discovery models and deepen the divergence CLAUDE.md forbids.

**Blast radius — this is not only `status`.** `.switchboard/api-server-port.txt` is the documented discovery path baked into roughly forty agent prompt fragments across `teamWiring.ts`, `standingOrders.ts`, `standingOrderFragments.ts`, `agentPromptBuilder.ts`, `PlanIngestionEngine.ts`, `schedulerPresets.ts` and `linkPresets.ts` — every variant of *"POST /kanban/queue/done with {"from":"..."} against the port in .switchboard/api-server-port.txt"*. Completion reports, queue pulls (`/kanban/queue/next`), reviewer relays (`ptySendPrompt`) and review escalations (`/kanban/move`) all route through it. When that file is missing, every dispatched agent is told to read something that is not there, and the failure is silent — the agent simply never reports.

**Release status — this is a clean break, not a migration.** The LocalApiServer has been present in released builds since `c77de7ea` (2026-04-29), but it was experimental there and not working well; nothing in the install base depends on its port behaviour. Moving the extension from an ephemeral port to 7777 therefore carries no migration obligation and needs no compatibility shim, no notice, and no fallback for old clients.

**Why a walk rather than a single fixed port.** One server serves many roots (`/health` returns a `roots` array; `_filterPortFileEligibleRoots` at `TaskViewerProvider.ts:4574` fans the file out to each eligible root), so per-workspace collision is not the concern. Two independent hosts on one machine is — a second VS Code window, or standalone alongside the extension. A four-port walk resolves that deterministically where a single hardcoded port would fail, and stays cheap enough to probe exhaustively during discovery.

## Metadata
**Topic:** Deterministic LocalApiServer port selection in both hosts
**Tags:** cli, standalone, extension, discovery, infrastructure, bugfix

**Complexity:** 5

## User Review Required

None.

## Complexity Audit

### Routine
- Moving `isPortFree` into a shared `src/utils/portResolver.ts` module — it already works, just needs relocating.
- Reordering `findRunningInstance` to probe before reading the file — the probe logic already exists one line below the bail.
- Keeping the port/pid file writers as-is — no change to `bootstrap.ts:3515` or the extension's writer at `TaskViewerProvider.ts:4352`.
- The `--port 0` explicit-ephemeral opt-in path is unchanged.

### Complex / Risky
- **Extension composition root seam** — adding `port: await resolvePreferredPort() ?? 0` to the `new LocalApiServer({...})` options at `TaskViewerProvider.ts:3788`. This is an options-object field where "never wired" and "working" are indistinguishable without reading the composition root — the exact class of divergence CLAUDE.md names. `_startLocalApiServer` is re-entrant (the liveness watchdog re-calls it on every failed health check), so the port walk runs on every restart.
- **Root-matching in the discovery walk** — comparing `workspaceRoot` against `/health`'s `roots` array must use `path.resolve()` on both sides, not raw string equality. Trailing slashes, symlinks, and relative paths will break an exact match.
- **Tailnet mode** — `probeHealth` defaults to `127.0.0.1`, but a tailnet server binds to a Tailscale interface. The walk will not find a tailnet server; the file remains the only discovery path. This is not a regression (today has the same gap) but the Goal's "never" is overbroad for tailnet.

## Edge-Case & Dependency Audit

**Race Conditions:**
- `_startLocalApiServer` is re-entrant (watchdog re-calls on failed health check). If the server crashed and the socket is in TIME_WAIT, `isPortFree(7777)` returns false, the walk picks 7778, and the server restarts on a different port. The port file writer updates, but agents that cached the old port hit a dead socket until they re-discover. Low-frequency (watchdog fires on health-check failure, not routine), but the plan should note it.
- Two VS Code windows starting simultaneously could both walk the range and race for the same port. `isPortFree` is a TOCTOU probe — free at probe time, taken by the other window at bind time. `LocalApiServer.start()` must handle EADDRINUSE on the resolved port (it already does for ephemeral, but the plan should confirm the error path doesn't silently swallow it).

**Security:**
- The walk probes `127.0.0.1` only — no external exposure. Root-matching prevents a second workspace's server from being mistaken for this one's. No new attack surface.

**Side Effects:**
- The extension moving from ephemeral to 7777 changes the port every existing agent prompt fragment references. The fragments still work (they read the port file, which is still written), but the port they resolve to changes from random to 7777. No behavioural change for agents — they follow the file.
- `isPortFree` binds and immediately closes a probe socket on each port in the range. Four throwaway sockets per discovery attempt — negligible.

**Dependencies & Conflicts:**
- No dependency on other plans. This is the prerequisite for "Agent Callbacks Route Through The Bundled CLI" — that plan's `cmdVerb` resolves through `findRunningInstance` and is inert until this plan's probe-first discovery lands.
- `src/utils/portResolver.ts` is a new shared module — both `cli.ts` and `TaskViewerProvider.ts` import it. Webpack must bundle it into the VSIX (uses only the `net` builtin, no `node_modules` at runtime).

## Dependencies

None — this plan is the foundation. The sibling subtask "Agent Callbacks Route Through The Bundled CLI" depends on this one.

## Adversarial Synthesis

Key risks: (1) tailnet mode is invisible to the loopback walk — the file remains load-bearing there, making the Goal's "never" overbroad; (2) root-matching via raw string equality would fail on trailing-slash/symlink path variants — must use `path.resolve()` on both sides; (3) the extension's re-entrant `_startLocalApiServer` re-walks the port range on every watchdog restart, which can shift the port if the prior socket is in TIME_WAIT. Mitigations: narrow the Goal's scope to loopback mode (or add a tailnet probe), specify `path.resolve()` in the root-matching implementation, and log a warning in the extension root when `resolvePreferredPort()` returns null (matching the standalone root's existing warning).

## Proposed Changes

**1. New shared resolver — `src/utils/portResolver.ts`.**

`isPortFree` currently lives at `cli.ts:448` and is unreachable from the extension. Move it (or export a copy) into a shared module alongside a new resolver:

```ts
export const PORT_BASE = 7777;
export const PORT_SPAN = 4;               // 7777..7780 — one constant, one line to widen

export function isPortFree(port: number): Promise<boolean>;

/** First free port in [PORT_BASE, PORT_BASE+PORT_SPAN). Returns null if all are taken. */
export async function resolvePreferredPort(base = PORT_BASE, span = PORT_SPAN): Promise<number | null>;
```

Uses only the `net` builtin — nothing new for webpack to bundle into the VSIX.

**2. Standalone composition root — `src/standalone/cli.ts:2805`.**

Replace `listenPort = 0` with `await resolvePreferredPort()`. Keep the pre-boot probe structure exactly as it is. Preserve `--port 0` as an explicit opt-in to ephemeral. If the whole range is taken, fall back to ephemeral as today and log that discovery will require the port file.

**3. Extension composition root — `src/services/TaskViewerProvider.ts:3788`.**

Add `port: await resolvePreferredPort() ?? 0` to the `new LocalApiServer({...})` options object. This is the seam that has never been wired; `LocalApiServer.ts:784` already honours a non-zero `options.port`, so no change is needed inside the service. If `resolvePreferredPort()` returns `null` (all four ports taken), log a `console.warn` matching the standalone root's "falling back to an ephemeral port" message — a silent fallback here defeats the plan's entire purpose for the extension and is undiagnosable without the log line. Note: `_startLocalApiServer` is re-entrant (the liveness watchdog re-calls it on every failed health check), so the walk runs on every restart — this is acceptable (the watchdog is rare) but the coder should be aware.

**4. Discovery probes before reading — `src/standalone/cli.ts:417`.**

Reorder `findRunningInstance`: walk `PORT_BASE..PORT_BASE+PORT_SPAN` calling `probeHealth`, and accept the first response whose `roots` array contains the requested `workspaceRoot`. Only if the walk finds nothing fall through to the existing port-file read, which still covers the explicit-ephemeral case. Root-matching is what makes the walk safe — it prevents a second workspace's server on 7778 being mistaken for this one's. **Both sides of the root comparison must be `path.resolve()`d** before matching — raw string equality breaks on trailing slashes, symlinks, and relative paths. **Tailnet caveat:** `probeHealth` defaults to `127.0.0.1`, so a tailnet-mode server (bound to a Tailscale interface) is invisible to the walk. The file-based fallback still covers this case (the file is written at `bootstrap.ts:3515`), but the Goal's "never requires the file" is overbroad for tailnet — the walk achieves it for loopback mode only.

**5. Keep writing the port and pid files — for the ephemeral case, not for compatibility.** `bootstrap.ts:3515` and the extension's writer stay as they are. The justification is narrow and technical: `--port 0` remains an explicit opt-in to ephemeral, and the range can in principle be exhausted. In both cases the file is the only record of the port, so it must keep being written. It is no longer a gate on discovery, and it is not being preserved for the install base.

**Explicitly out of scope.** The ~40 agent prompt fragments are not edited. Once the port is deterministic they are still correct — and rewriting them is a separate, much larger change with its own review surface.

## Verification Plan

### Automated Tests

No automated test suite covers this surface — the LocalApiServer port-binding and CLI discovery paths are integration-level and require a running host. The verification steps below are manual integration checks against both composition roots. (Session directive: automated tests are not executed in this run; the checks remain documented for the implementer.)

Both hosts, every time — a green standalone run proves nothing about the extension here, because defect 3 lives only in the extension's composition root.

**Standalone:**
1. `switchboard local` on a clean workspace → binds 7777; `switchboard status` reports online.
2. Occupy 7777 (`nc -l 7777`), start again → binds **7778** and logs the walk, not "falling back to an ephemeral port".
3. With the server up, `rm .switchboard/api-server-port.txt` → `switchboard status`, `plans`, `ready` and `dispatch` all still find it. **This is the regression test for the reported failure** and must fail before the change.
4. `switchboard --port 0` → still ephemeral; discovery falls through to the file and succeeds.
5. Occupy 7777–7780 → ephemeral fallback, warning logged, file-based discovery still works.

**Extension:**
6. Launch the extension host → `GET 127.0.0.1:7777/health` answers with `service: "switchboard"`. Today it answers on a random port; this is the behaviour change that proves the seam is wired.
7. Second VS Code window on a different workspace → second server on 7778; each `findRunningInstance` resolves to the server whose `roots` contains its own workspace root, not merely the first that answers.
8. Delete the port file from a workspace root while the extension runs → agent-facing endpoints remain reachable by probe.

**Both:**
9. `npm run compile` clean — confirms `src/utils/portResolver.ts` bundles into the VSIX (no `node_modules` at runtime).
10. Diff the two composition roots by hand and confirm both now pass an explicit `port`. Verb-reachability audits will not catch a regression here; the seam is an options-object field where "never wired" and "working" look identical.

### Goal Invariants

- **Negative:** `findRunningInstance` in `src/standalone/cli.ts` does NOT contain an early `return null` gated solely on `!fs.existsSync(portFile)` — the file-existence check is reachable only after the port-range walk has been attempted and failed.
- **Positive:** `findRunningInstance` returns a non-null port when a healthy Switchboard server is listening on any port in [7777, 7780] whose `/health` response `roots` array contains the requested `workspaceRoot` (after `path.resolve()` on both sides), even when `.switchboard/api-server-port.txt` is absent.
- **Positive:** `new LocalApiServer({...})` at `src/services/TaskViewerProvider.ts:3788` includes a `port` option in its options object — the field is present and non-zero when `resolvePreferredPort()` returns a non-null value.
- **Negative:** `src/utils/portResolver.ts` does NOT import any module outside the Node.js standard library (`net`, `path`, `fs`) — it must bundle into the VSIX with zero `node_modules` dependencies.
- **Positive:** `resolvePreferredPort()` in `src/utils/portResolver.ts` returns a port in [7777, 7780] when at least one port in that range is free, and returns `null` when all are taken.

## Implementation Summary

Implemented deterministic port selection and discovery across both hosts. Added `src/utils/portResolver.ts` exposing `resolvePreferredPort` over the range 7777–7780 and `isPortFree` using native `net` socket probes. Updated `src/standalone/cli.ts` so `findRunningInstance` probes health on ports 7777–7780 with workspace root verification before falling back to `api-server-port.txt`, and wired `resolvePreferredPort` into the standalone listener fallback. Wired `resolvePreferredPort` into `src/services/TaskViewerProvider.ts` for the extension host composition root so both hosts bind deterministic ports and support probe-first discovery without mandatory port files.

## Review Findings

Reviewed commit `70e29af9`; the port half needed one fix. `KanbanProvider._resolveRosterAndPort` (KanbanProvider.ts:5744) called `this._taskViewerProvider?.getLocalApiServerPort()` with the guard on the provider but not the method, so the whole batch drive prefix threw `TypeError` whenever the provider was a partial object — `test:contract:drive-mode-prompt-overhaul` went from green to red on this commit; changed to `?.()` and it is green again. Verified live against the running server (pid 1307298 on 7777): `isPortFree(7777)` is false and `resolvePreferredPort()` walks to 7778; a faithful replay of `findRunningInstance`'s walk resolves 7777 for `/home/patrick/switchboard` and for the same path with a trailing slash, and `null` for a foreign root, and the shipped `dist/standalone/cli.js status` finds the server from the repo root and correctly refuses from a root with no port file that `/health.roots` does not list. `npm run compile` is clean and `src/utils/portResolver.ts` bundles into both `dist/extension.js` and `dist/standalone/cli.js` with only the `net` builtin. Files changed by this review: `src/services/KanbanProvider.ts`.

The plan's tailnet caveat is over-cautious and can be dropped: `LocalApiServer.start()` retains the loopback listener alongside the tailnet one on the same port, so the loopback walk finds a tailnet-mode server. The manual step "delete the port file and re-discover" was NOT executed — the live board is serving other agents and the watchdog restarts the server when the file is missing — so that specific step is unverified; the walk replay above covers the same code path without disturbing it.

## Deferred Findings

- NIT `src/standalone/cli.ts:422` — `findRunningInstance` now probes four ports at 500 ms each before falling back to the port file, so every CLI call against a stopped server costs ~2 s where it used to fail instantly.
- NIT `src/standalone/cli.ts:428` — the 500 ms `/health` timeout in the walk is tight; a loaded host can exceed it, and the failure is silent (the walk falls through to the port file, and to "not found" when the file is absent).
- NIT `src/services/TaskViewerProvider.ts:3800` — the extension can now fail `start()` with `EADDRINUSE` (TOCTOU between `resolvePreferredPort` and `listen`, or two concurrent `_startLocalApiServer` entries) where it previously always bound an ephemeral port. The watchdog retries, so it self-heals after one interval; the failure is logged to the diagnostics channel.
- NIT `src/services/KanbanProvider.ts:6205,6247,6291` — the three pre-existing `getLocalApiServerPort()` call sites still use `provider?.method()` rather than the `provider?.method?.()` shape that this review had to fix at 5744.
- NIT `src/services/TaskViewerProvider.ts:7113` — the memo-processing prompt still tells the agent to check `.switchboard/api-server-port.txt` to decide whether the extension is running: the same self-defeating file gate this feature removes elsewhere. Outside the plan's named site list.
