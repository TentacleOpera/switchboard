# Make Switchboard's Agent Layer Discoverable in Claude Code (`.claude/` native mirror + CLAUDE.md scaffolding)

## Goal

Switchboard's entire agent-behavior layer — the protocol/registry (`AGENTS.md`), the workflows (`.agents/workflows/*.md`), and the skills (`.agents/skills/*.md`) — is invisible to **Claude Code**. Claude Code auto-loads `CLAUDE.md`, discovers skills in `.claude/skills/`, and never reads `AGENTS.md` or scans `.agents/`. So none of Switchboard's agent assets reach a Claude Code session, even though the extension, its API server, and the `.switchboard/` control plane are all running and reachable.

Close that gap by making the extension scaffold a **native Claude Code layer** alongside the existing Antigravity layer:

1. **Scaffold `CLAUDE.md` with the same machinery as `AGENTS.md`** — the protocol/registry block, managed by the same boundary-marker mechanism, controlled by a target setting (`agents` / `claude` / `both`).
2. **Generate native `.claude/skills/<name>/SKILL.md` mirrors** from the `.agents/` definitions during scaffolding:
   - **Workflows → skills.** Switchboard workflows (`memo`, `chat`, `accuracy`, `improve-plan`) are behavioral-mode prompts, which map directly onto Claude Code skills. Mirroring `memo` → `.claude/skills/memo/SKILL.md` makes `/memo` a **natively-invokable** command in Claude Code — no natural-language alias hack needed.
   - **Runtime skills → skills.** The ClickUp and Linear skill family (and other host-neutral skills) become model-invokable Claude Code skills, reusing the existing `_lib/sb_api_call.sh` helper so the localhost-proxy + host-side-token model is preserved with zero runtime duplication.
3. **Keep `.agents/` as the single source of truth.** The `.claude/` layer is generated from it, version-stamped, and overwritten on version change — exactly as workflow files already are today.

### Problem Analysis & Root Cause

**Root cause:** The agent layer was built solely for the Antigravity host convention (`AGENTS.md` protocol + `.agents/` assets + `/slash` routing + `send_message`/`view_file` tool names). Claude Code's discovery model is entirely different and is never targeted by the scaffolding pipeline.

**Evidence (verified in source):**
- `ensureAgentsProtocol` (`src/extension.ts:2965-3064`) writes the bundled `AGENTS.md` into the workspace `AGENTS.md` only, wrapped in markers `<!-- switchboard:agents-protocol:start/end -->`. No `CLAUDE.md` path exists anywhere in `extension.ts`.
- `ControlPlaneMigrationService.bootstrapControlPlaneLayout` (`src/services/ControlPlaneMigrationService.ts:656`) copies the bundled `.agents/` dir and `AGENTS.md` into the control-plane parent; nothing is written to `.claude/`.
- The skills are **host-neutral bash**. `.agents/skills/clickup_api.md` and `linear_api.md` source `.agents/skills/_lib/sb_api_call.sh`, which walks up to `.switchboard/api-server-port.txt` and `curl`s `http://localhost:<port>/api/clickup` (or `/comment`). No Antigravity-specific agent tool is involved — any Bash-capable agent runs them as-is.
- Switchboard "workflows" are behavioral prompt-modes (e.g. `memo.md` = "append each message, don't analyze"), not multi-agent orchestration. In Claude Code terms these are **skills**, not the `Workflow` tool's JS scripts.

**Why this is the right fix (B, not a pointer file):** A `CLAUDE.md` that merely *points at* `.agents/` would nudge the model to read files but would not make skills appear in Claude Code's skill list, would not make `/memo` invokable, and would still ship Antigravity tool names. Generating a native `.claude/` layer gives first-class discovery: `/memo` works, the clickup/linear skills are model-invokable, and the protocol context loads via `CLAUDE.md`.

## Metadata

- **Tags:** extension, claude-code-interop, scaffolding, skills, workflows
- **Complexity:** 7/10
- **Files affected:** `src/extension.ts`, `src/services/ControlPlaneMigrationService.ts`, `package.json`, `src/webview/setup.html`, `src/services/SetupPanelProvider.ts`, plus a new generator module (e.g. `src/services/ClaudeCodeMirrorService.ts`) and new tests. Source assets in `.agents/` are unchanged (they remain the source of truth).
- **Shipped state:** Additive. With the default target (`agents`), nothing changes for existing users — no `CLAUDE.md`, no `.claude/skills/`. The Claude Code layer appears only when the user opts into `claude` or `both`. Generated artifacts are version-stamped and overwritten on version change (same model as `extension.ts:3300` workflow files), so they self-heal on upgrade.

## User Review Required

Yes. Decisions needed before implementation:

1. **Default target.** Plan defaults `switchboard.protocol.target` to `agents` (no behavior change). Confirm — vs. `both`.
2. **Which skills to mirror.** Plan proposes an explicit allow-list driven by a small manifest, defaulting to: all workflows (as skills) + the ClickUp/Linear family + a few clearly host-neutral utilities (`archive`, `query_archive`, `web_research`, `complexity_scoring`). Confirm the ClickUp/Linear set is the priority and whether the broader utility set should be in v1 or deferred.
3. **`/memo` strategy.** Under B, `/memo` becomes a native skill — so the earlier "start memo capture" natural-language alias is optional. Confirm whether to drop the alias entirely or keep it as a secondary trigger documented in the skill body.

## Complexity Audit

### Routine
- New `switchboard.protocol.target` enum setting in `package.json`.
- Generalizing `ensureAgentsProtocol` to a target-parameterized `ensureProtocolFile` (the marker/idempotency logic is reused verbatim; only the target filename varies).
- Format translation per skill: flat `name.md` (description-only frontmatter) → `name/SKILL.md` with `name` + `description` (+ `allowed-tools: Bash` for shell skills). Body copied unchanged.
- Setup-panel control bound to the target setting.

### Complex / Risky
- **The generator (`.agents/` → `.claude/`).** New code that reads the source manifest, translates frontmatter, writes `.claude/skills/<name>/SKILL.md`, version-stamps, and overwrites-on-version-change. Must be idempotent and must not clobber any user-authored `.claude/skills/`. Mitigation: only manage skills it generated (track via a generated-by marker / manifest file under `.claude/`), never touch unknown skill dirs.
- **Two scaffold call sites.** Activation version-gated migration (`extension.ts:425-445`) and setup scaffolding (`extension.ts:3337-3343`) must both run the new generator + CLAUDE.md path, gated on the target setting, or users get inconsistent state depending on upgrade-vs-resetup.
- **`_lib` path coupling.** Mirrored skills reuse `.agents/skills/_lib/sb_api_call.sh` via the upward-walk for `.agents/skills`. This is correct *as long as `.agents/` is still scaffolded* (it always is). The plan deliberately does NOT copy `_lib` into `.claude/` — single source, single token path. Document this dependency.
- **Protocol-text tool names in CLAUDE.md.** The bundled `AGENTS.md` references `view_file`/`send_message`. In CLAUDE.md these are wrong for Claude Code. Mitigation: inject a short Claude-Code preamble into the CLAUDE.md managed block (map `view_file` → Read tool; note `send_message`/role-routing is Antigravity-only; for skills, just invoke `/<name>` or run the documented bash). The clickup/linear skills work regardless because they shell out.
- **Bash permission prompts.** Claude Code will prompt for the `curl`/`source` commands the skills run. Acceptable, but the plan should optionally emit a `.claude/settings.json` allow-list entry (or document `/fewer-permission-prompts`) so the proxy calls don't prompt every time.

## Edge-Case & Dependency Audit

1. **Skill discovery scope.** Claude Code discovers project skills from `.claude/skills/` at the workspace root plus `~/.claude/skills/`. Generate at the **control-plane root** (same place `AGENTS.md`/`.agents/` land), since that is the workspace opened in Claude Code. Sub-repo-level `.claude/` is out of scope for v1.
2. **Workflows are skills, not `Workflow` scripts.** Do NOT generate `.claude/workflows/` JS scripts — the Switchboard workflows are behavioral prompts. Map them to `.claude/skills/<name>/SKILL.md` so they are user-invocable as `/memo`, `/chat`, etc. Note this explicitly to avoid a wrong implementation.
3. **`/memo` now works natively.** With `memo` as a skill, `/memo` enters capture mode in Claude Code directly. The skill body is the existing `memo.md` content (already host-agnostic: read/append `.switchboard/memo.md`, write plans to `.switchboard/plans/`). The "Memo modal in the Kanban panel" wording fix (tracked in the docs plan) should be in before mirroring, or the mirror inherits the stale text.
4. **Backend-consumed skills must be excluded.** `refine_ticket` is "backend-consumed — not invocable via `skill:`" per AGENTS.md. The manifest skip-list must exclude it and any other UI-triggered-only skills, or Claude Code would surface a skill that does nothing useful when invoked.
5. **Host-side token preserved.** Mirrored clickup/linear skills call the same `/comment` and `/api/*` proxy routes; the extension still stamps the `<!-- switchboard -->` self-marker and holds the token. No secret ever lands in `.claude/`. Verify the generated body keeps the `/comment` route guidance verbatim (do not let agents post raw comments).
6. **API server must be running.** `sb_api_call.sh` fails clearly if `.switchboard/api-server-port.txt` is absent / server unreachable ("Ensure the Switchboard extension is active…"). Same failure mode as Antigravity; nothing new. Document it in the generated skill so a Claude Code user understands the dependency.
7. **Non-destructive CLAUDE.md.** A hand-authored `CLAUDE.md` (memory, imports, no markers, no `# AGENTS.md - Switchboard Protocol` header) must hit the **append** branch and keep all content; subsequent updates do in-place replacement of only the managed block. Verify the legacy-markerless branch (`hasProtocolHeaderLine`) does NOT fire on a normal CLAUDE.md.
8. **Idempotency + version bump.** Re-running with identical source → no-op. On version bump, regenerate skills and update the CLAUDE.md block in place. The generator owns only files it created (manifest-tracked); user-added `.claude/skills/` are never touched.
9. **Skill reload.** Claude Code may need a session reload to pick up newly generated skills. Note in setup-panel help text.
10. **`both` target.** AGENTS.md and CLAUDE.md are independently marker-managed; the `.claude/` skills mirror is independent of AGENTS.md. Running each per selected target is safe and idempotent — no cross-file coupling.
11. **Name sanitation.** Source filenames like `clickup_api.md` → skill name `clickup_api`. Confirm Claude Code skill-name rules (kebab/snake) and sanitize; avoid collisions with built-in or plugin skills.

## Dependencies

- The docs/UI-location fix for `memo.md` (separate plan) ideally lands first so the mirror doesn't carry stale "Memo modal in the Kanban panel" text.
- The generator is consumed by both scaffold call sites; they ship together.

## Adversarial Synthesis

1. **All-or-nothing coherence.** CLAUDE.md scaffolding without the skills mirror gives Claude Code protocol text pointing at assets it can't discover; the skills mirror without CLAUDE.md gives skills with no protocol context. Ship both under the target setting together.
2. **Clobbering user `.claude/`.** The single worst failure. The generator must manage only its own artifacts (generated-by manifest), append-not-overwrite CLAUDE.md, and never delete or rewrite skill dirs it didn't create. Tested explicitly.
3. **I previously mis-scoped skills as "hard."** They are not — they are host-neutral bash against a localhost proxy. The real exclusions are backend-consumed skills (`refine_ticket`) and dead Antigravity-tool references, handled by the manifest skip-list. Getting the include/exclude list right is the actual risk, not the translation.
4. **Token leakage.** Must verify nothing host-side (token, port beyond the runtime file) is baked into generated skills; they must resolve the port at call time via the existing helper, exactly as today.
5. **Two call sites drift / default flip.** Both scaffold paths updated; default stays `agents` so upgrades don't silently start writing `.claude/` into every workspace.

## Proposed Changes

### 1. CLAUDE.md scaffolding parity with AGENTS.md

- **`package.json`** — add `switchboard.protocol.target` enum (`agents` | `claude` | `both`, default `agents`) with enumDescriptions explaining Claude Code reads CLAUDE.md / Antigravity reads AGENTS.md.
- **`src/extension.ts`** — generalize `ensureAgentsProtocol` (2965-3064) into `ensureProtocolFile(workspaceUri, extensionUri, targetFileName, opts)`: bundled source stays `AGENTS.md`; target filename is a parameter; for CLAUDE.md, `opts.preamble` injects a 2-3 line Claude-Code note inside the marker block. All branches (create / skip / in-place update / legacy-markerless / append) unchanged per-target. Keep a thin `ensureAgentsProtocol` wrapper for churn minimization.
- Update both call sites (`425-445` activation migration, `3337-3343` setup) to read the target setting and loop `ensureProtocolFile` over the selected filenames, logging each result.

### 2. Generate native `.claude/skills/` mirror — new `ClaudeCodeMirrorService`

- **Manifest-driven include/exclude.** A small in-repo manifest lists which `.agents/workflows/*.md` and `.agents/skills/*.md` to mirror, with per-entry `allowed-tools`. Defaults: all workflows; ClickUp/Linear family (`clickup_api`, `clickup_attach`, `clickup_create_subpage`, `clickup_create_task`, `clickup_fetch`, `clickup_modify_task`, `linear_api`); selected utilities (`archive`, `query_archive`, `web_research`, `complexity_scoring`). Exclude: `refine_ticket` and other backend-consumed/UI-only skills.
- **Translation.** For each entry, write `.claude/skills/<name>/SKILL.md` with frontmatter `name`, `description` (from source frontmatter), and `allowed-tools` (e.g. `Bash` for proxy skills); body copied verbatim. The body keeps the `_lib/sb_api_call.sh` upward-walk and the `/comment`-route guidance unchanged.
- **No `_lib` duplication.** Generated skills reference the existing `.agents/skills/_lib/sb_api_call.sh`; do not copy it into `.claude/`.
- **Generated-by tracking.** Write a manifest (e.g. `.claude/.switchboard-generated.json`) recording generated skill paths + source version, so regeneration only manages its own artifacts and never touches user-authored skills.
- **Invoke from both scaffold paths**, gated on target ∈ {`claude`, `both`}. Version-stamp and overwrite-on-version-change like workflow files.

### 3. `ControlPlaneMigrationService.bootstrapControlPlaneLayout` — wire the mirror

- After the existing `.agents/` + `AGENTS.md` bootstrap (`ControlPlaneMigrationService.ts:656+`), call the new mirror generator and the CLAUDE.md path for the configured targets, so the Claude Code layer is produced during control-plane setup, not only on activation.

### 4. Setup-panel control

- **`src/webview/setup.html` + `src/services/SetupPanelProvider.ts`** — add a "Protocol / agent file target" control (Antigravity / Claude Code / Both) bound to `switchboard.protocol.target`, wired through the existing settings read/write channel. Help text: which file each host reads; that selecting Claude Code generates `.claude/skills/` + `CLAUDE.md`; that a session reload may be needed; that Bash skills will prompt for permission (point to `/fewer-permission-prompts` or emit an allow-list — see #5).

### 5. (Optional, recommended) Permission allow-list

- When target includes `claude`, optionally scaffold/append a `.claude/settings.json` allow entry for the proxy bash pattern so clickup/linear skills don't prompt on every call. Non-destructive merge; off if a user settings file already manages permissions.

## Verification Plan

### Automated Tests

- **`ensureProtocolFile`** (extend AGENTS.md scaffolding tests): CLAUDE.md create / skip-if-up-to-date / in-place block update / non-destructive append over hand-authored content / malformed-marker guard / legacy-markerless branch does NOT fire for a normal CLAUDE.md / preamble injected only for the CLAUDE.md target.
- **Target-selection helper:** `agents`→`[AGENTS.md]`, `claude`→`[CLAUDE.md]`, `both`→both.
- **`ClaudeCodeMirrorService`:** translation produces valid `SKILL.md` (frontmatter `name`+`description`, `allowed-tools` where expected); body preserved verbatim incl. `_lib` path and `/comment` guidance; manifest skip-list excludes `refine_ticket`; regeneration is idempotent; never modifies/deletes a user-authored `.claude/skills/` dir not in the generated manifest; version bump regenerates.
- **Setting wiring** (mirror existing setup-panel regression tests): control reads/writes `switchboard.protocol.target`.

### Manual Verification

1. **Default unchanged:** target `agents` → no `CLAUDE.md`, no `.claude/skills/`; Antigravity `/memo` still works.
2. **Native `/memo` in Claude Code:** target `claude` (or `both`), re-run setup, open control-plane workspace in Claude Code (reload if needed). Confirm `.claude/skills/memo/SKILL.md` exists and `/memo` enters capture mode — replies begin `[MEMO CAPTURE ACTIVE]`, messages append to `.switchboard/memo.md`, `process memo` creates one plan per entry in `.switchboard/plans/`.
3. **ClickUp skill in Claude Code:** with the extension active and the API server up, confirm the model can invoke `clickup_api` (or it auto-selects on a relevant request), the `_lib` helper resolves the port, a `/api/clickup` GET returns data, and a `/comment` POST posts a comment with the host-stamped self-marker (no token in `.claude/`).
4. **Linear skill:** same against `/api/linear` GraphQL and `/comment` for a Linear issue UUID.
5. **Non-destructive CLAUDE.md:** pre-create CLAUDE.md with custom memory → after scaffolding, custom content intact, managed block appended; re-run → skipped.
6. **User-skill safety:** pre-create a hand-authored `.claude/skills/custom/SKILL.md` → after regeneration it is untouched and absent from the generated manifest.
7. **Server-down failure:** stop the extension/API server → invoking a proxy skill returns the clear "Ensure the Switchboard extension is active…" error, not a crash.
8. **Both-target sync:** target `both`, bump source version → AGENTS.md + CLAUDE.md blocks update in place and `.claude/skills/` regenerates; user content preserved.
9. **Excluded skills:** confirm `refine_ticket` is NOT generated into `.claude/skills/`.
