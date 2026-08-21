# Protocols become database rows injected into prompts, not files scaffolded into every repo

## Goal

Move 29 of the 32 protocol definitions into the store, delete one outright, and shrink `.agents/protocols/` to two files. Protocols are UI-triggered instructions the extension delivers; nothing discovers them by scanning the filesystem, so their storage form is a delivery choice rather than a constraint.

One is deleted rather than migrated: **`improve-remote-plan` (8K)**. It cannot be executed in any configuration — see below.

Two stay committed: `improve-plan` (16K) and `improve-feature` (12K). `CLAUDE.md:127` and `:130` treat `improve-plan`'s required-section schema as authoritative for all plan authoring, so an agent following `CLAUDE.md` with no connection to the user's machine — a cloud session working from a clone — must be able to read it unaided.

`.agents/workflows/` (4 files, 52K) stays committed and is unaffected. Those are the four user-typeable slash commands — the entry surface an agent reads before it can reach the API — and they are the bootstrap that makes row-delivered protocols reachable.

This supersedes the destination chosen by `move-protocols-out-of-skill-discovery.md`. That plan's intent — get non-discoverable protocols out of the scaffold — was correct and is restored here. Its `.switchboard/protocols/` destination was unshippable, and the review fix that relocated them to `.agents/protocols/` solved shipping by abandoning the intent.

### Problem Analysis

**What happened.** `move-protocols-out-of-skill-discovery.md` moved 33 items out of `.agents/skills/` because CLIs (Devin, Claude Code, Windsurf) scan that directory and inject every discovered skill's name and description into the system prompt, costing tokens every turn for protocols the agent never self-discovers. The destination was `.switchboard/protocols/`.

A reviewer pass (commit `33d4f3d`) found that destination could not ship:

> "`.vscodeignore` excludes `.switchboard/**`, and neither seeding path (extension.ts's `.agents` crawl-copy, or `ControlPlaneMigrationService._bootstrapControlPlaneLayout`) copies anything outside `.agents/`. All 33 protocols and every path reference the extension emits were dead on any user install, while grep/compile/lint/manual checks all passed because the files exist in this repo."

That finding was correct and important. The remedy — relocate to `.agents/protocols/` — restored shipping and preserved the token goal (discovery scans `.agents/skills/`, so `.agents/protocols/` is not injected). But it left 424K across 32 files scaffolded into every repository, which is the scaffolding cost the original plan existed to remove. The goal moved and nothing required that to come back to the author.

**Why the file form was never necessary.** Protocols have three delivery patterns, none of which involves host discovery:

1. **Content injection** — the extension reads the file itself and embeds the text in a dispatched prompt. `KanbanProvider.ts:11753` does `readFileSync(path.join(workspaceRoot, '.agents', 'protocols', 'improve-plan', 'SKILL.md'), 'utf8')`. A row read is a drop-in substitution; no agent and no host is involved in resolving it.
2. **Path directive** — the prompt says "Read and follow `<path>`". The agent reads whatever absolute path it is handed; the path's origin is irrelevant to it. Roughly 18 such sites across `DesignPanelProvider` (1), `TaskViewerProvider` (2), `PlanningPanelProvider` (7), `KanbanProvider` (2), `agentPromptBuilder` (5), `bootstrap` (1).
3. **Clipboard prompt — and this is the mode with the sharpest constraint.** The webview builds a prompt string *containing a workspace-relative protocol path*, and the user copies it. Tickets tab → **Agent API** button (`tickets-agent-api`) → `renderAgentApiModal()` renders `AGENT_API_CAPABILITIES[provider]` with a "Copy prompt" button per row → `navigator.clipboard.writeText(filledPrompt)`. **Switchboard's involvement ends at the clipboard.** It never reads the protocol, never dispatches it, and has no knowledge of where the prompt is pasted or whether it is pasted at all. (`handleTicketsAskAgent`, which would post through the host, is explicitly not bound to any button — "the Agent API modal copies prompts instead.")

   Because the emitted path is **workspace-relative**, the receiving agent resolves it against its own cwd. That works today only because the file is committed and the agent happens to be running in the repo. So neither a hash-keyed nor a stable *materialised* path is viable here: an absolute path assumes the agent is on the same machine, which a pasted prompt cannot guarantee.

   **These must inline.** Thirteen protocols are clipboard-delivered — `get-tickets`, `generate-diagram`, `accuracy`, `advise_research`, `clickup-api`, `clickup-attach`, `clickup-create-subpage`, `clickup-create-task`, `clickup-fetch`, `clickup-modify-task`, `linear-api`, `improve-feature`, `improve-plan` — totalling ~72K, all 4K except `accuracy` (8K), `improve-feature` (12K) and `improve-plan` (16K). A clipboard paste is a one-shot cost rather than a per-turn one, so inlining is cheap, and it makes the prompt self-contained and host-agnostic — the right property for text bound for an unknown destination.
4. **Extension-delivered by name** — already converted to path references by the earlier plan.

So the constraint that normally forces control-plane content onto disk — agent hosts glob the filesystem rather than querying an API — **does not apply to protocols**. It applies to *skills*, which Claude Code discovers by reading `.claude/skills/*/SKILL.md`. Conflating the two is what made a directory look mandatory.

**And the shipping blocker dissolves.** The reviewer's constraint is about shipping a *scaffolded workspace directory*. Seed data compiled into the extension bundle has no `.vscodeignore` interaction and no dependence on the `.agents/` crawl-copy. The blocker exists only if protocols are files in the workspace.

### `improve-remote-plan` is deleted, not migrated

It is unexecutable, and the contradiction is between the protocol and the workflow that points at it.

`.agents/workflows/switchboard-remote.md:25` instructs: *"To improve a plan: use `/improve-remote-plan` (not `/improve-plan`)."* But section 7 of that same workflow states the operating premise flatly:

> "You have **no repo access** — no GitHub, no git, no file system."

And `improve-remote-plan`'s own Prerequisites require exactly those things:

```bash
source "$(git rev-parse --show-toplevel)/.agents/skills/_lib/sb_api_call.sh"
```

plus a reachable LocalApiServer. Its "When to Use" compounds this by naming a scenario — "a remote session with no local machine running" — that its own Prerequisites forbid. **There is no configuration in which the pointing workflow and the pointed-at protocol are both satisfiable.**

The replacement already exists in the same workflow. Sections 8 onward instruct the agent to author the plan directly into the Notion page body or Linear issue body via MCP, then set the column — which is the flow that actually works, because it needs only MCP. So line 25 is not merely broken, it is redundant with the document's own instructions.

Two further reasons not to keep it:

- **Its only distinctive capability is already covered.** Routing through `sb_api_call POST /api/linear` means the extension injects the Linear token host-side, so an agent writes to Linear without holding a credential. That is `linear-api`, which is already a protocol and already clipboard-delivered. `improve-remote-plan` adds nothing to it.
- **It has a latent two-writer hazard.** Its Read Phase never checks whether the plan already exists locally. If it does, editing the Linear description races `LinearSyncService`, whose `pullIntervalMinutes` defaults to 60 — so whichever direction syncs next wins, silently.

### Root Cause

Protocols were modelled as skills because they were authored as skills and lived beside them. Every subsequent decision — which directory, which seeding path, which ignore rule — inherited that framing. The delivery mechanism (extension reads, extension injects) had already diverged from the storage form (a discoverable-looking skill directory) long before the move.

### Non-goals

- Moving `.agents/skills/` — the four genuinely discoverable skills stay files, because hosts glob for them.
- Moving `.agents/workflows/` (the four user-typeable slash commands) or `.agents/skills/_lib/`. Both stay committed: workflows are the bootstrap entry surface, and `_lib/sb_api_call.sh` is sourced from the repo by `improve-remote-plan`.
- Changing protocol *content*.
- Re-litigating the token-cost goal; it is already achieved and must stay achieved.
- Broadening what remote mode can do. Removing `improve-remote-plan` narrows it to create-author-and-status via MCP, which is what the workflow's own sections 8+ already describe. If that narrowing is unwanted, the answer is an MCP-only improvement path, not reviving a protocol that needs the repo.
- Removing `RETIRED_WORKFLOW_PATH_MAP` — it stays as the read-time guard for persisted stale paths.

## Metadata

**Complexity:** 6
**Tags:** infrastructure, refactor, database, api, backend, reliability

## User Review Required

Yes — confirm the delivery model. The discriminator is **what the reader can reach**, not whether the extension dispatches it.

An earlier revision used `ClaudeCodeMirrorService.ts:64-71`'s "extension-dispatched" list as the test and concluded all 32 could be rows. That list is about CLI skill-discovery mirroring; it says nothing about whether a given reader can obtain the body. Three reachability tiers, and every protocol sits in exactly one:

| Reader can reach | Delivery | Which protocols |
| :--- | :--- | :--- |
| a clipboard from the extension | **`inline`** into the copied prompt | the 13 clipboard-delivered ones (~72K): `get-tickets`, `generate-diagram`, `accuracy`, `advise_research`, `clickup-api`, `clickup-attach`, `clickup-create-subpage`, `clickup-create-task`, `clickup-fetch`, `clickup-modify-task`, `linear-api`, plus `improve-plan` / `improve-feature` |
| the LocalApiServer — locally, or remotely through the proxy | **`GET /protocol/<name>`** (new endpoint) | everything the `sb_api_call` family already reaches, including `improve-remote-plan` |
| nothing but a clone | **committed file** | `improve-plan`, `improve-feature` |

**The middle tier is the piece that makes this work and it is cheap.** Any agent already using `sb_api_call` has a channel to the extension, so it can fetch a protocol body the same way it fetches everything else. That is what lets `improve-remote-plan` be a row despite being the "remote" protocol — it *requires* the LocalApiServer by its own Prerequisites, so the channel is guaranteed.

**The third tier is small but non-empty, and this is the correction.** A cloud session working from a clone has no extension, no clipboard, and no proxy. It reads `CLAUDE.md`, which points at `improve-plan`'s section schema as the authority for plan structure. If that body exists only as a row on the user's machine, a cloud agent authoring a plan has no way to learn the schema it is required to follow. `improve-feature` is the same case for features. Two files, ~28K — down from 424K, and for a reason that survives scrutiny rather than a mechanical name-match.

Note `improve-plan` and `improve-feature` appear in two tiers: clipboard-offered *and* repo-committed. That is consistent — the committed file is the floor, and the clipboard prompt inlines the body so a paste works on a machine that has no clone.

**Remaining decision within the row class: `inline` versus `materialize`.** Clipboard-delivered means `inline`, because Switchboard's involvement ends at the clipboard and cannot know where the prompt is pasted. Everything else means `materialize` to a hash-keyed cache — including the three largest, `terminal-coder-dispatch` (44K), `switchboard-orchestrator` (40K) and `switchboard-orchestration` (28K), which are also the most frequently dispatched and where inlining would re-add the per-turn token cost the original plan removed.

## Complexity Audit

### Routine

- Adding `delivery` (`inline` | `materialize`) and `body` to the `control_plane` table introduced by the scaffold plan.
- Seeding the 32 protocols from the extension bundle at activation, keyed by name and version.
- A resolver — `resolveProtocol(name)` — returning either the body or a materialised absolute path, for `row`-class protocols only.
- Materialising into `~/.switchboard/cache/protocols/<name>/SKILL.md` on demand, with the content hash as the cache key.
- Deleting `.agents/protocols/` from the repo and from the seeding crawl.

### Complex / Risky

- **140 reference sites across 26 files** — including four webview files (`tickets.js`, `planning.js`, `sharedDefaults.js`, `kanban.html`) and twelve test files. An earlier revision of this plan counted 60 across 9 by searching only `--include=*.ts`, which missed every clipboard-prompt site and every test. Every `path.join('.agents', 'protocols', …)` becomes a resolver call. The single content-injection site is trivial; the ~18 directive sites each need their prompt string rebuilt, because the emitted text changes shape (a path that is now absolute, or an inlined body). `DEFAULT_PLANNER_WORKFLOW` and `DEFAULT_FEATURE_PLANNER_WORKFLOW` in `agentPromptBuilder.ts` are persisted-config defaults, so changing them interacts with `RETIRED_WORKFLOW_PATH_MAP`.
- **Persisted user config points at file paths.** A user may have a customised planner workflow path stored in config. That path must keep resolving — extend `RETIRED_WORKFLOW_PATH_MAP` with `.agents/protocols/*` keys the same way the review fix added `.switchboard/protocols/*` keys, and make `normalizeRetiredWorkflowPath` map a stale path to a protocol *name* rather than another path.
- **Local overrides must survive.** A user who edited `.agents/protocols/improve-plan/SKILL.md` has customised behaviour. On migration, any file whose hash does not match the bundled version must be imported as an override row, never discarded. This is the difference between a migration and data loss.
- **Nothing outside the extension may name a protocol by path.** Once all 32 are rows, a `CLAUDE.md` directive or workflow file that says "read `.agents/protocols/X/SKILL.md`" hands an agent a path that does not exist, and the failure is silent — the agent reports a missing file, or proceeds without the instructions. A test must assert that no protocol path appears in `CLAUDE.md`, `AGENTS.md`, `.agents/workflows/*.md`, or any remote-flow document. Someone adding such a reference later is the realistic way this breaks, and `CLAUDE.md` already carries five stale `.switchboard/protocols/` paths today, which is the same bug in its current form.
- **The orchestrator reads protocols mid-session.** `TaskViewerProvider.ts:11230` resolves `switchboard-orchestrator/SKILL.md` plus a runsheet by name at dispatch time. If materialisation is lazy, a protocol must be on disk *before* the prompt naming it is sent, not after.

## Edge-Case & Dependency Audit

**Race conditions**
- Two dispatches materialising the same protocol concurrently: content-hash-named temp file plus atomic rename, so a partially written file is never observed at the emitted path.
- Materialising while a previous version is being read by a live agent: hash-keyed paths mean versions never collide, and pruning waits for idle.

**Security**
- Protocol bodies become rows the extension injects into prompts and materialises to disk. They are instructions with real authority — `terminal-coder-dispatch` drives coder agents. Bodies must originate only from the extension bundle or an explicit user override, never from anything network-fetched, and the materialised cache directory must not be writable by anything but the sidecar.
- Materialising outside the workspace means the path is machine-absolute. It must be validated against the cache root before being emitted, so a crafted protocol name cannot direct an agent to read an arbitrary file.

**Side effects**
- `.switchboard-bundled.json` (the `BUNDLE_LEDGER_FILE` at `ControlPlaneMigrationService.ts:1053`) currently prunes retired bundled files. With protocols as rows, the ledger's protocol entries are replaced by the version column on the row; the ledger keeps managing genuinely-bundled files only.
- Removing 424K and 32 files also removes them from every agent's file-search surface.
- `protocol-catalog.json` at the repo root looks like a generated catalogue of these; it needs regenerating or retiring.

**Migration**
- Protocols shipped in released versions at three successive locations (`.agents/skills/`, `.switchboard/protocols/` in dev builds, `.agents/protocols/` now). The migration must handle a workspace at any of the three: import any protocol file found at any of them, hash-compare against the bundled version, keep mismatches as override rows, archive the file as `SKILL.md.migrated.bak`, and never unlink.
- Assume no prior migration ran.

## Dependencies

- **Blocked on updating `src/test/vsix-packaging-contract.test.js`**, which hard-asserts `fs.existsSync('.agents/protocols')` with the message "protocols must live under `.agents/protocols/`". That assertion pins the destination the review fix chose rather than the goal, so it fails the moment this plan succeeds. It is a correct test of shipping and a wrong test of intent — the worked example of the problem the goal-invariant plan addresses.
- **Requires** the control-plane scaffold plan — that plan introduces the `control_plane` table, the bundle-seeding path, and the override-preservation policy this one extends. In practice they land together; this plan is the part that proves the table can hold real, load-bearing content.
- **Supersedes** the destination in `move-protocols-out-of-skill-discovery.md`, which needs a superseded note so nobody re-implements a file move.

## Adversarial Synthesis

**"The reviewer was right and this re-opens a settled question."** The reviewer was right about the blocker and wrong about the remedy's scope. Both facts hold. The shipping problem was real and would have broken every user install; the remedy silently changed what the plan was for. This plan keeps the reviewer's finding — `.switchboard/` cannot ship, so nothing goes there — and satisfies the original intent by removing the file rather than relocating it.

**"Files are simpler than rows for something an agent has to read."** True for skills, where a host globs and there is no alternative. False for protocols, where the extension already reads the file itself in the injection case, and hands over an arbitrary path in the directive case. The file is an implementation detail of a delivery mechanism that never depended on it.

**"Inlining 40KB into every dispatch is worse than a 424K directory."** Correct, which is why delivery is a per-protocol column rather than a policy, and why `materialize` is the default. The directory cost is paid per repository forever; an inline cost is paid per dispatch for the protocols where it is cheap.

**"Materialising to the home directory just moves the directory."** It moves it out of every repository into one machine-local cache, keyed by content hash, prunable, and never committed. That is the whole ask, and it applies only where the extension dispatches — on the user's own machine, where that cache is guaranteed to exist.

**"Remote agents will lose access to protocols."** Two of them genuinely would, which is why two stay committed. A cloud session working from a clone has no extension, no clipboard and no proxy, and `CLAUDE.md` points it at `improve-plan`'s section schema as the authority for plan structure — so that body must be readable unaided. Everything else is reachable by one of the other two tiers: clipboard-inlined, or fetched over `GET /protocol/<name>` by any agent that can already reach the LocalApiServer. The failure mode to guard is a protocol *moving* between tiers without its references moving with it, which is what the prose test pins.

**"Two committed files is an arbitrary carve-out."** It is derived, not chosen: they are the protocols `CLAUDE.md` cites as authoritative for work an agent does with no extension present. If `CLAUDE.md` stopped citing them — if plan structure moved into the workflow files, which are committed anyway — the carve-out would go to zero. That is a reasonable follow-up and deliberately out of scope here, because it changes what `CLAUDE.md` means rather than where a file lives.

## Proposed Changes

1. **`control_plane` table gains `body`, `delivery`, `version`, `content_hash`, and a nullable `override_body`** — extending the scaffold plan's schema rather than adding a second table.
2. **Bundle seeding**: the 32 protocols are compiled into the extension and upserted at activation by name and version, with hash comparison so an override row is never overwritten.
3. **`resolveProtocol(name)`** — the single resolution point for all 32. Returns the body for `inline` or an absolute materialised path for `materialize`, and validates any emitted path against the cache root. No host argument: protocols are only ever resolved by the extension, which only runs where the store exists.
4. **140 call sites across 26 files** rewritten to call the resolver instead of constructing `path.join('.agents', 'protocols', …)`. The webview sites become inlined bodies rather than paths, since the extension cannot know where a copied prompt is pasted.
4b. **`src/test/vsix-packaging-contract.test.js` updated.** It currently asserts `.agents/protocols/` exists, is non-empty, and fully packages — the exact inverse of this plan's goal invariant. Its packaging machinery (a faithful reproduction of vsce's `collectFiles` filter) stays and remains valuable; the protocol-specific assertion is replaced by one covering whatever seeds the `control_plane` rows.
5. **`RETIRED_WORKFLOW_PATH_MAP` extended** with `.agents/protocols/*` keys; `normalizeRetiredWorkflowPath` maps a stale path to a protocol *name*.
6. **Materialisation cache** at `~/.switchboard/cache/protocols/<content-hash>/SKILL.md`, atomic write, idle pruning.
7. **`improve-remote-plan` deleted**, not migrated to a row. Its `.agents/protocols/improve-remote-plan/` directory goes, along with every reference.
8. **`.agents/workflows/switchboard-remote.md:25` rewritten** to point at the workflow's own sections 8+ (author into the page/issue body via MCP, then set the column) instead of the deleted protocol. **This is a workflow file — propose the wording and obtain explicit approval before editing it.**
9. **`.agents/protocols/` deleted** from the repo and from the seeding crawl; `protocol-catalog.json` regenerated or retired; `.switchboard-bundled.json` protocol entries dropped in favour of the version column.

### Migration

Import from all three historical locations, hash-compare, preserve mismatches as override rows, archive each file as `SKILL.md.migrated.bak`, never unlink.

## Verification Plan

### Goal Invariants

- `.agents/protocols/` contains exactly `improve-plan/SKILL.md` and `improve-feature/SKILL.md` and nothing else — asserted against the repo, a packaged VSIX, and every `path.join` in `src/`. This is the assertion the original plan lacked, and it fails whether the other 30 sit at `.switchboard/protocols/`, back in `.agents/skills/`, or still in `.agents/protocols/`.
- `.agents/protocols/` totals under 32KB (currently 424K).
- Both survivors still ship: they are present in a packaged VSIX, which is the constraint that sank `.switchboard/protocols/`.
- The other 30 resolve from `control_plane` rows and exist as files nowhere in the repo.
- No protocol name or description appears in a CLI-discovered skill listing.

### Automated Tests
- **Ships and resolves on a clean install:** unpack a built VSIX into a fresh workspace with no `.agents/` at all; assert every one of the 32 protocols resolves. This is the check that was missing when the earlier version passed grep, compile, lint and manual review while being dead on every user install.
- **`improve-remote-plan` is gone:** assert the directory does not exist, no `control_plane` row is seeded for it, and no reference survives in `src/`, `.agents/`, `CLAUDE.md` or `AGENTS.md`.
- **`switchboard-remote.md` self-consistency:** assert the workflow names no protocol or path that its own section 7 premise ("no repo access — no git, no file system") makes unreachable. This is the general form of the bug, so it catches the next one.
- **API tier:** `GET /protocol/<name>` returns the body for every row-class protocol, rejects an unknown name, and rejects a name containing traversal characters. Assert `improve-remote-plan` is fetchable this way, since its own Prerequisites guarantee the channel.
- **Cloud tier (the correction this plan needed):** in a bare clone with no extension, no store, no cache and no network path to any machine, assert an agent can read `improve-plan/SKILL.md` and `improve-feature/SKILL.md` by the paths `CLAUDE.md` names. This is the scenario an earlier revision of this plan would have broken.
- **No protocol path on the clipboard:** click "Copy prompt" for every row of `AGENT_API_CAPABILITIES` in both providers; assert no clipboard payload contains a filesystem path, and that each contains the protocol body inline. This is the assertion that keeps a pasted prompt working on a machine that is not the user's.
- **Weaker-guarantee-wins:** assert `improve-plan` and `improve-feature` resolve as `inline`, since they are both clipboard-offered and extension-dispatched.
- **No unreachable protocol path in agent-read prose:** assert the only protocol paths appearing in `CLAUDE.md`, `AGENTS.md`, `.agents/workflows/*.md` or the remote-flow documents are the two committed ones, and that every such path resolves in a bare clone. No `.switchboard/protocols/` path may appear at all. This test fails today — `CLAUDE.md` carries five stale `.switchboard/protocols/` paths — and must pass after.
- **Workflows still bootstrap:** assert the four `.agents/workflows/*.md` files remain committed and readable in a fresh clone with no extension, since they are the entry surface that makes row-delivered protocols reachable.
- **`_lib` survives:** assert `.agents/skills/_lib/sb_api_call.sh` is still committed and resolvable via `git rev-parse --show-toplevel`, as `improve-remote-plan` requires.
- **Prompt-shape parity:** for each of the ~18 directive sites, assert the emitted prompt still names or contains the correct protocol, compared against a recorded baseline.
- **Override preservation:** hand-edit a protocol at each of the three historical locations, migrate, assert the edit survives as an override row, the file is archived as `.migrated.bak`, and the override wins at resolution.
- **Persisted stale config:** set a planner workflow config to each historical path, assert `normalizeRetiredWorkflowPath` resolves it to the right protocol name and the dispatch succeeds.
- **Token goal still met:** assert no protocol name or description appears in a CLI-discovered skill listing.
- **Path-escape guard:** a protocol name containing traversal characters must not produce a path outside the cache root.
- **Concurrency:** materialise the same protocol from two dispatches simultaneously; assert the emitted path is always a complete file.
- **Orchestrator timing:** assert a protocol named in a prompt is on disk before that prompt is sent.

## Outstanding Questions

- **[user]** Which protocols should default to `inline` rather than `materialize`? Proceeding on the assumption that anything under ~8KB inlines and the rest materialise, pending a look at dispatch frequency.
- **[user]** Does anyone have local edits to `.agents/protocols/` content today? Proceeding on the assumption that they might, so override preservation is built rather than skipped.
- Is `protocol-catalog.json` still read by anything, or is it a build artifact that can simply be retired?
