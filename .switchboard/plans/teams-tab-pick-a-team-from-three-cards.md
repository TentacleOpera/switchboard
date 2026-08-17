# TEAMS Tab — Pick a Team From Three Cards and See It Drawn

## Goal

Turn the TEAMS tab into a picture. You land on three team cards with pixel-art portraits. You click one and the team draws itself below — head at the top, members beneath, arrows for who reports to whom — and you start it from there. Building your own team stays possible, but it is a link under the three cards, not the front door.

### Why

The tab is a form. The three team types already exist as data (`SHIPPED_TEAM_TYPES`, `kanban.html:4430-4487`) — Batch planners, Coding, Multi-agent planning — but they render as text cards next to a members editor with `role` / `count` / `scope` / `relationship` dropdowns. To find out what a team *is*, you read a roster and assemble it in your head.

Everything needed to draw a team is already in the definition: `headRole`, and `members[]` with `role`, `count` and `relationship`. Nothing new has to be stored or computed. The tab just never drew it.

The customisation surface is also backwards. Almost nobody wants to invent a team topology; they want to pick one. The editor should be reachable, not primary.

### Root cause of the gap between "three cards" and "start it from there"

The tab today holds **two lists, not one**, and only the second is startable:

| Surface | DOM | Source | What it holds |
| :--- | :--- | :--- | :--- |
| **Team Types** | `#teams-gallery` (`:3099`) | `SHIPPED_TEAM_TYPES` (`:4430`) | Hard-coded **templates**. No `id`. Not in `terminals.agentGroups`. `USE` (`:4559-4575`) forks one into a real team with a generated `group-…` id and persists it. |
| **Your Teams** | `#agent-groups-list` (`:3111`) | `agentsTabAgentGroups` | The workspace's **adopted** teams. These have ids and are what `ptyStartTeam` resolves against. |

A shipped type therefore **cannot be started** — `ptyStartTeam` resolves `teamId` out of `terminals.agentGroups` (`teamWiring.ts:481-492`), and a type has never been written there. "START sits on the flow panel, so you start the thing you are looking at" is unreachable as stated for two of the three landing cards.

Second, `kanban.html` has **no HTTP path to the terminals verbs**. Its only channel to the host is `postKanbanMessage` (VS Code `postMessage`); grep confirms zero `fetch('/terminals/verb/…')` call sites in the file — the three matches are prompt *text*, not code. So a START button here needs a new message arm, not a `fetch`. And `KanbanProvider.startAgentGroupById` (`:4534-4554`) refuses on the extension host, because that host deliberately registers no `_agentGroupInstantiator` (`:4526-4533`, `setAgentGroupInstantiator` is called only from `bootstrap.ts:1949`).

Both are solvable and both are resolved below. Neither is visible from the tab's markup, which is why the original draft did not account for them.

## What you see

**Three cards, side by side.** Each carries:

- a pixel-art portrait of the head agent (planner, lead, planner-with-fan-in),
- the team name,
- its one-line purpose (already in the data: *"Works a feature's subtasks one at a time, then hands each to the team reviewer."*),
- a compact roster strip — `LEAD · 3 CODER · 1 REVIEWER`.

**Click a card and the flow draws itself** in a panel below the row:

```
            ( LEAD )
               │
    ┌──────────┼──────────┐
 (CODER)    (CODER)    (CODER)
    └──────────┼──────────┘
               │
          ( REVIEWER )
```

Nodes are the same pixel-art figures at small size. Arrows are typed by `relationship`: `reports-to-head` draws member → head; `reviewer` and `researcher` draw their own edge with a distinct label. A `count` of 3 draws three nodes, not a "×3" badge.

**START sits on the flow panel**, so you start the thing you are looking at.

> **Superseded:** "START sits on the flow panel, so you start the thing you are looking at." — read as a single START button on every card.
> **Reason:** Two of the three landing cards are templates with no id and no row in `terminals.agentGroups`; there is nothing for `ptyStartTeam` to resolve. A single START on a shipped type would either dead-click or fake success — both barred by PRD contract #6 (capability-gating honesty).
> **Replaced with:** The flow panel's primary action is **one button whose label states which of the two things it will do**, resolved per card:
> - the card corresponds to an **adopted** team (an entry in `agentsTabAgentGroups`) → **`START`**, which starts that team's id;
> - the card is a shipped type **not yet adopted** → **`USE & START`**, which forks-and-persists exactly as `USE` does today, waits for the save to be confirmed, then starts the forked id.
>
> One control, one place, honest label. Not two peer buttons — the panel picks the label from state. The existing `USE` button on the card body is removed; adoption now happens through the flow panel or through `+ Build your own`.

**Under the three cards: `+ Build your own`.** It opens the existing form unchanged. A saved custom team gets a fourth card with a generic portrait, and draws the same way.

**Adopted teams render as cards in the same row.** A card is a card: the "Your Teams" list keeps its `EDIT` / `×` row controls (they are editor affordances, not picker affordances), but every adopted team also appears in the card row so "click a card, see it drawn, start it" is true of everything the operator can start. A shipped type that has already been adopted renders **once** — as its adopted team — matched by `name`.

## The art

Match `switchboard-site/public/assets/*-detailed.svg` exactly — that is the house style and it is already the extension's theme:

- inline SVG, authored by hand, no image files and no external requests;
- every shape a `<rect>` on a 4px grid with `shape-rendering="crispEdges"`;
- three-tone cyan ramp — `#00e5ff` body, `#7ff3ff` highlight, `#00b8cc` shadow — on `--surface-container`;
- one `feGaussianBlur` glow filter, reused by reference.

Four portraits: **planner**, **lead**, **researcher/coder**, **reviewer**. They double as the flow-diagram nodes at small scale, so author them once at a single cell size and scale by whole multiples to keep the grid crisp.

### Placeholder art is expected first — do not block on it

**Ship the tab with crude placeholders.** A portrait can start as a handful of `<rect>`s in the cyan ramp — a head, a body, one distinguishing mark per role. That is enough to build, review and use the whole tab. Nobody should be waiting on finished art to wire a click handler.

What makes this safe is the structure, so build it this way from the start: each portrait is a `<symbol>` in one `<defs>` block, drawn everywhere via `<use>` at a fixed cell size. Cards and diagram nodes reference the symbol; neither knows what is inside it. Replacing placeholder art with final art is then an edit to the `<defs>` block alone — no change to the cards, the flow diagram, the layout, or the animation.

Because the cell size is fixed, better art cannot later shift the layout. That is the property worth protecting; the drawing quality is not.

A placeholder that looks unfinished is the correct state for this tab to be in while the mechanics get proven.

**Role fallback.** A custom team can head any of eight roles (`kanban.html:3118-3127`) and members are a free-text `role` input (`:4693`), so the four authored symbols cannot cover every case. Every `<use>` resolves through one `teamsTabPortraitId(role)` helper that returns the authored symbol id when there is one and a single generic `#portrait-agent` otherwise. No card and no node ever emits a `<use href>` that resolves to nothing — an unresolved `<use>` renders as empty space, which reads as a broken card.

## The animation

On pick, the diagram draws itself: nodes fade in top-down, staggered ~60ms; each arrow strokes on via `stroke-dashoffset` over ~220ms after its nodes land. Once settled, a slow pulse travels head-ward along the arrows — the idle state, showing direction of reporting.

Nothing here is wired to running agents. It animates because you picked a team, not because a team is doing something.

Under `prefers-reduced-motion: reduce`, the diagram appears complete with no draw-in and no pulse. The file already has a `@media (prefers-reduced-motion: reduce)` block at `:1107`; extend it rather than opening a second one.

## Where the work lands

All in `src/webview/kanban.html` except the START route, which needs one arm in each host:

- `teamsTabGalleryCard` (`:4523`) — card body becomes portrait + name + purpose + roster strip; the whole card becomes the click target; the `USE` button is removed (adoption moves to the flow panel).
- `teamsTabCustomCard` (`:4583`) — demoted to the `+ Build your own` link beneath the row.
- `teamsTabRenderGallery` (`:4505`) — renders adopted teams **and** un-adopted shipped types as one row, tracks which card is picked, renders the flow panel.
- **New** `teamsTabRenderFlow(group)` — derives nodes and edges from `headRole` + `members[]` and emits the SVG. One function, one input, no state of its own.
- **New** `teamsTabPortraitId(role)` — role → symbol id, with a generic fallback.
- **New** `teamsTabStartTeam(group)` — posts the start message and surfaces the result.
- `teamsTabShowGroupForm` / `teamsTabSaveAgentGroup` — unchanged.
- `KanbanProvider._handleMessage` — new `startAgentGroup` arm.
- `TaskViewerProvider.startTeamForWorkspace` — **already exists** once the workspace-db subtask lands; this plan calls it and adds nothing to it.

The head-role collision rules, the claimed-role disabling, and `terminals.agentGroups` storage all stay as they are. This is the tab's presentation, not its model.

## Metadata

**Complexity:** 6
**Tags:** ui, ux, frontend, backend
**Project:** Browser Switchboard

## User Review Required

None. The one open design question — how a template card can be "started" when it has no id — is decided above: one button, label resolved from state (`START` / `USE & START`).

## Complexity Audit

### Routine

- Rewriting three render functions in a file that already owns all of this markup.
- Authoring placeholder `<rect>` portraits behind a `<symbol>`/`<use>` indirection.
- Deriving nodes and edges from `headRole` + `members[]` — the data is already shaped for it.
- Extending the existing `prefers-reduced-motion` block.

### Complex / Risky

- **The START route is new plumbing, not a render change, and it crosses both hosts.** `kanban.html` has no HTTP channel; the arm must be `postKanbanMessage` → `KanbanProvider._handleMessage` → the host's start path. On the extension host that path is `this._taskViewerProvider.startTeamForWorkspace(...)`; on standalone it is the existing `this.startAgentGroupById(...)`, which works there because `bootstrap.ts:1949` registers an instantiator. Getting this backwards produces a button that works in the browser cockpit and dead-clicks in VS Code, or the reverse.
- **`USE & START` is a write-then-read across a process boundary and must not race.** `USE` today is fire-and-forget: `postKanbanMessage({type:'saveAgentGroup', group})` (`:4572`) with the response handled asynchronously as `saveAgentGroupResult` (`KanbanProvider.ts:11741`). Starting immediately after posting would ask the host to resolve an id that may not be persisted yet, and the operator would get `No team found with id 'group-coding-…'` on the very first click of a brand-new card. The start must be sequenced on the `saveAgentGroupResult` message, not on the post.
- **The two lists must not double-render an adopted type.** `SHIPPED_TEAM_TYPES` and `agentsTabAgentGroups` overlap by construction — `USE` copies `type.name` verbatim into the forked team (`:4563`). Rendering both lists naively shows "Coding" twice, once startable and once not. Match on `name` and render the adopted one.
- **A member's `role` is free text.** The member editor is an `<input type="text">` (`:4693`) defaulted to `'coder'` on blur. The diagram must render an arbitrary role string without a portrait for it — hence the generic fallback — and must not assume the role is one of the eight head-role options.
- **`count` drives node count and is operator-supplied, capped at 8 in the editor** (`:4698`, `max="8"`). A team can legitimately draw 8 + 8 + 8 nodes. The layout must wrap or scroll rather than overflow the panel; a fixed three-across assumption breaks on the first wide team.
- **The tab's own explanatory copy becomes false.** `:3097` reads "A team starts when its head role starts — **no instantiate button**." A START on the flow panel makes that a lie in the same viewport as the button. It must be rewritten in this change.
- **This is presentation, but it is the surface the autostart subtask writes its toggle onto.** `START ON LOAD` lands on these cards. Reshaping the cards after that toggle ships means placing it twice. Land this first, or run the two as one stream.

## Edge-Case & Dependency Audit

**Race Conditions** —
- `USE & START`: mitigated by sequencing on `saveAgentGroupResult` (see Proposed Changes). A `saveAgentGroupResult` with `success:false` must abort the start and surface the error — starting after a failed save is the worst outcome, because the id genuinely does not exist.
- A second window editing the same workspace's teams concurrently: `_mutateAgentGroups` already serialises the write chain (`KanbanProvider.ts:4423-4443`). The card row is re-rendered from `agentsTabAgentGroups`, which is refreshed on the existing `agentGroupsLoaded` path — unchanged by this plan.
- The flow panel holds a reference to the picked group. If that group is deleted from "Your Teams" while its diagram is open, the panel must clear rather than keep a startable button for a deleted id. `teamsTabRenderAgentGroups`'s delete handler (`:4667-4673`) already calls `teamsTabRenderGallery()`; that call must now also clear the flow panel when the picked id is gone.

**Security** — the new `startAgentGroup` message carries a **group id only**, never a definition. This mirrors the `payload.group` rejection on `ptyStartTeam` (`TaskViewerProvider.ts:2598-2600`) and is not optional: the webview is reachable over HTTP in the browser cockpit, so a definition accepted here would be a definition accepted from the network, and a team definition carries `startupCommand` strings the host runs. The arm must read `msg.groupId` and nothing else from the message.

**Side Effects** —
- The `USE` button disappears from the type cards. Adoption still happens — via `USE & START` on the flow panel, or `+ Build your own`. An operator who wants to adopt *without* starting adopts by clicking `USE & START`… which also starts. That is a deliberate narrowing: the tab's stated purpose is picking a team to run, and a silent "adopt but don't run" was never a step anyone asked for. `EDIT` on the "Your Teams" row remains the way to adjust one after the fact.
- The "Team Types" and "Your Teams" section headers now describe one row and one editor list rather than two parallel galleries; their copy needs a pass.

**Migration** — none. No stored shape changes. `SHIPPED_TEAM_TYPES` gains a `portrait` hint at most (optional; `teamsTabPortraitId(headRole)` covers it without one). Nothing persisted is read differently.

**Dependencies & Conflicts** — edits `src/webview/kanban.html`, `src/services/KanbanProvider.ts`, and (call-only) `src/services/TaskViewerProvider.ts`. It **conflicts on `kanban.html` with the autostart subtask** and must not run concurrently with it. It does not touch `terminals.html` / `terminals.js`, so the sidebar subtask runs in parallel.

## Dependencies

- `sess_20260816212416 — team verbs read the wrong workspace DB` — **hard prerequisite.** This plan's START calls `TaskViewerProvider.startTeamForWorkspace(...)`, which that subtask extracts. Without it, this plan would have to inline its own root resolution and would acquire the same single-root bug on a brand-new surface.
- `sess_teamsthreepresets — teams-tab-three-presets-and-phone-a-friend` (CODE REVIEWED) — shipped `SHIPPED_TEAM_TYPES` and the gallery this plan redraws.
- Must land **before** `sess_teamsstartonload — Teams Start Themselves on Load`, which places a toggle on these cards.

## Adversarial Synthesis

**Risk summary.** The headline risk is a beautiful tab whose primary button does not work: three cards, a drawn diagram, a START that resolves an id the host has never stored — passing every visual check while failing its one functional promise. The second is host asymmetry, where the start route works in the browser cockpit (which has an instantiator registered) and dead-clicks in VS Code (which does not), because the two hosts reach the fleet by different paths. Mitigations: the button's label is resolved from adoption state so it can never claim to start something unstartable; `USE & START` is sequenced on `saveAgentGroupResult` rather than fired after the post; and the verification plan exercises the button on both hosts explicitly rather than assuming shared markup implies shared behaviour.

## Proposed Changes

### `src/webview/kanban.html` — the card row, the flow panel, the portraits

- **Context:** `#teams-gallery` (`:3099`), `#agent-groups-list` (`:3111`), `teamsTabRenderGallery` (`:4505-4521`), `teamsTabGalleryCard` (`:4523-4581`), `teamsTabCustomCard` (`:4583-4607`), `SHIPPED_TEAM_TYPES` (`:4430-4487`), `agentsTabAgentGroups`, the reduced-motion block (`:1107`).
- **Logic:**
  1. **One `<defs>` block**, emitted once into `#teams-tab-content`, holding `<symbol id="portrait-planner">`, `#portrait-lead`, `#portrait-coder`, `#portrait-reviewer`, `#portrait-agent` (generic), plus the single `feGaussianBlur` glow filter. Placeholder `<rect>` art per the art section. Every consumer draws `<use href="#portrait-…" width="CELL" height="CELL">` at a fixed `CELL`.
  2. **`teamsTabPortraitId(role)`** — maps `planner|lead|coder|reviewer` to their symbols, `researcher`/`analyst`/`tester`/`intern` and anything unrecognised to `#portrait-agent`. Pure, no DOM.
  3. **`teamsTabRenderGallery()`** builds one row from a merged list:
     ```js
     const adoptedByName = new Map(agentsTabAgentGroups.map(g => [g.name, g]));
     const cards = [
         ...agentsTabAgentGroups.map(g => ({ group: g, adopted: true })),
         ...SHIPPED_TEAM_TYPES
             .filter(t => !adoptedByName.has(t.name))
             .map(t => ({ group: t, adopted: false })),
     ];
     ```
     Adopted teams first, then un-adopted types. Each entry renders a `teamsTabGalleryCard(entry)`. Below the row, the `+ Build your own` link (the demoted `teamsTabCustomCard`). Below that, `#teams-flow-panel`.
  4. **`teamsTabGalleryCard(entry)`** — portrait `<use>` for `entry.group.headRole`, name, `purpose` (types carry one; adopted teams fall back to their member summary), roster strip. The whole card is the click target: `onclick` sets the picked key and calls `teamsTabRenderFlow(entry)`. No `USE` button.
  5. **`teamsTabRenderFlow(entry)`** — derives from `entry.group.headRole` + `members[]`:
     - one head node;
     - `count` nodes per member, wrapping at the panel width;
     - one edge per member node, typed by `relationship`: `reports-to-head` → member→head unlabelled; `reviewer` / `researcher` / `tester` / `handoff` / `second-opinion` → its own edge with the preset's label from `MEMBER_RELATIONSHIP_PRESETS` (`:4496-4503`).
     Emits the SVG and the action button:
     ```js
     const btn = document.createElement('button');
     btn.className = 'agents-tab-custom-agent-item-btn';
     btn.textContent = entry.adopted ? 'START' : 'USE & START';
     btn.addEventListener('click', () => entry.adopted
         ? teamsTabStartTeam(entry.group.id)
         : teamsTabAdoptAndStart(entry.group));
     ```
  6. **`teamsTabAdoptAndStart(type)`** — forks exactly as the current `USE` handler does (`:4561-4568`), pushes to `agentsTabAgentGroups`, re-renders, posts `saveAgentGroup`, and **records the pending id**:
     ```js
     teamsTabPendingStartId = forked.id;
     postKanbanMessage({ type: 'saveAgentGroup', group: forked });
     ```
     The existing `saveAgentGroupResult` handler gains:
     ```js
     if (teamsTabPendingStartId) {
         const id = teamsTabPendingStartId;
         teamsTabPendingStartId = null;
         if (msg.success) { teamsTabStartTeam(id); }
         else { /* surface msg.error in #agent-groups-error; do NOT start */ }
     }
     ```
     This is the race guard: the id is only started once the host confirms it is persisted.
  7. **`teamsTabStartTeam(groupId)`** — `postKanbanMessage({ type: 'startAgentGroup', groupId })`, disable the button and show `STARTING…` until `startAgentGroupResult` arrives; on failure write `msg.error` into `#agent-groups-error` verbatim (the host's messages — cap refusal, double-start refusal, `No team found with id` — are good and must not be generified).
  8. **Copy fixes:** `:3097` — replace "A team starts when its head role starts — no instantiate button." with copy that states both truths: a team still starts automatically when its head role starts, *and* you can start it here. `:3104-3109` — the "Your Teams" blurb keeps its editor framing.
  9. **Reduced motion:** extend `:1107` so `.teams-flow-node`/`.teams-flow-edge` have no transition, `stroke-dashoffset: 0`, and no pulse animation.
- **Edge Cases:**
  - Zero adopted teams and three types → three `USE & START` cards. Correct first-run state.
  - A member with `count` unset → one node (`m.count || 1`, matching `teamSpawnSummary`).
  - A team with `members: []` → head node alone, no edges, and the existing "does nothing until you add a member" hint (`:4649-4657`) still applies on the editor row.
  - An `unassigned` team (head-role collision loser) is still startable explicitly (`resolveTeamById` does not filter it — `teamWiring.ts:477-479`), so its card renders with `START` and carries the existing `unassignedReason` note.
  - Deleting the picked team clears the flow panel (see Race Conditions).

### `src/services/KanbanProvider.ts` — the `startAgentGroup` message arm

- **Context:** the message switch around `saveAgentGroup` (`:11733-11747`) / `deleteAgentGroup` (`:11748-11760`). `_taskViewerProvider` exists (`:271`, set at `extension.ts:1187` and `bootstrap.ts:788`). `_agentGroupInstantiator` is registered on standalone only (`:307-310`, `bootstrap.ts:1949`), and `startAgentGroupById` (`:4534`) already refuses cleanly when it is absent.
- **Logic:**

```ts
case 'startAgentGroup': {
    // Group ID ONLY — never a definition. This panel is reachable over HTTP in
    // the browser cockpit, and a team definition carries startupCommand strings
    // the host runs. Same rule as ptyStartTeam's payload.group rejection.
    const workspaceRoot = this._resolveWorkspaceRoot();
    const groupId = msg.groupId;
    if (!groupId || !workspaceRoot) {
        this.postMessage({ type: 'startAgentGroupResult', success: false, error: 'Missing team ID or workspace' });
        break;
    }
    try {
        // Host split, mirroring setAgentGroupInstantiator's own contract
        // (:300-310): standalone registers an instantiator and owns the fleet
        // in-process; the extension host does not, and reaches the pty fleet
        // through TaskViewerProvider. startTeamForWorkspace is the extension
        // host's single team-start entry point — it owns the candidate-root
        // walk, so this arm must NOT resolve a root of its own.
        const result = this._agentGroupInstantiator
            ? await this.startAgentGroupById(workspaceRoot, groupId, async () => [])
            : await this._taskViewerProvider!.startTeamForWorkspace({
                  teamId: groupId,
                  pinnedRoot: workspaceRoot,
              });
        this.postMessage({ type: 'startAgentGroupResult', ...result });
    } catch (e: any) {
        this.postMessage({ type: 'startAgentGroupResult', success: false, error: e?.message || 'Failed to start team' });
    }
    break;
}
```

- **Edge Cases:**
  - The standalone branch's `liveTerminals` callback: use the same shape `bootstrap.ts:1184-1190` passes to `startAgentGroupById` rather than the `async () => []` placeholder above, so double-start reconciliation still works on that host. An empty list disables the refusal and would let a second head spawn.
  - The extension branch passes no `payloadCwd` / `parentRoot`: the TEAMS tab has no per-workspace target control, so the spawn cwd falls through to `pinnedRoot`, matching an unqualified start. If a target is wanted later it is an added field, not a changed signature.
  - `this._taskViewerProvider` is set on both hosts, so the `!` is safe; keep it optional-chained anyway if the surrounding code does.
  - **Return-in-body (PRD #4):** every branch posts a `{success, error?}` result and the arm's own `catch` returns a failure — no silent `break`, no false success.

## Verification Plan

### Automated Tests

1. `npm run lint`.
2. Grep proves no external asset reference in the new SVG: `grep -n "<image\|xlink:href=\"http\|url(http" src/webview/kanban.html` returns nothing new.
3. Grep proves the definition never crosses the wire: the `startAgentGroup` arm reads `msg.groupId` and there is no `msg.group` dereference in it.
4. `npm run verb-returns:check` and `npm run push-routing:check` — the new arm returns in-body and adds no raw `postMessage` beyond its result.

### Manual

Open the TEAMS tab and look at it:

5. Three cards with portraits, purposes and rosters — no dropdowns visible on landing.
6. Click Coding → a lead, three coders and a reviewer draw in, staggered, arrows last.
7. Click Multi-agent planning → the diagram changes to that team's shape; two researchers, not a "×2".
8. On an **un-adopted** type the flow-panel button reads `USE & START`. Click it: the team appears under "Your Teams", the card row re-renders it as an adopted card, and the team starts. The card no longer offers `USE & START` — it now reads `START`.
9. On an **adopted** team the button reads `START` and starts it directly.
10. Adopt a type, then start it a second time while its head is live: the host's double-start refusal appears verbatim in the error line — not a generic failure.
11. Kill the save path (e.g. point the board at a read-only DB): `USE & START` surfaces the save error and **does not** attempt a start.
12. `+ Build your own` opens the existing form; save one and it appears as a card that draws like the rest.
13. A custom team with a free-text member role (`e.g. "archivist"`) draws with the generic portrait, not an empty node.
14. A team with 8 members of one role wraps within the panel and does not overflow it.
15. Delete the currently-picked team from "Your Teams": the flow panel clears and offers no START for the deleted id.
16. With reduced motion on, the diagram is simply there.
17. Nothing in the SVG references a URL — confirm no network requests from the tab.
18. Swap one placeholder portrait for a finished one by editing only the `<defs>` block: the cards and the flow diagram pick it up with no other edit, and no layout shifts.
19. **Both hosts.** Repeat 8–10 in VS Code *and* in the browser cockpit. The two take different code paths inside the `startAgentGroup` arm; shared markup does not imply shared behaviour here.

---

**Recommendation:** Complexity 6 → **Send to Coder.**
