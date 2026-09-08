# The CLI Is the Control Surface, Including From a Phone

**Complexity:** 5

## Goal

Four plans making the CLI a peer surface rather than a convenience: pull your own next card, every board operation reachable, --json actually machine-parseable, and the queue visible without an agent narrating it.

## How the Subtasks Achieve This

- **`--json` output is not machine-parseable**: makes every `--json` command emit exactly one parseable JSON document, complete regardless of size, by auditing that no `--json` path bypasses the existing `exitFlushed` drain helper or reaches an interactive picker — and guards both with a CI regression harness so the fix (already in place at HEAD) cannot silently regress.
- **The CLI is a peer control surface — every board operation with terminal meaning is a named command**: names the operation set (~20 core, ~440 total across thirteen areas) backed by a single command table that derives `usage()`, per-command error strings, and a generated docs page; fails loudly for unbridged operations; rewrites `.agents/` curl patterns to the named set so agents copy the good pattern.
- **`/switchboard-next <guidance>` — an Unseated Terminal Pulls Its Own Work**: lets an agent in any terminal type free-text guidance, echoes the interpretation before acting, and pulls one batched prompt covering the selected cards — making the CLI a surface an unseated phone-over-ssh terminal can drive without the board writing into it.
- **The queue is invisible from a phone unless an agent remembers to narrate it**: has the host post dispatch and completion notifications as flat top-level comments on the plan's synced tracker card (mentioning the operator on completion), so the queue is legible from a phone without any agent being asked to narrate it — Linear is the push provider (bot identity via `actor=app` OAuth already built, pre-flight the operator's mobile settings); ClickUp posts flat comments for work-history value (no bot concept in the codebase, push is best-effort); Notion out of scope (push is presence-suppressed); no threading (single-operator use case, flat comments are readable).

## Dependencies & sequencing

- **`--json` output → The CLI is a peer control surface.** Both touch `cli.ts`. The named-operation-set's command table generates per-command exit paths; those paths must inherit `exitFlushed`/`emitJson` discipline. Land `--json` output first or alongside, or grep-assert the generated `--json` exit paths use `exitFlushed`.
- **`/switchboard-next` + The CLI is a peer control surface — coordinate on `AGENTS.md`.** `/switchboard-next` corrects the "ONLY four user-typeable workflow commands" line at `AGENTS.md:23`; the named-operation-set rewrites `.agents/` curl patterns. Different sections, same file — land together or coordinate to avoid clobbering the registry.
- **`/switchboard-next` should read via `switchboard api GET /kanban/plans`, not `switchboard plans --json`.** This decouples it from the `--json` output subtask (the `api` escape hatch is already live and authenticated). If the skill uses `--json` instead, it gains a hard dependency on `--json` output landing first.
- **The queue is invisible… is independent of the other three.** It touches the backend notification surface (`LocalApiServer`, `LinearSyncService`, `RemoteProvider`, Remote tab) and no CLI/skill surface; it can land in any order relative to the others.
- **External (out-of-feature) gates the named-operation-set depends on:** `4c134bdb` (one docs URL), `af65df25` (`_advanceCards` extraction — `advance` is built on it), `d63d77f9` (bridging registry — the "refuse rather than lie" honesty gate). These are not subtasks of this feature; they are tracked separately. If any slips, the named-operation-set has documented fallbacks (omit unbridged ops; `dispatch` stays primary temporarily).

## Team Dispatch Instructions

### `--json` output is not machine-parseable

- **Seat:** Intern (complexity 3).
- **Acceptance:**
  - `switchboard ready --json` and `switchboard plans "PLAN REVIEWED" --limit 500 --json` each pipe through a JSON parser and exit 0.
  - No `--json` success path calls `process.exit()` directly — grep-asserted (must use `exitFlushed`).
  - No `--json` path reaches an interactive `prompter.ask` / `promptWithSigInt` — grep-asserted.
  - No `--json` path writes non-JSON to stdout outside `emitJson` — grep-asserted.
  - The grep-assertions run in CI as a gate, not a one-off.
- **Must not touch:** None specified — the work is audit + regression harness + routing any bypass through the existing `exitFlushed`; no behaviour change for current commands.

### The CLI is a peer control surface — every board operation with terminal meaning is a named command

- **Seat:** Coder (complexity 5).
- **Acceptance:**
  - `usage()`, every inline per-command usage string, and the docs page are all rendered from one command table — grep-asserted no literal `npx switchboard <cmd>` string survives outside it.
  - The docs page regenerates byte-identical in CI; the drift check also diffs the command list against the triage appendix's "in" dispositions (completeness ground-truth).
  - An unbridged operation exits non-zero naming that, and does not print success; no named operation has `bridging: 'unknown'`.
  - No file under `.agents/protocols/` or `.agents/skills/` contains `curl -s -X POST` — grep-asserted in CI.
  - A human who never opened the browser can, from `switchboard help` plus the linked reference page, start a team, add a standing order, create a feature from three plans, and dispatch it — no browser, no curl.
- **Must not touch:** `verbAllowlist.ts` and `verbSchemas.ts` are AUTO-GENERATED — do not hand-edit; the command table is a new hand-authored source that *consumes* their data. Do not add net-new capability: every named operation must already exist behind a route, verb, or script; if one has no backing, drop it from the set rather than building it here.

### `/switchboard-next <guidance>` — an Unseated Terminal Pulls Its Own Work

- **Seat:** Coder (complexity 4).
- **Acceptance:**
  - `/switchboard-next code 3 low complexity plans` returns one prompt covering exactly three `PLAN REVIEWED` cards in the stated band, and advances all three.
  - The interpretation is echoed before acting (role, source column, count, filters, ordering, selected titles).
  - A `complexity: "Unknown"` card is excluded from a banded batch and the unscored-exclusion count is reported.
  - Ordering is pinned to `compareByPrecedence` priority mode and is unchanged when the board's order-by mode is switched.
  - `switchboard next --from <seat>` still pops the staged queue, unchanged; `AGENTS.md` no longer claims four commands are the only user-typeable ones.
- **Must not touch:** Do not reintroduce seat inference from `process.env`, process ancestry, or the fleet — the guidance is the only identity input. Do not add `--complexity`/`--count`/`--role` CLI flags (a second grammar kept in step with the prose). Do not add a confirmation gate — the echo-then-act model is the design.

### The queue is invisible from a phone unless an agent remembers to narrate it

- **Seat:** Coder (complexity 4).
- **Acceptance:**
  - A successful dispatch posts exactly one flat top-level comment on the plan's synced card; a feature dispatch posts one summarising comment, not one per subtask.
  - A successful completion posts exactly one flat top-level comment mentioning the operator, even when retried (durable dedupe).
  - Every auto-posted comment is stamped with the self-marker and filtered by the inbound poll — never routed to a column agent as input.
  - Linear posts as `actor=app` (bot identity already built in `LinearSyncService.ts`) — never the operator's own credentials (self-notification suppression would kill every push). Pre-flights the operator's mobile notification settings via GraphQL and warns if `mentions.mobile` is off or out-of-window.
  - ClickUp posts flat comments for work-history value (the comment lands on the card, readable in the tracker, reaches task followers). Push is best-effort — no bot concept exists in the codebase, no ClickUp bot infrastructure is built here.
  - No threading — all comments are flat top-level (no `parentId`, no `discussion_id`, no reply URL).
  - A tracker failure (revoked token, network break, 429) does not fail dispatch or completion — notification is best-effort, logged, out of the critical path.
  - No role's rendered agent prompt changes — diff before/after is identical.
- **Must not touch:** `REMOTE_MODE_DIRECTIVE` and any role's prompt — this feature adds nothing to any agent's context. Do not post outside `postManagedComment` (the marker guard is load-bearing). Do not author Linear notifications with the operator's own credentials — use `actor=app`. Do not thread — flat top-level comments only. Do not build ClickUp bot infrastructure (no second-account manual setup, no OAuth). Do not build silence detection, timeouts, or a watchdog — the operator is the detector. Do not build the withdrawn stall event (silence- and mtime-based inference the project has retired). Notion is out of scope — do not add Notion-specific notification paths.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The queue is invisible from a phone unless an agent remembers to narrate it](../plans/the-queue-is-invisible-unless-an-agent-remembers-to-narrate-it.md) — **PLAN REVIEWED** — ID: 295c2435-d2ee-4e6f-b82f-eaf63852bab9
- [ ] [`--json` output is not machine-parseable: an interactive prompt is appended, and stdout truncates on exit](../plans/json-output-is-not-machine-parseable.md) — **PLAN REVIEWED** — ID: aeb05236-5ee0-4417-bfb8-1db798b3492a
- [ ] [The CLI is a peer control surface — every board operation with terminal meaning is a named command, for agents and humans alike](../plans/agents-need-a-named-operation-set-not-the-whole-ui-message-bus.md) — **PLAN REVIEWED** — ID: ef40963b-b7c0-46d2-9656-3c090a0407dc
- [ ] [`/switchboard-next <guidance>` — an Unseated Terminal Pulls Its Own Work, in Plain Words](../plans/switchboard-next-a-seat-asks-for-its-own-card.md) — **PLAN REVIEWED** — ID: aa20329f-5563-40a4-8a4e-373bc78fa6e7
<!-- END SUBTASKS -->

