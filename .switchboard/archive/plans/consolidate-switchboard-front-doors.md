# Collapse Switchboard Front Doors to a Single Adaptive `/switchboard` (Plus `/memo`)

## Goal

Reduce Switchboard's user-facing entry points to a coherent, minimal set: one adaptive front door, `/switchboard`, that does the right thing for whatever environment it's invoked in, plus `/memo` as the single deliberate standalone. A dedicated, self-contained `switchboard-cowork` skill covers Claude Cowork via a Setup-panel export. Everything else becomes background machinery the front door routes to, never a slash command the user has to know by name.

### Problem & root-cause analysis

The current entry-point taxonomy is confusing because the names don't map to a single mental model, and *which one is "primary" depends on the user's environment*:

- **`switchboard`** — today a local-vs-remote router (`workflows/switchboard-index.md`); its most valuable job is really a **plan-mode brake** for cloud sessions (Claude remote, Codex remote), where the agent spins up a branch in a VM and, left unchecked, starts coding immediately when the user only wanted to plan.
- **`switchboard-chat`** — the original local consultative-planning skill; effectively an alias for the "chat prompt" button. Overlaps with the planning behavior above. (Sourced from `workflows/switchboard-chat.md`, `MIRROR_MANIFEST:57` — a **workflow**, not a `skills/` directory.)
- **`switchboard-manage`** — the management console for driving the board; runs inside an IDE *or* a separate local app (e.g. the Antigravity desktop app). This is the primary workhorse for local users. (Sourced from `skills/switchboard-manage`, `MIRROR_MANIFEST:65` — a **directory skill**.)
- **`switchboard-mcp`** — needed for Claude Cowork, which is sandboxed and cannot reach the local Switchboard API server directly; MCP is the transport bridge. (Sourced from `skills/switchboard-mcp`, `MIRROR_MANIFEST:168`.)

Three real use cases (local board-driving, cloud plan-brake, Cowork) are spread across four overlapping names, and users must know the taxonomy to pick correctly. Root cause: entry points were added per-capability over time rather than designed as one environment-adaptive door. The environment already determines what's possible (the host you're in *is* the signal), so a router that makes the user choose is redundant indirection.

This plan builds directly on `fix-skill-discovery-frontmatter-spam.md`, which removes the discovery clutter; this plan settles *which* doors remain and *what they do*.

## Design Decisions (stated, not deferred)

1. **`switchboard` is the single adaptive front door.** It detects its environment and *becomes* the right behavior instead of asking the user to choose.
2. **`switchboard-chat` and `switchboard-manage` are retired as standalone front doors.** Their skill bodies remain as **internal, non-discovered** skills that `switchboard` routes to; they are no longer separate slash commands. Note the two have **different source types**, so demotion differs per body (see §B): `switchboard-manage` is a directory skill (already frontmatter-stripped by the companion plan → Antigravity-invisible), while `switchboard-chat` is a **workflow** the companion plan does *not* touch — this plan owns making it non-surfaced.
3. **Local mode's hub is the management console — but the bare-`/switchboard` opener stays friendly (see Decision 8).** When invoked locally *with board-driving intent*, `/switchboard` routes to the management console (board-driving), which can launch a planning/chat session on request. This honors "everything is accessible through manage" and folds the old chat behavior in as a sub-action rather than a rival door.
4. **`memo` stays a standalone front door** — a deliberate, sticky capture mode whose strict protocol is safer as its own command than as a routed sub-action.
5. **Cowork is served by a dedicated `switchboard-cowork` skill delivered via a Setup-panel export button**, not by logic inside `switchboard`. It is not placed in the everyday-scanned `.agents/skills/` tree, so it never clutters local/cloud menus.
6. **`switchboard-mcp` demotes from a front door to the transport layer** that `switchboard-cowork` uses under Cowork's sandbox. Not user-facing.
7. **The workflow verbs** (`improve-plan`, `improve-feature`, `switchboard-split`, `group-into-features`, `constitution-builder`, `tuning`) remain **reachable via `switchboard` routing** but are removed from the discoverable/auto-surfaced set — the model still knows about them and the console can invoke them on demand.
8. **The bare-`/switchboard` opener is NOT replaced by a status read-out.** `switchboard-index.md:9-23` already mandates a short, welcoming prompt that *does not announce the detected environment and does not show a status read-out*. `switchboard-manage`'s Entry Protocol (`skills/switchboard-manage/SKILL.md` §1: "Entry Protocol (do this FIRST, then stop)") *is* a board-state read-out. These directly conflict. Resolution: a **bare** `/switchboard` (no request attached) always shows the friendly opener regardless of environment; the local→console route fires only once the user expresses board-driving intent (either `/switchboard <request>` or a follow-up in the opened session). Only then does the console's status read-out appear. This preserves the existing opener contract instead of overriding it.

   > **Superseded:** (implied by original Design Decision 3) local `/switchboard` presents the management console immediately.
   > **Reason:** That contradicts the existing, deliberate opener rule in `switchboard-index.md:11` ("reply with a short, welcoming prompt — not a status read-out … do NOT announce which environment you detected"). Routing straight to the console's Entry-Protocol read-out on a bare invocation would regress that UX.
   > **Replaced with:** Bare `/switchboard` → friendly opener always. Board-driving intent (attached request or follow-up) → console route + its status read-out. Environment detection stays silent and only picks the route.

## Environment Detection

`switchboard` (evolving from `workflows/switchboard-index.md`, which already probes `.switchboard/api-server-port.txt` at `:27`) resolves a 3-way environment:

| Environment | Signal | Behavior |
| :-- | :-- | :-- |
| Local IDE / Antigravity desktop app | `.switchboard/api-server-port.txt` present **and** the LocalApiServer answers a health check | **Management console** (board-driving hub; can launch planning) — routed on board-driving intent, per Decision 8 |
| Cloud remote VM (Claude/Codex remote) | shell available, `.switchboard/` present in the repo, **no** reachable server | **Plan-mode brake** (stop, plan, do not code) |
| Claude Cowork | (handled by the separate `switchboard-cowork` skill — not this detection path) | Route through MCP transport |

Worst-case misdetection (a local IDE with the extension turned off) degrades to plan-mode, which is safe (planning, not destructive board action). State this fallback explicitly in the routing prose.

**Health-check, not just file-presence.** The current router only checks that `.switchboard/api-server-port.txt` *exists* (`:27`). A stale port file (extension crashed/closed) would then misdetect local and route to a console whose API is dead. The table above requires the file **and** a live health check against the port; on file-present-but-unreachable, fall through to plan-mode (the documented safe default). Keep the health check cheap (single short-timeout request) so the opener stays snappy.

## Proposed Changes

### A. Evolve `switchboard-index.md` into the adaptive front door
- Keep the existing bare-invocation friendly opener (`:9-23`) unchanged — do not turn it into a status read-out (Decision 8).
- Keep the existing port-file environment probe; extend it to the explicit 3-way table above, **add the live health check**, and document the safe fallback (unknown/unreachable → plan-mode).
- Local branch (on board-driving intent): route to the management-console skill body (formerly `switchboard-manage`), including an in-console affordance to start a planning/chat session (absorbing `switchboard-chat`).
- Cloud branch: route to the plan-brake behavior (the consultative planning persona), explicitly instructing the agent to withhold code until a plan is approved.
- Remove `/sw`/`/sw-remote` remnants already noted as retired (`switchboard-index.md:53` already states they were retired — confirm no live route still points at them).

### B. Demote `switchboard-chat` and `switchboard-manage` to internal skills
- **`switchboard-manage` (directory skill):** its source frontmatter is already stripped by the companion plan → Antigravity-invisible. This plan's remaining work is to change its `MIRROR_MANIFEST` `invocation` from `no-model` to a non-surfaced category for Claude Code, and to make `switchboard-index.md` route to it as the local console body. Keep the body as reference material the front door reads (`view_file` / `skill:` directive).
- **`switchboard-chat` (workflow):** the companion plan does **not** touch workflows, so this plan owns it. Workflows are only surfaced in Antigravity when *typed* (host doc `:28-37`), so the demotion here is: (a) update its `MIRROR_MANIFEST:57` category so Claude Code no longer mirrors it as a slash command, and (b) fold its persona into the local console's "start a planning session" affordance so nobody needs to type `/switchboard-chat`. The typed command may remain harmlessly available but is removed from all "available front doors" guidance.
- Update `MIRROR_MANIFEST` invocation categories accordingly so Claude Code no longer surfaces them as slash commands.

### C. Introduce `switchboard-cowork` as a Setup-panel export
- Author a self-contained `switchboard-cowork` skill: setup instructions + usage guidance + the MCP-transport wiring, written so a Cowork user interacts naturally and never invokes MCP or "goes through channels" manually.
- Add a **"Set up Cowork"** button to the Setup panel (`src/webview/setup.html`, alongside the existing `btn-connect-claude-desktop` at `:595`) that **exports this skill as a `.zip` the user uploads into Cowork**.

  > **Superseded:** "Mirror the existing 'Connect Claude Desktop' button pattern (same panel, same export-artifact approach)" / "export … for the user to **drop into their Cowork project folder**."
  > **Reason:** Two grounded corrections. (1) The "Connect Claude Desktop" button is **not** an artifact-exporter — `connectClaudeDesktop` (`src/services/ClaudeDesktopConnector.ts:66-109`) idempotently *writes an MCP entry into `claude_desktop_config.json`*. (2) Cowork's documented skill-load path is **upload a `.zip` (skill directory at the zip root) → enable it in Settings > Capabilities** (same as Claude.ai chat) — there is no "drop it in the project folder and it's auto-discovered" step. So the export must produce a zip the user uploads, not a loose folder.
  > **Replaced with:** Reuse the Setup-panel **button + `SetupPanelProvider` message-handler** infra and the **export-to-file** mechanism from `btn-export-prompts` / board-state-export (`setup.html:667`, `:719-737`), but produce a **`.zip` with the `switchboard-cowork/` skill directory at the zip root**. Hand-off UX: "download this zip, then upload it in Cowork's Settings > Capabilities."

- **Frontmatter constraints (verified):** the skill follows the platform-agnostic Agent Skills spec, so one `SKILL.md` works across Claude.ai/Cowork/Claude Code. Required frontmatter: `name` (lowercase/hyphens, ≤64 chars, **must match the directory name** `switchboard-cowork`) and `description`. **Claude.ai/Cowork caps `description` at 200 characters** (the spec allows 1024) — keep the Cowork skill's description ≤200 chars or it is rejected/truncated on that surface.
- Generate the zip from the single in-repo source at button-press time (no hand-maintained copy) so it can't drift.
- Keep the source out of the scanned `.agents/skills/` tree so it never appears in Antigravity/Claude Code menus.

### D. Reduce `switchboard-mcp` to transport
- Reframe `switchboard-mcp` as the transport layer consumed by `switchboard-cowork`; remove it from front-door/discoverable surfaces. Companion-plan strip already covers its source frontmatter (Antigravity-invisible); this plan updates its `MIRROR_MANIFEST:168` category so CC stops treating it as a user-facing skill.
- **Do not** rename the manifest entry key or re-introduce an MCP server keyed `switchboard` — the extension's activation-time scrubber deletes `switchboard`-keyed MCP entries and SIGKILLs orphan MCP PIDs from six host configs; the sanctioned key is `switchboard-mcp`. Leave that wiring exactly as-is; this is a docs/category demotion only, not an MCP-server change.
- **Transport mechanism (confirmed).** Cowork is the **local desktop app**. `switchboard-mcp` is the **local stdio** MCP server the Cowork app runs to reach the local `LocalApiServer` — the desktop app's sandbox can't hit `localhost` directly, so the bundled stdio server is the bridge. This is exactly the existing, intended wiring; §C's `switchboard-cowork` bundle carries it. No change to the transport itself.

### E. Keep the workflow verbs routable but unsurfaced
- Ensure `improve-plan`, `improve-feature`, `switchboard-split`, `group-into-features`, `constitution-builder`, `tuning` remain invokable by the front door / model but are not surfaced as discoverable slash commands.
- **Split by source type** (they are not homogeneous): `group-into-features`, `constitution-builder`, `tuning` are **directory skills already frontmatter-stripped by the companion plan** → Antigravity-invisible with no extra work here; this plan only decides their CC manifest category. `improve-plan`, `improve-feature`, `switchboard-split` are **workflows** (companion untouched) — Antigravity shows them only when typed, so default to keeping them typeable but omit them from any "available front doors" guidance so the canonical surface stays `/switchboard` + `/memo`.

### F. Update the control-plane docs
- Update `AGENTS.md` / `CLAUDE.md` workflow registry and skills table, the `switchboard` skill description, and any user-facing manual (`docs/switchboard_user_manual.md`) to describe the new two-door surface and the Cowork setup flow. Edit the `.agents/` + `AGENTS.md` source of truth, not the generated mirrors (per control-plane source-of-truth rule); flag these system-file edits for explicit approval before applying.
- **Preserve the companion plan's reference-audit additions.** The companion (`fix-skill-discovery-frontmatter-spam.md` Step 4) may add explicit skill references to the `AGENTS.md` skills table to keep stripped skills reachable. This rewrite must fold those in, not revert them.

## Non-Goals

- Changing what the management console or planning personas *do* internally beyond the routing/entry consolidation.
- Building any new MCP capability — `switchboard-cowork` reuses the existing MCP server/transport.
- The discovery-frontmatter strip itself (owned by the companion plan; this plan depends on it).
- Adding a new `.claude`/Antigravity mirror mechanism — reuse `MIRROR_MANIFEST` categories and the existing Setup-panel export infra.

## User Review Required

- None. Cowork is the local desktop app, reached via the bundled `switchboard-mcp` stdio bridge to `LocalApiServer` — the plan's existing intent. Routing table, demotions, opener resolution, and `.zip`-upload delivery are all decided above.

## Dependencies

- `sess_frontmatter_strip — fix-skill-discovery-frontmatter-spam.md` — **hard dependency.** The demotions in B/D/E rely on the frontmatter-strip + `descriptionFallback` mechanism landing first. Sequence: companion plan → this plan.

## Complexity Audit

### Routine
- Manifest `invocation`-category edits for `switchboard-chat`, `switchboard-manage`, `switchboard-mcp`, and the verb skills.
- Doc/registry updates in `AGENTS.md`/`CLAUDE.md`/manual (mechanical, but system-file — needs approval).
- Reusing the existing Setup-panel button + message-handler pattern.

### Complex / Risky
- **The adaptive-router redesign** (§A): 3-way environment resolution + live health check + safe fallback + preserving the friendly opener (Decision 8). New behavior on the most user-visible surface.
- **Cowork export** (§C): a new `.zip` export artifact (skill dir at zip root, ≤200-char description) + authoring a self-contained `switchboard-cowork` skill that bundles the local `switchboard-mcp` transport.
- **Cross-surface coordination** with the companion plan on `MIRROR_MANIFEST` and `AGENTS.md` — ordering-sensitive; a botched sequence blanks descriptions or drops references.
- **Workflow vs. skill demotion asymmetry** (§B/§E): the two source types demote differently; treating them uniformly leaves either a typed command live or a body unreachable.

## Edge-Case & Dependency Audit

- **Race Conditions:** Environment detection races a stale/closing extension — a present-but-dead port file. Mitigated by the live health check (§Environment Detection) falling through to plan-mode.
- **Security:** No new auth surface. Cowork transport reuses the existing `switchboard-mcp` bridge; do not widen its scope. Respect the activation-time MCP scrubber (key must stay `switchboard-mcp`).
- **Side Effects:** Retiring `switchboard-chat`/`switchboard-manage` as typed commands could strand a prompt that still types them. Mitigated by keeping the typed forms harmlessly available (workflow) / routed (skill) and by the companion's reference audit + a routing smoke test.
- **Dependencies & Conflicts:** Shares `MIRROR_MANIFEST` (companion edits `descriptionFallback`; this plan edits `invocation` categories — non-overlapping fields, but same file and same entries for `switchboard-manage`/`switchboard-mcp`/verb skills) and `AGENTS.md` (companion adds references; this plan rewrites the registry — this plan must preserve them). Sequence companion → this plan.

## Dependencies

- `sess_frontmatter_strip — fix-skill-discovery-frontmatter-spam.md`

## Adversarial Synthesis

Key risks: environment misdetection stranding a user in the wrong mode (stale port file); the Cowork export bundle drifting from source or Cowork not ingesting a dropped-in skill the way assumed; and cross-plan manifest/doc edits landing out of order and blanking descriptions or dropping references. Mitigations: file-presence **plus** live health check with plan-mode as the safe fallback and an explicit in-session statement of the detected mode; generate the Cowork bundle from the single in-repo source at press time (no hand copy) and verify Cowork's skill-drop contract before shipping; strictly sequence companion → this plan and preserve the companion's reference-audit additions in the doc rewrite.

## Proposed Changes

### `.agents/workflows/switchboard-index.md`
- **Context:** Already the front-door router with a friendly opener (`:9-23`) and a bare file-presence probe (`:27`).
- **Logic:** Extend the probe to the 3-way table + live health check + documented plan-mode fallback; keep the opener; add local→console and cloud→plan-brake routes; absorb the chat persona as a console sub-action.
- **Implementation:** Prose edits to the routing section; do not alter the opener block. Confirm `/sw`/`/sw-remote` have no live routes.
- **Edge Cases:** Present-but-dead port file → plan-mode. Bare invocation → opener, never a read-out.

### `src/services/ClaudeCodeMirrorService.ts` — `MIRROR_MANIFEST`
- **Context:** `invocation` category controls the `.claude` gate frontmatter (`buildSkillMd:315-320`) and whether CC surfaces the skill.
- **Logic:** Change categories for `switchboard-chat` (`:57`), `switchboard-manage` (`:65`), `switchboard-mcp` (`:168`), and the verb skills so CC no longer surfaces them as user slash commands, while keeping them model-loadable/routable.
- **Implementation:** Category-field edits only. Do NOT touch `descriptionFallback` values the companion added, and do NOT rename entry keys.
- **Edge Cases:** Coordinate ordering with the companion (it must land first so descriptions are non-blank before category changes).

### `src/webview/setup.html` + `src/services/SetupPanelProvider.ts` (+ new `switchboard-cowork` source)
- **Context:** Setup panel already hosts `btn-connect-claude-desktop` (`:595`, config-writer) and export-to-file buttons (`btn-export-prompts` `:667`, board-state export `:719`).
- **Logic:** Add a "Set up Cowork" button that exports the `switchboard-cowork` bundle (export-to-file precedent), generated from the single in-repo source at press time.
- **Implementation:** New button + `postMessage` type + `SetupPanelProvider` handler; author the self-contained `switchboard-cowork` skill body outside the scanned `.agents/skills/` tree.
- **Edge Cases:** Bundle must not land in `.agents/skills/` (would re-spam). Reuse `switchboard-mcp` transport unchanged.

### `AGENTS.md` / `.agents/` control-plane docs / `docs/switchboard_user_manual.md`
- **Context:** Source-of-truth registry + skills table + user manual describe the current four-door taxonomy.
- **Logic:** Rewrite to the two-door surface (`/switchboard` + `/memo`) and document the Cowork setup flow; preserve companion reference-audit additions.
- **Implementation:** Edit `.agents/` + `AGENTS.md` sources (not generated mirrors); **flag for explicit user approval before writing** (system files).
- **Edge Cases:** Do not drop the companion's added skill references.

## Verification Plan

### Automated Tests
- Session directive: **skip compilation and automated test runs.** Verify by inspection + a manual routing smoke test.
- **Routing smoke test from `/switchboard`:** in each environment (local w/ extension up, local w/ extension down, cloud remote) confirm the correct route and that a bare invocation shows the friendly opener (never a status read-out). Confirm present-but-dead port file → plan-mode.
- **Discoverability check:** confirm `switchboard-chat`, `switchboard-manage`, `switchboard-mcp`, and the verb skills no longer appear as user slash commands in Claude Code or Antigravity, while remaining model-loadable/routable.
- **Cowork export check:** press "Set up Cowork", confirm a `.zip` is produced from the in-repo source with the `switchboard-cowork/` skill dir at the zip root and a `SKILL.md` whose `name` matches the dir and whose `description` is ≤200 chars; confirm the source is NOT under `.agents/skills/`.
- **Doc consistency check:** `AGENTS.md`/manual describe exactly two doors and the Cowork flow, and retain the companion's reference-audit entries.

## Confirmed Delivery Mechanics (web research, 2026-07-11)

Cowork is local (the desktop app) — that was always the design. The research confirmed the concrete *delivery* mechanics for the Cowork skill, which are what shape §C:

- **Skill delivery = upload a `.zip` (skill dir at the zip root) → enable in Settings > Capabilities**, same as Claude.ai chat. There is no "drop the folder in your Cowork project directory and it's auto-discovered" step — the export must be an uploadable zip. → drove the §C delivery correction (the original "drop into project folder" wording was wrong).
- **Frontmatter:** Agent Skills spec — `name` (lowercase/hyphens, ≤64, must match the dir name) + `description`; **Claude.ai/Cowork cap `description` at 200 chars** (the spec allows 1024). → §C constraint.
- **Transport:** the Cowork desktop app reaches a local server via a **bundled local stdio MCP server** — exactly the `switchboard-mcp` bridge to `LocalApiServer` the plan already intends. → confirms §D's wiring; no change needed.

## Risks

- **Environment misdetection** stranding a user in the wrong mode. Mitigated by the file-presence + live-health-check probe with plan-mode as the documented safe fallback and a clear in-session statement of which mode was detected and why.
- **Cowork export drift** — the exported `switchboard-cowork` bundle can go stale vs the in-repo source. Mitigated by generating the export from a single source at button-press time (no hand-maintained copy).
- **Cowork delivery-format mismatch** — Cowork loads a skill from an uploaded `.zip` (dir at zip root), not a loose folder, and caps `description` at 200 chars. Mitigated by exporting a correctly-structured zip and asserting the description length (§C, Verification).
- **Control-plane doc edits require approval** (system files) — batch them and request explicit sign-off before writing.
- **Overlap-hiding regressions** — hiding a workflow verb that some prompt still expects as a typed command. Mitigated by the companion plan's reference audit plus the routing smoke test.
- **Cross-plan ordering** — landing this before the companion blanks CC descriptions. Mitigated by the hard dependency + sequence.

## Metadata

**Complexity:** 7
**Tags:** feature, refactor, ux, backend

---

## Completion Summary

Collapsed the front doors to a single adaptive `/switchboard` + `/memo` and demoted the rest to internal/transport. Evolved `switchboard-index.md` into the 3-way adaptive front door (local+live-API → management console on board-driving intent; cloud remote → plan-mode brake; Cowork → separate skill) with a live health check and plan-mode safe fallback, preserving the bare-invocation friendly opener (Decision 8). Demoted `switchboard-chat` (`default`→`no-user`), `switchboard-manage` (`no-model`→`no-user`), `group-into-features` (`default`→`no-user`), and all `switchboard-*` aliases (`switchboard-plan`, `switchboard-feature`, `switchboard-remote-plan`, `switchboard-notion`, `switchboard-linear`, `switchboard-clickup`, `switchboard-kanban`) to `no-user` in `MIRROR_MANIFEST` so Claude Code no longer surfaces them as slash commands while keeping them model-loadable/routable; `switchboard-mcp` was already `no-user` (comment updated to reflect transport-layer framing). Authored a self-contained `switchboard-cowork` skill (outside `.agents/skills/` so it never clutters menus) with `name` matching the dir and a 112-char description (≤200 Cowork cap), and added a "Set up Cowork" button to the Setup panel that exports it as a `.zip` (skill dir at zip root) via a new `CoworkSkillExporter` service + `switchboard.exportCoworkSkill` command; webpack CopyPlugin ships the skill source to `dist/`. Updated `AGENTS.md` (workflow registry, architecture block, skills table), the `CLAUDE_PREAMBLE` example, and `docs/switchboard_user_manual.md` to the two-door surface + Cowork flow; preserved all companion-plan reference-audit entries (no references were added by Plan 1, so none to drop). Files changed: `.agents/workflows/switchboard-index.md`, `src/services/ClaudeCodeMirrorService.ts` (manifest categories + preamble), `src/cowork-skill/switchboard-cowork/SKILL.md` (new), `src/services/CoworkSkillExporter.ts` (new), `src/webview/setup.html`, `src/services/SetupPanelProvider.ts`, `src/extension.ts`, `package.json`, `webpack.config.js`, `AGENTS.md`, `docs/switchboard_user_manual.md`. Per session directive, compilation and automated tests were skipped — verification was by inspection (manifest category audit, frontmatter validation, description-length check).

## Review Findings

Verified correct: `switchboard-index.md` 3-way router + live health check + plan-mode fallback + preserved opener (Decision 8); all `MIRROR_MANIFEST` category demotions (`switchboard-chat`/`switchboard-manage`/`switchboard-mcp`/`group-into-features`/verb aliases → `no-user`); the `switchboard-cowork` skill (name matches dir, 112-char description ≤200) + `CoworkSkillExporter` (uses bundled `adm-zip`, zip dir at root) + Setup button/command/webpack copy wiring; MCP config block matches `ClaudeDesktopConnector.buildEntry` exactly; manual updated to the two-door surface. **MAJOR (fixed):** §F was incomplete — `AGENTS.md`'s Workflow Registry still advertised `/switchboard-chat` and `/switchboard-manage` as front doors (contradicting the goal); reframed both as "internal, not a front door — routed by `/switchboard`" and updated the `/switchboard` row to the two-door framing. **NIT (fixed):** `AGENTS.md` had accumulated duplicate managed-block markers (4 start / 6 end) from the self-referential `ensureProtocolFile` regen; collapsed to a single clean pair. Files changed: `AGENTS.md`. Remaining risk: `CLAUDE.md`/`.claude/skills` are generated mirrors of `AGENTS.md` — they regenerate on VSIX rebuild/Setup, so left untouched per the control-plane source-of-truth rule.

**Follow-up fix (marker-nesting root cause):** `buildManagedInner` (`ClaudeCodeMirrorService.ts`) now strips any existing `switchboard:agents-protocol:start/end` markers from the source before wrapping, so the wrap emits exactly one clean marker pair regardless of how many the bundled source carries (previously the self-referential AGENTS.md source re-nested a pair each activation, stabilising at 2/2). Verified: simulated 0–3 source pairs all yield 1/1; TS syntax check passes. Takes effect on the next VSIX rebuild + reinstall. Files changed: `src/services/ClaudeCodeMirrorService.ts`, `AGENTS.md` (collapsed to 1/1).
