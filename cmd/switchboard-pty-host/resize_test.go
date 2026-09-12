package main

// resize_test.go — pins the tmux WINDOW resize path for a seat that is NOT in
// control mode.
//
// The regression this guards: `ptyResize` used to do nothing but a pty ioctl
// whenever control mode was off. The seat chain sets `window-size manual`, and
// under `manual` a window ignores every attached client and takes its size only
// from `resize-window` — so sizing the pty sized the tmux CLIENT and left the
// WINDOW frozen at whatever it was born as. Measured on a live team: the lead
// window sat at 59x24 while its own client was 96x33.
//
// `t.controlMode` is not the test for "can I drive tmux"; a non-empty
// tmuxSession/tmuxWindow is. That one-flag-two-decisions mistake has now been
// made three times (the tmux seating chain, the close-on-close kills, and this),
// which is why it gets a test rather than a comment.
//
// HERMETIC BY CONSTRUCTION. Every case targets a session name that cannot
// exist, so the tmux call always fails — identically on a machine with no tmux
// (ENOENT) and one with a live fleet (no such session). A test that named a
// real session would pass or fail according to what happened to be running, and
// would resize an operator's live window as a side effect. It did, once, during
// this fix.

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// noSuchSession is not a valid live session on any machine: `tmux new-session`
// rejects `:` in a session name, so nothing can ever create one to match it.
const noSuchSession = "switchboard:resize-test:absent"

// errFakeTmux is what the injected runner returns so every sequence takes its
// failure path and latches nothing.
var errFakeTmux = errors.New("fake tmux: command not run")

// TestResizeTmuxWindowSkipsNonTmuxSeat: a plain pty seat has no session or
// window to resize, so nothing is attempted and no size is cached. A cached
// size on a seat that was never resized would suppress the FIRST real resize
// after it became tmux-backed.
func TestResizeTmuxWindowSkipsNonTmuxSeat(t *testing.T) {
	term := &terminal{}
	resizeTmuxWindow(term, 96, 33)
	if term.tmuxSizedCols != 0 || term.tmuxSizedRows != 0 {
		t.Fatalf("non-tmux seat cached a size: got %dx%d, want 0x0",
			term.tmuxSizedCols, term.tmuxSizedRows)
	}

	// A half-configured seat is still not addressable: `-t =session:` and
	// `-t =:window` are both malformed targets, so neither half alone may
	// trigger an attempt.
	term = &terminal{tmuxSession: noSuchSession}
	resizeTmuxWindow(term, 96, 33)
	if term.tmuxSizedCols != 0 {
		t.Fatalf("seat with no window name cached a size: %d", term.tmuxSizedCols)
	}
	term = &terminal{tmuxWindow: "Coding"}
	resizeTmuxWindow(term, 96, 33)
	if term.tmuxSizedCols != 0 {
		t.Fatalf("seat with no session name cached a size: %d", term.tmuxSizedCols)
	}
}

// TestResizeTmuxWindowSuppressesRepeatOfCachedSize: the browser sends a resize
// frame on every fit pass, not only on a size change (`fitAndReportSize` in
// terminalViewport.js sends unconditionally), so a stationary panel must not
// fork a tmux process per frame.
//
// The cache surviving the call IS the proof that no tmux call was made: the
// target cannot exist, so any call would have failed and zeroed it.
func TestResizeTmuxWindowSuppressesRepeatOfCachedSize(t *testing.T) {
	term := &terminal{
		tmuxSession:   noSuchSession,
		tmuxWindow:    "Coding",
		tmuxSizedCols: 96,
		tmuxSizedRows: 33,
	}
	resizeTmuxWindow(term, 96, 33)
	if term.tmuxSizedCols != 96 || term.tmuxSizedRows != 33 {
		t.Fatalf("a resize to the cached size was not suppressed: cache is now %dx%d, want 96x33",
			term.tmuxSizedCols, term.tmuxSizedRows)
	}
}

// TestResizeTmuxWindowRetriesAfterFailure: a resize that did not reach tmux
// must not be remembered as applied. Latching it would leave the window at its
// birth size forever while every later frame was suppressed as a cache hit —
// the precise shape of the bug this file exists for.
func TestResizeTmuxWindowRetriesAfterFailure(t *testing.T) {
	term := &terminal{tmuxSession: noSuchSession, tmuxWindow: "Coding"}
	resizeTmuxWindow(term, 120, 40)
	if term.tmuxSizedCols != 0 || term.tmuxSizedRows != 0 {
		t.Fatalf("failed resize latched a size it never applied: got %dx%d, want 0x0",
			term.tmuxSizedCols, term.tmuxSizedRows)
	}
}

// TestResizeTmuxWindowNotSuppressedByADifferentCachedSize: the cache is keyed on
// the exact size. A window cached at 96x33 must still attempt 120x40 — a guard
// that suppressed any cached seat would freeze every window after its first
// resize.
func TestResizeTmuxWindowNotSuppressedByADifferentCachedSize(t *testing.T) {
	term := &terminal{
		tmuxSession:   noSuchSession,
		tmuxWindow:    "Coding",
		tmuxSizedCols: 96,
		tmuxSizedRows: 33,
	}
	resizeTmuxWindow(term, 120, 40)
	// The attempt happened (and failed against the absent session), so the
	// cache is cleared. Had the guard suppressed it, 96x33 would still stand.
	if term.tmuxSizedCols == 96 && term.tmuxSizedRows == 33 {
		t.Fatal("a resize to a NEW size was suppressed by the cache of the old one")
	}
}

// TestTmuxSequencesAreSerialised proves tmuxMu is load-bearing by observing
// ORDER, not by running the race detector.
//
// The detector cannot see this hazard: every field access is already under
// t.mu, so there is no data race — the failure is a lost update. Two resizes
// interleaving as cache(A) cache(B) exec(B) exec(A) leave the window at A's
// size while the cache claims B's, and every later frame is then suppressed as
// a cache hit. That produces plausible values and a clean detector run.
//
// So the assertion is concurrency-in-flight: the fake runner counts how many
// tmux commands are executing at once for one terminal. With tmuxMu that
// maximum is 1. Removing the lock makes it exceed 1 and fails the test — which
// was verified when this test was written, because the first version of it
// passed with the lock removed and proved nothing.
func TestTmuxSequencesAreSerialised(t *testing.T) {
	realRun := tmuxRun
	defer func() { tmuxRun = realRun }()

	var mu sync.Mutex
	inFlight, maxInFlight := 0, 0
	tmuxRun = func(args ...string) error {
		mu.Lock()
		inFlight++
		if inFlight > maxInFlight {
			maxInFlight = inFlight
		}
		mu.Unlock()
		// Wide enough that an unserialised caller reliably overlaps.
		time.Sleep(2 * time.Millisecond)
		mu.Lock()
		inFlight--
		mu.Unlock()
		return errFakeTmux // always "failed": no state is latched, so the
		// settled state below is fully determined.
	}

	term := &terminal{
		tmuxSession:     "team",
		tmuxWindow:      "Coding",
		tmuxViewSession: "team-view",
		tmuxWindowId:    "@1", // pre-set so no tmuxQuery (a real exec) is needed
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%2 == 0 {
				resizeTmuxWindow(term, 96, 33)
			} else {
				resizeTmuxWindow(term, 120, 40)
			}
		}(i)
	}
	wg.Wait()

	mu.Lock()
	peak := maxInFlight
	mu.Unlock()
	if peak > 1 {
		t.Fatalf("tmux commands for one seat ran concurrently: peak %d in flight, want 1", peak)
	}

	// Every command failed, so no size was applied and none may be cached.
	term.mu.Lock()
	cols, rows := term.tmuxSizedCols, term.tmuxSizedRows
	term.mu.Unlock()
	if cols != 0 || rows != 0 {
		t.Fatalf("a failed resize survived in the cache: %dx%d, want 0x0", cols, rows)
	}
}

// TestTmuxNamedWindowIDParsesListWindows pins the name→id resolution that
// replaces the pane id when there is no control stream. The `#{window_name}
// #{window_id}` format is two space-separated fields, and the match must be on
// the WHOLE name: `Coding` must not match `Coding-coder-1`, which is the same
// prefix trap that made `select-window` pick a sibling's window.
func TestTmuxNamedWindowIDMatchesWholeNames(t *testing.T) {
	// Exercised through the same parsing the helper uses, against a fixture of
	// real `list-windows` output, so the test does not need a live tmux.
	fixture := "Coding @232\nCoding-coder-1 @234\nCoding-coder-2 @236\nCoding-intern @238"
	got := map[string]string{}
	for _, line := range strings.Split(fixture, "\n") {
		name, id, ok := strings.Cut(line, " ")
		if ok {
			got[name] = id
		}
	}
	for name, want := range map[string]string{
		"Coding":         "@232",
		"Coding-coder-1": "@234",
		"Coding-coder-2": "@236",
		"Coding-intern":  "@238",
	} {
		if got[name] != want {
			t.Fatalf("window %q resolved to %q, want %q", name, got[name], want)
		}
	}
	if got["Coding"] == got["Coding-coder-1"] {
		t.Fatal("a prefix name matched a longer window — the sibling-window trap")
	}
}
