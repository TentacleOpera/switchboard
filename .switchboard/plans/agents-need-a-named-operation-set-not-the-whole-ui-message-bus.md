# The CLI is a peer control surface — every board operation with terminal meaning is a named command, for agents and humans alike

## Goal

Make the CLI a peer control surface to the browser board: **every board operation with meaning outside the browser is a named CLI command**, with documented arguments and a known bridging status. The CLI is not a subset for agents. It serves a dispatched agent mid-task, a controller agent acting for the operator, and a human driving Switchboard from a terminal, a script or another tool who wants to forgo the browser entirely. The test for inclusion is not *who needs it* but *does it mean anything from a terminal* — asked two ways: what was the person doing when they pressed it, and could a script want it (the CLI has gestures the browser lacks: scheduling, piping, batch) — and where the browser affordance is a picker or a clipboard, the CLI substitutes an argument or stdout rather than dropping the operation. Not ten commands and a passthrough pointed at an internal transport.

### Problem Analysis

**The verb surface is not an API. It is a census of UI affordances.** `src/generated/verbAllowlist.ts` carries the header *"AUTO-GENERATED — do not edit… Source: protocol-catalog.json providers.<Name>.verbs[]"*. It enumerates every message a webview panel can post to the host, and it grows whenever someone adds a button. A sample of what is in it:

```
toggleCollapseCoders   renderMarkdownLive     listDesignFolders
stitchSaveApiKey       openTicketsPanel       createPlansDownloadZip
fileExists             toggleAllowUnknownComplexityAutoMove
```

Checkboxes, panel openers and a file-existence probe. **559 entries.** No agent wants them.

**Against that, the CLI names ten commands** — `plans`, `ready`, `dispatch`, `done`, `next`, `clear`, `fleet`, `verb`, plus setup/admin. Everything else is expected to go through `verb`.

**And `verb` is not the general escape hatch it appears to be.** Per `switchboard-api-escape-hatch-in-the-cli.md`: *"`cmdVerb` tries `POST /terminals/verb/<name>`, then falls back to `POST /kanban/verb/<name>`. Those are the only two routes it can reach."* Eleven plain REST paths the skills actually call — `/metadata/clickup`, `/task/linear/<id>`, `/comment`, `/diagram/generate`, `/worktree/cleanup` among them — are outside it entirely. The eight `kanban_operations/*.js` scripts are **not** the problem they were when `8aa2e928` was written: as of `96fb16df` (2026-09-03) all eight route through `.agents/skills/_lib/cli-call.js` → `execFile('switchboard api …')` → `apiRequest`, which attaches `Authorization: Bearer` (`cli.ts:561`). One transport, authenticated. Two scripts still carry a direct-DB fallback — `create-feature.js` and `get-state.js` `require` `out/services/KanbanDatabase` — which is `1946ee61`'s remit; `move-card.js` no longer does.

**So an agent has three bad options** and picks the worst one:

| option | why it fails |
| :-- | :-- |
| the ten named commands | cover single-card dispatch; no batch, no stage, no reorder, no report |
| `switchboard verb <name>` | must already know the name and payload; reaches only two routes; some targets are inert (see below) |
| raw `curl` | works, is what the protocol files demonstrate, sends no auth token |

Four files under `.agents/` still contain `curl -s -X POST`. A lead following its own instructions writes curl — observed 2026-09-03, a team head hand-rolling `ptySendPrompt` calls because that is the pattern in front of it.

**Discoverability material exists and reaches nobody.** `verbSchemas.ts` declares payload shapes for **277** verbs, with field names, types and required flags:

```ts
stageForQueue: {
    fields: {
        sessionIds:    { type: 'array',  required: true },
        workspaceRoot: { type: 'string' },
        missionId:     { type: 'string', required: false },
    },
},
```

The CLI cannot list verbs, cannot print a schema, and offers no filter. 277 documented payloads, zero of them reachable from a terminal.

**And a discovered verb still cannot be trusted.** `d63d77f9` establishes that 40 `switchboard.*` commands are unbridged on the standalone host: `executeCommand` warns once and returns `undefined`, while the calling arm returns `success: true`. `triggerBatchAgentFromKanban` and `batchDispatchLow` are both in that set — so the two batch verbs an agent would most want are exactly the ones that would report success and do nothing.

**Dumping the list is not the fix.** A `verb --list` of 559 entries hands an agent a larger haystack with no signal separating `dispatch` from `toggleCollapseCoders`. The gap is not that the transport is hidden; it is that no agent-facing *operation set* has ever been named.

### Root Cause

The CLI surface was defined by subtraction: ten commands were chosen deliberately, and everything else was left to a passthrough aimed at an internal UI transport. Nothing ever asked which board operations have meaning outside the browser, so the CLI never became a peer to the board — it stayed a convenience layer over a few reads and one dispatch. The consequence lands on everyone: agents fall back to curl, and a human who wants to run Switchboard from a terminal or another tool cannot, because forty operations exist only as buttons.

## Metadata

**Complexity:** 5
**Tags:** cli, agent-instructions, api, ux
**Project:** Browser Switchboard

## Proposed Changes

**0. The primary verb is `advance`, not `dispatch`.** Most of what an agent does to a card is *move it to the next column*; the column decides what happens. The primitive already exists — `KanbanProvider._advanceCards` — with a three-way `target` contract: `undefined` → compute the next pipeline stage; `'CODED_AUTO'` → complexity-route per card; a column id → move there unrouted. It owns filtering, routing, direction classification, the run-sheet write, cascade-id collection and the trigger gate.

It is also almost unreachable. Per `finish-advance-cards-extraction.md` (`af65df25`, PLAN REVIEWED, c8): *"`_advanceCards` has exactly two call sites, both gated on `CODED_AUTO`"*, and *"the specific-target branch and the `undefined` case have never executed."* Fifteen in-scope arms — `moveSelected`, `moveAll`, `moveCardForward`, `moveCardBackwards`, `sendDispatchToCoder`, `sendDispatchSetToCoders`, the non-`CODED_AUTO` halves of `triggerAction`/`triggerBatchAction`, `promptOnDrop` — open-code the same routine with three different trigger-gate rules between them. The CLI's `dispatch` command resolves a concrete column first and so takes the open-coded path too.

So the named set's core is one command, `switchboard advance <planId…> [--to <column>]`, backed by `_advanceCards` with `target: undefined` by default. Role-targeted dispatch (`seat`, explicit `--to`) is the exception for when the operator overrides the pipeline. **This plan depends on `af65df25`** — until the extraction lands, `advance` would be a sixteenth open-coded copy.

**1. Name the operation set.** Enumerate the board operations an agent legitimately performs and give each a CLI command with a real name, arguments and help text. The starting list, from what agents demonstrably reach for today:

| area | operations |
| :-- | :-- |
| read | `plans`, `ready`, `fleet`, `status` *(exist)* |
| dispatch | `dispatch` *(exists)*, **`batch`** (many plans, one gesture), **`seat`** (explicit target) |
| queue | **`stage`**, **`reorder`**, **`queue next`** |
| lifecycle | `done`, `next`, `clear` *(exist)*, **`complete`**, **`release`** |
| board | **`star`**, **`move`**, **`comment`** |
| team | **`report`** (write a seat report), **`team release`** |

Roughly twenty. Each maps to a route or verb that already exists; this is naming and argument parsing, not new capability.

**1b. One surface, organised by area — not tiers by caller.** The list above is the *card-workflow* area. It is not the whole surface, and it was wrong to frame the rest as "administration for a controller." A human at a terminal wants all of it. Grouped by area, with what backs each today:

| area | commands | backing today |
| :-- | :-- | :-- |
| cards | `advance`, `move`, `complete`, `uncomplete`, `star`, `comment`, `recover`, `archive` | verbs / routes, see change #0 |
| dispatch | `dispatch`, `batch`, `seat`, `stage`, `reorder`, `queue next / run` | as above |
| features | `feature create / delete / assign / remove / split / reconcile` | REST routes agents already use; wired on standalone |
| teams & seats | `team list / start / stop / release`, `seat add / rename / clear` | Kanban verbs; `addCoderTerminalFromKanban` **unbridged** (`d63d77f9`) |
| standing orders | `orders list / add / update / delete`, definitions likewise | `*StandingOrder*` verbs |
| agents | `agent save / delete / export-skill`, `group save / delete`, `startup get / set <role>` | `saveCustomAgent`, `saveAgentGroup`, `saveStartupCommands` (write side of `cfac05b8`) |
| worktrees | `worktree create [--feature \| --project] / abandon / cleanup` | `createWorktree*`, `abandonWorktree`, `cleanupWorktree` |
| projects & board | `project add / delete / assign`, `column save / delete`, `structure update / restore-defaults`, `routing update`, `setting get / set` | Kanban / Setup verbs |
| planning docs | `folder add / remove <kind> <path>`, `doc save / delete / import`, `constitution save`, `prd save` | Planning verbs; the browser's folder *picker* becomes a `<path>` argument |
| missions | `mission new / ready / launch / stop / add-member / remove-member`, `schedule new / start / stop` | the sixteen `mc*` verbs |
| memo | `memo load / save / clear` | TaskViewer verbs |
| prompts | `prompt <kind> [--for <plan>]` — **prints to stdout** | the 27 `copy*Prompt` verbs, minus the clipboard |
| integrations | `sync pause / resume`, `provider config …`, `notion setup` | Kanban / Setup / Tickets verbs |

**What genuinely stays out** is only what has no terminal meaning at all: webview lifecycle (`webviewReady`, `persistTabState`, `activeTabChanged`, `refresh*`), pure rendering (`renderMarkdownLive`, `serveAndOpenHtml`, `inspectRequestDataUrl`), panel focus (`open*Panel`, `focusTerminal`), and native dialogs whose *purpose* the CLI meets with an argument (`browse*`). Under this rule the exclusions are about twenty, not sixty — and every one is a browser mechanism, not an operation.

**The substitution rule, stated once so it is not re-decided per command:** a verb whose browser half is a *picker* takes a path or id argument; a verb whose browser half is the *clipboard* writes to stdout; a verb whose browser half is a *confirm dialog* takes `--yes` or refuses. The operation is kept; the affordance is translated.

**2. Mark each operation's bridging status, and refuse rather than lie.** Every named operation declares whether it is bridged on the current host. An operation whose underlying command is inert must **fail loudly** — not return success. Depends on `d63d77f9`'s `INERT`/`BRIDGED` registry; without it this plan can name operations but cannot promise they work.

**3. Discoverability lives on the docs site, not in the TUI.** `switchboard help` stays a short menu — no reorganisation, no tiers, no forty-line listing. The complete command reference is published at one URL on the public docs site, and the CLI links to it in three places: the `usage()` footer (`cli.ts:15`), the `about` banner beside the GitHub link (`:1042`, which today is the CLI's *only* URL), and every "unknown command" error. Anyone — agent or human — who lands in the CLI is one link from everything it can do.

**3a. The reference is generated, or it will rot.** The site already has a page that claims this — `docs/reference/settings-commands.md`, *"generated from the shipped extension manifest"* — and **no script in either repo produces it**. It was generated once and drifts by hand, which is the `375edd49` failure mode. The CLI reference must not be a second copy of that. It is emitted by a script from the CLI's own command definitions, committed to `switchboard-site/src/pages/docs/reference/cli.md` under `DocsLayout.astro`, registered in `src/data/nav.ts` in the Reference section beside `/docs/reference/local-api-server` (the HTTP surface's page — the CLI page is its terminal counterpart), and covered by a drift check in the main repo's CI in the same shape as `check-protocol-parity.js`: regenerate, diff, fail on change.

**3b. Prerequisite — commands become data.** Today `usage()` is one hardcoded template string with 29 literal `npx switchboard …` lines, and per-command usage is duplicated inline in error paths (`:1332`, `:1398`). Nothing can be generated from that. Introduce a single command table — `{ name, usage, summary, args, area, bridging }` — and derive *all three* consumers from it: `usage()`, the per-command error strings, and the docs page. One source; `help` gets shorter, not longer, because it renders the table's `name` + `summary` and points at the page for the rest.

**3c. Schemas ride along.** The 277 payload shapes in `verbSchemas.ts` are rendered into the docs page per command rather than exposed through a new `--schema` flag. A `--schema` flag is more TUI surface, which is what this change avoids; the page is where someone looks anyway.

**3d. One docs URL.** The extension currently carries two bases — `https://switchboard.dev/docs` (`ClaudeCodeMirrorService.ts:156`) and `https://tentacleopera.github.io/switchboard-site/docs/…` (`SetupPanelProvider.ts:1532`, `TaskViewerProvider.ts:14940`). The CLI must not add a third. It reads the canonical base from wherever `4c134bdb` puts it, and this plan depends on that card landing first or alongside.

**4. Keep `verb` and `api` as the escape hatches they are, and say so.** `verb` for the two verb routes, `switchboard api` (shipped, `cli.ts:1601`) for arbitrary REST. Both stay, both are documented as escape hatches rather than as the interface. An agent reaching for either should know it has left the supported set.

**5. Rewrite the agent instructions against the named set.** The four `.agents/` files still demonstrating `curl -s -X POST` are rewritten to the named commands. This is the half of `6fc37578` that makes the other half stick: agents copy the pattern in front of them, so the pattern has to be the good one.

### Dependencies

- `4c134bdb` — one docs URL. The CLI links to the reference; it must not introduce a third docs base.
- `af65df25` — the `_advanceCards` extraction. `advance` is built on it or not at all.
- `d63d77f9` — bridging status. Without it, change #2 cannot be honest.
- `8aa2e928` — `switchboard api`. **Landed** in `96fb16df` (2026-09-03): `cmdApi` at `cli.ts:1601`, `sb_api_call.sh` retired. The card is in CODE REVIEWED (completed 2026-09-03 during the `6fc37578` dispatch). This plan defines what sits *above* it; it is no longer a blocker. Note the CLI binary runs the current `dist` fresh per invocation, so `switchboard api` is live from a shell even while the board's server process (started 11:56) predates the commit (14:15).
- `6fc37578` — the parent. This plan supplies the surface that feature assumes exists.

### Not in scope

Adding capability. Every operation named here already exists behind a route, a verb or a script. If an operation turns out to have no backing route, it is dropped from the set rather than built here.

## Appendix — classification of the 559 verbs

Bucketed by name prefix and reviewed. This is the justification for what the named set leaves out; it is not a list of things to build.

| bucket | count | disposition |
| :-- | --: | :-- |
| other | **122** | **Unclassified — needs manual triage.** Genuinely mixed: UI events (`activeTabChanged`), integration config (`applyLinearConfig`), board ops (`assignSelectedToProject`), agent ops (`appendToPlannerPrompt`, `airlock_sendToCoder`). The named set cannot be finalised until this bucket is split. |
| config / CRUD | 107 | **Nearly all in.** Teams, seats, standing orders, worktrees, projects, columns, routing, startup commands, planning docs and folders — all have terminal meaning. Folder *pickers* become `<path>` arguments. Out: `resetDatabase` and `scaffoldMultiRepo` only if they cannot be made safe non-interactively; otherwise in behind `--yes`. |
| reads | 101 | **Mostly in.** A read that backs a panel view backs a `--json` command equally well (`fetchArchivedPlans`, `fetchDocPages`, `getBoardCards`). Out only where the read exists to populate a widget with no standalone meaning. |
| provider / sync | 60 | **Split by use case, not by owner.** Two different products share the Linear/ClickUp/Notion services: **board sync** (mirror the kanban to a tracker so plans are managed there) is in; the **tickets panel** (view tracker tickets you have *not* imported as plans) is out. A verb owned by the Tickets panel but doing sync work is in; one touching `ClickUpSyncService` to move a ticket is out. See the tracker appendix below. |
| UI state & settings | 59 | **Split.** Board *settings* (`toggleDynamicComplexityRouting`, `toggleCliTriggers`, `setSuppressMainTerminals`, `setProtocolTarget`) are in as `setting get / set`; card writes (`setCardPriority`, `setOrderByMode`, `setPriorityStarred`, `setKanbanPlanComplexity`) are card operations. `setPushScope` is WS broadcast plumbing (`_broadcaster.setWebviewScope`) and is out. Pure *display* state (`setActiveTab`, `toggleCollapseCoders`, icon colours) is out — it describes a webview, not the board. |
| clipboard | 27 | **In, via stdout.** Every `copy*Prompt` becomes `prompt <kind>` printing the same text. The clipboard was the browser's delivery mechanism, not the operation. A human can pipe it; an agent can read it. |
| **board operations** | **24** | **In.** The core of the named set — `batchDispatchLow`, `completePlan`, `dispatchAnalyze`, `moveSelected`, `stageForQueue`, `reorderQueue`, `setPriorityStarred`, `archiveSelected` and siblings. |
| panel / focus | 22 | **Out.** `openDesignPanel`, `focusTerminal`. Browser mechanisms with no terminal meaning — the one bucket that stays fully out, and already the correctly-inert set in `d63d77f9`. |
| terminal / agent control | 19 | **Partly in.** `promptAll`, `promptSelected`, `ptySendPrompt`, seat clear/stop. Roughly eight; the rest are panel-driven prompt sends (`sendHtmlTweakPrompt`). |
| **mission control** | **16** | **In for an orchestrator.** `mcLaunchMission`, `mcNewMission`, `mcAddMissionMember`, `mcStopMission` and siblings. |
| worktree | 2 | **Probably in.** `abandonWorktree`, `cleanupWorktree` — small, and agents do create worktrees. |

**Six allowlist entries are not verbs at all.** `planner`, `lead`, `coder`, `intern`, `reviewer`, `tester` appear in the allowlist because `scripts/generate-protocol-catalog.js:78` harvests every `case 'string':` in the handler file — `const caseRe = /case\s+(['"])([^'"]+)\1\s*:/` — and cannot tell the top-level `switch (msg.type)` from a nested switch on a `role` parameter inside `getPromptPreview`. No button posts them, no schema declares them, no handler dispatches on them. They should be removed from the triage. The generator fix is its own plan — `the-catalogue-extractor-tracks-brace-depth-but-never-consults-it.md` — which also clears the four parity errors currently red at HEAD. Checked: no column ids or outcome strings leaked the same way, so the problem is exactly these six.

**Resolved on review (2026-09-03):**

- **Tickets panel — out; board sync — in.** Operator decision, refined: the *tickets panel* shows tracker tickets not imported as plans and is out (`changeTicketStatus`, `postTicketComment`, `postTicketReply`, `ticketsAskAgent`, `moveTicket`, folder/file/watcher verbs, `create*Task`/`create*Issue`, `update*Assignee|Labels|Tags|Priority`, `load*Details|Members|Assignees|Comments`, `importAllTickets`, `importTicketSubtasks`). *Board sync* — mirroring the kanban to Linear/ClickUp/Notion so plans are managed there — is in, whichever panel owns the button. **Owner is the wrong axis**: the sync services are shared plumbing for both.
- **`codeMapConfirm` / `codeMapSelected` — out, as dead code.** They dispatch the analyst role to build a per-plan context map (`handleAnalystContextMap`). The CREATED-column button that posted them was added 2026-03-28 (`dc201d93`) and **removed 2026-06-25 (`239a82dc`)**; the handlers, both verbs and a source-string regression test (`context-map-batching-regression.test.js`) were left behind. No webview posts them today. Separately, `analystMapFromKanban` is in the `d63d77f9` unbridged set. Candidate for deletion, not for the named set.
- **`pauseLiveSync` / `resumeLiveSync` / `scanFoldersNow` / `runSchedulerJob` — in, under `sync` / `scan` / `schedule`.** A human running Switchboard from a terminal needs these. They are not for a *dispatched* agent's workflow — `help` should file them under integrations, not cards — but that is organisation, not exclusion.

- **`externalAutomationPrompt` / `queryArchivesPrompt` — in, via stdout.** Both are clipboard writes that escaped the `copy*` bucket by name; they get the same treatment as the 27 — a `prompt` subcommand that prints the text.

**The `other` bucket is fully triaged.** Of its 122: 6 removed as catalogue artefacts, ~20 out as browser mechanisms (webview lifecycle, rendering, native dialogs), the remainder in — tickets excluded by operator decision.

**Tracker verbs, split by use case (2026-09-03):**

*Board sync — in* (as `sync …`, `linear …`, `clickup …`, `notion …`):
`linearStartOAuth` `linearExchangeOAuth` `linearDisconnectOAuth` `linearCheckAdmin` (the connection — a prerequisite for sync, co-owned with Tickets) · `linearLoadProjects` `linearLoadProject` `linearSaveProjectSelection` `linearLoadAutomationCatalog` `saveLinearAutomation` `applyLinearConfig` · `clickupLoadSpaces` `clickupLoadFolders` `clickupLoadLists` `clickupLoadProject` `clickupLoadListStatuses` `clickupSave{Space,Folder,List}Selection` `saveClickUpMappings` `saveClickUpAutomation` `applyClickUpConfig` · `applyNotionConfig` `configureNotionBackup` `backupToNotion` `restoreFromNotion` `autoCreateNotionDatabase` `runNotionRemoteSetup` · `getRemoteConfig` `setRemoteConfig` `getRemoteHealth` `startRemoteControl` `stopRemoteControl` `pauseLiveSync` `resumeLiveSync` `getSyncConfig` `setBoardStateExportRemoteUrl` · `syncDocToOnline` `syncToSource` `fetchNotionContent` `getNotionFetchState` · `copyLinearAgentSkill` (→ stdout).

*Per-ticket import — in* (`linearImportTask`, `clickupImportTask`, `linearImportAndSendToPlanner`), as `import linear <issue> [--to-planner]` / `import clickup <task>`. Not because they write plan files — outcome is the wrong test — but because a user who does **not** want to rely on live sync can run a **recurring import** from a scheduler instead, and that is a gesture only a terminal has. The natural composition is `import linear --project <p> --new`, which the panel cannot offer. `importAllTickets` stays out: it is `switchboard.importAllTasks`, the tickets-panel mirror refresh, not plan import.

*Tickets panel — out*: everything else tracker-shaped, ~40 verbs, per the operator ruling above. Note `moveTicket`, `switchTicketsProvider`, `ticketsRootChanged`, `invalidateClickUpCache` are panel despite touching the sync services — the shared-service test misfiles them.

**Remaining buckets, walked (2026-09-03):**

- **Terminal / agent control (19) — all in.** `promptAll` / `promptSelected` / `promptOnDrop` are one `prompt` family (drop is the gesture; the operation is copy-prompt + move); `sendToBacklog` / `sendToNew` / `sendToPlanned` collapse into `move --to`; `sendToTerminal` / `sendAnalystMessage` are the message primitive; the five panel `send*Prompt` verbs are `prompt <kind> --to <seat>`; `startAgentGroup` is `team start`. `startOrchestrator` / `stopOrchestrator` are **live** (`startMissionControlFromKanban`) — pre-rename entry points that `2e684007` should fold into `mission start / stop`. `clearControlPlaneCache` is in the `d63d77f9` unbridged set.
- **Mission control (16) — all in**, as `mission …` and `schedule …`. `mcScheduleExternalCopy` is an **empty server arm** (`return { success: true }`) kept for the verb-returns gate while the webview copies to clipboard; the CLI command must compose the text itself.
- **Clipboard (27) — in via stdout.** Board operations (24) — in. Panel / focus (22) — out. Worktree (2) — in.

**Walk complete — every one of the 559 has a disposition.** Approximate totals: **~440 in, ~110 out, 6 removed as catalogue artefacts.** The out set is webview mechanics (lifecycle, rendering, focus, pure display state, native dialogs whose purpose an argument meets) plus the tickets panel by operator decision. Per-bucket counts are estimates where buckets overlap; the authoritative list is the generated docs page once the command table exists.

**Roughly 50 verbs are candidates before curation** (24 board + 16 mission control + ~8 terminal + 2 worktree), plus about six board-shaped reads. The named set of ~20 is a further curation of those: several candidates are variants of one operation (`batchDispatchLow` / `batchLowComplexity` / `batchPlannerPrompt` are three entries for what an agent thinks of as "batch dispatch"), and collapsing them is part of the work.

**The ~500 excluded verbs are not a gap.** They are a UI transport doing its job. The plan's claim is that pointing agents at them was the mistake, not that they should be reachable.

**Triage of `other` is a prerequisite.** 122 unclassified entries is too many to wave through, and it is where the remaining agent operations will be found — `appendToPlannerPrompt` and `airlock_sendToCoder` are both plainly agent-facing. That triage is the first task of this plan, not a follow-up.

## Verification Plan

1. Every named operation has help text, argument validation, and a non-zero exit code on failure.
2. `switchboard <op> --schema` prints the declared fields for operations whose verb appears in `verbSchemas.ts`.
3. An operation whose underlying command is unbridged on this host exits non-zero naming that, and does **not** print success.
4. No file under `.agents/protocols/` or `.agents/skills/` contains `curl -s -X POST` — grep-asserted in CI.
5. `verb` and `api` still work and are documented as escape hatches, not as the primary surface.
6. An agent given only `switchboard help` sees the docs link, and from the linked page alone can correctly invoke batch dispatch without reading source or a protocol file.
6b. A human who has never opened the browser board can, from `switchboard help` plus the linked reference page, start a team, add a standing order, create a feature from three plans, and dispatch it — with no browser and no curl.
6d. `switchboard help` is no longer than it is today. The docs link appears in `help`, in `about`, and in every unknown-command error.
6e. `usage()`, every inline per-command usage string, and the docs page are all rendered from one command table — grep-asserted that no literal `npx switchboard <cmd>` string remains outside it.
6f. The docs page regenerates byte-identical in CI; editing a command's `summary` without regenerating fails the gate. `settings-commands.md` is either put on the same generator or its 'generated from' claim is removed.
6c. Every `copy*Prompt` verb has a `prompt` subcommand that writes the same text to stdout; every `browse*` verb has a command taking the path as an argument.
7. The named set is enumerable from one command, and no entry in it is a UI affordance.
