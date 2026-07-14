# Test Gaps — Service Layer (viaapp)

**Date:** May 16, 2026
**Priority:** Medium
**Status:** Open
**Repo:** viaapp
**Parent Plan:** `feature_plan_20260515_unit_test_coverage_buildout.md`

## Summary

Three services in `src/library/services/` remain untested. This document records the specific blockers for each and the fix required.

## Untested Services

### 1. NotificationService — blocked by setup.js mock infrastructure

**File:** `src/library/services/NotificationService.ts`
**Circular dependency:** None. Does not import store. Receives `dispatch` as a parameter.

**Actual blocker:** The global `setup.js` mock for `@notifee/react-native` has the wrong shape. It mocks `default` as a factory function (`jest.fn(() => ({...}))`), but `NotificationService` uses the default import as an object (`notifee.getInitialNotification()`). Additionally, `clearMocks: true` in `jest.config.js` wipes all `jest.fn()` implementations before each test, so even if the mock shape were corrected, the inner methods lose their implementations after the first test.

Per-test-file `jest.mock` calls do **not** override `setup.js` mocks in this project's Jest configuration, so the fix cannot be scoped to a single test file.

**Fix required:**
1. Change the `@notifee/react-native` mock in `setup.js` to use plain functions instead of `jest.fn()` for the outer wrapper, or restructure to survive `clearMocks`:
   ```js
   jest.mock('@notifee/react-native', () => {
     const notifee = {
       getInitialNotification: jest.fn(() => Promise.resolve(null)),
       onForegroundEvent: jest.fn(() => jest.fn()),
     };
     return { __esModule: true, default: notifee };
   });
   ```
2. Verify the `__esModule: true` flag resolves correctly with babel's default import handling.
3. Audit whether any other test depends on `notifee.default` being callable as a function (unlikely — no other test imports notifee directly).
4. Same pattern may be needed for `@react-native-firebase/messaging` if `clearMocks` wipes its factory implementation.

**Effort:** ~1 hour (setup.js change + write tests + verify full suite)

### 2. LoginService — blocked by direct store import

**File:** `src/library/services/LoginService.ts`
**Circular dependency:** Yes. `import store from 'src/redux/store'` at line 1.

**What store is used for:** `store.getState().user?.socialUser?.displayName` (line 48) — a single runtime read.

**Fix required:** Refactor the store access to a lazy `require()` or extract to a utility:
```ts
// Instead of: import store from 'src/redux/store';
// At line 48:
const { default: store } = require('src/redux/store');
socialUser.displayName ??= store.getState().user?.socialUser?.displayName;
```

**Effort:** ~30 min refactor + ~1 hour tests

### 3. LogoutService — blocked by direct store import (part of store init chain)

**File:** `src/library/services/LogoutService.ts`
**Circular dependency:** Yes. Core of the cycle: `store → resourceApi → baseQuery → LogoutService → store`.
**Already globally mocked** in `setup.js` (line 140) to break this cycle.

**What store is used for:** `store.dispatch(setSignOut())` (line 58) — a single runtime dispatch on logout.

**Fix required:** Same lazy-import pattern:
```ts
// Instead of: import store from 'src/redux/store';
// Inside handleLogout:
const { default: store } = require('src/redux/store');
store.dispatch(setSignOut());
```

**Effort:** ~30 min refactor + ~1 hour tests

## Not Blocked (completed during review)

- **Auth.tsx** — no circular dep, no store import. Tests written: `Auth.test.ts` (12 tests).

## Infrastructure Note

The `jest.mock` override limitation (test-file mocks not overriding `setup.js` mocks) affects any new test that needs a different mock shape for a globally-mocked module. If more services hit this, consider:
- Moving mock factories to `__mocks__/` directories (Jest auto-mock convention)
- Using `jest.requireActual` + selective overrides instead of full factory replacements
- Investigating whether `setupFilesAfterEnv` mocks behave differently from `setupFiles` mocks

## Metadata

**Tags:** testing, services, gaps, infrastructure
**Complexity:** 3 (Medium — known fixes, bounded scope)
**Repo:** viaapp
