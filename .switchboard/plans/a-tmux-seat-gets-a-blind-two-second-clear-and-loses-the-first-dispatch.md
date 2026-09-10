# Every Prompt to a Team Seat Is Delivered to the Previous Generation's Agent

> **CORRECTION 2026-09-10, second rewrite.** This card was twice about delivery *timing* — first
> `tmuxPromptDelivery`'s blind clear settle (wrong path: the seats are pty seats), then the readiness
> floor and CR coalescing (wrong: the lead does not clear before a review request). Both were
> inference. The mechanism below was **observed**: the prompt was captured landing in the wrong pane.
> Timing is not involved.

## Goal

A prompt written to a seat's pty must reach that seat's own tmux window. Today the seating chain
blocks partway through, `select-window` never runs, and every prompt is forwarded to a window left
over from a previous host generation.

### Problem analysis

**Reported as:** *"the team lead's review round dispatch often fails on the first dispatch sent to a
team terminal, then the second succeeds."*

**Observed directly.** With a read-only `tmux capture-pane` watcher on all four live panes, the
operator had the lead send a review request to `Coding-intern`. Result:

- `Coding-intern`'s **live** pane `%57` — unchanged. Fresh Antigravity banner, empty `>` prompt.
- The **orphaned** pane `%52` — has the prompt, mid-turn:

```
  reply>","clearBeforePrompt":false,"origin":"Coding-intern"}
  confirming you received it. Nothing else is required.
  === STANDING ORDERS ===
  - Coding is your head agent. When you finish a task, report to it — POST …
  ⣟  Working...
```

- `promptCount` for the live seat went 0 → 1 and the API reported success.

**Two generations of windows share one name each.** `tmux list-windows -t lc-coding-team`:

```
0: Coding          pane=%46 pid=419356   <- previous generation
1: Coding-coder-1  pane=%48 pid=419582
2: Coding-coder-2  pane=%50 pid=419814
3: Coding-intern   pane=%52 pid=420000
4: Coding          pane=%54 pid=421448   <- current host's seats
5: Coding-coder-1  pane=%55 pid=421701
6: Coding-coder-2  pane=%56 pid=422336
7: Coding-intern   pane=%57 pid=422518
```

This reads as one team because the five sessions are a **group** and share one window list — which
is why the duplication is invisible from `tmux ls`.

**Every view session is pointed at the old generation:**

```
lc-coding-team          -> 0:Coding          %46
lc-coding-team-coder-1  -> 1:Coding-coder-1  %48
lc-coding-team-coder-2  -> 2:Coding-coder-2  %50
lc-coding-team-intern   -> 3:Coding-intern   %52
lc-coding-team-lead     -> 0:Coding          %46
```

**Root cause: the seating chain blocks on its second command and never reaches `select-window`.**
`goPtyFleetProjection.ts:257-272` builds:

```
tmux has-session -t <session> && tmux new-window -d -t <session> -n <win> <inner> || tmux new-session -d -s <session> -n <win> <inner>;
tmux new-session -A -d -t <session> -s <view> 2>/dev/null;     <-- BLOCKS HERE, FOREVER
tmux set-option -t <view> status off 2>/dev/null;
tmux select-window -t <view>:<win>;
tmux set-window-option -t <view>:<win> aggressive-resize on;
exec tmux attach -t <view>
```

The view session already exists, so under `-A` `new-session` behaves like `attach-session` — and
`-d` is not attach-session's detach flag (`-D` is). So it **attaches** and never returns. Proven on
the live host:

```
/proc/422519  state S+  etime 14762s (4.1 h)  wchan poll_schedule_timeout  fd 0,1 -> /dev/pts/14

tmux list-clients:
  client=/dev/pts/14  session=lc-coding-team-intern  pid=422519
```

It is a registered, attached tmux client. Four hours in `poll`. The seat's bash never exec'd
`tmux attach`; `/proc/421811/cmdline` is still `/bin/bash -l`.

**Note on reproducing it:** the same command run outside a pty *returns* — tmux cannot attach
without a tty and falls through. It only blocks inside a real pty. An isolated shell test therefore
shows the command as harmless, which is presumably how it shipped.

**So the consequences cascade from one hung command:**

1. `select-window` never runs → the client keeps the session's pre-existing current window, which is
   the previous generation's.
2. The seat's pty **is** that client's tty, so every byte written to the seat is forwarded by tmux
   to the old generation's agent.
3. The window this host created (index 4–7) is never selected and sits idle forever.
4. `set-option status off` never runs either — the status-line change committed earlier today
   (`0a8e1f13`) is dead code for the same reason, sitting one line below the block.

**And `select-window` would still be wrong once it runs.** It targets `<view>:<win>` — a window
**name**, with two windows carrying it. Name resolution picks the lower index, i.e. the older
window. Fixing the block alone leaves the misrouting.

**Why "first fails, second succeeds".** The old-generation agents are alive and hold standing
orders telling them to report to a seat *named* `Coding` — which resolves to a live name. So the
orphan does the work and answers out of band, late. The lead sees the first attempt produce nothing
on time, retries, and the second attempt appears to work. Every seat is affected, not just the
intern:

```
Coding    live %54:  9 lines, idle  |  orphan %46: 39 lines, BUSY
coder-1   live %55:  9 lines, idle  |  orphan %48: 45 lines, BUSY
coder-2   live %56:  9 lines, idle  |  orphan %50: 26 lines, idle
intern    live %57:  9 lines, idle  |  orphan %52: 36 lines, BUSY
```

Three orphaned agents are mid-turn in the repo, driven by a board that believes it is driving four
other seats.

**Delivery receipts cannot detect this.** `promptCount` increments after the confirm CR
(`ptyPromptDelivery.ts:361`) and `bytesWritten` is `Buffer.byteLength(text)` (`:366`) — the length
of the attempt. Neither knows which window tmux handed the bytes to. The standing orders tell leads
*"bytesWritten is what was written to it"*, which is not what that number means.

## Metadata

**Complexity:** 3
**Tags:** bugfix, tmux, prompt-delivery, teams, seating, misrouting
**Dependencies:** shares its cause with
`tmux-windows-duplicate-on-re-seat-and-nothing-reaps-orphaned-sessions.md` — that card describes the
duplicate windows; this one shows they misroute prompts, which makes it a correctness bug rather
than untidiness. Fix together.

## User Review Required

**One decision, and it is time-sensitive:** three orphaned agents are mid-turn holding the real work,
while the seats the board addresses are empty. Repointing the view sessions at the new windows sends
future prompts to fresh agents with no context; leaving it keeps feeding the orphans. Neither is
obviously right and it is not a decision to take on the operator's behalf.

## Proposed Changes

### 1. Do not block the chain

- Replace `tmux new-session -A -d -t <session> -s <view>` with a form that cannot attach. Either
  `-A -D`, or drop `-A` entirely: `tmux has-session -t <view> || tmux new-session -d -t <session> -s <view>`.
- Prefer the explicit `has-session` form. It states the intent — ensure the view exists, attach
  nothing — rather than relying on which of `-d`/`-D` wins under `-A`, which is exactly the subtlety
  that caused this.
- **Verify inside a pty**, not in a plain shell. The bug is invisible outside one.

### 2. Select the window by id, not by name

- Capture the window id when it is created (`new-window -P -F '#{window_id}'`) and use that for
  `select-window`, `set-window-option`, and any later targeting.
- A name is not unique across generations, and this failure is what that costs. An id is stable and
  unambiguous.

### 3. Fail the seat if the chain does not complete

- A seat whose `select-window` never ran is not a seat — it is a client pointed at someone else's
  window. Have the chain end in a state the host can verify (window id matches the seat's own), and
  mark the seat unhealthy when it does not.
- Today nothing notices for four hours.

### 4. Make delivery verifiable

- After a send, confirm the target window is the seat's own window id — one `display-message -p`
  format query, no polling. A delivery to the wrong window must not return `success: true`.
- This is the check that would have caught the whole class immediately, and the one whose absence
  let `bytesWritten` stand in for evidence it never had.

### 5. Reap the previous generation on re-seat

- Belongs with `tmux-windows-duplicate-on-re-seat-and-nothing-reaps-orphaned-sessions.md`. Note here
  only that orphaned agents keep their standing orders and go on reporting to seats by name, so they
  are not inert — they actively confuse the lead.

## Verification Plan

- After a re-seat, `tmux list-windows -t <session>` shows one window per seat, no duplicate names.
- Each view session's current window is its own seat's window id — assert with
  `display-message -p '#{window_id}'`, not by name.
- No seat process is left in `S+` on `tmux new-session`; each seat's own cmdline is `tmux attach`
  after the `exec`.
- `tmux set-option status off` has actually applied to the view session (it is downstream of the
  block today and never ran).
- The operator's test, repeated: a review request to `Coding-intern` appears in `%57`, the live pane,
  and nowhere else.
- A delivery whose target window is not the seat's own returns a failure.

## Outstanding Questions

- `tmux list-clients` shows **more** clients than seats — extra clients on `lc-coding-team`,
  `-coder-1`, `-intern` and `-lead` (pids 433486, 447440, 447601, 455777, 466901). Whether those are
  operator attachments or leaked clients from earlier seatings is unresolved. They do not misroute
  (clients on one session share its current window) but they suggest the same chain is leaving
  clients behind on every run.
