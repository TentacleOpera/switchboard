# A First-Run Setup Wizard for the Standalone Host

## Goal

`npx switchboard` on a fresh machine writes a 0-byte `kanban.db` into the repo, runs 64 schema migrations against it, and hands back a board the user may not want in a location they were never asked about. If they already have a database — a copy from another machine, a global store, a sibling repo — it is ignored, and the first thing they do is delete what the tool just spent a minute building.

Give the standalone host a first-run flow split at the natural seam: **the database question in the terminal, everything else in the browser.** The location of the database is the precondition for the server, so the terminal asks it; scaffolding, CLIs, roles and teams all have working panel UI already, so the panel asks those. Standalone is increasingly the **first** contact with Switchboard, before the VS Code extension, so first run has to stand on its own; it does not have to do so in a second UI idiom.

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
| Where does `.switchboard/` scaffolding live? | `controlPlaneRoot` stores it, but nothing *probes* for it. `detectCandidateParent` answers a different question and returns nothing below two git repos. | Needs an artifact probe (`.switchboard/`, `.agents/`, `.claude/`) at repo root and external root, with "none yet" as a real answer. |
| Which CLIs do you use? | `CLI_BRAND_ICON_KEYS` in `src/webview/terminals.js` — 19 entries (claude, antigravity, devin, jules, gemini, codex, cursor, copilot, windsurf, qwen, amp, cline, kiro, kilo, trae, opencode, zed…) | It is a **brand-icon map in a webview**, not a registry. The CLI cannot import it. |
| …and seat roles from them | `config.agents.startupCommands` — live, role-keyed, values are the CLI binary plus flags (`"lead":"claude"`, `"coder":"agy"`, `"analyst":"qwen"`). `agents.visibleAgents` is its visibility twin. | No **seed** table, but the seed is near-identity over the registry keys. Small, not a product decision. |
| …and the three teams | `SHIPPED_TEAM_TYPES` in `src/webview/kanban.html:4854` — Batch planners / Coding / Review, with head roles and member shapes | Lives in a **self-contained webview**. The CLI cannot import it, and duplicating it guarantees drift. |

So the last question is blocked on two extractions — and only because a *terminal* consumer cannot import a webview. A browser consumer already can.

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

None.

> **Amended — the earlier escalation was wrong, and so was the surface.** The first draft escalated "the CLI→startup-command table is new product data" to User Review and proposed a terminal wizard. Three corrections, all from evidence that was already in the tree:
>
> **1. The startup-command data exists and is nearly trivial.** `config.agents.startupCommands` is a live, role-keyed map, and its values are the CLI binary plus optional flags:
> ```json
> {"planner":"devin --permission-mode bypass","lead":"claude","coder":"agy",
>  "intern":"agy","reviewer":"devin --permission-mode bypass","analyst":"qwen"}
> ```
> So a CLI→command default is mostly the identity function over the registry keys — `claude`→`claude`, `qwen`→`qwen`, `agy`→`agy`, `codex`→`codex`. The only genuinely open part is per-CLI flags (`devin --permission-mode bypass`), and the safe default there is no flags with an editable field. What the first draft called missing product data was a seed table that writes itself from the registry. `agents.visibleAgents` is the matching role-visibility map and gets seeded the same way. No escalation warranted.
>
> **2. Control-plane detection is the wrong probe for scaffolding.** Question 4 leaned on `controlPlaneRoot` and, by implication, `ControlPlaneMigrationService.detectCandidateParent`. That detector answers a different question: it looks for a *parent directory holding two or more git repos* and suggests consolidating there (`extension.ts:4238-4270`, gated on `discoveredRepos.filter(r => r.hasGit).length < 2`). It returns nothing for a single-repo user, and it says nothing about where scaffolding currently is. Scaffolding may not exist yet, and when it does it may sit inside the repo or outside it. Question 4 must probe for the artifacts themselves — `.switchboard/`, `.agents/`, `.claude/` — at the repo root **and** at any configured external root, and treat "none found" as a first-class answer rather than a detector returning empty.
>
> **3. This should be a webview, not a terminal wizard.** Four of the five questions already have panel UI: `setup.html` ships tabs for **Database**, **Control Plane**, Multi-Repo, Plan Scanner, Remote and more, and the Agents tab already edits `startupCommands` and `visibleAgents`. Standalone serves those same panels in a browser via `headlessPanelHtml.ts`. A terminal wizard would reimplement four existing surfaces in a second idiom, and every future setting would have to be added twice. The extension's own onboarding is the shape to follow — detect a condition, offer once, remember the dismissal — not a scripted interrogation.
>
> The revised design is therefore **probe in the terminal, decide in the browser**, specified below. The terminal owns only what must happen before a page can render; everything else is the panel that already exists.

## Complexity Audit

### Routine

- `node:readline/promises` for the single database prompt — built-in, no dependency, and the standalone bundle must stay dependency-light.
- Reading and writing config keys that already exist (`kanban.dbPath`, `controlPlaneRoot`, `startupCommands`, `visibleAgents`).
- Adding flag equivalents to `cli.ts`'s existing argv parsing.

### Complex / Risky

- **Extracting `SHIPPED_TEAM_TYPES` out of `kanban.html`.** It is a self-contained webview by design, and two contract tests (`team-scoped-role-routing.test.js:972`, `standing-orders-marker-contract.test.js:315`) read the constant *out of the HTML source text*. Moving it breaks both unless they are retargeted in the same change. The extraction must leave the webview consuming the shared module rather than keeping a copy — a copy is the drift this plan exists to avoid.
- **Extracting the CLI list out of `terminals.js`.** Same shape: a webview-local map that the CLI needs. The brand-icon mapping and the launch-command mapping are different concerns and should not be fused into one object just because both are keyed by CLI name.
- **The `startupCommands` wipe guard.** `GlobalIntegrationConfigService` explicitly refuses an empty or all-blank `startupCommands` write ("WIPE GUARD: never let an empty/all-blank startupCommands or visibleAgents…"). A wizard that writes partial selections must not trip it, and must not be *rescued* by it either — a guard silently discarding the wizard's write looks identical to success.
- **TTY detection.** `npx switchboard` runs in CI, in containers, and under process managers. Prompting where there is no TTY hangs a start that used to complete. The one prompt must gate on `process.stdin.isTTY` and fall through to `--db`.

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

### 2. Ask the bootstrap question in the terminal

The database location is the **one** question that must be answered before anything else can run, and it is the one question with no panel to duplicate — because the panel cannot render until it is answered. Ask it in the terminal.

> **Superseded:** a DB-less "setup mode" server, booting `LocalApiServer` with a null DB so the browser could collect the database location too.
>
> **Reason:** that was infrastructure invented to avoid a single `readline` prompt. Today the database is built at `bootstrap.ts:467` and the server at `:2910`; making the server boot without a database, serve a restricted route set, and then continue into normal boot without a restart is a substantial new piece — and its entire purpose would be to ask one question that a terminal can ask in three lines. The webview argument is a duplication argument, and it does not apply to a question whose answer is the precondition for the webview existing.
>
> **Replaced with:** one terminal prompt, `node:readline/promises`, gated on `process.stdin.isTTY`, with `--db <path>` as the flag equivalent. Once answered, boot proceeds exactly as it does today and the panel serves normally.

Three outcomes from the probe:

- **one candidate** → adopt it, say which, no prompt;
- **several** → list them and ask which (or `--db`);
- **none** → ask: use an existing database (path), a transfer bundle, or create a new one — and if new, where.

**Outside the repo is the default, not a recommendation.** `~/.switchboard/kanban.db` is pre-selected and accepted by pressing enter. A named external path is the second option. **In-repo is last, and choosing it requires typing the choice, not accepting a default** — and the prompt states what it costs in one line rather than leaving the user to discover it.

The cost is not a matter of taste, and the withdrawn `db-location-chosen-at-install.md` had already assembled the evidence:

> `git clean -xdf` deletes the board. So does a fresh clone, so does deleting and re-cloning a repo, so does any ephemeral checkout — a cloud session, a CI job, a container. A read-only or mounted-in repo cannot host a writable board at all. Synced folders corrupt it.

That plan was withdrawn as superseded by the consolidation work, but the argument survives its withdrawal and nothing has shipped that answers it.

**And the backups do not rescue it, because they are in the repo too.** `writeDbBackup` derives its target from the *workspace root*, not from the database's own location (`KanbanDatabase.ts:7306`):

```ts
const backupDir = path.join(this._workspaceRoot, '.switchboard', 'dbbackup');
```

So `git clean -xdf` takes the board and every snapshot of it in the same stroke. In this workspace that directory is **29 MB across 4 files** — four whole copies of a 7.3 MB database, sitting inside the repository, protecting nothing against the failure mode most likely to destroy the original.

Worse, it does not follow the database. A user who moves the DB to `~/.switchboard/kanban.db` still gets backups written into `<repo>/.switchboard/dbbackup/` — so the recommended choice silently keeps one foot in the repo. **Fix this alongside the default:** derive `backupDir` from `path.dirname(this.dbPath)`, so backups live wherever the database lives. Without it, "store it outside the repo" is only half true and the half that fails is the recovery half.

Non-TTY with no candidate and no `--db` exits with instructions and creates nothing.

That collapses the first three of the five questions into one exchange, because "are you migrating?", "do you have an existing database?" and "where should it live?" are the same decision asked three ways.

### 3. Everything else is the panel that already exists

Scaffolding location, CLI selection, role seating and the three teams all have working UI in `setup.html` and the Agents tab, and standalone already serves them. They are asked **after** boot, in a first-run panel mode shaped like the extension's onboarding (`extension.ts:4238-4270`): a condition, an offer, a remembered dismissal.

The terminal prints the URL once and does not ask about any of them.

### 4. The scaffolding probe (panel-side)

Driven by an **artifact probe** — `.switchboard/`, `.agents/`, `.claude/` at the repo root *and* at any configured external root. Report what was found and where; treat "none yet" as a first-class answer with a recommendation, not as a detector returning empty. Do **not** call `detectCandidateParent`: it is gated on two or more git repos and answers "should you consolidate a control plane", a different question with a different trigger.

### 4a. Backups follow the database

Change `writeDbBackup`'s `backupDir` from `<workspaceRoot>/.switchboard/dbbackup` to `<dirname(dbPath)>/dbbackup`. Existing in-repo backup directories are left alone — not migrated, not deleted — since they are recovery artifacts and deleting them is the opposite of the point. New snapshots land beside the database.

This is small, independently shippable, and it is the difference between the recommended location being genuinely outside the repo and being outside the repo except for its backups. `kanban-db-backup-retention-deletes-the-wrong-files.md` (CODE REVIEWED) owns retention *within* the directory and is unaffected by where the directory is.

### 4b. The seed table

`src/services/cliRegistry.ts` carries the 19 keys with an optional `startupCommand` defaulting to the key itself. Per-CLI flags are the only hand-authored part and default to none, with the field editable in the panel. Seeding writes through the same `GlobalIntegrationConfigService` path the panel uses — and must clear the wipe guard rather than be silently discarded by it, which looks identical to success.

### 5. `switchboard setup`

A subcommand that reopens the first-run panel on demand, so the flow is reachable after first run without deleting anything. It is the dismissal's escape hatch.

## Verification Plan

### Automated

1. `npm run compile-tests` — clean.
2. New: **probe-before-create.** Given a workspace with no DB and a candidate at `~/.switchboard/kanban.db`, assert the candidate is adopted and **no file is written** at `<root>/.switchboard/kanban.db`. Assert the absence — a test that only checks the board loads passes today.
3. New: **no-candidate, non-TTY start creates nothing.** With `isTTY` false, no candidate and no `--db`, assert a non-zero exit with instructions and **no database file written** anywhere. Assert the absence — a test that only checks the board loads passes today.
4. New: **flag equivalence.** `--db <path>` produces the same adoption and the same config write as answering the prompt, and suppresses the prompt entirely.
4b. New: **scaffolding probe.** Given `.agents/` at the repo root and nothing external, assert the probe reports repo-local; given neither, assert "none yet" rather than an empty result; assert `detectCandidateParent` is **not** on this path.
5. New: **wipe-guard interaction.** A partial CLI selection writes `startupCommands` successfully; assert the values are present afterward, not merely that the write was attempted.
6. New: **single source for presets.** Assert `kanban.html` no longer defines `SHIPPED_TEAM_TYPES` inline and that the extracted module is the only definition; same for the CLI list in `terminals.js`.
7. Retargeted: `test:contract:team-scoped-routing` and `test:contract:standing-orders-marker` pass against the extracted module.
8. `npm run test:contract:standalone-fork` and `npm run standalone-parity:check` — regression.

**Gate wiring:** the retargeted tests are already invoked by `.github/workflows/integration-tests.yml` (lines 228 and 177). Any new test file needs both a `package.json` script and a workflow step.

### Manual

9. Fresh machine, no `~/.switchboard`: run `npx switchboard`, answer the database prompt, then follow the printed URL and complete the panel. Confirm the board comes up with the chosen DB location, the chosen scaffold root, core roles seated with startup commands, and the three teams present.
10. Same, answering "migrating" at question 1 with a transfer bundle: confirm 3–5 are skipped and the imported settings are in effect.
11. With an existing `~/.switchboard/kanban.db`: confirm it is adopted, the adoption is reported, and no new file appears in the repo.
12. Two candidates present: confirm both are listed and neither is chosen silently.
13. `npx switchboard` piped (no TTY), no candidate, no `--db`: confirm it exits with instructions and creates nothing. With `--db`, confirm it boots unattended exactly as today.
14. Single-repo user (the case `detectCandidateParent` returns nothing for): confirm scaffolding is still probed and answered.

## Recommendation

Send to Coder, and **ship change 1 on its own first**. Probe-before-create is a contained fix to the reported symptom and needs neither the setup-mode server nor the extractions. The rest is a first-run mode over panels that already exist, plus two extractions; nothing in it is new infrastructure.
