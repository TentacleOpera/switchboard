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

**The failure is structural, not careless.** Every one of these four is a place where two implementations must agree on a byte layout, and the only thing recording that agreement was a comment.

> **Superseded:** `terminals.js:11272` documents the binary output frame and cites `encodeOutputFrame in terminalWsGateway.ts` — a TypeScript function in a file nothing constructs any more. The Go author had no way to discover the contract except by reading a comment pointing at retired code.
> **Reason:** The file:line is wrong. `terminals.js:11272` is a comment about fleet polling and the 5-second sidebar race, not the wire format. The actual frame-format comment and the decoder live in `terminalViewport.js:1898-1910` (`ws.onmessage`, binary arm: "Binary = pty output (4-byte BE seq + UTF-8 payload)... See encodeOutputFrame in terminalWsGateway.ts"). The encoder it cites does still exist (`src/standalone/terminalWsGateway.ts:144`), so only the *location of the comment* was wrong, not the structural argument.
> **Replaced with:** The frame-format contract is documented in a comment at `terminalViewport.js:1898` (the JS decoder) and implemented by `encodeOutputFrame` in `terminalWsGateway.ts:144` (TS encoder) and `encodeOutputFrame` in `cmd/switchboard-pty-host/ws.go:184` (Go encoder). The Go author's only discovery path was a comment in the decoder file pointing at the TS encoder — correct in spirit, mis-cited as `terminals.js` in the original analysis.

**And the cost was not the bugs — it was the diagnosis.** Each fault masked the next, so fixing one revealed another, four times. The whole path — page, hub, upgrade, token, origin, framing — verified green from the serving machine at every step, because the tests available were `curl` and a raw socket, and neither sends what a browser sends. It was found by taking a screenshot and looking at a black rectangle.

**This will recur.** The launcher is the third subtask of *Go Where It Pays* (`f924f75c`) and is not yet shipped; the static client verbs are. Each is another boundary where a Go implementation must match a JS expectation with nothing but prose in between.

## Metadata

**Feature:** d2996735-56de-4e00-ac77-9170be1235f6
- **Complexity:** 6
- **Tags:** test, reliability, backend

## User Review Required

None.

## Complexity Audit

### Routine
- Extending the existing `test:contract:pty-host-blackbox` harness (`src/test/pty-host-blackbox-contract.test.js`) with additional assertions — the process spawn, ready-handshake parse, token auth, `decodeOutput` helper, and process-tree cleanup already exist and work.
- Adding a `replayChars` numeric assertion to the existing `hello`-frame check (line 368).
- Adding a binary-input (`0x01`+UTF-8) assertion alongside the existing legacy-JSON input path (line 391).
- Writing the frame-format document and adding reference comments at three sites.

### Complex / Risky
- **Section 4 (board proxy) requires a board listener the existing harness does not have.** No contract test in the repo spawns the standalone host or an in-process `LocalApiServer` with the proxy wired — every fleet/proxy test is source-grep or unit-scoped. This is the one genuinely new harness work in the plan.
- **Tightening the fault-3 assertion to *reject* text frames**, not merely decode binary — the existing `decodeOutput` (lines 374-378) is lenient and passes against a JSON frame; the fix must assert `messageType === BinaryMessage` (opcode 2) at the `ws` layer, not just that a 4-byte read succeeds.
- **Parity framing is inverted in the original plan.** The extension's page connects *directly* to the loopback child (`data-pty-host-origin`, `TaskViewerProvider.ts:5074`); the standalone's page connects to the *board's* origin which proxies (`bootstrap.ts:1434-1444`, `LocalApiServer.ts:1298-1315`). The blackbox test (direct-to-child) covers the extension's live path; section 4 is what covers the standalone's live path. Stating this correctly is load-bearing for the "both hosts" claim.

## Edge-Case & Dependency Audit

### Race Conditions
- The host sends `hello` and the one coalesced replay frame back-to-back under `client.writeMu` (`ws.go:128-136`). A test that registers its `hello` handler and arms the replay collector *separately* can miss the replay frame if it arrives before the collector is attached. The existing test removes the `hello` handler inside the message callback (line 364) — the replay collector must be attached in the *same* callback, before any `await`, or the assertion is flaky against a fast host.
- A publish landing between `hello` and the replay frame would be parsed by the client as scrollback. The Go host prevents this by holding the lock across both writes; the test must not introduce an `await` between arming the collector and the frame arriving.

### Security
- The `Origin` assertion must send a *foreign* origin (e.g. `http://evil.example:7777`) and assert refusal, AND a *same-origin* tailnet origin (e.g. `http://100.64.0.1:7777` with matching `Host`) and assert acceptance, AND a *missing* origin and assert acceptance. The `ws` library sends no `Origin` by default — a test that constructs `new WebSocket(url)` with no options tests the missing-origin case only, which is precisely why fault 1 survived. Pass `{ origin: '...' }` in the constructor options for the other two cases.
- The board-proxy assertion must verify the page's token is *swapped* for the child's token (`authorizePtyHostUpgrade`, `bootstrap.ts:5137-5142`) — forwarding the page's token verbatim 401s forever, because the Go host mints its own credential at boot.

### Side Effects
- **The binary must exist to test.** `npm run compile` does **not** build Go; `scripts/build-pty-host.sh` does, and needs a Go toolchain. The test must skip loudly with a stated reason when the binary is absent — never pass silently, which is a green gate over an untested contract. The existing harness already does this (`nativeBinary()` returns null → handshake probe skipped with a warning, line 170-173); new assertions inherit this guard by living in the same `if (bin)` block.
- **Kill the child on every exit path**, including assertion failure, or a failing run leaves an orphaned PTY host holding the workspace. The existing harness uses `try/finally` with `child.kill('SIGTERM')` — new assertions must extend the same `try` block, not open a second host they forget to tear down.
- **Port allocation.** The host picks an ephemeral port and reports it on the ready handshake. Parse it; do not assume. The existing `startHost` (line 104) already does.

### Dependencies & Conflicts
- **`test:contract:*` is what actually gates CI.** `npm test` (the vscode-test suite) is not CI-wired, so a test placed there runs never. Register assertions as additions to the existing `test:contract:pty-host-blackbox` script (already CI-wired), not a new suite under `npm test`.
- **The extension host is not directly covered by this test, and the coverage is the *opposite* of what the original plan implied.** The extension's page connects directly to the loopback child (`TaskViewerProvider.ts:5074`, `data-pty-host-origin`); the standalone's page connects to the board's origin which proxies (`bootstrap.ts:1434`). The blackbox test (direct-to-child) covers the extension's live path. Section 4 (board proxy) is what covers the standalone's live path. Both paths terminate at the same Go child, so the frame-shape assertions (sections 2-3) protect both — but the *routing* assertions must be stated per-host, not inherited.
- **Do not assert on Devin's or Claude's output.** The test spawns a shell and echoes a known string; asserting on a vendor CLI's banner makes the suite fail when a vendor changes their splash screen.
- **Contract suites run against `out/`, not `dist/`** — but this suite spawns the Go binary from `dist/<platform>/switchboard-pty-host` (resolved via `pty-host-artifacts.json`, line 20). Run `scripts/build-pty-host.sh` before this suite, not `npm run compile-tests`.

## Dependencies

- None. This plan is self-contained; it extends an existing contract suite and adds a document. No `sess_` session dependencies.

## Adversarial Synthesis

Key risks: (1) section 4 (board proxy) is underspecified on *how to obtain a board port* and can be implemented as a trivially-passing assertion against the child's port — the exact appearance-vs-goal gap that let fault 2 ship green; (2) the existing `decodeOutput` is lenient and passes against a JSON frame, so the fault-3 assertion must reject text frames by message type, not merely decode binary; (3) the original plan's citation (`terminals.js:11272`) and "both hosts" framing were both wrong, sending the implementer to the wrong file and inverting which host the proxy test covers. Mitigations: section 4 must specify a board-listener harness (spawn standalone, or in-process `LocalApiServer` with the proxy wired); every frame assertion must *reject* the broken encoding, not just *accept* the working one; the frame-format doc must be referenced from `terminalViewport.js` (decoder), `terminalWsGateway.ts` (TS encoder), and `ws.go` (Go encoder).

## Proposed Changes

### 1. `src/test/pty-host-blackbox-contract.test.js` — extend the existing suite

The harness already exists and works: `startHost` (line 104) spawns the real binary, `nativeBinary()` (line 40) resolves it from `pty-host-artifacts.json`, the ready-handshake parse (line 120) reads the ephemeral port + token, and the `if (bin) { ... }` block (line 170) gates every live assertion behind a loud skip when the binary is absent. **Do not build a second suite.** Add the assertions below as additional `await test(...)` calls inside the existing `if (bin)` block, each reusing the same `startHost` / `try/finally child.kill` pattern.

### 2. Assert each frame shape — *rejecting* the broken encoding, not just *accepting* the working one

One assertion per fault, written so the fault reproduces if reintroduced:

- **Output is a BINARY frame (opcode 2), not merely a 4-byte buffer.** The existing `decodeOutput` (line 374) returns `{seq, data}` for *any* 4+ byte buffer and passes the `out.data.includes(marker)` check against a JSON frame — that leniency is what let fault 3 ship green. The assertion must check the `ws` message type: register a collector that records `raw.type` (the `ws` library emits `'message'` with `raw.isBinary` / the second arg), and assert the output frame arrived as a binary message. A text/JSON output frame must *fail* the assertion. Then decode the 4-byte big-endian seq + UTF-8 payload and compare to what was written to the PTY. Fault 3 shipped a JSON frame the client silently discarded, so "output arrives" is not enough — assert its *encoding* and its *message type*.
- **`hello` carries `replayChars` as a numeric match, not just presence.** The client arms answerback suppression only when `replayChars > 0` (`terminalViewport.js:1972-1981`). The existing test checks `frames[0].t === 'hello'` (line 368) and stops. Assert `hello.replayChars` is a number, and when the replay is non-empty, assert it equals the UTF-16 length of the replay frame's payload (computed the same way as `utf16Len` in `ws.go:196` — count code units, surrogate-pairing code points > 0xFFFF as 2). Without the numeric match, xterm answers OSC queries buried in scrollback, typing `10;rgb:...` into the pty.
- **The replay is exactly ONE binary frame following `hello`.** The client's contract is "the next binary frame is the replay" (`terminalViewport.js:1975-1979`). The existing test checks `replayed.some(f => f.data.includes(marker))` (line 430) — `some()` is true at one frame or forty. Assert the binary-frame count between `hello` and the first live frame is exactly 1. Attach the replay collector in the *same* `hello` callback before any `await` (see Race Conditions) or the frame can be missed on a fast host.
- **Input is accepted as binary `0x01`+UTF-8, the PTY echoes it, and the socket stays open.** The webview sends keystrokes via `encodeInputFrame` (`terminalViewport.js:241-247`: one `0x01` opcode byte + UTF-8). The existing test sends `JSON.stringify({ t: 'input', data: ... })` (line 391) — the *legacy* JSON path, which the Go handler also accepts (`ws.go:167-169`) and which would have passed against the broken `ReadJSON`-only handler. Send a real binary frame: `ws.send(Buffer.from([0x01, ...Buffer.from('echo ' + marker + '\r', 'utf8')]))`, collect the echo, and assert the marker round-trips. Then assert the socket is **still open** — fault 4's real damage was the disconnect, not the ignored keystroke.
- **A malformed frame does not close the session — cover BOTH arms.** The Go handler branches on `messageType == BinaryMessage` (`ws.go:150`) vs JSON (`ws.go:159`). Send *each* kind of garbage and assert the socket survives both: (a) a text frame with invalid JSON (`ws.send('not-json{')`), which must hit the `continue` arm at `ws.go:160-165`; (b) a binary frame with an unknown opcode (e.g. `0x02`+bytes), which must hit the `continue` at `ws.go:157`. The old handler `return`ed on any parse error; assert that after both, a subsequent valid input frame still echoes.

### 3. Assert the origin rule from both sides

`CheckOrigin` (`ws.go:29-43`) accepts empty origin, loopback origin, and same-origin (origin host == request host); it refuses everything else. The `ws` library sends no `Origin` by default, so `new WebSocket(url)` tests the empty-origin case only — the omission that let fault 1 survive. Pass `{ origin: ... }` in the constructor options for the other cases:

- **Foreign origin refused:** `new WebSocket(wsUrl, { origin: 'http://evil.example:7777' })` — assert the upgrade is refused (connection error / 403).
- **Same-origin tailnet accepted:** `new WebSocket(wsUrl, { origin: 'http://100.64.0.1:7777' })` with the request `Host` matching — assert the upgrade succeeds. This is the tailnet case fault 1 broke.
- **Missing origin accepted:** `new WebSocket(wsUrl)` (no options) — assert the upgrade succeeds. This is the curl/terminal case.

A test that omits the header tests nothing — that omission is precisely why fault 1 survived, and the test must send what a browser sends.

### 4. Assert the board proxies `/ws/terminal` on its own origin — *with a real board listener*

The fleet lives on a loopback-only child. If the board stops proxying, terminals become unreachable from every machine except the server, which is the entire remote product. **This is the standalone host's live path** — the extension's page connects directly to the child (`TaskViewerProvider.ts:5074`), but the standalone's page connects to the board's origin (`bootstrap.ts:1434-1444`), which proxies via `authorizePtyHostUpgrade` (`LocalApiServer.ts:1298-1307`) or `getPtyHostPort` (`LocalApiServer.ts:1308-1315`).

> **Superseded:** (original section 4) "Assert an upgrade succeeds against the board's port, not the child's." — stated without specifying how to obtain a board port.
> **Reason:** The existing blackbox harness spawns only the Go child; it has no board listener. No contract test in the repo spawns the standalone host or an in-process `LocalApiServer` with the proxy wired. An implementer handed the original section would connect to the child's loopback port and label it "the board's port" — a green test that tests nothing about the proxy, re-enacting fault 2's green gate.
> **Replaced with:** The assertion must run against a real board listener. Two viable harnesses (pick one, state which):
> 1. **Spawn the standalone host** (`node dist/standalone/cli.js --workspace <tmp>`), parse its ready handshake for the board port + the page's `terminalSessionToken`, spawn the Go child it supervises (or let it), and assert a `/ws/terminal` upgrade against the *board's* port succeeds with the page's token (which the board swaps for the child's `terminalToken` via `authorizePtyHostUpgrade`). Heavier — requires the standalone build + a workspace + DB.
> 2. **Construct an in-process `LocalApiServer`** with `authorizePtyHostUpgrade` (or `getPtyHostPort`) wired to the already-spawned Go child, listen on an ephemeral port, and assert the upgrade against *that* port. Lighter — reuses the existing child spawn, but requires importing `LocalApiServer` into a contract test (no existing test does this).
>
> Either way: assert the upgrade succeeds against the **board listener's** port, not the child's; assert the page's token is swapped for the child's (a verbatim forward 401s); and assert a missing/broken proxy (unwire `authorizePtyHostUpgrade` and `getPtyHostPort`) makes the upgrade fail. This is the one assertion that protects the standalone's remote product path.

### 5. Give the contract one home, named in both languages — referenced from the *decoder*, not `terminals.js`

The frame layouts are currently described in a comment in `terminalViewport.js:1898` (the JS decoder) citing `encodeOutputFrame` in `terminalWsGateway.ts:144` (the TS encoder), with a parallel implementation in `cmd/switchboard-pty-host/ws.go:184` (the Go encoder).

> **Superseded:** (original section 5) "reference that document from `terminals.js`, `terminalWsGateway.ts` and `cmd/switchboard-pty-host/ws.go`."
> **Reason:** The decoder and the frame-format comment are in `terminalViewport.js`, not `terminals.js`. Referencing `terminals.js` reproduces the disease — the contract's home would be named for a file that does not contain the decoder, and the actual decoder site would keep citing the retired path.
> **Replaced with:** Write the four frame layouts down once — their shapes, fields, and encodings — in a single document (e.g. `docs/pty-wire-format.md`), and reference it from all three implementation sites: `terminalViewport.js:1898` (decoder), `terminalWsGateway.ts:144` (TS encoder), and `cmd/switchboard-pty-host/ws.go:184` (Go encoder). The next port has something to implement against, and the comment at each site points at the same home.

The four shapes to document:
1. **Output (binary, opcode 2):** 4-byte big-endian seq + UTF-8 payload. Encoded by `encodeOutputFrame` (TS `terminalWsGateway.ts:144`, Go `ws.go:184`); decoded by `terminalViewport.js:1900-1910`.
2. **Input (binary, opcode 2):** `0x01` opcode byte + UTF-8 keystrokes. Encoded by `encodeInputFrame` (`terminalViewport.js:241`); decoded by `ws.go:150-156`. (Legacy JSON `{t:'input',data}` accepted for compatibility, `ws.go:167-169`.)
3. **Control frames (text/JSON):** `hello` (carries `name`, `seq`, `replayChars`), `resize` (`cols`,`rows`), `ack`. `ws.go:129-136`, `ws.go:166-177`.
4. **Replay contract:** `hello` immediately followed by exactly ONE coalesced binary replay frame, sent under the write lock back-to-back. `ws.go:122-136`, `terminalViewport.js:1975-1979`.

## Verification Plan

### Automated Tests
1. Reverting any one of the four faults makes the suite red, with a message naming the frame shape that disagreed. This is the acceptance test for the whole card — run it four times, once per fault.
2. Removing `replayChars` from `hello` fails the numeric-match assertion, even though output still flows and a pane still renders.
3. Reverting `CheckOrigin` to the loopback allowlist fails on the tailnet-origin case and still passes the loopback/missing-origin cases.
4. Removing the board's `/ws/terminal` proxy (unwiring `authorizePtyHostUpgrade` and `getPtyHostPort`) fails the board-proxy assertion.
5. Sending a malformed frame (both the bad-JSON text arm and the unknown-opcode binary arm) leaves the socket open and the suite green.
6. With the binary absent the suite skips with a stated reason and a non-silent exit (inherited from the existing `nativeBinary()` guard).
7. The frame-format document exists and is referenced from all three implementation sites (`terminalViewport.js`, `terminalWsGateway.ts`, `ws.go`).

### Goal Invariants
- Assert `src/test/pty-host-blackbox-contract.test.js` contains an assertion that sends a binary `0x01`+UTF-8 input frame (count of `ws.send(Buffer.from([0x01,` occurrences ≥ 1).
- Assert `src/test/pty-host-blackbox-contract.test.js` contains an assertion that sends a foreign `Origin` header (count of `origin: 'http://evil` or equivalent ≥ 1).
- Assert `src/test/pty-host-blackbox-contract.test.js` contains an assertion that checks the `ws` message type is binary for output frames (count of `isBinary` or `messageType === 2` or equivalent ≥ 1).
- Assert `src/test/pty-host-blackbox-contract.test.js` contains an assertion that exercises a board listener (count of `LocalApiServer` or `dist/standalone/cli` references ≥ 1).
- Assert `docs/pty-wire-format.md` (or equivalent) exists and is referenced from `terminalViewport.js`, `terminalWsGateway.ts`, and `cmd/switchboard-pty-host/ws.go` (count of references ≥ 3).

## Outstanding Questions
- **[user]** The plan covers two independently-shippable phases: (A) frame-shape + origin assertions extending the existing child-only blackbox suite (sections 1-3), and (B) the board-proxy assertion requiring a new board-listener harness (section 4), plus the doc (section 5). Phase A is routine extension; phase B is the one genuinely new harness. Recommend splitting into two plans so phase A can ship and gate immediately while phase B's harness choice (spawn-standalone vs in-process `LocalApiServer`) is decided — proceeding on the assumption that the user prefers one plan with phase B's harness choice left to the implementer (option 2, in-process `LocalApiServer`, is lighter and reuses the existing child spawn).
