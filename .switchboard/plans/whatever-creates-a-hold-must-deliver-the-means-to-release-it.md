# Whatever Creates a Hold Must Deliver the Means to Release It

## Goal

A card stamped as held by a seat must always arrive with the instruction that
releases it. Today the stamp and the instruction are attached by two different
code paths, and one of them fires without the other.

### Problem analysis

**The completion directive rides the `dispatch` payload. A copy-prompt paste has
no `dispatch` payload.**

`bootstrap.ts:537`:

```ts
if (dispatch && typeof dispatch === 'object') {
    out = ensureDispatchProtocolDirectives(out, missionControlActive);
}
```

`ensureDispatchProtocolDirectives` is what appends
`CODING_COMPLETION_REPORT_DIRECTIVE` — the text that tells a seat to run
`submit` when it finishes. No `dispatch` object, no directive.

**But the paste stamps the hold anyway.** `attributePasteDispatch`
(`KanbanDatabase.ts:15120`) writes `owner_seat`, `owner_since` and
`completed_at = NULL` for the pasted-to seat. So a copy-prompt creates a hold and
delivers no way to clear it. The seat does the work, stops, and the card is held
for as long as the board lives.

Nothing is wrong with either half on its own. The defect is that they are
independent: one path opens the obligation, a different path closes it, and only
the second one checks whether it applies.

**Measured on the live board, 2026-09-21.** Of the 12 holds on seats that exist,
**11 have zero `dispatched` events** — they were pasted, not dispatched. Four are
plan files written by an agent and never assigned to anyone, stamped to
`Planning-planner-2` because the operator copy-prompted them in.

Held cards per seat, by role:

| role | held / seat | gets a `dispatch` payload |
|---|---|---|
| reviewer | 36.5 | rarely — pasted |
| planner | 23.2 | rarely — pasted |
| analyst | 5.5 | rarely — pasted |
| coder | 3.3 | yes — queue and rounds |

Coders are the only role that routinely arrives through a dispatch, and the only
role that is not accumulating. The correlation is the mechanism.

**This is not a role problem.** A coder pasted a prompt by hand gets no directive
either. Roles only correlate because of how each is usually given work.

**What this is NOT.** `submit` works: it was implemented today (`ddeb9c79`) and
resolves its seat from `SWITCHBOARD_TERMINAL` through both the Node CLI and the
Go client. An earlier reading that the directive named a non-existent verb was
measured against a stale build and is wrong. The verb is fine; it is never
delivered to the seats in question.

### Deeper mechanism — there are three stamp paths, not two

Improve pass (2026-09-21) mapped every writer that lands on `attributePasteDispatch`
/ the `attributePastedPrompt` verb:

1. **Strict `dispatch`-payload send.** `ptySendPrompt` with a `dispatch` field:
   validates, calls `attributePastedPrompt` (stamps), appends
   `ensureDispatchProtocolDirectives` to the text in-band
   (`TaskViewerProvider.ts:830-891`; `bootstrap.ts:2960-2999` + the `deliverPrompt`
   gate at ~`:544`). Stamp and directive paired — works.
2. **Host send with markered text but no `dispatch` field.** `deliverPrompt` /
   `_ptyHostVerb` runs `extractDispatchIdentity` on the body (`bootstrap.ts:717`,
   `TaskViewerProvider.ts:818`) and stamps via a post-send fire-and-forget
   `attributePastedPrompt` backstop (`bootstrap.ts:795-804`,
   `TaskViewerProvider.ts:1497-1506`) — but the directive gate still keys on
   `payload.dispatch`, which is absent. **Stamps, no directive.** This is the
   hole the original analysis named.
3. **Client-side paste / shift-drop — NO HOST SEND AT ALL.** A clipboard paste
   (or `term.paste()`) reaches the seat as raw keystrokes over the terminal
   websocket; `term.onData`'s arm/commit scanner (`terminalViewport.js:2035-2076`)
   POSTs `/kanban/verb/attributePastedPrompt` AFTER the bytes are delivered, and
   the verb stamps. Shift-drop writes over the raw ws directly and POSTs the same
   verb (`terminals.js:7531-7549`). Normal drop goes through
   `/terminals/verb/ptySendPrompt` (path 2). **On path 3 there is no prompt
   composition in the host — nothing exists to "re-gate".** The directive can
   only arrive as a follow-up delivery triggered by the stamp itself.

Path 3 is the dominant leak: the 11 measured holds are pastes, and a paste is
path 3. A fix scoped to path 2 alone would pass a `ptySendPrompt`-driven test
while every real operator paste kept leaking — the plan's own stated defect,
reproduced at verification time.

**Adjacent gap the fix should close for free.** The completion directive also
ships as a role-scoped standing order (`COMPLETION_DIRECTIVE_ORDER_INSTRUCTION`,
installed for `COMPLETION_DIRECTIVE_ROLES = ['coder','intern','lead','reviewer']`
— `standingOrders.ts:725,760`; installed on seat create at `bootstrap.ts:2622`
and `TaskViewerProvider.ts:4271`). Planner and analyst are not in the role list —
matching the measured accumulation. But standing orders are appended inside
`deliverPrompt`, so a path-3 paste bypasses them entirely: even a coder seat gets
no orders block on a paste. The follow-up delivery in Proposed Change 2 rides the
normal send pipeline with orders on, which delivers the orders block the paste
never got.

**The verb is the convergence point.** Every stamp — strict branch, backstop,
webview scanner, drop — flows through `attributePastedPrompt`. Its HTTP door is
`LocalApiServer._handleKanbanVerb` (`:9761`), which already runs per-verb
post-processing (the `triggerAction` outcome annotation at `:9821-9837`) and owns
`this._options.terminalVerb('ptySendPrompt', …)` (the queue/done relay at
`:8305`). That makes the door the one seam where "a hold was just stamped by an
uninstrumented delivery" is knowable and a release instruction can be sent.

### Related work — the operator's manual release valve (8b8c5366)

A sibling commit (`8b8c5366`, "the release-held-cards button has a route")
reinstated `POST /kanban/team/release`, which V81 had deleted alongside
`releaseCardInternal`, `released_at` and `/kanban/card/release`. The reversal is
deliberate and narrower than what V81 removed: the terminals panel's
"release held cards" button has POSTed that route since the panel was written,
so the button 404'd and looked inert; the reinstated arm is a hold-only operator
valve (`clearOwnerStamp` — no `completed_at`, no `released_at`, no column move)
scoped to the poster's own team via `resolveTeamMembers`. It is the manual
escape for exactly the leak this plan fixes at the source; it is NOT this plan's
mechanism — the directive delivery above prevents the stuck hold, the valve
clears one an operator already spotted. Three contract gates that pinned the
V81 deletion (`self-completion-clear`, `team-release-control`,
`atomic-team-lifecycle`) were updated in the same pass to record the new
decision: `releaseCardInternal`, `/kanban/card/release` and `released_at` stay
absent; `team/release` is asserted present with its narrowed semantics.

## Constraints

**Tie the directive to the STAMP, not to the payload shape.** The rule is: if this
send stamps a hold, it carries the completion directive. Gating on
`dispatch && typeof dispatch === 'object'` is gating on how the caller happened to
build the payload, which is why a paste slips through. A second gate on a second
payload field would reproduce this the next time a third send path appears.

**A pasted card is a full team card. Nothing is turned off for it.** This plan ADDS
the completion directive to the paste path; it removes nothing from it. Pasted work
keeps its hold, its activity light, its standing orders, its team membership and
its nudges — the operator pasting a prompt is dispatching work by hand, not opting
out of the team.

> **Superseded:** "…keeps its hold, its activity light, its standing orders, its
> team membership and its nudges — … The only thing the paste path is missing
> today is the instruction that lets the seat close the card, and that is what
> this adds."
> **Reason:** Factually wrong for path 3. A clipboard paste never enters
> `deliverPrompt`, so the seat receives NO standing-orders block and NO seat
> directive block either — the pasted prompt is exactly the clean text the copy
> verb composed (deliberately clean: `standingOrders.ts:717`). The normative
> intent (nothing is turned off for a pasted card) stands; the claim that orders
> already arrive does not.
> **Replaced with:** The paste path is missing the directive AND the delivery-time
> blocks. The follow-up send (Proposed Change 2) runs the normal delivery
> pipeline — orders on, seat block on — so it delivers all three, once.

**Completion never moves a card.** Cards move on start — the column move IS the
dispatch. A completion writes `completed_at` and releases the hold, and that is
all it does. No path added here may advance a column.

**Do not attach the directive to sends that stamp nothing.** A relay, a nudge, a
status check and an orientation must not tell a seat to post completion — there is
no card to complete, and a spurious `submit` releases whatever the seat last held.
This is the symmetric error and it is worse than the current one. Note this is
about sends that stamp NOTHING, not about the paste path, which stamps and
therefore must carry the directive.

**Both halves must agree on the SAME card.** The directive releases "the card your
seat holds", resolved server-side from `owner_seat`. If a paste stamps card A and
the directive is composed for card B, the seat releases the wrong one. Stamp and
directive must be derived from one resolution, not two.

**The existing sentinel guard stays.** `ensureCompletionDirective` is idempotent on
`COMPLETION REPORT:`; a send that already carries one must not get a second.

### Settled — no move on completion

An earlier draft asked whether a planner's completion should advance the card's
column. It should not, and the question should never have been asked: **cards move
on start, never on finish.** The column move IS the dispatch — it is what fires the
prompt — and there is no move-on-completion step anywhere in the product. That is a
shipped contract (`bundledProtocols.ts`, "Switchboard Contracts", item 1), not an
open design choice. A completion releases the hold and writes `completed_at`. It
moves nothing.

## Metadata

**Tags:** bugfix, backend, reliability
**Complexity:** 6

> **Superseded:** `**Tags:** dispatch, prompts, board, standalone` and
> `**Scope:** … **Standalone only.**`
> **Reason:** (a) Tags must come from the allowed vocabulary; none of the four
> were in it. (b) "Standalone only" contradicts the plan's own Proposed Change 2
> ("both composition roots") and the repo's no-divergence rule — the send-path
> seam exists in both `bootstrap.ts` and `TaskViewerProvider.ts`, so both are
> touched. The path-3 fix lives in shared code (`LocalApiServer`, webview) and
> covers both roots by construction.
> **Replaced with:** The tags above and scope spanning `bootstrap.ts`,
> `TaskViewerProvider.ts`, `LocalApiServer.ts`, `verbSchemas.ts`, and
> `src/webview/{terminalViewport.js,terminals.js}`.

## User Review Required

The approach changed in review: the fix is now two mechanisms, not one — an
in-band re-gate for host sends AND a server-initiated follow-up send at the
`attributePastedPrompt` HTTP door for client-side deliveries. Reviewers should
confirm the symmetric-error constraint still holds: the follow-up fires only on
an explicit caller flag plus `attributed >= 1`, never on payload shape alone.

## Complexity Audit

### Routine
- Hoisting `extractDispatchIdentity(text)` above the directive gate in
  `bootstrap.ts:deliverPrompt` and OR-ing it into the gate condition.
- Mirroring the same predicate in `TaskViewerProvider._ptyHostVerb`'s
  `!hasDispatch` branch (the parse already runs at `:818`; the append is a
  one-liner beside it, mirroring `:887`).
- Adding one optional boolean field to the `attributePastedPrompt` schema
  (`verbSchemas.ts:343`).
- Passing a flag through two existing webview POST bodies.

### Complex / Risky
- The follow-up `ptySendPrompt` is a NEW server-initiated send fired from the
  verb door: it must carry `clearBeforePrompt: false` and `kind: 'message'` or
  it will wipe the seat's screen mid-work / acquire dispatch semantics it must
  not have.
- Ordering: the follow-up must land after the pasted bytes. The scanner POST
  fires only at commit (the Enter chunk), so the prompt is already submitted —
  but a slow in-flight multi-chunk paste is a residual interleave risk.
- Double-delivery disambiguation for the normal-drop branch (in-band directive
  vs. follow-up) needs the webview to pre-check `extractPastedDispatchIdentity`
  on the composed prompt.
- Both composition roots are touched (no-divergence rule) plus shared services
  and two webview files.

## Edge-Case & Dependency Audit

### Race Conditions
- **Follow-up vs. in-flight paste.** The scanner POSTs at commit (Enter seen);
  the paste body is already at the seat, so the follow-up lands as queued input.
  A pathological multi-chunk paste could interleave — bounded, and the directive
  text is self-contained so mid-stream arrival still reads coherently.
- **Follow-up send vs. dead seat.** If the terminal died between paste and POST,
  `ptySendPrompt` returns `{success:false}` — log it loudly (the hold then leaks
  exactly as today, but visibly).
- **No re-stamp recursion.** The follow-up's own text contains no
  `PLANS TO PROCESS:` marker, so `extractDispatchIdentity` returns null on it and
  the parse-backstop stays inert. Assert this in a test — a regression here is a
  self-stamping loop.

### Security
- `deliverReleaseInstruction` is a new client-supplied field on an authenticated
  loopback verb — worst case an attacker triggers a prompt send to a named seat,
  a capability they already have via `/terminals/verb/ptySendPrompt`. No new
  surface.
- The directive text is a fixed server-side constant — no client-supplied prose
  is sent to the seat.

### Side Effects
- The follow-up send runs the full `deliverPrompt` pipeline with orders on —
  deliberate: it delivers the standing-orders block the paste bypassed (see
  "Adjacent gap"). Seat-block append is memoised per `agentInstanceId`.
- `attributed > 0` also implies `clearCompletedAt` already ran in the verb —
  unchanged.
- A batch paste stamps N holds; one `submit` clears exactly ONE held row
  (`LocalApiServer.ts:8163-8170` documents the one-POST-per-turn contract).
  Sibling holds are existing batch semantics — unchanged by this plan, noted so
  the verifier doesn't mistake them for a regression.

### Dependencies & Conflicts
- `ensureDispatchProtocolDirectives`, `extractDispatchIdentity`,
  `attributePastedPrompt`, `terminalVerb('ptySendPrompt')` — all shipped and
  wired in both roots.
- The `attributePastedPrompt` verb arm (`KanbanProvider.ts:14077`) is untouched —
  the follow-up lives door-side in `LocalApiServer._handleKanbanVerb`, beside
  the existing `triggerAction` post-processing precedent.
- `directivesAttached` already exists in the `ptySendPrompt` result shape —
  reuse it on the in-band path for observability parity.
- **Check at implementation time:** whether any surface still delivers
  `attributePastedPrompt` via in-process `postMessage` (legacy extension webview
  rather than HTTP `fetch`). If so, that caller bypasses `_handleKanbanVerb` and
  needs the same follow-up arm at its entry point. The browser-served panels all
  POST over HTTP, so the door covers them in both roots.

## Dependencies

None — self-contained. All machinery (`attributePastedPrompt`, the scanner,
`terminalVerb`, `ensureDispatchProtocolDirectives`) is already shipped.

## Adversarial Synthesis

Key risks: (1) the follow-up send must be non-destructive (`clearBeforePrompt:
false`, `kind:'message'`) or it damages the seat it is meant to equip; (2)
keying the follow-up on the door alone would double-deliver on the normal-drop
branch, so the webview flag must discriminate with
`extractPastedDispatchIdentity`; (3) a host send that stamps via the parse
backstop but skips the directive re-creates the bug — the predicate must be a
single shared boolean. Mitigations: explicit opt-in field plus `attributed >= 1`
gate; sentinel idempotence already prevents double-append within one text; the
directive's own text provably does not re-arm the parser.

## Proposed Changes

> **Superseded:** "1. Make the directive gate ask 'does this send stamp a hold?'
> rather than 'did the caller pass a `dispatch` object' — one predicate, used by
> both the stamping call and the directive call. 2. Apply it at both composition
> roots' send paths, so a paste and a dispatch are treated alike. 3. Keep the
> stamp/directive pairing total…"
> **Reason:** Correct predicate, wrong reach. The dominant stamp path (client
> paste / shift-drop) has no host send — there is no gate to fix on it. A
> send-path-only fix passes its own tests while the measured leak continues.
> **Replaced with:** Two mechanisms — the same single-predicate re-gate for host
> sends (Change 1), plus a follow-up delivery at the stamp's HTTP door for
> deliveries no send ever carried (Change 2). Change 3 (pairing stays total) is
> retained as Change 3 below.

### 1. In-band directive on the stamp predicate — host sends

**`src/standalone/bootstrap.ts` — `deliverPrompt` (~`:502-806`).**
Hoist `extractDispatchIdentity(text)` (currently `~:717`, after composition)
above the directive gate at `~:544`, and compute one boolean:

```ts
const willStampHold = !!(dispatch && typeof dispatch === 'object')
    || parsedDispatchIdentity !== null;
if (willStampHold) {
    const missionControlActive = taskViewerProvider?.isOversightAgentRunning() ?? true;
    out = ensureDispatchProtocolDirectives(out, missionControlActive);
}
```

Reuse the same `parsedDispatchIdentity` for the existing post-send registration
(`:795`) so stamp and directive cannot disagree — one parse, one predicate, two
consumers.

**`src/services/TaskViewerProvider.ts` — `ptySendPrompt` verb arm.**
In the `!hasDispatch` branch where `parsedDispatchIdentity` is already computed
(`:817-829`), append the bundle to `payload.data` and set `directivesAttached`,
mirroring the `hasDispatch` arm at `:886-890`:

```ts
const missionControlActive = this.isOversightAgentRunning();
payload = { ...payload, data: ensureDispatchProtocolDirectives(payload.data, missionControlActive) };
directivesAttached = missionControlActive
    ? ['COMPLETION REPORT', 'MISSION CONTROL REPORT']
    : ['COMPLETION REPORT'];
```

### 2. Release instruction at the attribution door — client-side deliveries

**`src/services/verbSchemas.ts:343`** — add `deliverReleaseInstruction:
{ type: 'boolean' }` (optional) to `attributePastedPrompt`.

**`src/services/LocalApiServer.ts` — `_handleKanbanVerb` (`:9761`).**
After `kanbanVerb(verb, body, workspaceRoot, source)` returns (`:9820`), beside
the existing `triggerAction` annotation arm, add:

```ts
if (verb === 'attributePastedPrompt'
    && body.deliverReleaseInstruction === true
    && result && result.attributed >= 1
    && typeof body.terminalName === 'string' && body.terminalName) {
    try {
        const missionControlActive = /* same oversight check the send paths use;
            resolve via existing option or the deliverPrompt default (true) */;
        const text = ensureDispatchProtocolDirectives('', missionControlActive).trim();
        const sendRes = await this._options.terminalVerb?.('ptySendPrompt', {
            name: body.terminalName,
            data: text,
            kind: 'message',
            clearBeforePrompt: false,
        });
        if (!sendRes || sendRes.success === false) {
            console.warn(`[LocalApiServer] release-instruction send failed for '${body.terminalName}':`, sendRes?.error);
        }
    } catch (e) {
        console.warn('[LocalApiServer] release-instruction send threw:', e);
    }
}
```

- `deliverReleaseInstruction === true` AND `attributed >= 1` — the pair means
  "a real stamp just happened through an uninstrumented delivery". No stamp, no
  send (the symmetric constraint enforced structurally).
- `clearBeforePrompt: false` is mandatory — default delivery clears the seat's
  screen.
- The send flows through `deliverPrompt` with defaults: orders ON (delivers the
  block the paste bypassed), seat block ON (memoised), and its own text parses
  no identity — no recursion.
- In-process callers (the strict `dispatch` branch, the parse backstop) call
  `handleServiceVerb` directly and never pass the flag — they keep their in-band
  directive and get no follow-up.

**`src/webview/terminalViewport.js` — the commit POST (`:2052`).**
Add `deliverReleaseInstruction: true` to the body.

**`src/webview/terminals.js` — `attributeDropDispatch` (`:7433`).**
Thread the flag through with per-branch values:

- Shift-drop branch (`:7531-7549`, raw `ws.send` — bytes never touched the host):
  `deliverReleaseInstruction: true`.
- Normal-drop branch (`:7575-7610`, server-side `ptySendPrompt`): set the flag to
  `!extractPastedDispatchIdentity(promptText)` — the webview already ships the
  byte-identical parser. If the composed prompt carries markers, Change 1
  delivers the directive in-band and the follow-up is unneeded; if it does not,
  the host could not parse identity and the follow-up is the only delivery.

### 3. Pairing stays total

If a named send kind is ever exempted from the directive, it must be exempted
from STAMPING too, so the pair cannot come apart again. There is no exemption
for the paste path.

## Verification Plan

### Automated Tests

- **Host send, no `dispatch` field:** `ptySendPrompt` whose `data` carries
  `PLANS TO PROCESS:`/`PLAN_ID=` but no `dispatch` produces delivered text
  containing `COMPLETION REPORT:` exactly once — per root (the extension arm and
  the standalone `deliverPrompt` gate). This is the defect stated as a test.
- **Door follow-up:** POST `/kanban/verb/attributePastedPrompt` with
  `deliverReleaseInstruction: true` and a resolvable plan → exactly one
  `ptySendPrompt` to `terminalName` whose `data` contains `COMPLETION REPORT:`,
  sent with `kind: 'message'` and `clearBeforePrompt: false`, AND
  `extractDispatchIdentity(sentText) === null` (no re-stamp recursion).
- **No stamp, no send:** `attributed === 0`, or flag absent/false → no follow-up
  send. Asserted per caller shape, because the symmetric error releases the
  wrong card.
- **No-directive sends stay clean:** a relay, a nudge and an orientation stamp
  nothing and carry no completion directive — asserted per send kind.
- **Sentinel idempotence:** text already containing `COMPLETION REPORT:` is not
  double-appended on either mechanism.
- **Completion semantics unchanged:** a `submit` from a pasted seat releases the
  hold and does NOT change `kanban_column`.
- **Paste and queue dispatch of the same card produce the same completion
  instruction naming the same card.**
- Wire the new checks into the contract-suite aggregator; `npm run compile-tests`
  before any `test:contract:*` run.

### Goal Invariants

- **Positive:** every delivery kind that stamps `owner_seat` delivers
  `COMPLETION REPORT:` to the same seat — dispatch send, markered host send,
  clipboard paste, shift-drop, markerless normal drop. Asserted by driving each
  kind and checking the pair, not by reading call sites.
- **Negative (paired):** no delivery that stamps nothing carries
  `COMPLETION REPORT:` — relay, nudge, orientation, status check.

### Manual — the part that decides it

On the live board: copy-prompt a plan into a planner. Confirm the seat receives
`COMPLETION REPORT:` (in the paste-adjacent follow-up for a clipboard paste).
Let the planner finish. Confirm the card leaves `heldUnposted` without anyone
clearing it by hand. Repeat once via shift-drop. A green suite is not evidence
here — the suites were green while every pasted card leaked.
