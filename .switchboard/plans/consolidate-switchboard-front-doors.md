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
- Add a **"Set up Cowork"** button to the Setup panel (`src/webview/setup.html`, alongside the existing `btn-connect-claude-desktop` at `:595`) that **exports this skill as an uploadable bundle** for the user to drop into their Cowork project folder.

  > **Superseded:** "Mirror the existing 'Connect Claude Desktop' button pattern (same panel, same export-artifact approach) — reuse that infrastructure rather than inventing a new one."
  > **Reason:** The "Connect Claude Desktop" button is **not** an artifact-exporter. `connectClaudeDesktop` (`src/services/ClaudeDesktopConnector.ts:66-109`) idempotently *writes an MCP entry into `claude_desktop_config.json` on the local machine*. Cowork is sandboxed — the extension cannot write into the user's Cowork project folder — so the mechanism must be a **file/bundle export the user picks up**, not a config write. The correct in-repo precedent is the Setup panel's export-to-file buttons: `btn-export-prompts` → `exportPromptSettings` (writes `.switchboard/settings.json`, `setup.html:667`) and the Board State Export block (`:719-737`).
  > **Replaced with:** Reuse the Setup-panel **button + `SetupPanelProvider` message-handler** infrastructure and the **export-to-file** mechanism from `btn-export-prompts` / board-state-export (generate the bundle from the single in-repo source, offer it via save-dialog or write to a known path the user uploads). Reuse `connectClaudeDesktop` only if/where Cowork also needs a local MCP config entry — but the *skill delivery* is an export, not a config write.

- Generate the bundle from the single in-repo source at button-press time (no hand-maintained copy) so it can't drift.
- Keep the bundle out of the scanned `.agents/skills/` tree so it never appears in Antigravity/Claude Code menus.

### D. Reduce `switchboard-mcp` to transport
- Reframe `switchboard-mcp` as the transport layer consumed by `switchboard-cowork`; remove it from front-door/discoverable surfaces. Companion-plan strip already covers its source frontmatter (Antigravity-invisible); this plan updates its `MIRROR_MANIFEST:168` category so CC stops treating it as a user-facing skill.
- **Do not** rename the manifest entry key or re-introduce an MCP server keyed `switchboard` — the extension's activation-time scrubber deletes `switchboard`-keyed MCP entries and SIGKILLs orphan MCP PIDs from six host configs; the sanctioned key is `switchboard-mcp`. Leave that wiring exactly as-is; this is a docs/category demotion only, not an MCP-server change.

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

- **Cowork bundle-delivery mechanism** — save-dialog export vs. write-to-known-path vs. clipboard. Recommended: match the export-to-file precedent (`exportPromptSettings`). Confirm the exact hand-off UX with the user, since it depends on how Cowork ingests a dropped-in skill folder (see Uncertain Assumptions).
- Everything else (routing table, demotions, opener resolution) is decided in Design Decisions above — no open product calls.

## Dependencies

- `sess_frontmatter_strip — fix-skill-discovery-frontmatter-spam.md` — **hard dependency.** The demotions in B/D/E rely on the frontmatter-strip + `descriptionFallback` mechanism landing first. Sequence: companion plan → this plan.

## Complexity Audit

### Routine
- Manifest `invocation`-category edits for `switchboard-chat`, `switchboard-manage`, `switchboard-mcp`, and the verb skills.
- Doc/registry updates in `AGENTS.md`/`CLAUDE.md`/manual (mechanical, but system-file — needs approval).
- Reusing the existing Setup-panel button + message-handler pattern.

### Complex / Risky
- **The adaptive-router redesign** (§A): 3-way environment resolution + live health check + safe fallback + preserving the friendly opener (Decision 8). New behavior on the most user-visible surface.
- **Cowork export** (§C): a new export artifact + a host (Cowork) whose skill-ingestion contract is not verified in-repo (Uncertain Assumptions).
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
- **Cowork export check:** press "Set up Cowork", confirm a bundle is produced from the in-repo source and lands where the user can pick it up; confirm the bundle is NOT written into `.agents/skills/`.
- **Doc consistency check:** `AGENTS.md`/manual describe exactly two doors and the Cowork flow, and retain the companion's reference-audit entries.

## Uncertain Assumptions

The following are NOT verified in-repo and the user was advised to run web research to confirm them before implementation:

- **Claude Cowork's skill-ingestion contract** — whether Cowork loads a skill by the user dropping a skill folder/bundle into the Cowork project directory (and in what format), and exactly how Cowork reaches an MCP transport from inside its sandbox. The in-repo precedent (`switchboard-mcp`, `ClaudeDesktopConnector`) is proven for **Claude Desktop**, not verified for **Cowork**; Cowork is newer and its behavior may differ or have changed. This directly shapes §C's export format and the "Set up Cowork" hand-off UX.

## Risks

- **Environment misdetection** stranding a user in the wrong mode. Mitigated by the file-presence + live-health-check probe with plan-mode as the documented safe fallback and a clear in-session statement of which mode was detected and why.
- **Cowork export drift** — the exported `switchboard-cowork` bundle can go stale vs the in-repo source. Mitigated by generating the export from a single source at button-press time (no hand-maintained copy).
- **Cowork ingestion mismatch** — if Cowork does not load dropped-in skill folders as assumed, §C's delivery mechanism is wrong. Mitigated by confirming the contract (Uncertain Assumptions) before building the export.
- **Control-plane doc edits require approval** (system files) — batch them and request explicit sign-off before writing.
- **Overlap-hiding regressions** — hiding a workflow verb that some prompt still expects as a typed command. Mitigated by the companion plan's reference audit plus the routing smoke test.
- **Cross-plan ordering** — landing this before the companion blanks CC descriptions. Mitigated by the hard dependency + sequence.

## Metadata

**Complexity:** 7
**Tags:** feature, refactor, ux, backend
