# Stop Skill-Discovery Spam in Antigravity & Devin by Removing Source Frontmatter

## Goal

Every Switchboard skill — including pure background machinery like `switchboard-contracts`, `web-research`, `complexity-scoring`, and the `clickup-*`/`linear-*` proxies — now shows up in the slash-command menu in filesystem-scanning hosts (Antigravity, Devin). The menu is unusable noise. Restore the pre-regression behavior: only the intended front doors surface, and background skills are reached the way they always were — by explicit reference from workflows and prompts.

### Problem & root-cause analysis

**What changed.** The plan `feature_plan_20260624112804_claude-code-native-discovery-mirror.md` (shipped 2026-06-24) gave every skill a directory `.agents/skills/<name>/SKILL.md` with `name` + `description` YAML frontmatter. The intent was to power **Claude Code** native discovery through `ClaudeCodeMirrorService`, which mirrors selected `.agents/` sources into `.claude/skills/`. To keep background skills out of Claude Code's slash menu, that plan relied on two frontmatter gates emitted into the **mirror output**: `disable-model-invocation: true` (slash-only) and `user-invokable: false` (model-only, hidden from slash).

**Why it broke elsewhere.** Those two gates are **Claude-Code-only conventions**. Antigravity and Devin do not read them. Per the authoritative host doc (`docs/imported_document_2026_07_09t00_31_11.md:10-19`), Antigravity auto-discovers **any** `[.agents]/skills/<name>/SKILL.md` whose frontmatter contains `name` and `description`, and registers it — full stop. There is **no** frontmatter field those hosts honor to suppress a discovered skill. So the act of giving background skills valid discovery frontmatter *is* the entire cause. They worked perfectly before the frontmatter existed, because they were (and still are) reached by explicit reference — workflows `view_file` them and prompts carry `skill: "<name>"` directives.

**The precise defect.** The `invocation` category in `MIRROR_MANIFEST` (`ClaudeCodeMirrorService.ts:46-169`) only affects the **`.claude/` mirror output** frontmatter (`buildSkillMd`, `:315-320`). It does nothing to the **`.agents/` source files** that Antigravity/Devin scan. So a skill tagged `no-user` (meant to be hidden) still ships a fully discoverable source `SKILL.md`. There is no code path that reconciles source-file discoverability with the intended invocation category — the two surfaces drifted apart.

### Grounded mechanism facts (verified in code, 2026-07-11)

- **Source resolution is manifest-driven, not frontmatter-driven.** `resolveSourceFile` (`ClaudeCodeMirrorService.ts:292-304`) joins `entry.source` to `.agents/`; if it's a directory it reads `<dir>/SKILL.md`, if it's a flat path it reads the file directly. The mirror does **not** parse frontmatter to locate or name the file.
- **Name comes from the manifest, description falls back to the manifest.** `buildSkillMd` (`:306-308`) sets `name: entry.name` (never the parsed name) and `description = parsed.description || entry.descriptionFallback || ''`. Therefore, if a source file has **no** frontmatter, the mirror still produces a correct `.claude/skills/<name>/SKILL.md` **provided** `entry.descriptionFallback` is populated. (Note: because `buildSkillMd` uses `entry.name`, the `firstH1` name fallback at `:351-352` never affects mirror output for manifest entries — the manifest name is authoritative.)
- **`parseSource` already tolerates a missing frontmatter block — no code change needed.** Verified: `parseSource` (`:231-252`) returns `{ body: normalized }` when the content does not start with `---`. A frontmatter-less source therefore yields an empty `description` and the full body — exactly what we want, so `descriptionFallback` flows through unchanged.

  > **Superseded:** (original Step 3 hedge) "If `parseSource` requires a delimiter, adjust it to tolerate a missing frontmatter block rather than adding empty frontmatter back."
  > **Reason:** Reading the code resolves the hypothetical. `parseSource` at `:233` guards on `normalized.startsWith('---')` and returns `{ body: normalized }` otherwise. It does not require a delimiter; no adjustment is needed.
  > **Replaced with:** No change to `parseSource` is required. Step 3 becomes a pure content edit (delete the leading `---`…`---` block from each target source), plus a verification assertion that the mirror still emits a non-empty description from the fallback.

- **Front doors are workflows, not skills.** `switchboard` ← `workflows/switchboard-index.md`, `memo` ← `workflows/memo.md` (manifest `:49-50`). Antigravity does not auto-discover `.agents/workflows/*.md` (host doc `:28-37`); those are user-typed slash commands. So stripping skill frontmatter does not touch the front doors.
- **Current state (measured on disk 2026-07-11):** **31** `.agents/skills/<name>/SKILL.md` directories currently begin with a `---` frontmatter block (the spam). All 31 are covered by `MIRROR_MANIFEST` today (no orphan discoverable dir exists right now), but Antigravity scans the **filesystem**, not the manifest — see Step 1 for why enumeration must key on the disk scan, not the manifest alone. `refine_ticket`/`refine_feature` are flat `.md` sources (not `<dir>/SKILL.md`), so they are already discovery-invisible. Legacy snake_case flat duplicates (e.g. `web_research.md`) predate the regression and are also already invisible.

## Non-Goals

- Any change to front-door identity, naming, or routing (that is the companion plan, `consolidate-switchboard-front-doors.md`).
- Removing or renaming skills.
- Touching `.agents/workflows/*.md`.
- Cleaning up the legacy snake_case flat-file duplicates (tracked separately; out of scope here — they are already discovery-invisible and harmless to this fix).
- Changing any `invocation` category in `MIRROR_MANIFEST`. Category changes (which affect the `.claude/` gate frontmatter) belong to the companion plan's B/D/E work. This plan's only manifest edits are adding `descriptionFallback` values.

## Proposed Change

For every background skill sourced from a `.agents/skills/<name>/` **directory**, remove the YAML frontmatter block from its `SKILL.md`, and preserve its Claude Code description by moving that string into the manifest's `descriptionFallback`. This reverts the discovery regression in Antigravity/Devin while leaving Claude Code's mirror output byte-for-byte equivalent.

### Step 1 — Enumerate the target set (scan disk ∪ manifest, not manifest-only)

The discovery surface Antigravity scans is the **filesystem** (`.agents/skills/*/SKILL.md` with frontmatter), so the target set MUST be derived from a disk scan, reconciled against the manifest:

1. Scan `.agents/skills/*/SKILL.md`; the target set is every one whose first line is `---` (frontmatter present). This is the authoritative list of what currently spams Antigravity (31 files today).
2. Cross-check against `MIRROR_MANIFEST`: for each target file, find every manifest entry whose `source` resolves to it. This is many-to-one — see Step 2.
3. If a disk dir has discoverable frontmatter but **no** manifest entry (none today, but possible in future), it still spams Antigravity and MUST be stripped; its Claude Code presence is unaffected (the mirror only emits manifest entries). Log any such orphan in completion notes.

   > **Superseded:** (original Step 1) "Target = every `MIRROR_MANIFEST` entry whose `source:` points at a `.agents/skills/<name>/` directory."
   > **Reason:** Manifest-driven enumeration keys on the wrong surface. Antigravity discovers from the filesystem; a skill dir present on disk but absent from the manifest would keep spamming and be silently missed. The manifest is the CC mirror's input, not Antigravity's.
   > **Replaced with:** Enumerate from the disk scan (`.agents/skills/*/SKILL.md` with leading `---`), then reconcile to the manifest for the fallback backfill. Disk is the source of truth for "what spams"; the manifest is the source of truth for "what CC needs a fallback for."

### Step 2 — Backfill `descriptionFallback` before stripping (handle shared sources)

For each target source file, copy the `description:` value currently in its frontmatter into `descriptionFallback` on **every** manifest entry whose `source` resolves to that file — not just the first. Several sources are referenced by more than one manifest entry (the discoverable `/switchboard-*` aliases at `:149-168` reuse canonical sources):

| Shared source dir | Manifest entries that resolve to it |
| :-- | :-- |
| `skills/web-research` | `web-research` (has fallback), `switchboard-research` (has fallback) |
| `skills/notion-api` | `notion-api` (**needs**), `switchboard-notion` (**needs**) |
| `skills/linear-api` | `linear-api` (**needs**), `switchboard-linear` (**needs**) |
| `skills/clickup-api` | `clickup-api` (**needs**), `switchboard-clickup` (**needs**) |
| `skills/kanban_operations` | `kanban-operations` (**needs**), `switchboard-kanban` (**needs**) |
| `skills/improve-remote-plan` | `improve-remote-plan` (**needs**), `switchboard-remote-plan` (**needs**) |

Once a shared source's frontmatter is stripped, **all** entries pointing at it lose their parsed description simultaneously, so every one needs a fallback or its `.claude` description goes blank.

**Entries that currently LACK `descriptionFallback` and therefore MUST be backfilled** (derived from the manifest, 2026-07-11): `switchboard-manage`, `improve-remote-plan`, `create-feature`, `create-feature-from-plans`, `clickup-api`, `clickup-fetch`, `clickup-create-task`, `clickup-modify-task`, `clickup-attach`, `clickup-create-subpage`, `linear-api`, `clickup-move-task`, `linear-move-issue`, `notion-api`, `generate-diagram`, `kanban-operations`, `worktree-cleanup`, `group-into-features`, `switchboard-orchestration`, `query-archive`, `query-switchboard-kanban`, `query-kanban-plans`, `switchboard-contracts`, `switchboard-mcp`, and the aliases `switchboard-remote-plan`, `switchboard-notion`, `switchboard-linear`, `switchboard-clickup`, `switchboard-kanban`.

**Entries that already have a fallback (leave as-is):** `get-tickets`, `archive`, `web-research`, `deep-planning`, `complexity-scoring`, `advise-research`, `constitution-builder`, `tuning`, `switchboard-research`.

This is the load-bearing step: it is what keeps Claude Code's on-demand model-invocation working after the source frontmatter is gone. Produce the concrete pairing programmatically (resolve each source → its entries) so the list can't drift, then assert no target entry is left with an empty resolved description (`parsed.description || descriptionFallback` must be non-empty for every entry).

### Step 3 — Strip the source frontmatter

Remove the leading `---`…`---` YAML block from each target `.agents/skills/<name>/SKILL.md`, leaving the markdown body intact. No `parseSource` change is required (see Grounded mechanism facts — it already returns all-body with an empty description for a frontmatter-less file). Do **not** replace the block with empty/partial frontmatter — a residual `name:` or `description:` line would re-satisfy Antigravity's discovery test and re-introduce the spam.

### Step 4 — Guarantee nothing is orphaned

Antigravity loses *semantic auto-invocation* of these skills once they're undiscoverable; they become reachable only by explicit reference. For each target skill, confirm at least one live reference exists (a workflow `view_file`/link, a `skill: "<name>"` directive, or the `AGENTS.md` skills table). For any skill reachable **only** by former auto-invocation, add an explicit reference in the owning workflow/prompt. Record the reference audit in the plan's completion notes.

> **Coordination with the companion plan:** the companion (`consolidate-switchboard-front-doors.md`) rewrites the `AGENTS.md`/`CLAUDE.md` registry + skills table (its section F). Any reference this step adds to the skills table MUST survive that rewrite — flag added references in completion notes so the companion's doc pass preserves them rather than reverting to the two-door surface and dropping them.

### Step 5 — Regenerate and verify

Rebuild the VSIX so `ClaudeCodeMirrorService` regenerates `.claude/skills/`. Verify:
- **Claude Code:** every target `.claude/skills/<name>/SKILL.md` still has the correct `name`, a non-empty `description` (from fallback), and the same `disable-model-invocation`/`user-invokable` gate as before — i.e. mirror output is unchanged. Diff the regenerated `.claude/skills/` against the pre-change output; the only expected delta is the `description` line source (parsed → fallback), which should be byte-identical if the fallback string matches the old frontmatter value.
- **Antigravity/Devin:** none of the target skills appear in the slash menu / `<skills>` block; only the front-door workflows (`switchboard`, `memo`) and the deliberate workflow verbs remain typeable.
- **Reachability:** explicitly invoking a stripped skill by name still loads its body in all hosts.

## Migration & Compatibility

- These are control-plane source files, not shipped user state — no user-data migration is required (per repo migration rule, only released user state migrates; this is dev/control-plane content).
- Do **not** edit any historical `MIGRATION_Vnn_SQL` bodies; this change is confined to `.agents/skills/*/SKILL.md` and the `descriptionFallback` fields of `MIRROR_MANIFEST`.
- The mirror regenerates `.claude/skills/` on rebuild; stale `.claude/` output is irrelevant to development/testing (only the installed VSIX matters).

## User Review Required

- None. The target set, the backfill list, and the strip mechanism are all fully determined by the code and the host-discovery contract. This is a mechanical revert of a regression with a verifiable no-delta check on the Claude Code side.

## Metadata

**Complexity:** 4
**Tags:** bugfix, refactor, infrastructure

## Complexity Audit

### Routine
- The edit itself is mechanical: delete a frontmatter block from ~31 files; add ~29 `descriptionFallback` strings to the manifest.
- No new patterns, no schema/DB changes, no user-state migration.
- Reuses the existing mirror pipeline unchanged (no `parseSource`/`buildSkillMd` code edits).

### Complex / Risky
- **Shared-source fan-out** (Step 2): stripping one source blanks the description for *every* alias entry pointing at it. Missing one alias → a blank CC description. Mitigated by resolving source→entries programmatically and the empty-description assertion.
- **Enumeration surface mismatch** (Step 1): keying on the manifest instead of the disk scan would silently miss a future orphan dir. Mitigated by scanning disk ∪ manifest.
- **Idempotency of the strip**: leaving residual `name:`/`description:` lines re-arms Antigravity discovery. Mitigated by asserting the stripped file no longer begins with `---`.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Single-pass control-plane file edits; no concurrent writers to `.agents/skills/*` or the manifest during the change.
- **Security:** None. No auth, network, or user-data surface touched.
- **Side Effects:** Antigravity/Devin lose *auto-invocation* of the stripped skills (intended). Claude Code output must be unchanged (verified by diff). Any skill previously reached *only* by auto-invocation would become unreachable in Antigravity — Step 4's reference audit is the guard.
- **Dependencies & Conflicts:** Shares two surfaces with the companion plan — `MIRROR_MANIFEST` (this plan edits only `descriptionFallback`; companion edits `invocation` categories) and `AGENTS.md`/`CLAUDE.md` (this plan may add reference-audit entries; companion rewrites the registry). Both are complementary given the sequence (this plan first). `switchboard-manage`, `switchboard-mcp`, `group-into-features`, `constitution-builder`, and `tuning` are directory skills stripped here **and** re-touched by the companion's B/D/E (category change + routing) — no contradiction, but the companion must treat their source frontmatter as already gone.

## Dependencies

- `sess_frontmatter_strip — this plan` — no upstream session dependency; this is the independently-shippable base of the feature.

## Adversarial Synthesis

Key risks: (1) a blank Claude Code description if any alias entry sharing a stripped source is missed in the backfill; (2) a future orphan skill dir escaping a manifest-only enumeration; (3) an accidental residual frontmatter line re-arming discovery. Mitigations: resolve source→entries programmatically and assert every entry's resolved description is non-empty; enumerate from the disk scan reconciled to the manifest; assert each stripped file no longer starts with `---`; diff the regenerated `.claude/skills/` for a byte-level no-op on the Claude Code side.

## Proposed Changes

### `.agents/skills/<name>/SKILL.md` (31 target files)
- **Context:** Each currently opens with a `---` frontmatter block carrying `name` + `description`, which is what Antigravity/Devin scan and register.
- **Logic:** Delete the leading `---`…`---` block only; leave the markdown body byte-for-byte intact.
- **Implementation:** Enumerate via the Step 1 disk scan; for each, remove lines from the first `---` through the matching closing `---`.
- **Edge Cases:** Do not leave partial/empty frontmatter. Assert post-edit the file no longer begins with `---`. Flat `.md` skill sources (`refine_ticket.md`, `refine_feature.md`) are NOT targets (already invisible).

### `src/services/ClaudeCodeMirrorService.ts` — `MIRROR_MANIFEST` (`:46-169`)
- **Context:** `buildSkillMd` (`:307`) resolves description as `parsed.description || entry.descriptionFallback || ''`. With source frontmatter gone, `parsed.description` is empty, so the fallback carries the CC description.
- **Logic:** Add a `descriptionFallback` string (equal to the old source `description:` value) to every entry listed in Step 2 that lacks one, including alias entries sharing a stripped source.
- **Implementation:** Add-only edits to the entry object literals; no structural or `invocation`-category changes.
- **Edge Cases:** Shared sources (`notion-api`↔`switchboard-notion`, etc.) require the fallback on *both* entries. Do not touch `invocation`, `allowedTools`, `source`, or `name`.

## Verification Plan

### Automated Tests
- Session directive: **skip compilation and automated test runs.** Verification is by inspection + mirror-output diff.
- **Manifest completeness assertion (manual/scripted):** for every manifest entry whose `source` resolves to a stripped file, assert `parsed.description || descriptionFallback` is a non-empty string. Zero empties permitted.
- **Strip idempotency check:** assert no target `.agents/skills/*/SKILL.md` begins with `---` after the edit.
- **Mirror no-op diff:** regenerate `.claude/skills/` (via VSIX rebuild or a direct `generateClaudeMirror` run) and diff against the pre-change output; the `name`, gate lines, and `allowed-tools` must be identical, and each `description` must match the prior value now sourced from the fallback.
- **Antigravity discovery check:** confirm none of the 31 stripped skills appear in the host's `<skills>` / slash menu, while `switchboard` and `memo` still do.
- **Reachability check:** explicitly load a stripped skill (e.g. `skill: "web-research"`) and confirm the body loads in Claude Code and Antigravity.

---

**Recommendation:** Complexity 4 → **Send to Coder.** Ready to execute; no open decisions. Land this before the companion front-door plan.
