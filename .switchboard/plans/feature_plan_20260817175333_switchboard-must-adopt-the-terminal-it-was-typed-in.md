# /switchboard must adopt the terminal it was typed in, not seat a second one

## Goal

`/switchboard` must turn **the terminal the user typed it in** into the orchestrator
terminal. Today it spawns a *different* terminal, boots a second CLI in it, and leaves
the user's own session as a bystander that just fired a curl.

### Problem analysis

The user types `/switchboard` in a live agent session. That session is already an agent,
already in the workspace, already talking to the user. The entire point of the launcher
skill is: *this* becomes the orchestrator. What actually happens is a second terminal
appears, a second CLI boots inside it, and the pre-flight interview is delivered there —
so the user has to leave the terminal they were typing in and go talk to a different one.

### Root cause

Step 2 of the launcher (`.agents/workflows/switchboard.md:74-84`, mirrored to
`.claude/skills/switchboard/SKILL.md`) is a single curl:

```bash
curl -s -X POST "$BASE/orchestration/start" -H "Content-Type: application/json" -d '{}'
```

`POST /orchestration/start` (`src/services/LocalApiServer.ts:2601`) delegates to
`TaskViewerProvider.startOrchestratorFromKanban` (`src/services/TaskViewerProvider.ts:10401`),
which is **the AUTOMATION-tab button's implementation**. Its job is to *seat a terminal*:

- `src/services/TaskViewerProvider.ts:10411-10437` — look for a live terminal named
  `Orchestrator` (`ORCHESTRATOR_TERMINAL_NAME`, `src/services/autobanState.ts:29`).
- `:10440-10446` — none found → `vscode.window.createTerminal({ name: 'Orchestrator', ... })`.
- `:10488-10526` — boot the `lead` (falling back to `coder`) startup command in it.
- `:10581-10584` — `_dispatchExecuteMessage(root, 'Orchestrator', kickoffPrompt, ...)`.

So the launcher is calling the *seat-a-new-terminal* door. There is no door that says
"the caller **is** the orchestrator — hand me the kickoff prompt and register me as the
seat." Every path into the orchestrator role is name-addressed at the literal string
`Orchestrator`, so a session that adopts the role in place is invisible to the system:

- `notifyTurnEnd` (`src/services/TaskViewerProvider.ts:1389`) resolves its recipient by
  walking the pty parent chain and, failing that, by `role === 'orchestrator'`
  (`:1455-1459`). A self-adopted session matches neither, so live turn-end notices never
  reach it.
- A later click of AUTOMATION → Start orchestrator finds no terminal *named*
  `Orchestrator` and spawns the duplicate all over again.

The fix is therefore two inseparable halves: a door that adopts the calling session
(`POST /orchestration/adopt`, returning the identical kickoff prompt instead of injecting
it elsewhere), and a persisted record of that seat so the two name-addressed read sites
above resolve to it.

The arming half already works from any caller: `POST /orchestration/confirm`
(`src/services/LocalApiServer.ts:2634` → `confirmOrchestrationSession`,
`src/services/TaskViewerProvider.ts:10604`) only verifies `session.md` and flips the
autoban state. It seats nothing. Nothing about arming needs to change.

## Metadata

- **Complexity:** 6
- **Tags:** backend, api, cli, bugfix
- **Project:** Browser Switchboard

## User Review Required

Yes — before coding. The design adds a third orchestration door and a persisted
seat record consulted on two live read paths. Review the architecture review and
adversarial synthesis below (delivered in chat), and confirm:

1. The distinct-door approach (new `POST /orchestration/adopt`) is preferred over
   overloading `/orchestration/start` with an adopt mode (see Alternatives in chat).
2. The degraded unnamed-terminal case (`liveDelivery: false`, notices via the
   reports inbox) is an acceptable experience for a VS Code integrated terminal /
   user shell, or whether the launcher should refuse to adopt when it cannot name
   itself and fall back to the old seat-a-terminal behaviour.

## Complexity Audit (Routine vs Complex/Risky)

**Routine**

- Adding an HTTP route + handler to `LocalApiServer` alongside the four existing
  `/orchestration/*` routes (`start` / `confirm` / `handoff` / `stop`,
  `src/services/LocalApiServer.ts:4485-4492`) — the injected callback pattern
  (`orchestrationStart` / `orchestrationConfirm`, `src/services/LocalApiServer.ts:382`,
  `:398`) is copied line for line.
- Rewriting step 2 of `.agents/workflows/switchboard.md`.
- Adding a row to the endpoint table in `.agents/skills/switchboard-orchestration/SKILL.md`.

**Complex / risky**

- **Extracting the kickoff-prompt builder.** `startOrchestratorFromKanban` builds the
  three-way prompt (interview / resume / stale-session) inline at
  `src/services/TaskViewerProvider.ts:10540-10578`. Adopt must return *the same text* —
  duplicating the branch is how the two doors drift. This is a pure extraction: the
  existing call site must keep behaving identically.
- **A second `enabled`-adjacent field on `AutobanConfigState`.** The normaliser entry
  is required for **shape validation**, not drop-prevention.

  > **Superseded:** `normalizeAutobanConfigState` (`src/services/autobanState.ts:268-377`) is a **whitelist** — it rebuilds the object field by field and silently drops anything it does not name. A new field that is not added to the normaliser is written, persisted, and then erased on the next normalise pass.
  > **Reason:** Verified against the live code: the normaliser destructures `const { triggerType, runSheet, ...preservedUnknownKeys } = state` and returns `{ ...preservedUnknownKeys, enabled, ... }` — it **spreads and preserves** unknown keys, only overriding the explicitly-normalised fields. An `orchestratorSeat` key that is not named in the return object is therefore **preserved as-is**, not erased. The "silently dropped on every pass" failure mode does not exist.
  > **Replaced with:** The normaliser entry is still required, but for a different reason: without it, a malformed seat (e.g. `{ terminalName: 'x' }` with no `adoptedAt`, or a non-object) is **preserved unvalidated** and surfaces raw at the read sites. The entry coerces the shape (require `adoptedAt`, trim/optional `terminalName`, drop non-objects to `undefined`) so the two read sites never see a half-record. Shipped installs have no `orchestratorSeat` key; absent → the entry returns `undefined` → pre-change behaviour exactly (see Migration below).
- **Changing `notifyTurnEnd`'s recipient resolution.** This is the live delivery path for
  every completed/blocked seat. A wrong edit here silently stops orchestrator
  notifications. The change is additive and ordered: adopted seat first, existing parent
  walk and role scan untouched behind it.
- **The mirror is generated, not hand-edited.** `.claude/skills/switchboard/SKILL.md` and
  `.claude/.switchboard-generated.json` are produced by `ClaudeCodeMirrorService` from
  `.agents/workflows/switchboard.md` plus `MIRROR_MANIFEST`
  (`src/services/ClaudeCodeMirrorService.ts:51-54`). Editing the mirror directly is a
  change that vanishes on the next activation.

## Edge-Case & Dependency Audit

- **The caller cannot always name its terminal.** `SWITCHBOARD_TERMINAL` is injected into
  **pty children only** (`src/standalone/ptyFleetService.ts:243`) — a Switchboard-managed
  seat has it; a VS Code integrated terminal created by
  `vscode.window.createTerminal` does not, and neither does a shell the user opened
  themselves. `src/services/agentPromptBuilder.ts:1451-1455` states this explicitly.
  Adopt therefore takes `terminalName` as **optional** and behaves honestly in both cases:
  - name present → full adoption; live turn-end notices are delivered to that name.
  - name absent → the session still adopts the role and gets the kickoff prompt (the
    user's complaint is fixed either way), and the response says live notices will arrive
    in the reports inbox instead. That is not a degraded invention: the reports mirror at
    `src/services/TaskViewerProvider.ts:1414-1425` is unconditional and already exists for
    exactly this case ("a non-pty orchestrator reads the same notice as a file",
    `.agents/skills/switchboard-orchestration/SKILL.md:329`).
- **A named seat that is not actually live.** Adopt must not trust the name blindly.
  Verify against `ptyListTerminals` when a pty host is present; if the name is not in the
  active list, adopt anyway (the session is real) but return `liveDelivery: false` and the
  reason, rather than recording a seat nothing can reach.
- **AUTOMATION → Start orchestrator clicked after an adopt.** `startOrchestratorFromKanban`
  must consult the adopted seat before its name lookup, or it spawns the duplicate this
  plan exists to remove.
- **Adopting twice.** Idempotent — the second call overwrites the seat record and returns
  the current-mode prompt. No new guard, matching the existing double-enter tolerance
  documented on `confirmOrchestrationSession` (`src/services/TaskViewerProvider.ts:10613`).
- **The adopted terminal dies.** No liveness watchdog. `notifyTurnEnd` already pre-checks
  the recipient against the active pty list (`src/services/TaskViewerProvider.ts:1483-1487`)
  and logs a skip; a dead adopted seat takes that same path, and the reports inbox keeps
  the record. `POST /orchestration/stop` clears the seat.
- **Migration.** `autoban.state` is persisted to `workspaceState`
  (`src/services/TaskViewerProvider.ts:9741`) and ships in released versions. The new field
  is optional and additive: an install with no `orchestratorSeat` normalises to `undefined`,
  both read sites fall through to today's behaviour, and nothing else in the object is
  touched. No migration step, no key rename, no deletion.
- **`/orchestration/start` stays.** The AUTOMATION-tab button and any external caller that
  genuinely wants a *new* terminal still need it. This plan adds a door; it removes none.
  Only the `/switchboard` launcher stops using it.
- **The persona names the doors.** `.agents/skills/switchboard-orchestrator/SKILL.md:31-32`
  says "You arrive in the terminal by one of two doors" and `:42-48` says "The host has
  already chosen the prompt it injected". Under adopt the agent *is* the terminal and reads
  the prompt from an HTTP response — the paragraph is wrong for the third door unless
  updated. Because adopt returns the same three-way prompt the host would have injected,
  the mode-selection table at `:50-54` stays correct as written.
- **Catalog + allowlist are generated.** A new route means `protocol-catalog.json`
  (`apiEndpoints[]`, extracted from the route table) is stale until
  `npm run catalog:generate` runs. `catalog:check` fails CI otherwise.
- **Skill tool permissions.** The mirrored skill is emitted with `allowed-tools: Bash`
  (`src/services/ClaudeCodeMirrorService.ts:52`, emitted at `:418`). Step 2 now asks the
  agent to read the persona skill and write `session.md`, so `Bash` alone is not enough.
- **The existing contract test asserts the old behaviour.**
  `src/test/orchestrator-tick-and-reports-contract.test.js` (the "step 2 hands off to a
  pointer that ships" check, around `:255-265`) requires the launcher to contain
  `orchestration/start` and the phrase "does not arm". It will fail on the rewritten
  launcher and must be updated in the same change, not after.

## Dependencies

- None — this plan is self-contained. It touches the launcher workflow, the
  orchestrator persona skill, the orchestration HTTP-surface skill, the API server,
  the provider, the autoban state module, the mirror service, and one contract test,
  all of which are in-tree and edited in the same change. No sibling plan must land
  first.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the normaliser's unknown-key-preserve behaviour means
the seat is never silently dropped — but a missing normaliser entry would let a
malformed seat surface raw at the read sites, so the entry is mandatory for shape
coercion, not optional; (2) `notifyTurnEnd` is the live delivery path for every seat —
an ordering mistake in the additive seat check silently reroutes all orchestrator
notices; (3) the unnamed-terminal adopt path returns `liveDelivery: false` and the
start-button consult returns `success: true` without delivering a kickoff anywhere —
a mild hollow-success smell the coder should surface as a note rather than bare
success. Mitigations: the normaliser entry validates and drops half-records; the
turn-end edit is strictly additive and ordered after the parent walk; the start-button
unnamed path should carry an explanatory note. Stale line numbers throughout this plan
(verified against the current tree) must not be trusted — locate every target by
symbol/string anchor, not by line.

## Proposed Changes

> **Stale line numbers.** Every `:NNNN` citation in this plan was verified against the
> tree as of writing and is **off** — the source files have grown since the plan was
> first drafted (e.g. `_handleOrchestrationStart` is at `LocalApiServer.ts:3089`, not
> `:2601`; `startOrchestratorFromKanban` is at `TaskViewerProvider.ts:10340`, not
> `:10401`; `notifyTurnEnd` is at `:1529`, not `:1389`; the kickoff builder is at
> `:10479-10517`, not `:10540-10578`; the route table is at `:4485-4492`, not
> `:3933-3938`; the `## Pre-flight` "one of two doors" text is at
> `switchboard-orchestrator/SKILL.md:105-118`, not `:31-48`). **Locate each target by
> function name / string sentinel / route path, not by line number.** The structural
> claims (what the code does, in what order) have been re-verified and hold; only the
> line addresses drifted.

### 1. `src/services/autobanState.ts` — persist the adopted seat

Add the type and the field to `AutobanConfigState` (near `orchestrationConfig`, `:168`):

```ts
/**
 * The orchestrator seat when a session adopted the role in place (POST
 * /orchestration/adopt) rather than the host seating a terminal named
 * 'Orchestrator'. `terminalName` is the pty friendlyName when the caller could
 * name itself (SWITCHBOARD_TERMINAL) — omitted when it could not, in which case
 * the seat is real but has no live delivery channel and reads the reports inbox.
 * Absent (the shipped default) = no adopted seat = pre-adopt behaviour.
 */
export interface OrchestratorSeat {
    terminalName?: string;
    adoptedAt: string;
}
```

Then, in `normalizeAutobanConfigState` (`:311-356`) — the normaliser is a whitelist, so
without this line the field is dropped on every pass:

```ts
orchestratorSeat: (function (s: any) {
    if (!s || typeof s !== 'object') return undefined;
    const adoptedAt = typeof s.adoptedAt === 'string' ? s.adoptedAt : '';
    if (!adoptedAt) return undefined;
    const terminalName = typeof s.terminalName === 'string' && s.terminalName.trim()
        ? s.terminalName.trim() : undefined;
    return { terminalName, adoptedAt };
})((state as any)?.orchestratorSeat),
```

### 2. `src/services/TaskViewerProvider.ts` — extract the prompt, add adopt, consult the seat

**(a) Extract the kickoff builder.** Lift the three-way branch verbatim into a private
helper. `startOrchestratorFromKanban` then calls it; nothing about the text changes.

> **Clarification — the persona-not-installed catch path.** The current code wraps the
> branch in `try { await fs.promises.access(personaPath); … } catch { kickoffPrompt = '… workflow is not yet installed …' }`.
> That catch has **no mode label** today (the variable is just overwritten). The
> extracted helper returns `{ mode, prompt }`, so the catch needs a mode too — use
> `mode: 'interview'` (the fallback prompt is a stand-in for the interview path) or a
> dedicated `'no-persona'` mode that the adopt handler surfaces as `mode: 'no-persona'`
> in its response. Do **not** drop the catch: a workspace without the persona skill
> installed must still get the "stand by" prompt from both doors, not an unhandled
> rejection. The "verbatim" extraction therefore adds a mode return on the happy paths
> and a labelled mode on the catch path — the only non-verbatim part of the lift.

```ts
/**
 * The three-way orchestrator kickoff prompt (interview / resume /
 * stale-session), chosen by two facts: does .switchboard/orchestrator/session.md
 * exist, and is automation armed. Extracted so BOTH doors emit the same text —
 * the seat-a-terminal door injects it, the adopt door returns it over HTTP.
 * Duplicating this branch is how the two doors drift.
 */
private async _buildOrchestratorKickoffPrompt(
    root: string,
    initiatorProject?: string | null
): Promise<{ mode: 'interview' | 'resume' | 'stale-session'; prompt: string }> {
    // ... body moved verbatim from startOrchestratorFromKanban, returning the
    // branch label alongside the string it already built.
}
```

In `startOrchestratorFromKanban`, replace `:10540-10578` with:

```ts
const { prompt: kickoffPrompt } = await this._buildOrchestratorKickoffPrompt(root, initiatorProject);
```

**(b) Reuse an adopted seat instead of creating a terminal.** At the top of
`startOrchestratorFromKanban`, immediately after the `root` guard (`:10405-10409`):

```ts
// A session already adopted the role in place (POST /orchestration/adopt). The
// button must not spawn a second terminal alongside it — deliver to the adopted
// seat when it is reachable, and say so when it is not.
const adopted = this._autobanState.orchestratorSeat;
if (adopted?.terminalName) {
    const { prompt } = await this._buildOrchestratorKickoffPrompt(root, initiatorProject);
    const sent = await this._dispatchExecuteMessage(
        root, adopted.terminalName, prompt, { orchestrationKickoff: true }, 'sidebar'
    );
    this.postMessage({ type: 'orchestratorStartResult', success: sent,
        ...(sent ? {} : { error: `adopted seat '${adopted.terminalName}' did not accept the kickoff` }) });
    return;
}
if (adopted) {
    // Adopted without a name: the seat is real, we simply cannot address it.
    // Creating a terminal here would be the duplicate the adopt door removes.
    this._seams().ui.showInfoMessage('An agent session already holds the orchestrator seat. Talk to it there, or stop orchestration first.');
    // NOTE: success: true here is a mild hollow-success smell — the kickoff is
    // NOT delivered anywhere by this click (the adopted session already has its
    // prompt from the adopt call). Carry an explanatory note so the AUTOMATION
    // tab does not read as "kickoff sent" when nothing was sent.
    this.postMessage({ type: 'orchestratorStartResult', success: true, note: 'Adopted seat has no terminal name — kickoff was not re-delivered. The adopted session already holds the prompt.' });
    return;
}
```

**(c) The adopt entry point.**

```ts
/**
 * The caller IS the orchestrator. Records the seat and returns the same kickoff
 * prompt startOrchestratorFromKanban would have injected into a terminal it
 * created. Seats nothing, boots nothing, arms nothing — arming stays
 * POST /orchestration/confirm.
 */
public async adoptOrchestratorSeat(
    workspaceRoot?: string,
    terminalName?: string,
    initiatorProject?: string | null
): Promise<{ success: boolean; mode?: string; prompt?: string; seat?: OrchestratorSeat; liveDelivery?: boolean; note?: string; error?: string }> {
    const root = this._resolveWorkspaceRoot(workspaceRoot);
    if (!root) { return { success: false, error: 'No workspace folder found.' }; }

    const requested = (terminalName || '').trim();
    let resolvedName: string | undefined;
    let note: string | undefined;
    if (requested) {
        // Do not trust the name blindly — a seat nothing can reach is worse than
        // an unnamed one, because the turn-end path would address it and drop.
        let live = false;
        if (this._ptyHostPort) {
            try {
                const res = await this._ptyHostVerb('ptyListTerminals', {});
                live = Array.isArray(res?.terminals) && res.terminals
                    .some((t: any) => t.status === 'active' && t.friendlyName === requested);
            } catch { /* treat as not live */ }
        }
        if (live) { resolvedName = requested; }
        else { note = `'${requested}' is not an active fleet terminal — turn-end notices will land in .switchboard/orchestrator/reports/ instead of this terminal.`; }
    } else {
        note = 'No terminal name supplied (SWITCHBOARD_TERMINAL is set for fleet seats only) — turn-end notices will land in .switchboard/orchestrator/reports/ instead of this terminal.';
    }

    const seat: OrchestratorSeat = { terminalName: resolvedName, adoptedAt: new Date().toISOString() };
    this._autobanState = normalizeAutobanConfigState({ ...this._autobanState, orchestratorSeat: seat });
    await this._persistAutobanState();
    this._postAutobanStateNow();

    const { mode, prompt } = await this._buildOrchestratorKickoffPrompt(root, initiatorProject);
    return { success: true, mode, prompt, seat, liveDelivery: !!resolvedName, ...(note ? { note } : {}) };
}
```

**(d) Clear the seat on stop.** In `stopOrchestratorFromKanban`, alongside the existing
disarm, drop the record — a stopped session does not hold the seat:

```ts
this._autobanState = normalizeAutobanConfigState({ ...this._autobanState, orchestratorSeat: undefined });
```

**(e) Route turn-end to the adopted seat.** In `notifyTurnEnd`, inside the
`else` branch that resolves a recipient (`:1447-1460`), consult the seat **before** the
existing parent walk's role fallback — additive, both existing steps untouched:

```ts
// An adopted seat is the orchestrator even though no terminal is named
// 'Orchestrator' and no fleet row carries role 'orchestrator'. Checked after the
// parent walk (a seat's own head still wins) and before the role scan.
if (!recipientName) {
    const adoptedName = this._autobanState.orchestratorSeat?.terminalName;
    if (adoptedName) { recipientName = adoptedName; }
}
if (!recipientName) {
    const orch = active.find((t: any) => this._normalizeAgentKey(t.role || '') === 'orchestrator');
    if (orch) { recipientName = orch.friendlyName; }
}
```

**(f) Wire the callback.** Beside `orchestrationStart` (`:3553`):

```ts
orchestrationAdopt: async (wsRoot, terminalName) => {
    return await this.adoptOrchestratorSeat(wsRoot, terminalName, undefined);
},
```

### 3. `src/services/LocalApiServer.ts` — the adopt door

Options field, beside `orchestrationStart` (`:318`):

```ts
/**
 * Adopt the CALLING session as the orchestrator: record the seat and return the
 * kickoff prompt instead of injecting it into a terminal the host created.
 * Reached by `POST /orchestration/adopt` from the /switchboard launcher.
 * Optional — absent in headless/test harnesses (returns 503).
 */
orchestrationAdopt?: (workspaceRoot?: string, terminalName?: string) => Promise<any>;
```

Handler, mirroring `_handleOrchestrationStart` (`:2601`) line for line — auth check, 503
when unwired, `_parseJsonBody`, 200 + result, 500 on throw:

```ts
/**
 * POST /orchestration/adopt — the caller IS the orchestrator. Body:
 * { workspaceRoot?, terminalName? }. Returns { mode, prompt, seat, liveDelivery }.
 * Seats no terminal and does NOT arm — arming stays POST /orchestration/confirm.
 */
private async _handleOrchestrationAdopt(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> { /* ... */ }
```

Route, beside the other three (`:3933`):

```ts
} else if (pathname === '/orchestration/adopt' && req.method === 'POST') {
    await this._handleOrchestrationAdopt(req, res);
```

### 4. `.agents/workflows/switchboard.md` — step 2 stops seating a terminal

Replace the whole of "## Step 2 — start the orchestration agent" (`:66-84`). Step 1 is
unchanged. New body:

```markdown
## Step 2 — become the orchestrator

**You are the orchestrator. Not a terminal you start — this one.** Adopt the seat and
run the pre-flight here, in this conversation.

```bash
PORT=$(cat "$ROOT/.switchboard/api-server-port.txt")
BASE="http://127.0.0.1:$PORT"

# SWITCHBOARD_TERMINAL is set for Switchboard-managed fleet seats. Unset elsewhere —
# send it empty rather than guessing a name.
curl -s -X POST "$BASE/orchestration/adopt" -H "Content-Type: application/json" \
  -d "{\"terminalName\": \"${SWITCHBOARD_TERMINAL:-}\"}"
```

The response carries `prompt` — the pre-flight instruction. **Follow it in this
session**: read `.agents/skills/switchboard-orchestrator/SKILL.md`, run the pre-flight,
report what you find, propose a goal, and wait for the user to answer *here*.

`POST /orchestration/adopt` **does not arm** and seats no terminal. On the user's
confirmation, write `.switchboard/orchestrator/session.md` and call
`POST /orchestration/confirm` — that is the only call that arms.

If the response carries a `note`, relay it in one line: it means live turn-end notices
will arrive in `.switchboard/orchestrator/reports/` rather than as prompts in this
terminal. Read that directory on each pass.

Never call `POST /orchestration/start` from here — that door creates a *separate*
Orchestrator terminal, which is the opposite of what `/switchboard` is for.
```

### 5. `src/services/ClaudeCodeMirrorService.ts` — widen the mirrored skill's tools

Step 2 now reads the persona skill and writes `session.md`; `Bash` alone cannot.
At `:51-54`:

```ts
{
    source: 'workflows/switchboard.md', name: 'switchboard', invocation: 'default',
    allowedTools: 'Bash, Read, Write, Glob, Grep',
    descriptionFallback: 'Local Switchboard management console — drive the board when the VS Code extension is running'
},
```

### 6. `.agents/skills/switchboard-orchestrator/SKILL.md` — name the third door

Rewrite the opening of `## Pre-flight` (`:31-38`). Replace "one of two doors" with three,
and state that under adoption the prompt arrives as an HTTP response body rather than an
injection. The mode table at `:50-54` is unchanged — adopt returns the same three-way
prompt the host would have injected, so "follow the mode the prompt indicates" still holds.

### 7. `.agents/skills/switchboard-orchestration/SKILL.md` — document the endpoint

Add a row above the `/orchestration/start` row (`:131`):

| `POST /orchestration/adopt` | `{ workspaceRoot?, terminalName? }` | **The caller IS the orchestrator.** Records the seat and returns `{ mode, prompt, seat, liveDelivery, note? }` — the same pre-flight prompt `/orchestration/start` would have injected into a terminal it created, handed back so you run it in your own session. Seats no terminal. **Does not arm** — arming is `POST /orchestration/confirm`. Pass `terminalName` from `$SWITCHBOARD_TERMINAL` when set; omitted or unmatched → `liveDelivery: false` and turn-end notices arrive in the reports inbox instead |

### 8. `src/test/orchestrator-tick-and-reports-contract.test.js` — update the launcher contract

Replace the step-2 check (the "step 2 hands off to a pointer that ships" check,
around `:255-265`). It currently *requires* the bug:

```js
await check('step 2 adopts this session — it does not seat a second terminal', () => {
    assert.ok(/orchestration\/adopt/.test(launcher), 'step 2 does not call POST /orchestration/adopt');
    assert.ok(
        !/orchestration\/start/.test(launcher.replace(/Never call[\s\S]{0,200}/g, '')),
        'step 2 still calls POST /orchestration/start — that door creates a separate Orchestrator terminal'
    );
    assert.ok(
        /does not arm|Does not arm/.test(launcher),
        'the launcher must say adopt does not arm — otherwise it reads as a one-click arm'
    );
    assert.ok(
        !/orchestration-starts-as-a-conversation\.md/.test(launcher),
        'the launcher points at a .switchboard/plans/ file — gitignored, not distributed'
    );
});
```

Add one check to section 8 ("both doors land on the same seat-and-interview method")
asserting `LocalApiServer.ts` routes `/orchestration/adopt`, and one asserting
`TaskViewerProvider.ts` contains `_buildOrchestratorKickoffPrompt` with **exactly one**
occurrence of the interview sentinel string (`no session file exists`) — the extraction's
whole purpose is that the branch is not duplicated.

### 9. Generated artifacts — regenerate, do not hand-edit

- `npm run catalog:generate` → refreshes `protocol-catalog.json` (`apiEndpoints[]`) and
  `src/generated/verbAllowlist.ts`. Commit both.
- `.claude/skills/switchboard/SKILL.md`, `.claude/.switchboard-generated.json` and
  `.agents/.switchboard-bundled.json` are written by `ClaudeCodeMirrorService` on
  activation from `.agents/workflows/switchboard.md` + `MIRROR_MANIFEST`. Reload the
  window once so the mirror rewrites them, then commit the result. Editing them by hand
  produces a change that vanishes on the next activation.

## Verification Plan

1. **Contract tests.**
   - `npm run test:contract:orchestrator-tick` — the rewritten launcher check passes, and
     every other check in the file (reports channel, seat-routing lines, section 8) stays
     green.
   - `npm run test:contract:autoban-state` — confirms the `orchestratorSeat` addition did
     not disturb the existing `startOrchestratorFromKanban` assertions at
     `src/test/autoban-state-regression.test.js:502-517` (still no `orchestrationConfig.enabled`
     write, still does not arm, still does not tear down the run-sheet engine).
   - `npm run catalog:check` — passes only after `catalog:generate` has been run and
     committed.
   - `npm run lint`.
2. **Normaliser round-trip.** In a node REPL against `src/services/autobanState.ts`:
   `normalizeAutobanConfigState({ orchestratorSeat: { terminalName: 'Claude 1', adoptedAt: '2026-08-17T00:00:00Z' } })`
   returns the seat intact; `normalizeAutobanConfigState({})` returns
   `orchestratorSeat: undefined`; a malformed seat (`{ terminalName: 'x' }`, no
   `adoptedAt`) normalises to `undefined` rather than a half-record.
3. **Extraction is behaviour-preserving.** With no `session.md` present, click AUTOMATION →
   Start orchestrator. A terminal named `Orchestrator` is created and receives the
   *interview* prompt, byte-identical to today's (`no session file exists ... STOP`).
   Repeat with `session.md` present and automation armed → the *resume* prompt. Repeat
   with `session.md` present and disarmed → the *stale-session* prompt.
4. **The actual bug — the named case.** From a Switchboard-managed fleet terminal
   (`echo $SWITCHBOARD_TERMINAL` prints a name), type `/switchboard`.
   - **No new terminal appears.** The terminal count before and after is identical.
   - The pre-flight report and the goal proposal are printed **in that terminal**, and it
     waits for an answer there.
   - `curl -s localhost:$PORT/orchestration/adopt -d '{"terminalName":"<name>"}'` returned
     `liveDelivery: true` and no `note`.
5. **The unnamed case.** Repeat from a terminal where `SWITCHBOARD_TERMINAL` is unset.
   Still no new terminal; the agent relays the one-line `note` about the reports inbox.
6. **Turn-end reaches the adopted seat.** With the seat adopted (named case) and a coder
   dispatched to a subtask, let the coder finish. The `[switchboard:turn-end]` notice
   arrives as a prompt **in the adopted terminal**, and a mirrored report file appears in
   `.switchboard/orchestrator/reports/`. In the unnamed case, only the report file appears
   — check the extension host log for the honest `turn-end: recipient ... skipping` line
   rather than a silent drop.
7. **No duplicate seat.** With the seat adopted, click AUTOMATION → Start orchestrator.
   No second terminal is created; the kickoff is delivered to the adopted terminal (named
   case) or the info message is shown (unnamed case).
8. **Arming still works end to end.** Answer the pre-flight in the adopted terminal,
   confirm the goal, let the agent write `.switchboard/orchestrator/session.md` and call
   `POST /orchestration/confirm`. The AUTOMATION tab flips to armed / `agent-managed`.
   `POST /orchestration/stop` disarms **and** clears `orchestratorSeat` — verified by
   clicking Start orchestrator afterwards and seeing a fresh `Orchestrator` terminal
   created (the pre-change path, restored).
9. **Migration safety.** Load a workspace whose persisted `autoban.state` predates this
   change (no `orchestratorSeat` key). The board renders, automation state is unchanged,
   turn-end routing behaves exactly as before, and Start orchestrator creates a terminal
   as it always has.
10. **Mirror fidelity.** After a window reload, `.claude/skills/switchboard/SKILL.md`
    contains the new step 2 and its frontmatter reads
    `allowed-tools: Bash, Read, Write, Glob, Grep`. `/switchboard` in a fresh Claude Code
    session can read the persona skill and write `session.md` without a tool-permission
    refusal.

---

**Recommendation:** Complexity 6 → **Send to Coder.** The change is majority-routine
(route, handler, workflow rewrite, skill-doc rows, mirror tools) with two
well-scoped moderate risks (the `notifyTurnEnd` additive edit on a live delivery path,
and the prompt-builder extraction that must stay behaviour-identical including the
persona-not-installed catch). Not intern-trivial, not lead-grade architectural.

## Completion Report

Implemented `/switchboard` terminal adoption mechanism (`POST /orchestration/adopt`) so the session running the launcher adopts the orchestrator seat in place instead of spawning a duplicate terminal. Added `OrchestratorSeat` type and shape normalisation in `src/services/autobanState.ts`, extracted `_buildOrchestratorKickoffPrompt`, implemented `adoptOrchestratorSeat`, updated `startOrchestratorFromKanban` / `stopOrchestratorFromKanban`, and routed `notifyTurnEnd` in `src/services/TaskViewerProvider.ts`. Exposed `POST /orchestration/adopt` route and handler in `src/services/LocalApiServer.ts`, updated `.agents/workflows/switchboard.md`, widened mirrored tools in `src/services/ClaudeCodeMirrorService.ts` / `.claude/skills/switchboard/SKILL.md`, updated skill documentation, and aligned the contract test in `src/test/orchestrator-tick-and-reports-contract.test.js`. Regenerated `protocol-catalog.json` and `src/generated/verbAllowlist.ts` with no issues encountered.
