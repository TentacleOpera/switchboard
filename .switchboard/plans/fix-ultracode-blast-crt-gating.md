# Fix: ULTRACODE blast incorrectly gated behind CRT artifact animation

## Metadata
**Complexity:** 2
**Tags:** bugfix, frontend, ui
**Project:** 

## Goal

The afterburner ULTRACODE slam animation (triggered by toggling Feature Ultracode on in `kanban.html`) is incorrectly suppressed when the unrelated "Artifacts panel animation" (CRT sweep beam) toggle is off. These are two independent animations with independent setup toggles and must not gate each other.

### Root cause

`fireUltracodeBlast()` in `kanban.html` (line ~4769) checks three body classes before firing:

1. `cyber-theme-enabled` — correct (Afterburner theme required).
2. `cyber-animation-disabled` — **wrong**. This class is driven by the "Enable Artifacts panel animation" toggle in setup, which controls the rolling CRT sweep beam in the planning panel preview. It has nothing to do with the ULTRACODE slam.
3. `ultracode-animation-enabled` — correct (the dedicated ultracode animation toggle).

Gate ② is the bug. Setup exposes three independent toggles (Artifacts animation, CRT scanlines, Feature Ultracode animation), so disabling the CRT artifact animation should not suppress the ultracode slam.

## Changes

**File:** `src/webview/kanban.html`

1. Remove the `cyber-animation-disabled` guard from `fireUltracodeBlast()`.
2. Update the preceding comment to stop claiming the blast is "skipped when cyber animations are disabled."

No other files change. The setup toggles, message handlers, and persistence are already independent and correct.

## Verification

- With Afterburner theme + ultracode animation ON + artifacts animation OFF: blast fires.
- With Afterburner theme + ultracode animation OFF: blast does not fire.
- With non-Afterburner theme: blast does not fire.
