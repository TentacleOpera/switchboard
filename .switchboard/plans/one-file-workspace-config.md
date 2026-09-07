# One File Configures a Workspace, and It Is the File the Docs Show

kanbanColumn: CREATED

## Goal

A single declarative file expresses a complete working Switchboard setup — where the board lives,
which CLIs seat which roles, which tracker, which serve mode. It is what the documentation shows, it
is what you copy to a second machine, and it is diffable in git.

### Problem analysis

**Configuration currently lives in five places, and no single one can describe a working install.**

```
package.json contributes    88 VS Code settings
config table                in the board database
integration-config.json     global, machine-wide
/etc/switchboard/switchboard.env   what systemd reads
.switchboard/config.json    per workspace
```

A new user cannot see their setup, cannot copy it, and cannot tell which store answered a given
question. An experienced one cannot either — tonight established that `linear.config` in the
database can hold nothing but `{"_migrated":true}` while a working credential sits in the encrypted
store, so *"is Linear configured?"* is unanswerable from any single file.

**The nearest comparable tool does this in one file.** Sortie's whole configuration is a
`WORKFLOW.md` — YAML frontmatter for tracker kind, credentials, `query_filter`, `agent.kind` and
`max_concurrent_agents`, with the body as the templated prompt. Switching agent is described as
*"a one-line change"*. Whatever else differs between the products, that is a better onboarding
artefact than 88 settings across five stores, and it is the difference between a README that shows a
config and a README that describes a UI tour.

**This matters most for the goal of getting people to try it.** Every question a first-run flow has
to ask is a question a file could have answered, and every setup that cannot be copied is a setup
that has to be rebuilt on the second machine.

**The hazard is obvious and must be designed against.** A sixth configuration store that competes
with the five is worse than the five. This codebase's most-cited defect class is a value whose
source cannot be identified after the fact.

## Metadata

- **Complexity:** 6
- **Tags:** config, onboarding, ux, standalone, both-hosts

## User Review Required

None. Change 2 takes the precedence decision.

## Proposed Changes

### 1. `switchboard.yaml` at the workspace root — declarative, partial, and optional

One file, checked into the repo if the operator wants, holding what a setup actually needs:

```yaml
board:     { location: ~/.switchboard, port: 7777, serve: tailnet }
agents:
  lead:     { cli: claude, startup: "claude --permission-mode bypass" }
  coder:    { cli: devin }
  reviewer: { cli: claude, host: tower }        # host: the SSH-seat card
tracker:   { kind: linear, project: Switchboard, import: "label:agent-ready" }
```

**Partial is normal.** A file declaring only `board.port` is valid; everything it omits resolves
exactly as it does today. This is not a migration of the five stores — it is a layer above them that
can express any subset.

**Credentials are never in it.** Tokens stay in the encrypted store. The file names *which* tracker,
not how to authenticate to it — `integration-config.json`'s corruption history is reason enough not
to put a secret in a file people will paste into issues.

### 2. Precedence, decided and reported

The order, most specific first: **an explicit CLI flag → `switchboard.yaml` → the existing stores →
the built-in default.**

Every read reports which layer answered, extending the `source` vocabulary `GET /settings` already
has. "Which store answered?" must be answerable after the fact, for every value, or this becomes the
sixth store rather than the front door.

A value present in the file **and** changed later in the settings window is the one case that must
be unambiguous: the window writes to its own store, the file wins on next start, and the window says
so at save time rather than appearing to succeed.

### 3. The settings window writes it back

`307d08aa` gives the operator a UI. This gives them a file. They must be the same configuration
seen two ways — the window offers "export to `switchboard.yaml`", and a file present at startup is
shown in the window with the file named as the source.

Two surfaces that cannot round-trip is how the sixth store appears.

### 4. It is what the documentation shows

The README, the first-run flow and the Pi install guide all show the file. A user who reads any of
them ends up with something they can copy, diff and paste into an issue when asking for help.

This is the actual deliverable. The parser is straightforward; making it the documented path is the
change.

## Edge-Case & Dependency Audit

1. **Both hosts read it.** A file honoured by standalone and ignored by the extension is worse than
   no file. Verify by reading both composition roots.
2. **It is not the transfer bundle.** `hand-a-workspace-to-another-machine.md` carries board *state*
   — plans, projects, priorities. This carries *configuration*. Both are portable and they are not
   the same thing; say so in each.
3. **No secrets, ever.** A contract test should fail if a token-shaped key is accepted.
4. **Unknown keys are preserved, not dropped.** A file written by a newer version and read by an
   older one must survive a round trip through the settings window.
5. **A malformed file fails loudly at startup.** It must never be read as "unconfigured" — that is
   the `catch { return {} }` defect the codebase already names.
6. **Do not migrate the 88 VS Code settings here.** That is the sidebar plan's stage 4. This layer
   sits above whatever those become.

## Verification Plan

1. A workspace with only `switchboard.yaml` and no other configuration starts a board on the
   declared port, in the declared serve mode, with the declared roles seated.
2. A file declaring one key changes only that key; everything else resolves as before.
3. Every value's source is reportable, and a value from the file reports the file.
4. A CLI flag overrides the file for that run, and the reported source says so.
5. Copying the file to a second machine reproduces the setup, with no secrets carried.
6. A token-shaped key in the file is rejected with a message naming the secret store.
7. A malformed file stops startup with a parse error naming the line — it is never treated as absent.
8. Round-tripping through the settings window preserves unknown keys.
9. Both hosts honour the file, verified by reading both roots.
