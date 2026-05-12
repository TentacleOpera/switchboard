# Architectural Refactor 3/4: Remove Distributed State

## Goal

Phase 3 of Workspace Single Source of Truth refactor.
With all call sites updated, safely remove the unused fields and methods that represented the distributed state.

## Metadata

**Tags:** backend, infrastructure, reliability, workflow
**Complexity:** 2

## Dependencies

- sess_1777759329250 — Architectural Refactor 2/4: Update All Call Sites

## Proposed Changes

### Phase 3: Remove Distributed State

#### [DELETE] `src/services/TaskViewerProvider.ts:311` — Remove _activeWorkspaceRoot field

**Context:** Private field declaration at line 311.

**Logic:** Delete the field only after ALL read/write sites have been migrated to kanban provider (done in Phase 2).

**Implementation:**
```typescript
// Line 311: DELETE after all usages migrated
private _activeWorkspaceRoot: string | null = null;
```

#### [DELETE] `src/services/TaskViewerProvider.ts:472-521` — Remove _resolveWorkspaceRoot method

**Context:** Lines 472-521 containing `_resolveWorkspaceRoot` method.

**Logic:** Entire method becomes unnecessary — kanban is the single source of truth. Replace with direct getter call.

**Implementation:**
```typescript
// DELETE entire _resolveWorkspaceRoot method

// NEW: Simplified resolution that delegates to kanban
public resolveWorkspaceRoot(): string | null {
    return this._kanbanProvider?.getCurrentWorkspaceRoot() ?? null;
}
```

#### [MODIFY] `src/extension.ts:1093` — Remove activation-time workspace capture

**Context:** Line 1093 where `workspaceRoot` is captured at activation using `getPreferredWorkspaceRoot()`.

**Logic:** Do not capture workspace at activation time. Instead, initialize the `KanbanProvider` which handles its own initialization based on user settings to preserve UX.

**Implementation:**
```typescript
// BEFORE (line 1093):
const workspaceRoot = getPreferredWorkspaceRoot();

// AFTER:
// REMOVED: Activation-time workspace capture eliminated.
const kanbanProvider = new KanbanProvider(context.extensionUri, context, mcpOutputChannel);

// NEW: Auto-initialize workspace state to preserve UX
kanbanProvider.initializeDefaultWorkspace();

// Where workspaceRoot was previously used directly, now read from kanban (or let components listen to events):
// OLD: if (workspaceRoot) { ... }
// NEW: const currentWorkspace = kanbanProvider.getCurrentWorkspaceRoot();
//      if (currentWorkspace) { ... }
```

## Success Criteria
1. Zero cached workspace state outside `KanbanProvider`.
2. No auto-fallback to `roots[0]` anywhere in codebase.
