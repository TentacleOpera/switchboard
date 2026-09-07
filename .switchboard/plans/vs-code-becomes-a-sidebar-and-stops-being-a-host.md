# VS Code Becomes a Sidebar, and Stops Being a Second Host

kanbanColumn: CREATED

## Goal

The extension keeps its sidebar and loses everything else: no editor panels, and — the part that
matters — no board of its own. It spawns or attaches to the standalone host and talks to it over
HTTP like the browser does. One host, one UI, one implementation.

### Problem analysis

**The extension costs more than it returns, and the value it removes is the product's main claim.**
A board inside an editor is not always-on: close the window and the fleet's supervisor goes with it.
The always-on board is the reason to run Switchboard on a Pi at all, and the extension is the one
deployment that cannot have it.

**Its UI is worse, and it makes the browser's UI worse too.** This is the part that is easy to
miss: the webviews are shared, so they must satisfy the VS Code webview sandbox **even when served
to a browser**. That sandbox is why `confirm()` is a silent no-op, why the frozen webview API killed
originator stamping, why every page carries CSP nonces, and why the panel font stack has no symbol
glyphs. A browser user pays for constraints imposed by a host they are not running.

**Two hosts is the single largest source of defects in this codebase, by its own account.**
`CLAUDE.md`'s second rule exists only because of the extension, and its worked example is four
`PlanIngestionEngine` queue seams wired in `extension.ts` alone for a month. Four more divergences
turned up in one evening. The defence against it is:

```
standalone-parity:check      parity:check      host-seam-parity:check
+ 6 parity/standalone test files
npm test leads with standalone-parity:check
```

Three gates, and the rule itself records that `standalone-parity:check` is *"scoped to the browser
read-back path, not the composition root"* — so it does not catch the class it was built for.

**The carrying cost, measured:**

```
vscodeShim.ts                    608 lines — a fake VS Code API so shared services run headless
service files importing vscode   32 of 124
vscode.* call sites              274 in TaskViewerProvider, 103 in KanbanProvider
editor panels                    8 createWebviewPanel sites across 7 providers
sidebar                          1 registerWebviewViewProvider (extension.ts:1130)
```

The density is the encouraging part: 274 call sites in 28,942 lines is about **1%**.
`TaskViewerProvider` is overwhelmingly host-agnostic logic wearing a thin VS Code veneer.

**And it is the last obstacle to every architectural option.** A Go core, a sidecar, one prompt
builder — each ends at "but the extension needs it in-process". Remove that and they become
ordinary engineering decisions.

## Metadata

- **Complexity:** 9
- **Tags:** architecture, extension, standalone, ux, both-hosts

## User Review Required

None. The staging below is the decision; both stages are specified.

## Proposed Changes

### Stage 1 — the panels leave the editor

Delete the eight `createWebviewPanel` sites (Kanban, Agent Control, Planning, Project, Setup,
Tickets, Design, Connections). The commands that opened them **open the browser instead**, on the
running host's URL. A command that used to open a panel must not disappear — ~4,000 installs have
muscle memory and keybindings, and a command that silently vanishes reads as a broken upgrade.

The sidebar (`switchboard-view`) stays exactly as it is in this stage.

### Stage 2 — the extension stops being a host

This is the stage that pays. Today the extension constructs `LocalApiServer` in-process and owns its
own database, fleet and watcher. After this it does neither: it **spawns or attaches to the
standalone host** and the sidebar talks HTTP, the same endpoints the browser uses.

Then, and only then:

- **The no-divergence rule retires.** There is one composition root. Delete
  `standalone-parity:check`, `host-seam-parity:check` and the parity test files — but rewrite them
  as assertions that the extension holds **no** host state, rather than deleting them outright. A
  deleted guard is how the second host grows back.
- **`vscodeShim.ts` goes**, along with the vscode imports in the 32 contaminated service files.
  Those services stop being "shared" and become simply "the product".
- **The webviews leave the sandbox.** `confirm()`, CSP nonces, the frozen API and the font stack
  stop being constraints on a browser UI.

Stage 1 without stage 2 removes duplicated UI and leaves two hosts. Do not stop there.

### Stage 3 — what the sidebar is for

Once it is a client, the sidebar should stop imitating the board. Its job is what an editor is
uniquely good at: **is the host up, what are my seats doing, and take me to the board.** Fleet and
terminal status, the current workspace, start/attach, open in browser.

It must not become a second board. That is how this grows back.

### Stage 4 — the settings that were VS Code's

88 configuration keys are contributed to VS Code's settings UI. An extension that is no longer the
host cannot own them.

Most should move to the settings window (`307d08aa`) and its store. Keep in `package.json` only what
VS Code genuinely needs — how to find or launch the host. **Every key that moves needs a migration
that reads the old value once**, per the shipped-state rule; ~4,000 installs have these set and
silently losing them is worse than any UI gain here.

## Edge-Case & Dependency Audit

1. **~4,000 installs, and this is the largest migration this product has attempted.** An upgrade
   must leave a working install: commands still exist and redirect, settings are read once and
   carried, and no board data is touched. A user who updates and finds an empty editor will not
   investigate.
2. **Marketplace discovery is the only channel of its kind.** `apt` and `npx` have no equivalent.
   Hollowing the extension keeps it; deleting it does not. That is the argument for a sidebar over
   removal, and it is a distribution argument, not a technical one.
3. **The extension must handle "no host running".** Today it *is* the host. After stage 2 the
   sidebar's first job is starting or attaching to one, and the failure mode when it cannot must be
   explicit rather than an empty panel.
4. **Which process owns the PTYs.** The fleet moves to the standalone host. Terminals a user
   expects to see in the editor now live elsewhere — decide what the sidebar shows and how a user
   reaches a live terminal, before stage 2 lands.
5. **Do not do stages 1 and 2 in one release.** Stage 1 is reversible and low-risk; stage 2 changes
   where the database lives for every extension user. Ship them apart so a regression has one cause.
6. **`DiagramRenderer` and `ConnectionsPanelProvider` are extension-only** — they are among the four
   service classes absent from the standalone bundle. They have no browser equivalent yet, so
   deleting their panels deletes the feature unless it is ported first.
7. **This unblocks the Go work but must not wait for it.** `Go Where It Pays` and a possible sidecar
   both become simpler once there is one host; neither is a prerequisite here.

## Verification Plan

1. After stage 1, every command that previously opened a panel opens the browser on the running
   host, and no command has been removed from the palette.
2. After stage 1, `grep -c createWebviewPanel src/` returns zero outside `DiagramRenderer` and
   whatever change 6 decided.
3. After stage 2, the extension constructs no `LocalApiServer`, opens no database, and spawns no
   PTY — verified by reading `extension.ts`, not by the UI appearing to work.
4. With no host running, the sidebar offers to start one and says so plainly when it cannot.
5. With a host already running, the sidebar attaches rather than starting a second — the
   single-writer refusal is never shown to a user.
6. `vscodeShim.ts` is deleted and no service file imports `vscode`.
7. The parity checkers are replaced by assertions that the extension holds no host state, and those
   assertions fail if a `LocalApiServer` construction is reintroduced.
8. An upgrade from the current release leaves board data untouched, every migrated setting carrying
   its previous value, and the sidebar working on first launch with no manual step.
9. A browser user sees no CSP nonce, no dead `confirm()`, and no sandbox-imposed limitation that
   only existed for the editor.
