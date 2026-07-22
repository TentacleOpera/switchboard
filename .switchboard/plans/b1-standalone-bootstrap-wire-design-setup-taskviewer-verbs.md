---
description: "Layer-2 fix: wire the Design/Setup/TaskViewer verb routers into the standalone (npx) composition root so their /verb/* endpoints stop 503-ing. LocalApiServer already has the callback slots and route handlers; bootstrap.ts just never constructs the providers or passes the callbacks. Also replace the planningVerb memo-only stub."
---

# B1 Standalone Bootstrap — Wire Design / Setup / TaskViewer Verbs into `npx`

## Metadata
- **Project:** browser-switchboard
- **Tags:** backend, api, architecture
- **Complexity:** 6
- **Release phase:** B1 (standalone headless / npx). Layer-2 counterpart to `a2b-verb-engine-layer1-completion-return-schemas-tests.md` (Layer 1). This plan makes the verbs *reachable* over `npx`; that plan makes their reads *return data*.

## Goal

In the standalone (`npx switchboard`) process, construct `DesignPanelProvider`, `SetupPanelProvider`, and `TaskViewerProvider` with headless seams and pass their `handleServiceVerb` bridges to `LocalApiServer` as `designVerb` / `setupVerb` / `taskViewerVerb`, so `POST /design/verb/*`, `/setup/verb/*`, and `/taskViewer/verb/*` serve results instead of returning 503. Replace the `planningVerb` memo-only stub so Project-panel verbs beyond the 4 memo verbs stop returning the fake `{ success: true, note: 'not fully wired' }`.

### Problem / root-cause analysis

Even with Layer 1 complete, `npx switchboard` cannot serve Design/Setup/TaskViewer verbs, because the standalone composition root never wires them. Verified in `src/standalone/bootstrap.ts`:

- **Only two callbacks are passed to `LocalApiServer`** — `kanbanVerb, planningVerb` (`bootstrap.ts:726-727`). No `designVerb`/`setupVerb`/`taskViewerVerb`.
- A comment states the consequence outright (`bootstrap.ts:374-379`): *"Standalone serves Design/Setup HTML but does NOT wire their verb routers … so their verbs 503,"* and `getPanelsManifest({ design: false, setup: false })` greys the icons out.
- **No panel provider is constructed in the standalone process** — `grep 'new DesignPanelProvider|new SetupPanelProvider|new TaskViewerProvider' src/standalone/` is empty. `kanbanVerb`/`planningVerb` are hand-reimplemented switch blocks in `bootstrap.ts`; they do **not** delegate to the migrated providers' `handleServiceVerb`.
- **`planningVerb` is a memo-only stub** (`bootstrap.ts:667-710`): it implements `memoLoad/memoSave/memoClear/memoGeneratePrompt` and then `return { success: true, note: 'Planning verb '${verb}' not fully wired in standalone yet' }` for everything else.

The good news — the server side is already built: `LocalApiServer` declares the optional callback slots (`LocalApiServer.ts:181-183`) and has the route handlers that 503 only when the callback is absent (`:1519-1589`). The standalone secret/seam infrastructure also exists: `StandaloneHostSecrets`, `StandaloneHostPathConfigProvider`, `StandaloneHostState` (`src/standalone/hostServices.ts`), and `createStandaloneSecretStorage(secrets)` (`src/standalone/vscodeShim.ts:257`) which returns a `SecretStorage`-shaped adapter. So this is a **wiring job**, not new infrastructure.

## User Review Required
- None.

## Scope

### ✅ IN SCOPE
- In `bootstrap.ts`, construct the three providers for headless use. Two viable approaches — pick the one that matches how the providers already accept seams:
  1. **Direct seam injection** (mirrors the test harness): build the headless `HostSeams` bundle (using `StandaloneHostSecrets` for `HostSecrets`, `StandaloneHostPathConfigProvider`, etc.) and assign it to each provider's `_hostSeams` before first dispatch; or
  2. **Shim context**: construct each provider with a minimal context whose `.secrets` is `createStandaloneSecretStorage(secrets)` and `.extensionUri`/state come from the vscodeShim, letting `_initXService` build the vscode-shimmed bundle.
  Prefer whichever requires the least surface change; the providers' `handleServiceVerb` already lazily builds seams via `_seams()`.
- Wire the bridges into `LocalApiServer` options:
  `designVerb: (v, p, r) => designProvider.handleServiceVerb(v, p)`, and likewise `setupVerb`, `taskViewerVerb`.
- Flip `getPanelsManifest({ design: true, setup: true })` (and expose TaskViewer if the shell gates it) so the shell renders the panels as live.
- Replace the `planningVerb` stub tail: keep the memo special-cases, and delegate all other Project-panel verbs to a constructed `PlanningPanelProvider.handleServiceVerb` (or document precisely which remain intentionally unsupported headlessly, instead of a blanket fake success).
- Migrate the residual **outside-the-switch** `vscode.*` couplings that block real headless construction — Design `open()`/`deserializeWebviewPanel()` webview setup paths that run at construction, TaskViewer `handleGet*/Set*` setting helpers, `vscode.Terminal` type annotations — enough that the providers can be instantiated in the standalone process without a real `vscode` module. (Webview-panel *reveal* is inherently VS Code; the standalone path must not call it — construct for verb-serving only.)

### ⚙️ OUT OF SCOPE
- The arm-level return-in-body + schema work → the Layer-1 completion plan. (Without it, wired reads still return `{ success: true }` empty — so land Layer 1 first, or accept that reads are reachable-but-empty until it lands.)
- `node-pty` readable terminal output (B3) — dispatch verbs remain fire-and-track.
- New verbs / behavior changes.

## Implementation Steps
1. Construct `StandaloneHostSecrets`-backed provider contexts in `bootstrap.ts` (the `secrets` instance already exists at `bootstrap.ts:213`).
2. Instantiate the three providers headlessly; verify no code path calls `vscode.window.createWebviewPanel` / `.reveal` during construction or verb dispatch (guard or skip the webview-setup branches).
3. Add `designVerb`/`setupVerb`/`taskViewerVerb` to the `options` object passed to `LocalApiServer`; flip the panels manifest to enabled.
4. Rework `planningVerb` to delegate non-memo verbs to `PlanningPanelProvider.handleServiceVerb`.
5. Smoke each route: `POST /design/verb/<name>`, `/setup/verb/<name>`, `/taskViewer/verb/<name>` return 200 (not 503).

## Complexity Audit
### Routine
- Adding the three callbacks and flipping the manifest.
### Complex / Risky
- **Provider construction without a real `vscode`** — the providers were written for the extension host; instantiating them under the shim may trip webview/panel setup, file watchers (`vscode.workspace.createFileSystemWatcher`), or `onDidChange*` registrations at construction. Identify and guard those so construction is side-effect-safe headlessly.
- **Secret backend parity** — token verbs must resolve `HostSecrets` to `StandaloneHostSecrets` (encrypted file store), not a VS Code `SecretStorage`; verify a token written via `POST /setup/verb/<save>` is readable back via `/setup/verb/<get>` in the same standalone process.
- **planningVerb delegation** — ensure the memo special-cases (which intentionally differ headlessly: "send" degrades to copy) are preserved when delegating the rest.

## Dependencies
- Existing B1 standalone bootstrap (`src/standalone/bootstrap.ts`, `hostServices.ts`, `vscodeShim.ts`) and `LocalApiServer` callback slots/routes — present.
- **Layer-1 completion plan** — soft dependency: wiring makes verbs reachable; Layer 1 makes their reads non-empty. For end-to-end value, land Layer 1 first or in tandem.

## Verification Plan
### Automated
- `npm run compile-tests` green.
- A standalone smoke test boots the bootstrap, hits `POST /{design,setup,taskViewer}/verb/<readVerb>`, and asserts 200 + expected body (full body assertions require Layer 1).
### Manual / behavioral
- `npx` (dev build) → shell shows Design/Setup panels live (not greyed); a Design/Setup/TaskViewer verb round-trips over HTTP with no `vscode` process.
- Setup token save → get round-trip works against `StandaloneHostSecrets`.
- A non-memo Project-panel verb no longer returns `{ note: 'not fully wired' }`.

---

## Completion Report

Implemented the Layer-2 standalone wiring so `npx switchboard` constructs the Design/Setup/TaskViewer/Planning providers headlessly and routes their verbs through `LocalApiServer` (no 503s). Files changed: `src/standalone/vscodeShim.ts` (added `Terminal` type + `createTerminal`/`activeTerminal`/`terminals` headless-reject surfaces so dispatch paths fail loudly instead of `undefined is not a function`); `src/services/TaskViewerProvider.ts` (extracted the inline `_messageListener` assignment in `resolveWebviewView` into a new `_createMessageListener()` method plus a public `initHeadlessVerbServing(seams, broadcaster)` entry point, so the listener can be registered without spinning up the sidebar webview); `src/standalone/bootstrap.ts` (construct the four providers with an in-memory `ExtensionContext` + `createVscodeHostSeams` bundle over `StandaloneHostSecrets`/the vscode shim, inject `_hostSeams`/`_broadcaster`, wire `designVerb`/`setupVerb`/`taskViewerVerb` into the `LocalApiServer` options, flip `getPanelsManifest` to `{design:true, setup:true}`, rework `planningVerb` to delegate non-memo verbs to `PlanningPanelProvider.handleServiceVerb` while preserving the headless memo special-cases, and call `setApiServer`/`dispose` on the new providers). No issues encountered; per the task directives compilation and automated tests were skipped, so a `npm run compile-tests` + a standalone smoke (`POST /{design,setup,taskViewer}/verb/<readVerb>` → 200) should be run before marking Layer-2 done.
