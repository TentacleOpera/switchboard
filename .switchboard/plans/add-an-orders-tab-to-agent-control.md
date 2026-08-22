# Add an Orders tab to Agent Control

## Goal

Give standing orders a visible surface in Agent Control — a read-first list of every installed order with its scope, target and body — so the instructions actually governing agent behaviour can be inspected, and contradictory or stale orders can be seen rather than inferred from behaviour.

**The tab lands in `src/webview/agent-control.html`, not in `kanban.html`.** An earlier revision of this plan targeted the board's `data-view="agent-control"` projection, which is interim scaffolding: `agent-control.html` is meant to exist as a real panel, and `extract-agent-control-into-its-own-panel-file.md` creates it. Adding Orders to the projection would mean adding it twice — once to `kanban.html` now and once to the new file on extraction — and then deleting one copy. This plan therefore **depends on the extraction** and adds a fourth tab to the new file.

### Problem Analysis

Standing orders are the most behaviour-determining state Switchboard holds, and they are the only such state with **no user-visible surface at all**. They are installed and removed programmatically — `applySeatPacingOrders`, `applyTeamQueueOrders`, `installReviewerCallbackOrder` / `removeReviewerCallbackOrder`, `installGlobalQueueDoneOrder` — and stored in DB config under `terminals.standingOrders` (`standingOrders.ts:17`). Where a UI reflects them at all, it reflects them *backwards*: the file-based queue's auto/manual toggle state "is derived from whether the standing order is installed" (`LocalApiServer.ts:4229-4232`), not from a setting the user set. So the orders are the source of truth for a control the user thinks they own, and they cannot read it.

**The cost of that invisibility is concrete and current.** Two installed orders contradict each other today, and no user could have seen it:

- `TEAM_QUEUE_DONE_ORDER_BODY` (`teamWiring.ts:322-325`), installed at **both** `team` and `team-head` scope by `applyTeamQueueOrders`, tells any seat: if all subtasks are in `LEAD CODED`, `POST /kanban/dispatch` with `targetColumn: CODE REVIEWED`. No roster check, no reviewer-seat condition.
- The head order (`teamWiring.ts:757-770`) says the opposite: check the roster for a seat with role `reviewer`; **"If your team has NO reviewer seat, do NOT move the card to CODE REVIEWED — that is not your role."**

The head holds both. The seat version is cheaper to satisfy — one board read versus a roster lookup — so it is the one more likely to be acted on, and acting on it hands a feature to an off-team reviewer that then edits the same files the team is still working. That failure is invisible at every layer: nothing logs it, no board state distinguishes it, and the orders themselves cannot be read.

The repo already records this class of failure as known: `.switchboard/plans/a-stale-standing-order-can-still-reach-a-live-agent.md`, cited in `teamWiring.ts:342-343` as the reason manual mode removes orders in the same mutation that would otherwise leave them live.

**And the read path already exists.** `GET /terminals/standing-orders` is served and consumed by `terminals.js:3899`. So this plan is a rendering surface over an endpoint that ships, not new plumbing.

### Root Cause

Orders were introduced as a *mechanism* — a way for code to attach durable instructions to terminals — and every consumer since has installed them programmatically for its own purpose. No single owner ever needed the whole set rendered, so no surface was built. The result is a store with five scopes, at least five installers, a client-side resolver mirror, and no reader.

## Metadata

**Complexity:** 4
**Tags:** ui, frontend, reliability, devops

## User Review Required

- **Read-only first, or read-write?** This plan proposes read + delete, and deliberately not authoring. Rationale in Adversarial Synthesis; the decision is yours because it sets how much of the tab exists in v1.
- Confirm Orders is the fourth tab of the new panel rather than a fifth board tab. It joins `agents`, `teams`, `prompts` — cross-cutting agent configuration — which is the same reason those three are being extracted.

## Complexity Audit

### Routine

- A tab button beside the existing four (`kanban.html:2939-2947`) and an `id="orders-tab-content"` pane matching the established `<name>-tab-content` convention (`:2951`–`:3864`).
- Fetching `GET /terminals/standing-orders` and rendering rows: scope, target/parent, team id, body, and the order's `id`.
- Grouping by scope so the five scopes (`'global' | 'team' | 'pair' | 'team-head' | 'role'`, `standingOrders.ts:3`) read as distinct sets rather than one flat list.

### Complex / Risky

- **If this ships before the extraction, it costs double and the negative-selector filter bites.** In `kanban.html` the Agent Control filter is `.shared-tab-btn:not([data-tab="agents"]):not([data-tab="teams"]):not([data-tab="prompts"])` (`:2913`), so a new tab is hidden by default in that view — a tab that exists, works and cannot be seen, indistinguishable from one never built. In the extracted file there is no projection and no filter, so the whole class of bug disappears. That is the strongest reason to wait for the extraction rather than land this first.
- **The new panel follows the companion-`.js` convention**, so the tab's code belongs in `agent-control.js` rather than an inline script — matching the seven panels that already do this, not the two inline-script exceptions.
- **The client mirrors the server resolver, and the marker string is the contract.** `terminals.js:10353-10354` states it explicitly — "Keep in sync with `src/services/standingOrders.ts` — the marker string is the contract" — and `:10667` mirrors `applyStandingOrders`. This tab must render what the *server* returns and must not add a third implementation of resolution. If the tab needs to show "which orders would reach terminal X", it calls the existing endpoint or a new server-side resolve; it does not re-derive selection client-side.
- **Deletion is destructive and the orders are load-bearing.** Removing the wrong row breaks a live pipeline — deleting a `queue/done` order leaves seats with no completion path, which presents as a hung queue, not an error. Deletion must name what it is removing and which scope it affects. Per this repo's standing rule there is **no confirmation dialog**; the protection is that the row states its scope and target plainly, and that deletion is per-row rather than bulk.
- **Programmatic reinstallation will resurrect deleted orders.** `applyTeamQueueOrders` and `applySeatPacingOrders` are idempotent installers keyed on deterministic ids — they reinstall on the next toggle or team wiring pass. So a user who deletes a queue order may see it return, which reads as the UI not working. The tab must show enough (the deterministic id, or the installer that owns it) that a re-appearing row is legible rather than mysterious.

## Edge-Case & Dependency Audit

**Migration.** None. `terminals.standingOrders` is read as-is; no schema change, no key rename.

**Security.** Order bodies contain endpoint paths and localhost ports, never tokens — `sb_api_call` injects credentials host-side. Verify that assumption holds when rendering: an order body is displayed verbatim, so anything secret that ever reached one would now be on screen. Render as text, never as HTML — bodies are agent-facing instructions that may contain markup-like characters, and this is the one XSS surface the tab introduces.

**Side effects.** Making orders visible will surface existing contradictions beyond the one named above. That is the point, but it means the tab's first users may find several — worth expecting rather than treating each as a regression.

**Ordering.** Blocked on the extraction. It is also the natural surface for a future situational orders library (composing different orders for reviewer/no-reviewer teams, and for feature versus plan dispatch); building the reader first means that work has somewhere to be seen and a way to be verified.

## Dependencies

- **Requires** `extract-agent-control-into-its-own-panel-file.md`. Landing Orders before it means building the tab twice and fighting the negative-selector filter for a week.
- **Unaffected by** `retire-the-agent-tabs-from-kanban-html.md` — Orders is never added to the board, so retirement has nothing of this plan's to delete.
- **Supersedes nothing.** `context-aware-completion-reporting.md` (C5, unbuilt) rewrites *which* orders are installed; this renders whatever is installed. They do not conflict, and this one makes that one testable by eye.
- No dependency on the unbuilt task-complete endpoint.

## Adversarial Synthesis

**"Orders are internal machinery — exposing them invites users to break their own pipelines."** They are already breaking, invisibly: two installed orders contradict each other right now, and the only way to discover it was reading `teamWiring.ts`. A store whose corruption is undetectable is worse than one a user can misedit, because the second failure is attributable.

**"Then make it read-only."** Read-only is most of the value and is why this plan is read-first. But delete earns its place on the evidence: the known-failure plan this repo already carries is *a stale standing order can still reach a live agent*, and the remedy for a stale order is removal. Read-only would show the user the stale order and offer nothing.

**"Add authoring too — half a CRUD is awkward."** Authoring is the part that needs the situational library to exist first. A free-text order box invites hand-written instructions that duplicate or contradict the installed ones, which is the current problem with more hands on it. `validateInstruction` (`standingOrders.ts:363`) exists, so authoring is cheap to add later — after there is a composed set to add to.

**"Put it in Terminals, next to the existing consumer."** `terminals.js` already fetches the endpoint, so that is where the code lives — but Terminals is the per-terminal view and orders are scoped to teams, roles and globals. Agent Control is the view that already collects `agents`, `teams`, `prompts`: cross-cutting agent configuration. Orders are the missing member of that set.

## Proposed Changes

1. **Tab button** `data-tab="orders"` and an `id="orders-tab-content"` pane in `agent-control.html`, following the established `<name>-tab-content` convention.
2. **Tab logic in `agent-control.js`**, per the companion-file convention.
3. **No projection edits.** Nothing in `kanban.html` changes; if the extraction has not shipped, this plan waits.
4. **Render from `GET /terminals/standing-orders`**, grouped by scope, each row showing scope, target/parent, team id, deterministic order id, and body as **text**.
5. **Per-row delete** through the existing mutation path (`mutateStandingOrders`), no confirmation gate, with the row's scope and target legible before the click.
6. **Label installer-owned rows** so a reinstalled order is legible rather than looking like a failed delete.
7. **No client-side resolution.** The tab renders server output; it does not add a third mirror of `applyStandingOrders`.

### Migration

None.

## Verification Plan

### Goal Invariants

- The Orders tab is **visible** in the Agent Control view and lists every installed order.
- No order body is rendered as HTML.
- Deleting a row removes exactly that order and no other.
- No new implementation of order resolution exists client-side.

### Automated Tests

- **Tab is present and reachable:** assert `agent-control.html` carries the `data-tab="orders"` button and `#orders-tab-content` pane, and that the tab activates. In the extracted file there is no filter to fight, so this is an ordinary assertion rather than the two-sided one the projection would have required.
- **Nothing was added to the board:** assert `kanban.html` contains no `data-tab="orders"` — the guard against this being back-ported into the projection during dual-run.
- **Renders every scope:** seed one order in each of the five scopes (`global`, `team`, `pair`, `team-head`, `role`) and assert all five render. A tab that silently drops `pair` or `role` is worse than no tab, since absence reads as "no such order".
- **Body is text, not markup:** seed an order whose body contains `<script>` and angle brackets; assert it renders as literal text. Bodies are written by installers today, but they are free text by type.
- **Delete is surgical:** with several orders installed, delete one by id and assert the others are untouched — including one sharing the same scope and team, which is the realistic near-miss.
- **No third resolver:** assert the orders tab code contains no copy of the marker string or of `applyStandingOrders`' selection logic, pinning the constraint `terminals.js:10353` already states in a comment.
- **The known contradiction is visible:** with `applyTeamQueueOrders` run for a team, assert the tab lists both the `team` and `team-head` rows it installs. This is the concrete case that motivated the tab — if the surface cannot show it, it has not delivered.

### Manual Verification

- Open Agent Control, confirm the tab appears alongside AGENTS / TEAMS / PROMPTS.
- Toggle a team's queue mode to auto, confirm two rows appear; toggle to manual, confirm they disappear.

## Outstanding Questions

- **[user]** Read + delete only, or authoring in v1?
- **[user]** Agent Control only, or should the board keep an Orders view too? Default assumption is Agent Control only — the board is being narrowed to the board, not widened.
- Does any order body today contain anything that should not be displayed? The credential-injection design says no, but the tab makes bodies visible for the first time, so it is worth one pass over the installed set before shipping rather than after.
- Is there a server-side "which orders reach terminal X" resolve worth exposing, so the tab can answer that without mirroring the resolver? `resolveTeamStanding` (`standingOrders.ts:101`) suggests the logic is already factored for it.
