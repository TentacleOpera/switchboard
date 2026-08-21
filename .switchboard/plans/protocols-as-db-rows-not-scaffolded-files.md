# Protocols become database rows injected into prompts, not files scaffolded into every repo

## Goal

Move the 27 extension-dispatched protocol definitions (380K of the 424K) into the store and stop shipping them as a directory inside every user's workspace. Protocols are UI-triggered instructions the extension delivers; nothing discovers them by scanning the filesystem, so nothing requires them to be files.

Five protocols stay committed files: `improve-plan`, `improve-feature`, `improve-remote-plan`, `get-tickets`, `generate-diagram` (44K). These are read by an agent following `CLAUDE.md` with no extension running — in a cloud or remote session there is no extension, no local store, and no cache, so being in the repo is their only viable delivery path.

This supersedes the destination chosen by `move-protocols-out-of-skill-discovery.md`. That plan's intent — get non-discoverable protocols out of the scaffold — was correct and is restored here. Its `.switchboard/protocols/` destination was unshippable, and the review fix that relocated them to `.agents/protocols/` solved shipping by abandoning the intent.

### Problem Analysis

**What happened.** `move-protocols-out-of-skill-discovery.md` moved 33 items out of `.agents/skills/` because CLIs (Devin, Claude Code, Windsurf) scan that directory and inject every discovered skill's name and description into the system prompt, costing tokens every turn for protocols the agent never self-discovers. The destination was `.switchboard/protocols/`.

A reviewer pass (commit `33d4f3d`) found that destination could not ship:

> "`.vscodeignore` excludes `.switchboard/**`, and neither seeding path (extension.ts's `.agents` crawl-copy, or `ControlPlaneMigrationService._bootstrapControlPlaneLayout`) copies anything outside `.agents/`. All 33 protocols and every path reference the extension emits were dead on any user install, while grep/compile/lint/manual checks all passed because the files exist in this repo."

That finding was correct and important. The remedy — relocate to `.agents/protocols/` — restored shipping and preserved the token goal (discovery scans `.agents/skills/`, so `.agents/protocols/` is not injected). But it left 424K across 32 files scaffolded into every repository, which is the scaffolding cost the original plan existed to remove. The goal moved and nothing required that to come back to the author.

**Why the file form was never necessary.** Protocols have three delivery patterns, none of which involves host discovery:

1. **Content injection** — the extension reads the file itself and embeds the text in a dispatched prompt. `KanbanProvider.ts:11753` does `readFileSync(path.join(workspaceRoot, '.agents', 'protocols', 'improve-plan', 'SKILL.md'), 'utf8')`. A row read is a drop-in substitution; no agent and no host is involved in resolving it.
2. **Path directive** — the prompt says "Read and follow `<path>`". The agent reads whatever absolute path it is handed; the path's origin is irrelevant to it. Roughly 18 such sites across `DesignPanelProvider` (1), `TaskViewerProvider` (2), `PlanningPanelProvider` (7), `KanbanProvider` (2), `agentPromptBuilder` (5), `bootstrap` (1).
3. **Extension-delivered by name** — already converted to path references by the earlier plan.

So the constraint that normally forces control-plane content onto disk — agent hosts glob the filesystem rather than querying an API — **does not apply to protocols**. It applies to *skills*, which Claude Code discovers by reading `.claude/skills/*/SKILL.md`. Conflating the two is what made a directory look mandatory.

**And the shipping blocker dissolves.** The reviewer's constraint is about shipping a *scaffolded workspace directory*. Seed data compiled into the extension bundle has no `.vscodeignore` interaction and no dependence on the `.agents/` crawl-copy. The blocker exists only if protocols are files in the workspace.

### Root Cause

Protocols were modelled as skills because they were authored as skills and lived beside them. Every subsequent decision — which directory, which seeding path, which ignore rule — inherited that framing. The delivery mechanism (extension reads, extension injects) had already diverged from the storage form (a discoverable-looking skill directory) long before the move.

### Non-goals

- Moving `.agents/skills/` — the four genuinely discoverable skills stay files, because hosts glob for them.
- Converting the five `bundled-file` protocols to rows. They are the delivery mechanism for agents with no extension in the loop; committing them is not scaffolding overhead, it is the only path that works.
- Changing protocol *content*.
- Re-litigating the token-cost goal; it is already achieved and must stay achieved.
- Removing `RETIRED_WORKFLOW_PATH_MAP` — it stays as the read-time guard for persisted stale paths.

## Metadata

**Complexity:** 6
**Tags:** infrastructure, refactor, database, api, backend, reliability

## User Review Required

Yes — confirm the split, which is by **consumer**, not by host.

**Two delivery classes, decided by who reads the protocol:**

| Class | Protocols | Size | Reader |
| :--- | :--- | :--- | :--- |
| `bundled-file` — stays committed in `.agents/protocols/` | `improve-plan`, `improve-feature`, `improve-remote-plan`, `get-tickets`, `generate-diagram` | **44K (10%)** | an agent following `CLAUDE.md` with **no extension in the loop** |
| `row` — `control_plane` row, extension injects or materialises | the other 27, incl. `terminal-coder-dispatch` (44K), `switchboard-orchestrator` (40K), `switchboard-orchestration` (28K) | **380K (90%)** | the extension, on the user's machine |

**Why the 5 must stay files.** They are reached by an agent reading `CLAUDE.md` and following a path — in a cloud or remote session there is no extension running, no local DB, and no home cache. Being committed to the repo *is* their delivery mechanism, and it is the only one available: a clone carries them, which is exactly how a `/switchboard-cloud` session reads `improve-plan` today. Any design that turns these into rows removes them from remote agents entirely, because nothing in the remote path can inject on the extension's behalf.

**Why the 27 can be rows.** They are extension-dispatched, and the extension only ever runs where the store exists. `terminal-coder-dispatch` and the orchestrator protocols are never needed by a remote agent — a cloud session does not dispatch coders or run the orchestrator. So there is no host for which a row is unreachable.

This is the whole design, and it removes the per-host delivery forcing an earlier revision of this plan proposed. Delivery is a property of the protocol's consumer, fixed at authoring time, not a runtime decision about who is asking.

**Remaining decision:** within the `row` class, `inline` versus `materialize`. Median is 4KB, but the three largest are also the most frequently dispatched, so blanket inlining would re-add the per-turn token cost the original plan removed. Recommendation: `materialize` to a hash-keyed cache under `~/.switchboard` by default, `inline` under ~8KB where a disk round-trip buys nothing. A per-row column, not a policy.

## Complexity Audit

### Routine

- Adding `delivery` (`inline` | `materialize`) and `body` to the `control_plane` table introduced by the scaffold plan.
- Seeding the 32 protocols from the extension bundle at activation, keyed by name and version.
- A resolver — `resolveProtocol(name)` — returning either the body or a materialised absolute path, for `row`-class protocols only.
- Materialising into `~/.switchboard/cache/protocols/<name>/SKILL.md` on demand, with the content hash as the cache key.
- Deleting `.agents/protocols/` from the repo and from the seeding crawl.

### Complex / Risky

- **60 reference sites across 9 files.** Every `path.join('.agents', 'protocols', …)` becomes a resolver call. The single content-injection site is trivial; the ~18 directive sites each need their prompt string rebuilt, because the emitted text changes shape (a path that is now absolute, or an inlined body). `DEFAULT_PLANNER_WORKFLOW` and `DEFAULT_FEATURE_PLANNER_WORKFLOW` in `agentPromptBuilder.ts` are persisted-config defaults, so changing them interacts with `RETIRED_WORKFLOW_PATH_MAP`.
- **Persisted user config points at file paths.** A user may have a customised planner workflow path stored in config. That path must keep resolving — extend `RETIRED_WORKFLOW_PATH_MAP` with `.agents/protocols/*` keys the same way the review fix added `.switchboard/protocols/*` keys, and make `normalizeRetiredWorkflowPath` map a stale path to a protocol *name* rather than another path.
- **Local overrides must survive.** A user who edited `.agents/protocols/improve-plan/SKILL.md` has customised behaviour. On migration, any file whose hash does not match the bundled version must be imported as an override row, never discarded. This is the difference between a migration and data loss.
- **The 27/5 boundary is the load-bearing decision and must be enforced, not documented.** If a protocol in the `row` class ever gets referenced from a path an agent reaches without the extension — a `CLAUDE.md` directive, a workflow file, a remote flow — that agent silently gets nothing. A test must assert that every protocol named in `CLAUDE.md`, `.agents/workflows/*.md`, or any remote-flow document is in the `bundled-file` class. Adding a protocol reference to `CLAUDE.md` later is the realistic way this breaks.
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

- **Requires** the control-plane scaffold plan — that plan introduces the `control_plane` table, the bundle-seeding path, and the override-preservation policy this one extends. In practice they land together; this plan is the part that proves the table can hold real, load-bearing content.
- **Supersedes** the destination in `move-protocols-out-of-skill-discovery.md`, which needs a superseded note so nobody re-implements a file move.

## Adversarial Synthesis

**"The reviewer was right and this re-opens a settled question."** The reviewer was right about the blocker and wrong about the remedy's scope. Both facts hold. The shipping problem was real and would have broken every user install; the remedy silently changed what the plan was for. This plan keeps the reviewer's finding — `.switchboard/` cannot ship, so nothing goes there — and satisfies the original intent by removing the file rather than relocating it.

**"Files are simpler than rows for something an agent has to read."** True for skills, where a host globs and there is no alternative. False for protocols, where the extension already reads the file itself in the injection case, and hands over an arbitrary path in the directive case. The file is an implementation detail of a delivery mechanism that never depended on it.

**"Inlining 40KB into every dispatch is worse than a 424K directory."** Correct, which is why delivery is a per-protocol column rather than a policy, and why `materialize` is the default. The directory cost is paid per repository forever; an inline cost is paid per dispatch for the protocols where it is cheap.

**"Materialising to the home directory just moves the directory."** It moves it out of every repository into one machine-local cache, keyed by content hash, prunable, and never committed. That is the whole ask, and it applies only to the 27 protocols the extension dispatches on the user's own machine — where that cache is guaranteed to exist.

**"Remote agents will lose access to protocols."** They would, if the boundary were drawn by host instead of by consumer. They can read protocols today only because the files are committed, and there is no extension in a cloud session to inject on their behalf — so a row is genuinely unreachable there. That is precisely why the five protocols remote flows reference stay committed files, and why the 27 that move are exactly the ones no remote agent ever needs. The boundary test in the verification plan is what keeps that true as `CLAUDE.md` changes.

## Proposed Changes

1. **`control_plane` table gains `body`, `delivery`, `version`, `content_hash`, and a nullable `override_body`** — extending the scaffold plan's schema rather than adding a second table.
2. **Bundle seeding**: the 32 protocols are compiled into the extension and upserted at activation by name and version, with hash comparison so an override row is never overwritten.
3. **`resolveProtocol(name)`** — the single resolution point for `row`-class protocols. Returns the body for `inline` or an absolute materialised path for `materialize`, and validates any emitted path against the cache root. No host argument: `row`-class protocols are only ever resolved by the extension, and `bundled-file` protocols are never resolved through it at all — they are read from the repo by path, as today.
4. **60 call sites across 9 files** rewritten to call the resolver instead of constructing `path.join('.agents', 'protocols', …)`.
5. **`RETIRED_WORKFLOW_PATH_MAP` extended** with `.agents/protocols/*` keys; `normalizeRetiredWorkflowPath` maps a stale path to a protocol *name*.
6. **Materialisation cache** at `~/.switchboard/cache/protocols/<content-hash>/SKILL.md`, atomic write, idle pruning.
7. **`.agents/protocols/` deleted** from the repo and from the seeding crawl; `protocol-catalog.json` regenerated or retired; `.switchboard-bundled.json` protocol entries dropped in favour of the version column.

### Migration

Import from all three historical locations, hash-compare, preserve mismatches as override rows, archive each file as `SKILL.md.migrated.bak`, never unlink.

## Verification Plan

### Goal Invariants

- `.agents/protocols/` contains exactly the five `bundled-file` protocols and no others — asserted against the repo, a packaged VSIX, and every `path.join` in `src/`. This is the assertion the original plan lacked, and it is what would have caught the destination change: it fails whether the 27 are at `.switchboard/protocols/`, back in `.agents/skills/`, or still in `.agents/protocols/`.
- `.agents/protocols/` totals under 64KB (currently 424K).
- No protocol name or description appears in a CLI-discovered skill listing.

### Automated Tests
- **Ships and resolves on a clean install:** unpack a built VSIX into a fresh workspace with no `.agents/` at all; assert every one of the 32 protocols resolves. This is the check that was missing when the earlier version passed grep, compile, lint and manual review while being dead on every user install.
- **The 27/5 boundary:** assert every protocol named in `CLAUDE.md`, `.agents/workflows/*.md` and the remote-flow documents is in the `bundled-file` class and present in the repo. Assert no `row`-class protocol is named in any of them. This is the test that keeps a remote agent from silently getting nothing.
- **Remote reachability:** clone the repo with no extension, no store and no cache; assert all five `bundled-file` protocols are readable by path, exactly as a `/switchboard-cloud` session reads `improve-plan` today.
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
