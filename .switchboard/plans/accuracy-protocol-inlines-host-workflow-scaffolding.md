# The Accuracy Protocol Inlines Host-Workflow Scaffolding a Coder Cannot Use

kanbanColumn: CREATED

## Goal

When the accuracy protocol is embedded into a dispatched coder's prompt, it carries the steps and nothing else. No slash command, no artifact system, no delegation vocabulary, no phase state machine.

### Problem analysis

`accuracy` is stored in `control_plane` with `delivery=inline` and a body of **4,732 bytes**, and `buildAccuracyDirective` (`protocolDirectives.ts:148`) embeds that body verbatim into the prompt. Every dispatched coder with Accuracy Mode on receives all of it.

Most of it is scaffolding from the host workflow it used to be, and is either meaningless or actively wrong in an inlined prompt:

**`## File Creation Rules`** — *"always use `IsArtifact: false` to prevent path validation errors."* This one is **real and must not be cut**. `IsArtifact` is an Antigravity tool parameter and the rule is load-bearing there — an Antigravity seat that omits it hits path validation errors writing into `.switchboard/`. It is noise only for seats that have no such parameter (Claude Code, Devin).

So this section is what proves the trim has to be **host-conditional, not a deletion**: one static body is dispatched to seats with different tool vocabularies, and no single string is correct for all of them. Everything listed below it, by contrast, is wrong on *every* host including Antigravity, because it describes a conversational workflow that no dispatched seat is in.

**`## No-Artifact Rule`** — *"`/accuracy` is a solo, in-conversation workflow. Do NOT write out artifacts to disk."* Names a slash command the agent did not invoke and cannot invoke, to forbid an artifact system it does not have.

**`## Quick Reference` — *"Valid Actions: None (solo workflow, no cross-agent delegation)"*** — "Valid Actions" is the `send_message` vocabulary, which `CLAUDE.md` states is Antigravity-only and to be ignored. The section exists to say the list is empty.

**Step 1** — *"Activate accuracy mode via the `/accuracy` command."* The agent did not activate anything; the body was inlined into its prompt by the dispatcher. The first instruction it reads describes something that already happened, by a mechanism it has no access to.

**MCP reference** — the same step mentions MCP tool availability. Switchboard removed its MCP server.

**`## Final-Phase Recovery Rule`** — *"use the Kanban UI to manually move the card."* A dispatched agent has no UI, and the control plane forbids agents moving cards. It also carries phase-completion bookkeeping — *"Mark Phase 5 complete in your reply. The workflow automatically terminates when all phases are done"* — describing a state machine that does not exist on this path.

**Why it matters beyond tidiness.** Inlined bodies are re-presented in full on every dispatch that enables the mode, so this is paid per dispatch, per seat. It also instructs the coder to do impossible things, which is worse than saying nothing: an agent that looks for a `/accuracy` command it cannot invoke is spending turns on scaffolding rather than the task.

## Metadata

- **Complexity:** 2
- **Tags:** prompts, control-plane, protocols

## User Review Required

None.

## Proposed Changes

### 1. Cut the sections that only make sense as a host workflow

Remove `File Creation Rules`, `No-Artifact Rule`, `Quick Reference`, and `Final-Phase Recovery Rule`. Strip the `/accuracy` activation from step 1 and the MCP reference alongside it.

What should survive is the method — the phases and what each requires — and nothing about how the protocol was invoked or how a workflow engine tracks it.

### 2. Rewrite step 1 for a reader who was handed the body

It should open with what the agent is being asked to do, not with how the mode was activated. The agent already has the text; telling it how to obtain the text is the one instruction guaranteed to be useless.

### 3. Check the other twelve inline protocols for the same scaffolding

`accuracy` is one of **13** rows with `delivery=inline`. They came from the same workflow format, so the same sections are likely present in others, paid on the same per-dispatch basis.

Audit them together rather than fixing this one and rediscovering it later.

### 4. Keep the body in the database, not in a file

The fix is to the `control_plane` row's content. Do not solve this by materialising the protocol to disk instead — inline delivery is correct for something the agent must have in front of it, and the storage overhaul moved these into the database deliberately.

## Edge-Case & Dependency Audit

1. **The `materialize` protocols may legitimately keep some of this.** A protocol read from a file by an agent that invoked it by name has a different context from one pasted into a prompt. Do not apply the same cut blindly to all 61 materialised rows.
2. **`buildAccuracyDirective` handles the unresolved case correctly** — it emits *"resolve via `switchboard api GET /protocol/accuracy`"* rather than a path. That behaviour stays.
3. **Changing a `control_plane` row changes what every future dispatch carries.** Confirm how the row is edited and versioned — it has `version` and `content_hash` columns — rather than writing to it directly.
4. **Host-conditional emission needs a default that fails visibly.** The dispatcher knows the seat's CLI family, so the file-creation rule can be emitted for Antigravity and withheld elsewhere. An **unrecognised family must keep the line**: a stray instruction costs a seat nothing, while dropping it breaks an Antigravity seat's writes. Guessing "not Antigravity" is the quiet failure; guessing "Antigravity" is the visible, harmless one.
5. **The trimmed body still has to teach the method.** The risk in cutting is going too far and leaving a coder without the phases; the sections named above are the ones that describe the *host*, not the work.

## Verification Plan

1. A dispatched coder with Accuracy Mode on receives no reference to `/accuracy`, artifacts, Valid Actions, MCP, or the Kanban UI.
2. An **Antigravity** seat still receives the `IsArtifact: false` file-creation rule, and so does a seat of unrecognised CLI family. Only a seat known to be Claude Code or Devin has it withheld.
3. The inlined body is materially smaller than 4,732 bytes.
4. It still contains every phase and what each requires.
5. The unresolved-protocol fallback still names the API call rather than a path.
6. The other twelve inline protocols have been checked for the same sections.
