# Proactive /clear when a lead rests a coder terminal

## Goal

Teach the head agent (lead) driving a team of coder terminals to send `/clear` to a terminal **at the moment it puts that terminal at rest** — i.e. when a coder has reported completion and the lead has decided the next subtask goes to a *different* terminal. The clear then lands minutes before that terminal's next dispatch instead of racing it.

> **Line references.** Every `file:line` below was re-resolved against HEAD on 2026-08-16. The draft's `bootstrap.ts` and `TaskViewerProvider.ts` references were drifted; corrections are inline.

### Problem

Today the only `/clear` a fleet terminal ever receives on the dispatch path is the one bolted to the front of a prompt delivery: `sendPromptToPty` writes `/clear\r`, waits a settle window, then pastes the prompt (`src/standalone/ptyPromptDelivery.ts:42-46`). That single mechanism has to satisfy two things that pull in opposite directions:

- The wait must be **long enough** for the CLI to finish tearing down and re-rendering its session, or the prompt concatenates with residual output.
- The wait must be **short enough** that a dispatch is not visibly stalled, because a human or an automation pass is waiting on it.

That tension is the whole reason the settle constant has been tuned repeatedly and now exists in three different values on two paths: `DEFAULT_CLEAR_SETTLE_MS = 600` for the directly-owned pty (`ptyPromptDelivery.ts:14`, cut down from 2000), a user-facing `terminal.clearBeforePromptDelay` setting on the VS Code clipboard/`sendText` path (resolved by `resolvePtyClearDelay`, `TaskViewerProvider.ts:362-367`; the Phone-a-Friend clipboard path reads it directly at `:5516` with a 2000 default), and a separate `terminal.ptyClearBeforePromptDelay` resolved in standalone (`resolveStandalonePtyClearDelay`, `bootstrap.ts:200-218`). The header comment in `ptyPromptDelivery.ts:8-13` explicitly warns the two paths are "different physics on the same-named operation" and must not be unified.

### Root cause

> **Superseded:** "The clear is scheduled at the **worst possible moment** — inline, immediately before the prompt that depends on it having finished. … The race disappears — not because the settle window was tuned correctly, but because there is no longer anything downstream of it inside the same operation."
> **Reason:** The race is real on the *board dispatch* paths, but it is **absent on the path this plan governs**. `terminal-coder-dispatch/SKILL.md:51-65` makes `clearBeforePrompt: false` mandatory on every `ptySendPrompt` a lead sends, and `sendPromptToPty` only writes `/clear` when the flag is truthy (`ptyPromptDelivery.ts:42`). So a lead-driven coder never takes the inline clear, and there is no settle window to remove. Justifying the change by a race that does not occur here leaves the actual defect unnamed — and makes the plan's success check answerable without addressing it.
> **Replaced with:** the root cause below.

**The `clearBeforePrompt: false` mandate is correct and has an unpaid cost: a lead-driven coder is never cleared at all.** The mandate exists because a resend must reach a coder that still remembers its own work — flipping it to `true` would wipe the conversation the resend depends on (`SKILL.md:189-196`). But it is the *only* clear on this path, so switching it off switches off context reset entirely. A coder that takes subtask 1, then subtask 4, then a fix resend, then subtask 7 carries every earlier subtask's conversation into every later one, indefinitely, until a human clears it from the terminals panel or the terminal dies.

The complement the mandate needs is a clear at a moment when nothing depends on it: **the idle interval after a coder reports and before it is dispatched again.** A terminal that has just reported completion and is being stood down is idle by definition; a clear issued there has that whole interval (typically minutes, while the lead reviews a diff and decides what to dispatch next) to complete. It restores the reset without reintroducing the inline settle window on the resend path — and, as a second-order benefit, a terminal cleared at rest has nothing left for a future inline clear to race.

The mechanism to do this **already exists and is already reachable by an agent**: `POST /terminals/verb/ptyClearTerminal` with `{ "name": "<friendlyName>" }` is served identically by both hosts — the extension routes `/terminals/verb/*` through `handlePtyVerb` (`TaskViewerProvider.ts:2521`) → `_ptyHostVerb` (`:417`, dispatched at `:2770`) → the pty-host child, which handles the verb at `src/standalone/ptyHost.ts:166-171`; standalone handles it directly at `src/standalone/bootstrap.ts:1391-1396`. Both call `clearPty` (`ptyPromptDelivery.ts:111-117`), which takes the same per-terminal send lock as `sendPromptToPty`, so a clear cannot splice into an in-flight chunked paste.

What does **not** exist is any instruction telling a lead to use it. The head-agent contract — `.agents/skills/terminal-coder-dispatch/SKILL.md`, the file the `Drive` feature-workflow toggle points a lead at (`DRIVE_FEATURE_PREFIX`, `src/services/KanbanProvider.ts:75`) — has a route table with exactly two rows (`ptySendPrompt`, `ptyListTerminals`) plus two `sendToTerminal` fallbacks, a dispatch/review/resend lifecycle, and no notion of a terminal being stood down. `.agents/skills/switchboard-orchestration/SKILL.md` §4b (`:214-224`) documents the same two verbs and no others. `DELEGATE_PARENT_NOTICE` (`agentPromptBuilder.ts:683-690`) is deliberately a single sentence with no protocol in it. So the lead has no reason to know the verb exists.

This is a contract gap, not a mechanism gap. The fix is to document the rest-and-clear step in the two agent-facing contracts a fleet head reads, and pin it with a source-text gate so it cannot silently drift out again.

### Two stale facts in the same files, corrected in the same edit

Both files this plan edits currently assert things that are false at HEAD, and both are loaad-bearing for *this* plan's own reasoning. Correcting them is not net-new scope — leaving them means the new contract test freezes false text in place, and the new §7 cross-references a paragraph that misstates the mechanism it depends on.

1. **An omitted `clearBeforePrompt` no longer defaults to `true`.** `terminal-coder-dispatch/SKILL.md:53-56` says "The extension's `handlePtyVerb` injects the config default (`switchboard.terminal.clearBeforePrompt`, default `true`) whenever the field is absent … **Omit the field and every dispatch sends `/clear` to the coder first**". It does not. `TaskViewerProvider.ts:2755-2768` injects the config default **only** when `clearBeforePromptFromConfig === true`; an absent `clearBeforePrompt` is left absent and the delivery layer treats it as false (`ptyPromptDelivery.ts:42`). `bootstrap.ts:1435-1437` converges on the same behaviour, and both carry comments saying so explicitly ("an absent field meaning /clear is fail-dangerous for a relay into a mid-task terminal"). `switchboard-orchestration/SKILL.md:223` repeats the same false claim ("omitting it wipes the coder's conversation before every send"). The **rule** — pass `false` explicitly on every send — stays; only its stated mechanism is wrong. Rewrite the justification as "explicit, because the default has moved once already and a silent flip wipes a coder mid-conversation".
2. **The standing-order cap constants do not exist.** `terminal-coder-dispatch/SKILL.md:144-146` states "Caps are server-side: `MAX_ORDERS = 20`, `MAX_INSTRUCTION_CHARS = 2000`, `MAX_BLOCK_CHARS = 4000`". All three were removed; `src/test/standing-orders-marker-contract.test.js:272-284` is an active contract test asserting **none of them is declared** in `standingOrders.ts` or `terminals.js`, and `applyStandingOrders` (`standingOrders.ts:147-184`) states "Truncation is gone" in its own comment. `validateInstruction` (`:188-192`) enforces only non-empty and no-marker.

## Metadata

- **Complexity:** 4
- **Tags:** reliability, docs, cli
- **Project:** Browser Switchboard

> **Superseded:** `**Complexity:** 3`
> **Reason:** 3 routes to Intern. The work is not mechanical: it rewrites a precondition whose loss makes a lead wipe a working coder, corrects two stale factual claims in a file whose only job is to be followed literally, and chooses what a permanent source-text gate will freeze. The plan itself names "the instruction is destructive if the precondition is dropped" as its top risk — that is not intern work.
> **Replaced with:** Complexity 4 → Coder.

## User Review Required

None. Every decision here is settled by the code: the verb exists on both hosts with one payload shape, the precondition and both prohibitions are forced by `clearPty`'s unconditional write and by the lead's own context being unrecoverable, and the two stale claims are contradicted by an active contract test and by the hosts' own source comments.

## Complexity Audit

### Routine

- Adding a route-table row for `ptyClearTerminal` to `.agents/skills/terminal-coder-dispatch/SKILL.md` §1 — mirrors the rows already there.
- Adding a new numbered section documenting the rest-and-clear step.
- Adding one failure-mode bullet to the existing failure-modes section — mirrors the bullets already there.
- Adding one row plus a pointer line to `.agents/skills/switchboard-orchestration/SKILL.md` §4b.
- Two one-paragraph factual corrections (the absent-field default, the retired caps).
- Registering a new contract test as an npm script and a CI step — both files carry dozens of identical entries.

### Complex / Risky

- **The instruction is destructive if the "at rest" precondition is dropped.** `clearPty` writes `/clear\r` to the pty unconditionally; there is no busy check anywhere in the path. An instruction that reads as "clear terminals you are not currently prompting" would have a lead wipe a coder that is mid-task. The precondition (completion callback received **and** next work assigned elsewhere) is the load-bearing half of the sentence, not a caveat.

- **A lead that clears itself destroys the driving session.** The pattern's continuity is the head's own conversation context across turns — there is no loop, no persisted state, nothing to recover from (`SKILL.md:7-11`). `SWITCHBOARD_TERMINAL` is the lead's own name and is right there in its environment (`SKILL.md:80-90`), and `ptyClearAllTerminals` is one verb away in the same family (`ptyHost.ts:178-182`, `bootstrap.ts:1450-1454`) — it clears every active terminal with no exclusions. Both need explicit prohibitions in the same section as the instruction, not buried elsewhere.

- **Regenerating the `.claude/` mirror.** `.agents/` is the source of truth, but `.claude/skills/terminal-coder-dispatch/SKILL.md` and `.claude/skills/switchboard-orchestration/SKILL.md` are committed and gated by `npm run mirror:check` (`scripts/check-claude-mirror.js`, wired at `package.json:898`), which regenerates from `.agents/` into a temp dir and fails on any content drift. Both files are in `MIRROR_MANIFEST` (`ClaudeCodeMirrorService.ts:78-84` and the orchestration entry). Editing only `.agents/` turns the build red. There is **no** `mirror:write` npm script — regeneration is the `node -e` invocation below.

- **Section renumbering is NOT a risk — the draft invented one.**

  > **Superseded:** "**Renumbering sections in a skill file that other text cross-references.** The skill body refers to its own sections by number (e.g. §3's callback contract is referenced from the failure-modes list). Any inserted section shifts three headings. The cross-references must be re-checked after the insert, or the doc sends a lead to the wrong section."
  > **Reason:** `grep '§' .agents/skills/terminal-coder-dispatch/SKILL.md` returns **nothing**. The document contains zero section cross-references; the failure-modes bullets refer to concepts and verb names, never to "§3". The hazard was invented, and the draft's own proposed insert text then introduced the first `§1`/`§3` references the file has ever had — manufacturing the fragility it warned about.
  > **Replaced with:** Insert the new section between `## 6. The resend` (`:189-196`) and `## 7. Sequencing across subtasks` (`:200`), renumber `7→8`, `8→9`, `9→10` (`## When this skill does NOT apply` is unnumbered and unaffected), and write the new section's internal references **by name**, not by number — "the `clearBeforePrompt: false` rule in §1" becomes "the mandatory `clearBeforePrompt: false` rule above". Keeping the file `§`-free is the anti-drift measure; adding the first `§` is not.

## Edge-Case & Dependency Audit

- **`success: true` does not mean the clear was written.** Both host arms return `{ success: true }` when the named terminal exists but `status !== 'active'` — they skip the write, because a dead pty has no context to reset (`ptyHost.ts:169`, `bootstrap.ts:1394`). Only an unknown name yields `{ success: false, error: "No such terminal: <name>" }`. A lead must not infer liveness from a successful clear; `ptyListTerminals` is the liveness check. This asymmetry belongs in the failure-modes list.

- **Standing orders survive a clear — but not for the reason the draft gave.** The callback contract is persisted at the `terminals.standingOrders` DB config key (`standingOrders.ts:15`) and re-appended per delivery: the extension appends inside `_ptyHostVerb` before the pty-host call, standalone inside `deliverPrompt` (`bootstrap.ts:1438-1443`, gated on `payload.standingOrders !== false`). Clearing a coder does not orphan it, and the lead must not re-register the order.

  > **Superseded:** "`MAX_ORDERS` is 20 and duplicate registration crowds the shared `MAX_BLOCK_CHARS` budget."
  > **Reason:** Those constants were removed and their absence is pinned by an active contract test (`standing-orders-marker-contract.test.js:272-284`); `applyStandingOrders` states "Truncation is gone" in its own comment (`standingOrders.ts:170-173`). The conclusion (do not re-register) is right; the budget it was justified by no longer exists.
  > **Replaced with:** A duplicate order is not truncated — it is *rendered twice*, so every prompt that terminal receives for the rest of its life carries the same `- Regarding terminal "…"` line two or more times. `applyStandingOrders` strips and re-appends the whole block per send (`:164`), so the duplication is permanent, not transient. `SKILL.md:148-150` already says to treat an existing order as authoritative and check with `GET` first; the rest section should point at that rule rather than restate a cap.

- **This must not weaken `clearBeforePrompt: false`.** The skill's existing hard rule is that every `ptySendPrompt` passes `clearBeforePrompt: false`, because a resend to a coder that is mid-conversation must preserve that conversation. Proactive clearing does not change that: a terminal the lead rested is already clean, and a terminal the lead did *not* rest still needs its context. The obvious wrong "simplification" — flip `clearBeforePrompt` to `true` and delete the rest step — reintroduces the inline settle window on every resend and destroys the conversation the resend depends on. The contract test must assert the `false` mandate is still present, so the two rules cannot be traded against each other later.

- **Lock interaction.** `clearPty` and `sendPromptToPty` share `withTerminalLock` keyed on terminal name (`ptyPromptDelivery.ts:22-29`). A clear issued to terminal A immediately after dispatching a prompt to terminal B involves two different locks and cannot interleave; a clear issued to a terminal with a paste in flight queues behind it rather than splicing into it. No new serialisation is needed.

- **Host parity.** Unlike `sendToTerminal` — which is served at different paths with different payload shapes per host, and which the skill already warns against for exactly that reason (`SKILL.md:44-49`) — `ptyClearTerminal` is one path and one `{ name }` payload on both hosts. Documenting it does not introduce a host split.

- **Not in `protocol-catalog.json`.** No `pty*` verb appears in the generated catalog (it covers the webview verb surface, not the pty rail), so `GET /catalog` is not a discovery path for this verb and no catalog regeneration is implied. `pty-route-surface-contract.test.js:1-38` pins that exclusion deliberately. The skill files are the discovery path — which is precisely why the gap matters.

- **The verb's existence is already gated elsewhere.** `pty-route-surface-contract.test.js:26-38` lists `ptyClearTerminal` in `PTY_VERBS` and asserts the whole set is served on `/terminals/verb/` and nowhere else, on both hosts, with a live server. The new test's host-arm assertion would duplicate that coverage — see the trimmed test below.

- **Reach gap (accepted).** These two skill files are read by leads that arrive via the `Drive` toggle and by fleet agents that load `switchboard-orchestration`. A lead that arrives by neither route — a delegate parent holding only `DELEGATE_PARENT_NOTICE`, or a human-prompted ad-hoc head — gets nothing. Widening reach means installing the instruction as a standing order at team-wiring time, which is a runtime change and a separate plan. Scoped out deliberately; recorded so the gap is not mistaken for coverage.

- **Dependencies:** none on unlanded work. Every route, verb, and lock this plan documents is live at HEAD.

- **Security:** no new surface. `ptyClearTerminal` is already exposed on the authenticated `/terminals/verb/*` rail that every fleet terminal can reach with its injected `SWITCHBOARD_API_TOKEN`; this plan adds documentation, not a route.

## Dependencies

None.

## Adversarial Synthesis

**Risk Summary.** The gap is real — `ptyClearTerminal` is live, host-parity, lock-safe, and named in no lead-facing contract — but the draft justified it with a race that does not occur on this path, since the same skill mandates `clearBeforePrompt: false` and the inline clear therefore never fires. The true defect is the mandate's unpaid cost: a lead-driven coder is never cleared at all. Chief risks are (a) an instruction that loses its "only at rest" precondition and has a lead wipe a working coder, (b) a lead clearing itself or calling `ptyClearAllTerminals` and destroying the unrecoverable driving context, and (c) a source-text gate that goes green on the words while no build check can observe whether any lead actually rests a terminal. Mitigations: the three prohibitions live in the same section as the instruction; the contract test pins the prohibitions and the `clearBeforePrompt: false` mandate rather than duplicating `pty-route-surface`'s verb-existence coverage; and two stale claims in the same files are corrected in the same edit so the gate does not freeze false text.

## Proposed Changes

### `.agents/skills/terminal-coder-dispatch/SKILL.md`

**1 — §1 route table (after the `ptyListTerminals` row, `:35`):** add a third row, ahead of the two `sendToTerminal` fallback rows.

```markdown
| Rest a terminal — reset its context | `POST /terminals/verb/ptyClearTerminal` with `{ "name": "<friendlyName>" }` |
```

**2 — §1 correction (`:51-58`), the absent-field default.** Replace the mechanism sentence; keep the rule and the example unchanged.

```markdown
### `clearBeforePrompt: false` is mandatory and non-obvious

Both hosts currently treat an **absent** `clearBeforePrompt` as `false` — the extension injects
the config default only when a caller passes `clearBeforePromptFromConfig: true`
(`TaskViewerProvider.ts`), and standalone does the same (`bootstrap.ts`). Do not rely on that.
The meaning of an omitted field has already moved once, and if it moves back, every dispatch
you send wipes the coder's conversation and the symptom is a coder with no memory of work it
did minutes earlier. Pass it explicitly on every send:
```

**3 — §3 correction (`:143-146`), the retired caps.** Replace the caps sentence.

```markdown
`available: false` in the GET response means no kanban DB is reachable — gate honestly rather
than pretending zero orders. There are no server-side caps and no truncation: a duplicate
order is not dropped, it is rendered a second time in the standing-orders block of every
prompt that terminal receives from then on.
```

**4 — new section, inserted between `## 6. The resend` and the current `## 7. Sequencing across subtasks`.** Renumber the three sections below it: `7 → 8`, `8 → 9`, `9 → 10`. (`## When this skill does NOT apply` is unnumbered and unaffected.) Refer to other sections **by name, not by `§N`** — the file has no `§` references today and must not acquire any.

````markdown
## 7. Resting a terminal — clear it when you put it down

A coder reports completion. You review the diff, and the next subtask goes to a *different*
terminal. That first terminal is now **at rest** — clear it immediately:

```bash
curl -s -X POST "$BASE/terminals/verb/ptyClearTerminal" $AUTH \
  -H "Content-Type: application/json" --max-time 10 \
  -d '{"name":"coder-1"}'
```

Both hosts serve this verb with the same `{ name }` payload — the extension through
`handlePtyVerb` → the pty host, standalone in `bootstrap.ts`. It takes the same per-terminal
send lock as `ptySendPrompt`, so a clear issued right after dispatching to another terminal
cannot splice into an in-flight paste.

**Why this step exists.** Because you pass `clearBeforePrompt: false` on every send, your
coders are never cleared by the dispatch path — a coder that took subtask 1, then subtask 4,
then a fix resend, carries all of it into subtask 7. Clearing at rest is what resets that
context, and it costs nothing: the terminal is idle, minutes pass before you dispatch to it
again, and nothing is waiting on the CLI's re-render. The alternative — letting the next
prompt carry the clear — pays for `/clear` and its settle window *inside* the dispatch and
destroys the conversation a resend depends on. The mandatory `clearBeforePrompt: false` rule
above is unchanged: a resend to a terminal you did **not** rest still needs its context.

Three rules, all load-bearing:

- **Never clear yourself.** Your driving context is your own conversation across turns —
  there is no loop holding it and nothing to recover it from. `SWITCHBOARD_TERMINAL` is your
  own name; never pass it to this verb. For the same reason, never call
  `ptyClearAllTerminals`: it clears every active terminal, you included.
- **Only clear a terminal that is genuinely at rest.** The verb writes `/clear` to the pty
  unconditionally — there is no busy check. A terminal is at rest when its completion message
  has reached you *and* you have decided its next work goes elsewhere. Clearing a coder that
  is still working destroys the work in flight.
- **Standing orders survive a clear.** The callback contract lives at the
  `terminals.standingOrders` DB key and is re-appended to every `ptySendPrompt`. A cleared
  coder still reports to you on its next task — do not re-register the order, and treat any
  existing order as authoritative (check with `GET /terminals/standing-orders` first).
````

**5 — failure-modes section (now §9):** append one bullet.

```markdown
- **`ptyClearTerminal` answered `success: true` and nothing was cleared** — the verb returns
  `success: true` when the name resolves but the terminal is not `active`; it writes nothing,
  because a dead pty has no context to reset. Only an unknown name returns
  `{"success": false, "error": "No such terminal: <name>"}`. Treat `success: true` as "the
  name resolved", not as "the terminal is alive" — `ptyListTerminals` is the liveness check.
```

### `.agents/skills/switchboard-orchestration/SKILL.md`

§4b "Prompt delivery (POST /terminals/verb/*)" (`:214-224`) — add a third row to the endpoint table after the `ptyListTerminals` row (`:224`), one pointer line beneath the table, and correct the same absent-field claim carried by the `ptySendPrompt` row (`:223`).

```markdown
| `POST /terminals/verb/ptyClearTerminal` | `{ name }` | Reset a named terminal's context. Send it when you put a terminal **at rest** — a clear issued at rest is what resets a coder you always send with `clearBeforePrompt: false`, and it lands long before the next dispatch instead of racing it. Never send it to your own terminal, and never use `ptyClearAllTerminals` (it clears every active terminal, you included). |
```

Row `:223`, replace "**Pass `clearBeforePrompt: false`** — omitting it wipes the coder's conversation before every send." with "**Pass `clearBeforePrompt: false` explicitly** — the omitted-field default has moved once already; if it moves back, every send wipes the coder's conversation."

```markdown
Clear a coder the moment you stand it down, not on the way back in — see
`terminal-coder-dispatch`, "Resting a terminal", for the precondition (completion received
**and** next work assigned elsewhere) and the self-clear prohibition.
```

### `.claude/skills/terminal-coder-dispatch/SKILL.md`, `.claude/skills/switchboard-orchestration/SKILL.md`

Generated mirrors — **do not hand-edit**. Both are in `MIRROR_MANIFEST` (`src/services/ClaudeCodeMirrorService.ts:47+`). Regenerate from `.agents/` after the edits above:

```bash
npm run compile-tests
node -e "require('./out/services/ClaudeCodeMirrorService').generateClaudeMirror(process.cwd(), require('./package.json').version)"
npm run mirror:check
```

Commit the regenerated mirror files alongside the `.agents/` edits. `mirror:check` fails CI on any drift. Note the working tree may already carry unrelated mirror changes — check `git status` for `.claude/skills/**` before and after so this change's regeneration is separable from whatever is already pending.

### `src/test/proactive-terminal-rest-clear-contract.test.js` (new)

Source-text gate, in the style of the skill-text assertions in `src/test/unattended-batch-improvement-contract.test.js:173-188`. It pins what nothing else covers: that the contract text carries the instruction, its precondition and both prohibitions, and that proactive clearing was not traded against the `clearBeforePrompt: false` mandate.

> **Superseded:** the draft's fifth case, `test('both hosts still serve ptyClearTerminal with a { name } payload', …)`.
> **Reason:** Duplicates `src/test/pty-route-surface-contract.test.js`, which already lists `ptyClearTerminal` in `PTY_VERBS` (`:26-29`) and asserts the whole `pty*` set is served on `/terminals/verb/` on both hosts against a live server — a stronger check than a `src.indexOf("case '…'")` string match. A second, weaker copy of an existing gate adds maintenance cost and no coverage.
> **Replaced with:** a stale-fact guard in its place, covering the two false claims this plan corrects — the class of defect that put them there in the first place.

```javascript
'use strict';

/**
 * Contract: proactive /clear at rest.
 *
 * A lead clears a coder terminal when it stands that terminal down. That is the ONLY
 * clear those coders ever get: the same skill mandates `clearBeforePrompt: false` on
 * every send, so the dispatch path never resets them. Every failure mode here is
 * silent — a rest instruction that loses its "only when at rest" precondition has a
 * lead wipe a working coder; a lead that clears itself destroys an unrecoverable
 * driving context; and trading `clearBeforePrompt: false` away for inline clearing
 * breaks every resend while paying the settle window back.
 *
 * Verb existence on both hosts is covered by pty-route-surface-contract.test.js
 * against a live server — deliberately not duplicated here.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const SKILL = '.agents/skills/terminal-coder-dispatch/SKILL.md';
const ORCH = '.agents/skills/switchboard-orchestration/SKILL.md';

let failures = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { failures++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

test('the head-agent contract teaches ptyClearTerminal', () => {
    const skill = read(SKILL);
    assert.ok(/ptyClearTerminal/.test(skill), 'terminal-coder-dispatch never names ptyClearTerminal');
    assert.ok(/at rest|resting|stand it down|put it down/i.test(skill), 'the rest step is undocumented');
});

test('the rest instruction carries its precondition and both prohibitions', () => {
    const skill = read(SKILL);
    assert.ok(/[Nn]ever clear yourself/.test(skill), 'the self-clear prohibition is missing');
    assert.ok(/ptyClearAllTerminals/.test(skill), 'the clear-all prohibition is missing');
    assert.ok(/no busy check/i.test(skill), 'the "writes unconditionally, no busy check" precondition is missing');
});

test('proactive clearing did NOT trade away clearBeforePrompt: false', () => {
    const skill = read(SKILL);
    assert.ok(/`clearBeforePrompt: false` is mandatory/.test(skill), 'the clearBeforePrompt: false mandate was removed');
    assert.ok(
        !/"clearBeforePrompt"\s*:\s*true/.test(skill),
        'the skill now shows a dispatch with clearBeforePrompt: true — that is the race this contract removes'
    );
});

test('the orchestration HTTP surface documents the clear verb', () => {
    const orch = read(ORCH);
    assert.ok(/ptyClearTerminal/.test(orch), 'switchboard-orchestration §4b omits ptyClearTerminal');
});

test('neither contract re-states a retired standing-order cap', () => {
    // MAX_ORDERS / MAX_INSTRUCTION_CHARS / MAX_BLOCK_CHARS were removed from the runtime;
    // standing-orders-marker-contract.test.js pins their absence in source. The skills
    // documented them for months after they were gone.
    for (const rel of [SKILL, ORCH]) {
        for (const cap of ['MAX_ORDERS', 'MAX_INSTRUCTION_CHARS', 'MAX_BLOCK_CHARS']) {
            assert.ok(
                !new RegExp(`\\b${cap}\\b`).test(read(rel)),
                `${rel} documents ${cap}, which no longer exists`
            );
        }
    }
});

test('neither contract claims an omitted clearBeforePrompt defaults to true', () => {
    // Both hosts treat an absent field as FALSE and inject the config default only on
    // an explicit clearBeforePromptFromConfig opt-in. The rule (pass false) stands; the
    // old justification did not.
    for (const rel of [SKILL, ORCH]) {
        const text = read(rel);
        assert.ok(
            !/[Oo]mit(ting)? (the field|it)[^.]{0,80}(wipes|sends `\/clear`)/.test(text),
            `${rel} still claims an omitted clearBeforePrompt clears the terminal — both hosts default it to false`
        );
    }
});

if (failures > 0) { console.error(`\n${failures} contract failure(s)`); process.exit(1); }
console.log('\nAll proactive-clear contract assertions passed.');
```

### `package.json`

Add the script beside the other `test:contract:*` entries (near `:903-905`):

```jsonc
"test:contract:terminal-rest-clear": "node --require ./src/test/bootstrap/sandboxStateHome.js src/test/proactive-terminal-rest-clear-contract.test.js"
```

### `.github/workflows/integration-tests.yml`

Add a step next to the other pty/terminal contract steps (after `test:contract:pty-prompt-delivery-framing`, `:96-97`), following the commented-step convention used throughout the file:

```yaml
      # A lead driving coders passes clearBeforePrompt: false on every send, so the
      # dispatch path never resets those terminals — a coder carries subtask 1's
      # conversation into subtask 7 forever. Clearing a terminal when the lead stands
      # it down is the only reset on that path, and it is pure source text: a rest
      # instruction that loses its "only when at rest" precondition has a lead wipe a
      # coder that is still working, and a lead that clears itself loses a driving
      # context nothing can recover.
      - name: Proactive terminal rest clear contract (rest instruction, prohibitions, no stale facts)
        run: npm run test:contract:terminal-rest-clear
```

## Verification Plan

> Per the dispatching session's directives, this pass ran no project compilation and executed no test suite as verification. Steps 1 and 5 below are the implementer's own acceptance for the deliverables they create; steps 2–4 and 6 are inspection and live-verb checks that need no build.

1. **The new contract test passes and actually bites.** Run it, then prove each assertion fails on the defect it guards: temporarily delete the "Never clear yourself" line and re-run (expect a failure); restore it. Temporarily re-add the sentence "Caps are server-side: `MAX_ORDERS = 20`" and re-run (expect a failure); restore. A source-text test that cannot fail is decoration.

2. **Mirror is in sync.** `npm run mirror:check` must print its success line, and `git status` must show the two regenerated `.claude/skills/**/SKILL.md` files staged alongside the `.agents/` edits. Capture `git status` for `.claude/skills/**` *before* starting — the working tree may already carry unrelated mirror changes.

3. **Section numbering is coherent after the insert.** Read the edited skill end to end and confirm headings run 1–10 with no gaps or repeats and the new section is §7. Then confirm the file still contains **zero** `§` characters (`grep -c '§'` → 0) — the new section must reference its siblings by name.

4. **The two stale facts are gone from both files, and their replacements are true.** `grep -n 'MAX_ORDERS\|MAX_INSTRUCTION_CHARS\|MAX_BLOCK_CHARS'` over both `.agents/` skills returns nothing. Re-read the rewritten `clearBeforePrompt` paragraph against `TaskViewerProvider.ts:2755-2768` and `bootstrap.ts:1435-1437` and confirm it describes what those arms actually do.

5. **Verb reachability, live.** With the extension running, against a real fleet terminal:
   ```bash
   PORT=$(cat .switchboard/api-server-port.txt)
   curl -s -X POST "http://127.0.0.1:$PORT/terminals/verb/ptyListTerminals" \
     -H "Content-Type: application/json" --max-time 10 -d '{}'
   curl -s -X POST "http://127.0.0.1:$PORT/terminals/verb/ptyClearTerminal" \
     -H "Content-Type: application/json" --max-time 10 -d '{"name":"<a live terminal>"}'
   ```
   Expect `{"success":true}` and a visibly reset CLI session in that terminal. Repeat with a bogus name and confirm `{"success":false,"error":"No such terminal: ..."}` — the asymmetry the new failure-modes bullet documents.

6. **End-to-end behavioural check — the only step that tests the actual goal.** Every other step verifies that words are present; none can observe whether a lead behaves. Start a lead team from the AGENTS tab, turn on the `Drive` feature-workflow toggle for a feature with at least two subtasks and at least two coder terminals, and drive it. Confirm the lead: dispatches subtask 1 to coder A; on coder A's callback, dispatches subtask 2 to coder B *and* issues `ptyClearTerminal` for coder A; never issues a clear against its own `SWITCHBOARD_TERMINAL`; never calls `ptyClearAllTerminals`; and still passes `clearBeforePrompt: false` on every `ptySendPrompt`. Then dispatch fresh work to coder A and confirm it starts from a clean context. **Do not mark this plan done on a green contract test alone** — the gate goes green on the text, and this step is what closes the gap between the text and the behaviour.

## Outstanding Questions

- **[user]** Should the rest-and-clear instruction also reach leads that never load `terminal-coder-dispatch` — delegate parents holding only `DELEGATE_PARENT_NOTICE`, and ad-hoc heads a human prompts directly? Installing it as a standing order at team-wiring time would cover them, but that is a runtime change to team instantiation, not a doc edit. Proceeding on the assumption that the two documented lead routes (`Drive` toggle, `switchboard-orchestration`) are the intended scope, and recording the reach gap in the Edge-Case audit rather than widening this plan.

## Recommendation

Complexity 4 → **Send to Coder.** The verb, the lock semantics and the host parity are all settled; the work is judgment about wording that a lead will follow literally, plus two factual corrections in the same files that the new gate would otherwise freeze in place. Do not route this to an intern: the plan's own top risk is a precondition being dropped from a sentence, and the fix for that is care in exactly the place an intern is weakest.

## Completion Report

Implemented in full on 2026-08-16, commit `025de73c`. Added the `ptyClearTerminal` row to the route table in `terminal-coder-dispatch/SKILL.md` section 1, inserted a new section 7 ("Resting a terminal — clear it when you put it down") with the at-rest precondition, three load-bearing prohibitions (never clear yourself, never `ptyClearAllTerminals`, only clear at rest), and the standing-orders-survive note, then renumbered sections 7→8, 8→9, 9→10. Corrected two stale facts: the absent-`clearBeforePrompt` default (both hosts default to `false`, not `true`) and the retired standing-order caps (`MAX_ORDERS`/`MAX_INSTRUCTION_CHARS`/`MAX_BLOCK_CHARS` no longer exist). Mirrored the verb and the corrected justification in `switchboard-orchestration/SKILL.md` section 4b. All 6 contract test assertions were proven to bite by temporarily breaking each guarded text and confirming failure before restoring. The file contains zero `§` characters (the pre-existing `§5` reference in section 3.5 was also corrected to reference "The review turn" by name). `npm run mirror:check` is green (47 files, v1.7.13) — the pre-existing red on `switchboard-orchestration` cleared as expected. The commit contains exactly 7 files: the two `.agents/` skill files, the two regenerated `.claude/` mirrors, the new test, and one hunk each in `package.json` and the CI workflow (staged via `git add -p`, leaving pre-existing unrelated hunks unstaged).

## Review Findings

Reviewer pass (2026-08-16) on commit `025de73c`, judged on **substance** — whether a lead could misread the at-rest precondition — since a source-text gate can only observe words. The mechanical deliverables all hold: 6/6 contract assertions pass, headings run 1, 2, 3, 3.5, 4–10 with no gaps, zero `§` characters remain in `terminal-coder-dispatch/SKILL.md`, both retired cap constants are absent from both files, the `clearBeforePrompt: false` mandate survives with no `clearBeforePrompt: true` example introduced, and `npm run mirror:check` is green at 47 files. **One MAJOR found and fixed in the precondition itself:** the rule defined "at rest" positively (completion received **and** next work assigned elsewhere) but never closed the negative reading, and the ride-along `## 3.5` section in the same file introduces a `blocked` turn-end notice fired on ~90 s of *silence* — the single most likely event to make a lead conclude a coder is free, when `blocked` in fact means the coder is mid-task and unresponsive. The rule now states explicitly that "at rest" is not "a terminal I am not currently prompting", that a dispatched coder you have not heard from is working, and that only a `completed` notice or an explicit completion message satisfies the precondition — never a `blocked` one. Files changed by this review: `.agents/skills/terminal-coder-dispatch/SKILL.md` plus its regenerated `.claude/` mirror. Remaining risk unchanged and correctly scoped by the plan: the gate still cannot observe lead behaviour, so Verification step 6 (drive a real two-coder feature and watch the lead rest coder A) is still the only check that closes the text-to-behaviour gap; and the reach gap for leads arriving via neither documented route stands as an Outstanding Question.

**Reviewer pass 2 (2026-08-17) — independent re-verification, no new findings.** Ran the gate rather than inheriting the prior claim: 6/6 assertions pass, and each was proven **non-vacuous** by evaluating its regex against a synthetically broken copy of the text in-memory (no file mutation) — every one fires on the defect it guards, including the two negative guards for the retired caps and the omitted-field claim. The corrected mechanism paragraph was checked against the real code and is accurate: `TaskViewerProvider.ts:2816` injects the config default only on an explicit `clearBeforePromptFromConfig === true`, `ptyPromptDelivery.ts:42` treats an absent field as falsy, and `bootstrap.ts:1425` says so in its own comment. Structure holds — headings run 1, 2, 3, 3.5, 4–10, zero `§` characters, both retired cap constants absent from both files, `$BASE`/`$AUTH` are defined at `:24-25` so the new §7 curl example is runnable as written, and the prior pass's `blocked`-notice caveat matches §3.5's actual definition (silence past `turnEndSilenceMs`, ~90 s). Gate wiring confirmed: `test:contract:terminal-rest-clear` is defined at `package.json:906` **and invoked** at `integration-tests.yml:107`; `mirror:check` green at 47 files. Remaining risk unchanged — the gate observes text, not lead behaviour, so Verification step 6 is still the only check that closes that gap.
