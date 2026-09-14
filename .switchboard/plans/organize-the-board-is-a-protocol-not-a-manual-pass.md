# Organising the Board Is a Protocol, Not a Manual Pass

> **Re-cut to the ask, 2026-09-14.** Operator: *"I asked for a kanban button similar to suggest
> features that triggered a board organisation workflow, not a UI surface"*, and *"I literally asked
> for a guidance protocol, not a ceremony"*.
>
> **What the plan built instead.** From its first revision (`e0e7f7e5`) it specified a server-side
> `auditBoard` service wired into both composition roots, an **Organise** button opening a findings
> panel with per-item accept/dismiss, a `lc organize` CLI verb, a content-overlap detector, and a
> merge action — eleven changes, 376 lines. The button was asked for; everything behind it was not.
>
> **The model is SUGGEST FEATURES, and it is five lines of plumbing:**
>
> ```
> kanban.html:3046      <button id="btn-suggest-features">SUGGEST FEATURES</button>
> kanban.html:6910      → postKanbanMessage({ type: 'suggestFeatures', workspaceRoot, projectFilter })
> KanbanProvider:15355  → _buildSuggestFeaturesPrompt(...)   // names .agents/skills/manage-features/SKILL.md
>               :15356  → clipboard.writeText(prompt)
>               :15357  → "prompt copied — paste into chat"
> ```
>
> A button, a message, a prompt naming a **skill file**, copied to the clipboard. No panel, no
> endpoint, no service. The skill file holds the instructions; the agent does the work — **including
> gathering the board data itself**. That is the whole shape, and it is what this plan is now.
>
> The previous revisions are in git (`e0e7f7e5`, `153f6bd8`, `b754d753`).

## Goal

A protocol an agent reads when the operator asks it to organise the board. It says what to look at,
in what order, how to act, and — mostly — when to stop and ask.

It ships as **a skill file plus one button**, modelled exactly on SUGGEST FEATURES. No audit
service, no findings panel, no CLI verb, no new endpoint. Every action the agent takes uses something
that already exists.

**The agent gathers the board data itself** — the prompt carries the skill path, the workspace root
and the project filter, nothing more. Pre-computing a candidate list in the host would put a second,
staler copy of the board's state in the prompt and give the agent a reason not to read the plan files,
which is exactly the mistake rule 1 exists to prevent.

### What the operator wants organised

1. **Loose cards grouped into features.**
2. **Duplicates merged.**
3. **Plans that are out of date surfaced.**
4. **The board's condition made visible** — said out loud, in the conversation, not written to a file.

### The governing rule

**The agent proposes. The operator disposes. Nothing is applied without a yes.**

This is not caution for its own sake — it is the only thing that works. On 2026-09-14 an agent
walking this exact territory concluded five separate times that work was unwritten or unbuilt when it
was not: the mission step model (it exists as *streams*, not *steps*), the shared/runtime schema
split (built; the separate-file half was deliberately cancelled), the `TERM` fix (already planned,
more thoroughly), the tracker-label design (already planned, then retired by operator decision), and
standing orders (assumed intact; actually deleted). Each was settled only by the operator saying so.

An agent cannot determine "is this done?" from the corpus. It can only bring the question and the
evidence.

## The protocol

### 1. Read before proposing anything

Read the board, then read the **plan files** of anything you intend to touch. Titles are not enough —
today's misjudgements were all title-and-grep level. A vocabulary mismatch (*step* vs *stream*) makes
a correct design look absent.

### 2. Group by proposing clusters, one at a time

Cluster on topic and tags. Present each as **name + members + why**. The operator accepts, edits or
rejects per cluster. Do not batch them into one approval.

### 3. Apply groupings through `features/reconcile` — never a sequence of creates

`POST /kanban/features/reconcile` (`LocalApiServer.ts:7044`) → `reconcileFeatures`
(`KanbanProvider.ts:16559`), with `removeUnmentionedFeatures` (`:16762`) for deletions. Build the
desired end state and send it once.

**It is idempotent but NOT single-transaction atomic.** A mid-failure leaves partial state that a
retry converges. So the apply is **re-audit → re-apply**, never fire-once-and-trust.

### 4. Close cards through `task/complete`, with a reason

`POST /kanban/task/complete` (`LocalApiServer.ts:4196`), body
`{ from, planId, workspaceRoot?, outcome?, note? }`. `from: "operator"` is accepted with **no live
terminal** (verified at `:4147-4153`). Always give a `note` — a card closed without a reason is
indistinguishable from one closed by mistake.

### 5. Delete features through the API, never by removing the file

The watcher re-imports a deleted file. Use the API delete path.

### 6. Never assert that a plan is done — ask

If a plan's subject appears to exist in the tree, say so **as a question**, with the evidence:
*"this plan's subject appears to be at `<path>` — is it done?"* Do not move it, close it, or mark it.
The operator's answer is the fact.

### 7. Check the card's premise, not just its subject

A distinct and more useful signal: a card written before some mechanism landed may still be *unbuilt*
while its **premise** is now false. Compare the card's `created_at` against what shipped since, and
read its plan file for the tell — these cards usually quote the constraint that no longer holds.
Surface it as a question, per rule 6.

### 8. Report the board's condition in conversation

Counts, duplicates, remnants, anything odd. Spoken, not filed. A findings document nobody opens is
the same failure as nobody looking.

### 9. Say what you cannot fix

Some things the protocol only diagnoses. Say so and move on rather than implying a cure. Current
example: the hot board holds **2,556 completed plans against 590 active** and no archive database
exists — the cause is diagnosed in *Auto-Archive Has Never Run: the Advertised Switch Is Not the One
the Code Reads*. Organising cannot remove a single one of those rows.

## What gets built

| Piece | Shape |
| :--- | :--- |
| `.agents/skills/organize-board/SKILL.md` | the protocol above, as a skill file |
| `ORGANISE` button | `kanban-controls-strip`, beside `SUGGEST FEATURES` |
| `organizeBoard` message + prompt builder | mirrors `suggestFeatures` / `_buildSuggestFeaturesPrompt` — names the skill path, injects workspace root and project filter, copies to clipboard |

That is the entire build. If `SUGGEST FEATURES` needed more than that, so would this; it did not.

## Deliberately dropped

Build items from the previous revisions, removed because the agent does the work:

| Dropped | Was |
| :--- | :--- |
| `auditBoard` service wired in both roots | change 1 |
| Findings panel with per-item accept/dismiss | change 5 (the panel, not the button) |
| `lc organize` CLI verb | change 6 |
| Content-overlap detector | change 7 |
| Merge action | change 8 — the agent merges using protocol rules 3–5 |
| Pre-computed candidate card list in the prompt | the agent gathers its own |

Any of these is a separate plan with its own justification if wanted later, not a rider on this one.

## Metadata

**Tags:** protocol, docs, board, agents
**Complexity:** 2

## Verification Plan

There is no code, so there is no contract test. The protocol is verified by use:

1. Ask an agent to organise the board. It proposes and applies nothing unasked.
2. Give it a plan whose work has shipped. It **asks** rather than closing it.
3. Give it a plan whose vocabulary differs from yours (*step* vs *stream*). It reads the file rather
   than concluding from the title.
4. Accept one grouping and reject another. Only the accepted one lands.
5. Re-run it. The second pass proposes nothing new — `features/reconcile` is idempotent.

### Goal Invariants

1. Nothing is applied without an explicit yes.
2. No plan is ever marked done by the agent.
3. The protocol adds no audit service, findings panel, CLI verb or endpoint — one button and a skill file.
4. What it cannot fix, it names.
