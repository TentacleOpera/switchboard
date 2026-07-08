---
description: "Feature A · A2b follow-on: convert the ~593 shim verbs (which forward back into the vscode-coupled _handleMessage) into genuinely host-agnostic service methods behind A2a's seams — the real handler extraction the plan specified, and the prerequisite for B1 headless. Plan only; do NOT start."
---

# Feature A · A2b — Genuine Host-Agnostic Verb Extraction (Shim Burn-Down)

> **Status: PLAN ONLY — do not begin extraction. This documents the remaining work and how to execute it.**

## Goal

Convert the **~593 shim verbs** across the five panel services into **genuinely host-agnostic** service methods — moving each `_handleMessage` arm's real logic into its service method and routing every `vscode.*` call through A2a's seams — so every catalogued verb runs **without VS Code** (the B1 headless prerequisite), not just reachably-over-HTTP-while-VS-Code-runs.

### Problem & root cause

A2b's per-verb rail currently exposes all **605 verbs** over HTTP (`POST /{kanban,planning,design,setup,taskViewer}/verb/<name>`), and the honest parity gate reports the true breakdown: **12 genuinely extracted, 593 shims** (Kanban 10 real / 134 shim, Setup 2 / 115, Planning 0 / 172, Design 0 / 62, TaskViewer 0 / 110). A **shim** is a service method whose body is `return this._ctx.handleMessage({ type: '<verb>', ...payload })` — it forwards straight back into the provider's `_handleMessage`, where the `vscode.*` coupling still lives.

Shims made the surface **reachable** (an external client can drive every verb while VS Code runs minimised — Feature A's stated model). They did **not** make it **decoupled**: a shim still transitively requires `vscode`, so it cannot run in a headless standalone process. Reachable ≠ host-agnostic. Root cause: the per-verb recipe was proven on ~12 Kanban verbs and the rest were stubbed to light up the surface quickly; genuine extraction (the plan's literal "each case arm's body moves to a shared host-agnostic service module") is the deferred long pole.

## Metadata
- **Tags:** refactor, backend, api
- **Complexity:** 8
- **Release phase:** Extension-as-engine (Feature A) is satisfied by shims; this plan is the **B1 (headless standalone) prerequisite**. See `standalone-headless-core-service-bootstrap.md`.
- **Relates to:** parent A2b (`transport-migration-per-verb-burndown.md`), A2a seams (`extract-standalone-npx-03-transport-migration.md`), A1 catalog (`extract-standalone-npx-01-protocol-core.md`).

## User Review Required
- **One genuine product call:** does full extraction gate the **Feature A** release, or is it **B1-scoped** (post-release)? **Recommendation: B1-scoped.** Shims satisfy Feature A's "VS Code stays the engine, minimised" model — external clients can already drive every verb. Genuine extraction is only *required* for a headless host with no VS Code. Sequence this plan with B1, not as a Feature A release blocker. (Decision stated; not hedged — flip only if a headless client is needed before B1.)

## Scope

### ✅ IN SCOPE
- **Convert 593 shims → real extractions** across `kanbanService.ts` (134), `planningService.ts` (172), `designService.ts` (62), `setupService.ts` (115), `taskViewerService.ts` (110). For each verb: move the `_handleMessage` arm's real body into the service method, replacing every `vscode.*` reference with the corresponding A2a seam call (`HostCommands` / `HostUI` / `HostEditor` / `HostPathConfigProvider` / `TerminalBackend`).
- **Extract-BEFORE-repoint ordering** (hard rule — see Risks): a repointed webview arm that delegates to a *shim* self-recurses (`_handleMessage → svc.verb → handleMessage → _handleMessage`). Every verb must be genuinely extracted before its arm is repointed.
- **Seam-growth protocol:** when a verb hits a vscode surface not covered by the existing seams, stop, add the interface + vscode impl to `hostSeams.ts`, wire it into each `_initXService` ctx, then resume. Add the missing **`HostSecrets`** seam (A2a residual) when the first secret-reading verb is reached.
- **Tighten the parity gate incrementally:** once a panel reaches zero shims, flip `check-protocol-parity.js` to *fail* if a shim reappears in that panel (ratchet toward 605 genuinely-extracted).
- **Restore push discoverability** (see design item below): extend the catalog scanner to enumerate routed push helpers (partially done for `_pushTo`), or add a runtime push-enumeration path. Today `pushSites` is a lower bound (969 → 630) because routing hides pushes from the static `postMessage` scanner.

### ⚙️ OUT OF SCOPE
- The standalone composition root / keyring / config-file / Memento→config / single-instance guard — that is **B1** (`standalone-headless-core-service-bootstrap.md`). This plan makes the verbs *extraction-ready*; B1 wires the headless host that consumes them.
- `node-pty` terminal backend + xterm browser grid → **B3**. npx packaging → **B4**. Transport shim / browser board → **B2**.
- Any new verb or behavior change. This is a **byte-compatible refactor** — reply timing, error shapes, and ack semantics must match the current webview path exactly (4,000 installs).

## Implementation Steps
1. **Classify each panel's verbs into two tiers** (a static-analysis pass): **pure-logic** (zero `vscode.*` in the arm body — mechanically movable) vs **vscode-coupled** (needs seam routing). The pure-logic tier can be auto-migrated by a script; the coupled tier is hand-work.
2. **Per verb (the proven recipe):** move arm body → service method → route `vscode.*` through the seam → keep the arm as `case '<verb>': return svc.<verb>(payload)` (**extract before repoint**) → parity-test byte-compat → add/confirm the `handleServiceVerb` case.
3. **Panel order (smallest/least-coupled first to prove the batch machinery):** Design (62) → Setup (115) → Kanban remaining (134) → TaskViewer (110) → Planning (172).
4. **Orchestration:** partition **one agent stream per provider file** (they are the shared-edit hot spots — parallel edits to the same provider collide). Batch ~20–30 verbs per run, `compile-tests` gate between batches, merge incrementally. Expect a dozen-plus agent runs across several passes; large token spend; multi-session.
5. **Seam growth** as encountered (protocol above). Add `HostSecrets`.
6. **Parity ratchet:** per-panel, flip to fail-on-shim once clean.
7. **Push discovery fix** (design item): scanner enumerates routed pushes and/or a runtime endpoint; document `pushSites` as lower-bound until then.

## Complexity Audit
### Routine
- Pure-logic verb moves — mechanical; the recipe repeats.
- Adding `handleServiceVerb` cases / route arms — already-patterned.
### Complex / Risky
- **Volume:** ~20–30k LOC across 5 providers. The long pole; cannot be one session.
- **Per-verb seam routing:** terminal/worktree, ClickUp/Linear sync, editor/window, and configuration verbs each need their vscode surface individually routed through a seam — not copy-paste.
- **Recursion hazard:** repoint-before-extract on a shimmed verb = infinite loop. Enforce extract-first; a lint/parity check that flags "repointed arm whose service method is a shim" would catch regressions.
- **Byte-compatibility for 4,000 installs:** reply timing, error shapes, ack semantics must not drift. Provider tests must pass unchanged per panel.
- **Parallel edit collisions:** partition by provider file; never two agents in one provider.
- **Catalog push-discovery degradation:** routing pushes through helpers (Gap A) hides them from the static `postMessage` scanner (969 → 630). Genuine extraction will move more pushes behind helpers, worsening this — the scanner must learn the helper forms, or push discovery must go runtime-based.

## Edge cases & risks
- **Idempotency of the burn-down:** each verb conversion is independent and byte-compatible; a half-done panel still works (extracted verbs run host-agnostic, un-extracted stay shims — both reachable). No big-bang.
- **Test seams:** each service method must run under a test seam bundle (no `require('vscode')`), proving genuine decoupling — this is the actual acceptance signal, stronger than "compiles."
- **Do NOT let any verb assume readable terminal output** — that arrives only with B3's node-pty backend; the current `TerminalBackend` vscode adapter is write/lifecycle only.

## Dependencies
- **A2a seams** (present: `HostPathConfigProvider`, `TerminalBackend`, `HostCommands`, `HostUI`, `HostEditor`; **`HostSecrets` still missing** — add on first use).
- **A1 catalog** (present — the per-verb checklist).
- **The proven recipe + generic verb rail** (present — all 5 panels routed).
- **Unblocks B1** (headless standalone) — that feature cannot run verbs headlessly until the shims are gone.

## Verification Plan
### Automated
- `compile-tests` green per batch. Parity gate genuinely-extracted count rises monotonically toward **605 / 605** (0 shims). Push-routing ratchet stays green.
### Manual / behavioral
- Per panel, provider tests pass unchanged after burn-down (run per-panel, not batched).
- **Headless smoke:** a sample of migrated verbs execute under a test seam bundle with NO `vscode` import reachable — the real proof of host-agnosticism (compiling is necessary, not sufficient).
- A `POST /<panel>/verb/<name>` call and the equivalent webview `postMessage` produce byte-identical replies/acks/error shapes.

## Effort note
Multi-session, orchestration-driven. Not achievable in a single conversational pass (tool/context limits); it is achievable as batched parallel agent runs with compile gates. Estimate: a dozen-plus agent runs across several passes. Large token spend — schedule accordingly.
