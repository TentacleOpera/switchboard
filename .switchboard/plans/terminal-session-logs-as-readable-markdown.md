# Terminal session logs as readable markdown documents

## Goal

Persist each terminal session as a markdown document and let a button in the terminal frame open it full-screen in the existing docs viewer, with a sidebar for browsing other sessions' logs — so terminal history stops being bounded by a replay buffer sized for something else.

### Problem Analysis

**One undersized buffer is doing two incompatible jobs.** `MAX_SCROLLBACK_BYTES = 256 * 1024` (`terminalWsGateway.ts:5`) is a per-terminal in-memory ring, replayed when a client attaches. As an attach mechanism the small size is correct: opening a multi-pane grid replays every pane at once, so the cap is really a bound on attach cost — most acute over the tunnelled link the remote setup depends on. As a *history* mechanism it is far too small, and raising it makes the attach burst worse. The two goals pull in opposite directions, which is why the current value satisfies neither.

**And the ring is lossy by design in ways already worked around.** The DEC private-mode tracking exists precisely because *"the ring cannot be relied on to carry the last transition: it evicts at MAX_SCROLLBACK_BYTES, so an enable can outlive its own reset inside the replay."* Mouse-mode state had to be tracked separately to survive a reattach the ring could not cover. That is a buffer being asked for durability it cannot provide.

**History is also destroyed on the normal path.** `queue/done` clears a member's terminal by design (`teamWiring.ts:318`), so on the ordinary completion route the record of how the work went is gone. Nothing writes it anywhere first.

**Nothing logs pty output to disk today.** A grep for `appendFile` / `createWriteStream` across the standalone host finds a rotation-aware line logger in `cli.ts:213` — *"reopened on every line via `appendFileSync`, so rotation never loses the…"* — but nothing tees terminal output.

**The volume problem is real and is not solved by existing coalescing.** `OUTPUT_FLUSH_MS = 6` joins node-pty's many tiny reads into one frame, which the comment is explicit about: *"One flush per window collapses that into a single frame, a single scrollback entry, and a single backpressure check."* That is a rendering optimisation. It does **not** collapse redraws — a spinner rewriting one line still emits every version — so a naive tee produces megabytes representing a few dozen useful lines.

**Both halves of the presentation already exist.** `renderMarkdown` is a shared renderer (`sharedUtils.js:122`) with its own contract test, and `tickets.html` implements the sidebar-list-plus-detail layout — `#tree-pane` inside a `.content-row` with a `.sidebar-toggle-row` and a `collapsed` state (`:364-366`) — the same pattern the Mission Control panel spec reuses rather than reinventing. And the mission-control spec already specifies this exact interaction for schedules: a **Logs** control that *"switches the content view to the log markdown file, with a link to it."*

### Root Cause

Terminal output was treated as a stream to render, never as a record to keep. Everything downstream therefore reads from the only place it exists — an in-memory ring whose size is set by rendering concerns — and every durability need since (mode state, completion evidence, "what did that agent actually do") has been met by working around the ring rather than by writing the stream down.

## Metadata

**Complexity:** 5
**Tags:** feature, frontend, backend, devops

## Settled Design

- **Markdown on disk, one document per terminal session**, under `.switchboard/logs/`.
- **ANSI is stripped.** A markdown document rendered by the docs viewer cannot carry escape sequences, so colour and TUI structure are deliberately lost here. The live terminal remains the place for those; the log is for reading.
- **Carriage-return redraws are collapsed at write time** — only the final state of a rewritten line is kept. Mandatory rather than optional: a document made of spinner frames is unreadable, and the bloat is almost entirely here.
- **Dispatch boundaries become headings.** The delivery layer knows when it injects a prompt, so each delivery opens a `##` section. That turns a session from an undifferentiated stream into a navigable document with an outline.
- **The ring buffer is left alone.** It keeps its job and its size; this plan removes the pressure to grow it.
- **Retention is deferred** to `retention-and-archive-for-unbounded-growth.md`; the writer rotates, the policy lives there.

## Complexity Audit

### Routine

- Teeing pty output to a rotating per-terminal file, following the `cli.ts:213` append-and-reopen pattern.
- A button in the terminal frame that opens the log view.
- Reusing `renderMarkdown` and the `.content-row` / `#tree-pane` sidebar layout.

### Complex / Risky

- **Agent output contains code fences, and they will break the document.** Coding agents print ```` ``` ```` constantly, so wrapping raw output in a fenced block is broken by construction on roughly the first interesting line. Use a longer fence than anything in the payload, or escape at write time. This is the single most likely defect and it will look like "the log renders fine until it doesn't".
- **Chunk boundaries must not split a character.** The gateway already holds this discipline for frames — `MAX_FLUSH_BYTES`, *"Whole chunks only — never split one — so a surrogate pair can't be cut across two separately-UTF-8-encoded payloads"* — and the log writer needs the same rule, plus a carry for a partial CR-collapse run across a flush.
- **`renderMarkdown` on a large document will choke the viewer.** Serve tail-first with ranged reads and paginate; do not hand the renderer a multi-megabyte string. This is the same attach-burst mistake one layer up, and the reason for the cap this plan exists to route around.
- **A durable on-disk log is a new place secrets land.** Agent terminals echo tokens, env and paths. `.gitignore:52` is `.switchboard/*` with explicit `!` negations for `reviews/`, `plans/`, `features/`, `sessions/` and two files — so `.switchboard/logs/` is ignored **by default** and needs no gitignore change. The hazard is the opposite direction: nobody may add a negation for it, and the route serving it must sit behind the same auth as everything else. State both, because "we didn't have to touch .gitignore" reads like the question was never asked.
- **Stripping ANSI is a real loss, so do not oversell the log as a terminal replacement.** A TUI-heavy session renders as a mess of positioning artefacts even with CR-collapse. The log answers "what happened"; the terminal answers "what does it look like now".
- **Session boundaries need defining.** `queue/done` clears a terminal but the process lives on — so is that one session or two? A cleared terminal starting fresh work is a new session to a reader, and rolling the file there is what makes the document match what the user thinks they are reading.

## Edge-Case & Dependency Audit

**Migration.** None. New files in an already-ignored directory; nothing existing changes shape. Sessions before this ships simply have no log.

**Security.** A new durable record of terminal output. Ignored by git by default, served only through the authenticated route, and never negated in `.gitignore`. Worth an explicit test on the auth gate rather than assuming the route inherits it.

**Side effects.** Disk growth per terminal per session, bounded by rotation. Write cost is one append per flush window, on a path that already coalesces at 6 ms — so the write rate is the flush rate, not the node-pty read rate.

**Ordering.** Independent. It reduces the pressure to raise `MAX_SCROLLBACK_BYTES`, so it should land before anyone tunes that constant.

## Dependencies

- **Reuses** `renderMarkdown` (`sharedUtils.js:122`) and the `tickets.html` sidebar-list-plus-detail layout.
- **Retention deferred to** `retention-and-archive-for-unbounded-growth.md`.
- **Aligns with** `mission-control-panel-ui-specification.md`, whose schedules tab already specifies a Logs control that switches the content view to a log markdown file — the same interaction, so the two should look alike.
- **Helps** `completion-is-asserted-never-inferred.md`: a halt reason recorded on the state can point at a log that still exists after the terminal is cleared.

## Adversarial Synthesis

**"Just raise `MAX_SCROLLBACK_BYTES`."** That grows the attach burst linearly, times every pane in the grid, over the tunnel where it hurts most — and it still loses everything on a pty host restart and on the deliberate `queue/done` clear. It buys more of the wrong thing.

**"Keep raw ANSI so the log can be replayed in a terminal."** Then it is not a document and cannot use the docs viewer, which is the whole point of the request. Fidelity and readability genuinely conflict here; readability wins because the live terminal already serves fidelity.

**"Write plain text, not markdown."** Markdown costs nothing extra — the renderer and the viewer already exist — and buys headings, which is what makes a long session navigable rather than merely present.

**"Agents can already be asked what they did."** Asking an agent is asking for a summary of its own work, which is the thing least likely to mention what went wrong. A log is evidence, and the same "assert, don't infer" argument that applies to completion applies to what an agent actually ran.

## Proposed Changes

1. **Tee pty output to a per-terminal markdown file** under `.switchboard/logs/`, written on the existing flush window.
2. **Collapse carriage-return redraws and strip ANSI at write time**, carrying partial runs across flush boundaries.
3. **Fence safely** — longer-than-payload fences or write-time escaping — so agent-printed code blocks cannot break the document.
4. **Open a `##` section on each prompt delivery**, so the document has an outline.
5. **Rotate on size and on session boundary**, leaving the policy to the retention plan.
6. **Add a ranged tail endpoint** behind the existing auth.
7. **Add a log button to the terminal frame** that opens the full-screen view for that terminal.
8. **Reuse the docs viewer and the sidebar-list layout** for reading and for browsing other sessions.
9. **Leave `MAX_SCROLLBACK_BYTES` unchanged.**

### Migration

None.

## Verification Plan

### Goal Invariants

- Every terminal session has a readable log covering more than the ring holds.
- A log never breaks its own markdown rendering.
- No log is reachable without auth, and none is ever committed.
- The live attach path is unchanged.

### Automated Tests

- **History outlives the ring:** emit more than 256 KB, then assert the log contains output the replay buffer has evicted. This is the whole point and it fails today.
- **History outlives the clear:** run `queue/done`, then assert the log still holds the cleared session. The deliberate clear is the most common way history is lost.
- **Agent code fences do not break the document:** write output containing ```` ``` ```` and assert the rendered result is intact. This is the likeliest defect, so it needs the test that would catch it on line one.
- **Redraws collapse:** emit a spinner sequence and assert one final line, not N frames — and assert the byte size is a small fraction of the raw stream.
- **No split characters:** emit multi-byte characters straddling a flush boundary and assert the log is valid UTF-8, mirroring the frame-level guarantee.
- **Large logs are served ranged:** assert a tail request does not read or return the whole file.
- **Auth is enforced:** request a log unauthenticated and assert refusal.
- **Never committed:** assert `.switchboard/logs/` is ignored, and that no `!` negation for it exists — a test on the ignore result alone would pass the day someone adds one.
- **Attach is unchanged:** assert replay behaviour and `MAX_SCROLLBACK_BYTES` are untouched.

### Manual Verification

- Run a long agent session, clear the terminal, then open the log and confirm the whole session reads as a document with per-dispatch headings.
- Open the sidebar and confirm other terminals' sessions are browsable.

## Outstanding Questions

None.
