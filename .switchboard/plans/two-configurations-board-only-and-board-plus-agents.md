# Two Configurations: Board Only, and Board Plus Agents

## Goal

State — in the docs, the site and the setup flow — that LABCOM has **two** deployment shapes with
different requirements, and make the smaller one actually work:

- **Board only** — the board, the API and the pty host on a small box; agents run on other machines.
  **1 GB is enough.**
- **Board plus local agents** — everything on one box. **2 GB minimum, 4 GB comfortable.**

The site currently advertises only the second, so the cheapest useful configuration is invisible.

### Problem analysis

**The board alone is small.** Measured on a Pi 400 with zero seats: **182 MB** RSS settled. Pi OS Lite
headless is ~100-150 MB. An ssh client per remote seat is a few MB. 1 GB is comfortable.

**And running agents elsewhere needs no new code.** A seat's startup command is a plain shell string
executed in a pty — today `agy --dangerously-skip-permissions`. Make it
`ssh desktop 'agy --dangerously-skip-permissions'` and the pty is local while the agent runs on the
other machine. The Pi holds ~5 MB for the client instead of ~250 MB for the agent.

**What actually has to change is small.** The earlier framing here — "the working tree must be where
the agent is", a shared mount versus drifting clones — was wrong. Both machines clone the same repo;
the agent works its own copy and git is the sync, which it already is (`feat(board): bidirectional
git-carried shared board snapshot`). Two concrete gaps:

1. **The plan path handed over is absolute.** `GET /kanban/board` returns `planFile` as
   `/home/patrick/switchboard/.switchboard/plans/…` even though the database stores it relative, so a
   lead filling the `Implement the plan at <path>` template (`KanbanProvider.ts:5877`, `:5951`) passes
   a board-host path that need not exist on the agent's machine. Hand over the **repo-relative** path
   and say it is relative to the agent's repo root. That is the whole fix.
2. **The plan must be committed and pushed before a remote dispatch.** Otherwise the path resolves to
   nothing in the agent's clone. This is a real constraint, not a theoretical one: **4 plan files are
   uncommitted on this box right now**, and commit `23244777` is literally titled *"board: commit
   three plan files that existed only on the Pi"*. A remote dispatch of an uncommitted plan fails, and
   it fails as "file not found" inside the agent rather than as a dispatch error.

**Completion already travels fine.** It is an HTTP call — `switchboard done --from <seat>` — which
`teamWiring.ts:456` describes as *"the explicit completion signal that replaces the unreliable
mtime-"* signal. The older mechanism, *"first plan-file mtime advance after dispatch"* (bundled
contracts skill, contract #2), is filesystem-local and will not fire for a remote agent — so the
activity light goes quiet even though completion is reported. Cosmetic, but it should be known rather
than discovered.

**Heap drift still eats a 1 GB margin.** The host grew **182 MB → 271 MB with no seats** over about an
hour (see `the-host-accumulates-heap-and-inotify-watches-over-a-days-use`). On 4 GB that is noise; on
1 GB it is a tenth of the machine, so that plan is a prerequisite for advertising 1 GB.

**On transport: SSH is not a LABCOM requirement, it is the only sane option.** What a seat needs is a
pty it can write to and read from. tmux sockets are unix-domain only — `-L name` or `-S path`
(`tmuxBackend.ts:74`) — so they cannot cross a machine boundary. A plain TCP pty service would be an
unauthenticated remote shell on the LAN. `mosh` is the better choice than raw `ssh` for a long-lived
seat because it survives a network drop instead of killing the session and the seat with it; both are
installed here. Being on the same LAN changes nothing — you still need authentication and a pty
multiplexer, and that is ssh.

## Metadata

**Complexity:** 3
**Tags:** docs, infrastructure, ux, site
**Dependencies:** `the-host-accumulates-heap-and-inotify-watches-over-a-days-use` must land before
1 GB is advertised.

## User Review Required

None.

## Proposed Changes

### 1. Set an explicit V8 heap ceiling on small hosts

- **Logic:** node sizes its old-space against the machine. On a 1 GB box that default can exceed what
  is actually available, and the failure is an OOM rather than a GC. Pass `--max-old-space-size`
  derived from `MemAvailable` at launch, and say so in the docs.

### 2. Hand over a repo-relative plan path

- **Logic:** the dispatch path and `GET /kanban/board` should give a repo-relative `planFile`, and the
  lead's template should state it is relative to the agent's repo root. Absolute board-host paths are
  the only thing that makes a remote seat fail today.
- **Guard:** refuse — or warn on — a remote dispatch whose plan file is uncommitted, since the agent's
  clone cannot have it. Failing at dispatch is far better than failing inside the agent.

### 3. Document the remote-seat recipe

- One worked example: a startup command of the `ssh`/`mosh` form, the commit-before-dispatch rule, and
  the callback path (the remote agent must reach the board's API; on a tailnet it already can).
- Belongs in `docs/REMOTE_ACCESS.md`.

### 4. Say both configurations on the site

- `SYSTEM REQUIREMENTS` currently reads *"Minimum: A 2 GB Raspberry Pi 4"*. Two lines instead:
  board-only at 1 GB, board-plus-agents at 2 GB with 4 GB recommended.

## Verification Plan

- A board-only host on a 1 GB box serves the board, dispatches to a remote seat, and receives its
  completion callback.
- With `--max-old-space-size` set, a long-running board-only host stays inside the 1 GB box.
- The site names both configurations.

## Outstanding Questions

- Should a remote dispatch be blocked outright when the plan file is uncommitted, or only warned? A
  block is honest but stops work on a box where plans are routinely written and dispatched in the same
  breath — which is how this board is actually used.
