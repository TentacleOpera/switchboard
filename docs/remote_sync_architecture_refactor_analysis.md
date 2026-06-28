# Remote / Sync Architecture: Fault Lines and Refactor Analysis

> **Status:** Discovery + direction. Not an implementation plan.
> **Author:** Switchboard Operator (consultation mode)
> **Date:** 2026-06-28
> **Scope:** The relationship between the Remote tab, the Automation tab, and the push/pull sync subsystems — and why the "lightweight remote modes" UX question cannot be answered with a small plan.

---

## Goal

### The triggering question

The Remote tab currently implies a heavy mental model: to use remote control you turn on active polling *and* let the agent write back. But there are lighter modes that the user wants surfaced — most importantly an **ingest-biased** mode where the remote is just a plan source and local Automation does the reacting. The user proposed a clean model:

- **Two modes:** *Ingest only* and *Full*.
- **Two independent addons:** *push sync* (always on for Full, optional for Ingest) and *comment polling* (optional for both).

The original ask was narrow — "does anything need to be *surfaced* (a UI note), or does behavior need to *change*?" Investigating the code to answer that revealed the real problem: **the question can't be answered cleanly because the push and pull halves of the system are structurally misaligned.** The clean 2×2 the user drew does not map onto the code, because *push is not a property of the remote system at all* — it lives in a different subsystem, with a different provider set, a different config home, and a different trigger.

### Root cause (the history, as the code records it)

1. A **legacy sync system** pushed local plan changes out to an issue tracker (Linear, later ClickUp). This was a *push-from-local* design.
2. **Remote control** (drive the board *from* the tracker) was **bolted on** as a separate *pull* system — `RemoteControlService` + the provider-agnostic `RemoteProvider` interface (Linear + Notion).
3. The legacy automation was later **split into bug-triage vs. remote-control** modes (`LinearAutomationService` vs. `RemoteControlService`), sharing one `LinearSyncService` config (see memory: *remote-control-vs-triage-two-modes*).
4. **But the push half was never split or folded into the provider abstraction.** It stayed cross-system: triggered from local column moves and the file watcher, gated by a *different* flag (`realTimeSyncEnabled`) set in *Setup*, and wired only to Linear + ClickUp.

The result is two subsystems that were never reconciled, plus a provider set that doesn't line up across them.

---

## Current architecture (verified against source)

There are **three** sync behaviors, living in **two** subsystems with **two** provider abstractions (one of them not really an abstraction at all).

### A. Pull / ingest — `RemoteControlService` (the Remote tab)

Provider-agnostic via the `RemoteProvider` interface (`src/services/remote/RemoteProvider.ts:40`). Implementations for **Linear** (`LinearRemoteProvider.ts`) and **Notion** (`NotionRemoteProvider.ts`).

`RemoteControlService._poll()` (`src/services/RemoteControlService.ts:192`) runs three independently-gateable behaviors:

| Behavior | Method | What it does |
|---|---|---|
| **State import** | `_pollState` → `provider.importRemotePlan` (`:266`) | Remote item with no local plan → import as a new local markdown plan. |
| **State mirror** | `_applyStateMirror` (`:288`) | Remote status change → move local column **+ dispatch that column's agent** + post a dispatch-ack comment back. |
| **Comment polling** | `_pollComments` (`:316`) | Remote comment → route to the current column's agent. |

Configured by the **Remote tab** (`kanban.html:2547`), persisted to DB config key `remote.config`: `{ provider, boards, silentSync, pingMode, pingFrequencySeconds }`.

The only **write-back** this subsystem performs is `provider.postComment` — the dispatch acknowledgement. **It never pushes plan content or status back.**

### B. Status push — local column move → remote state

Triggered when a card moves locally: `KanbanProvider._queueLinearSync` (`:1924`) and `_queueClickUpSync` (`:1892`). Both are gated by `config.realTimeSyncEnabled === true` — a flag set in **Setup**, *not* the Remote tab. They call `debouncedSync` → `syncPlan` (`LinearSyncService.ts:1902`, `ClickUpSyncService.ts:2525`), which maps the column to a tracker state (`columnToStateId`) and PATCHes the remote.

- Extra gate: `completeSyncEnabled` suppresses pushing terminal columns (DONE/COMPLETED/ARCHIVED) — `LinearSyncService.ts:1916`.
- **Providers: Linear + ClickUp only. No Notion.**

### C. Content push — local plan body → remote description

`ContinuousSyncService` watches plan files (via `GlobalPlanWatcherService`) and pushes the markdown body to the remote's description field: `_syncToLinear` / `_syncToClickUp` → `syncPlanContent` (`ContinuousSyncService.ts:874`, `:847`; `LinearSyncService.ts:1953`).

- "Realtime sync is configured in Setup" — the note at `kanban.html:3085` refers to exactly this.
- **Providers: Linear + ClickUp only. No Notion.**

### The Notion gap (confirmed)

Notion is a **pull-only** remote. The capability to write a page body exists — `NotionFetchService.updatePageContent` (`:631`) — but its **only caller is `ResearchImportService.ts:240`**, a one-off import path. It is **not wired into either push pipeline (B or C).** The only thing Notion remote control ever writes back is `postComment` (dispatch acks). So in the user's own code-automation flow (steps 6–7: "Switchboard uses the Notion API to change status to Coded / update the description"), **the status- and content-push steps do not exist for Notion today.**

---

## The heart of the mess: provider matrices don't line up

| Capability | Linear | Notion | ClickUp |
|---|:---:|:---:|:---:|
| Pull: state import / mirror / comments (Remote tab) | ✅ | ✅ | ❌ |
| Push: status (column → state) | ✅ | ❌ | ✅ |
| Push: content (body → description) | ✅ | ❌ | ✅ |
| **Full bidirectional** | ✅ | ❌ | ❌ |

Three different provider sets for what the user (reasonably) thinks of as one feature:

- **Pull providers:** Linear, Notion
- **Push providers:** Linear, ClickUp
- **Bidirectional:** Linear *only*

So:

- **Notion** can *drive* the board but can never be *updated by* it (beyond comments). The code-automation loop the user described silently half-works.
- **ClickUp** can be *updated by* the board but can't *drive* it — it isn't a `RemoteProvider` at all.
- **Linear** is the only provider where the user's 2×2 even makes sense.

This is why "add a push toggle to the Remote tab" is a trap: push isn't a Remote-tab concept, it has a different provider set, and for the marquee Notion case the thing the toggle would gate **doesn't exist**.

### Raggedness is legitimate — only Notion is a real gap

Crucially, **the asymmetry above is not all defect.** Two of the three "missing" cells reflect intended product roles, not bugs:

- **ClickUp push-only is correct by design.** ClickUp is a PM/stakeholder surface: its value is letting non-devs *see* dev progress (status + plan content flowing *out* to a board they watch). Devs using Switchboard don't sit in ClickUp dragging cards to drive their own work. ClickUp was never meant to be a remote-control (pull) surface, and **should not be promoted to one** just to square the table.
- **Notion push *is* a real gap.** Notion is explicitly an *agent* control surface (claude.ai + the Notion MCP connector): the agent is meant to drive status and write results back. Its loop is genuinely bidirectional by intent, and the push half is simply missing.

So the goal is **not** "make every provider bidirectional." Symmetry isn't the objective — matching each provider to how it's actually used is. The real defect is that **a provider's capabilities are implicit and scattered across subsystems** instead of being *declared*. The intended capability matrix is deliberately ragged:

```
Linear:  { pull: true,  push: true  }   // bidirectional
Notion:  { pull: true,  push: true  }   // push half NOT YET BUILT — the one real gap
ClickUp: { pull: false, push: true  }   // push-only, by design — leave as-is
```

Once capabilities are declared on the provider, the UI can honestly gray out "Full mode" for a push-only or pull-only provider instead of silently lying. ClickUp simply never appears as a Remote-tab *control* provider; it lives purely as a push target, where it already is. **The only push work the refactor must add is Notion's.**

---

## Config fragmentation

At least **four** separate surfaces currently touch sync, with no single source of truth for "what is this board doing with its remote?":

| Surface | Where | Controls |
|---|---|---|
| `remote.config` | Remote tab | provider, boards, silentSync, pingMode, ping frequency (pull) |
| `realTimeSyncEnabled` | Setup (per Linear/ClickUp service config) | whether push B + C run at all |
| `completeSyncEnabled` | Setup / Linear config | whether terminal-column status push runs |
| Auto-Pull modal | `integration-settings-modal` (`kanban.html:3077`) | a *separate* background pull + interval, distinct from the Remote tab's ping loop |

A user reasoning about "is my board syncing, and which way?" has to consult four places, two of which (`realTimeSyncEnabled`, Auto-Pull) aren't on the Remote tab.

---

## Why the simple plan fails

The user's clean model —

```
mode:    Ingest | Full
addons:  push sync (forced-on for Full, optional for Ingest)
         comment polling (optional for both)
```

— is the *right user-facing model*. But underneath:

- **`mode`** maps cleanly to one gate in `RemoteControlService` (skip `_applyStateMirror` in Ingest). ✅ One service, easy.
- **`comment polling`** maps cleanly to one gate (skip `_pollComments`). ✅ One service, easy.
- **`push sync`** does **not** map to the Remote tab subsystem at all. It's a different service (B + C), a different provider set (no Notion!), a different config flag (`realTimeSyncEnabled`), and a different trigger (column move / file watcher, not the poll loop).

So wiring `push sync` as a Remote-tab toggle means either (a) the toggle silently does nothing for Notion, or (b) we first build the missing Notion push pipeline and then unify three config surfaces behind one control. That's a refactor, not a checkbox.

---

## Candidate direction (to be planned, not yet decided)

The unifying idea: **make push a first-class, provider-symmetric capability behind the same `RemoteProvider` abstraction that already governs pull.** Then the user's 2×2 becomes literally true in the code.

1. **Declare capabilities on each provider** (e.g. `capabilities: { pull, push }`) and **extend `RemoteProvider`** with push methods, e.g. `pushState(remoteId, column)` and `pushContent(remoteId, markdown)`. Linear and ClickUp move their existing `syncPlan` / `syncPlanContent` behind it; **Notion implements them for the first time** (the `updatePageContent` capability already exists and just needs wiring, plus a status-property write).
   - ClickUp stays **push-only by design** (`pull: false`) — it is a stakeholder-visibility surface, not a control surface, so it never becomes a Remote-tab control provider. No new pull work for ClickUp.
   - The declared matrix lets the UI honestly disable modes a provider can't support, rather than shipping toggles that silently no-op.
2. **One config object per board** describing the full sync contract: `{ provider, mode: ingest|full, push: on|off, comments: on|off, cadence }`. Migrate `remote.config`, `realTimeSyncEnabled`, `completeSyncEnabled`, and the Auto-Pull modal into (or behind) it.
3. **Remote tab becomes the single control surface** for pull *and* push, since both are now provider methods. Setup keeps credentials/board mapping; behavior lives on the tab.
4. **Reconcile the two pull loops** — the Remote tab's ping loop and the Auto-Pull modal's background pull appear to overlap and should likely become one.

This closes the Notion push gap, collapses four config surfaces toward one, and makes "ingest + push" and "full − comments" expressible without contradictions.

---

## Open questions / decisions needed

1. **ClickUp's role.** ~~Promote to a full bidirectional `RemoteProvider`, or formally accept it as push-only?~~ **Resolved:** ClickUp stays **push-only by design** — it is a PM/stakeholder visibility surface, not a control surface devs drive their board from. The matrix is *intentionally* ragged; the fix is to **declare** each provider's capabilities, not to force symmetry. This removes ClickUp pull from refactor scope entirely.
2. **Notion status push.** The code-automation loop needs Notion to write a status property (step 6) and description (step 7). Confirm the Notion remote setup actually has a writable status property to target, and define the column→status mapping (the Linear equivalent is `columnToStateId`).
3. **Two pull loops.** Are the Remote-tab ping loop and the Auto-Pull modal genuinely redundant, or do they serve different boards/purposes? If redundant, one must absorb the other (with migration).
4. **Echo-loop safety under push.** Today's loop-closing guards (`RemoteControlService.ts:18–29`) assume push is comments-only. Once push writes *state and content*, the guards (column-equality echo guard, `authoredBySelf`, seen-set) must be re-proven against the new round trip (push state → bumped remote timestamp → inbound delta). This is the highest-risk part.
5. **Migration (≈4,000 installs).** `remote.config`, `realTimeSyncEnabled`, and `completeSyncEnabled` all ship today. Any consolidation must import-before-delete and preserve existing behavior for users who set these in older versions (see CLAUDE.md migration rules).
6. **Scope split.** This is plausibly 3+ separable plans: (a) Notion push pipeline (the one real provider gap); (b) declared-capabilities + `RemoteProvider` push abstraction (Linear/ClickUp move existing push behind it, no new ClickUp pull); (c) config consolidation + Remote-tab UX (the original ingest/full ask). The original UX ask is the *last* step, not the first — it depends on (a) and (b) existing.

---

## Immediate vs. eventual

- **Eventual:** the refactor above.
- **Immediate option (if a stopgap is wanted before the refactor):** the original "surface, don't wire" answer still holds as a temporary measure — add the ingest/full + comment toggles to the Remote tab (both are clean, single-service gates) and *display push state read-only* with an honest caveat that Notion push is not yet implemented. This avoids shipping a push toggle that lies for Notion users, while delivering the lightweight ingest mode now.

This decision — stopgap-then-refactor vs. refactor-first — is the next thing to settle.
