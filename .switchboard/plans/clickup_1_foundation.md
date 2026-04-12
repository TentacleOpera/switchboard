# ClickUp Integration — Part 1: REST API Foundation & Token Management

## Goal

Create the foundational `ClickUpSyncService` class with a direct ClickUp REST API client, secure token storage via VS Code SecretStorage, configuration file schema, and `.gitignore` exclusion. This plan produces no user-visible features — it lays the plumbing for Parts 2 and 3.

## Metadata

**Tags:** backend, infrastructure
**Complexity:** 5

## User Review Required

> [!NOTE]
> - **ClickUp API Token**: After this plan lands, users can run "Switchboard: Set ClickUp API Token" from the command palette to store their token securely. The token is stored in VS Code SecretStorage (OS keychain), never in plaintext config.
> - **No UI changes yet**: This plan creates no visible UI. The setup button and sync behavior come in Parts 2 and 3.

## Complexity Audit

### Routine
- **Configuration file schema**: `.switchboard/clickup-config.json` is a simple JSON file. Read/write with `fs.promises`.
- **`.gitignore` update**: Single-line addition.
- **Command registration**: Adding `switchboard.setClickUpToken` follows the existing pattern in `extension.ts` (lines 1075–1286) and `package.json`.
- **Retry/delay/chunk utilities**: Standard helper methods with no novel logic.

### Complex / Risky
- **`_httpRequest` method**: Must handle all ClickUp REST API patterns (GET/POST/PUT/DELETE), parse JSON responses, propagate HTTP error codes, and never leak the API token into logs. The method must work inside the VS Code extension host's Node.js runtime (no `fetch` — use `https` module).
- **SecretStorage threading**: The `context.secrets` reference from `activate()` must be passed through to wherever `ClickUpSyncService` is instantiated. This affects the constructor signature and all call sites added in Parts 2–3.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — this plan creates no async workflows or event handlers.
- **Security:** Token stored in VS Code SecretStorage (OS keychain). `_httpRequest` sets the `Authorization` header but never logs it. The `_getApiToken` method returns `null` (not empty string) if no token is set, forcing callers to handle the missing-token case explicitly.
- **Side Effects:** The `clickup-config.json` file is created lazily (only by Part 2's setup flow), not by this plan. The `.gitignore` addition is safe — the wildcard `.switchboard/*` already excludes most files, but an explicit entry improves clarity.
- **Dependencies & Conflicts:**
  - **No cross-plan conflicts**: This plan creates a new file (`ClickUpSyncService.ts`) and adds one command. No existing files are modified in ways that conflict with other pending plans.
  - **Upstream dependency**: None — this is the foundation plan.
  - **Downstream dependents**: `clickup_2_setup_flow.md` and `clickup_3_sync_on_move.md` both depend on this plan.

## Adversarial Synthesis

### Grumpy Critique

*Adjusts reading glasses. Squints at the code.*

1. **Why `https` and not `fetch`?** Node.js 18+ (which VS Code ships with) has global `fetch`. Using the `https` module is 2015-era code. You're writing request/response plumbing that `fetch` handles in one line.

2. **No response type safety.** `_httpRequest` returns `{ status: number; data: any }`. That `any` is going to propagate through the entire codebase. Every caller will need runtime type checks or cast blindly.

3. **Token validation is a network call.** `isAvailable()` calls `GET /team` to validate the token. What if ClickUp is slow? What if the user is offline? This will block UI flows that check availability.

### Balanced Response

1. **`https` vs `fetch`**: Valid concern. However, VS Code extension host Node.js version varies by VS Code release. The `https` module is universally available and avoids polyfill uncertainty. For a single service class, the verbosity cost is acceptable. If the team prefers `fetch`, the swap is mechanical and contained to one method.

2. **Type safety**: Agreed — `any` is a code smell. The implementation below uses a generic `_httpRequest<T>` with a type parameter. Callers pass the expected response shape. Runtime validation is deferred to the caller (acceptable for an internal service).

3. **Availability check latency**: `isAvailable()` is only called when the kanban webview opens (Part 2) — not on every move. A 2-second timeout is added to prevent blocking. If the call fails or times out, the ClickUp button is hidden (safe default).

## Proposed Changes

### Target File 1: ClickUp Sync Service — Foundation
#### CREATE `src/services/ClickUpSyncService.ts`
- **Context:** New service class housing all ClickUp REST API interactions. This plan creates the skeleton: interfaces, constructor, HTTP client, config I/O, token access, and utility methods. The `setup()` and `syncPlan()` methods are added in Parts 2 and 3.
- **Logic:**
  1. Define `ClickUpConfig` interface matching the config JSON schema
  2. Define `KanbanPlanRecord` interface matching the `plans` table columns in `KanbanDatabase.ts`
  3. Export `CANONICAL_COLUMNS` constant from `KanbanDatabase.ts:163-164` column set
  4. Implement `_httpRequest()` using Node.js `https` module with `Authorization` header
  5. Implement `_loadConfig()` / `_saveConfig()` for JSON file I/O
  6. Implement `_getApiToken()` reading from `context.secrets`
  7. Implement `isAvailable()` with a lightweight `GET /team` health check and 2-second timeout
  8. Implement `_retry()`, `_delay()`, `_chunkArray()` utility methods
- **Implementation:**

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';

export interface ClickUpConfig {
  workspaceId: string;
  folderId: string;
  spaceId: string;
  columnMappings: Record<string, string>;
  customFields: {
    sessionId: string;
    planId: string;
    syncTimestamp: string;
  };
  setupComplete: boolean;
  lastSync: string | null;
}

export interface KanbanPlanRecord {
  planId: string;
  sessionId: string;
  topic: string;
  planFile: string;
  kanbanColumn: string;
  status: string;
  complexity: string;
  tags: string;
  dependencies: string;
  createdAt: string;
  updatedAt: string;
  lastAction: string;
}

// Canonical Switchboard kanban columns (mirrors KanbanDatabase.ts VALID_KANBAN_COLUMNS)
export const CANONICAL_COLUMNS = [
  'CREATED', 'BACKLOG', 'PLAN REVIEWED', 'LEAD CODED',
  'CODER CODED', 'CODE REVIEWED', 'COMPLETED'
];

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

export class ClickUpSyncService {
  private _workspaceRoot: string;
  private _configPath: string;
  private _config: ClickUpConfig | null = null;
  private _debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private _rateLimitDelay: number = 1000;
  private _batchSize: number = 10;
  private _maxRetries: number = 3;
  private _secretStorage: vscode.SecretStorage;
  private _setupInProgress: boolean = false;
  private _isSyncInProgress: boolean = false;

  constructor(workspaceRoot: string, secretStorage: vscode.SecretStorage) {
    this._workspaceRoot = workspaceRoot;
    this._configPath = path.join(workspaceRoot, '.switchboard', 'clickup-config.json');
    this._secretStorage = secretStorage;
  }

  // ── Config I/O ──────────────────────────────────────────────

  async loadConfig(): Promise<ClickUpConfig | null> {
    try {
      const content = await fs.promises.readFile(this._configPath, 'utf8');
      this._config = JSON.parse(content);
      return this._config;
    } catch {
      return null;
    }
  }

  async saveConfig(config: ClickUpConfig): Promise<void> {
    const dir = path.dirname(this._configPath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(this._configPath, JSON.stringify(config, null, 2));
    this._config = config;
  }

  // ── Token Management ────────────────────────────────────────

  /**
   * Read ClickUp API token from VS Code SecretStorage.
   * Returns null if not set — callers must handle this.
   */
  async getApiToken(): Promise<string | null> {
    try {
      return await this._secretStorage.get('switchboard.clickup.apiToken') || null;
    } catch {
      return null;
    }
  }

  // ── HTTP Client ─────────────────────────────────────────────

  /**
   * Authenticated HTTPS request to ClickUp REST API.
   * All extension-code ClickUp interactions go through this method.
   * Never logs the Authorization header.
   */
  async httpRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    apiPath: string,
    body?: Record<string, unknown>,
    timeoutMs: number = 10000
  ): Promise<{ status: number; data: any }> {
    const token = await this.getApiToken();
    if (!token) { throw new Error('ClickUp API token not configured'); }

    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = https.request({
        hostname: 'api.clickup.com',
        path: `/api/v2${apiPath}`,
        method,
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        },
        timeout: timeoutMs
      }, (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode || 0, data: raw });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      req.on('error', reject);
      if (payload) { req.write(payload); }
      req.end();
    });
  }

  // ── Availability Check ──────────────────────────────────────

  /**
   * Check if ClickUp is configured and reachable.
   * Uses a 2-second timeout to avoid blocking UI.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const token = await this.getApiToken();
      if (!token) { return false; }
      const result = await this.httpRequest('GET', '/team', undefined, 2000);
      return result.status === 200;
    } catch {
      return false;
    }
  }

  // ── Utilities ───────────────────────────────────────────────

  get setupInProgress(): boolean { return this._setupInProgress; }
  set setupInProgress(v: boolean) { this._setupInProgress = v; }

  get isSyncInProgress(): boolean { return this._isSyncInProgress; }
  set isSyncInProgress(v: boolean) { this._isSyncInProgress = v; }

  get debounceTimers(): Map<string, NodeJS.Timeout> { return this._debounceTimers; }
  get batchSize(): number { return this._batchSize; }
  get rateLimitDelay(): number { return this._rateLimitDelay; }
  get configPath(): string { return this._configPath; }
  get workspaceRoot(): string { return this._workspaceRoot; }

  delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  async retry<T>(fn: () => Promise<T>, retries: number = this._maxRetries): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (error) {
        if (i === retries - 1) { throw error; }
        await this.delay(Math.pow(2, i) * 1000);
      }
    }
    throw new Error('Max retries exceeded');
  }
}
```

- **Edge Cases Handled:**
  - Missing token → `getApiToken()` returns `null`, `httpRequest()` throws, `isAvailable()` returns `false`
  - Network timeout → 2-second cap on `isAvailable()`, configurable on `httpRequest()`
  - Config dir missing → `saveConfig()` creates `.switchboard/` with `mkdir -p`
  - Corrupted config JSON → `loadConfig()` returns `null` (callers re-create)

### Target File 2: Token Storage Command
#### MODIFY `src/extension.ts`
- **Context:** Register the `switchboard.setClickUpToken` command alongside existing commands (lines 1075–1286). This command prompts for the API token and stores it in VS Code SecretStorage.
- **Logic:**
  1. Add a new `vscode.commands.registerCommand` call after the existing command registrations
  2. Use `vscode.window.showInputBox` with `password: true` to collect the token
  3. Store via `context.secrets.store()`
- **Implementation:**

Add after the last `registerCommand` block (around line 1286):

```typescript
const setClickUpTokenDisposable = vscode.commands.registerCommand('switchboard.setClickUpToken', async () => {
    const token = await vscode.window.showInputBox({
        prompt: 'Enter your ClickUp API token (starts with pk_)',
        password: true,
        placeHolder: 'pk_...',
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value || value.trim().length < 10) {
                return 'Token appears too short. ClickUp tokens typically start with pk_';
            }
            return null;
        }
    });
    if (token) {
        await context.secrets.store('switchboard.clickup.apiToken', token.trim());
        vscode.window.showInformationMessage('ClickUp API token saved securely.');
    }
});
context.subscriptions.push(setClickUpTokenDisposable);
```

- **Edge Cases Handled:**
  - User cancels input → no-op (token check returns `undefined`)
  - Token too short → inline validation feedback
  - Token has whitespace → trimmed before storage

### Target File 3: Command Palette Registration
#### MODIFY `package.json`
- **Context:** Add the `switchboard.setClickUpToken` command to the `contributes.commands` array so it appears in the VS Code command palette.
- **Logic:** Add one entry to the existing `contributes.commands` array.
- **Implementation:**

Add to the `contributes.commands` array (after existing entries):

```json
{
  "command": "switchboard.setClickUpToken",
  "title": "Set ClickUp API Token",
  "category": "Switchboard"
}
```

### Target File 4: Git Ignore Update
#### MODIFY `.gitignore`
- **Context:** Ensure the ClickUp configuration file (created by Part 2) is not committed. It contains workspace-specific ClickUp IDs.
- **Logic:** Add explicit exclusion line. Note: `.switchboard/*` already excludes most files, but this line is not covered by any `!` exception, so it's technically already excluded. The explicit entry adds documentary clarity.
- **Implementation:**

Add after the existing `.switchboard/` block (around line 47):

```
# ClickUp integration config (workspace-specific IDs)
.switchboard/clickup-config.json
```

- **Edge Cases Handled:** Redundant with `.switchboard/*` wildcard but harmless — adds intent clarity for contributors.

## Verification Plan

### Automated Tests
- **Unit test for `_httpRequest`**: Mock `https.request` to verify correct headers, timeout handling, and JSON parsing.
- **Unit test for config I/O**: Write config, read it back, verify round-trip fidelity. Test corrupted JSON returns `null`.
- **Unit test for `isAvailable`**: Mock a 200 response → returns `true`. Mock timeout → returns `false`. Mock missing token → returns `false`.

### Manual Verification Steps
1. Run `npx tsc --noEmit` — no new type errors from `ClickUpSyncService.ts`
2. Open command palette → "Switchboard: Set ClickUp API Token" appears
3. Enter a token → confirm it persists across VS Code restart (SecretStorage is durable)
4. Verify `.switchboard/clickup-config.json` is in `.gitignore` output: `git check-ignore .switchboard/clickup-config.json` returns the path

## Files to Modify

1. `src/services/ClickUpSyncService.ts` — CREATE (REST client, config I/O, token access, utilities)
2. `src/extension.ts` — MODIFY (register `switchboard.setClickUpToken` command)
3. `package.json` — MODIFY (add command to `contributes.commands`)
4. `.gitignore` — MODIFY (add explicit `clickup-config.json` exclusion)

## Agent Recommendation

**Send to Coder** — Complexity 5. Routine multi-file changes with no complex state management or risky architectural decisions. The HTTP client is the only non-trivial piece, and the pattern is well-understood.

---

## Post-Implementation Review

### Review Date: 2026-04-09

### Stage 1: Grumpy Principal Engineer Findings

1. **[MAJOR] Missing `CODED` column in `CANONICAL_COLUMNS`.** The `VALID_KANBAN_COLUMNS` set in `KanbanDatabase.ts:163-164` includes `'CODED'` but `CANONICAL_COLUMNS` in `ClickUpSyncService.ts` did not. Plans in the `CODED` column would have no ClickUp list and sync would silently skip them. A column that exists in the DB but not in the sync service is a data-loss vector.

2. **[MAJOR] Duplicate `KanbanPlanRecord` interface.** `ClickUpSyncService.ts` defines its own `KanbanPlanRecord` (12 fields, `status: string`) instead of importing from `KanbanDatabase.ts` (19 fields, `status: KanbanPlanStatus`). Two types with the same name in the same project will drift apart. Future developers will import the wrong one. The ClickUp version is missing `workspaceId`, `sourceType`, `brainSourcePath`, `mirrorPath`, `routedTo`, `dispatchedAgent`, `dispatchedIde`.

3. **[NIT] Unused `CLICKUP_API_BASE` constant.** Declared `const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2'` but `httpRequest()` hardcodes the hostname and path prefix. Dead code.

### Stage 2: Balanced Synthesis

1. **`CODED` column — FIXED.** Added `'CODED'` to `CANONICAL_COLUMNS`. Setup flow (Part 2) now creates 8 lists, not 7.

2. **Duplicate `KanbanPlanRecord` — Deferred.** Refactoring to import from `KanbanDatabase` is the right long-term fix, but the ClickUp interface is a deliberate subset (sync methods only need 12 fields). Changing this requires updating the move hook object literals in `KanbanProvider.ts` to spread the full DB record. Lower risk to defer. No type errors today because the move hooks construct object literals matching the ClickUp interface explicitly.

3. **Unused `CLICKUP_API_BASE` — FIXED.** Removed the dead constant.

### Files Changed (Review Fixes)

| File | Change |
|------|--------|
| `src/services/ClickUpSyncService.ts` | Added `'CODED'` to `CANONICAL_COLUMNS`; removed unused `CLICKUP_API_BASE` |

### Validation Results

- **Typecheck** (`npx tsc --noEmit`): ✅ Pass (only pre-existing `ArchiveManager` import error — known false positive)
- **All plan requirements verified**: ClickUpSyncService.ts created ✅, extension.ts command ✅, package.json entry ✅, .gitignore entry ✅

### Remaining Risks

- **Duplicate `KanbanPlanRecord` type**: Will cause confusion if either type is extended. Should be resolved in a follow-up by importing from `KanbanDatabase.ts` with `import type`.
