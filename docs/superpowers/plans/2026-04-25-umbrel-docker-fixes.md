# UmbrelOS Docker Compatibility Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all Docker compatibility issues so UmbrelOS runs without errors in a Docker container.

**Architecture:** Make hardware-specific features gracefully fail or return empty/safe values in Docker. Relax CSP for external resources needed by the UI.

**Tech Stack:** TypeScript/Node.js (umbreld source), Docker, Helmet CSP

---

## Issue Summary

| Issue | Severity | Root Cause |
|-------|----------|------------|
| rugix-ctrl ENOENT | Medium | Error still propagates despite try-catch |
| nmcli ENOENT | Low | NetworkManager not in Docker, needs silent handling |
| CPU temperature fails | Low | No Docker detection, throws error |
| getExternalDevicesWithVirtualMountPoints missing | High | Stub class missing this method |
| CSP blocks external resources | High | img-src and connect-src too restrictive |

---

## Task 1: Fix rugix-ctrl error propagation

**Files:**
- Modify: `source/modules/blacklist-uas/blacklist-uas.ts:96-100`
- Modify: `source/modules/system.ts:294-298` (verify stub)

- [ ] **Step 1: Read blacklist-uas.ts around line 96**

Locate the exact code that calls `rugix-ctrl system commit`

- [ ] **Step 2: Verify system.ts commitOsPartition stub**

Read `source/modules/system.ts` around line 294 to confirm the stub exists

- [ ] **Step 3: Ensure error is caught and logged as debug**

If the try-catch at line 96-100 only catches but doesn't suppress the error log, add proper error suppression:
```typescript
try {
  await $`rugix-ctrl system commit`
} catch (error) {
  // rugix-ctrl is not available in Docker, this is expected
}
```

- [ ] **Step 4: Rebuild and verify no rugix-ctrl errors in logs**

---

## Task 2: Handle nmcli unavailability

**Files:**
- Modify: `source/modules/system/routes.ts` (add nmcli wrapper with Docker check)

- [ ] **Step 1: Find where nmcli is called in routes.ts**

Search for `nmcli` or `wifi` related TRPC procedures

- [ ] **Step 2: Create a helper function that catches ENOENT**

Add at the top of routes.ts or in system.ts:
```typescript
async function runNmcli(args: string[]): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await $`nmcli ${args}`
    return { success: true, stdout, stderr }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { success: false, stdout: '', stderr: 'nmcli not available' }
    }
    throw error
  }
}
```

- [ ] **Step 3: Wrap wifi.connected and wifi.supported procedures**

Replace direct `$`nmcli`` calls with `runNmcli()` and return empty results when not available

- [ ] **Step 4: Verify no nmcli errors in logs**

---

## Task 3: Fix CPU temperature to handle Docker gracefully

**Files:**
- Modify: `source/modules/system.ts:14-21` (getCpuTemperature function)

- [ ] **Step 1: Read getCpuTemperature function**

Locate the exact implementation at lines 14-21

- [ ] **Step 2: Wrap in try-catch with fallback**

```typescript
function getCpuTemperature(): number | null {
  try {
    const cpuTemperature = systemInformation.cpuTemperature()
    if (typeof cpuTemperature.main !== 'number') {
      return null // Not available in Docker
    }
    return cpuTemperature.main
  } catch (error) {
    // CPU temperature not available (e.g., in Docker)
    return null
  }
}
```

- [ ] **Step 3: Update routes.ts to handle null return**

The TRPC query should return null instead of throwing when temperature unavailable

- [ ] **Step 4: Verify no CPU temperature errors in logs**

---

## Task 4: Add missing getExternalDevicesWithVirtualMountPoints method

**Files:**
- Modify: `source/modules/files/external-storage.ts:52-96` (ExternalStorage stub class)

- [ ] **Step 1: Read external-storage.ts to find the stub class**

Locate the ExternalStorage class and see its current methods

- [ ] **Step 2: Add getExternalDevicesWithVirtualMountPoints method**

Add to the stub class:
```typescript
getExternalDevicesWithVirtualMountPoints(): string[] {
  // External storage is not available in Docker
  return []
}
```

- [ ] **Step 3: Verify the method is properly exported**

Ensure the method is accessible via `ctx.umbreld.files.externalStorage`

- [ ] **Step 4: Rebuild and verify no externalDevices errors in logs**

---

## Task 5: Fix CSP to allow external resources

**Files:**
- Modify: `source/modules/server/index.ts:101-138` (CSP configuration)

- [ ] **Step 1: Read current CSP configuration**

Locate lines 101-138 where helmet CSP is configured

- [ ] **Step 2: Add external domains to img-src**

Change:
```typescript
imgSrc: ["'self'", 'data:', 'blob:'],
```
To:
```typescript
imgSrc: ["'self'", 'data:', 'blob:', 'https://getumbrel.github.io'],
```

- [ ] **Step 3: Add external domains to connect-src**

Add `https://apps.umbrel.com` to connect-src (or use default-src if specified):
```typescript
connectSrc: ["'self'", 'https://apps.umbrel.com'],
```

- [ ] **Step 4: Verify CSP headers allow external resources**

Check browser console for CSP violations after rebuild

---

## Task 6: Comprehensive verification

- [ ] **Step 1: Run docker compose build**

Build the image with all fixes

- [ ] **Step 2: Start container and capture logs**

Verify startup logs show no ERROR level messages (except expected Docker-incompatible features)

- [ ] **Step 3: Check browser console for CSP errors**

Navigate to the UI and verify no CSP violations for icons or API calls

- [ ] **Step 4: Verify Files module works**

Check that the file browser loads directories properly

---

## Files Summary

| File | Changes |
|------|---------|
| `source/modules/blacklist-uas/blacklist-uas.ts` | Suppress rugix-ctrl error |
| `source/modules/system/routes.ts` | Wrap nmcli with error handling |
| `source/modules/system.ts` | Make getCpuTemperature return null on failure |
| `source/modules/files/external-storage.ts` | Add missing method |
| `source/modules/server/index.ts` | Relax CSP for external domains |

---

## Dependencies

- Task 3 should be done before Task 6
- Other tasks are independent and can be done in parallel

---

## Success Criteria

1. No `spawn nmcli ENOENT` errors in logs
2. No `spawn rugix-ctrl ENOENT` errors in logs
3. No `Could not get CPU temperature` errors in logs
4. No `getExternalDevicesWithVirtualMountPoints is not a function` errors in logs
5. App icons load from `getumbrel.github.io`
6. App store API calls succeed to `apps.umbrel.com`
