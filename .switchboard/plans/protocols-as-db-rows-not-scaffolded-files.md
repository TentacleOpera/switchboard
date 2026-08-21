# Protocols become database rows injected into prompts, not files scaffolded into every repo

## Goal

Make the store the single home for the 32 protocol definitions and stop shipping them as a directory inside every user's workspace. Protocols are UI-triggered instructions the extension delivers; nothing discovers them by scanning the filesystem, so nothing requires them to be files.

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
- Changing protocol *content*.
- Re-litigating the token-cost goal; it is already achieved and must stay achieved.
- Removing `RETIRED_WORKFLOW_PATH_MAP` — it stays as the read-time guard for persisted stale paths.

## Metadata

**Complexity:** 6
**Tags:** infrastructure, refactor, database, api, backend, reliability

## User Review Required

Yes — one decision, and it is the crux.

**How does a path-directive protocol reach the agent once there is no file?** Sizes decide it: 424K over 32 files, median 4KB, but `terminal-coder-dispatch` is 44KB, `switchboard-orchestrator` 40KB, `switchboard-orchestration` 28KB, `improve-plan` 16KB — and the largest are the most frequently dispatched.

- **(a) Inline the body** into the prompt instead of a path. Clean, host-agnostic, no filesystem at all. But 40KB+ into every coder dispatch is a large standing cost, and it re-adds the per-turn token cost the original plan was removing.
- **(b) Materialise on demand** to `~/.switchboard/cache/protocols/<name>/SKILL.md` and emit that absolute path. Prompt stays a one-liner, repo stays clean, agent neither knows nor cares about the origin.
- **(c) Per-protocol, declared on the row** — a `delivery` column with `inline` or `materialize`.

**Recommendation: (c), defaulting to `materialize`, with `inline` for small protocols where a round-trip to disk buys nothing.**

**A constraint that must shape the answer regardless:** a materialised `~/.switchboard/` path does not exist for a remote or cloud agent — a Claude Code web session cannot read the user's home directory. So delivery must vary by **host**, not only by protocol: local hosts may materialise, remote hosts must inline. This is the same local/remote split that runs through the rest of the storage programme, and it means (b) alone is not sufficient.

## Complexity Audit

### Routine

- Adding `delivery` (`inline` | `materialize`) and `body` to the `control_plane` table introduced by the scaffold plan.
- Seeding the 32 protocols from the extension bundle at activation, keyed by name and version.
- A resolver — `resolveProtocol(name, host)` — returning either the body or a materialised absolute path.
- Materialising into `~/.switchboard/cache/protocols/<name>/SKILL.md` on demand, with the content hash as the cache key.
- Deleting `.agents/protocols/` from the repo and from the seeding crawl.

### Complex / Risky

- **60 reference sites across 9 files.** Every `path.join('.agents', 'protocols', …)` becomes a resolver call. The single content-injection site is trivial; the ~18 directive sites each need their prompt string rebuilt, because the emitted text changes shape (a path that is now absolute, or an inlined body). `DEFAULT_PLANNER_WORKFLOW` and `DEFAULT_FEATURE_PLANNER_WORKFLOW` in `agentPromptBuilder.ts` are persisted-config defaults, so changing them interacts with `RETIRED_WORKFLOW_PATH_MAP`.
- **Persisted user config points at file paths.** A user may have a customised planner workflow path stored in config. That path must keep resolving — extend `RETIRED_WORKFLOW_PATH_MAP` with `.agents/protocols/*` keys the same way the review fix added `.switchboard/protocols/*` keys, and make `normalizeRetiredWorkflowPath` map a stale path to a protocol *name* rather than another path.
- **Local overrides must survive.** A user who edited `.agents/protocols/improve-plan/SKILL.md` has customised behaviour. On migration, any file whose hash does not match the bundled version must be imported as an override row, never discarded. This is the difference between a migration and data loss.
- **Host detection has to be right.** Choosing `materialize` for a remote agent hands it a path it cannot read, and the failure is silent — the agent reports it cannot find the file, or worse, proceeds without the protocol. The resolver must take the host as an explicit argument, never infer it from ambient state.
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

**"Materialising to the home directory just moves the directory."** It moves it out of every repository into one machine-local cache, keyed by content hash, prunable, and never committed. That is the whole ask. And for remote hosts, where no such cache exists, inlining is the fallback — which is why both modes have to exist.

## Proposed Changes

1. **`control_plane` table gains `body`, `delivery`, `version`, `content_hash`, and a nullable `override_body`** — extending the scaffold plan's schema rather than adding a second table.
2. **Bundle seeding**: the 32 protocols are compiled into the extension and upserted at activation by name and version, with hash comparison so an override row is never overwritten.
3. **`resolveProtocol(name, host)`** — the single resolution point. Returns the body for `inline` or an absolute materialised path for `materialize`, forces `inline` when the host is remote, and validates any emitted path against the cache root.
4. **60 call sites across 9 files** rewritten to call the resolver instead of constructing `path.join('.agents', 'protocols', …)`.
5. **`RETIRED_WORKFLOW_PATH_MAP` extended** with `.agents/protocols/*` keys; `normalizeRetiredWorkflowPath` maps a stale path to a protocol *name*.
6. **Materialisation cache** at `~/.switchboard/cache/protocols/<content-hash>/SKILL.md`, atomic write, idle pruning.
7. **`.agents/protocols/` deleted** from the repo and from the seeding crawl; `protocol-catalog.json` regenerated or retired; `.switchboard-bundled.json` protocol entries dropped in favour of the version column.

### Migration

Import from all three historical locations, hash-compare, preserve mismatches as override rows, archive each file as `SKILL.md.migrated.bak`, never unlink.

## Verification Plan

### Automated Tests

- **Goal invariant (the assertion the original plan lacked):** assert `.agents/protocols/` does not exist in the repo, is absent from a packaged VSIX, and appears in no `path.join` in `src/`. This test is the point of the plan — it must fail before the work and pass after, and it is what would have caught the destination change.
- **Ships and resolves on a clean install:** unpack a built VSIX into a fresh workspace with no `.agents/` at all; assert every one of the 32 protocols resolves. This is the check that was missing when the earlier version passed grep, compile, lint and manual review while being dead on every user install.
- **Delivery per host:** for a `materialize` protocol, assert a local host receives a readable absolute path under the cache root, and a remote host receives the inlined body and no path.
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
