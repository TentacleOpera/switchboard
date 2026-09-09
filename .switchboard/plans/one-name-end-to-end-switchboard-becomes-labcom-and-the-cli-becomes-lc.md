# One Name End to End: Switchboard Becomes LABCOM, and the CLI Becomes `lc`

## Goal

Ship one name. The product is LABCOM on the site and Switchboard in the code, the CLI, the package,
the docs and every instruction handed to an agent — and the site already advertises commands that do
not exist. Rename the **user- and agent-facing surface** to LABCOM / `lc`, leave the **on-disk and
config identifiers** alone, and keep an alias so a running fleet does not break mid-flight.

### Problem analysis

**The site is already ahead of the code.** The landing page tells a reader to run:

```
sudo apt install labcom          npx labcom          lc-next
```

None of those exist. `package.json` is `name: "switchboard"`, its only bin is
`{"switchboard": "./dist/standalone/cli.js"}`, `displayName` is `Switchboard`, publisher `TurnZero`.
So the page's install instructions are currently wrong, not merely inconsistent.

**The surface, measured:**

| Surface | Count | Rename? |
|---|---|---|
| `npx switchboard …` usage lines in `src/standalone/cli.ts` | 58 | yes |
| distinct agent-facing verbs in prompts/orders | 5 | **yes — highest risk** |
| docs files mentioning it | 23 | yes |
| `switchboard.*` scoped config keys | many | **no** (or migration) |
| source files referencing `.switchboard/` on disk | 63 | **no** |

**The agent-facing five are the dangerous ones.** `teamWiring.ts`, `agentPromptBuilder.ts` and
`bundledProtocols.ts` embed `switchboard --`, `switchboard api`, `switchboard done`,
`switchboard next` and `switchboard verb` in text that **agents execute**. Standing orders already
delivered to live seats hold the old strings, and a seat re-reads its orders from a prompt, not from
a registry. Rename the binary without an alias and every running seat starts issuing commands that
do not exist — completion callbacks included, so the queue silently stops draining.

**What must NOT be renamed.** `.switchboard/` holds 2,353 plans, the board databases,
`api-server-port.txt` and the backups; scoped settings are keyed `switchboard.prompts.…`,
`switchboard.activeTab` and so on. Renaming either is a data migration, not a rename, and buys
nothing a user can see. `lc-` is already the tmux session prefix, so the short name is in use in
exactly the one place where it is cosmetic.

## Metadata

**Complexity:** 7
**Tags:** rename, cli, docs, both-hosts
**Dependencies:** none, but **sequence it before**
`hero-animation-shows-two-dispatch-paths-linear-then-cli` — that art draws `lc-next`, and the site
copy already says `lc-next`, so both are wrong until this lands.

## User Review Required

None. The command shape is decided: **`lc <verb>`**, a single binary with subcommands. No hyphenated
shims. Operator, 2026-09-09: *"cli hasn't released yet. go with lc next."*

## Proposed Changes

### 1. Command shape: `lc <verb>`, one binary, no shims — DECIDED

- A single `lc` binary with subcommands, exactly the shape the CLI already has
  (`switchboard next` → `lc next`). The argument parser needs no change; only the name does.
- **No hyphenated per-verb shims.** They were considered for the hand-typed short form, and rejected:
  nothing to package, install or keep in sync is worth more than one saved character.

### 2. Rename the package and bin. No alias, no compatibility shim

- `package.json`: `name` → `labcom`, `displayName` → `LABCOM`, bin becomes `lc`. The old name is
  **removed**, not deprecated. The CLI has not been released, so there is nothing external to keep
  working, and an alias would leave the old name in the tree indefinitely — which is the thing this
  plan exists to end.
- **The one real hazard, and how the rollout handles it:** a seat that is already running holds
  `switchboard done` (and the other verbs) as *text* inside its standing orders — a prompt, not a
  lookup. After the rename that callback runs a command that no longer exists, and it fails quietly,
  so the queue stops draining with no error to see. The answer is change 3, not an alias.

### 3. Roll it out by restarting the fleet

- **Order of operations:** stop the fleet → land the rename → start teams again. A restarted team is
  dispatched fresh standing orders containing the new verbs, so no seat can be holding the old ones.
- **Why this is cheap:** starting a team is one press, and group seats are disposable by design (see
  `groups-are-ephemeral-teams-are-durable-one-store-cannot-be-both`). The cost of a restart is far
  less than carrying a second name.
- **Do not land the prompt-text change (4) while seats from before it are still running** — that is
  the same hazard from the other direction.

### 4. Update the agent-facing instruction text

- `teamWiring.ts`, `agentPromptBuilder.ts`, `bundledProtocols.ts`: the five verbs above.
- Land this **after** the alias exists, never before.
- Seats already holding old orders keep working via the alias; they pick up the new text on their next
  clear-and-dispatch, which happens per subtask anyway.

### 5. Update the CLI's own 58 usage lines and `--help`

- Mechanical, but it is the surface a human reads first, so it should be one pass, not incremental.

### 6. Docs sweep (23 files)

- Include `docs/LOW_MEMORY_HOSTS.md` and `docs/REMOTE_ACCESS.md`, which name the binary in verification
  procedures a reader is meant to run.

### 7. Rename the site repo and base path — do this FIRST, it only gets dearer

- `github.com/TentacleOpera/switchboard-site` → `labcom-site`, and
  `astro.config.mjs:6` `base: '/switchboard-site/'` → `/labcom-site/`.
- **Free today, expensive later.** The repo is `PRIVATE` with no `homepageUrl` set, so nothing is
  published and no external link exists to break. Every site URL currently carries
  `/switchboard-site/`; once the page goes public that path is in every shared link, every search
  result and every doc cross-reference. This is the one item in the plan whose cost rises with delay.

### 8. Migrate the `switchboard.*` config keys

- 43 keys are actually persisted in the live board database (`config` table, `key LIKE
  'switchboard.%'`). They are constructed at call sites rather than declared as constants, so a
  literal-string grep finds none — the rename has to follow the key builders, not a list.
- **Migration, not a fallback:** on boot, for each old key with no new counterpart, copy it across and
  delete the old. One pass, idempotent, no dual-read path left behind. There are no other installs to
  consider.

### 9. Rename the `.switchboard/` state directory — largest, and last

- Scope, measured: **2,716 git-tracked files** under `.switchboard/`, **63 source files** referencing
  the path, and **770 files whose text mentions `.switchboard/`** (plans and docs quoting paths).
- Do it as its own commit, mechanically: `git mv`, then a path-string sweep across source, then
  content. Land it after 1-8 so a bisect of the rename does not also move 2,716 files.
- Live installs need `mv ~/.switchboard ~/.labcom` before the new build starts. On this box that is one
  command; there is nothing else deployed.
- **The plan text itself is affected** — these plans quote `.switchboard/plans/...` paths constantly,
  so the sweep must include `.switchboard/plans/*.md`, which is the directory being renamed. Do the
  content sweep after the `git mv`, not before.

### 10. Explicitly out of scope

- Nothing. Every occurrence of the old name is covered by 1-9. If something is found that is not, it is
  a gap in this plan rather than a deliberate exception.

## Verification Plan

### Automated Tests

- `test:contract:no-legacy-binary-in-agent-text` (new): no string handed to an agent —
  standing orders, head prompts, bundled protocols — contains the old binary name.
- `switchboard` is **gone**, with no exceptions: `grep -ri switchboard` over the repo returns nothing
  outside git history. Assert it as a contract test so it cannot regress.
- The config migration (change 8) is idempotent: running it twice leaves the same 43 keys, and a board
  written before the rename opens with its settings intact.
- `--help` mentions `lc` and never `npx switchboard`.

### Goal Invariants

- Nothing a user or an agent is told to run is a command that does not exist.
- `.switchboard/` and `switchboard.*` are untouched by this change.
- Every site claim about installation matches a real bin name.

### Manual

1. `apt install labcom` (or the packaged equivalent) then `lc --help` — works.
2. `switchboard --help` — command not found. That is the intended result.
3. Stop the fleet, land the rename, start a team: a coder finishes a subtask and its completion
   callback lands using the new verb.
4. Confirm no seat predates the rename before declaring it done — `tmux ls` creation times against
   the deploy time is enough.

## Outstanding Questions

- **[user]** Command shape — change 1. `lc` plus shims is the recommendation; the operator's `lc-next`
  suggests hyphenated throughout.
- The VS Code extension id (`open-vsx.org/extension/TurnZero/switchboard`) is linked from the site's
  nav and CTA. The extension is being deprecated, so the cheapest answer may be to drop the links
  rather than rename the listing — but that is a decision, not an omission.
