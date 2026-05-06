# Architectural Refactor 1/4: Event System Foundation

## Goal

Begin the architectural refactor for Workspace Single Source of Truth.
Eliminate distributed workspace state by making the kanban workspace switcher the sole authority for workspace selection across the entire extension. 
This first phase focuses on auditing the existing usages and adding the foundational event system to `KanbanProvider`.

## Metadata

**Tags:** backend, infrastructure, reliability, workflow
**Complexity:** 3

## Dependencies

- sess_1777585484209 — Fix Workspace Switching Bugs
- sess_1777421958753 — Workspace-to-Database Mapping Feature
- sess_1776749089776 — Fix Cross-Workspace Brain File Contamination

## Proposed Changes

### Pre-Phase: Call Site Enumeration and Categorization

**Purpose:** Before any code changes, enumerate all 143+ `_activeWorkspaceRoot` usages to categorize risk.

#### [AUDIT] TaskViewerProvider.ts — Complete usage inventory

**Context:** Run grep to identify all usages and classify by context type.

**Command:**
```bash
grep -n "_activeWorkspaceRoot" src/services/TaskViewerProvider.ts | wc -l  # Expect ~143
grep -n "_resolveWorkspaceRoot" src/services/TaskViewerProvider.ts | wc -l   # Expect ~20+
```

**Classification criteria:**
- **SYNC_READ**: Read in sync context (constructor, getter, sync method) — HIGH RISK
- **SYNC_WRITE**: Assignment in sync context — HIGH RISK
- **ASYNC_READ**: Read in async method — LOWER RISK
- **ASYNC_WRITE**: Assignment in async method — MEDIUM RISK
- **INIT**: Constructor or initialization path — SPECIAL HANDLING

**Deliverable:** Create `switchboard/refactor-audit.md` with table of all usages and migration strategy per category.

---

### Phase 1: Event System Foundation

#### [MODIFY] `src/services/KanbanProvider.ts:139` — Add workspace change event and initialization

**Context:** After `_currentWorkspaceRoot` declaration (line 139). Need to emit events when workspace changes so other components can react, and provide an auto-initialization method to preserve startup UX.

**Logic:** Add EventEmitter pattern for workspace changes. Emit whenever `_currentWorkspaceRoot` is modified. Add an initialization method.

**Implementation:**
```typescript
// After line 139 (_currentWorkspaceRoot declaration)
private _currentWorkspaceRoot: string | null = null;

// NEW: Event system for workspace changes
private _onWorkspaceChangeEmitter = new vscode.EventEmitter<string | null>();
public readonly onWorkspaceChange = this._onWorkspaceChangeEmitter.event;

// NEW: Controlled setter that emits events
public setCurrentWorkspaceRoot(workspaceRoot: string | null): void {
    const oldRoot = this._currentWorkspaceRoot;
    if (oldRoot === workspaceRoot) { return; }
    
    this._currentWorkspaceRoot = workspaceRoot;
    this._onWorkspaceChangeEmitter.fire(workspaceRoot);
    console.log(`[KanbanProvider] Workspace changed: ${oldRoot} → ${workspaceRoot}`);
}

// NEW: Auto-initialization to preserve UX (called from extension.ts)
public initializeDefaultWorkspace(): void {
    const config = vscode.workspace.getConfiguration('switchboard');
    if (!config.get<boolean>('autoSelectFirstWorkspace', true)) {
        return; // User explicitly disabled auto-selection
    }
    
    if (!this._currentWorkspaceRoot) {
        const roots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
        if (roots.length > 0) {
            this.setCurrentWorkspaceRoot(roots[0]);
        }
    }
}
```

#### [MODIFY] `src/services/KanbanProvider.ts:460,467` — Update all internal mutations

**Context:** Lines 460 and 467 where `_currentWorkspaceRoot` is assigned directly. Use setter instead.

**Logic:** Replace direct assignment with controlled setter.

**Implementation:**
```typescript
// Line 460: Replace direct assignment
// BEFORE:
this._currentWorkspaceRoot = resolved;
// AFTER:
this.setCurrentWorkspaceRoot(resolved);

// Line 467: Replace direct assignment
// BEFORE:
this._currentWorkspaceRoot = roots[0] || Array.from(allowedRoots)[0];
// AFTER:
this.setCurrentWorkspaceRoot(roots[0] || Array.from(allowedRoots)[0]);
```

## Verification Plan

### Unit Tests

**Test: Workspace change event emitted**
```typescript
it('should emit event when workspace changes', async () => {
    const events: (string | null)[] = [];
    kanbanProvider.onWorkspaceChange((ws) => events.push(ws));
    
    kanbanProvider.setCurrentWorkspaceRoot('/workspaceA');
    kanbanProvider.setCurrentWorkspaceRoot('/workspaceB');
    
    expect(events).toEqual(['/workspaceA', '/workspaceB']);
});
```

**Test: No event on duplicate workspace**
```typescript
it('should not emit when setting same workspace', () => {
    let emitCount = 0;
    kanbanProvider.onWorkspaceChange(() => emitCount++);
    
    kanbanProvider.setCurrentWorkspaceRoot('/workspaceA');
    kanbanProvider.setCurrentWorkspaceRoot('/workspaceA');
    
    expect(emitCount).toBe(1);
});
```

## Success Criteria
1. Audit is complete.
2. `KanbanProvider` successfully emits change events.
