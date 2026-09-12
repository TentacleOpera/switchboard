package main

// controlmode.go — a pure tmux control-mode (`tmux -CC`) stream parser.
//
// Control mode is tmux's documented protocol for integrators: instead of
// drawing a pane, tmux emits line-oriented notifications (`%output %<pane>
// <data>`, `%begin`/`%end` command-reply blocks, `%layout-change`, `%exit`, …)
// that a client parses and renders itself. iTerm2's tmux integration is this
// protocol.
//
// This file implements ONLY the parse. It has no I/O: it does not touch the
// ring, the log, or a websocket. The caller (`publish()` in main.go) is the
// single fan-out point that routes parsed output to the browser, the ring and
// the log. Wiring the parser into `publish()` is subtask 2; until then this
// code is unreferenced at runtime.
//
// Design constraints (from the plan, proven against
// `protocol-fixtures/tmux-control-mode.json`):
//
//   - The stream opens with a DCS sequence (`ESC P 1000 p`), NOT a `%` line.
//     A parser that scans only for lines beginning with `%` swallows it into
//     the first message.
//   - `%output` payloads are octal-escaped: bytes < 0x20 and `\` (0x5c) arrive
//     as `\ooo` (three octal digits); 0x7f and bytes >= 0x80 pass through raw.
//     The payload is NOT guaranteed ASCII or valid UTF-8 — do not validate or
//     sanitise it. `capture-pane` output bypasses `server_client_print()` and
//     can contain invalid UTF-8.
//   - Three id sigils (`$` session, `@` window, `%` pane) collide with the
//     message-type prefix: `%output %16 …` is type `%output` addressed to
//     pane 16. The second `%` is an id, not a second type. The distinction is
//     positional (first token = type, second = id).
//   - `%begin`/`%end`/`%error` blocks are opaque: every line between the
//     guards is data, not a control message. A zsh prompt inside a
//     `capture-pane` response can legitimately begin with `%`; the parser must
//     NOT parse it as a control line. tmux guarantees notifications never land
//     inside a block (`control_write()` queues them behind pending blocks).
//   - `%exit` comes from the client process's stdio, not the server's buffered
//     output — they are not ordered against each other. `%exit` is terminal
//     wherever it appears, including inside an open block (force-close the
//     block and emit the exit event).
//   - Control lines arrive CRLF-terminated on a real pty (`OPOST|ONLCR`), but a
//     pipe-captured fixture has bare LF. Stripping all CR is safe because tmux
//     octal-escapes 0x0d inside `%output` payloads, so a raw CR is always a
//     line terminator, never payload.
//   - A chunk boundary is not a line boundary. The parser carries a partial
//     line (and open block state) between calls; the only way to find a
//     chunk-boundary bug is exhaustive byte-offset splitting (see the test).
//   - Unknown message types must pass through as ignorable, because tmux adds
//     types across versions and an unrecognised type must never break
//     rendering.

import "strings"

// MessageKind is the three outcomes a caller needs from a control-mode line.
type MessageKind int

const (
	// KindOutput: decoded pane bytes ready to render. PaneID holds the pane
	// (sigil stripped); Data holds the octal-decoded payload.
	KindOutput MessageKind = iota
	// KindControl: a recognised tmux notification the caller may act on
	// (`%exit`, `%layout-change`, `%window-close`, `%session-changed`, …).
	// Fields holds the raw tokens after the type. Exit is true for `%exit`.
	KindControl
	// KindIgnored: an unrecognised type, passed through by name so a future
	// tmux cannot break rendering. Type holds the type token; Fields holds
	// the raw tokens after it.
	KindIgnored
	// KindBlock: a completed `%begin`/`%end` (or `%error`) command-reply
	// block. Block holds the decoded contents. A block is also emitted when
	// `%exit` force-closes an open block.
	KindBlock
)

// ControlMessage is one parsed control-mode event.
type ControlMessage struct {
	Kind   MessageKind
	Type   string   // type token, e.g. "%output", "%exit", "%future-thing"
	PaneID string   // KindOutput: pane id with sigil stripped (e.g. "16")
	Data   []byte   // KindOutput: octal-decoded payload bytes
	Fields []string // KindControl/KindIgnored: raw tokens after the type
	Block  *Block   // KindBlock: the completed block contents
	Exit   bool     // KindControl: this is a %exit (terminal)
}

// Block is the decoded contents of a completed `%begin`/`%end`/`%error` block.
type Block struct {
	Time          string   // %begin <unix-time>
	CommandNumber string   // %begin <command-number> — the match key
	Flags         string   // %begin <flags> (1 = from this client's stdin)
	Lines         []string // decoded lines between the guards
	Data          []byte   // Lines joined with '\n', decoded
	Error         bool     // closed by %error rather than %end
}

// blockState is the in-progress block carried across chunk boundaries.
type blockState struct {
	time   string
	number string
	flags  string
	lines  []string // raw (still-escaped) lines accumulated so far
}

// ParseState carries the partial line and any open block across chunks. It is
// owned by the caller (one per seat stream); the parser mutates it in place but
// performs no I/O.
type ParseState struct {
	pending       string // partial line awaiting a terminator
	entryConsumed bool   // the leading DCS sequence has been stripped
	dcsSeen       bool   // the DCS entry was actually matched (not just skipped)
	block         *blockState
}

// dcsEntry is the control-mode opening sequence: ESC P 1000 p.
const dcsEntry = "\x1bP1000p"

// stTerminator is the DCS string terminator (ESC \), which tmux emits on
// detach. Raw ESC never appears inside a `%output` payload (tmux octal-escapes
// 0x1b), so stripping bare ST from the stream is safe.
const stTerminator = "\x1b\\"

// knownControlTypes is the tmux 3.4 notification inventory (17 shapes plus
// `%exit`). Anything not in this set, and not `%output` or a block guard, is
// reported as KindIgnored so a future tmux cannot break rendering.
var knownControlTypes = map[string]bool{
	"%layout-change":           true,
	"%window-add":              true,
	"%unlinked-window-add":     true,
	"%window-close":            true,
	"%unlinked-window-close":   true,
	"%window-renamed":          true,
	"%unlinked-window-renamed": true,
	"%window-pane-changed":     true,
	"%pane-mode-changed":       true,
	"%session-changed":         true,
	"%client-session-changed":  true,
	"%session-renamed":         true,
	"%session-window-changed":  true,
	"%sessions-changed":        true,
	"%client-detached":         true,
	"%paste-buffer-changed":    true,
	"%paste-buffer-deleted":    true,
	"%pause":                   true,
	"%continue":                true,
	"%subscription-changed":    true,
	"%message":                 true,
	"%config-error":            true,
	"%exit":                    true,
}

// ParseControlMode consumes one chunk of control-mode output and returns the
// complete messages it contains. A partial final line (and any open block) is
// retained in state for the next call; the parser never assumes a chunk
// boundary is a line boundary. It performs no I/O.
func ParseControlMode(chunk string, state *ParseState) []ControlMessage {
	if state == nil {
		state = &ParseState{}
	}
	buf := state.pending + chunk

	// The stream opens with a DCS sequence, not a `%` line. It can arrive
	// split across the first chunk boundary, so we wait until we have enough
	// bytes to decide.
	if !state.entryConsumed {
		if len(buf) < len(dcsEntry) && strings.HasPrefix(dcsEntry, buf) {
			// A prefix of the DCS — wait for the rest.
			state.pending = buf
			return nil
		}
		if strings.HasPrefix(buf, dcsEntry) {
			buf = buf[len(dcsEntry):]
			state.dcsSeen = true
		}
		state.entryConsumed = true
	}

	// Strip the DCS string terminator (ESC \) if tmux emits it on detach.
	// Safe because raw ESC never appears inside an escaped `%output` payload.
	buf = strings.ReplaceAll(buf, stTerminator, "")
	// Strip CR. tmux octal-escapes 0x0d inside `%output` payloads, so a raw CR
	// is always a line terminator (CRLF on a pty), never payload. This makes
	// CRLF (production pty) and bare-LF (pipe-captured fixture) parse alike.
	buf = strings.ReplaceAll(buf, "\r", "")

	// Split on LF. The final element (no trailing terminator) is the partial
	// line carried to the next call.
	parts := strings.Split(buf, "\n")
	state.pending = parts[len(parts)-1]
	lines := parts[:len(parts)-1]

	var msgs []ControlMessage
	for _, line := range lines {
		msgs = append(msgs, parseControlLine(line, state)...)
	}
	return msgs
}

// parseControlLine classifies one complete control-mode line.
func parseControlLine(line string, state *ParseState) []ControlMessage {
	// Inside a block, every line is data until a matching guard or a terminal
	// %exit arrives. tmux guarantees notifications never land inside a block.
	if state.block != nil {
		if line == "%exit" || strings.HasPrefix(line, "%exit ") {
			// %exit is terminal even inside an open block: force-close the
			// block (surfacing what was captured so far) then emit the exit.
			return []ControlMessage{
				closeBlock(state, false),
				{Kind: KindControl, Type: "%exit", Exit: true, Fields: tokensAfter(line, "%exit")},
			}
		}
		if strings.HasPrefix(line, "%end") && isBlockGuard(line, "%end", state.block) {
			return []ControlMessage{closeBlock(state, false)}
		}
		if strings.HasPrefix(line, "%error") && isBlockGuard(line, "%error", state.block) {
			return []ControlMessage{closeBlock(state, true)}
		}
		// A stray %end/%error whose command number does not match, or any
		// other line (including one beginning with `%`), is block data.
		state.block.lines = append(state.block.lines, line)
		return nil
	}

	// Not in a block.
	if line == "" {
		return nil
	}
	if !strings.HasPrefix(line, "%") {
		// An unexpected non-control line outside a block. Pass it through as
		// ignored so it is visible, not silently dropped.
		return []ControlMessage{{Kind: KindIgnored, Type: "", Fields: []string{line}}}
	}

	typ := typeToken(line)

	if typ == "%begin" {
		openBlock(line, state)
		return nil
	}
	// A stray %end/%error with no open block: ignored, not fatal.
	if typ == "%end" || typ == "%error" {
		return []ControlMessage{{Kind: KindIgnored, Type: typ, Fields: tokensAfter(line, typ)}}
	}
	if typ == "%output" {
		return []ControlMessage{parseOutput(line)}
	}
	// `%extended-output` is pane output too, not a notification. tmux emits it
	// INSTEAD of `%output` for any client that armed flow control — and
	// sendFlowControlLocked arms `pause-after=30` on every attach, so in this
	// host it is the DOMINANT output form, not an edge case (measured on tmux
	// 3.4: 6707 %extended-output vs 14 %output on a busy pane). Classifying it
	// as KindControl sent every byte to handleControlEvent and rendered a blank
	// pane. Shape: `%extended-output %<pane> <age> : <octal payload>`.
	if typ == "%extended-output" {
		return []ControlMessage{parseExtendedOutput(line)}
	}
	if typ == "%exit" {
		return []ControlMessage{{Kind: KindControl, Type: "%exit", Exit: true, Fields: tokensAfter(line, "%exit")}}
	}
	if knownControlTypes[typ] {
		return []ControlMessage{{Kind: KindControl, Type: typ, Fields: tokensAfter(line, typ)}}
	}
	return []ControlMessage{{Kind: KindIgnored, Type: typ, Fields: tokensAfter(line, typ)}}
}

// parseOutput decodes `%output %<pane> <payload>`. The pane sigil is `%`; the
// payload is everything after the single space following the id, octal-decoded.
func parseOutput(line string) ControlMessage {
	rest := strings.TrimPrefix(line, "%output")
	rest = strings.TrimPrefix(rest, " ")
	var paneID, payload string
	if sp := strings.IndexByte(rest, ' '); sp < 0 {
		paneID = rest
	} else {
		paneID = rest[:sp]
		payload = rest[sp+1:]
	}
	paneID = strings.TrimPrefix(paneID, "%")
	return ControlMessage{Kind: KindOutput, Type: "%output", PaneID: paneID, Data: decodeOctal(payload)}
}

// parseExtendedOutput decodes `%extended-output %<pane> <age> : <payload>`.
// The payload uses the same octal escaping as `%output`; `<age>` is the
// milliseconds the data sat in tmux's buffer and is not needed for rendering.
func parseExtendedOutput(line string) ControlMessage {
	rest := strings.TrimPrefix(line, "%extended-output")
	rest = strings.TrimPrefix(rest, " ")
	sp := strings.IndexByte(rest, ' ')
	if sp < 0 {
		return ControlMessage{Kind: KindOutput, Type: "%extended-output", PaneID: strings.TrimPrefix(rest, "%")}
	}
	paneID := strings.TrimPrefix(rest[:sp], "%")
	rest = rest[sp+1:]
	// Skip the age token.
	if sp = strings.IndexByte(rest, ' '); sp < 0 {
		return ControlMessage{Kind: KindOutput, Type: "%extended-output", PaneID: paneID}
	}
	rest = rest[sp+1:]
	// The separator is ": " (a bare ":" when the payload is empty).
	if strings.HasPrefix(rest, ": ") {
		rest = rest[2:]
	} else {
		rest = strings.TrimPrefix(rest, ":")
	}
	return ControlMessage{Kind: KindOutput, Type: "%extended-output", PaneID: paneID, Data: decodeOctal(rest)}
}

// decodeCaptureC decodes `capture-pane -C` escaping, which is NOT the `%output`
// scheme: `-C` doubles a backslash (`\\`) and writes non-printables as `\ooo`.
// Measured on tmux 3.4. Only the `-C` capture reply goes through this.
func decodeCaptureC(s string) []byte {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) && s[i+1] == '\\' {
			out = append(out, '\\')
			i++
			continue
		}
		if s[i] == '\\' && i+3 < len(s) && isOctalDigit(s[i+1]) && isOctalDigit(s[i+2]) && isOctalDigit(s[i+3]) {
			out = append(out, byte(octalValue(s[i+1], s[i+2], s[i+3])))
			i += 3
			continue
		}
		out = append(out, s[i])
	}
	return out
}

// openBlock begins a `%begin <time> <number> <flags>` block.
func openBlock(line string, state *ParseState) {
	f := strings.Fields(line)
	b := &blockState{}
	if len(f) > 1 {
		b.time = f[1]
	}
	if len(f) > 2 {
		b.number = f[2]
	}
	if len(f) > 3 {
		b.flags = f[3]
	}
	state.block = b
}

// isBlockGuard reports whether line is a `%end`/`%error` matching the open
// block's command number. Blocks match on command number (monotonic, unique),
// not timestamp (second-resolution, can collide for two commands in the same
// second).
func isBlockGuard(line, guard string, b *blockState) bool {
	f := strings.Fields(line)
	if len(f) < 3 || f[0] != guard {
		return false
	}
	return f[2] == b.number
}

// closeBlock emits the captured block contents VERBATIM and clears the open
// block.
//
// Block contents are NOT `\ooo`-escaped. Only `%output`/`%extended-output`
// payloads are. Measured against tmux 3.4 on this host: a pane whose visible
// text was the literal `\033[31m` came back from
// `capture-pane -peqJN -S -50000` as the raw bytes `\`,`0`,`3`,`3` — so
// octal-decoding block data turned literal scrollback text into a live ESC and
// injected escape sequences into the pane, the ring and the log transcript.
// A `capture-pane -C` reply uses a DIFFERENT scheme again (backslash doubled as
// `\\`), so the decode belongs to the caller that knows which command it
// issued — see decodeCaptureC and the blockPending arm in publish().
func closeBlock(state *ParseState, errored bool) ControlMessage {
	b := state.block
	state.block = nil
	if b == nil {
		return ControlMessage{Kind: KindBlock, Block: &Block{Error: errored}}
	}
	lines := make([]string, 0, len(b.lines))
	var data []byte
	for i, ln := range b.lines {
		lines = append(lines, ln)
		if i > 0 {
			data = append(data, '\n')
		}
		data = append(data, ln...)
	}
	return ControlMessage{
		Kind: KindBlock,
		Type: "%begin",
		Block: &Block{
			Time:          b.time,
			CommandNumber: b.number,
			Flags:         b.flags,
			Lines:         lines,
			Data:          data,
			Error:         errored,
		},
	}
}

// typeToken returns the first whitespace-delimited token of a control line.
func typeToken(line string) string {
	if sp := strings.IndexByte(line, ' '); sp >= 0 {
		return line[:sp]
	}
	return line
}

// tokensAfter returns the whitespace-delimited tokens after the type token.
func tokensAfter(line, typ string) []string {
	rest := strings.TrimPrefix(line, typ)
	rest = strings.TrimPrefix(rest, " ")
	if rest == "" {
		return nil
	}
	return strings.Split(rest, " ")
}

// decodeOctal decodes tmux's `%output` payload escaping: `\ooo` (a backslash
// followed by exactly three octal digits) becomes that byte. Bytes >= 0x7f and
// any byte that is not part of an escape pass through verbatim — the payload is
// NOT guaranteed ASCII or valid UTF-8, so we do not validate or sanitise it.
// A backslash not followed by three octal digits is emitted literally (tmux
// always emits three digits, so this only matters for malformed input).
func decodeOctal(s string) []byte {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) && isOctalDigit(s[i+1]) && isOctalDigit(s[i+2]) && isOctalDigit(s[i+3]) {
			out = append(out, byte(octalValue(s[i+1], s[i+2], s[i+3])))
			i += 3
			continue
		}
		out = append(out, s[i])
	}
	return out
}

func isOctalDigit(c byte) bool { return c >= '0' && c <= '7' }

func octalValue(a, b, c byte) int {
	return int(a-'0')*64 + int(b-'0')*8 + int(c-'0')
}
