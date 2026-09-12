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

import "testing"

// noSuchSession is not a valid live session on any machine: `tmux new-session`
// rejects `:` in a session name, so nothing can ever create one to match it.
const noSuchSession = "switchboard:resize-test:absent"

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
