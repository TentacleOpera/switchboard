# Long-Term Orchestration Is the Headline, Not the Fifth Bullet

## Goal

Make **automatic orchestration of long-running projects** the site's primary
claim, and state plainly what makes it unique: LABCOM keeps project state in a
**database**, and turns judgement into **code**. Because of those two things the
orchestrator itself can be a **2B-class model**, run sheets can be set and left,
and work can be apportioned across cost tiers instead of all landing on the
expensive model.

The idea needs a name, and the page needs a sentence. Recommended sentence:
**"The model reports what it sees. The rules decide what happens."** Term, decided
and introduced after the claim rather than before it: **deterministic
orchestration**. See "Naming the thesis".

## Problem analysis

### The strongest claim is the third bullet of the fifth section

It is already on the page, in `MISSIONS`:

> **The state is LABCOM's, not the model's.** Progress lives on the board and in
> the plan files on your box, and a seat's context is cleared at each checkpoint
> — so nothing rests on one conversation staying coherent to the end. That is why
> a cheap, short-context model can carry long-horizon work: it only ever has to
> hold the task in front of it.

That is the product in four sentences, and a reader reaches it after the hero,
`HOW IT WORKS`, a second scene, a headline about walking away and two other
bullets. The page's own design note says it was *"written on the assumption that
nobody reads past the second image."* By that standard this claim is not on the
page.

### The hero argues a different, smaller product

The hero sells **always-on** and **small**: *"A coding team that never stops.
Running on one Raspberry Pi"*, 0.5 GB of RAM, move a card on your phone. All
true — and all about uptime and footprint, a machine that stays on.

Long-term orchestration is the larger claim: work that stays coherent across
weeks, restarts, context resets and model swaps, because no participant has to
remember it. A reader who sees only the hero learns the box never sleeps. They do
not learn the project cannot forget.

### The three claims, and what backs each

*(Stated as the chain above — each is load-bearing for the next, and none is
claimed as a first.)*

**1. The orchestrator can be a 2B-class model.**
This is the genuinely unique one, and it is not "we support small models" — it is
that the orchestrator *never makes the call*. `src/standalone/judgement/flags.ts`:

> **Tier 1 does not emit a diagnosis.** A small model's observations are
> reliable; its conclusions are not… So the model reports WHAT IT SAW —
> `no-write`, `card-implement`, `tail-quota-error` — and `deriveClass` turns
> observations into a class **mechanically, in code that can be read and tested**.

The vocabulary is closed, and *"a flag outside the set means THE RULE DID NOT
RUN"* — never a coerced nearest match. Verified live: `gemma4:e2b-it-qat`,
configured 2026-09-17, **1.1 s warm round trip, 26.7 tok/s decode**. Judgement
tiers are declared by *"ROLE AND COST, never by locality: any tier may be local
or remote"* (`judgement/tiers.ts`), so the claim stands wherever the model runs.

**2. Set-and-forget run sheets.**
Follows from 1. If the rules are code and the state is rows, execution is
deterministic and repeatable, so a long run sheet can be left to run without
being checked. The thing you would otherwise be checking for — a model quietly
losing the thread — is the failure mode this architecture removes rather than
mitigates.

**3. Routing apportions work across cost tiers.**
Complexity routing sends work to the seat that fits it: the lead takes complex
and risky work, a coder the routine half, an intern the cheapest. That is what
makes a free local model useful as a team member rather than a novelty — the
Coding team exists to *"save token costs through work splitting"*, with a local
model as the intern.

**All three rest on the same foundation:** rows in a database, rules in code.
That is the sentence the site is missing.

### The claim is a COMBINATION, not a first

**Operator position, 2026-09-20: the page does not claim to be unique.** It
claims a combination that a cloud vendor will not replicate. That is a stronger
footing than per-feature novelty, because every individual element can be matched
and the claim still stands — and it removes the fragility of a page that can be
falsified by one competitor shipping one feature.

**And the elements are a chain, not a list.** Each link makes the next possible:

> Decisions are **code**, not inference
> → so the orchestrator can be a **2B model**
> → so the whole thing fits on a **box you own**
> → so **nothing meters you**, and the models are ones you already pay for.

Written as a chain it argues itself. Written as four bullets it reads as a
feature list, which invites exactly the feature-by-feature comparison the page
should not be fighting.

**Why a cloud vendor does not follow.** The obstacle is commercial, not
technical. A platform whose economics rest on selling inference cannot lead with
"bring your own subscription, run a 2B local model, and never pay us per token" —
and an always-on appliance on your router is the opposite answer to "always on"
from a company whose answer is the cloud. They could build it. It would
cannibalise them.

**Say this without asserting anything about anyone's roadmap.** The page argues
its own architecture and economics; it does not predict what a competitor will or
will not do.

### Competitive context: Kiro Crew, read 2026-09-20

AWS ships **Kiro Crew** — *"an open source development workspace that remembers
your context, learns how you work, and coordinates across your unique tools"* —
local or remote over SSH, on Mac/Linux/Windows. Read before drafting, because it
retires two claims this page might otherwise lead with.

**What it already does, so we must not claim it as ours:**

- *"Checkpoints long-running work so tasks resume after restarts without
  re-prompting."* **"State survives a restart" is table stakes, not a
  differentiator.**
- Coordinates multiple agents in parallel, locally, open source.
- **Spec-driven development** — *"turn prompts into executable specs"* with
  *"requirements, architectural designs, and sequenced tasks"*. That is
  structurally our plan → feature → subtasks model. Do not present it as novel.
- It also has things we do not: property-based testing, and automated reasoning
  that finds contradictions in requirements.

**Where the difference is real, and these are the claims to lead with:**

1. **Who decides.** Kiro Crew dispatches on cron, webhooks, CI events, and
   *"parallel agent execution that can pick up actionable work independently"* —
   agents choose what to work on. Here the model reports observations from a
   closed vocabulary and `deriveClass` maps them to an action in code that can be
   read and tested. **This is the differentiator, and everything else follows
   from it.**
2. **What is stored.** Kiro Crew keeps *"a knowledge graph with vector embeddings
   and full-text search"* — memory, and explicitly RAG-shaped. We keep execution
   state: in flight, owner, round, queue, accepted. The contrast table below
   applies to Kiro more cleanly than to a vault.
3. **Bring your own models** — see the next section.
4. **The board is the control surface.** Kiro gives a dashboard and an Activity
   view streaming *"agent reasoning, tool calls, and approvals"*: you watch
   agents. Here you move a card and work starts. Instruction, not observation.
5. **Footprint.** 0.5 GB on a Pi on your router, against a desktop-class Electron
   app.

**Caveat for whoever drafts this:** two marketing pages, not hands-on use. State
the architectural contrast; do not assert what their product fails to do.

### Bring your own models, from your own subscriptions

Kiro presents a **model selector** — Claude Opus / Sonnet / Haiku, DeepSeek v3.2,
MiniMax M2.5, with an Auto mode — operated by AWS. You use their inference,
through their platform.

Here, a seat is a **terminal running a command you chose**. The operator's own
live board, 2026-09-20:

```
lead      "claude"
coder     "devin --permission-mode bypass"
planner   "devin --permission-mode bypass"
reviewer  "claude"
```

Those are arbitrary shell strings. Any agent CLI you can run, you can seat —
on the subscription you already pay for. There is no model list to be on, no
per-token resale, and no vendor between you and the model.

The same holds for the orchestrator: the `local` provider takes any
OpenAI-compatible endpoint, which is how `gemma4:e2b` runs the judgement tier
from a box on the tailnet.

**One honest asterisk.** `CliFamily` recognises `devin`, `claude` and
`antigravity` by name, and everything else is `unknown`. That affects **readiness
timing only** — an unrecognised CLI waits on the longest boot ceiling, because
guessing short breaks delivery. It does not restrict which CLIs run. Say "any
CLI runs"; do not say "every CLI is tuned".

### It is not RAG, and the copy must say so before the reader assumes it

**"The project lives in a database" is too weak a claim, and it invites the
wrong comparison.** Plenty of people already keep heavy context in Obsidian, a
vault, or a vector store. Storage is table stakes. Stated that way, a reader
files this under "another RAG setup" and stops.

The difference is what is stored and who acts on it:

| | a vault / RAG | LABCOM's board |
| :--- | :--- | :--- |
| holds | what the model should **know** | what is **happening** — in flight, owner, round, queue, accepted |
| the model | retrieves, then **decides** | reports what it **saw**; it does not conclude |
| the store | is **read** | **acts** — dispatches, stamps ownership, advances, releases |
| lifetime | the turn | survives restarts, context resets, swapping the model |

Retrieval makes the model's answer better informed. This removes the model from
the answer: `deriveClass` turns a closed vocabulary of observations into a class
*"mechanically, in code that can be read and tested"* — code the model never
sees.

**So the claim is about who decides, not about where things are kept:**

> **The model reports what it sees. The rules decide what happens.**

That is the architecture stated literally, and no vault does it.

### Naming the thesis

**DECIDED 2026-09-20 (operator): "deterministic orchestration."** It is the
operator's own word —
*"you can set and forget long term run sheets without checking because things
are deterministic so you can trust execution"* — it names the novel half
(decisions are code, not inference), it is the opposite of the failure everyone
fears from an agent pipeline, and it explains the cost claim without asserting
it: a 2B model suffices **because it is not the one deciding**.

**Scope it the first time it is used, or a careful reader will break it.** It is
not deterministic end to end — the seats are LLMs and the model's observations
vary. What is deterministic is the **orchestration layer**: routing, dispatch,
advancement, completion. If that qualification proves awkward in the copy, use
**deterministic dispatch**, which is narrower and fully true.

**The alternatives below are recorded as considered-and-rejected, not as open
options.** They are kept so the next editor does not re-propose one.

- **Stateful orchestration** — accurate, but it names the **storage** half, which
  is precisely the half that is table stakes. It invites "so what, everything is
  stateful", and it captures nothing of decisions-being-code. It is also
  ambiguous about which half is stateful: the model is stateless, the system is
  stateful.
- **Assisted orchestration** — "assisted" reads as *human*-assisted in this
  field (assisted driving, copilot), which is the opposite of a set-and-forget
  claim. It also describes help added **to** the orchestrator, when the payoff
  is the orchestrator doing less.
- **Augmented orchestration** — advertises **addition** when the selling point is
  **subtraction**: the orchestrator got small enough to be a 2B model.
  "Augmented" is also much-borrowed and arrives pre-blurred.
- **Grounded orchestration** — withdrawn. *Grounding* is itself a RAG term, so it
  actively invites the comparison the section above exists to pre-empt.

**Do not lead the hero with the term.** A coined word spends the attention the
claim needs, and this claim says itself in plain words. Hero gets the sentence;
the term is introduced once the reader already believes it.

### The line the copy must not cross

The small model is the **orchestrator** — the controller and its judgement tier.
It is **not** the coder. The coding seats stay whatever the operator points them
at, which the hero already says: *"a Claude lead, Gemini coders, a free local
model."*

Copy that implies a 2B model writes the code would be false, and would collapse
the first time a reader tried it. The claim is narrower and stronger than that:
the thing that **decides** can be tiny, because deciding has been made small.

### Measured, from the operator's own board, 2026-09-20

- **749** active plans, **2,559** archived, **2,678** recorded plan events
- The host was restarted twice in one working session; the board, its columns,
  its teams and their standing orders came back identical

Restart everything and the project is still there, because nothing that mattered
was ever in a model's head.

### One number on the page needs re-sourcing

`MISSIONS` says *"approaching 3,000 taken to done."* The live `COMPLETED` column
holds **32**, because completed cards archive immediately; the lifetime figure is
`plans_archive` at **2,559**. The claim is defensible — but the column a curious
reader would check is not the one that supports it.

## Metadata

**Complexity:** 3
**Tags:** website, positioning, copy, astro
**Project:** Website
**Scope:** `switchboard-site/src/pages/index.astro`, plus one docs page. Content
and information architecture — no product code changes.

## Constraints

**Site naming.** The product is **LABCOM**, the CLI is **`lc`**. No "Switchboard"
in site copy.

**Claim the uniqueness directly.** This is a positive claim about what LABCOM
can do that others cannot, not a swipe — so it is argued by describing our own
architecture in specifics (observations versus conclusions, rows versus context,
tiers by cost), not by characterising other products. Stated precisely enough,
the contrast needs no help.

**Do not site the model on the Pi 400.** A 2B model as orchestrator is true and
shipping; hosting it *on a Pi 400 specifically* is not — that silicon lacks the
ISA the LiteRT build needs, and the ollama build is 4.3 GB against 3.7 GB of RAM.
Copy should say the orchestrator is small enough to be a 2B model and leave where
it runs to the docs, since the hero's own hardware is a Pi 400.

**Name the orchestrator, not the coder.** Every use of the term and every
cost claim refers to the controller and its judgement tier. No copy may imply a
2B model writes the code — the coding seats are whatever the operator configures.

**Every claim traceable.** The page holds itself to this already — a source
comment records that a beat *"does NOT claim tmux"* because `bootstrap.ts:3999`
says otherwise. New copy meets the same bar: each claim names the behaviour, file
or table backing it, in a source comment.

**No number without a source.** See the `COMPLETED` / `plans_archive` split.

**Respect the page's structure.** A scene is a kicker, a short headline and two
to four scannable beats, art first. Add a scene; do not invent a format.

## Proposed changes

### 1. The hero names the durable claim

One line in the hero's existing voice: the project's state lives on your box, not
in a conversation. It belongs with the tagline, not the spec line — the spec line
is about hardware and this is not a hardware claim. Existing always-on and
footprint claims stay; this is added above them, not traded for them.

### 2. A dedicated scene, placed third at the latest

A new scene — working title **LONG-HAUL** — immediately after `HOW IT WORKS`.
Three beats, one per unique claim:

- **The rules decide; the model reports.** Cards, plans, features, rounds and
  ownership are rows on your box, and the code that turns an observation into an
  action is readable and testable. Nothing waits on a model to choose what
  happens next. *(Do not lead on "survives a restart" — Kiro Crew checkpoints
  too.)*
- **The orchestrator is a 2B model, because it never decides alone.** It reports
  what it saw from a fixed list of observations; the rules that turn those into
  actions are code you can read and test. An unrecognised answer means the rule
  did not run — it is never rounded to the nearest guess. That is why a run sheet
  can be left running without being watched, and why the model driving it does
  not have to be an expensive one.
- **Every model in it is one you brought.** A seat is a terminal running your
  CLI on your subscription — `claude`, `devin`, a free local model — and routing
  sends complex work to the lead and the routine half to a cheaper seat. No model
  list, no per-token resale, no vendor in between.

### 3. `MISSIONS` stops carrying the argument alone

With the claim promoted, the `MISSIONS` beat doing this work is rewritten to what
that section is actually about — handing out one task at a time in declared order
— and points at the new scene rather than restating it.

### 4. Re-source the number

Replace *"approaching 3,000 taken to done"* with a figure whose origin is named
in a source comment (`plans_archive`, and the date read), so the next editor
updates it from the right place instead of guessing upward.

### 5. One docs page for the mechanism

For the reader who believes the claim and wants to know how: what is stored,
what survives a restart, what happens to a seat's context at a checkpoint, the
observation vocabulary, and **where a small orchestrator model can run** —
including the Pi 5 and tailnet options the homepage deliberately does not get
into. Linked from the new scene.

## Verification plan

### Automated

- The site builds (`npm run build` in `switchboard-site`) and the new scene
  renders.
- The new scene appears before `Composed by you` in `index.astro` source order.
- No "Switchboard" or `switchboard` in added copy.
- Every number in added copy carries a source comment naming where and when it
  was read.
- Existing hero claims (always-on, RAM figure, Pi) are still present — promotion
  must not silently drop them.
- **No copy states or implies that the orchestrator model runs on the Pi 400.**
- **No copy states or implies that a 2B model writes code.** Every small-model
  claim is scoped to the orchestrator and its judgement tier.
- The chosen term is defined the first time it is used and does not appear in
  the hero ahead of the plain claim.
- Where the copy says "deterministic", it scopes the word to the orchestration
  layer — no sentence claims the seats or their output are deterministic.
- The page distinguishes execution state from retrieved knowledge, so a reader
  cannot file it as RAG.

### Goal invariants

- A reader who stops after the second image knows the project's state is durable
  and independent of any model.
- The uniqueness is claimed in specifics about LABCOM, with no characterisation
  of other products.
- Every factual claim can be checked by someone who has it installed.

### Manual

Read the page on a phone, stop after the second image, and confirm the
long-horizon claim has landed. That is the page's own stated test and the one
that matters here.

## Outstanding questions

- **How much of the Kiro contrast goes on the page?** The architectural
  difference is worth stating; naming a competitor is a decision the operator has
  not made. The copy can carry the contrast without the name.

- ~~Which term ships?~~ **Answered: "deterministic orchestration."** One thing
  left for the drafter, not a decision: if scoping the word inside the sentence
  proves awkward, fall back to **deterministic dispatch**, which is narrower and
  needs no qualification. Either way the word must not be left claiming the
  seats are deterministic.

- **Does the hero line replace or join the tagline?** *"A coding team that never
  stops"* and *"the project can't forget"* are adjacent claims; stacking both may
  dilute each. Draft both ways before choosing.
- **Does the 2B-model beat name the model?** Naming `gemma4:e2b` is concrete and
  checkable, but dates the copy and invites "only that one?". A class ("a 2B
  model") is durable and vaguer. Decide before drafting.
- **Art for the new scene, or text-only first?** Every other scene carries an
  image; a text-only scene will read as unfinished beside them.
