# Make Switchboard's Agent Layer Discoverable in Claude Code (`.claude/` native mirror + CLAUDE.md scaffolding)

## Goal

Switchboard's entire agent-behavior layer — the protocol/registry (`AGENTS.md`), the workflows (`.agents/workflows/*.md`), and the skills (`.agents/skills/*.md`) — is invisible to **Claude Code**. Claude Code auto-loads `CLAUDE.md`, discovers skills in `.claude/skills/`, and never reads `AGENTS.md` or scans `.agents/`. So none of Switchboard's agent assets reach a Claude Code session, even though the extension, its API server, and the `.switchboard/` control plane are all running and reachable.

Close that gap by making the extension scaffold a **native Claude Code layer** alongside the existing Antigravity layer:

1. **Scaffold `CLAUDE.md` with the same machinery as `AGENTS.md`** — the protocol/registry block, managed by the same boundary-marker mechanism, controlled by a target setting (`agents` / `claude` / `both`).
2. **Generate native `.claude/skills/<name>/SKILL.md` mirrors** from the `.agents/` definitions during scaffolding:
   - **Workflows → skills.** Switchboard workflows (`memo`, `chat`, `accuracy`, `improve-plan`) are behavioral-mode prompts, which map directly onto Claude Code skills. Per verified research (Claude Code 2.1.0+, see Research Findings), a project skill at `.claude/skills/<name>/SKILL.md` is exposed **both** as a literal `/<name>` slash command **and** as a model-auto-invocable tool (the `Skill` tool) keyed on its frontmatter `description`. So mirroring `memo` → `.claude/skills/memo/SKILL.md` makes `/memo` a **native slash command** in Claude Code — no natural-language alias hack needed — *and* lets the model auto-enter capture mode when the description matches.
   - **Runtime skills → skills.** The ClickUp and Linear skill family (and other host-neutral skills) become Claude Code skills, reusing the existing `_lib/sb_api_call.sh` helper so the localhost-proxy + host-side-token model is preserved with zero runtime duplication. Per the research's Trade-off Evaluation, **side-effecting proxy skills** (clickup/linear write/comment routes) should set `disable-model-invocation: true` so the proxy is only hit on an explicit `/clickup-api` (etc.) command, not auto-triggered from a semantic match; **pure info-retrieval skills** should set `user-invokable: false` with a rich description so the model pulls them on demand without slash-command clutter. See Proposed Changes §2 for the per-skill invocation-mode manifest.
3. **Keep `.agents/` as the single source of truth.** The `.claude/` layer is generated from it, version-stamped, and overwritten on version change — exactly as workflow files already are today.

### Problem Analysis & Root Cause

**Root cause:** The agent layer was built solely for the Antigravity host convention (`AGENTS.md` protocol + `.agents/` assets + `/slash` routing + `send_message`/`view_file` tool names). Claude Code's discovery model is entirely different and is never targeted by the scaffolding pipeline.

**Evidence (verified in source):**
- `ensureAgentsProtocol` (`src/extension.ts:2965+`) writes the bundled `AGENTS.md` into the workspace `AGENTS.md` only, wrapped in markers `<!-- switchboard:agents-protocol:start/end -->`. No *scaffolding* path for `CLAUDE.md` exists.
- **Nuance (do not duplicate this):** the extension already *reads, writes, and displays* `CLAUDE.md` and `AGENTS.md` per workspace through the governance-file system — `loadConstitutionFiles` / `readConstitutionFile` / `saveConstitutionFile` / `deleteConstitutionFile` in `PlanningPanelProvider.ts`, keyed by `governanceFile: 'constitution' | 'claude' | 'agents'`, surfaced in the project panel's **System tab** (see plan `feature_plan_20260624_113751_split-constitution-system-tab.md`). So the gap this plan closes is **generation/scaffolding** of `CLAUDE.md` and the `.claude/` skill mirror — *not* editing/display, which already exists. The new scaffolder must coexist with that editing surface (see Edge-Case audit).
- `ControlPlaneMigrationService.bootstrapControlPlaneLayout` (`src/services/ControlPlaneMigrationService.ts:656`) copies the bundled `.agents/` dir and `AGENTS.md` into the control-plane parent; nothing is written to `.claude/`.
- The skills are **host-neutral bash**. `.agents/skills/clickup_api.md` and `linear_api.md` source `.agents/skills/_lib/sb_api_call.sh`, which walks up to `.switchboard/api-server-port.txt` and `curl`s `http://localhost:<port>/api/clickup` (or `/comment`). No Antigravity-specific agent tool is involved — any Bash-capable agent runs them as-is.
- Switchboard "workflows" are behavioral prompt-modes (e.g. `memo.md` = "append each message, don't analyze"), not multi-agent orchestration. In Claude Code terms these are **skills**, not the `Workflow` tool's JS scripts.

**Why this is the right fix (B, not a pointer file):** A `CLAUDE.md` that merely *points at* `.agents/` would nudge the model to read files but would not make skills appear in Claude Code's skill list, would not make `/memo` invokable, and would still ship Antigravity tool names. Generating a native `.claude/` layer gives first-class discovery: `/memo` works, the clickup/linear skills are model-invokable, and the protocol context loads via `CLAUDE.md`.

## Metadata

- **Tags:** [feature, cli, backend, infrastructure]
- **Complexity:** 7/10
- **Files affected:** `src/extension.ts`, `src/services/ControlPlaneMigrationService.ts`, `package.json`, `src/webview/setup.html`, `src/services/SetupPanelProvider.ts`, plus a new generator module (e.g. `src/services/ClaudeCodeMirrorService.ts`) and new tests. Source assets in `.agents/` are unchanged (they remain the source of truth).
- **Shipped state:** Additive. With the default target (`agents`), nothing changes for existing users — no `CLAUDE.md`, no `.claude/skills/`. The Claude Code layer appears only when the user opts into `claude` or `both`. Generated artifacts are version-stamped and overwritten on version change (same model as `extension.ts:3300` workflow files), so they self-heal on upgrade.

## User Review Required

Decisions — **all resolved (2026-06-24)**:

1. **Default target — RESOLVED: `both`.** `switchboard.protocol.target` defaults to `both` (scaffold AGENTS.md *and* CLAUDE.md + `.claude/` mirror). This is a behavior change for existing users on upgrade — see Edge-Case audit for the non-destructive guarantees that make it safe.
2. **Which skills to mirror — RESOLVED:** mirror the full cleaned-up set (see the finalized manifest in Proposed Changes §2). The skill inventory was cleaned this session — 7 skills deleted (`deprecated/`, `clickup_mcp`, `apply_patch`, `gemini_interactive`, `architectural_diagrams`, `convert_to_epic`, `fix_plans_dropdown`), leaving 21 skills + the `_lib` helper.
3. **`/memo` strategy — RESOLVED: keep `start memo capture`.** `memo` becomes a native skill so `/memo` works in Claude Code, **and** the skill body preserves `start memo capture` as a documented plain-language trigger (per user direction). Both entry forms are honored.

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
2. **Workflows are skills, not `Workflow` scripts.** Do NOT generate `.claude/workflows/` JS scripts — the Switchboard workflows are behavioral prompts. Map them to `.claude/skills/<name>/SKILL.md` so they are user-invocable as `/memo`, `/switchboard-chat`, etc. Note this explicitly to avoid a wrong implementation.
3. **`/memo` now works natively.** With `memo` as a skill, `/memo` enters capture mode in Claude Code directly. The skill body is the existing `memo.md` content (already host-agnostic: read/append `.switchboard/memo.md`, write plans to `.switchboard/plans/`). The "Memo modal in the Kanban panel" wording fix (tracked in the docs plan) should be in before mirroring, or the mirror inherits the stale text.
4. **Only `_lib` is excluded (not `refine_ticket`).** Verified this session: `refine_ticket` is agent-actionable — its "Refine" button merely copies the skill content as a clipboard prompt for an agent to run (`copyRefinePrompt`), so it mirrors fine and is invocable in Claude Code. The only true exclusion is `_lib` (the shared `sb_api_call.sh` helper, referenced by proxy skills via upward-walk — never a skill itself). All genuinely orphaned/superseded skills were already deleted from source this session, so the manifest doesn't need a skip-list beyond `_lib`.
5. **Host-side token preserved.** Mirrored clickup/linear skills call the same `/comment` and `/api/*` proxy routes; the extension still stamps the `<!-- switchboard -->` self-marker and holds the token. No secret ever lands in `.claude/`. Verify the generated body keeps the `/comment` route guidance verbatim (do not let agents post raw comments).
6. **API server must be running.** `sb_api_call.sh` fails clearly if `.switchboard/api-server-port.txt` is absent / server unreachable ("Ensure the Switchboard extension is active…"). Same failure mode as Antigravity; nothing new. Document it in the generated skill so a Claude Code user understands the dependency.
7. **Non-destructive CLAUDE.md.** A hand-authored `CLAUDE.md` (memory, imports, no markers, no `# AGENTS.md - Switchboard Protocol` header) must hit the **append** branch and keep all content; subsequent updates do in-place replacement of only the managed block. Verify the legacy-markerless branch (`hasProtocolHeaderLine`) does NOT fire on a normal CLAUDE.md.
8. **Idempotency + version bump.** Re-running with identical source → no-op. On version bump, regenerate skills and update the CLAUDE.md block in place. The generator owns only files it created (manifest-tracked); user-added `.claude/skills/` are never touched.
9. **Skill reload — verified (Claude Code 2.1.0+).** Skills under `.claude/skills/` are **hot-reloaded mid-session** via an internal file-watcher; the next user turn reflects new/modified `SKILL.md` files with no restart. **However**, `CLAUDE.md` and `.claude/settings.json` are loaded only at session initialization and **require a session restart** to take effect. So: newly generated skills appear instantly, but a freshly scaffolded `CLAUDE.md` (protocol block) and the permission allow-list only apply after the user restarts the Claude Code session. Note this split in setup-panel help text ("skills appear instantly; restart Claude Code to load CLAUDE.md and permission settings").
10. **`both` target.** AGENTS.md and CLAUDE.md are independently marker-managed; the `.claude/` skills mirror is independent of AGENTS.md. Running each per selected target is safe and idempotent — no cross-file coupling.
11. **Name sanitation — verified.** The Agent Skills standard uses **lowercase kebab-case**. Source filenames are snake_case (`clickup_api.md`, `query_switchboard_kanban.md`). The generator MUST sanitize the directory name (and thus the slash command) to kebab-case: `clickup_api` → `clickup-api` → `/clickup-api`; `query_switchboard_kanban` → `query-switchboard-kanban`. The `name` frontmatter field may keep a human-readable display name, but the **directory name** (which defines the slash command) must be kebab-case. Avoid collisions with built-in commands (`help`, `compact`, `clear`) and bundled skills (`debug`, `code-review`) — none of the 25 mirrored names collide (verified against the research's collision list). Record the snake→kebab mapping in the generated manifest so regeneration is stable.
12. **Coexistence with the System-tab governance editor.** The extension already reads/writes/displays `CLAUDE.md` and `AGENTS.md` per workspace via the governance-file system (System tab — `feature_plan_20260624_113751_split-constitution-system-tab.md`; `saveConstitutionFile` with `governanceFile: 'claude' | 'agents'` writes the **whole** file from a textarea). Two interactions to handle:
    - **Scaffolder owns the managed block; the System tab can edit the whole file.** `ensureProtocolFile` rewrites only the marker-delimited block on version bump. Edits a user makes *outside* the markers in the System tab are preserved; edits *inside* the managed block get reverted on the next scaffold. Recommend the System tab visually flag the `<!-- switchboard:agents-protocol:* -->` region as auto-managed (read-only hint), so users don't lose in-block edits. At minimum, document it.
    - **CLAUDE.md auto-appears in the System tab once scaffolded.** With default `both`, scaffolding creates `CLAUDE.md`, and `loadConstitutionFiles` already returns its `'claude'` status — so it surfaces in the System tab's CLAUDE.md sub-tab automatically. This is desirable synergy (no extra wiring), but means the System tab's CLAUDE.md empty-state will now rarely show on a scaffolded workspace. No code change needed; note for QA.
13. **`hasProtocolHeaderLine` collision with a CLAUDE.md that pastes AGENTS.md content.** The legacy-markerless branch fires on the header line `# AGENTS.md - Switchboard Protocol`. Since the CLAUDE.md managed block is built from the same bundled `AGENTS.md` source, a CLAUDE.md whose managed block was stripped of markers but kept that header could be mis-detected as legacy and fully replaced. Low probability, but the CLAUDE.md preamble/header should differ from the AGENTS.md header to keep the legacy heuristic unambiguous per-target.

## Dependencies

- `memo.md`'s UI-location text was already corrected this session ("Memo sub-tab in the sidebar"), so the mirror will not carry the stale "Memo modal in the Kanban panel" wording.
- The generator is consumed by both scaffold call sites; they ship together.
- Coexists with `feature_plan_20260624_113751_split-constitution-system-tab.md` (System tab for CLAUDE.md/AGENTS.md) — no conflict; see Edge-Case §12. That plan's reviewer pass also already absorbed this session's `ensureAgentsProtocol`/`AGENTS.md` marker fixes into its commit (noted there as out-of-scope-but-valid).

## Adversarial Synthesis

**Risk Summary:** The highest-severity risks are (1) clobbering user-authored `.claude/` content or a hand-written CLAUDE.md — mitigated by a generated-by manifest, marker-block append/update semantics, and a parameterized per-target header check so the legacy branch can't mis-fire on CLAUDE.md; (2) silent skill-drop / broken auxiliary-file paths from treating the 21 heterogeneous source skills as uniform — mitigated by explicit format normalization (flat vs directory vs no-frontmatter) and the "SKILL.md-only, keep `.agents/` paths" invariant for `_lib` and `.js` resources; (3) inconsistent upgrade behavior across the two scaffold call sites that gate on *different* version stores — mitigated by gating the mirror on each site's existing predicate and invoking it after skill-seeding. The default-`both` upgrade flip is accepted per user decision and is safe only because of the non-destructive guarantees above; the permission allow-list is default-on (not optional) so proxy skills are usable. All Claude Code discovery/invocation/permission assumptions are now verified (see Research Findings) — `/memo` is a confirmed native slash command, the `settings.json` allow-list schema is confirmed, and per-skill invocation-mode flags (`disable-model-invocation` / `user-invokable`) are specified to keep side-effecting proxy skills off the semantic auto-trigger path. Residual risk: the `allowed-tools` frontmatter field is inconsistently enforced by the model (research Opinion), so the `settings.json` allow-list — not the frontmatter — is the reliable permission gate.

## Proposed Changes

### 1. CLAUDE.md scaffolding parity with AGENTS.md

- **`package.json`** — add `switchboard.protocol.target` enum (`agents` | `claude` | `both`, **default `both`**) with enumDescriptions explaining Claude Code reads CLAUDE.md / Antigravity reads AGENTS.md.
- **`src/extension.ts`** — generalize `ensureAgentsProtocol` (2982-3098) into `ensureProtocolFile(workspaceUri, extensionUri, targetFileName, opts)`: bundled source stays `AGENTS.md`; target filename is a parameter; for CLAUDE.md, `opts.preamble` injects a 2-3 line Claude-Code note inside the marker block. Branch behavior:
  - **skip / in-place update / append branches**: unchanged per-target (marker logic is target-agnostic).
  - **create branch (line 3017)**: MUST write the **managed block** (markers + preamble), NOT the markerless `sourceForCreate`. Today AGENTS.md's create branch writes markerless content and self-heals on the next run via the legacy branch; for CLAUDE.md that self-heal would **wipe the preamble**, so the create branch must emit `managedBlock` for the CLAUDE.md target. (Leave the AGENTS.md create branch as-is to avoid scope creep, or align both — implementer's call, but CLAUDE.md must use the managed block.)
  - **legacy-markerless branch (`hasProtocolHeaderLine`, line 2970)**: parameterize the header per target. Introduce `CLAUDE_PROTOCOL_HEADER` (e.g. `# CLAUDE.md - Switchboard Protocol`) and make `hasProtocolHeaderLine(content, header)` take the header as an argument, so a CLAUDE.md whose markers were stripped is detected by the CLAUDE header — NOT by the AGENTS header that lives inside the copied source body. This resolves Edge-Case §13 concretely.
  - Keep a thin `ensureAgentsProtocol` wrapper for churn minimization.
- Update both call sites (`425-445` activation migration, `3337-3343` setup) to read the target setting and loop `ensureProtocolFile` over the selected filenames, logging each result. **Note the two call sites gate on DIFFERENT version stores**: activation uses `shouldRefreshAgentWorkspaceFiles` → `getLastCopiedAgentVersion`/`setLastCopiedAgentVersion` (`extension.ts:104/117`); control-plane uses `ControlPlaneMigrationService._shouldRefreshAgentVersion` → `.switchboard/.agent_version.json` (`ControlPlaneMigrationService.ts:720+`). The CLAUDE.md path and mirror generator must be gated on the **same predicate each call site already uses**, so upgrade behavior is consistent across both.

### 2. Generate native `.claude/skills/` mirror — new `ClaudeCodeMirrorService`

- **Finalized manifest (post-cleanup, 2026-06-24).** A small in-repo manifest lists which `.agents/workflows/*.md` and `.agents/skills/*.md` to mirror, with per-entry `allowed-tools` **and an invocation mode** (see Research Findings — `disable-model-invocation` / `user-invokable` are verified frontmatter keys). The skill set was cleaned this session (7 deleted); the surviving 21 skills + 4 workflows were categorized by trigger mechanism, which drives the mirror **and** the invocation-mode flag:

  **Workflows → user-invocable skills (`/name`), all mirrored (4) — invocation mode: default (both slash + model-auto):**
  - `memo` (body documents both `/memo` and the plain-language `start memo capture` trigger), `accuracy`, `improve-plan`, `switchboard-chat` (note: trigger is `/switchboard-chat`, not `/chat`, to avoid the native-CLI clash).

  **Skills — mirror (21). Invocation mode per the research's Trade-off Evaluation:**
  - *Side-effecting proxy skills → `disable-model-invocation: true` (explicit `/name` only, no semantic auto-trigger into write/comment routes):* `clickup_api`, `clickup_fetch`, `clickup_create_task`, `clickup_modify_task`, `clickup_attach`, `clickup_create_subpage`, `linear_api`, `get_tickets`, `generate_diagram`, `kanban_operations` (move-card mutates state), `refine_ticket` (generates a spec prompt — explicit invocation preferred).
  - *Pure info-retrieval / read-only skills → `user-invokable: false` + rich description (model pulls on demand, no slash clutter):* `archive`, `query_archive`, `query_switchboard_kanban`, `query_kanban_plans`, `web_research`, `deep_planning`, `complexity_scoring`, `advise_research`, `constitution_builder`, `tuning`.
  - *Note on `user-invokable` spelling:* the validator recognizes **`user-invokable`** (with a "k"); `user-invocable` (with a "c") triggers validator warnings (GitHub Issue #23723). The generator MUST emit `user-invokable`.
  - *`allowed-tools` for shell skills:* `Bash` (single-string form is valid per research). For skills that also read files (e.g. `deep_planning`, `web_research`), add `Read, Glob, Grep, WebSearch, WebFetch` as a comma-separated string or YAML array. Native tool names are capitalized (`Read`, `Write`, `Edit`, `Grep`, `Glob`, `WebSearch`, `WebFetch`).

  **Excluded from the mirror:** `_lib` (the shared helper, not a skill — referenced by the proxy skills via upward-walk, never mirrored as a skill).

  **No longer present (deleted this session, so not in the manifest):** `deprecated/`, `clickup_mcp`, `apply_patch`, `gemini_interactive`, `architectural_diagrams`, `convert_to_epic`, `fix_plans_dropdown`.

  > Correction from an earlier draft: `refine_ticket` is **not** "backend-consumed." Its "Refine" button (`copyRefinePrompt`) just copies the skill content as a clipboard prompt for an agent to run; the skill is fully agent-actionable, so it is mirrored. The dead auto-dispatch path (`linearRefineTask`/`clickupRefineTask` → `switchboard.refineTask`) was removed this session.
- **Translation.** For each entry, write `.claude/skills/<kebab-name>/SKILL.md` with frontmatter `name`, `description` (from source frontmatter, or manifest fallback), `allowed-tools` (where applicable), and the invocation-mode flag (`disable-model-invocation: true` or `user-invokable: false`) per the manifest. Body copied verbatim — the body keeps the `_lib/sb_api_call.sh` upward-walk and the `/comment`-route guidance unchanged. **Directory name = kebab-case** (defines the slash command); `name` frontmatter may be a human-readable display name. Keep the body under 500 lines (research recommendation; all current skills are well under).
- **Source skill format normalization (Clarification — verified in source this session).** The 21 source skills are NOT uniform and the translator must handle every shape:
  - **18 flat `.md` files** (e.g. `clickup_api.md`, `archive.md`): YAML frontmatter with `description` only (no `name`). Derive `name` from the filename stem; `description` from frontmatter.
  - **3 directory skills** (`advise_research/`, `kanban_operations/`, `query_archive/`): already ship `SKILL.md` with `name` + `description` frontmatter. Read the `SKILL.md` directly; do NOT recurse into auxiliary files.
  - **No-frontmatter case** (`advise_research/SKILL.md` has NO YAML block — body starts at `# Advise Research If Unsure`): fall back to the first H1 line (stripped of `#`) for `name`, and a manifest-supplied `description` default for the description. The in-repo manifest MUST carry an explicit `description` fallback for any entry whose source lacks frontmatter, so no mirrored skill ships with an empty description (Claude Code may silently drop or hide a nameless/descriptionless skill).
  - **Auxiliary resource files** (`kanban_operations/move-card.js`, `kanban_operations/get-state.js`): these are referenced inside the SKILL.md body via `.agents/skills/kanban_operations/...` paths. **Invariant: the mirror copies ONLY `SKILL.md` into `.claude/skills/<name>/`; auxiliary files are NOT copied.** This is safe ONLY because the body keeps the `.agents/` absolute-from-workspace-root path and `.agents/` is always scaffolded. Document this invariant in the generator header comment so a future edit that "fixes" the relative paths to `.claude/skills/...` is caught in review. (Same invariant as `_lib` — single source, single token path.)
- **No `_lib` duplication.** Generated skills reference the existing `.agents/skills/_lib/sb_api_call.sh`; do not copy it into `.claude/`.
- **Invocation ordering (Clarification — verified in source).** At the **activation** call site, `ensureAgentsProtocol` (line 431) runs INSIDE the version gate and BEFORE the skill-seeding loop (lines 448+, which copies `.agents/skills/*` into the workspace). On a truly fresh install `.agents/skills/` is empty until 448+ runs. Therefore the mirror generator must be invoked **AFTER the skill-seeding loop** at the activation site, not next to line 431, or it will scan an empty source directory and mirror nothing. At the **setup** call site (`ControlPlaneMigrationService._bootstrapControlPlaneLayout` / the setup function at 3315+), `.agents/` is copied earlier in the same flow (3318-3344), so the mirror may run at the end of that flow. Gate the mirror on the same version-refresh predicate each site uses (see §1).
- **Generated-by tracking.** Write a manifest (e.g. `.claude/.switchboard-generated.json`) recording generated skill paths + source version, so regeneration only manages its own artifacts and never touches user-authored skills.
- **Invoke from both scaffold paths**, gated on target ∈ {`claude`, `both`}. Version-stamp and overwrite-on-version-change like workflow files.

### 3. `ControlPlaneMigrationService.bootstrapControlPlaneLayout` — wire the mirror

- After the existing `.agents/` + `AGENTS.md` bootstrap (`ControlPlaneMigrationService.ts:656+`), call the new mirror generator and the CLAUDE.md path for the configured targets, so the Claude Code layer is produced during control-plane setup, not only on activation.

### 4. Setup-panel control

- **`src/webview/setup.html` + `src/services/SetupPanelProvider.ts`** — add a "Protocol / agent file target" control (Antigravity / Claude Code / Both) bound to `switchboard.protocol.target`, wired through the existing settings read/write channel. Help text (verified facts): which file each host reads; that selecting Claude Code generates `.claude/skills/` + `CLAUDE.md`; that **skills hot-reload mid-session** but **CLAUDE.md and permission settings require a Claude Code session restart** to take effect; that Bash skills will prompt for permission unless the allow-list is in place (see #5).

### 5. Permission allow-list (default-on, non-destructive) — schema verified

- When target includes `claude`, scaffold/merge a `.claude/settings.json` allow entry for the proxy bash pattern so clickup/linear skills don't prompt on every call. **Default-on** (not optional): a permission prompt on every proxy call makes the skills effectively unusable.
- **Verified schema** (`.claude/settings.json` or `.claude/settings.local.json`):
  ```json
  {
    "$schema": "https://json.schemastore.org/claude-code-settings.json",
    "permissions": {
      "allow": [
        "Bash(curl *)",
        "Bash(node *)",
        "Bash(source *)"
      ],
      "deny": []
    }
  }
  ```
  - Glob-style `*` wildcards are supported (prefix/suffix); **regex is NOT supported**. The `sb_api_call.sh` helper runs `curl` and `source`, and `kanban_operations` runs `node` — so the three entries above cover the proxy/SQL/CLI skill family.
  - Add the `"$schema"` key (research recommendation) for editor auto-completion.
  - **Non-destructive merge:** if a user `.claude/settings.json` already exists, read it, merge only the Switchboard-specific `permissions.allow` entries that are absent, and write back — never overwrite the file. Track owned entries via the generated-by manifest (§2) so a re-run doesn't duplicate them. If the file has a `"permissions"` object the generator doesn't own, append to its `allow` array; if it has no `permissions` object, add one.
  - **Known risk (research Opinion findings):** the "Accept, do not ask again" UI in Claude Code can overwrite and wipe existing wildcard permission configs in `settings.local.json` with a single narrow rule (GitHub Issue #9814). Document this in setup help text so users know to re-run Switchboard setup if their allow-list gets narrowed. Also note `allowed-tools` frontmatter enforcement can be inconsistent (the model may ignore it on abstract goals — Issues #18737/#37683); the `settings.json` allow-list is the reliable gate, not the frontmatter field.

## Verification Plan

### Automated Tests

- **`ensureProtocolFile`** (extend AGENTS.md scaffolding tests): CLAUDE.md create / skip-if-up-to-date / in-place block update / non-destructive append over hand-authored content / malformed-marker guard / legacy-markerless branch does NOT fire for a normal CLAUDE.md / preamble injected only for the CLAUDE.md target.
- **Target-selection helper:** `agents`→`[AGENTS.md]`, `claude`→`[CLAUDE.md]`, `both`→both.
- **`ClaudeCodeMirrorService`:** translation produces valid `SKILL.md` (frontmatter `name`+`description`, `allowed-tools` where expected); body preserved verbatim incl. `_lib` path and `/comment` guidance; manifest mirrors the 21 skills + 4 workflows and excludes only `_lib`; regeneration is idempotent; never modifies/deletes a user-authored `.claude/skills/` dir not in the generated manifest; version bump regenerates.
- **Source-format normalization:** flat `.md` → name from filename stem, description from frontmatter; directory skill (`kanban_operations`) → reads `SKILL.md`, copies NO auxiliary `.js` files; no-frontmatter skill (`advise_research`) → name from first H1, description from manifest fallback (never empty); every mirrored skill has non-empty `name` and `description`.
- **Create-branch preamble:** CLAUDE.md create path writes the managed block (markers + preamble); re-running immediately after create hits the **skip** branch (markers present), NOT the legacy branch (preamble not wiped).
- **Per-target header check:** a CLAUDE.md with markers stripped but AGENTS-header present in the copied body is detected via the CLAUDE header parameter, not the AGENTS header — legacy branch does not fire on a normal CLAUDE.md.
- **Version-store gating:** activation site gates mirror on `shouldRefreshAgentWorkspaceFiles`; control-plane site gates on `_shouldRefreshAgentVersion`; both record their respective version after a successful mirror so neither re-runs every activation.
- **Invocation ordering:** at the activation site, the mirror runs AFTER the skill-seeding loop; a fresh-install activation produces a non-empty `.claude/skills/` mirror (source `.agents/skills/` is populated first).
- **Setting wiring** (mirror existing setup-panel regression tests): control reads/writes `switchboard.protocol.target`.
- **Invocation-mode flags (verified schema):** side-effecting proxy skills emit `disable-model-invocation: true`; info-retrieval skills emit `user-invokable: false` (spelled with a "k", not "c"); workflow skills emit neither (default both-mode). Confirm no mirrored skill emits `user-invocable` (with "c").
- **Kebab-case naming:** every generated skill directory is lowercase kebab-case (`clickup-api`, `query-switchboard-kanban`); the slash command derived from the directory matches; the snake→kebab mapping is stable across regenerations.
- **Allow-list merge:** scaffolding into an empty `.claude/` creates `settings.json` with the `permissions.allow` entries (`Bash(curl *)`, `Bash(node *)`, `Bash(source *)`) + `$schema`; scaffolding into a `.claude/settings.json` with pre-existing user permissions appends only absent Switchboard entries without overwriting; re-running does not duplicate entries.

### Manual Verification

1. **Target gating:** with default `both`, a fresh scaffold produces AGENTS.md *and* CLAUDE.md + `.claude/skills/`. Set target `agents` explicitly → no `CLAUDE.md`, no `.claude/skills/`, Antigravity `/memo` still works. Set `claude` → no `.claude/` regression on the AGENTS.md side. Confirm the upgrade path: an existing `agents`-era workspace, on first activation after this ships with default `both`, gains CLAUDE.md + `.claude/` without disturbing existing AGENTS.md/`.agents/` content.
2. **Native `/memo` in Claude Code:** target `claude` (or `both`), re-run setup, open control-plane workspace in Claude Code. Skills hot-reload, so `/memo` should be available without a restart; confirm `.claude/skills/memo/SKILL.md` exists and `/memo` enters capture mode — replies begin `[MEMO CAPTURE ACTIVE]`, messages append to `.switchboard/memo.md`, `process memo` creates one plan per entry in `.switchboard/plans/`. (If the protocol block in CLAUDE.md is also expected to be active, restart the session once — CLAUDE.md loads at init only.)
3. **ClickUp skill in Claude Code:** with the extension active and the API server up, confirm `/clickup-api` (kebab-case) is available as a slash command (the skill has `disable-model-invocation: true`, so it is NOT auto-triggered — it must be invoked explicitly). Run it: the `_lib` helper resolves the port, a `/api/clickup` GET returns data, and a `/comment` POST posts a comment with the host-stamped self-marker (no token in `.claude/`). Confirm the allow-list suppressed the Bash permission prompt for `curl`/`source`.
4. **Linear skill:** same against `/api/linear` GraphQL and `/comment` for a Linear issue UUID.
5. **Non-destructive CLAUDE.md:** pre-create CLAUDE.md with custom memory → after scaffolding, custom content intact, managed block appended; re-run → skipped.
6. **User-skill safety:** pre-create a hand-authored `.claude/skills/custom/SKILL.md` → after regeneration it is untouched and absent from the generated manifest.
7. **Server-down failure:** stop the extension/API server → invoking a proxy skill returns the clear "Ensure the Switchboard extension is active…" error, not a crash.
8. **Both-target sync:** target `both`, bump source version → AGENTS.md + CLAUDE.md blocks update in place and `.claude/skills/` regenerates; user content preserved.
9. **Excluded skills:** confirm `_lib` is NOT generated as a skill, and that NO auxiliary resource files (e.g. `kanban_operations/move-card.js`, `get-state.js`) are copied into `.claude/skills/` — only `SKILL.md` per skill. Confirm `refine_ticket` **IS** generated (it is agent-actionable per Edge-Case §4 and the manifest; the earlier "NOT generated" wording here was a contradiction and is corrected).

## Research Findings (Resolved)

Source: `docs/claude_code_project_skills_and_configuration_architecture.md` (54 sources, Claude Code 2.1.0+ / Jan 7 2026). All open questions from the prior Recommended Research section are now answered. No further research is needed.

**SQ1 — CLAUDE.md discovery (verified).** Claude Code auto-loads `CLAUDE.md` from the `cwd` at session launch and walks **up** the directory tree aggregating ancestor `CLAUDE.md` files; nested (descendant) `CLAUDE.md` files are lazily loaded on demand. Multi-root workspaces resolve per the launched `cwd`. → Confirms generating `CLAUDE.md` at the **control-plane root** (where Claude Code is launched) is correct. `CLAUDE.md` supports `@path/to/file.md` modular imports (since 0.2.106) — not required for v1 but available if the managed block grows.

**SQ2 — Skill invocation (verified).** A project skill at `.claude/skills/<name>/SKILL.md` is exposed **both** as a literal `/<name>` slash command **and** as a model-auto-invocable `Skill` tool keyed on the frontmatter `description` (progressive disclosure: only name+description are indexed at startup, ~100 tokens/skill; full body loads on slash-command or model invocation). Two frontmatter flags control this: `disable-model-invocation: true` (slash-only, no semantic auto-trigger) and `user-invokable: false` (model-only, hidden from slash autocomplete). → Confirms `/memo` is a real native slash command. Drives the per-skill invocation-mode manifest in Proposed Changes §2.

**SQ3 — SKILL.md frontmatter schema (verified).** Fields: `name`, `description` (recommended; truncated at 1,536 chars in indexing), `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invokable` (**spelled with a "k"** — `user-invocable` with a "c" triggers validator warnings, Issue #23723), `allowed-tools`. `allowed-tools` accepts a single string (`Bash`), comma-separated string (`Read, Write, Bash(git *)`), or YAML array. Native tool names capitalized (`Read`, `Write`, `Edit`, `Grep`, `Glob`, `WebSearch`, `WebFetch`); MCP tools as `mcp__<server>__<tool>`. Bash scoping: `Bash(git *)`, `Bash(npm:*)`, `Bash(*)`. → Confirms the generator's frontmatter emission is spec-correct.

**SQ4 — Naming (verified).** Directory `<name>` defines the slash command. Agent Skills standard = **lowercase kebab-case**. → Source snake_case names MUST be sanitized to kebab-case (`clickup_api` → `clickup-api`). No collisions with built-ins (`help`, `compact`, `clear`) or bundled skills (`debug`, `code-review`) across the 25 mirrored names.

**SQ5 — settings.json allow-list (verified).** `permissions.allow` array in `.claude/settings.json` or `.claude/settings.local.json`; glob `*` wildcards (prefix/suffix); **no regex**. Entries: `"Bash(curl *)"`, `"Bash(node *)"`, `"Bash(source *)"`. Add `"$schema": "https://json.schemastore.org/claude-code-settings.json"`. Use `settings.local.json` for machine-specific absolute paths (not needed here — our patterns are command-based, not path-based). → The allow-list in Proposed Changes §5 is now concrete and implementable.

**SQ6 — Hot reload (verified).** Skills hot-reload mid-session (file-watcher, 2.1.0+); `CLAUDE.md` and `settings.json` require a session restart. → Reflected in Edge-Case §9 and setup-panel help text.

**Residual risks (research Opinion findings, documented in plan):** `allowed-tools` frontmatter enforcement is inconsistent (model may ignore it on abstract goals — Issues #18737/#37683), so the `settings.json` allow-list is the reliable permission gate. The "Accept, do not ask again" UI can wipe wildcard configs in `settings.local.json` (Issue #9814) — document the re-run-setup recovery path.

## Recommendation

**Complexity: 7/10 → Send to Lead Coder.** The change is additive and the marker/version machinery is reused, but it spans multiple files, introduces a new generator with real clobbering/idempotency risk, must coordinate two differently-gated scaffold call sites, and carries per-skill invocation-mode + kebab-name + allow-list semantics that must be emitted exactly per the verified Claude Code 2.1.0 schema. All Claude Code discovery/invocation/permission assumptions are now verified (see Research Findings) — no further research is blocking implementation.
