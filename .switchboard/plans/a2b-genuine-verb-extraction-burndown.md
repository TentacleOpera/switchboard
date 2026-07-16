---
description: "Feature A · A2b follow-on: make the extension's verb handlers genuinely host-agnostic for B1 (headless, no VS Code). REVISED after a design audit — the original shim→twin-method recipe is the wrong vehicle; this plan uses INVERT-AND-INJECT (the provider becomes the host-agnostic engine; seams are injected in-place) plus a generic dispatch fallback. Plan only; do NOT start."
---

# A2b — Host-Agnostic Verb Engine — Design Record (INVERT-AND-INJECT)

> **Status: DESIGN RECORD — do not dispatch this card.** Implementation was split (2026-07-16) into the "Host-Agnostic Verb Engine" feature's six subtasks (`a2b-verb-engine-01-foundations.md` — the hard part — plus one burndown per provider, 02–06). This file is kept as the authoritative design rationale: the shim-rejection audit, the INVERT-AND-INJECT approach, and the global constraints. It supersedes the earlier shim-extraction approach (see "Why the shim approach was rejected").

## Goal

Make the extension's message handlers run **without VS Code** (the B1 headless prerequisite) — not just reachable-over-HTTP-while-VS-Code-runs. Achieve this by **injecting the host behind seams into the providers in-place**, so `_handleMessage` *becomes* the host-agnostic engine, rather than copying 605 handlers into a parallel service layer.

## Why the shim approach was rejected (design audit, 2026-07-08)

The prior approach exposed all 605 verbs over HTTP, but ~593 as **shims** — service methods that forward `ctx.handleMessage({type, ...payload})` back into the vscode-coupled `_handleMessage`. A design audit found this is the wrong vehicle:

- **The `ctx.handleMessage` back-door defeats decoupling.** A "host-agnostic service" that calls back into `_handleMessage` (229 `vscode.*` refs, ~53 `executeCommand`) is not decoupled — a shim can *never* run headless; it dead-ends in vscode.
- **Write-only reads.** `_handleMessage` arms `break` (never `return`), so a shim resolves to `{success:true}` with no data; the result escapes only as a webview/WS push. A remote HTTP client can *invoke* `get*`/`fetch*`/`load*` verbs but **cannot read the result** — incoherent for a remote-control API.
- **Negative-value work + recursion trap.** Each shim is written now and thrown away later; and the moment an arm is repointed to a same-named shim, `_handleMessage → svc.verb → ctx.handleMessage → _handleMessage` stack-overflows. That landmine would be armed ~593 times.
- **Shallow command seam.** Routing `executeCommand('switchboard.fullSync')` through `HostCommands` relocates coupling; a headless host must still reimplement ~26 `switchboard.*` commands.
- **Untyped, unvalidated, unmaintainable at scale.** `payload: any`, no per-verb schema, and a hand-maintained 605-case `switch` (with `default` mid-switch) across 5 providers.

The seam interfaces (`hostSeams.ts`) + `broadcastHub` foundation are sound and are kept; the ~10 genuinely-extracted Kanban verbs prove a testable target. Only the shim *vehicle* is replaced.

## Metadata
- **Tags:** refactor, backend, api, architecture
- **Complexity:** 8
- **Release phase:** B1 (headless standalone) prerequisite — NOT a Feature A release blocker (shims already satisfy Feature A's "VS Code minimised" model). Sequence with `standalone-headless-core-service-bootstrap.md`.
- **Relates to:** parent A2b (`transport-migration-per-verb-burndown.md`), A2a seams, A1 catalog.

## User Review Required
- **Request/response contract (product call, needs a decision before build):** should every verb **return its result in the HTTP body** (recommended), with the webview push kept only as an optional live-UI update? Today reads are push-only, so an HTTP client can't read. **Recommendation: return-in-body is the contract; push is additive.** Decide this first — it shapes the arm-return refactor below.
- Otherwise: None.

## Scope

### ✅ IN SCOPE
1. **Inject the host into the providers in-place.** Each provider already builds seams + broadcaster in `_initXService`. Replace direct `vscode.*` / `this._panel.webview.postMessage` / `executeCommand` calls **inside the existing `_handleMessage` arms** with the seam / broadcaster equivalents. The arm keeps its logic; only the host coupling is swapped. `_handleMessage` then runs unchanged under a headless seam bundle.
2. **Deepen the command seam.** Extract the shared logic behind the ~26 `switchboard.*` commands the verbs invoke into **host-agnostic domain services** (e.g. `SyncService.fullSync()`), and have arms call those directly instead of `HostCommands.executeCommand('switchboard.X')`. `HostUI`/`HostEditor`/`HostPathConfigProvider`/`TerminalBackend` stay as-is (genuine host side-effects).
3. **Fix the request/response contract.** Make each arm **return** its result (per the product decision above) in addition to any live-UI push. The HTTP handler returns that value; a remote client can read.
4. **Replace the 605-case switches + 593 shims with a generic, allowlist-gated dispatch.** `handleServiceVerb(verb, payload)` → validate `verb` against an **allowlist `Set`/registry** (data, not control flow) → validate `payload` against the verb's **schema** → `return this._handleMessage({ type: verb, ...payload })`. Delete the per-verb shim methods and the string-keyed service twins. Un-migrated verbs are reachable through the same generic path with **zero per-verb code and no recursion risk** (the arm is never repointed to a same-named method).
5. **Quarantine / remove the `ctx.handleMessage` back-door.** Once arms run on seams, the back-door is unnecessary; keep it (if at all) only as the single generic dispatch entry, never as a per-verb forwarder.
6. **Per-verb input schema + validation** at the dispatch boundary (the network turns trusted postMessage input into untrusted input).

### ⚙️ OUT OF SCOPE
- The standalone composition root / keyring / headless bootstrap itself → **B1**. This plan makes `_handleMessage` runnable headlessly; B1 supplies the headless seam bundle + entry point.
- `node-pty` terminal backend → **B3**. Browser board → **B2**. npx → **B4**.
- New verbs / behavior changes — this is a **byte-compatible in-place refactor** of shipped provider code (~4,000 installs).

## Disposition of existing artifacts
- **Shim service classes** (`kanbanService`/`planningService`/`designService`/`setupService`/`taskViewerService`): the string-keyed shim methods are **deleted** (unreleased dev work → clean break, no migration). Genuinely host-agnostic domain logic already extracted (e.g. `getSetting`, `saveSetting`) is **kept** — either as a domain-service method the arm calls, or folded back into the arm. The classes survive only if they hold real shared domain logic.
- **The 605-case `handleServiceVerb` switches**: collapse to one generic allowlist-gated dispatcher per provider.
- **`ctx.handleMessage`**: demoted to the single generic dispatch path, or removed.

## Implementation Steps (per provider, orchestrated)
1. **Domain-service extraction first:** pull the ~26 `switchboard.*` command bodies into host-agnostic domain services (`SyncService`, dispatch service, etc.). This unblocks arms that call `executeCommand`.
2. **In-place arm migration:** per arm, replace `vscode.*`/`executeCommand`/raw `postMessage` with seam / domain-service / broadcaster calls, and add a `return` of the result. No twin method.
3. **Collapse dispatch:** replace the per-provider switch with the allowlist+schema registry → generic `_handleMessage` dispatch that returns results. Delete shims.
4. **Order:** Design (62) as the proving panel → Setup (117) → Kanban (144) → TaskViewer (110) → Planning (172).
5. **Orchestration:** one agent stream **per provider file** (avoid same-file edit collisions), batch ~20–30 arms, `compile-tests` gate between batches, merge incrementally. Multi-session; large token spend — but **no double-work** (each arm touched once, in place) and **no recursion trap** (arms never repoint to twins), which is materially less effort than the shim-then-rewrite path.
6. **Seam growth:** add a seam (incl. the missing `HostSecrets`) when an arm hits an uncovered host surface; stop, add, wire into every `_initXService` ctx, resume.

## Complexity Audit
### Routine
- Mechanical `vscode.X → seam.X` swaps inside arms with no coupling beyond the 5 seams.
- Collapsing the switch to a registry.
### Complex / Risky
- **Byte-compatibility on shipped providers** (4,000 installs): in-place edits to the live `_handleMessage` hot path. Reply timing, error/ack push shapes, and `workspaceRoot` resolution must not drift. Per-provider tests must pass unchanged.
- **Command-seam deepening**: extracting ~26 `switchboard.*` command bodies into host-agnostic services is the genuinely hard part (terminal/worktree/dispatch, ClickUp/Linear sync).
- **Arm-return refactor**: arms currently `break`; making them `return` their result must not change side-effect ordering.
- **Parallel edit collisions**: partition strictly by provider file.

## Edge cases & risks
- **Test seams are the acceptance signal.** Each migrated arm must run under a test seam bundle with **no `vscode` import reachable** — this, not "compiles", proves host-agnosticism.
- **Un-migrated verbs still work** via the generic dispatch (they run in-process while VS Code is the engine) — the burn-down is incremental and never breaks the board.
- **Do NOT assume readable terminal output** — that arrives only with B3's node-pty backend.
- **Push discoverability (catalog):** routing pushes through helpers already dropped the static catalog's `pushSites` (969→630); once arms return results, push discovery matters less, but treat `pushSites` as a lower bound and prefer runtime push enumeration.

## Dependencies
- **A2a seams** (present; add `HostSecrets` on first use).
- **A1 catalog** (present — the per-verb checklist).
- **Unblocks B1** (headless standalone) — B1 cannot run verbs headlessly until arms are seam-injected.

## Verification Plan
### Automated
- `compile-tests` green per batch. Parity gate's genuinely-extracted count rises toward 605/605 (0 shims). Push-routing ratchet stays green.
### Manual / behavioral
- **Headless smoke:** a sample of migrated arms execute under a test seam bundle with no `vscode` — the real proof.
- **Request/response:** `POST /<panel>/verb/<readVerb>` returns the data in the HTTP body (no second WS channel needed).
- Per-panel provider tests pass unchanged (byte-compat). A `POST /<panel>/verb/<name>` and the equivalent webview `postMessage` produce equivalent effects/results.

## Effort note
Multi-session, orchestration-driven. **Cheaper than the shim approach** — each verb is touched once, in place; no twin methods, no rewrite-twice, no recursion landmines. Estimate: a handful of agent runs per provider across a few passes, with compile gates.
