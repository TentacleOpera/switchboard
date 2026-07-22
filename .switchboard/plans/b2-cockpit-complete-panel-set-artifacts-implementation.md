---
description: "Scope the browser cockpit surface to what is actually viable once secrets are editor-only and terminal dispatch is unavailable — do NOT mirror the editor 1:1. Replace the current COARSE tab-level hiding (whole agents/automation/worktrees tabs) with a PER-CONTROL capability matrix: a control is hidden only if it needs a terminal or a secret; git/data/config controls (worktree lifecycle, cron/batch scheduling, board/plan management) stay. Drop the redundant Design panel; strip the secret-dependent docs+tickets tabs from Artifacts."
---

# B2 · Browser Cockpit — Surface Scope (Per-Control Capability Matrix, Not Panel Mirroring)

## Metadata
- **Project:** browser-switchboard
- **Tags:** ui, ux, architecture, security
- **Complexity:** 6
- **Release phase:** B2 (browser cockpit). Surface-definition plan.
- **Dependencies:** `b2-cockpit-secrets-editor-only` (defines the `secretsEntry` axis this consumes). Soft: `b2-cockpit-real-icons-and-claudify-theming`, `b2-cockpit-live-data-delivery-empty-board`.

## Goal

Define exactly which panels, tabs, and controls the browser cockpit exposes — scoped to what works without a terminal and without touching secrets — and make the gating **per-control**, so working functionality is never hidden just because it shares a tab with a terminal feature.

> **Superseded direction:** the earlier framing of this plan was "complete the panel set — mirror every editor `createWebviewPanel` in the browser."
> **Reason:** once secrets are editor-only (`b2-cockpit-secrets-editor-only`) and terminal dispatch is unavailable headless, a 1:1 mirror exposes dead/pointless surfaces. Conversely, the current coarse gating *over*-hides: it nukes whole tabs (worktrees, automation) that contain git/scheduling controls which work fine headless.
> **Replaced with:** a capability-scoped surface — drop what's genuinely redundant, keep every control that needs neither a terminal nor a secret, gate only the ones that do.

### Problem / root-cause analysis

The browser surface is defined by two things today, both wrong at the edges:
1. **The manifest** (`getPanelsManifest`, `headlessPanelHtml.ts:238-240`) exposes board/project/design/setup and misses the Planning/**Artifacts** panel (`planning.html`, `PlanningPanelProvider._panel:737`) and Implementation (`implementation.html`).
2. **The gating** (`transport.js:applyCapabilityGating`) hides, under a single `terminalDispatch:false`, the **entire** agents/automation/worktrees tabs and their content (`transport.js:238-243`).

Both the manifest and the gating are the wrong granularity. Verified facts that drive the correct scope:
- **Worktree lifecycle is git, not terminal.** `createWorktree`/`createWorktreeForFeature`/merge-back are `execFileAsync('git', ['worktree', ...])` calls (`KanbanProvider.ts:10066,10405`). They run headless. Only *dispatching an agent into* a worktree needs a terminal. → Worktree management must stay; hiding the whole tab is a bug.
- **Cron/batch automation is scheduling config + logic in `KanbanProvider`.** In the concurrent-with-editor model the extension runs it live, so the browser can drive it. Defining schedules/batches is data. → The cron/batch controls stay; only the parts that *dispatch* need a terminal.
- **Design panel is redundant in the browser** (user decision) — its core flow (build-via-planner = terminal; publish-artifact prompts tied to editor/claude context) doesn't earn a browser slot.
- **Artifacts (`planning.html`) online docs + tickets tabs are secret-dependent** (ClickUp/Linear/Notion) → gated out by the secrets-editor-only rule; the panel keeps its local artifact/planning content.

## User Review Required — RESOLVED
- **agents tab → Show.** Definitions are plain config (always editable); with the host-conditional terminal capability, dispatch works in the extension-hosted browser. Gated only in terminal-less standalone.
- **Implementation panel → Omit** (like Design): its launcher role is the App-Shell's, onboarding is host-authority (`A`), the terminals tab is terminal-bound — nothing browser-viable remains.
- **Terminal-controls UX → confirmed.** In the extension host, dispatch fires via the extension: terminal *output* appears in the VS Code window, the browser board updates live (B3/node-pty later streams a terminal into the browser for standalone).

## Complexity Audit
### Routine
- Manifest entries; per-tab / per-control CSS gating.
- Parameterizing `HOST_CAPABILITIES` (currently a hardcoded constant) to accept per-host values.
### Complex / Risky
- Rewriting gating from tab-level to control-level without orphaning a live verb or hiding a working git/data control (the exact bug this fixes).
- Distinguishing capability-gated (host-reported: `T`/`automation`/`orchestrator`) from policy-gated (browser-off regardless: `S`/`A`/`R`).
- Two Planning surfaces (project vs planning) share one provider — disambiguate via `isProject`.

## Dependencies
- Consumes the `secretsEntry` axis from **Secrets** (land Secrets first or alongside). **Owner of:** `transport.js:applyCapabilityGating` (control-level refactor), the `headlessPanelHtml` manifest + capability matrix, AND the parameterization of `HOST_CAPABILITIES`. Shares `shell.html` nav with **Real Icons + Theming** (that plan owns icon rendering + the header theme switcher; this plan owns which nav entries exist). Shares `setup.html` with **Secrets** (Secrets hides key entry; this plan reduces the tab set). **Serve-from-extension** and the standalone bootstrap PASS their real capability values into the getter this plan parameterizes.

## Adversarial Synthesis
**Risk Summary:** Key risks: (1) `HOST_CAPABILITIES` is currently a hardcoded `{terminalDispatch:false,…}` constant shared by BOTH hosts, so the extension-hosted browser wrongly hides terminal controls it CAN run via the extension's `VscodeTerminalBackend` — parameterize per host (corrected above); (2) two `Verify` rows (agents tab, control-plane migrate) must be resolved by reading handlers before ship; (3) hide-button-keep-verb must not orphan a verb the bootstrap still wires. Mitigations: capability axes gate on the host's reported value, policy axes are browser-off regardless; the capability matrix is the contract — every Hide cites T/S/A/R; runtime-verify the `Verify` rows.

## Proposed Changes

### 1. Per-control capability model (replaces coarse tab hiding)
- **Parameterize `HOST_CAPABILITIES`** (`headlessPanelHtml.ts:29`, today a hardcoded shared constant) so each host emits its own flags onto `body.dataset.hostCapabilities` — `terminalDispatch`, `automation`, `orchestrator` (capabilities, host-reported), plus `secretsEntry` (policy, from the Secrets plan). Consumed by `transport.js:applyCapabilityGating`. The extension serving path passes `terminalDispatch:true` (+ automation/orchestrator true); the standalone bootstrap passes `false` until B3.
- **Rewrite the gating from tab-level to control-level.** A control is hidden iff it *requires* a capability the host lacks. Concretely:
  - **Keep (git/data/config — no capability needed):** worktree create/list/remove/merge; cron/batch **schedule definition**; board/plan CRUD; project/plan editing. **Copy Prompt Selected / Copy Prompt All** (`kanban.html:5337,5340`, `data-action="promptSelected|promptAll"`) — they return the dispatch prompt in the HTTP body for client-side clipboard copy, no terminal. Copy-Prompt is the ONLY advance affordance in the browser.
  - **Gate on `terminalDispatch:false`:** live agent dispatch (autoban start, manager-pass, CLI-triggers, orchestrator **start**, "dispatch agent into worktree", build-via-planner, memo "Send to Planner", julesSelected) **AND the column-header Advance controls: Advance Selected / Advance All** (`kanban.html:5331,5334`, `data-action="moveSelected|moveAll"`). **Drag-and-drop is locked to copy-prompt** in the browser — force `dragDropMode` (`kanban.html:5228,10793`) to the copy-prompt mode so a dropped card copies its prompt instead of firing a (dead) dispatch.
  - **Gate on `secretsEntry:false`:** API-key entry rows; secret-write affordances.

> **Superseded:** `transport.js:262-266`'s note deliberately keeps `moveSelected`/`moveAll` visible in a headless host, reasoning they "degrade to plain column-advances (no CLI trigger fires) — that is board management" and that hiding them would "orphan a live backend path."
> **Reason:** an Advance whose entire purpose is to dispatch an agent is useless without a terminal — a silent column-move with no dispatch confuses more than it helps, and it is inconsistent with drag-drop already being locked to copy-prompt. Hiding the UI control does NOT remove the `moveSelected`/`moveAll` verbs (they remain for API/programmatic callers), so no backend path is orphaned — only a dead-end button is removed.
> **Replaced with:** hide Advance Selected / Advance All **only when `terminalDispatch:false`** (terminal-less standalone) — in the extension host `terminalDispatch:true`, so they stay Shown and dispatch via the extension (terminal output in the VS Code window, board updates in the browser). Where hidden, Copy Prompt Selected / All are the only column-header advance affordances and drag-drop locks to copy-prompt.
- Do NOT hide a tab wholesale — hide the individual controls inside it, and hide the tab button only if **every** control in it is gated. (Worktrees and Automation will therefore remain visible with a reduced control set.)

### 2. Manifest — capability-scoped panel set
- `headlessPanelHtml.ts:getPanelsManifest`: browser host →
  - **Board** (keep, reduced), **Project** (keep, reduced), **Artifacts/planning** (ADD, docs+tickets tabs gated).
  - **Setup** → **keep, but reduced to its browser-relevant content: the plan-scanner (primary) + prompt-overrides/export-import.** The plan-scanner is a first-class browser workflow — configuring source dirs to ingest plans and manage them on the board without the editor is a core reason the browser exists, so it must NOT be dropped. Everything else in Setup is editor-only (secrets `S`; DB/control-plane/mappings `A`; status-bar `R`; remote `T+S`).
  - **Theme** → **removed from the Setup panel and lifted to the App-Shell header** as a toggle (see `b2-cockpit-real-icons-and-claudify-theming`) — theme is cockpit chrome, not a workspace setting.
  - **Design** → **omit** for the browser host (redundant). Keep the plumbing for the editor host only.
  - **Implementation** (`implementation.html`) → **omitted (decided)** — launcher role is the App-Shell's, onboarding is host-authority (`A`, editor-only), the terminals tab is terminal-bound; nothing browser-viable remains.
- Add `/planning` route + `getPanelHtmlById('planning')`; wire the (already-headless) Planning verbs.

### 3. Artifacts panel tab gating
- In `planning.html`, gate the **online docs** and **tickets** tabs behind `secretsEntry` (they drive ClickUp/Linear/Notion) — same mechanism as the terminal gating, new axis. Keep local artifact/upload-prompt content that returns prompts in the HTTP body (client-side copy, no secret).

### 4. Capability matrix (the deliverable that prevents future drift)
- Produce a matrix: **panel × tab × control → {requires-terminal?, requires-secret?, visible-in-browser?}**, checked in beside `getPanelsManifest`. Every "hidden" decision must cite terminal or secret; anything citing neither is a bug (it should be visible). This replaces "mirror the editor" as the parity contract.

## Capability Matrix (pre-populated)

Legend — **Requires:** `T`=terminal/agent-dispatch, `S`=secret/integration-key, `A`=host-authority (mutates the workspace/DB/control-plane **substrate** the editor is actively bound to — editor-only), `R`=host-relevance (configures editor-only UI, e.g. the VS Code status bar — meaningless in a browser), `—`=none. **Browser:** Show / Hide / **Verify** (implementer must read the handler to confirm before shipping). Rule: Hide iff Requires ∈ {T, S, A, R}. Every control not named below requires none and is **Show** by default (git/FS/DB-content/config/copy-prompt/board-management). **Substrate vs content:** `A` is only for controls that change *where/how the workspace itself is wired* (DB path, control-plane root, workspace→DB routing); editing board cards / plans / features / projects is **content**, shared with the editor by design, and stays **Show**.

**Capability axes are host-reported, NOT a browser blanket (load-bearing correction).** `T` (and `automation` / `orchestrator`) are **capabilities** — "can the host physically do this?" — resolved per host at serve time: the **extension host reports them `true`** (it holds a real `VscodeTerminalBackend`, so a browser-triggered dispatch executes in the extension; terminal output shows in the VS Code window, the board updates in the browser), and the **standalone host reports `false` until B3 (`node-pty`)**. So a `T` row means "Hidden **only when the host reports `terminalDispatch:false`**" — in the concurrent-with-editor model these controls are **Shown and functional**. `S` (`secretsEntry`), `A`, and `R` are **policy/relevance** — off in the browser regardless of host capability (secrets stay editor-only even though the extension physically could set them).

> **Superseded:** `HOST_CAPABILITIES` = a single hardcoded `{ terminalDispatch:false, automation:false, orchestrator:false, … }` constant (`headlessPanelHtml.ts:29`) shared by both hosts, and the earlier assumption that "the browser cannot run terminals."
> **Reason:** the constant makes the **extension-hosted** browser hide terminal controls it can actually run via the extension's `VscodeTerminalBackend` — under-reporting the host's true capability. "Browser = no terminal" is only true for the terminal-less standalone host.
> **Replaced with:** parameterize `HOST_CAPABILITIES` per host (mirror `getPanelsManifest`'s availability arg). The extension serving path passes `{ terminalDispatch:true, automation:true, orchestrator:true }`; the standalone bootstrap passes `false` (until B3). The capability-gated (`T`/`automation`/`orchestrator`) rows below are therefore Shown in the extension host and Hidden only in terminal-less standalone.

### Board (`kanban.html`)
| Tab | Control | Requires | Browser |
|---|---|---|---|
| kanban | `promptSelected`, `promptAll` (`5337,5340`) | — | Show |
| kanban | `moveSelected`, `moveAll` = Advance Selected/All (`5331,5334`) | T | Hide |
| kanban | `rePlanSelected` (re-dispatch a planner) | T | Hide |
| kanban | `julesSelected` (Jules dispatch) | T | Hide |
| kanban | `completeSelected`, `completeAll`, `testingFailed`, `archive-selected`, `recover-selected`, `addBlankFeature`, `saveRoutingMap` | — | Show |
| kanban | `btn-autoban`, `btn-pause-autoban-timer`, `btn-reset-autoban-timer`, `btn-manager-pass`, `btn-cli-triggers`, `btn-remote-control` | T | Hide |
| kanban | `btn-create-worktree` (git worktree add) | — | Show |
| kanban | `btn-add-plan`, `btn-import-clipboard`, `btn-chat-copy-prompt`, `btn-refresh-uat` | — | Show |
| agents | custom-agent definitions + startup commands (config only; no in-tab dispatch) | — | Show (see note) |
| automation | autoban start, orchestrator **start**, live-dispatch controls | T | Hide |
| automation | cron/batch **schedule definition** + recurrence config | — | Show |
| prompts | prompt-override / workflow-path editing | — | Show |
| worktrees | create / list / remove / merge-back (git) | — | Show |
| worktrees | "dispatch agent into worktree" | T | Hide |
| uat | `btn-refresh-uat` + UAT review | — | Show |
| setup (sub-tab) | quick-setup config | — | Show |

*Note (agents tab):* agent **definition** requires neither T nor S, so by rule it is Show — but its only payoff (dispatching that agent) is terminal-gated. Flagged **Verify** for a product call: keep as read/config, or hide the tab as low-value in a no-terminal host. Default per the rule: Show.

### Project (`project.html`)
| Tab | Control | Requires | Browser |
|---|---|---|---|
| constitution | `btn-build-via-planner`, `btn-update-via-planner`, `btn-review-constitution` (agent) | T | Hide |
| constitution | `btn-copy-architect-constitution`, `btn-copy-build-prompt`, `btn-copy-update-prompt` | — | Show |
| constitution | save / edit / enable / disable / delete / manage-paths / add-path | — | Show |
| system | `btn-build-system`, `btn-review-system` (agent) | T | Hide |
| system | `btn-copy-system-prompt`, `btn-copy-architect-system`; save / edit / delete | — | Show |
| (header) | `btn-build-prd-via-planner` | T | Hide |
| (header) | `btn-copy-prd-prompt`, `btn-refresh-insights`, `btn-create-kanban-plan`, `btn-import-kanban-plans`, `btn-plan-auto-fetch-now` | — | Show |
| features | feature CRUD / grouping | — | Show |
| projects | project CRUD | — | Show |
| kanban | board view | — | Show |
| memo | `memo-send` = Send to Planner | T | Hide |
| memo | capture / append / edit / copy-prompt | — | Show |
| tuning | tuning settings | — | Show |

### Artifacts (`planning.html`)
| Tab | Control | Requires | Browser |
|---|---|---|---|
| docs (online docs) | `btn-sync-to-online`, `btn-create-doc`, `btn-sync-confirm-*`, doc-sync wizard | S | Hide (whole tab) |
| tickets | `btn-submit-create-ticket`, `btn-apply-move-ticket`, `btn-comments-refresh`, `tickets-agent-api` | S | Hide (whole tab) |
| create-plans | `btn-import-full-doc`, `btn-new-doc-create`, `btn-copy-research-prompt` (package-docs→prompt→paste-back) | — | Show |
| create-plans | `btn-new-doc-create-agent`, `btn-agent-doc` (agent dispatch variants) | T | Hide |
| html | `btn-copy-artifact-prompt`, `btn-diagram-prompt` (copy upload prompt) | — | Show |
| research | `btn-copy-research-prompt`, `btn-import-research-doc-clipboard` | — | Show |
| (viewer) | `fit` / `pan` / `reset` / `zoom-in` / `zoom-out` | — | Show |

### Setup (`setup.html`)
| Tab | Control | Requires | Browser |
|---|---|---|---|
| clickup / linear / notion | token inputs (`clickup-token-input` `824`, `linear-token-input` `1030`, `notion-token-input` `1234`) | S | Hide |
| clickup / linear | apply-config, save-mappings, save-automation, add-rule, enable-triage, create-unmapped | S | Hide |
| plan-scanner | scanner source dirs — **primary browser workflow; ingest plans without the editor** | — | Show |
| (header) | export / import prompts, prompt-overrides, `btn-copy-tutorial-prompt`, `btn-copy-linear-agent-skill`, `btn-agent-dir-cleanup`, browse-folders | — | Show |
| theme | theme selection | — | Moved to App-Shell header (not a Setup tab) |
| database | DB path, `initDb`, `browseDbPath` — **repoints the live session's DB substrate** | A | Hide |
| control-plane | detect / preview / execute / set-root / migrate — **rewires the shared `.switchboard`/`.agents` substrate** | A | Hide |
| mappings | workspace→DB routing — substrate topology | A | Hide |
| status-bar | configures the **VS Code status bar** (`#status-bar-fields`) — no such thing in a browser | R | Hide |
| remote | `btn-remote-control-toggle`, `btn-notion-remote-setup` | T + S | Hide |
| (header) | `multi-repo-pat` input (`1713`) | S | Hide |

### Not in the browser
- **Design** (`design.html`) — panel dropped (redundant); not classified.
- **Implementation** (`implementation.html`) — pending the include/omit decision; if included, run the same sweep before shipping.

## Edge-Case & Dependency Audit
- **Standalone vs concurrent:** cron/batch and worktree backends run live under the extension (concurrent model). In pure `npx` they must be wired in bootstrap or the controls degrade to "unavailable" honestly (greyed with a reason), never a dead button. Flag any not-yet-wired standalone backend rather than silently showing a control that 500s.
- **Don't orphan a live backend:** never hide a control whose verb the server still serves and which needs no terminal/secret (that's the current worktrees/automation bug). Conversely, never show a control whose backend isn't reachable.
- **Two Planning surfaces:** `project.html` vs `planning.html` share the provider — disambiguate via `isProject` so gated tabs are gated on the right surface.

## Verification Plan
### Manual (the real DoD)
- Browser nav has **no Design**; has **Artifacts** with **no docs/tickets tabs**; **Setup** with **no key fields**.
- **Worktrees** tab is present and can create/list/clean worktrees in the browser; only "dispatch agent into worktree" is hidden.
- **Automation** tab is present; cron/batch schedules can be defined; only live-dispatch controls (autoban/orchestrator start) are hidden.
- **Board column headers** show only **Copy Prompt Selected / Copy Prompt All** — **no Advance Selected / Advance All** — and dragging a card copies its prompt (does not advance/dispatch).
- Every hidden control maps to a terminal or secret requirement in the matrix; nothing git/data-only is hidden.
### Automated
- Unit-test the gating: given `{terminalDispatch:false, secretsEntry:false}`, worktree-create + cron-schedule + `promptSelected`/`promptAll` controls are visible; agent-dispatch + `moveSelected`/`moveAll` + key-entry controls are hidden, and `dragDropMode` resolves to copy-prompt.
- Manifest test: Design absent for browser host; Artifacts present; matrix has no "hidden with no capability cited" entry.

## Completion Report
Scoped browser surface using per-control CSS capability gating in `transport.js` driven by `HostCapabilities`. Added `/planning` route and Artifacts panel to `getPanelsManifest()`, while omitting Design for browser cockpit and gating `secretsEntry` (hiding key entry and docs/tickets tabs) and `terminalDispatch` (hiding live dispatch and advance buttons while preserving git/worktrees and schedule definition). Files changed: `src/services/headlessPanelHtml.ts`, `src/services/LocalApiServer.ts`, `src/webview/transport.js`. No issues encountered.

