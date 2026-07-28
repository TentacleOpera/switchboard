---
description: "Fix the Kanban project filter's cross-client coupling. The client-local view filter (boardProjectFilter) already exists; the remaining bugs are on the shared side: kanban.activeProjectFilter is last-writer-wins and decides where NEWLY AUTHORED plans/features get filed (PROJECT PIN at KanbanProvider:8944, feature stamping at :11878), and a project switch reloads project-scoped settings for every client. The reported 'extension project switch didn't work' symptom is now root-caused: _refreshBoardImpl still server-filters the card set by the shared _projectFilter while the other two card-source paths send it unfiltered, so the client-side filter runs on an already-filtered set and renders empty. Piece 3 of 3; independent of pieces 1 and 2."
---

# Kanban Project Filter — Client-Local View, Per-Initiator Authoring Scope

## Goal

**Definition of done: (a) switching project in one client cannot change where another client's newly authored plans and features get filed, (b) switching project in one client cannot swap another client's effective project-scoped settings, and (c) the reported "extension project switch didn't work" symptom is root-caused and fixed.**

### Core problem (root-cause analysis)

Unlike the Design panel (pieces 1 and 2), the Kanban board's *view* filter is **already** client-local and working. `boardProjectFilter` (`kanban.html:4230`) is documented as *"the single source of truth for what the board renders"*, cards for all projects are cached in `allCards` and filtered client-side (`:4235-4239`), and the comment at `:7202-7215` states the intent plainly — the local filter is preserved on same-workspace refreshes *"so browser and webview never reset each other."* That part is sound and this plan does not disturb it.

The bugs are on the **shared** side.

> **Superseded:** "there are two proven ones plus one unresolved symptom."
> **Reason:** The improve pass root-caused the unresolved symptom by code reading (see *Proven bug 3* below). It is not one of the three candidates the plan listed — it is a fourth cause: an **incomplete migration** of the board's card-source paths to client-side project filtering. Leaving it labelled "unresolved" would send the implementer into a speculative instrumentation pass for a defect that is already located and one-line-shaped.
> **Replaced with:** There are **three proven bugs**. The symptom is proven bug 3.

#### Proven bug 1 — the shared row decides where new plans get filed (data correctness)

`setProjectFilter` (`KanbanProvider.ts:6539-6567`) writes the shared singleton `_projectFilter` **and** persists `kanban.activeProjectFilter` to the DB on **every** dropdown switch, from **either** client. That row is last-writer-wins across clients.

That row is not merely cosmetic — it is the **authoring scope**:

- `:8944` reads it to build the **PROJECT PIN** directive injected into plan-authoring prompts (`agentPromptBuilder.ts:878`: *"The user had the project X active when they copied this prompt"* → the agent writes `**Project:** X` into every plan file it creates).
- `:11878` reads it to stamp a **new feature's** project when its subtasks carry none.
- `GlobalPlanWatcherService._handlePlanFile` stamps imported plans from it (per the comment at `:11870-11872`).

**Consequence:** leave the browser board on project X, then copy a plan prompt from the extension while looking at project Y — the generated plans are pinned to **X**. Silently misfiled, with no visible cause, and `CLAUDE.md`'s pinning protocol is explicit that this snapshot is meant to be *"a frozen, race-free snapshot"* of *"the board's active project"*. With two clients there is no single "the board", so the guarantee quietly fails.

Note this row is **legitimately shared state** — it is the authoring/dispatch scope, deliberately one source of truth, and remote/DB-less agents depend on reading it. So the fix is **not** to make it client-local. The fix is that the authoring scope for a *client-initiated* action must be resolved from **that client's** view filter, not from a last-writer-wins global.

> **Superseded:** "the two authoring read sites (`:8944`, `:11876`)."
> **Reason:** A read-site sweep for `kanban.activeProjectFilter` and `getProjectFilter()` found **four** client-initiated authoring sites, not two — and they do not even agree on their source (two read the persisted DB row, two read the in-memory singleton). Fixing only the two named sites leaves the other two misfiling under exactly the same conditions, so the plan would pass its own success check while the goal stayed unmet.
> **Replaced with:** *(superseded again — see below.)*

> **Superseded:** "found **four** client-initiated authoring sites… (all four must be threaded)."
> **Reason:** The four-site sweep was itself incomplete, and it failed in exactly the way the block above criticises. A re-sweep across **both** patterns in `src/` (`kanban.activeProjectFilter` **and** `getProjectFilter()`, over `KanbanProvider.ts`, `TaskViewerProvider.ts`, `PlanningPanelProvider.ts`) found **nine** client-initiated authoring sites. The most damning omission is `TaskViewerProvider.ts:6762` — the **ClickUp** task import, a byte-for-byte sibling of the Linear import at `:6696`, sixty-six lines below it in the same file, with the identical `const projectFilter = this._kanbanProvider?.getProjectFilter() ?? null;` shape. Threading Linear and not ClickUp would ship the misfiling bug on one importer and fix it on the other. `KanbanProvider.ts:1214` (`copyGeneralChatPrompt`) is the second-worst: it is `chatCopyPrompt`'s twin, feeds the same `manifestProject` into the same `buildKanbanBatchPrompt`, and **already takes a `projectName?` parameter** — the initiator channel is half-built there and simply unused by the webview.
> **Replaced with:** The nine-site table below. Threading fewer than all nine reproduces the partial-fix failure this plan's own *Adversarial Synthesis* names as its second-biggest risk.

**Client-initiated authoring read sites (all nine must be threaded):**

| # | Site | Reads | What it stamps |
|---|---|---|---|
| 1 | `KanbanProvider.ts:8944` (`chatCopyPrompt` arm, `:8922`) | DB row `kanban.activeProjectFilter` | PROJECT PIN in the planning prompt |
| 2 | `KanbanProvider.ts:11878` (`createFeatureFromPlanIds`, verb `createFeature` at `:10731`) | DB row | New feature's project when subtasks carry none |
| 3 | `KanbanProvider.ts:1214` (`copyGeneralChatPrompt`) | DB row | `manifestProject` → PROJECT PIN in the general chat prompt |
| 4 | `PlanningPanelProvider.ts:3411` (`createPlansPasteBack` arm) | In-memory `getProjectFilter()` | `projectName` passed to `switchboard.importPlanFromClipboard` |
| 5 | `TaskViewerProvider.ts:6696` (**Linear** issue import) | In-memory | Project of every plan created from the imported issue |
| 6 | `TaskViewerProvider.ts:6762` (**ClickUp** task import) | In-memory | Project of every plan created from the imported task |
| 7 | `TaskViewerProvider.ts:18837` (`createDraftPlanTicket`) | In-memory | `projectName` on the new draft plan ("Inherit the active kanban project filter") |
| 8 | `TaskViewerProvider.ts:11997` (memo `process`/`send` arm) | DB row | `projectName` → `_buildMemoPlannerPrompt` → PROJECT PIN the planner writes into every memo-derived plan |
| 9 | `TaskViewerProvider.ts:8771` (orchestrator kickoff dispatch) | DB row | Injects "active project filter" into the orchestrator persona prompt; the orchestrator then authors under it |

Sites 1–3 and 8–9 read the **persisted DB row**; sites 4–7 read the **in-memory singleton**. Sites 1, 3, 8 and 9 are *prompt-pin* carriers (the agent writes the `**Project:**` line); sites 2 and 4–7 stamp a DB record directly. Both classes misfile identically, so both are threaded through the same resolver.

**Deliberately NOT threaded — background/no initiator:**

| Site | Reads | Why it stays on the shared default |
|---|---|---|
| `TaskViewerProvider.ts:15676` (brain plan auto-claim) | In-memory `getProjectFilter()` | Fires from a file watcher, not a client action. There is no initiator to attribute it to; the workspace-level default is the correct and only available answer. |
| `GlobalPlanWatcherService._handlePlanFile` | DB row | Same — file-watcher import, no initiator. This is the path remote/DB-less agents depend on. |
| `TaskViewerProvider.ts:17512`, `:17523`, `:17578` (`runSheets` push) | In-memory | Display-only: `projectFilter` is echoed to the sidebar, stamps nothing. Becomes a per-connection concern in the successor plan, not an authoring one. |
| `KanbanDatabase._resolveProjectForInsert` (`:2002`, `:3458`, `:8452`) | DB row (sync) | The importer's own precedence chain and the resolve-only guard. **Must not change** — it is the `CLAUDE.md` backstop this plan depends on. |

**Precedent — the mechanism is already in the codebase, not novel.** `kanban.html:4279` already sends the board's own filter in a verb payload today:

```js
postKanbanMessage({ type: 'suggestFeatures', workspaceRoot: getActiveWorkspaceRoot(), projectFilter: boardProjectFilter ?? null });
```

So "the initiating client puts its view filter in the message" is an established pattern here, not an invention — which lowers the risk of option (a) materially. Two consequences: (i) cite this when reviewing, and (ii) **field naming** — the existing precedent uses `projectFilter`. This plan uses `initiatorProject` deliberately, because `projectFilter` is already overloaded across three different meanings in this file (the singleton, the DB row, the board's view filter) and a fourth would be actively harmful. Leave `suggestFeatures` on its existing name; do **not** rename it as drive-by scope.

**Clarification (not new scope):** the split between DB-row readers and in-memory-singleton readers is itself a latent inconsistency — the in-memory value can lead the persisted row (`setProjectFilter` writes memory first, then awaits the DB write) and can lag it (`_refreshBoardImpl:3341` re-reads the row into memory only on refresh). Threading an explicit initiator value past both makes the distinction moot for client-initiated actions, which is a second reason to prefer that mechanism over "read the right global."

#### Proven bug 2 — one client's switch swaps the other's effective settings

When project override is enabled, `setProjectFilter` (`:6560-6566`) calls `_reloadSettingsFromStore()`, `_markConfigDirty()`, `refreshPromptOverridesCache()` and `_postOverrideState()`. These act on the provider singleton and push to **all** clients. So a browser project switch re-scopes the extension's effective settings and prompt overrides mid-session.

> **Superseded:** *(fix approach)* "make the `_reloadSettingsFromStore` / `_postOverrideState` consequences at `:6560-6566` apply to the initiating client rather than unconditionally to the singleton + all clients."
> **Reason:** The reload is not the carrier. `_getScopedSetting` (`:625-660`) and `getScopedRoleConfig` (`:545-570`) resolve the **project tier by reading `this._projectFilter` live, at read time** — not from the cached fields `_reloadSettingsFromStore` populates. Suppressing the reload would leave the six cached fields stale while every on-demand scoped read (role configs, prompt overrides, and therefore prompt generation) still swaps to the other client's project. The plan would ship a change that makes the symptom less visible without fixing it — the classic green-metric-over-real-goal failure.
> **Replaced with:** **Option C1 — thread an initiator project scope through the scoped read/write path** so a client-initiated action resolves settings against its own project. This is the same mechanism as bug 1, extended to the four scoped accessors. **Selected by the user over C2** (which would have declared project-override settings workspace-global and fixed only the UI-push half). C1's surface is bounded and shallow — see *C1 surface* below.

**C1 surface (measured, not estimated).** The scoped read/write path is already funnelled through exactly four functions, and all four are exposed as members of the `KanbanServiceContext` seam interface (`kanbanService.ts:42`, wired at `KanbanProvider.ts:6975-6978`):

| Function | Site | Call sites needing the new argument |
|---|---|---|
| `getScopedRoleConfig` | `KanbanProvider.ts:545` | 4 — `:513`, `:6975` (ctx), `:9832`, `TaskViewerProvider.ts:869` (`_readRoleConfigScoped`) |
| `updateScopedRoleConfig` | `KanbanProvider.ts:574` | 2 — `:6976` (ctx), `:9814` (Prompts-tab save) |
| `_getScopedSetting` | `KanbanProvider.ts:627` | 3 outside the cache loaders — `:733`, `:6977` (ctx), `:9834` |
| `_updateScopedSetting` | `KanbanProvider.ts:665` | 11, all arm-level or one hop — `:860`, `:5981`, `:5982`, `:6013`, `:6014`, `:6817`, `:8201`, `:8229`, `:8241`, `:8295`, `:9816` (+ `:6978` ctx) |

> **Superseded:** `updateScopedRoleConfig` at "`:575`"; `_getScopedSetting` "5 outside the cache loaders"; `_updateScopedSetting` "10".
> **Reason:** Re-counted against the file. `updateScopedRoleConfig` is at `:574`. `_getScopedSetting` has 3 non-loader call sites, not 5 (the loader sites are `:394-409` and `:753-762`). `_updateScopedSetting` has 11 enumerated sites, not 10 — the plan's own list already contained eleven entries while the prose said ten. These are checklist numbers; an implementer ticking off ten and stopping leaves one unthreaded.
> **Replaced with:** The corrected counts above.

**One scoped read bypasses all four accessors and must be threaded separately.** `TaskViewerProvider.exportPromptSettings` (`:873`, reads at `:919-921`) resolves the project tier itself, straight off the DB:

```ts
const activeProject = db.getConfigSync('kanban.activeProjectFilter');
const projectOverrideOn = db.getConfigJsonSync<boolean>('kanban.projectOverrideEnabled', false);
if (projectOverrideOn && activeProject && activeProject !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) { … }
```

It reimplements the exact predicate C1 is centralising, and it is **client-initiated** (the Prompts tab's Export button). Under C1 it exports the *other* client's project role configs into a settings file the user then shares or re-imports. It is not in the four-accessor table because it never calls them — which is precisely why a sweep scoped to the accessors misses it. Thread it with the same `_projectTier(initiatorProject)` helper.

**There is no deep transitive call chain.** Every scoped read/write is either at arm level, one hop from an arm, or inside the two cache-loader functions. An optional trailing parameter therefore reaches every site without a signature cascade, and **no implicit request-scoped context (`AsyncLocalStorage`) is required.**

**Two carriers of shared state remain and must be handled explicitly:**

1. **`TaskViewerProvider._cachedDefaultPromptOverrides` (`:854`) is a single unkeyed field.** `refreshPromptOverridesCache()` rebuilds it from "the current scope" — i.e. the singleton `_projectFilter`. Under C1 it must become **project-keyed** (`Map<string, Overrides>`, keyed by resolved project or a sentinel for none) or be resolved on demand. Left unkeyed, C1's threading is defeated at the last hop for exactly the settings that matter most: prompt overrides.
2. **The six cached fields loaded by `_reloadSettingsFromStore` (`:751-763`)** — `_cliTriggersEnabled`, `_dynamicComplexityRoutingEnabled`, `_columnDragDropModes`, `_routingMapConfig`, `_allowUnknownComplexityAutoMove`, `_kanbanOrderOverrides` — are singleton caches read from 75 sites across the provider (21 / 12 / 13 / 11 / 9 / 9). Those 75 reads are **not** 75 equivalent problems. Classifying them splits the remaining work along a hard architectural line:

   | Class | Examples | Reachable from an initiator? |
   |---|---|---|
   | **Cache-load / write-back** | `:399-401`, `:758-760`, `:5978`, `:6009`, `:6818`, `:8293` | Yes — arm level; already covered by threading the four accessors. |
   | **Decision reads** — settings that *cause behaviour* | `:1273-1276` (complexity → role routing), `:5929` (effective drag-drop mode) | Yes — reachable from the arm that initiated the action. **In scope** (stage 4). |
   | **Push-payload reads** — settings embedded in broadcast messages | `:1113`, `:2012`, `:3519`, `:3686` (`routingConfig` in `updateBoard`); `:2055`, `:3546`, `:3705` (`modes` in `updateColumnDragDropModes`); `:1112`, `:2021`, `:3522`, `:3687` (`enabled` in `cliTriggersState`) | **No.** See the floor below. |

> **Superseded:** the push-payload row's contents — "`:2053`, `:3544`, `:3703` (`dragDropMode` inside `updateColumns`), `:4627`".
> **Reason:** Three separate errors in one table cell.
> **(a) Wrong message.** `:2053`/`:3544`/`:3703` are the lines that *compose* the `effectiveModes` map; the map is sent as its own **`updateColumnDragDropModes`** message at `:2055`/`:3546`/`:3705`. `updateColumns` (`:1110`, `:1964`, `:3472`, `:3657`) carries column **definitions**, whose `dragDropMode` field (`:106`) is the *configured* per-column mode from the column spec — not the scoped `_columnDragDropModes` override, and therefore not scope-dependent at all. An implementer of the successor plan would go looking for a scoped field inside `updateColumns` and find nothing. The successor plan (`per-connection-scoped-push-rendering.md`) names the message correctly; this plan must agree with it or the two disagree about what the deferred remainder even is.
> **(b) Missing message.** `cliTriggersState` (`:1112`, `:2021`, `:3522`, `:3687`) embeds `_cliTriggersEnabled` and is scope-dependent in exactly the same way. It was absent from the floor entirely. The successor plan lists it; this plan did not.
> **(c) `:4627` is misclassified.** It is **not** a push payload. It sits inside `generateUnifiedPrompt` (`:4505`) — `routingMapConfig: this._routingMapConfig` is baked into the **generated dispatch prompt**. That is a client-initiated authoring/decision read with a real initiator, so it belongs **in scope** in stage 4, not in the deferred floor. Left in the floor, a dispatched agent receives the other client's routing map inside its prompt — a silent cross-client leak into agent instructions, which is a worse failure than a stale legend.
> **Replaced with:** The corrected row above (eleven emit sites across three message types), and `:4627` moved into stage 4's in-scope decision reads.

**The architectural floor (why this plan cannot be 100% comprehensive on its own).** Push-payload reads are not request-scoped — they are server-initiated broadcasts with no initiator to attribute. `postMessage` → `_broadcaster.push` → `wsHub.broadcast(verb, payload, surface)` renders **one payload** and fans it out to every connection. Making `routingConfig` or `dragDropMode` per-client therefore requires **per-connection payload rendering**, which requires the server to know each connection's project — and verbs arrive over **HTTP** (`handleServiceVerb`) while pushes leave over **WS**, two channels with no association between them.

The groundwork exists but the association does not: `WsHub` already holds `private _connections: Set<ConnectionMeta>` (`wsHub.ts:49`) with per-connection sequence numbers and resync-on-connect. What is missing is (a) a client identity sent on HTTP verb calls, (b) per-connection project state stored against `ConnectionMeta`, and (c) per-connection rendering in `BroadcastHub.push` / `WsHub.broadcast`. That is a new capability spanning three services, and it **subsumes** the `initiatorProject` threading rather than extending it — so it is a genuine successor plan, not a stage of this one. It is recorded in Scope as the deliberate remainder.

The `_postOverrideState()` broadcast is a separate defect within bug 2: it pushes `overrideState` through `postMessage` → `_broadcaster.push` (`:2090-2100`), which fans out to the webview **and** every WS client, so client A's switch rewrites client B's override toggles, hint text, and "Active scope:" indicator. Under C1 the override scope genuinely *is* per-client, so this state belongs in the initiating verb's return body (PRD contract #4) and must **not** be broadcast.

> **Superseded (scope correction, not a reversal):** the implication that removing the `setProjectFilter` push is sufficient to stop `overrideState` following the last switch.
> **Reason:** **`setProjectFilter` is not the only emitter, and it is not even the frequent one.** `_postOverrideState()`'s own docstring (`:6436`) says so: *"Called from toggle handlers, setProjectFilter, and the refresh push cluster."* The full emitter set is `:2022`, `:3523`, `:3688` (**the refresh push cluster**), `:6566` (`setProjectFilter`), and `:8158`, `:8170`, `:8193` (the genuine global toggles). The refresh cluster fires on essentially every board refresh — including the 35 `_refreshBoard` call sites this plan is already widening. So the sequence is: the initiating client applies the correct per-client `overrideState` from the verb response (step 6) → the very next refresh broadcasts a singleton-rendered `overrideState` to everyone → the fix is silently reverted, typically within seconds, with no user-visible cause. Step 6 alone is **green-metric-over-real-goal**: test 7 (which asserts `setProjectFilter` does not broadcast) passes while the observable behaviour is unchanged.
> Two further accuracy points on the same function: (i) `_postOverrideState` opens with `if (!this._panel) return;`, so it emits **nothing at all** when the VS Code panel is closed — the cross-client defect is real but conditional on the editor panel existing, and browser-only clients receive no `overrideState` today by any path; (ii) `overrideState` is therefore a **fourth scope-dependent push type**, alongside the three in the floor table above, and it has the same no-initiator problem they do.
> **Replaced with:** Step 6 stands as written — it is necessary and it is the half that has an initiator. The refresh-cluster half is **explicitly moved to the successor plan** as a fourth push type (see *Out of scope* and the *Successor plan* note), because it is the same architectural problem: a server-initiated broadcast that must be rendered per connection. Until the successor lands, this plan's stage 3 must state honestly in the override UI that the *displayed* "Active scope:" indicator can be transiently rewritten by another client's refresh, even though the *effective* scope for the initiating client's actions is correct. Do **not** attempt to fix the refresh-cluster pushes by threading — they have no initiator, which is the whole reason the floor exists.

> **Note on the C2 path (not taken).** Under C2 the broadcast would have been *correct* — honest reporting of genuinely shared state — and suppressing it would have left the other client's "Active scope:" label stale. The broadcast is only a defect once C1 makes the scope per-client. The two options therefore imply **opposite** changes to `_postOverrideState`; do not mix them.

#### Proven bug 3 — the live refresh still server-filters the card set (this is the reported symptom)

> **Superseded:** "**This is not yet root-caused, and the plan must not pretend otherwise.** … Verified candidates to discriminate between: 1. Re-seed on an unrelated push. 2. Dropdown re-render snapping selection. 3. Snapshot early-out suppressing the repaint. … Step 1 of implementation is therefore diagnostic, not corrective."
> **Reason:** The cause was found by reading the three card-source paths against each other. It is none of the three candidates. All three candidates were checked and are non-causes for this symptom: (1) the re-seed at `kanban.html:7207-7215` cannot fire for a client that already owns a non-null filter; (2) the dropdown ladder at `:4798-4830` reads `boardProjectFilter`, not the backend mirror, at every priority level, and its `savedValue` is read from the client's own DOM before the rebuild; (3) the WS resync (`getFullStateMessages`) pushes `updateBoard` directly to a new client and bypasses the early-out entirely. Keeping a speculative diagnostic step would burn the implementer's first pass re-deriving a settled answer.
> **Replaced with:** The root cause below, plus a corrective step 1.

**The board has three card-source paths. Two were migrated to client-side project filtering; one was not.**

| Path | Project argument | Sends |
|---|---|---|
| `TaskViewerProvider._refreshRunSheetsImpl:17441-17445` — the **primary** refresh | `null` (explicitly, with a comment: *"Project filtering moved client-side … pass null … sends the unfiltered card set to the board"*) | **Unfiltered** ✅ |
| `KanbanProvider.getFullStateMessages:1080-1085` — WS **resync-on-connect** | `null` (*"project filter stays client-side (pass null), only repoScope is a backend concern"*) | **Unfiltered** ✅ |
| `KanbanProvider._refreshBoardImpl:3378-3381` — the **secondary** refresh, reached by 35 `this._refreshBoard(...)` call sites | `this._projectFilter` | **Server-filtered** ❌ |

```ts
// KanbanProvider.ts:3377-3381 — the un-migrated path
const projectFilter = this._projectFilter;
const repoScope = this._repoScopeFilter;
const dbRows = (projectFilter !== null || repoScope)
    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getBoard(workspaceId);
```

`_projectFilter` is **never `null`** — it initialises to `KanbanDatabase.UNASSIGNED_PROJECT_FILTER` (`:218`) and every writer sets either a project name or `'__unassigned__'`. So `projectFilter !== null` is always true and this path **always** server-filters.

Meanwhile the webview believes otherwise. `kanban.html:7299-7304`:

```js
case 'updateBoard': {
    // Cache the full unfiltered card set (all projects) and apply the
    // local boardProjectFilter client-side … The backend now sends
    // unfiltered cards; the board owns its view filter so browser and
    // webview never reset each other.
    allCards = Array.isArray(msg.cards) ? msg.cards : [];
```

**The failure chain (exactly the reported symptom):**

1. A refresh arrives via `_refreshBoardImpl` while `_projectFilter === 'X'`. `allCards` is now **only project X's cards**, mislabelled as the full set.
2. The user switches the dropdown to project Y. The same-workspace branch (`kanban.html:8326-8340`) sets `boardProjectFilter = 'Y'`, runs `applyBoardProjectFilter(allCards)` → **zero cards**, renders an empty board, and posts `setProjectFilter` with **`noRefresh: true`** — deliberately declining the round-trip that would have repopulated it.
3. The board sits empty until an unrelated refresh happens to fire. **"The project switch didn't work."**

**Why it was never reproducible:** the outcome depends on *which path last populated `allCards`*. Refreshed via the primary path or a fresh WS connect → unfiltered cache → the switch works. Refreshed via any of the 35 `_refreshBoard` call sites → filtered cache → the switch renders empty. Same click, opposite results, no user-visible difference in state.

**Corroborating evidence that this is an unfinished migration, not a design choice:**

> **Superseded:** "`TaskViewerProvider.ts:17432` reads `const projectFilter = this._kanbanProvider?.getProjectFilter() ?? null;` and **never uses it** — a dead local left behind when that path was switched to `null`."
> **Reason:** **Factually wrong — the local is live.** `projectFilter` at `:17432` is read at `:17480` (`const excludeProjectPlans = projectFilter === null || projectFilter === '__unassigned__';`) and `:17490` (`return row.project === projectFilter;`), both inside `filterByProjectScope` (`:17481`), which filters the **sidebar** run-sheet rows at `:17494-17498`. The migration moved the *board's* project filtering client-side; the *sidebar* still filters in the backend and this local is what it filters by. The claim appeared three times (here, Implementation Step 1, and the `TaskViewerProvider` entry in Proposed Changes) and each instruction to delete it has been removed. TypeScript would have caught the deletion, but only after the implementer had already acted on a stated fact and gone looking for why the plan was wrong.
> **Replaced with:** The two items below. The unfinished-migration conclusion is unaffected — it rests on the explicit comments at `TaskViewerProvider.ts:17433-17440` and `KanbanProvider.ts:1080-1085`, which say in so many words that project filtering moved client-side, against `_refreshBoardImpl` which never got the memo.

- **The two migrated paths say so in comments; the third contradicts them in code.** `TaskViewerProvider._refreshRunSheetsImpl:17433-17440` — *"Project filtering moved client-side… pass null for the project argument… sends the unfiltered card set to the board"*; `getFullStateMessages:1080-1085` — *"project filter stays client-side (pass null), only repoScope is a backend concern"*. `_refreshBoardImpl:3377-3381` passes `this._projectFilter`. Three siblings, one dissenter, no comment justifying the difference.
- `refreshWithData:1931-1936` already carries a workaround for a filtered set: when `filterActive`, it issues a **second, unfiltered** `db.getBoard(workspaceId)` purely so column occupancy isn't computed from a project-filtered set (*"Column occupancy must be computed from the full workspace (not filtered by project/repo)"*). Note **which** function this is (see the correction under *Implementation Steps* step 2): `refreshWithData` is fed by the already-migrated **primary** path, so its project-half is *already* redundant today — evidence that the codebase has been carrying the cost of a filtered card set it no longer produces on that path.

**Cross-client corollary (same root cause, additional blast radius):** because `updateBoard` is broadcast to every client, a refresh scoped to client A's `_projectFilter` **overwrites client B's `allCards` with A's project's cards**. B's board then renders whatever the intersection of A's project and B's filter happens to be — usually nothing. Client-local view independence is therefore *not* actually achieved today; it only appears to be whenever the primary path happens to win the race.

**Second corollary — silent empty prompts:** `this._lastCards = cards` (`:1945`, `:3509`, `:3685`) inherits the same server-filtered set. `chatCopyPrompt` (`:8928`) resolves the user's selection with `this._lastCards.filter(...)` and has **no DB fallback** — if the selected cards aren't in `_lastCards` (because the other client's project filtered them out), `chatPlans` is silently `[]` and the user copies a prompt containing zero plans. `promptSelected` (`:8973-8981`) survives this only because it falls back to `_buildCardsFromDbSessionIds`.

## Metadata
- **Tags:** bugfix, refactor, reliability, backend, ui
- **Complexity:** 9
- **Project:** browser-switchboard
- **Release phase:** Piece 3 of 3 in the browser/extension view-independence set. **Independent of pieces 1 and 2** (different provider, different mechanism) — can ship in any order. Within its own feature (*Cross-Client Project Scope Independence*) it is subtask 1 of 2 and **must merge before** `per-connection-scoped-push-rendering.md`.

> **Superseded:** **Tags:** bugfix, architecture, kanban, browser, cross-host, data-integrity
> **Reason:** `architecture`, `kanban`, `browser`, `cross-host`, and `data-integrity` are not in the allowed tag vocabulary; invented tags are dropped or pollute the tag index.
> **Replaced with:** `bugfix, refactor, reliability, backend, ui` — the nearest allowed equivalents.

> **Superseded:** **Complexity:** 5 *("reflects the unknown diagnostic work, not the size of the edits")*
> **Reason:** The justification for 5 was diagnostic uncertainty, which is now resolved — that argues *down*. But the read-site sweep found four authoring sites rather than two, bug 2's real fix is architectural rather than a call-site tweak, and the bug-3 fix changes the payload of a message consumed by 35 call sites plus `_lastCards` and dynamic-column derivation. Multi-file coordination with shipped-install blast radius scores 7.
> **Replaced with:** **Complexity:** 9. The user selected option C1 for bug 2 and asked for the most comprehensive fix available, which adds a third and fourth deliverable: four scoped accessors, a cache that must be re-keyed, and the behaviour-causing decision reads. 9 rather than 10 because the architectural remainder (per-connection push rendering) is explicitly deferred to a successor plan rather than attempted here.

> **Superseded:** *(No `**Project:**` line: no PROJECT PIN directive was supplied and the user named no project.)*
> **Reason:** The project is determinable without asking: this plan's feature is governed by `.switchboard/projects/browser-switchboard/prd.md`, and its sibling subtask already carries `**Project:** browser-switchboard`. Two subtasks of one feature disagreeing on their pin is exactly the kind of drift this pass exists to remove.
> **Replaced with:** `**Project:** browser-switchboard` in Metadata. **This is documentation, not a state change** — the plan is already imported (`PLAN_ID=c0de3d94-827a-4875-bb4d-0d7f5d3ca5db`) and the pin resolves once, at first import, so the line is a no-op against the board. To actually move an imported plan between projects, use the board or its local API.

## User Review Required

- **None.** Every open question is decided.

Decisions on record:

- **Bug 2 → option C1, selected by the user.** Effective settings resolve per-initiating-client. Project-override settings do **not** become workspace-global. The Proposed Changes below implement C1; the earlier C2 recommendation is withdrawn.
  - Scope boundary inside C1: the four scoped accessors and the prompt-overrides cache go per-initiator; the six `_reloadSettingsFromStore` cached fields stay workspace-scoped (75 read sites, board-behaviour settings only — see *C1 surface*). This boundary is the difference between a ≈6 and a ≈9; it is a deliberate cut, not an oversight, and is stated in Scope.

Everything else that was previously flagged for review is also decided:

- **Where the authoring scope comes from → option (a), confirmed.** Client-initiated authoring verbs pass their `boardProjectFilter` in the message; the host prefers it and falls back to the DB row when absent. Option (b) — "write the row immediately before the action" — is a race by construction and still breaks with two clients. Option (a) is also the *only* mechanism actually available: `handleServiceVerb(verb, payload)` (`KanbanProvider.ts:7085`, `LocalApiServer.ts:127`) carries **no client identity**, so the payload is the sole channel through which an initiator can be identified. The pin becomes a client-supplied input, so the resolve-only import guard in `CLAUDE.md` (unknown pin → unassigned, never auto-create a `projects` row) remains the required backstop.
- **`kanban.activeProjectFilter` keeps tracking the last switch → confirmed.** Keep writing it exactly as today, so single-client behaviour and remote/DB-less reads are unchanged. It simply stops being authoritative for a *client-initiated* action.

## Scope

### ✅ IN SCOPE
1. **Fix the un-migrated card-source path** (proven bug 3): make `_refreshBoardImpl:3378-3381` pass `null` for the project argument, matching the two already-migrated paths, so every client receives the unfiltered card set its client-side filter assumes.

   > **Superseded:** "**Diagnose the 'switch didn't work' symptom** against the three candidates above, with both clients connected. Fix what is found; if it proves to be candidate 1, the correction is to narrow the re-seed conditions at `kanban.html:7207-7215`."
   > **Reason:** Root-caused during this pass; it is a fourth cause and the re-seed conditions are not implicated. See *Proven bug 3*.
   > **Replaced with:** The corrective item above.

2. **Per-initiator authoring scope** (proven bug 1): thread the initiating client's project filter through the **nine** client-initiated authoring sites (table above), preferring the client value and falling back to the shared default when absent.
3. **Per-initiator settings scope** (proven bug 2, option C1): add an optional initiator-project argument to the four scoped accessors (`getScopedRoleConfig`, `updateScopedRoleConfig`, `_getScopedSetting`, `_updateScopedSetting`) and their `KanbanServiceContext` seam members; thread the same argument into `TaskViewerProvider.exportPromptSettings` (`:919`), which resolves the tier itself and bypasses all four; re-key `TaskViewerProvider._cachedDefaultPromptOverrides` by project; stop broadcasting `overrideState` from `setProjectFilter` and return it in the response body instead.
4. **Per-initiator decision reads** (C1, comprehensive tier): thread the initiator project into the settings reads that *cause behaviour* rather than merely display — complexity→role routing (`:1273-1276`, via `_routingMapConfig`), effective drag-drop mode (`:5929`, via `_columnDragDropModes`), and **`generateUnifiedPrompt:4627`** (`routingMapConfig` baked into the generated dispatch prompt — reclassified out of the deferred floor, see the correction under *Proven bug 2*). Resolve them through the accessors with the initiator argument instead of reading the singleton cache.
5. **Regression tests for the misfiling bug, the filtered-cache bug, and the settings-swap bug** — the highest-value artifacts here, because all three failures are silent.

### ⚙️ OUT OF SCOPE
- Re-architecting `boardProjectFilter`. It already works; leave it as the client-local render filter.
- Removing or re-keying the `kanban.activeProjectFilter` DB row. It is **shipped state** read by remote agents, the plan watcher, and DB-less sessions; per the project's migration rule it must keep working unchanged for ~4,000 installs. This plan changes *what defers to it*, never its shape or presence.
- The `**Project:**` pin file format or the importer's resolve-only guard (`CLAUDE.md` backstop) — unchanged, and still the required safety net.
- Design panel work (pieces 1 and 2).
- Threading the two background/watcher stamp sites (`TaskViewerProvider.ts:15676`, `GlobalPlanWatcherService._handlePlanFile`). They have no initiator by construction.
- The three display-only `runSheets` project echoes (`TaskViewerProvider.ts:17512`, `:17523`, `:17578`). They stamp nothing; they become a per-connection concern in the successor plan.
- **Push-payload settings remain shared** — the eleven emit sites across three message types (`routingConfig` in `updateBoard` at `:1113`, `:2012`, `:3519`, `:3686`; `modes` in `updateColumnDragDropModes` at `:2055`, `:3546`, `:3705`; `enabled` in `cliTriggersState` at `:1112`, `:2021`, `:3522`, `:3687`) — **plus `overrideState`** from the refresh push cluster (`:2022`, `:3523`, `:3688`), which this pass identified as a fourth scope-dependent push type. These are server-initiated broadcasts with no initiator; fixing them requires per-connection payload rendering, which requires per-connection project state on `ConnectionMeta`. **This is the deliberate remainder** — a successor plan (*Per-connection client identity and scoped push rendering*), not a stage of this one, because the capability subsumes this plan's threading rather than extending it.

  Until it lands, the *displayed* routing config, drag-drop affordances, CLI-trigger toggle and "Active scope:" indicator follow the last client to switch (or the last refresh), while the *decisions* those settings drive are per-initiator (stage 4). **State this boundary in the override UI** — and state it accurately: it is not "the indicator is stale until you refresh", it is "the indicator can be rewritten by another client's refresh at any time". That is the honest description, and it is the thing the successor plan removes.
- **The remaining cached-field read sites** beyond the decision reads in stage 4. They are display or write-back paths already covered by threading the accessors.
- Introducing `AsyncLocalStorage` or any other implicit request-scoped context. Measurement showed the scoped call sites are shallow (arm level or one hop), so an explicit optional argument reaches all of them. An implicit context would add a bundling and propagation risk the code shape does not require.
- **Per-request field swapping** — setting `this._projectFilter` to the initiator's value for the duration of a request and restoring it afterwards. Verb dispatch is not serialised across clients, so two interleaved requests would corrupt each other's scope. This is the tempting shortcut; it is a race by construction and must not be used.

## Implementation Steps

> **Superseded:** "1. **Diagnostic pass first.** Reproduce with extension + browser both open; instrument `updateWorkspaceSelection` re-seeds, the dropdown rebuild ladder, and the snapshot early-out to determine which candidate fires. Do not write corrective code before this resolves."
> **Reason:** The diagnosis is complete (proven bug 3). Instrumenting three non-causes would consume the first implementation pass and find nothing.
> **Replaced with:** Step 1 below, which is corrective. The reproduction is retained — demoted from a blocking diagnostic to a *pre-fix confirmation* that takes minutes: with both clients open, force a refresh through a `_refreshBoard` call site, then switch project and observe the empty board.

1. **Fix the un-migrated path.** `KanbanProvider.ts:3378-3381` → pass `null` as the project argument. Then delete the now-dead `const projectFilter = this._projectFilter;` at `:3377` if nothing else in scope uses it. Leave the `_projectFilter` **read-back and validation** block at `:3340-3376` intact — it is what keeps the in-memory value and the DB row converged for the authoring paths, and is independent of card sourcing.

   > **Superseded:** "…and the dead `projectFilter` local at `TaskViewerProvider.ts:17432`."
   > **Reason:** That local is **live**, not dead — `filterByProjectScope` (`:17481`) reads it at `:17480` and `:17490` to filter the sidebar's run-sheet rows (`:17494-17498`). Deleting it breaks sidebar project filtering. See the correction under *Proven bug 3*.
   > **Replaced with:** Nothing — `TaskViewerProvider.ts:17432` is untouched by this plan.

2. **Re-check the occupancy workaround.** Narrow `filterActive` at `refreshWithData:1931` to `!!this._repoScopeFilter` rather than deleting the second query — `repoScope` still filters `activeRows`, so the unfiltered `db.getBoard()` stays load-bearing for that case.

   > **Superseded:** "With `activeRows` unfiltered, the `filterActive` second query at `refreshWithData:1931-1936` **becomes** redundant for the project case."
   > **Reason:** Wrong causal chain, and it points the implementer at the wrong function. `refreshWithData` is **not** fed by `_refreshBoardImpl` — it is called from `TaskViewerProvider._refreshRunSheetsImpl:17457`, which is the **already-migrated** primary path that passes `null` today. So the project half of `filterActive` is *already* redundant, before step 1 changes anything. Told it "becomes" redundant, an implementer verifying the claim would look for the dependency on step 1, fail to find one, and reasonably conclude the plan had confused two functions.
   > **Replaced with:** The corrected step above. Practical consequence: **step 2 is independent of step 1** and can be done, tested, and shipped on its own. Sequencing them is a convenience, not a requirement.

3. **Thread the initiator project.** Add an optional `initiatorProject?: string | null` to the payloads of the client-initiated authoring verbs covering all **nine** sites, and resolve it with an explicit precedence helper (below). Send `boardProjectFilter` from `kanban.html` (and the corresponding panel's own view filter for the Planning/TaskViewer sites) on those verbs. Note `KanbanProvider.copyGeneralChatPrompt` (`:1209`) **already accepts a `projectName?` parameter** that short-circuits its DB read — for that site the work is to route the initiator value into the existing parameter and then re-express its fallback through the resolver, not to add a new one.
4. **Thread the initiator project through the scoped accessors (C1).** Add an optional trailing `initiatorProject?: string | null` to `getScopedRoleConfig`, `updateScopedRoleConfig`, `_getScopedSetting`, `_updateScopedSetting`, and to the four matching `KanbanServiceContext` members. Resolve it with the *same* `resolveAuthoringProject` helper from step 3 so authoring scope and settings scope can never disagree. Omitted argument → today's singleton behaviour, exactly.
5. **Re-key the prompt-overrides cache.** `TaskViewerProvider._cachedDefaultPromptOverrides` becomes `Map<string, Overrides>` keyed by resolved project (with a sentinel key for "no project"); `refreshPromptOverridesCache(project?)` rebuilds one entry rather than the whole field. Without this, step 4 is defeated at the last hop.
6. **Return override state instead of broadcasting it** for the `setProjectFilter` verb; keep the broadcast on the genuine global toggles (`setWorkspaceOverride` `:8158`, `setProjectOverride` `:8170`, `:8193`), which are workspace-wide by definition. **Leave the three refresh-cluster emitters (`:2022`, `:3523`, `:3688`) alone** — they have no initiator and are handed to the successor plan as a fourth scoped push type. Do not attempt to suppress them: suppressing them would leave every client's override indicator permanently stale instead of transiently wrong, which is worse.
7. **Thread the three decision reads.** `_resolveRoleForComplexity`-style routing at `:1273-1276`, `_effectiveDragDropMode` at `:5929`, and `generateUnifiedPrompt:4627` resolve `routingMapConfig` / `columnDragDropModes` through the accessors with the initiator argument rather than reading the singleton cache. Leave every display/push read on the cache — see the floor in *Proven bug 2*.
8. **Thread `exportPromptSettings`.** `TaskViewerProvider:919-921` resolves the project tier inline off the DB, bypassing all four accessors. Replace its hand-rolled predicate with `_projectTier(initiatorProject)` so the export reflects the exporting client's project.
9. **Add the regression tests below.**

### Staging and gates

The plan is **not** split into separate plan files (see the recommendation at the end), but it is ordered, and each stage is independently verifiable. Do not begin a stage until the previous stage's tests are green.

| Stage | Steps | Gate |
|---|---|---|
| **1 — Unfiltered card set** | 1–2 | Test 1. Board renders correctly on project switch with both clients open. Independently shippable; ship it before continuing if you want the user-facing fix out early. (Step 2 is independently shippable *within* the stage — it does not depend on step 1.) |
| **2 — Authoring scope** | 3 | Tests 2–6, 8, 14. Lands the shared `resolveAuthoringProject` helper that stage 3 reuses. **All nine sites, or the stage is not done** — test 14 enumerates them. |
| **3 — Settings scope (C1 core)** | 4–6, 8 | Tests 9–11, 15. The cache re-key (step 5) is part of this gate, not a follow-up. |
| **4 — Decision reads** | 7 | Tests 12–13, 16. Smallest stage; deliberately last so a surprise here cannot block stages 1–3. |

## Complexity Audit

### Routine
- Threading one optional field into four authoring call sites behind a single resolver helper.
- Changing one query argument to `null` to match two sibling paths that already do it.
- Deleting two dead locals.

### Complex / Risky

> **Superseded:** "**The diagnostic step is genuinely unknown work** — the symptom is reported but not reproduced. Complexity 5 reflects that, not the size of the edits. If diagnosis shows a fourth cause, re-scope rather than forcing a fit."
> **Reason:** Diagnosis found exactly the fourth cause that clause anticipated. Its instruction — *re-scope rather than force a fit* — has been followed in this revision.
> **Replaced with:** The risks below, which are about blast radius rather than uncertainty.

- **`_refreshBoardImpl` feeds 35 `this._refreshBoard(...)` call sites plus `_lastCards`.** Widening its card set changes (i) what the board renders before the client filter runs, (ii) `_lastCards`, read by ~18 selection/dispatch handlers, and (iii) `_filterDynamicColumns(columns, visibleAgents, allCards)`, which decides which dynamic columns are visible. The already-migrated primary path proves the wider set is tolerated in production, but that path is not the one hydrating `_lastCards` after every `_refreshBoard` call — this change makes both paths agree, and *agreeing on the wider set* is the deliberate choice.
- **Payload growth on large boards.** Every refresh now ships all projects' cards. Same volume the primary refresh path and WS resync already send, so no new worst case — but the frequency changes, and the snapshot early-out (`:2003-2012`) will fire *less* often because the hash now varies with any project's cards, not just the active one. Measure before assuming this is free.
- **Proven bug 1's fix touches plan project pinning**, which `CLAUDE.md` treats as a protocol with a non-negotiable import guard. Getting it wrong misfiles plans — the same class of bug, differently caused. The resolve-only importer backstop must remain intact and must be asserted by test.
- **Shipped-state sensitivity:** the DB row must keep being written and readable for older installs and remote agents.
- **A client-supplied project name is now an authoring input.** Validation is the existing resolve-only guard; no project-creation path may be added.
- **C1's boundary is the risk, not C1's mechanism.** The threading itself is mechanical and shallow. The danger is a *partial* C1: thread the four accessors but leave `_cachedDefaultPromptOverrides` unkeyed, and prompt overrides still resolve from the other client's project while every test that checks role configs passes. The cache re-key (step 5) and its test are not optional polish — they are the difference between C1 working and C1 looking like it works.
- **The six excluded cached fields are a visible behaviour boundary.** After C1, role configs and prompt overrides follow the initiating client while drag-drop modes and routing thresholds follow the workspace. That is coherent but not self-evident; it must be stated in the override UI, or it becomes the next bug report.
- **The authoring site list has been wrong twice.** Two → four → nine, each time discovered by widening the sweep rather than by a failing test. The pattern is consistent: sweeps scoped to one symbol (`kanban.activeProjectFilter`) miss the other (`getProjectFilter()`), sweeps scoped to `KanbanProvider.ts` miss `TaskViewerProvider.ts`, and sweeps that find one importer miss its sibling sixty-six lines below. **Treat the nine-row table as a floor, not a ceiling** — before closing stage 2, re-run both greps across `src/` and diff against the table. Test 14 exists to make the next omission red rather than silent.
- **One read bypasses the abstraction being introduced.** `exportPromptSettings:919` reimplements the project-tier predicate inline off the DB. Centralising a predicate does nothing about the copies that never called the function; the C1 surface table measured *callers of the accessors*, which is exactly the sweep shape that cannot see a reimplementation.
- **Step 6 is only half a fix by construction, and that is now explicit.** The `overrideState` broadcast has seven emitters; this plan removes one and hands three to the successor. Test 17 pins the remainder. The failure mode to guard against is an implementer seeing test 7 pass and reporting bug 2 as closed.

## Edge-Case & Dependency Audit

- **Race conditions:** the current design *is* the race (last-writer-wins on a shared row, read at prompt-generation time). Option (a) removes it for client-initiated actions by making the scope travel with the request instead of being read from global state later. A residual, accepted race remains for the two background stamp sites, which have no initiator and must use the shared default.
- **Ordering race inside `setProjectFilter`:** the in-memory `_projectFilter` is assigned before the awaited DB write (`:6540` vs `:6551`), so the four authoring sites currently disagree about which value they see for the duration of that await. Threading the initiator value past both makes the window irrelevant for client-initiated actions; do not "fix" it by reordering, which would just move the window.
- **Migration / shipped state:** `kanban.activeProjectFilter` keeps its key, shape, and population behavior — no migration needed, and no-op for single-client users. Confirm an install that never opens the browser board sees byte-identical behavior.
- **DB-less / remote sessions:** must keep working off the DB row alone (they have no client filter to send). The fallback is what preserves them — do not make the client value mandatory.
- **Single-client invariance:** with only the extension open, every path must behave exactly as today *except* that the board now receives the unfiltered card set — which is already true whenever the primary refresh path wins. This is the primary regression risk of the change and is what test 3 below pins.
- **Empty-string vs `'__unassigned__'` vs `null`:** three distinct sentinels are in play — `boardProjectFilter` uses `null` (no filter) / `'__unassigned__'` / name; `_projectFilter` never uses `null`; the DB row stores `''` for unassigned (`:6549`). The resolver must normalise all three explicitly rather than relying on falsiness, or "no filter" will be indistinguishable from "unassigned" and unassigned plans will be pinned to nothing silently.
- **Security:** a client-supplied project name becomes an input to plan authoring. It is a *name*, resolved by the existing resolve-only importer guard, which must continue to refuse unknown pins and never auto-create a `projects` row (`CLAUDE.md` backstop). Do not add a project-creation path here. Per PRD contract #5, the new `initiatorProject` field must be added to the affected verbs' schemas in `verbSchemas.ts` as an **optional** string — a required field there would reject valid existing webview payloads on shipped installs.
- **PRD contract #4 (return-in-body):** the `setProjectFilter` arm currently returns a bare `{ success: true }`. Returning the override state satisfies both this plan's bug-2 fix and the standing contract in one change.
- **No confirmation dialogs** are added anywhere (project rule).

## Dependencies

- None. This plan is independent of pieces 1 and 2 of the browser/extension view-independence set (different provider, different mechanism) and can ship in any order.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is blast radius, not uncertainty: widening `_refreshBoardImpl`'s card set changes what 35 call sites push and what `_lastCards` holds for ~18 selection handlers, so the single highest-value guard is a test pinning that `_lastCards` and `updateBoard` carry all projects' cards regardless of `_projectFilter`. The second risk is partial-fix theatre, and this pass proved it is not hypothetical — it is the plan's own recurring failure mode. Bug 1 is only fixed if **all nine** authoring sites are threaded, and the list has been wrong twice (two, then four, now nine); the omissions were always siblings of sites already found — the ClickUp importer sixty-six lines below the Linear one, `copyGeneralChatPrompt` next to `chatCopyPrompt` — so "we swept for it" is demonstrably not sufficient evidence here. Bug 2's C1 is only fixed if the four scoped accessors, the unkeyed `_cachedDefaultPromptOverrides`, **and** the accessor-bypassing `exportPromptSettings:919` are all handled; threading the accessors alone leaves prompt overrides resolving from the other client's project while every role-config test passes. And bug 2's `overrideState` half is now known to be only partially deliverable here at all — three refresh-cluster emitters re-broadcast the singleton on every refresh and are handed to the successor, so "test 7 is green" must not be read as "bug 2 is closed."

Mitigations: land bug 3 first as an independently shippable fix with its own test; route authoring scope, settings scope, and decision reads through **one** shared precedence helper so a missed site is a compile error rather than a silent misfile; make the site list *enumerated by a test* (test 14) rather than asserted by a sweep; treat the cache re-key and its test as part of C1 rather than polish; keep the no-argument path byte-identical so DB-less, watcher, and single-client flows are untouched; and pin both the intended remainder (tests 13, 17) and the resolve-only import guard so the boundary of this plan is a tested contract rather than a claim in prose.

## Proposed Changes

### `src/services/KanbanProvider.ts` — `_refreshBoardImpl` (`:3377-3381`)

- **Context.** The only un-migrated card-source path. `_projectFilter` is never `null`, so the ternary always takes the server-filtering branch.
- **Logic.** Pass `null` for the project argument, matching `TaskViewerProvider:17441-17445` and `getFullStateMessages:1080-1085`. `repoScope` remains the only backend scoping concern.
- **Implementation.**
  ```ts
  // Project filtering is client-side (boardProjectFilter in kanban.html); the
  // board caches the unfiltered set and filters locally so two clients never
  // reset each other. Only repoScope is a backend scoping concern. Matches
  // TaskViewerProvider._refreshRunSheetsImpl and getFullStateMessages.
  const repoScope = this._repoScopeFilter;
  const dbRows = repoScope
      ? await db.getBoardFilteredByProject(workspaceId, null, repoScope)
      : await db.getBoard(workspaceId);
  ```
- **Edge cases.** Do **not** touch the `_projectFilter` read-back/validation block above it (`:3340-3376`) — it keeps the in-memory value and DB row converged for authoring, and deleting it would reintroduce the startup seed window it was written to close. `completedRows` must be sourced the same way for consistency; verify whether this path also pre-filters completed plans and align it.

### `src/services/KanbanProvider.ts` — `refreshWithData` occupancy workaround (`:1931-1936`)

- **Context.** `filterActive` triggers a second, unfiltered `db.getBoard()` solely so hidden-column occupancy isn't computed from a project-filtered set.
- **Logic.** With the project filter gone from the source query, the project half of that condition is dead. Narrow, don't delete — `repoScope` still filters `activeRows`.
- **Implementation.** `const filterActive = !!this._repoScopeFilter;`
- **Edge cases.** Confirm no other consumer of `allActiveRowsFiltered` depended on it being a *superset* of the project-filtered set in a way that changes now that they're equal.

### New — initiator-project resolver (`src/services/KanbanProvider.ts`, near `getProjectFilter` at `:6391`)

- **Context.** Four sites need identical precedence; three sentinels are in play.
- **Logic.** Explicit precedence: client-supplied value → persisted DB row → in-memory singleton → unassigned. Normalise `null`, `''`, and `'__unassigned__'` to a single "no project" result so unassigned is never confused with "no filter".
- **Implementation.**
  ```ts
  /**
   * Resolve the project an authoring action should file under.
   * `initiatorProject` is the initiating client's own view filter, sent in the
   * verb payload — the ONLY per-client signal available (handleServiceVerb
   * carries no client identity). Falls back to the shared workspace default so
   * DB-less/remote callers and watcher-driven imports are unchanged.
   * Returns undefined for "no project" (all three sentinels collapse here).
   */
  public async resolveAuthoringProject(
      workspaceRoot: string,
      initiatorProject?: string | null
  ): Promise<string | undefined> {
      const norm = (v: string | null | undefined) =>
          (!v || v === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) ? undefined : v;
      if (initiatorProject !== undefined) return norm(initiatorProject);
      try {
          const row = await this._getKanbanDb(workspaceRoot).getConfig('kanban.activeProjectFilter');
          if (norm(row)) return norm(row);
      } catch { /* fall through to the in-memory value */ }
      return norm(this._projectFilter);
  }
  ```
- **Edge cases.** `initiatorProject !== undefined` — not truthiness. A client explicitly on "unassigned" must file unassigned, not silently inherit the shared row. This distinction is the whole point of the field and is the most likely thing to be implemented wrong.

### `src/services/KanbanProvider.ts` — `chatCopyPrompt` (`:8943-8945`), `copyGeneralChatPrompt` (`:1214`) and `createFeatureFromPlanIds` (`:11878`)

- **Context.** All three read the DB row directly today. `chatCopyPrompt` and `copyGeneralChatPrompt` are twins — both build `manifestProject` and hand it to `buildKanbanBatchPrompt('chat', …)`; the first was in the original table, the second was missed.
- **Logic.** Replace the direct reads with `resolveAuthoringProject(workspaceRoot, msg.initiatorProject)`.
- **Implementation.** At `:8944`, `manifestProject` becomes the resolver's return value directly (it is already `string | undefined` with the same unassigned semantics). At `:1214`, `copyGeneralChatPrompt(workspaceRootInput?, projectName?)` **already has the initiator channel** — its `if (!resolvedProject) { …DB read… }` fallback becomes `resolvedProject ?? await resolveAuthoringProject(workspaceRoot, initiatorProject)`; the caller supplies the board's filter. At `:11878`, keep the "subtasks win" precedence above it untouched — the resolver only supplies the fallback for a feature whose subtasks carry no project.
- **Edge cases.**
  - **The verb is `createFeature` (arm at `:10731`), not `createFeatureFromPlanIds`** — the latter is the method. Schema and payload work targets `createFeature`. `createFeatureFromPlanIds` additionally has **internal** callers with no initiator — `splitFeature` (`:12159`, `:12163`) and the reconcile path (`:12352`) — plus `create-feature.js` / the HTTP plan-create route. Every one of those must pass `undefined` and behave exactly as today. Adding a *required* parameter here would be a silent behaviour change across five internal call sites; the parameter must be optional and trailing.
  - `chatCopyPrompt`'s `_lastCards.filter` at `:8928` should gain the same `_buildCardsFromDbSessionIds` fallback `promptSelected` has at `:8974-8981`, so a selection that predates the current card set yields a real prompt instead of a silent empty one.

### `src/services/PlanningPanelProvider.ts` — `createPlansPasteBack` (`:3411`)

- **Context.** Reads the in-memory singleton to pin a pasted plan.
- **Logic.** Same resolver, with the panel's own initiator value.
- **Implementation.** `const cpProject = await this._kanbanProvider?.resolveAuthoringProject(root, msg.initiatorProject) ?? null;`
- **Edge cases.** Preserve the existing "on any failure to read the filter the plan lands unassigned (never invent a project)" behaviour — the resolver's `catch` must not throw out.

### `src/services/TaskViewerProvider.ts` — five authoring sites (`:6696`, `:6762`, `:8771`, `:11997`, `:18837`) and one scoped read (`:919`)

- **Context.** Five client-initiated authoring sites live in this file, not one. Two are ticket importers, one is a draft-plan creator, one is the memo planner prompt, one is the orchestrator kickoff prompt. A sixth site (`:919`) is a settings-scope read that bypasses the accessors.
- **Logic.** Route every one through `resolveAuthoringProject` (or `_projectTier` for `:919`), with the panel's own initiator value.
- **Implementation.**
  - `:6696` (**Linear** import) and `:6762` (**ClickUp** import) — identical shape, identical fix. Both are `const projectFilter = this._kanbanProvider?.getProjectFilter() ?? null;` feeding `_createImportedLinearPlan` / `_createInitiatedPlan`. Change **both in the same edit**; they are sixty-six lines apart and the whole point of this correction is that a sweep found one and missed the other.
  - `:18837` (`createDraftPlanTicket`) — the `if (activeProject && activeProject !== UNASSIGNED)` block becomes `projectName = await resolveAuthoringProject(root, initiatorProject)`. Its current logic already collapses `'__unassigned__'` to `undefined`, which the resolver reproduces exactly.
  - `:11997` (memo arm) — `projectName` feeds `_buildMemoPlannerPrompt`, which writes the PROJECT PIN the planner agent then stamps into every memo-derived plan. Same class as `chatCopyPrompt`; same fix.
  - `:8771` (orchestrator kickoff) — injects the active project filter into the persona prompt. Resolve from the initiator so an orchestrator started from the browser board does not inherit the editor's project.
  - `:919` (`exportPromptSettings`, fn at `:873`) — replace the inline `projectOverrideOn && activeProject && activeProject !== UNASSIGNED` predicate with `this._kanbanProvider?._projectTier(initiatorProject)` (exposed as needed). This is step 8.
- **Edge cases.**
  - **`:17432` is NOT a dead local — leave it.** It is read at `:17480` and `:17490` by `filterByProjectScope` (`:17481`) to filter sidebar rows. See the superseded block under *Proven bug 3*.
  - Leave `:15676` (brain auto-claim) and `:17512` / `:17523` / `:17578` (`runSheets` pushes, display-only) alone — none is a client-initiated authoring action.
  - `:8771` and `:11997` both wrap their read in `try { … } catch { /* best-effort */ }`. Preserve that: the resolver must not turn a best-effort read into a throwing one.

### `src/services/KanbanProvider.ts` — the four scoped accessors (C1 core)

- **Context.** `getScopedRoleConfig` (`:545`), `updateScopedRoleConfig` (`:575`), `_getScopedSetting` (`:627`), `_updateScopedSetting` (`:665`) each select the project tier with the same live-read predicate: `this._projectOverrideEnabled && this._projectFilter && this._projectFilter !== UNASSIGNED_PROJECT_FILTER`. That predicate is the single point where the singleton leaks into per-client behaviour.
- **Logic.** Add an optional trailing `initiatorProject?: string | null` to all four and replace the predicate with one shared helper. Argument omitted → identical behaviour to today (this is what preserves single-client and background paths).
- **Implementation.**
  ```ts
  /** The project tier to resolve against, or undefined for "no project tier".
   *  `initiatorProject` is the initiating client's own view filter; omitted means
   *  no initiator (watcher, remote, or single-client path) → fall back to the
   *  shared singleton, i.e. today's behaviour byte-for-byte. */
  private _projectTier(initiatorProject?: string | null): string | undefined {
      if (!this._projectOverrideEnabled) return undefined;
      const raw = initiatorProject !== undefined ? initiatorProject : this._projectFilter;
      return (!raw || raw === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) ? undefined : raw;
  }
  ```
  Each accessor then reads `const tier = this._projectTier(initiatorProject);` and uses `if (tier) { … db.getProjectConfigJsonSync(tier, key, …) }`. Mirror the same four signatures onto `KanbanServiceContext` (`kanbanService.ts:42`) and their wiring at `KanbanProvider.ts:6975-6978`.
- **Edge cases.** `initiatorProject !== undefined`, never truthiness — a client explicitly on Unassigned must get *no project tier*, not the shared singleton's project. This is the identical trap called out for `resolveAuthoringProject`, and both helpers must be tested for it. Do **not** change the workspace/global tiers below the project tier; they are unaffected by C1.

### `src/services/KanbanProvider.ts` — `_reloadSettingsFromStore` (`:751-763`) and the six cached fields

- **Context.** These six fields are singleton caches read from 75 sites; they are explicitly out of C1's per-initiator remit.
- **Logic.** Leave them workspace-scoped and leave the loader calling the accessors with no initiator argument — which now resolves to the singleton, exactly as today. No change required here; this section exists so the implementer does not "helpfully" thread them and triple the diff.
- **Edge cases.** `setProjectFilter` currently calls `_reloadSettingsFromStore()` when override is on (`:6560-6562`). Under C1 that reload is still correct *for these six workspace-scoped fields*, so keep it. It is no longer load-bearing for role configs or prompt overrides, which now resolve per-initiator on demand.

### `src/services/TaskViewerProvider.ts` — `_cachedDefaultPromptOverrides` (`:854`) and `refreshPromptOverridesCache` (`:850`)

- **Context.** One unkeyed field caching the resolved prompt overrides for "the current scope". This is the last hop before prompt assembly and the single most likely place for C1 to silently fail.
- **Logic.** Convert to a project-keyed map; make the refresh and the read both take the resolved project.
- **Implementation.** `private _cachedDefaultPromptOverrides = new Map<string, Overrides>();` keyed by the resolved project name or a `' none'` sentinel. `refreshPromptOverridesCache(project?: string | null)` rebuilds one entry; callers that mean "everything changed" (`setWorkspaceOverride`, `setProjectOverride`, `saveRoleConfig`) clear the whole map. `_readRoleConfigScoped` (`:867`) gains the same optional argument and forwards it to `getScopedRoleConfig`.
- **Edge cases.** Unbounded growth is not a concern (one entry per project, bounded by the projects table), but the map **must** be cleared on workspace switch alongside the other per-workspace caches, or a stale project's overrides survive into the next workspace.

### `src/services/KanbanProvider.ts` — `setProjectFilter` verb arm (`:7582-7597`) and `_postOverrideState` (`:6437-6455`)

- **Context.** The arm returns a bare `{ success: true }`; `setProjectFilter` broadcasts override state to all clients. Under C1 the override scope is per-client, so broadcasting it is wrong.
- **Logic.** Have the arm **return** the override state rather than push it (PRD contract #4). Keep `_postOverrideState()`'s broadcast for `setWorkspaceOverride` / `setProjectOverride`, which flip a workspace-level DB flag and are genuinely global.
- **Implementation.** Extract the payload construction from `_postOverrideState` into a pure `_buildOverrideState(initiatorProject?: string | null)`; `_postOverrideState` becomes `this.postMessage(this._buildOverrideState())`; the `setProjectFilter` arm returns `{ success: true, overrideState: this._buildOverrideState(msg.initiatorProject) }`. `kanban.html` applies it from the response instead of waiting for the push.
- **Edge cases.** The webview currently only ever *receives* `overrideState`; it must now also apply it from a verb response. Do not remove the message handler at `kanban.html:7602` — the toggle paths still use it. Note this is the **opposite** of what the withdrawn C2 option required; see the note under *Proven bug 2*.

### `src/webview/kanban.html` — dropdown change handler (`:8302-8340`) and authoring verb senders

- **Context.** The same-workspace branch already owns `boardProjectFilter` and posts `setProjectFilter` with `noRefresh: true`.
- **Logic.** Add `initiatorProject: boardProjectFilter` to the payload of each of the four authoring verbs sent from this webview. Apply the returned `overrideState` from the `setProjectFilter` response.
- **Edge cases.** Send `boardProjectFilter` verbatim, including `null` and `'__unassigned__'` — the resolver distinguishes them. Do not coerce to `''`.

### `src/services/verbSchemas.ts`

- **Context.** PRD contract #5 — the HTTP boundary validates every verb payload. **Measured reality:** of the affected verbs, only **`createFeature`** has a schema today. `setProjectFilter`, `chatCopyPrompt`, and `createPlansPasteBack` have **none** — and the file's own contract (`:9-11`) is that *"A verb WITHOUT a schema passes through unvalidated"*.
- **Logic.** Add `initiatorProject: { type: 'string' }` (optional) to `createFeature`'s existing schema. For the schema-less verbs, adding the field **creates a schema where none existed**, which is a small but real behaviour change: `validateVerbPayload` (`:49`) begins enforcing `payload must be a JSON object` for that verb even though only `initiatorProject` is declared.
- **Edge cases.**
  - **Optional, never required** — a required field rejects valid payloads from shipped webview builds.
  - **`null` is safe.** The validator short-circuits on `value === undefined || value === null` and `continue`s for a non-required field (`:64-69`), so declaring `type: 'string'` still accepts an explicit `null`. This matters: `boardProjectFilter` is legitimately `null` and the resolver's whole contract is `!== undefined`-not-truthiness. **Do not** work around a non-existent null rejection by coercing to `''` in the webview — that would collapse "no filter" into "unassigned" and defeat the resolver.
  - Undeclared fields pass through (`:15-17`), so no existing payload is newly rejected by the added field itself.
  - Serialise edits to this file per the PRD's orchestration discipline — the successor plan also appends here (`setPushScope`).

## Verification Plan

*(Session directive: no compilation or test execution during this planning pass. The following are specifications for the implementer.)*

### Automated Tests

Home: `src/test/kanban-persistence.test.ts` (already exercises `getProjectFilter` and project persistence).

1. **Unfiltered card set (bug 3, highest value).** With `_projectFilter = 'X'` and plans in projects X and Y, drive `_refreshBoardImpl` and assert the pushed `updateBoard.cards` **and** `_lastCards` contain **both** projects' cards. This is the test that would have caught the original symptom.
2. **Misfiling regression (bug 1, highest value).** Browser board on project X, extension on project Y; invoke `chatCopyPrompt` with `initiatorProject: 'Y'` → the PROJECT PIN resolves to **Y**, not X. Repeat for `createFeatureFromPlanIds` (blank feature, no subtask project), `createPlansPasteBack`, and the Linear import site.
3. **Single-client invariance.** With no `initiatorProject` supplied, all four sites resolve identically to today's behaviour (guards the ~4,000-install path).
4. **Explicit-unassigned is not "no signal".** `initiatorProject: '__unassigned__'` files unassigned even when the DB row names a project — asserts the `!== undefined` precedence rather than truthiness.
5. **DB-less / remote caller.** No client filter supplied → the pin still resolves from `kanban.activeProjectFilter`.
6. **Importer guard intact.** An unknown pin leaves the plan unassigned and creates no `projects` row.
7. **Override state is not broadcast on a project switch.** `setProjectFilter` returns `overrideState` in its body and emits no `overrideState` broadcast; `setProjectOverride` still broadcasts.
8. **`chatCopyPrompt` DB fallback.** Selected sessionIds absent from `_lastCards` still produce a prompt with the right plan count (not an empty prompt).
9. **Per-initiator settings (C1, highest value of the C1 set).** Project override ON, project X and Y each holding a *different* value for the same role config. Resolve with `initiatorProject: 'Y'` → Y's value; resolve with `initiatorProject: 'X'` → X's value; interleave the two calls and assert neither observes the other's tier. Repeat for `_getScopedSetting` and both write accessors (a write with `initiatorProject: 'Y'` must land in Y's `project_config`, never X's).
10. **Prompt-overrides cache is project-keyed (C1's silent-failure guard).** Warm the cache under project X, then resolve prompt overrides with `initiatorProject: 'Y'` → Y's overrides, not X's cached ones. Without this test a partial C1 passes tests 9 and still ships the bug.
11. **C1 no-argument invariance.** Every accessor called with the argument omitted returns byte-identical results to the pre-change implementation under both override-ON and override-OFF. This is the ~4,000-install guard for C1 and complements test 3.
12. **Decision reads are per-initiator (stage 4).** Project X and Y hold different `routingMapConfig` values. A complexity-routing decision initiated with `initiatorProject: 'Y'` resolves Y's role mapping while X's client is the last to have switched. Same for effective drag-drop mode at `:5929`.
13. **Push payloads stay shared — pinned deliberately.** `updateBoard.routingConfig`, `updateColumnDragDropModes.modes`, `cliTriggersState.enabled` and the refresh-cluster `overrideState` all reflect the workspace singleton, not the initiator. Asserted so the documented floor is a pinned contract rather than silent drift, and so the successor plan has a test to flip. *(Corrected from "`updateColumns[].dragDropMode`" — that message carries configured column specs, not the scoped override map; see the correction under Proven bug 2.)*
14. **All nine authoring sites are threaded — enumerated, not sampled.** A table-driven test that walks every site in the nine-row table and asserts each resolves to the supplied `initiatorProject` rather than the DB row. This test exists because the site list has now been wrong **twice** (two, then four, actually nine); an enumerating test converts the next omission into a red test instead of a silent misfile. Include `TaskViewerProvider:6762` (ClickUp) explicitly — it is the site a sweep is most likely to miss again.
15. **`exportPromptSettings` respects the initiator.** Project override ON, X and Y holding different role configs; export with `initiatorProject: 'Y'` while the DB row says X → the exported bundle contains Y's project configs. Guards the one scoped read that bypasses all four accessors.
16. **The generated prompt carries the initiator's routing map.** `generateUnifiedPrompt` invoked with `initiatorProject: 'Y'` embeds Y's `routingMapConfig` at `:4627`, not X's. This is the reclassified site — without this test it stays quietly in the deferred floor where the original revision put it.
17. **`overrideState` still broadcasts from the refresh cluster — pinned, not fixed.** Assert `:2022`/`:3523`/`:3688` continue to emit singleton-rendered `overrideState`. Deliberately pinning the *known remaining hole* so that (a) nobody "fixes" it by threading a non-existent initiator, and (b) the successor plan has an explicit contract to flip. Pair it with test 7 (which pins that `setProjectFilter` no longer broadcasts) — together they state exactly how far this plan gets.

### Manual

- Reproduce the original symptom before the fix: with both clients open, force a refresh through a `_refreshBoard` call site, then switch project in the extension and observe the empty board. Confirm it no longer occurs after step 1. **Record in Review Findings that the cause was the un-migrated `_refreshBoardImpl` query, not candidates 1–3.**
- Switch project in the browser, then in the extension; confirm each board renders its own filter and neither snaps back or blanks.
- Copy a plan prompt from the extension while the browser sits on a different project; confirm the created plan lands on the extension's project.
- With project override ON, switch project in the browser and confirm the extension's override toggles, hint text, and "Active scope:" indicator do not change **at the moment of the switch**. Then force a board refresh and confirm the indicator *does* get rewritten — that is the known remaining hole (test 17), not a regression. Record it as observed so the successor plan's manual pass has a before-state.
- With project override ON and the two clients on different projects, copy a prompt from each client and confirm each prompt was assembled from its own project's role config and prompt overrides.
- Import a **ClickUp** task from one client while the other sits on a different project; confirm the created plans land on the importing client's project. Repeat for a **Linear** issue. These two paths are byte-identical in code and must be verified separately anyway — the point of the check is that the implementer touched both.
- Create a draft plan (`createDraftPlanTicket`) and process a memo from one client while the other is on a different project; confirm both land on the initiating client's project.

## Uncertain Assumptions

None. Every assumption in this plan was resolved by reading the repository; no web research is required before implementation.

*(An earlier revision flagged `AsyncLocalStorage` semantics as an external unknown, on the assumption that C1 needed an implicit request-scoped context. Measuring the call sites disproved the premise — all scoped reads and writes are at arm level or one hop from it, so an explicit optional argument reaches every one. The uncertainty was removed with the mechanism that created it.)*

---

**Recommendation:** Complexity 9 → **Send to Lead Coder.**

### Do NOT split this plan

An earlier revision recommended splitting into three plan files. That recommendation is **withdrawn**, for three reasons:

1. **Splitting buys no parallelism.** All four stages touch `src/services/KanbanProvider.ts`. The PRD's orchestration discipline is explicit — *"One agent stream per provider file. Same-file parallel edits collide. Different provider files parallelise; the same file serialises."* Three plans against one file run sequentially anyway, so the split trades context continuity for nothing.
2. **The stages share their highest-risk surface.** Stages 2, 3 and 4 all resolve scope through the same `resolveAuthoringProject` / `_projectTier` precedence rule, whose `!== undefined`-not-truthiness contract is the single most likely thing to be implemented wrong. Two plans authoring two precedence helpers reintroduces the exact bug the plan exists to fix.
3. **Comprehensiveness was the stated goal.** One agent holding all four stages holds the whole model of how authoring scope, settings scope, and card sourcing interact. Three agents hold three partial models and re-derive the shared parts.

The de-risking the split was reaching for is delivered instead by the **staging gates** in *Implementation Steps* — ordered stages, each independently verifiable, stage 1 shippable on its own if the user wants the reported bug fixed early.

### Successor plan (required for full coverage)

**Per-connection client identity and scoped push rendering** (`.switchboard/plans/per-connection-scoped-push-rendering.md`). The one thing this plan provably cannot deliver: settings embedded in broadcast payloads cannot be made per-client by threading, because they have no initiator. That needs per-connection project state on `WsHub`'s existing `ConnectionMeta` (`wsHub.ts:41-44`, `:49`) and per-connection rendering in `BroadcastHub.push`. It **subsumes** this plan's `initiatorProject` threading for the push path rather than extending it, so it must follow — building it first would make this plan's threading dead code, and building it concurrently would collide on the same three files. Tests 13 and 17 pin the current shared behaviour so the successor has explicit contracts to flip.

**Hand-off — four message types, not three.** This pass identified a fourth scope-dependent push the successor plan did not originally list:

| Message | Scoped field | Emit sites | Status |
|---|---|---|---|
| `updateBoard` | `routingConfig` ← `_routingMapConfig` | `:1113`, `:2012`, `:3519`, `:3686` | in successor |
| `updateColumnDragDropModes` | `modes` ← `_columnDragDropModes` | `:2055`, `:3546`, `:3705` | in successor |
| `cliTriggersState` | `enabled` ← `_cliTriggersEnabled` | `:1112`, `:2021`, `:3522`, `:3687` | in successor |
| **`overrideState`** | `activeScope`, `activeProjectName`, `projectSwitchEnabled` ← `_projectFilter` | `:2022`, `:3523`, `:3688` (refresh cluster) | **added by this pass** |

Eleven emit sites for the first three, plus three for `overrideState`. The `overrideState` conversion is what makes *this* plan's step 6 actually hold end-to-end — until it lands, step 6 is correct but immediately overwritten by the next refresh. Note also that `_postOverrideState` (`:6437`) opens with `if (!this._panel) return;`, so it is currently a no-op for browser-only sessions; the successor must decide whether to relax that guard when routing through the broadcaster, or the per-connection render is dead code for exactly the clients the feature targets.

**Stage Complete:** PLAN REVIEWED
