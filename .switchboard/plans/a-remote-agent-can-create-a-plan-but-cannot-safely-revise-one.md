# A Remote Agent Can Create a Plan, But Cannot Safely Revise One

## Goal

Make **revising** an existing plan reachable from a machine that is not the board host, with a
precondition that cannot be silently omitted. An agent seat on another box should be able to read a
plan, improve it, and write it back — over HTTP, with no filesystem access to the board, and with no
way to quietly destroy someone else's edit.

This is the appliance shape stated plainly: **one plans folder and one source tree, on the board
host.** Nothing is mirrored, synced, or carried in git between machines. An agent elsewhere reaches
plan text the same way it reaches everything else — over the API.

### Problem analysis

Three of the four pieces already exist. The fourth exists too, and is the problem.

**Read — solved, and correct.** `GET /kanban/plan?planId=` (`LocalApiServer.ts:11803`) returns the DB
record **plus the markdown**, read from `record.planFile` on the host, and tags which store answered
(`source`). A remote agent needs no filesystem access to read a plan today.

**Create — solved.** `POST /kanban/plans` (`:11936`) writes a new `.md` under
`.switchboard/plans/`, guards the slug against path traversal, refuses to clobber an existing file
(409), calls `importPlanFiles(root)`, and returns the planId the importer assigned. It is a good
model and the rest of this plan mostly asks the revise path to behave like it.

**Transport — solved.** The tailnet listener already exists (`LocalApiServer.ts:1515`, `:1539`), and
`_checkAuth` trusts a request that arrived on it exactly as it trusts loopback (`:1811`: *"tailnet
membership is the control"*). This plan adds **no transport and no new trust boundary**.

**Revise — reachable, and unsafe.** `POST /planning/verb/saveFileContent` is routed (`:14647` →
`_handlePlanningVerb`), `saveFileContent` is in `PLANNING_VERBS`
(`src/generated/verbAllowlist.ts`), and `PlanningPanelProvider` is constructed by the standalone host
(`bootstrap.ts:1829`). So the write is already exposed. It has five defects, and the first is the
one that matters.

**1. The precondition is optional, and omitting it overwrites.** The conflict check is

```ts
if (originalContent && diskContent !== originalContent) { /* 409-equivalent */ }
```

(`PlanningPanelProvider.ts`, the `saveFileContent` arm at `:5104`). A caller that does not send
`originalContent` gets **no check at all** and a straight overwrite. This is the repo's fallback rule
on the most destructive read there is: *absent* and *"yes, force it"* are the same value, and the
quiet one wins. A remote agent that has never heard of the field will silently discard whatever a
human typed into the plan thirty seconds earlier, and nothing anywhere records that it happened.

**2. The precondition is the entire prior document.** These plans run to 25 KB. Every revision
round-trips the full markdown twice, and the agent has no cheap way to re-check staleness before
committing to a write.

**3. The write does not re-import; create does.** `_handleCreatePlan` calls `importPlanFiles(root)`
and hands back the assigned planId. `saveFileContent` writes the file and leaves the board to
`GlobalPlanWatcherService` (`:133-172`, watching `.switchboard/{plans,features}/**/*.md`). Same host,
same directory, two different contracts — an agent that creates gets a planId, an agent that revises
gets nothing and must poll to find out whether the board caught up.

**4. The response is a webview message, not an HTTP contract.** It returns
`{ type: 'saveFileContentResult', success, conflict: exists || undefined, diskContent, tab }` — a
shape built for a panel, including a `tab` field that means nothing to a machine caller, and a
`conflict` that is `undefined` rather than `false` on the ordinary failure path.

**5. It is callable today, and nothing tells an agent so.** The CLI already carries two generic
escape hatches (`cli.ts:28-95`):

```
switchboard verb <verbName> [jsonPayload] [--json]
switchboard api <METHOD> <path> [jsonBody] [--json] [--data @<file>] [--timeout <ms>]
```

Either reaches `saveFileContent`, and the CLI is what sets the `X-Switchboard-Client` marker the
CSRF guard demands (`agentPromptBuilder.ts:1404`). So **no new command is needed to make the write
reachable** — `--data @<file>` even handles a 25 KB body.

**And there are two roads by which an agent learns what to do, which matters because they break
differently.**

*The adopt road — an agent that came in through `/switchboard`.* The launcher
(`.agents/workflows/switchboard.md`) checks `switchboard api GET /health` and **uses an existing
board** rather than starting one; with `--remote`/`SWITCHBOARD_REMOTE`/`remotes.json` that board is
the Pi. `apiTarget.ts` resolves the endpoint as a **tagged** `{ baseUrl, workspaceRoot, auth,
source }` — *"a remote root is NEVER guessed"*, *"there is no fallback between tiers"* — and the
agent then calls `POST /mission-control/adopt` (`LocalApiServer.ts:14729`), which hands back a
pre-flight `prompt` naming the protocol to fetch. It fetches it: `GET /protocol/<name>` (`:14811`).
**This road pulls.** Such an agent already holds a resolved, tagged target for the right board and
needs nothing from this plan but the verb itself.

*The clipboard road — an agent the user pasted into.* No adopt, no target, no protocol. See Change 3:
it is handed the plan's text and an absolute path on the board host, and that is the road this plan
mostly exists to fix.

What is genuinely absent is a **list**: `GET /protocol/<name>` fetches a protocol you can already
name, and verb names live in `src/generated/verbAllowlist.ts`, compiled in and exposed nowhere. An
agent can pull what it was told the name of; it cannot enumerate. That is a narrower gap than "no
discovery", and it is not this plan's to close.

So the work here is making the call **safe** (Changes 1, 2), and repairing the road that cannot
currently reach it at all (Change 3).

**6. The write is scoped to allowed roots, not to the plans folder.** `_handleCreatePlan` guards its
target to `.switchboard/plans/` explicitly. `saveFileContent` guards to `_getAllowedRoots()` — a much
wider set, for good panel reasons. Exposed to a remote caller, "revise a plan" is then really
"write any file under an allowed root", which is a far larger capability than the feature needs.

**The fix is not a second endpoint.** A `PUT /kanban/plan` beside this one would be two write paths
for one file, disagreeing about preconditions — the two-catalogues trap in a new place. Make the
existing verb safe and give it a front door.

## Metadata

**Complexity:** 3
**Tags:** api, plans, remote, concurrency, standalone
**Scope:** `LocalApiServer.ts`, `PlanningPanelProvider.ts`'s `saveFileContent` arm, the `switchboard`
CLI, and `protocol-catalog.json`. The extension host is out of scope — it is being removed, and a
second implementation there is throwaway work.

## Dependencies

**None blocking.** The tailnet listener and its auth decision already exist and are not reopened here
(see Outstanding Questions for the one thing that arguably should be).

**Related, not blocking:** `switchboard-remote` already drives plans through Linear/Notion/external
surfaces. That is a different inlet for a different actor — a human away from the desk. This plan is
the inlet for an agent seat, and the two should not grow separate write implementations. Whichever
lands later uses the verb this plan hardens.

## Proposed Changes

### 1. The precondition becomes mandatory, and absent is a refusal

Add `baseHash` — the SHA-256 of the bytes currently on disk — as the precondition for a machine
caller.

- **No `baseHash` and no explicit `force: true` → 400**, naming the missing field. Never write
  unguarded because a field was absent. This is the whole point: a caller that wants to overwrite
  must *say so in the request*, so "I forced it" and "I didn't know" stop being the same bytes.
- `force: true` is honoured and **recorded** in the response, never silent.
- Stale `baseHash` → **409** with `{ conflict: true, currentHash, content }`. The current content
  goes in the body because the agent needs it to merge and has just spent a round trip discovering
  it is behind.
- `originalContent` stays accepted for the existing panel caller — it is the same check by another
  name — but the HTTP contract is the hash, and the panel should migrate to it.

### 2. Write, then import, then say what happened

Call `importPlanFiles(root)` after a successful write, as `_handleCreatePlan` already does, so a
revise and a create leave the board in the same state by the time each returns.

Respond with the shape a machine can act on:

```json
{ "written": ".switchboard/plans/<slug>.md", "planId": "...", "contentHash": "...",
  "imported": true, "root": "...", "forced": false }
```

Never a bare `success: true`. The response names **the file it wrote and the root that answered** —
the repo's "which store answered?" rule, applied to a write. The watcher still fires afterwards;
`importPlanFiles` is keyed on plan_file + workspace_id and is idempotent, so the second pass is a
no-op rather than a second import.

### 3. Fix the prompt the user actually pastes (`KanbanProvider.ts:13893`)

**This is the road for an agent that did not adopt the board**, and it is where the whole thing
breaks. An agent that came in through `/switchboard` already holds a tagged target and pulls its own
protocol; this one holds a clipboard. Both must be able to write back, and only one of them can
today. There is no dispatch involved. The `improvePlan` verb builds a prompt and puts it on the clipboard —
*"Improve-plan prompt copied to clipboard. Paste it into your agent."* On the standalone host the
prompt comes back in the response body and `transport.js` copies it **client-side**
(`bootstrap.ts:2196-2229`, *"headless has no server-side clipboard"*), so a user on a laptop browsing
the board over the tailnet already gets it onto their own clipboard. That half works.

The prompt itself does not. It is assembled from the skill text, the plan's **full current content**,
and this line:

```
- **Local file path (write the improved content here):** ${planFilePath}
```

`planFilePath` is `path.resolve(workspaceRoot, planFile)` — **an absolute path on the board host**.
Pasted into an agent on another machine it is either a path that does not exist, or — the worse case,
and the one that actually happens — a path that *does* exist there as a different copy of the repo,
which the agent edits believing it is the board's. The prompt hands over the text and a path, and
offers no planId-keyed way to write anything back.

**The prompt must carry a handle, not a path.** Replace `planFilePath` with:

- the `planId`,
- the `contentHash` of the content embedded in the prompt (Change 4 makes the host able to state it),
- the write-back command, concretely, the way the researcher hand-off directive spells out its POST
  (`agentPromptBuilder.ts:1247`): read back if you need to re-check, write with the hash, and on 409
  re-read and merge rather than retrying with `force`.

Keep the absolute path only as an additional note for the local case, clearly labelled as valid on
the board host — never as the instruction.

**Then the protocol, in the same shape.** `.agents/protocols/improve-plan/SKILL.md` Step 1 says
*"Read the target plan file and treat it as the single source of truth."* Same correction, same
reason. Its two-tier content-preservation rule stands exactly as written — a concurrent-edit merge is
the case it was drafted for, and Change 1 finally gives it a mechanism. Note the handler reads the
`.agents` copy first and falls back to `.claude/skills/improve-plan/SKILL.md` and then to an inline
string (`KanbanProvider.ts:13903-13910`): **all three** carry the instruction, so all three change or
the fallback silently teaches the old way.

**Then the convenience command**, which is ergonomics, not capability:

- `switchboard plan read --plan <planId>` prints the markdown and the `contentHash`.
- `switchboard plan write --plan <planId> --base-hash <hash> [--file <path> | -]`.
- Exit non-zero and print the conflict body on 409, so a scripted agent cannot mistake a refusal for
  a write — the generic `switchboard api` path reports HTTP status, but an agent reading stdout for a
  409 body is one careless `| head` away from treating a refusal as success.
- Register in `protocol-catalog.json` and regenerate (`npm run catalog:generate`);
  `scripts/check-protocol-parity.js` then keeps `src/generated/verbAllowlist.ts` honest.

**Severable:** the protocol is the point. If the command is cut, the protocol documents
`switchboard api POST /planning/verb/saveFileContent --data @plan.md` instead and the feature still
works.

### 4. The read hands back what the write demands

`GET /kanban/plan` returns `contentHash` alongside `content` and `source`, so read → edit → write is
a closed loop with no second call to compute the precondition. A read that could not open the file
(the handler already tolerates a missing file and returns the record without content) returns
**no hash at all** rather than the hash of an empty string — an absent file must not present as an
empty one.

### 5. Scope the machine-reachable write to the plans and features folders

The API arm guards its target to `.switchboard/plans/` and `.switchboard/features/`, using the same
resolve-and-compare guard `_handleCreatePlan` uses (`:11967-11971`), and refuses anything else with a
message naming the allowed roots. The panel arm keeps `_getAllowedRoots()` — it is a local user
acting through the UI, and narrowing it would break the plan-editing surface for paths under a mapped
parent (the comment at `PlanningPanelProvider.ts:5109-5117` documents exactly that breakage being
fixed once already; do not re-break it).

Two callers, two scopes, one implementation, and the difference is stated where it is made.

### 6. Standalone only

`PlanningPanelProvider` is constructed by both roots (`extension.ts:1465`, `bootstrap.ts:1829`), but
this seam is wired for the standalone host. The extension is not updated and that is the intended
state, not a divergence.

## Verification Plan

### Automated

- **The regression, first:** a write with neither `baseHash` nor `force` returns 400 and the file on
  disk is **byte-identical afterwards**. Today this call overwrites.
- A write with `force: true` and no `baseHash` succeeds and the response carries `forced: true`.
- A stale `baseHash` returns 409 with `currentHash` and the current content; the file is unchanged.
- A correct `baseHash` writes, re-imports, and returns the file, planId and new hash.
- **Round trip:** the `contentHash` returned by a write equals the hash from the next read. A read of
  a plan whose file is missing returns no `contentHash` field (not the empty-string hash).
- **Two writers, one base:** both fetch the same hash, both write; the second gets 409. Assert it is
  not last-write-wins.
- A machine write targeting a path outside `.switchboard/plans` / `.switchboard/features` is refused,
  and the same path through the panel arm is unaffected.
- The write is reachable through the generic path with no new command — assert
  `switchboard api POST /planning/verb/saveFileContent` round-trips, so the convenience command
  stays severable.
- If the convenience command lands: `switchboard plan write` exits non-zero on 409 and prints the
  conflict body.
- **The pasted prompt contains no absolute host path as its write instruction.** Assert over the
  built string: it names a `planId` and a `contentHash` and the write-back command. This is the
  regression — today it names a path that is only true on the board host.
- All three skill sources produce a prompt that names the write-back: the `.agents` copy, the
  `.claude/skills` fallback, and the inline fallback string (`KanbanProvider.ts:13903-13910`). A test
  that only covers the first lets the fallback teach the old way.
- `improve-plan` no longer instructs the agent to read a plan file from its own filesystem, and names
  the `baseHash` precondition. A protocol that omits it would teach the force path.
- The new verb is present in `src/generated/verbAllowlist.ts` after `npm run catalog:generate`, and
  `scripts/check-protocol-parity.js` reports no drift.
- Run `npm run compile-tests` before any `test:contract:*` script — contract suites run against
  `out/`.

### Goal invariants

- **No write path can silently overwrite.** An unguarded write happens only because the request asked
  for one, and the response says it did.
- Every write response names the file it wrote and the root that answered.
- There is exactly one plan-write implementation. Two callers may differ in scope; they do not differ
  in precondition.
- An agent that can reach the board over the tailnet can revise a plan with no filesystem access to
  the host and no copy of the repo.
- Create and revise leave the board in the same state by the time each returns.

### Manual

From a second machine on the tailnet: read a plan through the CLI, change a heading, write it back
with the hash you read, and watch the card update on the board. Then write again with the now-stale
hash and confirm the refusal names the conflict rather than succeeding. Finally, edit the same plan
in the Planning panel while a write is in flight and confirm the loser is told, not silently dropped.

## Outstanding Questions

- **[ANSWERED 2026-09-19 — ONE COPY OF EVERYTHING]** There is one plans folder and one source tree,
  on the board host. No mirroring, no sync, no git transport between machines, and no second
  `.switchboard/plans/` on a seat machine to be confused for the real one. Operator decision.
  Consequence: this endpoint is the only agent write path, and plan line references resolve against
  the single tree — so nothing needs to record which checkout a reference was true of.

- **[ANSWERED 2026-09-19 — YES, OVER THE TAILNET, THAT IS THE PRODUCT]** A tailnet peer writes.
  An earlier draft of this plan left it open; that was wrong, and the question is struck rather than
  carried. The appliance *is* a board on a small box with agent seats on other machines: if a seat on
  the tailnet cannot revise a plan, there is no remote agent and no reason for this endpoint to
  exist. `_checkAuth` already decided it (`LocalApiServer.ts:1811`, *"tailnet membership is the
  control"*), already covers `POST /kanban/plans`, and a plan revision is a smaller capability than
  creating a card, not a larger one. Nothing here is gated behind an extra credential.

  What the tailnet bypass does **not** substitute for is the precondition. Trusting the caller is not
  the same as trusting that it read the current version — that is Change 1, and it applies equally to
  loopback.

- **[OPEN]** Should the host expose a **pull** catalogue — `switchboard verbs`, or
  `GET /protocol/catalog` — so an agent can ask what it can do, instead of only being told?

  **Fetch-by-name already exists** — `GET /protocol/<name>` (`LocalApiServer.ts:14811`), which the
  adopt handshake relies on. What is missing is enumeration, and that catalogue exists too:
  `src/generated/verbAllowlist.ts` holds `KANBAN_VERBS`, `PLANNING_VERBS` and `TICKETS_VERBS` —
  complete, generated from `protocol-catalog.json` by `npm run catalog:generate`, drift-guarded by
  `scripts/check-protocol-parity.js`, and compiled into the host. It is simply not reachable from
  anywhere a caller can stand: `cli.ts` does not import it, and `cmdVerb` (`cli.ts:2206`) neither
  lists nor validates — with no verb name it prints a usage line and exits 5, and with one it POSTs
  and lets the host refuse. Exposing it is printing three `Set`s.

  So the question is not cost, it is whether a name is an interface. A listed verb is one a seat may
  call, which makes the allowlist a public surface that cannot be renamed freely — today it is an
  internal validation artefact that happens to be exhaustive. Decide that deliberately.

  Out of scope here; this plan should not be the thing that decides it. Change 3's protocol is the
  answer for *this* verb either way — a catalogue of 500 names tells an agent that
  `saveFileContent` exists, not that it must send `baseHash`.

- **[OPEN]** Should the panel migrate off `originalContent` to `baseHash` in the same change, or
  keep both indefinitely? Keeping both is two preconditions for one write — tolerable while the panel
  is being moved out of the editor anyway (*VS Code Becomes a Sidebar*), but it should not outlive
  that move.
