# InboxWatcher Dead Code Cleanup

## Goal

Remove InboxWatcher-era settings and environment variables that are no longer used after InboxWatcher deletion. These are harmless dead code but confusing to developers and should be cleaned up.

## Metadata

**Tags:** cleanup, infrastructure
**Complexity:** 1
**Estimated Impact:** ~5 lines deleted; removes confusing dead code

## Context

After InboxWatcher was deleted (plan `workspace_ssot_consolidation.md`), several InboxWatcher-era settings and environment variables remained:
- `security.strictInboxAuth` setting and `SWITCHBOARD_STRICT_INBOX_AUTH` env variable
- `runtime.workspaceMode` setting
- `dispatchSigningKey` generation

These are no longer read by any code and are dead code.

## Proposed Changes

### [MODIFY] `src/extension.ts` — Remove `strictInboxAuth` setting and env variable

**Lines 1145, 1195:**
```typescript
// DELETE lines 1145, 1195:
const strictInboxAuthSetting = getEnforcedSwitchboardBooleanSetting('security.strictInboxAuth', true);
// ...
process.env.SWITCHBOARD_STRICT_INBOX_AUTH = strictInboxAuthSetting.value ? 'true' : 'false';
```

### [MODIFY] `src/extension.ts` — Remove `workspaceMode` setting

**Lines 1146, 1198:**
```typescript
// DELETE line 1146:
const workspaceModeSetting = getEnforcedSwitchboardBooleanSetting('runtime.workspaceMode', false);

// DELETE line 1198:
if (strictInboxAuthSetting.ignoredWorkspaceOverride || workspaceModeSetting.ignoredWorkspaceOverride) {
```

### [MODIFY] `src/extension.ts` — Remove `dispatchSigningKey` generation

**Line 1147:**
```typescript
// DELETE line 1147:
const dispatchSigningKey = await getOrCreateDispatchSigningKey(context);
```

### [DELETE] `package.json` — Remove `security.strictInboxAuth` setting

Search for and delete the `security.strictInboxAuth` setting definition from `package.json` under `contributes.configuration`.

### [DELETE] `package.json` — Remove `runtime.workspaceMode` setting

Search for and delete the `runtime.workspaceMode` setting definition from `package.json` under `contributes.configuration`.

### [DELETE] `src/extension.ts` — Remove `getOrCreateDispatchSigningKey` import and function

If `getOrCreateDispatchSigningKey` is no longer used anywhere in the codebase after the above deletions, remove its import and the function definition.

## Edge Cases

- **None** — these are dead code with no consumers.

## Verification Plan

### Automated Tests
- TypeScript build must succeed with zero errors.
- Webpack build must succeed.

### Manual Tests
- Open VS Code.
- **Verify:** Extension activates successfully, no errors in Switchboard output channel.
- Check VS Code settings (Command Palette → "Preferences: Open Settings (UI)").
- **Verify:** `switchboard.security.strictInboxAuth` and `switchboard.runtime.workspaceMode` settings no longer appear in settings search.

## Success Criteria
1. `strictInboxAuth` setting and env variable removed.
2. `workspaceMode` setting removed.
3. `dispatchSigningKey` generation removed.
4. Corresponding `package.json` setting definitions removed.
5. TypeScript build succeeds with zero errors.
6. Extension activates successfully with no runtime errors.

---

**Recommendation:** Send to Coder (complexity 1).
