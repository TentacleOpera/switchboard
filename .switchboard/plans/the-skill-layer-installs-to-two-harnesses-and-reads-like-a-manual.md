# The Skill Layer Installs to Two Harnesses, and Reads Like a Manual

## Goal

`switchboard agent-setup` scaffolds the skill layer into whatever agent harness the operator uses —
the agent-side counterpart to the board scaffolder the CLI already has — and what it installs is a
table a 2-billion-parameter local model can actually follow, rather than four hundred lines of
conditional prose.

### Problem analysis

**1. `init` knows two conventions, and the operator is using a third.**

`switchboard init [--target <agents|claude|both>]` installs the skill layer into `.agents/` or
`.claude/`. Those are the two hosts the product grew up with. An operator running any other harness
gets nothing and must copy files by hand, guessing at that harness's discovery rules.

This is not hypothetical: the reference deployment for this work runs **Pi**
(`@earendil-works/pi-coding-agent`), whose settings carry `skills`, `prompts` and `extensions` paths
in `~/.pi/agent/settings.json`. It discovers skills perfectly well — it has simply never been told
where Switchboard's are. The same is true of anything else with a filesystem and a config file.

**2. The skills that drive the board are written for a large model.**

| skill | lines | bytes |
| --- | --- | --- |
| `manage-features` | 487 | 27,733 |
| `query-kanban` | 332 | 12,148 |
| `kanban-operations` | 288 | 20,492 |
| `switchboard` (launcher) | 124 | 5,895 |

**The constraint is not token budget, and assuming it is leads to the wrong fix.** Measured on the
reference host (`gemma4:e2b-it-qat`, CPU-only, 4 cores): warm prefill runs at **2733 tok/s**, so
`kanban-operations` at roughly 5,100 tokens costs about two seconds to read. That is affordable.

What a 2B model cannot reliably do is *follow* 288 lines of branching prose — nested conditionals,
caveats about which of four paths applies, paragraphs of rationale between the instruction and the
command. Shortening the file is not the fix; **removing the branches is**. A skill for a small model
is a verb table and a worked example, not a manual with the reasoning left in.

Evidence from the same host, same day: given the shipped judgement prompt, `gemma4:e2b-it-qat`
produced a correct classification but omitted the required `CLASS:` prefix in four replies out of
six. It knew the answer; it did not hold the format. Every instruction a small-model skill adds is
an instruction it may drop.

**3. There is no console entry point, by design, and nothing replaced it.**

`/switchboard` states its own scope: *"Everything else — browsing the board, moving cards… belongs
to the board (open it in a browser) and the skills that own each concern. This skill is a launcher,
not a console."* That was a correct decision for a host with a browser beside it. For an operator in
a mosh session on a phone or tablet, "open it in a browser" is the thing they are avoiding, and the
skills that own each concern are the four-hundred-line ones above.

**Why this is worth doing at all.** The board's own PTY surface is still under development, and a
mosh session is smoother to type into than a browser-hosted terminal on a tablet. An operator should
be able to drive the board from the client they are already comfortable in. That argument is already
accepted for humans — `board-commands-in-the-switchboard-cli.md` makes it explicitly, and the CLI
board commands shipped. This plan extends the same argument to the *agent* sitting in that terminal.

### What already works and must not be disturbed

- **The CLI board commands.** `plans`, `ready`, `dispatch`, `done`, `accept`, `next`, `reports`,
  `clear`, `fleet`, `status` are shipped and are the mechanism. Nothing here adds a second way to
  reach the board — a skill that does anything other than invoke the CLI is wrong.
- **`board-commands-in-the-switchboard-cli.md`'s conclusion**, that an agent is an expensive way to
  make an HTTP call. The small-model skill exists for the operator who is *already talking to an
  agent*, not to insert one where a command would do.
- **The existing skills.** They work for the models they were written for and are not to be rewritten
  or trimmed. This plan adds a profile beside them.
- **`audit-agent-skills-structure.md`'s host-split work** on discovery and frontmatter coherence.
  This plan adds targets to that structure; it does not re-litigate it.
- **The `npx` prohibition** in the launcher skill — `switchboard` on the public registry is an
  unrelated third-party package. Any new skill repeats that rule or omits the command entirely.

### Non-goals

- **An MCP surface.** Covered for shell-less hosts by its own plan; every harness in scope here has a
  shell.
- **`switchboard attach`.** The live-seat-view problem is its own plan.
- **Rewriting `manage-features`, `query-kanban` or `kanban-operations`.**
- **Making the small-model profile capable of everything.** It is deliberately a subset. A model that
  needs the full surface should be given the full skill, or should not be driving the board.

## Metadata

**Feature:** (unassigned)
- **Complexity:** 4
- **Tags:** backend, cli, skills, docs

## User Review Required

- **[RESOLVED 2026-09-17] It is a scaffolder, not a flag.** Operator: *"ideally the user just
  writes something like `switchboard agent-setup` and the cli just scaffolds it in the agent
  location. the cli already has a scaffolder for the board, it needs a scaffolder for the agent
  location."* So change 2 is a new command modelled on the existing `scaffold`, not another
  `--target` value on `init`. Which harness layouts it knows about is an implementation choice
  inside that command.
- **[RESOLVED 2026-09-17] Mutating verbs are in scope.** Operator: *"yes, because that's most of
  the point. a user just wants to say 'dispatch my next card' and it gets done."* The profile carries
  `next` and single-seat `clear`; it excludes `--all` and `dispatch <planId>`, and carries an
  explicit refusal list. See change 1 for the measurements behind each exclusion.

## Complexity Audit

### Routine

- A scaffolder command alongside the existing board scaffolder.
- Writing one short skill file.

### Complex / Risky

- **A verb table hand-copied from the CLI can drift** — but loudly, since a wrong command is
  rejected on sight. A test that every named command exists is sufficient; generation is not.
- **Every harness has its own discovery rule**, and a named target encodes someone else's convention
  into this repo. Pi's `skills` path is stable today; that is a statement about today.

## Edge-Case & Dependency Audit

### Security

- **A skill tells an agent to run shell commands.** The small-model profile must not contain any
  command that takes a path or a shell fragment from the model's own reasoning. Every command in it
  is a fixed verb with named arguments drawn from board state.
- **`npx switchboard` fetches a stranger's package** on an uninstalled machine. The profile names
  `switchboard` only, and says to stop if it is missing rather than substitute anything.

### Side Effects

- **A skill installed into a harness the operator later reconfigures becomes a stale copy** with no
  owner. `init` should record where it wrote, so a later run can find and update it rather than
  leaving duplicates.

### Dependencies & Conflicts

- Adds a command to `src/standalone/cli.ts` beside `scaffold` — standalone only, per the cutover rule.
- Shares the skill source tree with `audit-agent-skills-structure.md`. If both are in flight, that
  plan owns the structure and this one owns the targets and the new profile.

## Adversarial Synthesis

The risk is maintaining install targets for harnesses this project does not control, and shipping a
second skill that says a subset of what an existing skill says — two documents to keep true instead
of one. Mitigations: generate the verb table from the CLI so neither document can drift from the
commands; keep the profile to read-only verbs unless the User Review says otherwise, so a stale copy
is inert rather than dangerous; prefer one generic target over a catalogue of named ones.

The opposite risk is that the product claims to be driveable from any terminal while its agent layer
installs to exactly two harnesses, one of which is being removed.

## Proposed Changes

### 1. A small-model profile: a hand-written table, ~20 lines, read-only by default

A verb table and nothing else — no rationale, no conditionals, no "if the board is not running,
consider…".

> **Superseded:** "The table is generated from the CLI's own command registry at build time so it
> cannot drift from the commands it names."
> **Reason:** over-engineering. The table is eight lines naming eight commands, and a wrong command
> **fails loudly** — the CLI rejects it and the operator sees it immediately. That is the opposite of
> the quiet-wrong-answer case the repo's fallback rule exists for, so it does not earn a build step,
> a registry classification and a generation test. Hand-write it; fix it when it breaks.
> **Replaced with:** a test asserting every command named in the profile exists in the CLI, which
> catches drift without generating anything.

**Measured 2026-09-17**, `gemma4:e2b-it-qat` on the reference host, against a first draft of this
table (18 lines) and ten natural-language questions: **7 of 10 produced a runnable command**, at
~2 s each, including correctly declining both "delete all the cards" and "what's the weather".

The three failures are all text problems, not model problems, and name what the profile must get
right:

- **Placeholders are copied literally.** `switchboard plans "<column>"` in the table produced
  `switchboard plans <column>` as output. Show a real value — `switchboard plans "Coding"` — and the
  substitution works.
- **Quotes are dropped.** `--search "<topic>"` produced `--search auth refresh`, which parses as two
  arguments. Quoting must be stated, not demonstrated.
- **Adjacent rows are confused.** "What can I start next?" selected `plans` over `ready` despite the
  `ready` row naming that phrasing. Where two rows are close, the distinction needs stating.

An earlier, vaguer draft scored worse on declining but better on substitution, so these trade against
each other and the profile should be re-measured after any edit rather than reasoned about.

**Scope: read and write.** Operator decision, 2026-09-17: dispatching is most of the point — the
goal is to say *"dispatch my next card"* and have it happen, not merely to query. So the table
carries `ready`, `plans`, `fleet`, `status`, `reports`, plus `next` and single-seat `clear`.

`switchboard next` ("pull the next card from the queue for a seat") is what makes this safe to
attempt at 2B: it dispatches **without an id**, so the model never has to read a card list, extract
an identifier and carry it into a second command. Chaining is where a small model would fail;
`next` removes the chain. `dispatch <planId>` is deliberately absent for the same reason.

**No fleet-wide clear.** `switchboard clear --all` resets the context of every live seat. It is a
deliberate feature with a UI button and is unchanged in the CLI — but it is not in this table. A
model can only reach what the table lists, and a fleet-wide context wipe is not a thing a model
should resolve from an ambiguous sentence.

**Omission is not refusal — the table needs an explicit "cannot" list.** Measured 2026-09-17: with
`--all` merely absent, `gemma4:e2b-it-qat` asked *"delete all the cards"* still answered
`switchboard clear --all`, reaching for the nearest destructive-sounding row. Nothing in the product
deletes cards; the request had no correct answer, and the model approximated rather than declined.

It only declined once the profile **named the refusals directly** — deleting, removing or archiving
cards, plans or features; editing or renaming a card; anything touching files, git or the repo. With
those lines present, both *"delete all the cards"* and *"rm -rf the repo"* correctly returned
"I can't do that".

Two further lines earned their place by measurement:

- **`clear` frees a SEAT; it never deletes a card.** Without this, "clear" and "delete" blur.
- **A question ("what", "which", "is", "anything") reads the board; it never dispatches.** Measured:
  *"what can I start next?"* selected `next`, which acts, over `ready`, which reads. Read-shaped
  phrasing selecting a write-shaped command is the same failure class at lower stakes.

Measured outcome of the full table, twelve natural-language cases: **10 of 12** correct, ~2 s each,
with both destructive prompts correctly refused. The two misses were `"which terminals are up"` →
`status` rather than `fleet`, and the `next`/`ready` confusion above.

Shape, roughly:

```
Pick ONE line from the table and run it exactly, replacing only the quoted parts.
If no line matches, reply "I can't do that" and run nothing.

user asks about                            run
ready work, what to start, what is next    switchboard ready
the board, all cards, everything           switchboard plans
one column                                 switchboard plans "Coding"
finding a card by topic                    switchboard plans --search "auth refresh"
seats, terminals, agents, who is running   switchboard fleet
whether the board or server is up          switchboard status
blocked or stuck work                      switchboard reports --kind blocked
dispatching or starting the next card      switchboard next
dispatching the next card to one seat      switchboard next --from "coder-1"
freeing or resetting ONE seat              switchboard clear "coder-1"

These are NOT in the table. Reply "I can't do that" and run nothing:
  deleting, removing or archiving cards, plans or features
  editing, renaming or moving a card
  anything about files, git, or the repo

`clear` frees a SEAT. It never deletes a card.
A question ("what", "which", "is") reads the board. It never dispatches.
Always keep the quote marks shown above.
Never run `npx switchboard`.
```

### 2. `switchboard agent-setup` — a scaffolder for the agent location

The CLI already scaffolds a **board** (`switchboard scaffold --parent-dir … --workspace-name …`).
It has no equivalent for the **agent** side. `agent-setup` is that command, modelled on the existing
scaffolder rather than bolted onto `init` as another `--target` value:

- detects or is told the harness location, writes the skill files there, and prints anything the
  operator must add to that harness's own config;
- records where it wrote, so a second run updates rather than leaving a stale duplicate;
- knows Pi's layout (`~/.pi/agent/`, whose settings carry `skills`, `prompts` and `extensions`
  paths), since that is the reference deployment, and accepts an explicit directory for anything it
  does not know.

`init --target agents|claude|both` keeps its current meaning. This is a sibling command for a
different job, not a widening of that flag.

### 3. A console entry that is honest about being one

The launcher keeps its scope. The small-model profile is the console for a terminal agent, and says
so in one line, so the two are not confused by an operator reading both.

## Verification Plan

### Automated Tests

- **Every command named in the profile exists in the CLI.** A test parses the profile and asserts
  each command resolves, catching drift without generating the table.
- **No fleet-wide clear in the profile.** The shipped profile text contains no `--all`.
- **`dispatch <planId>` is absent**, so the profile never requires a small model to chain an id
  between two commands.
- **Refusal regression, against the profile rather than the model:** given the profile, "delete all
  the cards" and "rm -rf the repo" both emit no command. These are the measured cases that produced
  `switchboard clear --all` before the refusal list existed.
- **`agent-setup` writes to the Pi skills path**, and a second run updates rather than duplicating.
- **`agent-setup` with an explicit directory** prints the operator's next step and writes nothing
  outside that directory.
- **`init` is unchanged** — its existing targets behave exactly as before.
- **The profile contains no `npx`.**

### Model Evaluation

The reference host makes this measurable rather than asserted, and it is the test that matters:

- Given the profile and ten natural-language board questions, `gemma4:e2b-it-qat` selects the correct
  command for each, with **no invented flags**. Record the pass rate; a profile that a 2B model
  cannot follow has failed its only purpose regardless of how it reads.
- Record the same pass rate for `kanban-operations` as a baseline, to show the profile earns its
  existence rather than assuming it does.

### Goal Invariants

- An operator on a harness that is neither Claude Code nor Antigravity can install the skill layer
  with one command and be told exactly what to configure.
- The small-model profile names only commands the CLI actually has.
- Nothing in the profile reaches the board except through the CLI.
- The read-only profile cannot change board state.
- The existing skills are unchanged.

## Outstanding Questions

- **Does the profile need to teach output parsing?** `--json` is precise but a small model reading a
  large JSON board may do worse than with the human-readable form. Untested, and it decides whether
  `--json` belongs in the table at all.
- **What happens when the board is not running?** The launcher skill handles this in prose the small
  profile cannot afford. Possibly the CLI should say it plainly enough that no skill text is needed —
  which would be a CLI change, not a skill one.
- **Is one profile enough, or one per harness?** Pi, Open WebUI and a bare terminal differ in how
  they present a skill, even where the content is identical.
