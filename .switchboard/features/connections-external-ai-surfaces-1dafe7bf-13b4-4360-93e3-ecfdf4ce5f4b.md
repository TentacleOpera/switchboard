# Connections — External AI Surfaces

**Complexity:** 7

## Goal

Make Switchboard's external-surface integrations discoverable and useful, so long-running authoring and review work can run on a different AI quota pool.

Remote Control exists and works, but it is the ninth tab of the Setup panel with no presence in the browser cockpit at all, and its name describes where the user is standing rather than what it does. Renaming it Connections and giving it a rail entry makes it findable, and names the side-by-side case (a second AI surface running next to the machine) as clearly as the away-from-desk one.

On top of that surface sit pre-written skill launchers that hand memo processing, plan writing and review out to an external AI, which writes results straight back into .switchboard/ where the existing watchers import them. No new transport is required — the prompt-composition and file-watch mechanisms already ship. The memo watcher closes the one gap: plans are watched on write, memo is not.

## How the Subtasks Achieve This

- **Connections Panel — Rename Remote Control and Give It a Rail Entry**: builds the container. Renames Remote Control to Connections, adds a manifest row and rail icon so the browser cockpit surfaces it at all, and moves the provider config out of `setup.html`'s ninth tab. The rename is first, not last: the name determines the label, icon, copy and tooltip, and an icon under the wrong name gets clicked once and not understood.
- **External-Agent Skill Launchers in the Connections Panel**: fills the container with the thing that delivers the quota win. Generalises the existing prompt-composition path (`PlanningPanelProvider.ts:4734-4800+`, the feature Improve button) into a launcher registry — process memo, write plans from a brief, review a plan, review a feature — each composing skill instructions plus artifact plus a write-back instruction naming an absolute path. The external agent writes into `.switchboard/`; `GlobalPlanWatcherService` imports it. No new transport.
- **Memo Write-Back Watcher — Reflect External Edits to `memo.md`**: closes the one hole in that return path. Plan files are watched on write; `.switchboard/memo.md` is read on demand only, so an externally processed memo is invisible in an open panel until reload. Watches the file through the `hostSeams` watcher with an echo guard so the panel's own saves do not bounce back.
- **Scheduled External-Agent Jobs — Instruction Inbox and Standing Jobs**: the capability that actually separates an external surface from a terminal. Spark and Cowork have their own cron, so they can work **unattended on a schedule** — memo→plans overnight, a Drive doc→plans daily, nightly code review of the coded columns, or full pipeline management declaring card moves. Adds `.switchboard/instructions/` (one-shot inbox + standing job definitions + declared-intent moves + run-log) mirroring the proven orchestrator-inbox pattern, with job activity ingested into kanban-db tables for the UI. Two enablers already exist: the per-column board mirror at `.switchboard/kanban-state-<column>.md` carries absolute plan paths and planIds in machine-readable comments, so "review everything in CODED" needs one file read and no API; and `TaskViewerProvider.ts:4475-4517` already implements the inbox structure and its frontmatter injection guard.
- **Move the WEB AGENTS Tab out of Artifacts and into Connections**: rehomes a hand-off surface that already exists and already works. `planning.html:3668` / `:3862-3922` is *"point an agent at your docs and get back a high-level plan"* — three source modes, copy-prompt buttons, paste-back to a board card. Same pattern as everything else here, filed under docs-and-artifacts because there was no better home when it was built. Its six `createPlans*` verbs stay in `PlanningPanelProvider`; only the UI moves, with the panel addressing two verb rails rather than six arms changing provider.
- **`switchboard-spark` — A Generated, Uploadable Context Skill**: closes the *outbound* gap. The prompts the board already copies reference skills by path (`agentPromptBuilder.ts:373, 744, 970-983`) and assume the receiving agent has absorbed `AGENTS.md`. A local agent gets that free; Spark does not, so today the user hand-pastes `AGENTS.md` alongside every prompt. This generates one self-contained file to upload once as persistent context — built from `.agents/` + `AGENTS.md` via the `ClaudeCodeMirrorService` pattern, so it is a second emitter rather than a fourth copy of the control plane.
- **Connections Jobs Tab — Standing Jobs, Inbox Lifecycle and Run-Log View**: makes the machinery visible. The jobs plan is deliberately headless; without this tab the only way to answer "did the overnight job run, and what did it do?" is hunting a hidden directory. Reads the job-activity tables the machinery ingests (`job_runs`, `job_instructions`, `board_move_requests`), renders standing jobs, inbox lifecycle (pending/claimed/done/**stuck**) and declared-move outcomes, and carries the three write actions the protocol defines — drop an instruction, clear a stuck claim, copy the cron prompt. Read-mostly by design: no push channel to the external agent exists, so the tab never fakes control.

## Why not MCP

The original approach was an MCP bridge giving an external agent synchronous tool calls against the board. It is parked, not deleted, at `.switchboard/plans/feature_plan_20260805_112400_switchboard_mcp_bridge_server.md` — that file carries the full reasoning and a verified twelve-tool mapping worth reusing if the situation changes.

Short version: Gemini Spark rejects `http://` and its fetch originates in Google's cloud, which cannot route to `127.0.0.1`, so local TLS does not help. The only route is a public HTTPS tunnel — and a tunnel forwards every path on the port, which would publish the whole board API including agent dispatch and terminal write. Auth would likely mean a hand-rolled OAuth 2.1 server. And Spark is slow by design, so synchronous tool calling is a poor fit regardless. The asynchronous prompt hand-off in this feature reaches the actual goal — running long work on Google's quota — with mechanisms that already ship.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Connections Panel — Rename Remote Control and Give It a Rail Entry](../plans/feature_plan_20260805120000_connections-panel-rename-and-rail-entry.md) — **CODE REVIEWED**
- [ ] [External-Agent Skill Launchers in the Connections Panel](../plans/feature_plan_20260805120001_external-agent-skill-launchers.md) — **CODE REVIEWED**
- [ ] [Memo Write-Back Watcher — Reflect External Edits to `memo.md`](../plans/feature_plan_20260805120002_memo-external-write-back-watcher.md) — **CODE REVIEWED**
- [ ] [`switchboard-spark` — A Generated, Uploadable Context Skill for External AI Surfaces](../plans/feature_plan_20260805130000_switchboard-spark-uploadable-context-skill.md) — **CODE REVIEWED**
- [ ] [Scheduled External-Agent Jobs — Instruction Inbox and Standing Jobs](../plans/feature_plan_20260805130001_scheduled-external-agent-jobs-instruction-inbox.md) — **CODE REVIEWED**
- [ ] [Move the WEB AGENTS Tab out of Artifacts and into Connections](../plans/feature_plan_20260805130002_move-web-agents-into-connections.md) — **CODE REVIEWED**
- [ ] [Connections Jobs Tab — Standing Jobs, Inbox Lifecycle and Run-Log View](../plans/feature_plan_20260805153000_connections-jobs-tab-activity-view.md) — **CODER CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Connections Panel first.** It is the container the launchers render into. The launcher work can be built against a stub, but it is not shippable until the panel exists.

**Memo Write-Back Watcher is independent** — it ships in any order and is useful on its own (it also covers the user hand-editing `memo.md` in an editor). Only the `memo-process` launcher is materially better with it; the plan and review launchers do not depend on it at all.

**External-Agent Skill Launchers last**, or in parallel with the watcher once the panel has landed.

**`switchboard-spark` context skill is independent and arguably highest-value-per-effort.** The board's existing copy-prompt paths already work against Spark — the skills are referenced inside the prompts — so this one alone removes the current friction (hand-pasting `AGENTS.md` with every prompt) without waiting on the panel. It gains a regenerate button once the panel lands, but ships fine before it: generation runs on activation and the file sits in `.switchboard/`.

**Scheduled Jobs depends on `switchboard-spark`, and only on it.** The polling contract, claim-marker protocol and board-mirror format have to reach the agent somehow, and that artifact is the only channel — a cron agent at 3am knows nothing else about Switchboard. Land the context skill first or build the two in parallel with the contract agreed up front. No dependency on the panel; the Jobs tab arrives in its own plan.

**WEB AGENTS move is hard-blocked on the panel** — there is nowhere to move it until Connections and its sub-tab strip exist. Otherwise independent.

**Jobs Tab is hard-blocked on both the panel and the jobs machinery** — it renders into one and queries the job-activity tables the other creates. Stub-buildable against the machinery plan's fixed table names; verify end to end only after both parents land.

`TaskViewerProvider.ts` is touched by three subtasks — the memo watcher (watcher + echo guard), the jobs machinery (instruction writer, moves sweep, ingestion), and the Jobs tab (verb arms). **Serialise those three streams** under the one-agent-stream-per-provider-file rule. No other shared provider file across the seven, so no serialisation is forced beyond that and the panel→launchers, panel→web-agents, panel+jobs→jobs-tab and spark→jobs orderings above.

## The panel's shape

Connections is **sub-tabbed**, not a flat form, and it is not a new-feature panel — it is a home for two surfaces that already ship:

| Sub-tab | Contents | Source |
|---|---|---|
| **Providers** | Remote Control provider config (Notion / Linear) | moved from `setup.html`'s ninth tab |
| **Hand-offs** | pre-written skill launchers | new |
| **Jobs** | standing jobs, inbox lifecycle, last run, declared-move outcomes | new (machinery + tab plans) |
| **Web Agents** | docs → external agent → plan, paste-back | moved from `planning.html` |

The split is config (Providers) versus operations (the other three). Both existing tenants — Remote Control and WEB AGENTS — work today and sit in unrelated panels with nothing telling a user the other exists. That lowers the speculative risk of building this panel and raises the cost of not building it.

**Deliberately not vendor-named.** No Spark panel, no Cowork panel, no vendor in a sub-tab label. The instruction/inbox model is file-based and surface-agnostic by construction — any cron-capable agent with folder access consumes it. Putting a supplier's name on UI for a mechanism that does not know about suppliers is the same error as calling the feature "Remote": naming the wrong axis.

**Two return paths, both correct, neither replacing the other.** Filesystem write-back needs the agent to have folder access — true for Spark's Connected Folders and Cowork, false for claude.ai, ChatGPT and any browser-only chat. Paste-back (what WEB AGENTS uses today) is the only path that works for those, which is why that surface can point at *any* web agent. Offering both, clearly labelled, is the end state.

## Two framings worth keeping straight

The feature has **two distinct value propositions**, and conflating them makes the panel work look more urgent than it is:

1. **Attended hand-off** (panel, launchers, context skill) — the user copies a prompt, pastes it into an external surface, gets a result back through the filesystem. Cheaper Anthropic bill on long authoring and review work.
2. **Unattended scheduled work** (context skill + scheduled jobs) — nothing is copied and nobody is watching. Cron on the external surface pulls work from an instruction folder. This is the one a terminal genuinely cannot do, and it reaches inputs Switchboard has no integration for at all, such as a Google Drive doc that only Spark can see.

Both route through the same context artifact, which is why that plan sits on the critical path for the feature despite being the smallest piece of UI work in it.

## Validated, not assumed

The attended hand-off was tested before these plans were written: Gemini Spark ran the `improve-plan` workflow against a real plan file (`feature_plan_20260805105310_memo-workspace-indicator-and-independent-picker.md`). Spot-checking its citations against source found them accurate — `memo.html:185-188` quoted verbatim, `memo.js:15-18`, `workspaceUtils.ts:6`, `verbSchemas.ts:1519` all exact. It also honoured project conventions unprompted: it flagged that `src/generated/verbAllowlist.ts` is generated and must not be hand-edited, warned against speculatively scaffolding `.switchboard/`, wrote "None" rather than hedged User Review items, and pinned a project that resolved.

So the premise holds — these surfaces produce work of usable quality against this codebase. The plans in this feature are about removing friction and adding scheduling, not about proving the approach.

**One capability the local pipeline lacks.** These surfaces can dispatch their own research sub-agents. Switchboard's `advise_research` directive only knows two endings — POST to a registered Researcher, or leave a ready-to-run prompt in the chat for the user (`agentPromptBuilder.ts:744, 747`) — and with no Researcher registered, uncertainties pile up as prompts nobody runs. The context skill therefore carries an explicit **override** telling the agent to dispatch its own research and fold the findings in, and the scheduled-jobs plan ships a `research-unknowns` standing job that resolves the backlog of unknowns in new plans overnight.

## Completion Report

- **Implemented:** the panel *container* only — `getConnectionsHtml` + a `connections` manifest row and `getPanelHtmlById` case, the `/connections` route, `icons/nav-connections.svg`, a four-entry sub-tab strip, and the `switchboard-remote.md` reframing. Three service files were written (`externalAgentPrompts.ts`, `SparkContextExporter.ts`, `ScheduledJobsService.ts`) but **none of them has a single caller anywhere in `src/`**, so the launchers, the Spark context artifact and the scheduled-jobs machinery are all unreachable; the memo write-back watcher was not written at all.
- **Files Changed:** `icons/nav-connections.svg`, `src/webview/connections.html`, `src/services/headlessPanelHtml.ts`, `src/services/LocalApiServer.ts`, `src/services/externalAgentPrompts.ts`, `src/services/SparkContextExporter.ts`, `src/services/ScheduledJobsService.ts`, `.agents/workflows/switchboard-remote.md`, plus regenerated `protocol-catalog.json` and `.claude/skills/switchboard-remote/SKILL.md`. `src/webview/setup.html` and `src/webview/planning.html` were restored byte-exact to their pre-feature state.
- **Issues Encountered:** the coding pass deleted two shipped surfaces instead of moving them — the Remote Control config form (taking `BOARD STATE EXPORT` and the Notion sync toggles with it) and the WEB AGENTS tab — leaving live handlers bound to markup that no longer existed on ~4,000 installs; both are now restored. Two CI gates were red (`catalog:check`, `mirror:check`) and `browser-panel-scrollbar-contract` failed four assertions against the hand-written `connections.html` stylesheet; all are green after this pass. A blocking design defect remains open for the panel and WEB AGENTS plans: `transport.js:26` derives one route prefix per panel from `data-panel`, so the reconciled "call `/setup/verb/` and `/planning/verb/` per verb" decision cannot be implemented as written.
