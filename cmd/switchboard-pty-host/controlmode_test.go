package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// controlmode_test.go — proves the parser against
// `protocol-fixtures/tmux-control-mode.json` (real `tmux -CC` captures from
// this host) plus targeted edge cases. No live tmux, no pty, no WS: the tests
// feed bytes and assert decoded output.

type fixtureFile struct {
	ProtocolVersion int            `json:"protocolVersion"`
	Captures        map[string]struct {
		Description string `json:"description"`
		Raw         string `json:"raw"`
	} `json:"captures"`
}

func loadFixture(t *testing.T) *fixtureFile {
	t.Helper()
	paths := []string{
		"protocol-fixtures/tmux-control-mode.json",
		filepath.Join("..", "..", "protocol-fixtures", "tmux-control-mode.json"),
	}
	var raw []byte
	var err error
	for _, p := range paths {
		raw, err = os.ReadFile(p)
		if err == nil {
			break
		}
	}
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var f fixtureFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return &f
}

// scratchRaw returns the captured scratch-session stream.
func scratchRaw(t *testing.T) string {
	return loadFixture(t).Captures["scratchWithOutput"].Raw
}

// TestEntrySequenceConsumed: the DCS prefix does not leak into the first
// message's payload.
func TestEntrySequenceConsumed(t *testing.T) {
	var st ParseState
	msgs := ParseControlMode(scratchRaw(t), &st)
	for _, m := range msgs {
		if m.Kind == KindOutput || m.Kind == KindBlock {
			if containsBytes(m.Data, []byte("P1000p")) {
				t.Fatalf("DCS prefix leaked into payload: %q", m.Data)
			}
		}
	}
	if !st.entryConsumed {
		t.Fatalf("entry sequence not marked consumed")
	}
	if st.pending != "" {
		t.Fatalf("unexpected pending remainder: %q", st.pending)
	}
}

// TestFixtureDecodesByteExact: the two %output messages decode to the original
// colour sequences and CRLF bytes.
func TestFixtureDecodesByteExact(t *testing.T) {
	var st ParseState
	msgs := ParseControlMode(scratchRaw(t), &st)

	var outputs []ControlMessage
	for _, m := range msgs {
		if m.Kind == KindOutput {
			outputs = append(outputs, m)
		}
	}
	if len(outputs) != 2 {
		t.Fatalf("want 2 output messages, got %d", len(outputs))
	}
	want1 := []byte("\x1b[32mline 3\x1b[0m ok\r\n")
	want2 := []byte("\x1b[1;31mDONE\x1b[0m\r\n")
	if outputs[0].PaneID != "16" || !reflect.DeepEqual(outputs[0].Data, want1) {
		t.Fatalf("output[0]: pane=%q data=%q want pane=16 data=%q", outputs[0].PaneID, outputs[0].Data, want1)
	}
	if outputs[1].PaneID != "16" || !reflect.DeepEqual(outputs[1].Data, want2) {
		t.Fatalf("output[1]: pane=%q data=%q want pane=16 data=%q", outputs[1].PaneID, outputs[1].Data, want2)
	}
}

// TestFixtureMessageSequence: the full fixture yields the expected ordered
// kinds/types — an empty block, a session-changed control, two outputs, and a
// window-renamed control.
func TestFixtureMessageSequence(t *testing.T) {
	var st ParseState
	msgs := ParseControlMode(scratchRaw(t), &st)

	type want struct {
		kind MessageKind
		typ  string
	}
	expect := []want{
		{KindBlock, "%begin"},
		{KindControl, "%session-changed"},
		{KindOutput, "%output"},
		{KindOutput, "%output"},
		{KindControl, "%window-renamed"},
	}
	if len(msgs) != len(expect) {
		t.Fatalf("want %d messages, got %d: %+v", len(expect), len(msgs), msgs)
	}
	for i, w := range expect {
		if msgs[i].Kind != w.kind || msgs[i].Type != w.typ {
			t.Fatalf("msg[%d]: kind=%v type=%q want kind=%v type=%q", i, msgs[i].Kind, msgs[i].Type, w.kind, w.typ)
		}
	}
	// Block is empty (the %begin/%end pair had no captured lines).
	if msgs[0].Block == nil || len(msgs[0].Block.Data) != 0 {
		t.Fatalf("expected empty block, got %+v", msgs[0].Block)
	}
	// session-changed carries the session id and name as fields.
	if !reflect.DeepEqual(msgs[1].Fields, []string{"$16", "ccprobe"}) {
		t.Fatalf("session-changed fields=%v", msgs[1].Fields)
	}
}

// TestChunkBoundarySafety: feed the fixture split at every byte offset, threading
// one state, and assert the message sequence is identical each time. This is
// the defect a line-oriented parser over a stream always has, and exhaustive
// byte-offset splitting is the only way to find it.
func TestChunkBoundarySafety(t *testing.T) {
	raw := scratchRaw(t)
	reference := normalize(ParseControlMode(raw, &ParseState{}))
	for i := 1; i < len(raw); i++ {
		var st ParseState
		var got []ControlMessage
		got = append(got, ParseControlMode(raw[:i], &st)...)
		got = append(got, ParseControlMode(raw[i:], &st)...)
		got = append(got, ParseControlMode("", &st)...) // flush trailing pending
		if !reflect.DeepEqual(normalize(got), reference) {
			t.Fatalf("split at offset %d diverged:\nreference=%s\ngot=%s", i, dump(reference), dump(normalize(got)))
		}
	}
}

// TestCRLFAndBareLFIdentical: the same fixture with CRLF and with bare-LF line
// terminators parse to identical message sequences.
func TestCRLFAndBareLFIdentical(t *testing.T) {
	raw := scratchRaw(t)
	bare := stripCR(raw)
	crlf := bareLFToCRLF(bare)
	a := normalize(ParseControlMode(raw, &ParseState{}))
	b := normalize(ParseControlMode(bare, &ParseState{}))
	c := normalize(ParseControlMode(crlf, &ParseState{}))
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("CRLF vs bare-LF diverged:\nCRLF=%s\nLF=%s", dump(a), dump(b))
	}
	if !reflect.DeepEqual(a, c) {
		t.Fatalf("fixture vs resynthesised CRLF diverged:\nfixture=%s\nsynth=%s", dump(a), dump(c))
	}
}

// TestBlockStatefulParsing: a capture-pane response inside a %begin/%end block
// with a line beginning `%` (a zsh prompt) is surfaced as data, not parsed as a
// control message.
func TestBlockStatefulParsing(t *testing.T) {
	in := "%begin 100 7 0\r\nline one\r\n% zsh prompt here\r\n%output should be data\r\n%end 100 7 0\r\n"
	var st ParseState
	msgs := ParseControlMode(in, &st)
	if len(msgs) != 1 || msgs[0].Kind != KindBlock {
		t.Fatalf("want one block, got %+v", msgs)
	}
	b := msgs[0].Block
	if b.CommandNumber != "7" {
		t.Fatalf("command number=%q want 7", b.CommandNumber)
	}
	want := "line one\n% zsh prompt here\n%output should be data"
	if string(b.Data) != want {
		t.Fatalf("block data=%q want %q", b.Data, want)
	}
	if b.Error {
		t.Fatalf("block should not be errored")
	}
}

// TestExitMidBlockIsTerminal: %exit arriving inside an open block force-closes
// the block and emits the exit event, without waiting for a matching %end.
func TestExitMidBlockIsTerminal(t *testing.T) {
	in := "%begin 100 8 0\r\ncaptured line\r\n%exit\r\n"
	var st ParseState
	msgs := ParseControlMode(in, &st)
	if len(msgs) != 2 {
		t.Fatalf("want 2 messages (block + exit), got %d: %+v", len(msgs), msgs)
	}
	if msgs[0].Kind != KindBlock {
		t.Fatalf("msg[0] kind=%v want KindBlock", msgs[0].Kind)
	}
	if string(msgs[0].Block.Data) != "captured line" {
		t.Fatalf("block data=%q want %q", msgs[0].Block.Data, "captured line")
	}
	if msgs[1].Kind != KindControl || !msgs[1].Exit || msgs[1].Type != "%exit" {
		t.Fatalf("msg[1] = %+v want KindControl %%exit", msgs[1])
	}
	if st.block != nil {
		t.Fatalf("block should be closed after %%exit")
	}
}

// TestPayloadHighBytesRaw: bytes >= 0x80 pass through raw (not sanitised, not
// UTF-8 validated).
func TestPayloadHighBytesRaw(t *testing.T) {
	// Raw bytes 0xc3 0xa9 (UTF-8 for é) and 0xff pass through verbatim.
	in := "%output %5 \303\251\xff\r\n"
	var st ParseState
	msgs := ParseControlMode(in, &st)
	if len(msgs) != 1 || msgs[0].Kind != KindOutput {
		t.Fatalf("want one output, got %+v", msgs)
	}
	want := []byte{0xc3, 0xa9, 0xff}
	if !reflect.DeepEqual(msgs[0].Data, want) {
		t.Fatalf("data=%x want %x", msgs[0].Data, want)
	}
}

// TestPayloadBackslashEscaped: a `\` (0x5c) in the payload is escaped as `\134`
// and decodes back to `\`.
func TestPayloadBackslashEscaped(t *testing.T) {
	in := "%output %5 a\\134b\r\n"
	var st ParseState
	msgs := ParseControlMode(in, &st)
	if len(msgs) != 1 || msgs[0].Kind != KindOutput {
		t.Fatalf("want one output, got %+v", msgs)
	}
	want := []byte("a\\b")
	if !reflect.DeepEqual(msgs[0].Data, want) {
		t.Fatalf("data=%q want %q", msgs[0].Data, want)
	}
}

// TestPayloadNeverParsed: a payload containing %output, %begin, %exit or an
// embedded (escaped) newline is returned as data, not parsed as a control line.
func TestPayloadNeverParsed(t *testing.T) {
	cases := map[string]string{
		"contains %output": "%output %5 x\\033%output y\r\n",
		"contains %begin":  "%output %5 x\\033%begin z\r\n",
		"contains %exit":    "%output %5 x\\033%exit z\r\n",
		"embedded newline":  "%output %5 line1\\012line2\r\n",
	}
	for name, in := range cases {
		var st ParseState
		msgs := ParseControlMode(in, &st)
		if len(msgs) != 1 || msgs[0].Kind != KindOutput {
			t.Fatalf("%s: want one output, got %+v", name, msgs)
		}
	}
}

// TestUnknownTypeIgnored: an invented %future-thing is reported as ignored, not
// thrown.
func TestUnknownTypeIgnored(t *testing.T) {
	in := "%future-thing 1 2 3\r\n"
	var st ParseState
	msgs := ParseControlMode(in, &st)
	if len(msgs) != 1 || msgs[0].Kind != KindIgnored {
		t.Fatalf("want one ignored, got %+v", msgs)
	}
	if msgs[0].Type != "%future-thing" {
		t.Fatalf("type=%q want %%future-thing", msgs[0].Type)
	}
	if !reflect.DeepEqual(msgs[0].Fields, []string{"1", "2", "3"}) {
		t.Fatalf("fields=%v", msgs[0].Fields)
	}
}

// TestNoSideEffects: the parser is a pure function — it returns messages and a
// remainder in state, and does not write to any ring, log, or WS client. We
// assert the structural contract: feeding the same input to a fresh state
// yields the same output (deterministic, no hidden state), and the state holds
// only the partial line and block.
func TestNoSideEffects(t *testing.T) {
	raw := scratchRaw(t)
	a := ParseControlMode(raw, &ParseState{})
	b := ParseControlMode(raw, &ParseState{})
	if !reflect.DeepEqual(normalize(a), normalize(b)) {
		t.Fatalf("parser is non-deterministic across calls with fresh state")
	}
	// A second call with empty input on a finished stream yields nothing and
	// leaves no dangling block.
	var st ParseState
	_ = ParseControlMode(raw, &st)
	more := ParseControlMode("", &st)
	if len(more) != 0 || st.block != nil {
		t.Fatalf("trailing call produced %d messages, block=%v", len(more), st.block)
	}
}

// --- helpers ---

// stripCR removes all CR from s.
func stripCR(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] != '\r' {
			out = append(out, s[i])
		}
	}
	return string(out)
}

// bareLFToCRLF converts bare-LF terminators to CRLF.
func bareLFToCRLF(s string) string {
	return byteReplace(s, "\n", "\r\n")
}

func byteReplace(s, old, new string) string {
	var b []byte
	for i := 0; i < len(s); {
		if i+len(old) <= len(s) && s[i:i+len(old)] == old {
			b = append(b, new...)
			i += len(old)
		} else {
			b = append(b, s[i])
			i++
		}
	}
	return string(b)
}

func containsBytes(hay, needle []byte) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i+len(needle) <= len(hay); i++ {
		if reflect.DeepEqual(hay[i:i+len(needle)], needle) {
			return true
		}
	}
	return false
}

// normalize strips volatile byte slices down to a comparable form.
type normMsg struct {
	Kind   MessageKind
	Type   string
	PaneID string
	Data   string
	Fields []string
	Exit   bool
	Block  *normBlock
}

type normBlock struct {
	Time          string
	CommandNumber string
	Flags         string
	Data          string
	Error         bool
}

func normalize(msgs []ControlMessage) []normMsg {
	out := make([]normMsg, 0, len(msgs))
	for _, m := range msgs {
		nm := normMsg{Kind: m.Kind, Type: m.Type, PaneID: m.PaneID, Data: string(m.Data), Fields: m.Fields, Exit: m.Exit}
		if m.Block != nil {
			nm.Block = &normBlock{Time: m.Block.Time, CommandNumber: m.Block.CommandNumber, Flags: m.Block.Flags, Data: string(m.Block.Data), Error: m.Block.Error}
		}
		out = append(out, nm)
	}
	return out
}

func dump(msgs []normMsg) string {
	b, _ := json.MarshalIndent(msgs, "", "  ")
	return string(b)
}

// TestExtendedOutputIsPaneOutput: with flow control armed (`pause-after`, which
// sendFlowControlLocked issues on every attach) tmux emits %extended-output
// INSTEAD of %output — measured on tmux 3.4 as 6707 vs 14 on a busy pane. It
// must decode to pane output; classifying it as a notification renders a blank
// pane and an empty transcript.
func TestExtendedOutputIsPaneOutput(t *testing.T) {
	in := "%extended-output %49 294 : hi\\015\\012\r\n"
	var st ParseState
	msgs := ParseControlMode(in, &st)
	if len(msgs) != 1 {
		t.Fatalf("want 1 message, got %d: %+v", len(msgs), msgs)
	}
	if msgs[0].Kind != KindOutput {
		t.Fatalf("kind=%v want KindOutput (extended-output is pane data)", msgs[0].Kind)
	}
	if msgs[0].PaneID != "49" {
		t.Fatalf("pane=%q want 49", msgs[0].PaneID)
	}
	if string(msgs[0].Data) != "hi\r\n" {
		t.Fatalf("data=%q want %q", msgs[0].Data, "hi\r\n")
	}
}

// TestBlockDataIsNotOctalDecoded: capture-pane replies are NOT \ooo-escaped.
// Measured on tmux 3.4: a pane showing the literal text \033[31m came back from
// `capture-pane -peqJN -S -50000` as the raw bytes \,0,3,3. Decoding it turned
// scrollback text into a live ESC and injected escape sequences into the pane,
// the ring and the log.
func TestBlockDataIsNotOctalDecoded(t *testing.T) {
	in := "%begin 100 9 0\r\nLIT:\\033[31m TAIL:\\134\r\n%end 100 9 0\r\n"
	var st ParseState
	msgs := ParseControlMode(in, &st)
	if len(msgs) != 1 || msgs[0].Kind != KindBlock {
		t.Fatalf("want one block, got %+v", msgs)
	}
	want := "LIT:\\033[31m TAIL:\\134"
	if string(msgs[0].Block.Data) != want {
		t.Fatalf("block data=%q want %q (block content must stay verbatim)", msgs[0].Block.Data, want)
	}
}

// TestDecodeCaptureC: `capture-pane -C` uses its own scheme — backslash doubled,
// non-printables as \ooo — which is NOT the %output scheme.
func TestDecodeCaptureC(t *testing.T) {
	if got := string(decodeCaptureC("a\\\\b")); got != "a\\b" {
		t.Fatalf("doubled backslash: got %q want %q", got, "a\\b")
	}
	if got := string(decodeCaptureC("x\\033y")); got != "x\x1by" {
		t.Fatalf("octal: got %q want %q", got, "x\x1by")
	}
	if got := string(decodeCaptureC("plain")); got != "plain" {
		t.Fatalf("passthrough: got %q want %q", got, "plain")
	}
}
