# Nothing Asserts That the Go PTY Host and the Webview Agree on a Wire Format

## Goal

A contract test that starts the real Go PTY host binary, drives one real frame of every kind the webview sends and expects, and fails when the two disagree. Four such disagreements shipped together and every gate stayed green.

### Problem analysis

**Four wire mismatches shipped in one commit and none was caught by anything.** `e26ac375` moved the terminal fleet out of the TypeScript `terminalWsGateway` into the Go PTY host. It reimplemented the host's **verbs** and did not carry over the **contract around them**. Found on 2026-09-07, in this order, each hidden behind the last:

| # | Fault | Symptom |
| :-- | :--- | :--- |
| 1 | `CheckOrigin` allowlisted loopback only | Every remote browser got 403. curl sends no `Origin`, so every terminal-based test passed. |
| 2 | Board served no `/ws/terminal` | The page's `location.host` fallback hit a path nothing answered — panes stuck on "connecting". |
| 3 | Output framed as `{t:'replay'\|'output', data:<raw>}` | The webview accepts binary, or `{t:'out', data:<base64>}`. Every byte was parsed, matched no branch, dropped. **Live socket, black pane.** |
| 4 | Input read with `ReadJSON` | The webview sends keystrokes as binary `0x01`+UTF-8. `ReadJSON` failed and the handler `return`ed, **closing the socket on the first keypress**. |

A fifth, from the same root, is filed separately as `198dba7a`: the `terminalsChanged` broadcast ceased to exist, leaving the UI on a 5-second poll.

**Every existing gate passed throughout.** `npx tsc --noEmit` was clean — the two sides share no types, because one is Go. `go build` was clean — the Go host is internally consistent. `test:contract:pty-route-surface` passed — it greps *source text* for route names and injected attributes, and never opens a socket. The webview's own contract tests read `terminals.js` as a string. Nothing in the repository has ever started the binary and spoken to it.

**The failure is structural, not careless.** Every one of these four is a place where two implementations must agree on a byte layout, and the only thing recording that agreement was a comment. `terminals.js:11272` documents the binary output frame and cites `encodeOutputFrame in terminalWsGateway.ts` — a TypeScript function in a file nothing constructs any more. The Go author had no way to discover the contract except by reading a comment pointing at retired code.

**And the cost was not the bugs — it was the diagnosis.** Each fault masked the next, so fixing one revealed another, four times. The whole path — page, hub, upgrade, token, origin, framing — verified green from the serving machine at every step, because the tests available were `curl` and a raw socket, and neither sends what a browser sends. It was found by taking a screenshot and looking at a black rectangle.

**This will recur.** The launcher is the third subtask of *Go Where It Pays* (`f924f75c`) and is not yet shipped; the static client verbs are. Each is another boundary where a Go implementation must match a JS expectation with nothing but prose in between.

## Metadata

- **Complexity:** 5
- **Tags:** testing, terminals, standalone, go, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. A black-box contract test that runs the real binary

Start `dist/<target>/switchboard-pty-host` as a child process, create a terminal over its HTTP API, open a real WebSocket, and exercise the wire. **The real binary, not a mock** — a mock encodes the assumption under test and would have passed on all four faults.

Note there is already a `test:contract:pty-host-blackbox` script. Establish what it covers before adding a second: if it exists and did not catch these, the gap is in what it asserts, and extending it beats a parallel suite.

### 2. Assert each frame shape that actually crossed the wire

One assertion per fault, written so the fault reproduces if reintroduced:

- **Output is a binary frame**: 4-byte big-endian seq, then UTF-8. Decode it and compare to what was written to the PTY. Fault 3 shipped a JSON frame that the client silently discarded, so asserting "output arrives" is not enough — assert its *encoding*.
- **`hello` carries `replayChars`**: the client arms answerback suppression only on that field, and without it xterm answers OSC queries buried in scrollback, typing `10;rgb:...` into the pty. Assert the field exists and matches the replay's UTF-16 length.
- **The replay is ONE frame** following `hello`, per the client's contract that "the next binary frame is the replay".
- **Input is accepted as binary** `0x01`+UTF-8, and the PTY echoes it. Then assert the socket is **still open** — fault 4's real damage was the disconnect, not the ignored keystroke.
- **A malformed frame does not close the session.** The old handler `return`ed on any parse error.

### 3. Assert the origin rule from both sides

`Origin: http://<tailnet-ip>:<port>` with a matching `Host` upgrades; a foreign origin is refused; a missing origin is accepted. **A test that omits the header tests nothing** — that omission is precisely why fault 1 survived, and the test must send what a browser sends.

### 4. Assert the board proxies `/ws/terminal` on its own origin

The fleet lives on a loopback-only child. If the board stops proxying, terminals become unreachable from every machine except the server, which is the entire remote product. Assert an upgrade succeeds against the **board's** port, not the child's.

### 5. Give the contract one home, named in both languages

The frame layouts are currently described in a comment in `terminals.js` citing a retired TypeScript file. Write them down once — the four shapes, their fields, their encodings — and reference that document from `terminals.js`, `terminalWsGateway.ts` and `cmd/switchboard-pty-host/ws.go`, so the next port has something to implement against.

## Edge-Case & Dependency Audit

1. **The binary must exist to test.** `npm run compile` does **not** build Go; `scripts/build-pty-host.sh` does, and needs a Go toolchain. The test must skip loudly with a stated reason when the binary is absent — never pass silently, which is a green gate over an untested contract.
2. **`test:contract:*` is what actually gates CI.** `npm test` (the vscode-test suite) is not CI-wired, so a test placed there runs never. Register this as a `test:contract:` script.
3. **Port allocation.** The host picks an ephemeral port and reports it on the ready handshake. Parse it; do not assume.
4. **Kill the child on every exit path**, including assertion failure, or a failing run leaves an orphaned PTY host holding the workspace.
5. **The extension host is not covered by this.** It uses the same Go child now, so the test protects both — but assert that assumption rather than inheriting it.
6. **Do not assert on Devin's or Claude's output.** The test spawns a shell and echoes a known string; asserting on a vendor CLI's banner makes the suite fail when a vendor changes their splash screen.

## Verification Plan

1. Reverting any one of the four faults makes the suite red, with a message naming the frame shape that disagreed. This is the acceptance test for the whole card — run it four times, once per fault.
2. Removing `replayChars` from `hello` fails, even though output still flows and a pane still renders.
3. Reverting `CheckOrigin` to the loopback allowlist fails on the tailnet-origin case and still passes the loopback case.
4. Removing the board's `/ws/terminal` proxy fails.
5. Sending a malformed frame leaves the socket open and the suite green.
6. With the binary absent the suite skips with a stated reason and a non-silent exit.
7. The frame-format document exists and is referenced from all three implementation sites.
