# A First-Run Setup Wizard for the Standalone Host

## Goal

`npx switchboard` on a fresh machine writes a 0-byte `kanban.db` into the repo, runs 64 schema migrations against it, and hands back a board the user may not want in a location they were never asked about. If they already have a database — a copy from another machine, a global store, a sibling repo — it is ignored, and the first thing they do is delete what the tool just spent a minute building.

Give the standalone host an interactive first-run wizard: detect before creating, ask where things live, and seat the user's agents and teams from the CLIs they actually use. Standalone is increasingly the **first** contact with Switchboard — before the VS Code extension — so first run has to stand on its own rather than assume a panel will finish the job.

### Problem Analysis

**The first-boot path creates unconditionally and asks nothing.** `src/standalone/bootstrap.ts:467-478`:

```ts
const db = KanbanDatabase.forWorkspace(workspaceRoot);
const dbPath = db.dbPath;
if (!fs.existsSync(dbDir))  { fs.mkdirSync(dbDir, { recursive: true }); }
if (!fs.existsSync(dbPath)) { fs.writeFileSync(dbPath, Buffer.alloc(0)); }
await db.ensureReady();
```

`forWorkspace` resolves a *configured* location (`customDbPath` → `kanban.dbPath` → mappings / `db-pointer` → `<root>/.switchboard/kanban.db`). It never looks for an **unconfigured existing** database, and nothing defers the build until the location is settled. `ensureReady()` then runs the migration chain — 93 `MIGRATION_V*_SQL` constants reaching V64 — on the empty file it just made. That chain is the wait the user experiences, spent on an artifact they are about to remove.

**There is no interactive prompting anywhere in the CLI.** `src/standalone/cli.ts` dispatches `secrets`, `token`, `init`, `scaffold`, `control-plane`, `stop`, `status`, `logs` — all flag-driven. `init` takes `--target agents|claude|both` and nothing else. No `readline`, no prompt library, no TTY handling. The wizard is net-new, not an extension of an existing flow.

**Three of the five questions need data that does not exist in a form the CLI can reach.** This is the real scope of the work, and it is not the prompting:

| Question | Substrate today | Gap |
|---|---|---|
| Where does the DB live? | `kanban.dbPath`, `controlPlaneRoot`, mappings, `db-pointer` — all exist | Presentation only |
| Where does `.switchboard/` scaffolding live? | `switchboard.kanban.controlPlaneRoot` exists ("Explicit Control Plane folder override… leave empty to auto-detect") | Presentation only |
| Which CLIs do you use? | `CLI_BRAND_ICON_KEYS` in `src/webview/terminals.js` — 19 entries (claude, antigravity, devin, jules, gemini, codex, cursor, copilot, windsurf, qwen, amp, cline, kiro, kilo, trae, opencode, zed…) | It is a **brand-icon map in a webview**, not a registry. The CLI cannot import it. |
| …and seat roles from them | `startupCommands` is `Record<string,string>` **keyed by role**, in `GlobalIntegrationConfigService` | There is **no CLI→command mapping anywhere**. Nothing maps "claude" to a launch command. Grep for `DEFAULT_STARTUP` / `defaultStartupCommand` / `startupCommandFor` returns nothing. |
| …and the three teams | `SHIPPED_TEAM_TYPES` in `src/webview/kanban.html:4854` — Batch planners / Coding / Review, with head roles and member shapes | Lives in a **self-contained webview**. The CLI cannot import it, and duplicating it guarantees drift. |

So the wizard's last question — the one that delivers most of the value — is blocked on two extractions and one piece of data that has never been written down.

### Root Cause

Standalone was built as a second front door onto a product whose configuration surface is the extension's panels. Every default that a panel collects interactively — team shape, agent roster, startup commands — was stored where the panel could reach it, which is a webview file or a role-keyed config the panel writes. Nothing needed a headless path to those defaults, because nothing headless ever set them up.

### Non-goals

- **Replacing the Setup panel.** The wizard covers first run; the panel remains the place to change any of it later. The wizard writes the same config keys the panel writes, never a parallel store.
- **A migration engine.** "Are you migrating?" routes to the transfer bundle (`hand-a-workspace-to-another-machine.md`), it does not reimplement import.
- **Consolidating databases.** The N-to-1 merge is `single-global-database-in-home-store.md`. This wizard *adopts* an existing DB; it never merges two.
- **Non-interactive regression.** Every question must have a flag equivalent, and a non-TTY invocation must behave exactly as it does today minus the unconditional create.

## Metadata

**Complexity:** 7
**Tags:** feature, backend, cli, onboarding

## User Review Required

- **The CLI→startup-command table is new product data and needs a human decision, not a guess.** Nothing in the codebase records how to launch any of the 19 CLIs. The plan proposes seeding a small table for the CLIs the project can state confidently and leaving the rest to a free-text prompt, but *which* CLIs get a shipped default — and what those commands are — is the user's call. A wrong default seats a role that fails on first dispatch, which is worse than an empty field the user fills in.

## Complexity Audit

### Routine

- `node:readline/promises` for prompting — built-in, no dependency, and the standalone bundle must stay dependency-light.
- Reading and writing config keys that already exist (`kanban.dbPath`, `controlPlaneRoot`, `startupCommands`, `visibleAgents`).
- Adding flag equivalents to `cli.ts`'s existing argv parsing.

### Complex / Risky

- **Extracting `SHIPPED_TEAM_TYPES` out of `kanban.html`.** It is a self-contained webview by design, and two contract tests (`team-scoped-role-routing.test.js:972`, `standing-orders-marker-contract.test.js:315`) read the constant *out of the HTML source text*. Moving it breaks both unless they are retargeted in the same change. The extraction must leave the webview consuming the shared module rather than keeping a copy — a copy is the drift this plan exists to avoid.
- **Extracting the CLI list out of `terminals.js`.** Same shape: a webview-local map that the CLI needs. The brand-icon mapping and the launch-command mapping are different concerns and should not be fused into one object just because both are keyed by CLI name.
- **The `startupCommands` wipe guard.** `GlobalIntegrationConfigService` explicitly refuses an empty or all-blank `startupCommands` write ("WIPE GUARD: never let an empty/all-blank startupCommands or visibleAgents…"). A wizard that writes partial selections must not trip it, and must not be *rescued* by it either — a guard silently discarding the wizard's write looks identical to success.
- **TTY detection.** `npx switchboard` runs in CI, in containers, and under process managers. Prompting where there is no TTY hangs a start that used to complete. The wizard must gate on `process.stdin.isTTY` and fall through to flags.

## Edge-Case & Dependency Audit

**The create-before-ask defect is independently shippable and should land first.** Steps 1–3 of the wizard are worth nothing if `bootstrap.ts` has already built the database by the time they run. Ordering inside first run: probe → ask → *then* create. This half fixes the reported symptom (a minute spent building a file the user deletes) even if the rest of the wizard is deferred.

**Adoption candidates, in probe order:** an explicit `--db <path>`; `SWITCHBOARD_STATE_HOME`-relative `~/.switchboard/kanban.db`; a parent-directory `db-pointer`; `<root>/.switchboard/kanban.db`. **More than one candidate is a question, not a guess** — present them and let the user choose. Silently preferring one is how `a-configured-db-path-may-not-be-where-the-board-is.md` describes installs ending up with a configured path pointing at an empty file while the real board sits elsewhere.

**Adopting a foreign DB still runs migrations.** A database from an older install is behind head and `ensureReady()` will migrate it. That is correct and must be *said* — "adopting an existing database, upgrading its schema" — because the user has just been told the wizard avoids a long build and will otherwise read the same wait as the bug they reported.

**Never create in a non-TTY, non-flagged invocation.** Today `start` creates silently. After this, a non-TTY start with no candidate and no flag should **fail with instructions** rather than build. That is a deliberate behaviour change on a shipped path and belongs in release notes: a `start` that finds nothing and creates nothing is better than one that quickly creates the wrong thing.

**Migration/compat.** No schema change. Existing installs have a resolvable DB and never see the wizard — the trigger is "no database resolved **and** no candidate adopted **and** first run", not "version changed". Re-running the wizard must be an explicit `switchboard setup`, never automatic.

**Host parity.** The wizard is standalone-only by nature (there is no terminal in the extension host), but every key it writes is read by both hosts, so the extension must see the same result. Per the standing rule in `CLAUDE.md` / `AGENTS.md`, the shared modules extracted here (team presets, CLI registry) belong to both hosts, not to the CLI.

**Scaffolding question interacts with a Planned plan.** `control-plane-scaffold-out-of-the-repo.md` (PLAN REVIEWED) makes `.agents/` and `.claude/` a gitignored, regenerated projection rather than committed content. Question 4's "inside the repo or an external folder (recommended)" should present the recommendation that plan lands on, not invent a second policy. If that plan ships first, question 4 may reduce to confirming a default.

## Dependencies

- **`hand-a-workspace-to-another-machine.md`** — question 1 ("are you migrating?") routes into that bundle's import. Until it exists, question 1 should point at the manual copy steps rather than promise an import that is not built.
- **`control-plane-scaffold-out-of-the-repo.md` (PLAN REVIEWED)** — sets the recommended answer for question 4.
- **Collides with `standalone-start-path-db-creation-parity.md`** — both edit `bootstrap.ts:467-478`. That plan makes the standalone-created DB identical to `init`'s; this one decides *whether* to create. Land that first and build the probe in front of its unified creation path, or the two rewrites conflict.

## Adversarial Synthesis

Key risks. (1) Building the wizard while `bootstrap.ts` still creates unconditionally produces a wizard that asks where to put a database that already exists — the questions must gate the creation, not follow it. (2) Duplicating `SHIPPED_TEAM_TYPES` or the CLI list into the CLI instead of extracting them gives two sources that drift, and the contract tests that read them out of HTML source text will not notice. (3) Inventing launch commands for 19 CLIs seats roles that fail on first dispatch; an empty field is better than a wrong one. (4) Prompting without a TTY guard hangs `start` in CI. (5) The `startupCommands` wipe guard silently discarding a partial write looks exactly like success. Mitigations: the create-before-ask fix is sequenced first and shippable alone; extraction is specified as move-and-consume, with the two source-text tests named; the command table is escalated to User Review rather than guessed; TTY gating and flag equivalents are required for every question; the wipe-guard interaction gets its own assertion.

## Proposed Changes

### 1. Probe before create (independently shippable)

In `bootstrap.ts`, before the `writeFileSync(dbPath, Buffer.alloc(0))`, resolve candidates in the order above. One candidate → adopt and report it. Several → prompt (TTY) or list-and-exit (non-TTY). None → run the wizard (TTY) or exit with instructions (non-TTY). Creation moves *after* the answer.

### 2. A prompting primitive

`src/standalone/wizard.ts` on `node:readline/promises`: yes/no, single-choice, multi-choice, free text. Every prompt takes a default and a flag name, so `--db`, `--scaffold-root`, `--clis` bypass it. `process.stdin.isTTY === false` short-circuits every prompt to its flag or its default.

### 3. The five questions, gated

1. **Migrating from another machine?** → yes: ask for a transfer bundle, hand to the importer, then skip 3–5 (the bundle carries those settings). No: continue.
2. **Existing database to use?** → pre-answered when the probe found candidates; the question is only asked when it found none.
3. **Where should the board live?** → `~/.switchboard/kanban.db` (recommended — survives `git clean`, a fresh clone, and ephemeral checkouts), in the repo, or a path you name. Writes `kanban.dbPath`.
4. **Where should `.switchboard/` scaffolding live?** → external folder (recommended) or in the repo. Writes `controlPlaneRoot`. Present whatever recommendation `control-plane-scaffold-out-of-the-repo.md` settles on.
5. **Which CLIs do you use?** → multi-choice over the extracted registry. Seats the core roles and the three shipped teams with a startup command per selected CLI; any CLI without a shipped default gets a free-text prompt rather than a guess.

### 4. The two extractions

- **`src/services/teamPresets.ts`** — `SHIPPED_TEAM_TYPES` moved out of `kanban.html:4854`, with the webview importing it. Retarget `team-scoped-role-routing.test.js:972` and `standing-orders-marker-contract.test.js:315` to the module in the same change.
- **`src/services/cliRegistry.ts`** — the 19 CLI keys from `terminals.js`'s `CLI_BRAND_ICON_KEYS`, plus a separate optional `startupCommand` per entry. Brand icon and launch command stay distinct fields; `terminals.js` consumes the registry for its icon map.

### 5. `switchboard setup`

A subcommand that re-runs the wizard on demand, so the flow is reachable after first run without deleting anything.

## Verification Plan

### Automated

1. `npm run compile-tests` — clean.
2. New: **probe-before-create.** Given a workspace with no DB and a candidate at `~/.switchboard/kanban.db`, assert the candidate is adopted and **no file is written** at `<root>/.switchboard/kanban.db`. Assert the absence — a test that only checks the board loads passes today.
3. New: **non-TTY start creates nothing.** With `isTTY` false, no candidate and no flag, assert a non-zero exit with instructions and no file created.
4. New: **flag equivalence.** Every question satisfied by flags produces the same config writes as the interactive path.
5. New: **wipe-guard interaction.** A partial CLI selection writes `startupCommands` successfully; assert the values are present afterward, not merely that the write was attempted.
6. New: **single source for presets.** Assert `kanban.html` no longer defines `SHIPPED_TEAM_TYPES` inline and that the extracted module is the only definition; same for the CLI list in `terminals.js`.
7. Retargeted: `test:contract:team-scoped-routing` and `test:contract:standing-orders-marker` pass against the extracted module.
8. `npm run test:contract:standalone-fork` and `npm run standalone-parity:check` — regression.

**Gate wiring:** the retargeted tests are already invoked by `.github/workflows/integration-tests.yml` (lines 228 and 177). Any new test file needs both a `package.json` script and a workflow step.

### Manual

9. Fresh machine, no `~/.switchboard`: run `npx switchboard`, walk all five questions, confirm the board comes up with the chosen DB location, the chosen scaffold root, core roles seated, and the three teams present with startup commands.
10. Same, answering "migrating" at question 1 with a transfer bundle: confirm 3–5 are skipped and the imported settings are in effect.
11. With an existing `~/.switchboard/kanban.db`: confirm it is adopted, the adoption is reported, and no new file appears in the repo.
12. Two candidates present: confirm both are listed and neither is chosen silently.
13. `npx switchboard` piped (no TTY): confirm it exits with instructions and creates nothing.

## Recommendation

Send to Coder, and **ship change 1 on its own first**. Probe-before-create is a contained fix to the reported symptom and needs none of the extractions; the wizard is a larger piece whose value is gated on two refactors and one product decision that is not the coder's to make.
