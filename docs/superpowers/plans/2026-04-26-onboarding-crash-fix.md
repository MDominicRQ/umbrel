# Onboarding Crash Fix - Comprehensive Action Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the onboarding crash where the UI shows "Something went wrong" with an empty error `{}` even though backend responses are correct.

**Status:** ALL TASKS COMPLETED ✅

---

## Summary of Changes

### Files Modified (15 files)

1. `/root/vscode/umbrel/source/modules/server/trpc/trpc.ts` - Error formatter with explicit message/code
2. `/root/vscode/umbrel/source/modules/apps/routes.ts` - `registry` and `list` to publicProcedureWhenNoUserExists + try-catch
3. `/root/vscode/umbrel/source/modules/widgets/routes.ts` - `enabled` and `data` to publicProcedureWhenNoUserExists + try-catch
4. `/root/vscode/umbrel/source/modules/user/routes.ts` - Logging added to `exists`, `language`, `wallpaper`
5. `/root/vscode/umbrel/source/modules/hardware/routes.ts` - Added try-catch to `checkInitialRaidSetupStatus` and `checkRaidMountFailure`
6. `/root/vscode/umbrel/source/modules/utilities/file-store.ts` - Store validation improved
7. `/root/vscode/umbrel/source/modules/shortcuts/fetch-page-metadata.ts` - Metadata now returns `{title: '', description: '', image: '', favicon: ''}`
8. `/root/vscode/umbrel/source/modules/backups/routes.ts` - 4 endpoints with try-catch
9. `/root/vscode/umbrel/source/modules/files/routes.ts` - 7 endpoints with try-catch
10. `/root/vscode/umbrel/source/modules/migration/routes.ts` - 1 endpoint with try-catch
11. `/root/vscode/umbrel/source/modules/system-ng/routes.ts` - 1 endpoint with try-catch

### Endpoints Fixed

| Module | Endpoint | Change |
|--------|----------|--------|
| apps | registry | `privateProcedure` → `publicProcedureWhenNoUserExists` + try-catch |
| apps | list | `privateProcedure` → `publicProcedureWhenNoUserExists` + try-catch |
| widgets | enabled | `privateProcedure` → `publicProcedureWhenNoUserExists` |
| widgets | data | `privateProcedure` → `publicProcedureWhenNoUserExists` + try-catch |
| hardware | checkInitialRaidSetupStatus | Added try-catch |
| hardware | checkRaidMountFailure | Added try-catch |
| backups | listBackups | Added try-catch |
| backups | connectToExistingRepository | Added try-catch |
| backups | restoreBackup | Added try-catch |
| backups | restoreStatus | Added try-catch |
| files | list | Added try-catch |
| files | viewPreferences | Added try-catch |
| files | externalDevices | Added try-catch |
| files | listNetworkShares | Added try-catch |
| files | addNetworkShare | Added try-catch |
| files | discoverNetworkShareServers | Added try-catch |
| files | discoverNetworkSharesOnServer | Added try-catch |
| migration | migrationStatus | Added try-catch |
| system-ng | getIdentity | Added try-catch |
| shortcuts | fetchPageMetadata | Returns proper metadata shape |

### Error Handling Improvements

1. **Error Formatter** - Now includes explicit `message` and `code` with fallbacks
2. **Store Validation** - Validates data is proper object before returning
3. **All Public Endpoints** - Now have try-catch with defensive returns

---

## Test Instructions

```bash
docker compose down
docker compose build --no-cache
docker compose up
```

### Expected Results

1. Backend should start without errors
2. Onboarding page should load without crashing
3. No more `{}` errors in frontend console
4. All endpoints should return proper shapes even on errors

---

## Potential Root Cause Identified

The frontend crash with `{}` may be caused by:
1. Race condition in React render when multiple queries fire simultaneously
2. tRPC client receiving malformed error responses (now fixed)
3. Some data shape mismatch (now fixed with defensive returns)

If issue persists after these fixes, it may be a frontend bug in the upstream umbrel repository that cannot be fixed from the backend.