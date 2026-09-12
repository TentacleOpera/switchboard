package main

// controlmode_io.go — the control-mode I/O layer: input encoding (the
// three-way `send-keys` encoder), control-command writing, history fetch, and
// pane-id discovery. The parser itself lives in controlmode.go; this file is
// the wiring the host uses to talk back to tmux over the control-mode stdin.
//
// All writers here go to t.file (the pty stdin). They are called either with
// t.mu already held (the write/ptyResize/prompt paths) or from the publish
// goroutine, which takes t.mu itself before issuing commands. A bare newline
// on stdin detaches the control client — `control_read_callback` treats
// `*line == '\0'` as `CLIENT_EXIT` — so every command writer guards against
// emitting an empty line.

import (
	"fmt"
	"strings"
)

// blockKind tags a pending %begin/%end block so publish() can tell a
// list-panes reply (parse for the pane id) from a capture-pane reply
// (terminal content, route to the consumers). Blocks return strictly in the
// order commands were sent, so a FIFO of these on the terminal is enough.
type blockKind int

const (
	blockNone       blockKind = iota
	blockPaneID               // list-panes reply — parse for the pane id, do NOT route
	blockScrollback           // capture-pane -S -50000 — terminal content, route to consumers
	blockPending              // capture-pane -P -C — trailing escape fragment, route to consumers
)

// writeControlCommandLocked writes one tmux control command (no trailing
// newline in `cmd`) to the pty stdin, appending the terminator. An empty
// command is skipped: a bare newline detaches the control client. Caller
// holds t.mu.
// EVERY command sent to control-mode stdin produces exactly one %begin/%end
// reply block, so every command MUST push its kind onto the FIFO that publish()
// pops. Taking the kind here — rather than leaving callers to remember a
// separate append — is what keeps the two aligned by construction.
//
// They were not aligned: 8 commands were written and only 3 pushed. Flow control
// (`refresh-client -f`) is sent BEFORE `list-panes`, so its reply popped the
// blockPaneID entry, parsePaneIDFromBlock read an empty block, and t.paneID was
// never learned. writeControlModeInputLocked then buffered every keystroke
// waiting for a pane id that could not arrive, while ptyWrite returned success —
// typed input vanished on every seat. Each send-keys desynced it further.
func writeControlCommandLocked(t *terminal, cmd string, kind blockKind) error {
	if cmd == "" {
		return nil
	}
	if _, err := t.file.WriteString(cmd + "\n"); err != nil {
		return err
	}
	t.pendingBlocks = append(t.pendingBlocks, kind)
	return nil
}

// isLiteralSafeRune reports whether a rune may travel via `send-keys -lt`
// (literal UTF-8 string, the fewest bytes on the wire). iTerm2's set: ASCII
// alphanumerics and `+ / ) : , _`. Everything else ≥ 0x20 goes through the
// code-point path; C0 controls and 0x7f go through the hex path.
func isLiteralSafeRune(r rune) bool {
	if r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
		return true
	}
	switch r {
	case '+', '/', ')', ':', ',', '_':
		return true
	}
	return false
}

// Per-command chunk limits, matching iTerm2's reference encoder: ~333 bytes
// per `-H` command, ~125 code points per `0xNN` command, 1000 chars per `-l`
// command.
const (
	sendKeysHexChunk     = 150
	sendKeysCodeChunk    = 125
	sendKeysLiteralChunk = 1000
)

// encodeSendKeys turns operator keystrokes into a sequence of `send-keys`
// commands (without trailing newlines) using iTerm2's three-way encoder:
//   - C0 controls (0x00–0x1f) and 0x7f → `send-keys -H -t %<pane> NN …` (hex
//     bytes, KEYC_LITERAL — bypasses the prefix key and every binding; this is
//     the fix for "prefix eating keys").
//   - Code points ≥ 0x20 that are not literal-safe → `send-keys -t %<pane>
//     0xNNNN …` (Unicode code points, UTF-8 encoded by tmux — the correct path
//     for typed Unicode; `-H` would need manual UTF-8 byte splitting).
//   - Runs of literal-safe runes → `send-keys -lt -t %<pane> STRING` (literal
//     UTF-8, fewest bytes on the wire).
//
// Consecutive runes of the same kind are run-length-encoded into one command,
// chunked at the per-command limits. paneID is the tmux pane id without the
// `%` sigil (e.g. "5"); it must be known before any input can be sent.
func encodeSendKeys(paneID string, data string) []string {
	if paneID == "" || data == "" {
		return nil
	}
	target := "%" + paneID
	var cmds []string
	runes := []rune(data)
	i := 0
	for i < len(runes) {
		r := runes[i]
		kind := classifyRune(r)
		// Run-length-encode consecutive runes of the same kind.
		j := i + 1
		for j < len(runes) && classifyRune(runes[j]) == kind {
			j++
		}
		switch kind {
		case 0:
			// Hex bytes. Each rune here is < 0x80 (C0 or 0x7f), one byte each.
			for start := i; start < j; start += sendKeysHexChunk {
				end := start + sendKeysHexChunk
				if end > j {
					end = j
				}
				var b strings.Builder
				b.WriteString("send-keys -H -t ")
				b.WriteString(target)
				for k := start; k < end; k++ {
					b.WriteString(fmt.Sprintf(" %02x", byte(runes[k])))
				}
				cmds = append(cmds, b.String())
			}
		case 1:
			// Unicode code points.
			for start := i; start < j; start += sendKeysCodeChunk {
				end := start + sendKeysCodeChunk
				if end > j {
					end = j
				}
				var b strings.Builder
				b.WriteString("send-keys -t ")
				b.WriteString(target)
				for k := start; k < end; k++ {
					b.WriteString(fmt.Sprintf(" 0x%x", runes[k]))
				}
				cmds = append(cmds, b.String())
			}
		case 2:
			// Literal UTF-8 string.
			for start := i; start < j; start += sendKeysLiteralChunk {
				end := start + sendKeysLiteralChunk
				if end > j {
					end = j
				}
				var b strings.Builder
				// `-l -t`, NOT `-lt -t`. tmux parses `-lt` as `-l` plus `-t`, and `-t`
				// takes an argument — so it swallowed the following `-t` as the
				// target and treated `%<pane> <text>` as the keys. tmux ACCEPTS it
				// and exits 0 while delivering nothing, which is why ordinary typed
				// text (all literal-safe, so it takes this path) vanished on every
				// seat with the write reporting success. Verified against a live
				// pane: `-lt -t` delivers 0, `-l -t` delivers 1.
				b.WriteString("send-keys -l -t ")
				b.WriteString(target)
				// The separating space is REQUIRED and was missing: the hex and
				// code-point branches prefix each argument with " ", this one wrote
				// the text flush against the target, so the command read
				// `send-keys -l -t %7hello` and tmux resolved a pane named
				// "%7hello". Unquoted is safe because isLiteralSafeRune admits only
				// alphanumerics and `+ / ) : , _` — never a space or a shell
				// metacharacter, so a literal run is always a single bare word.
				b.WriteString(" ")
				for k := start; k < end; k++ {
					b.WriteRune(runes[k])
				}
				cmds = append(cmds, b.String())
			}
		}
		i = j
	}
	return cmds
}

// classifyRune maps a rune to its encoder kind: 0 = hex (C0/0x7f),
// 1 = code point (≥ 0x20, not literal-safe), 2 = literal.
func classifyRune(r rune) int {
	if r < 0x20 || r == 0x7f {
		return 0
	}
	if isLiteralSafeRune(r) {
		return 2
	}
	return 1
}

// writeToPty is the single seam for putting bytes on the pty. In raw mode (or
// before tmux has taken over) it writes the bytes verbatim; once control mode
// is active it encodes them as `send-keys` commands. Every caller that used to
// do `t.file.WriteString(...)` or `io.WriteString(t.file, ...)` goes through
// here. Caller holds t.mu.
func writeToPty(t *terminal, data string) error {
	if !t.controlMode || !t.controlActive {
		_, err := t.file.WriteString(data)
		return err
	}
	return writeControlModeInputLocked(t, data)
}

// writeControlModeInputLocked encodes keystrokes as send-keys commands. If
// the pane id is not yet known (no %output / list-panes seen), the input is
// buffered and flushed when the pane id arrives — never silently dropped.
// Caller holds t.mu.
func writeControlModeInputLocked(t *terminal, data string) error {
	if t.paneID == "" {
		t.pendingInput = append(t.pendingInput, data...)
		return nil
	}
	// Drain anything buffered before the pane id was known so it lands first.
	pending := t.pendingInput
	t.pendingInput = nil
	if len(pending) > 0 {
		if err := sendKeysLocked(t, string(pending)); err != nil {
			return err
		}
	}
	return sendKeysLocked(t, data)
}

// flushPendingInputLocked sends any input buffered before the pane id was
// known. Called from publish() once the pane id arrives. Caller holds t.mu.
func flushPendingInputLocked(t *terminal) error {
	pending := t.pendingInput
	t.pendingInput = nil
	if len(pending) == 0 {
		return nil
	}
	return sendKeysLocked(t, string(pending))
}

// sendKeysLocked encodes data as send-keys commands and writes them. If a
// copy/choose mode is active, it is cancelled first so the keystrokes reach
// the pane, not the mode's key table (`cmd_send_keys_inject_key` checks pane
// modes before the pane). Caller holds t.mu.
func sendKeysLocked(t *terminal, data string) error {
	if t.copyModeActive {
		if err := writeControlCommandLocked(t, "send-keys -t %"+t.paneID+" -X cancel", blockNone); err != nil {
			return err
		}
		t.copyModeActive = false
	}
	for _, cmd := range encodeSendKeys(t.paneID, data) {
		if err := writeControlCommandLocked(t, cmd, blockNone); err != nil {
			return err
		}
	}
	return nil
}

// sendFlowControlLocked arms the control client's flow-control flags on
// attach. `pause-after=30` makes tmux send `%pause` and stop queuing for a pane
// whose oldest block exceeds 30s (instead of killing the client with
// "too far behind" at the 300s CONTROL_MAXIMUM_AGE); the host resumes with
// `refresh-client -A '%n:continue'`. `no-detach-on-destroy` keeps the control
// client attached when a session is destroyed. Caller holds t.mu.
func sendFlowControlLocked(t *terminal) error {
	return writeControlCommandLocked(t, "refresh-client -f no-detach-on-destroy,pause-after=30", blockNone)
}

// sendListPanesLocked queries the pane id for a session. The reply arrives as
// a %begin/%end block; the caller must push blockPaneID onto pendingBlocks so
// publish() parses it instead of routing it to the browser. Caller holds t.mu.
func sendListPanesLocked(t *terminal, target string) error {
	return writeControlCommandLocked(t, fmt.Sprintf("list-panes -t %s -F \"#{pane_id}\"", target), blockPaneID)
}

// `-E -1` bounds the capture ONE LINE ABOVE the visible screen. Without it
// `-S -50000` runs to the end of the pane, so the replay carried the CURRENT
// screen as well as the scrollback above it — the client rendered the agent's
// prompt from the replay and the live agent then redrew it, which is the
// doubled input area. Verified on tmux 3.4: the unbounded capture and the
// visible screen both contain the same prompt line. The live pane draws itself;
// history's job is only the part that has scrolled off.
//
// sendHistoryFetchLocked issues the two capture-pane calls that fill a freshly
// opened panel: the scrollback (`-peqJN -S -50000`) and the pending incomplete
// escape fragment (`-p -P -C`). The caller must push blockScrollback then
// blockPending onto pendingBlocks. `-S -50000` matches tmux's history limit
// (the acceptance criterion: a freshly opened panel scrolls back to tmux
// history limit, matching `capture-pane -p -S -50000`); it is already a
// bounded value, so the unbounded `-S -` hang risk does not apply. Caller
// holds t.mu.
func sendHistoryFetchLocked(t *terminal) error {
	// GUARD on a known pane id. Every other command site checks this
	// (ws.go's resize, writeControlModeInputLocked, the %pause resume arm); the
	// history fetch did not, so an unlearned id produced `capture-pane -t %` —
	// tmux answers `can't find pane: %` in an %error block, and publish() routes
	// block contents to the browser, the ring and the log. That is the
	// "cannot find panel" an operator sees, repeated once per command.
	//
	// Returning nil rather than erroring: the fetch is re-issued when the id is
	// learned (the blockPaneID arm in publish()), so there is nothing to report.
	if t.paneID == "" {
		return nil
	}
	pane := "%" + t.paneID
	if err := writeControlCommandLocked(t, fmt.Sprintf("capture-pane -t %s -peqJN -S -50000 -E -1", pane), blockScrollback); err != nil {
		return err
	}
	return writeControlCommandLocked(t, fmt.Sprintf("capture-pane -t %s -p -P -C", pane), blockPending)
}

// parsePaneIDFromBlock extracts the first pane id from a list-panes reply
// block (one `%<id>` per line). Returns "" if none is found.
func parsePaneIDFromBlock(block *Block) string {
	if block == nil {
		return ""
	}
	for _, line := range block.Lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		return strings.TrimPrefix(line, "%")
	}
	d := strings.TrimSpace(string(block.Data))
	return strings.TrimPrefix(d, "%")
}
