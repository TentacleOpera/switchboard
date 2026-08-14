# The Researcher Relationship Has No Return Path

## Goal

Give the `researcher` relationship a companion member-side standing order, so a researcher that is handed a question saves its findings and relays a summary back to the terminal that asked. Today the head-side order says *"fold its answer in when it comes back"* and nothing in the system makes it come back.

This is the prerequisite for retiring `/research/dispatch` (see `feature_plan_20260812170000_...`): that endpoint's one genuine contribution is the save-and-return instruction it appends host-side, and deleting it without replacing that instruction strands every answer.

### Problem analysis

Observed 2026-08-13. A planner (`planner-5`) handed a research question to `researcher-1` over `/terminals/relay`. Delivery succeeded — `{"success":true,"delivered":"researcher-1"}` — and then nothing came back. The researcher had:

- no instruction to save its findings anywhere, and
- no return address.

Its answer would have ended in its own scrollback and stayed there. It was only recovered because a **second** relay was sent by hand carrying both instructions; the researcher then saved a 24KB report and relayed a summary back, correctly, first attempt. The capability was never in doubt — the instruction was simply absent.

The stranding is total, not partial. The pty verb surface (`ptyListTerminals`, `ptyVisibleRoles`, `ptyCreateTerminal`, `ptySendPrompt`, `ptyWrite`, `ptyClear*`, `ptyClose*`, `ptyRename*`, `ptySendModel`, `ptyPasteImage`, `ptyCreateBatch`) exposes **no scrollback read**. Terminal output reaches the panel over `/ws/terminal` only. So an answer that is not written to a file or relayed back is not reachable by any caller — it is lost the moment it scrolls.

### Root cause

**`LINK_PRESETS` entries carry a single, one-directional template, and `/terminals/relay` has no reply channel.**

The `researcher` template (`src/services/linkPresets.ts:60-64`, mirrored at `src/webview/terminals.js:8032-8036`) is one body, installed on one terminal:

> *"{child} is your researcher. When you hit a question that needs external sources, documentation or API details you do not already have, hand it to {child} with enough context to work standalone — it cannot see your conversation. Keep working on what you can while it runs, and **fold its answer in when it comes back**. Do not block on it."*

Every clause is addressed to the head. The child is never told it is a researcher, never told where to put findings, and never told who asked. "When it comes back" is an assumption the vocabulary does not fund.

`/terminals/relay` does not fund it either. It stamps provenance for the *reader* —

```
=== RELAYED MESSAGE FROM planner-5 ===
…
=== END RELAYED MESSAGE ===
```

— but that is a header, not a route. Replying requires the recipient to compose its own `POST /terminals/relay` with `to`/`from` inverted, which it has no standing instruction to do.

**Why this surfaces now.** The teams relationship vocabulary has landed (commit `1bd39f4a`): `src/services/linkPresets.ts` is the canonical preset list, every preset carries `direction`, and `wireSpawnedTeam` (`src/services/teamWiring.ts:397-416`) reads `preset.direction` to decide which terminal receives the order. That is exactly right for `reports-to-head`, `reviewer`, `tester` and `second-opinion`, where one order suffices. It is **not** sufficient for `researcher`, which is the one relationship whose whole value is a round trip. Under a `direction`-only model the researcher is spawned, named in the head's order, and told nothing.

Today the gap is masked: `/research/dispatch` appends the missing half host-side —

```ts
const fullPrompt = `${prompt}\n\nIMPORTANT: After completing the research, save the results to ${savePath} using the write_to_file tool so the plan author can review them later.`;
```

(`src/services/TaskViewerProvider.ts`, inside `_dispatchResearchToResearcher` at `:4790`). Retiring that endpoint removes the only thing currently closing the loop, which is why this plan lands first.

## Metadata

- **Complexity:** 4
- **Tags:** backend, ui, feature, reliability
- **Project:** Browser Switchboard

## Current State (verified at HEAD, 2026-08-14)

The prerequisite this plan was written against **has landed**. Verified by direct read, not inferred:

| Surface | State at HEAD |
| :--- | :--- |
| `src/services/linkPresets.ts` | Exists. `LinkPreset = { id, label, direction, template }`, 7 entries, `resolvePreset`, `resolvePresetMeta`, `DEFAULT_MEMBER_RELATIONSHIP`. |
| `direction` field | Present on **all 7** presets in both files, non-optional in the TS interface. |
| `src/webview/terminals.js` mirror | `LINK_PRESETS` at `:8027-8086`, carries `direction`. |
| `src/test/link-presets-mirror-contract.test.js` | Exists. Asserts ids, labels, templates, directions match, plus `reports-to-head` ≡ `AGENT_GROUP_CALLBACK_INSTRUCTION`. |
| `wireSpawnedTeam` | `teamWiring.ts:360`. Resolves relationship → preset, branches on `direction`, installs orders through `mutateStandingOrders` with a `(parent, child)` idempotency key (`:444-459`). |
| `memberTemplate` | **Absent.** This plan introduces it. |

Two facts discovered during verification change the design below and are called out in place:

1. **The mirror contract test is a regex scraper, not a module import.** It parses both files textually. Adding a field is a **parser** change, not an added assertion — see Proposed Change 3.
2. **`wireSpawnedTeam` has no created-vs-reused signal.** All three call sites (`bootstrap.ts:1184`, `agentGroupInstantiation.ts:130`, `TaskViewerProvider.ts:2295`) pass only `{db, headName, children, members}`. The original "install only if this spawn CREATED the member" guard is therefore unimplementable without threading a new flag through three callers — and unnecessary, because the shipped `(parent, child)` idempotency key already delivers install-once. See Proposed Change 4.

## User Review Required

- None. The paired-order shape, the save location, the self-keyed install and excluding `custom` are all settled below.

## Complexity Audit

### Routine

- Adding an optional `memberTemplate` field to `LinkPreset` in `src/services/linkPresets.ts` and to the `terminals.js` mirror.
- Installing the companion order in `wireSpawnedTeam` alongside the primary one.

### Complex / Risky

- **The preset shape is co-owned, and its guard is a text parser.** `link-presets-mirror-contract.test.js` does not import either module — it reads both files as strings and reconstructs the presets with regexes (`extractPresets`, `:50-104`). A new field must be added to both files **and to that parser** in one change. Adding the field alone does not merely leave it uncovered: it silently corrupts the `template` comparison (Proposed Change 3 shows exactly how).
- **Order budget.** `MAX_ORDERS = 20` and `MAX_BLOCK_CHARS = 4000` are shared across every order on one terminal (`standingOrders.ts:13-15`), and truncation is **silent**, landing mid-sentence (`:70-72`). A paired relationship risks doubling the orders a shared researcher accumulates: one shared researcher serving eight planners would take eight member-side orders if keyed per head. See Edge-Case 2 — the fix is the key, not a guard.
- **`wireSpawnedTeam` bypasses `validateInstruction`.** The modal path validates the 2000-char cap at `LocalApiServer.ts:2373`; the spawn path writes through `mutateStandingOrders` directly and does not. An over-long `memberTemplate` would be installed unchecked and then truncated mid-sentence at block-render. Keep the body far under both caps (the one below is ~640 chars).
- **The reply instruction must be executable, not aspirational.** "Report back to whoever asked" is the same class of instruction as "fold its answer in when it comes back" — it names an outcome and no mechanism. The member template must carry the actual `/terminals/relay` shape with `to`/`from`, or it reproduces this bug one level down.
- **Preset prose may not contain a single quote.** Both files use single-quoted concatenation, and the contract test's fragment regex (`/'([^']*)'/g`, `:88`) does not understand `\'` as an escape — an escaped quote desynchronises the parser mid-entry. This rules out the `curl -d '{...}'` idiom for the new body and forces the `reports-to-head` house style (name the route and the JSON, no shell quoting). It also rules out apostrophes in the prose: write "Do not", never "don't".

## Edge-Case & Dependency Audit

1. **Prerequisite satisfied.** `linkPresets.ts`, `direction`, the mirror and its contract test all exist at HEAD (commit `1bd39f4a`). This plan extends that shape and is unblocked.
2. **A shared researcher must not accumulate one order per asker.** A shared researcher serves N heads. The member-side order is about *how to answer anyone*, not about a specific head. Keying it `(parent = researcher, child = researcher)` — self-referential — makes the shipped `(parent, child)` idempotency check (`teamWiring.ts:444-459`) install it exactly **once**, no matter how many heads wire to that instance, with no new plumbing. Keying it `(parent = researcher, child = head)` would install N identical copies, burn the 20-order budget at 20 planners, and mislabel each one.
3. **A self-referential order does not survive a rename today.** `rewriteStandingOrdersForRename` (`standingOrders.ts:39-50`) updates `parent` **or** `child`, never both — the first `if` returns before the second is reached. For every order that exists today the two fields differ, so the bug is latent. A self-keyed order makes it live: rename the researcher and only `parent` is rewritten, leaving `child` at the old name, so `applyStandingOrders`' `liveNames.has(o.child)` filter (`:61`) drops the order and the return path silently dies. Fixed in Proposed Change 5 — this is a hard part of this change, not an optional cleanup.
4. **`custom` has no templates.** It is a UI sentinel with an empty body (`linkPresets.ts:116`, `terminals.js:8085`); `resolvePresetMeta` already rejects it and falls back to `reports-to-head`. `memberTemplate` is likewise absent for it. An unknown relationship id must fall back to `reports-to-head`, never to an empty instruction — which `resolvePresetMeta` already guarantees, so the wiring inherits it.
5. **Presets that need no return path keep none.** `reports-to-head` is already member-side; `reviewer`, `tester` and `second-opinion` are head-side and *do* expect a reply, but their replies are conversational rather than artefacts — deliberately out of scope here. `memberTemplate` is **optional**; only `researcher` defines one in this plan. Widening it to the others is a separate decision.
6. **The standing-order prefix.** `applyStandingOrders` renders each order as `- Regarding terminal "<child>": <instruction>` (`standingOrders.ts:66-68`). With the self-key of Edge-Case 2 the `<child>` slot is the researcher's own name, so the line reads `- Regarding terminal "researcher-1": You are a researcher for this fleet…`. Coherent, and it satisfies the harder constraint: the body must never lean on that slot to identify the asker, because the asker is not in it. Use the relay's own `FROM` stamp instead.
7. **The instruction must stay on one line.** `applyStandingOrders` emits one order per line and appends its own `\n`. A `\n` inside an instruction breaks the list into what looks like separate orders. Write the body as single-line prose with inline `(1)` / `(2)` markers — the same shape `reports-to-head` already uses.
8. **Save location.** `/research/dispatch` resolved `switchboard.research.localFolderPaths[0] || '.switchboard/docs/'` (inside `_dispatchResearchToResearcher`). The member template must name the same default so retiring the endpoint does not silently move where findings land. The templates are static strings, so the configured override cannot be interpolated — name the default and let the operator's own instruction override it in practice. The setting itself is **not** deleted by the retirement plan.
9. **The relay port.** The member template needs a concrete target. `/terminals/relay` is served by the same `LocalApiServer` the agent already reaches; the port is in `.switchboard/api-server-port.txt`. Instruct reading the port file rather than hardcoding a port — the port is not fixed across installs or restarts. `reports-to-head` already words this exactly ("against the port in .switchboard/api-server-port.txt"); reuse the phrasing.
10. **Auth header.** Under the extension host `getAuthToken()` is empty and `_checkAuth` short-circuits to loopback trust; under standalone the header is required. Emit `Authorization: Bearer $SWITCHBOARD_API_TOKEN` unconditionally — the shell expands it, so the secret never enters scrollback. Note that `reports-to-head` omits the header entirely and would therefore fail under standalone; that is a pre-existing gap in a different preset and **out of scope here** — do not "fix" it in this change.
11. **`from` must be the researcher's own name.** `/terminals/relay` validates both ends against the live fleet and 404s on a bad `from`. The member template must tell the researcher to use its own terminal name, which it can read from the relay stamp of the message it received or from `ptyListTerminals`.
12. **No blocking.** The head-side order already says "Do not block on it" — unchanged. The member-side order must not introduce an acknowledgement handshake; it is fire-and-forget in both directions.
13. **Race conditions.** A researcher answering two relayed questions concurrently must reply to each asker separately. Since the reply is composed from the incoming message's `FROM` stamp, this is naturally per-message; do not introduce a "last asker" variable.
14. **Security.** No new endpoint and no new input. `/terminals/relay` already validates both ends against the live fleet and hardcodes `clearBeforePrompt: false`, so a reply cannot wipe the asker's context.
15. **The two `resolvePreset` implementations deliberately differ — do not "fix" the divergence.** TS (`linkPresets.ts:129-138`) falls back to `reports-to-head` for unknown/`custom`/empty, so a wired member never gets an empty order. JS (`terminals.js:8102-8108`) returns `''`, so picking *Custom…* in the modal empties the box for the operator to type. Both are correct for their caller. The TS docblock's claim that it "Mirrors `resolvePreset` in `terminals.js`" is false and invites a future agent to unify them; correct the comment (Proposed Change 1) and leave both behaviours alone. The contract test covers the preset **data**, not the resolvers.

## Dependencies

- `sess_none — no external session dependency.`
- **Satisfied: the teams relationship vocabulary** — `linkPresets.ts`, `direction`, `wireSpawnedTeam`'s direction branch and the mirror contract test are all present at HEAD (`1bd39f4a`). This plan extends all four and is unblocked.
- **Hard: blocks the retirement plan** — `feature_plan_20260812170000_...` (retire `/research/dispatch`) must land **after** this one. That endpoint currently appends the save instruction that this plan replaces; retiring first leaves an interval where no path closes the loop.
- **Shares `src/webview/terminals.js`** with `feature_plan_20260812171500_...` (link-up preset delivery), but in a **different region**: this plan edits only the `LINK_PRESETS` literal (`:8027-8086`); that plan edits `loadLayoutSettings` (`:1416-1422`), the preset `change` handler (`:8520-8525`) and `buildLinkPrompt` (`:8370-8394`). They serialise under the project's one-stream-per-file rule but do not contend for the same lines.

## Adversarial Synthesis

Key risks: a member-side order that names an outcome instead of a mechanism, reproducing the exact stranding it exists to fix — closed by putting the concrete `/terminals/relay` shape in the template. A new preset field landing on one side of the mirror — closed by extending the test's **parser**, not just its assertions, because the parser is a regex scraper that will otherwise fuse the new field into `template` and go green while covering nothing. A shared researcher accumulating one identical order per head — closed by keying the companion order to the researcher itself, which reuses the shipped idempotency check instead of inventing a spawn-provenance flag the wiring function does not have. And the sting in that tail: a self-keyed order is the first order in the system whose `parent` and `child` are equal, which exposes a latent rename bug that would silently kill the return path the first time anyone renames a researcher — fixed here, in the same change, because this plan is what makes it reachable. Sequencing is the last risk: land this before the retirement plan or there is a window with no working return path at all.

## Proposed Changes

### 1. `src/services/linkPresets.ts` — an optional member-side companion template

**Context.** `LinkPreset` at `:30-35`; the `researcher` entry at `:56-65`; the `resolvePreset` docblock at `:122-128`.

**Logic.** Some relationships are a round trip. Add an optional second body installed on the member at spawn, independent of `direction` (which continues to place the primary order).

**Implementation.** On the interface:

```ts
/** Optional companion order installed on the MEMBER at spawn, in addition to the
 *  primary order placed by `direction`. Present only for relationships whose value
 *  is a ROUND TRIP: the head-side body says "hand it questions and fold its answer
 *  in when it comes back", and nothing else in the system makes it come back —
 *  /terminals/relay stamps provenance for the reader but is not a reply channel.
 *
 *  Installed under the self-key (parent = child = the member), so `wireSpawnedTeam`'s
 *  existing (parent, child) idempotency check installs it exactly ONCE however many
 *  heads share the instance. Keying it per head would burn the 20-order budget and
 *  silently truncate the block at 4000 chars (standingOrders.ts:13-15, :70-72).
 *
 *  Single-line, no single quotes, no apostrophes: applyStandingOrders emits one
 *  order per line, and the mirror contract test's fragment regex has no escape
 *  handling. */
memberTemplate?: string;
```

and on the `researcher` entry, after `template`:

```ts
memberTemplate:
    'You are a researcher for this fleet. When another terminal relays you a question, research it, '
    + 'then do BOTH of these — findings you keep to yourself are lost, because nothing can read your '
    + 'terminal. (1) Save the full report to .switchboard/docs/ with your file-write tool. (2) Relay a '
    + 'standalone summary back to whoever asked, naming the saved file path: POST /terminals/relay with '
    + '{"to":"<the name in the RELAYED MESSAGE FROM stamp on their message>","from":"<your own terminal '
    + 'name>","message":"<your summary>"} against the port in .switchboard/api-server-port.txt, sending '
    + 'header Authorization: Bearer $SWITCHBOARD_API_TOKEN. They cannot see your terminal, so the '
    + 'summary must stand on its own.'
```

Also correct the false claim in the `resolvePreset` docblock (`:124`): it does **not** mirror the webview function — the webview returns `''` for `custom` so the modal message box empties, while this one falls back to `reports-to-head` so a wired member never receives an empty order. State the divergence and that it is deliberate (Edge-Case 15).

**Edge cases.** ~640 chars — far inside `MAX_INSTRUCTION_CHARS` (2000), which matters because the spawn path does not call `validateInstruction`. No `{child}`/`{parent}` placeholders, deliberately (Edge-Case 6): the asker is identified from the relay stamp, not from the order. No `\n` (Edge-Case 7). No `'` anywhere, including apostrophes (Complexity Audit).

### 2. `src/webview/terminals.js` — mirror the field

**Context.** The `LINK_PRESETS` literal at `:8027-8086`; the `researcher` entry at `:8028-8037`.

**Implementation.** Add `memberTemplate` to the `researcher` entry, byte-identical to the TS source, under the existing keep-in-sync comment. **Do not reorder the array** — `LINK_PRESETS[0]` is the persisted default preset (`:1418-1419`, `:8089`).

**Edge cases.** The webview never *installs* the companion order — the modal writes a single instruction through `/terminals/standing-orders`, and spawn-time wiring is host-side. The mirror exists so the contract test can compare, and so the two copies do not drift when the field is next edited.

### 3. `src/test/link-presets-mirror-contract.test.js` — extend the **parser**, then assert

**Context.** `extractPresets` at `:50-104`; the field-comparison test at `:122-134`.

**Logic.** This is the step most likely to be under-done, because the test looks like it does a structured comparison and does not. It reads both files as text and rebuilds each preset with regexes. Three concrete defects appear the moment `memberTemplate` is added:

- **`template` swallows `memberTemplate`.** Fragment collection (`:91-100`) stops only when the gap between two quoted fragments contains `}` or `id:`. The gap between the last `template` fragment and the first `memberTemplate` fragment is `,\n    memberTemplate:\n        ` — neither. So every `memberTemplate` fragment is appended to `template`. Both files fuse identically, so `assert.strictEqual(ts.template, js.template)` **still passes** — the test goes green while `template` is no longer being compared as `template` and `memberTemplate` is not compared at all.
- **No `memberTemplate` assertion exists.** A field the test does not compare is a field that drifts.
- **Field order becomes load-bearing.** Placing `memberTemplate` *before* `template` happens to avoid the fusion (`indexOf('template:')` is case-sensitive and does not match inside `memberTemplate:`). Do not rely on that. A test whose correctness depends on the declaration order of two sibling keys is a trap for the next editor.

**Implementation.** Replace the ad-hoc template scrape with one helper used for both fields:

```js
/**
 * Extract a single-quoted concatenation for `key` from one entry.
 * Anchored so `template` does not match inside `memberTemplate`, and terminated
 * at the entry boundary OR at any sibling key, so one field never swallows the
 * next. Returns undefined when the key is absent.
 */
function extractConcat(arrayText, key, fromIdx) {
    const keyRe = new RegExp('(?:^|[,{\\s])' + key + '\\s*:');
    const rel = arrayText.slice(fromIdx).search(keyRe);
    if (rel === -1) { return undefined; }
    const m = arrayText.slice(fromIdx + rel).match(keyRe);
    const section = arrayText.slice(fromIdx + rel + m[0].length);
    const fragments = [];
    const fragRegex = /'([^']*)'/g;
    let fragMatch, lastIdx = 0;
    while ((fragMatch = fragRegex.exec(section)) !== null) {
        if (fragMatch.index > 0) {
            const between = section.slice(lastIdx, fragMatch.index);
            // Entry boundary, next entry, or ANY sibling key ends this value.
            // Inside one concatenation the gaps are only `+`, whitespace and
            // newlines — never an identifier followed by a colon.
            if (between.includes('}')) { break; }
            if (/\b\w+\s*:/.test(between)) { break; }
        }
        fragments.push(fragMatch[1]);
        lastIdx = fragMatch.index + fragMatch[0].length;
    }
    return fragments.join('');
}
```

Use it for both fields when building each entry, and add the assertion beside the existing three (`:129-132`):

```js
assert.strictEqual(
    ts.memberTemplate, js.memberTemplate,
    `Preset '${ts.id}': memberTemplate mismatch`
);
```

Presets without the field compare `undefined === undefined` and pass unchanged.

**Edge cases.** Confirm the existing four assertions still pass **before** adding the field — a parser rewrite that changes what `template` extracts for the six untouched presets is a regression in the guard itself. Re-run after adding the field and confirm the researcher's `template` is the head-side body **only**, not the fused blob. The fragment regex still has no escape handling, which is why the preset prose may not contain `'` — keep that constraint documented in the helper rather than adding escape support the source files are not allowed to need.

### 4. `src/services/teamWiring.ts` — install the companion order under the self-key

**Context.** `wireSpawnedTeam` at `:360`; the `ResolvedOrder` accumulation at `:391-416`; the idempotent install at `:440-460`.

**Logic.** After resolving each member's primary order, push a second `ResolvedOrder` when the preset defines a `memberTemplate`, keyed `parent = child = memberName`. The existing loop then installs it through the same `mutateStandingOrders` call, the same `MAX_ORDERS` pre-check, and the same `(parent, child)` idempotency check — which is precisely what delivers install-once for a shared researcher, with no created-vs-reused flag and no change to any of the three call sites.

**Implementation.** Inside the `for (let i = 0; i < count …)` loop at `:403-414`, after the `direction` branch pushes the primary order:

```ts
// Round-trip relationships need a second, member-side order — the head-side
// body says "fold its answer in when it comes back" and nothing else makes it
// come back. Self-keyed (parent = child = member) so the (parent, child)
// idempotency check below installs it exactly ONCE however many heads share
// this instance; keying it per head would install N identical copies and burn
// the 20-order budget. No {child}/{parent} substitution: the body identifies
// the asker from the relay stamp, never from the order.
if (preset.memberTemplate) {
    resolvedOrders.push({
        parentName: memberName,
        childName: memberName,
        instruction: preset.memberTemplate,
    });
}
```

**Edge cases.** The primary order for a `head-receives` researcher is `(head, member)` and the companion is `(member, member)` — different tuples, no collision, and both are counted by the `toAdd` pre-check so the cap error stays accurate. The `resolvedOrders.length === 0` fallback at `:420-428` is untouched: it runs only when `members` is absent entirely, where there is no relationship to resolve and so no companion. `resolvePresetMeta` already maps unknown and `custom` ids to `reports-to-head`, which defines no `memberTemplate`, so a bad id installs no companion rather than an empty one.

### 5. `src/services/standingOrders.ts` — rename must rewrite both ends

**Context.** `rewriteStandingOrdersForRename` at `:39-50`.

**Logic.** The current mapper returns on the first match, so an order whose `parent` and `child` are the same terminal has only its `parent` rewritten. `applyStandingOrders` then filters it out (`liveNames.has(o.child)` fails against the stale name) and the return path dies silently on the first rename. No order in the system has equal ends today, so this is latent — Proposed Change 4 is what makes it reachable, so the fix belongs in this change, not a follow-up.

**Implementation.** Rewrite both fields in one pass:

```ts
const next = orders.map(o => {
    // Both fields, not the first match: a self-keyed order (parent === child,
    // e.g. the researcher's own return-path order) needs both ends rewritten
    // or applyStandingOrders' liveNames.has(child) filter silently drops it.
    if (o.parent !== oldName && o.child !== oldName) { return o; }
    changed = true;
    return {
        ...o,
        parent: o.parent === oldName ? newName : o.parent,
        child: o.child === oldName ? newName : o.child,
    };
});
```

**Edge cases.** Behaviour is byte-identical for every order with distinct ends, which is every order that exists on a shipped install — so this is not a migration, and no persisted state changes shape. Both hosts call this function (`TaskViewerProvider.ts:2277`, `bootstrap.ts:1291`), so the single fix covers the extension and standalone.

## Verification Plan

Manual, against a running fleet. Per session directive, no compilation step and no automated test run is part of this plan.

1. **Reproduce the stranding first.** On the pre-change build, relay a research question to a researcher with no extra instructions. Confirm nothing is written under `.switchboard/docs/` and nothing returns — the answer exists only in its scrollback.
2. **The round trip closes.** After the change, start a team with a `researcher` member and relay a question from the head. The researcher saves a report under `.switchboard/docs/` **and** relays a summary back naming the file path.
3. **Read the orders, do not infer them.** `GET /terminals/standing-orders` and confirm the head carries the `researcher` body about the member, and the member carries the companion body with `parent === child === <researcher name>`. A flipped or missing order is silent in behaviour.
4. **Shared researcher, one companion order.** Team with one shared researcher; start eight heads against it. The researcher holds **one** companion order, not eight, and all eight heads hold an order naming it.
5. **Rename the researcher, then re-verify.** Rename it and re-read `GET /terminals/standing-orders`: the companion order must show the **new** name in both `parent` and `child`. Then send the researcher a prompt and confirm the companion order still appears in its standing-orders block — this is the Change 5 regression, and it is invisible without the explicit re-read.
6. **Two askers, two replies.** Relay a question from head A and another from head B. Each gets its own reply; neither is answered to the wrong terminal.
7. **Reply survives the asker's other work.** The reply arrives without clearing the asker's context — `/terminals/relay` hardcodes `clearBeforePrompt: false`.
8. **Order budget.** With a researcher, a reviewer and three coders on one head, confirm the rendered block is under `MAX_BLOCK_CHARS` and no order is truncated mid-sentence.
9. **One line per order.** Confirm the rendered standing-orders block still shows exactly one `- Regarding terminal "…":` line per order — a stray newline in the new body would split it into what reads as two orders.
10. **Other relationships unchanged.** A `reports-to-head` coder and a `reviewer` gain no companion order and behave exactly as before.
11. **`custom` stays inert and excluded.** Still absent from the member relationship dropdown; no companion order. An unknown relationship id installs the `reports-to-head` order and no companion.
12. **Standalone host.** Repeat verification 2 under `npx switchboard`, where the `Authorization` header is genuinely required — the reply must still deliver.

### Automated Tests

None added, and none run in this pass (session directive). The one existing contract that must be extended rather than left behind is `link-presets-mirror-contract.test.js` — see Proposed Change 3, which changes its **parser** and adds one assertion. Note that leaving it untouched does not turn it red; it turns it green-and-meaningless, which is why the change is specified as a parser rewrite rather than an added assert.

## Recommendation

Complexity 4 → **Send to Coder.** Land **first** in this feature, before the link-up preset change and before the `/research/dispatch` retirement. The teams prerequisite is already satisfied at HEAD.
