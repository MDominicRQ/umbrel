# UmbrelOS App Proxy Path-Based Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix path-based proxy for Open WebUI (root-absolute assets), OpenClaw (WebSocket query string), Tailscale (gateway fallback page), and Bitcoin (app ID + landing). General cleanup and regression prevention.

**Architecture:** Path-based proxy at `/proxy/<appId>/` using `http-proxy-middleware`. App-kind-aware routing. Root-absolute asset requests handled via `Referer`-based middleware. WebSocket upgrades preserve query strings.

**Tech Stack:** TypeScript, Express, `http-proxy-middleware` v2, `ws`, Docker

---

## Task 1: Fix Open WebUI Root-Absolute Assets via Referer Middleware

**Files:**
- Modify: `/root/vscode/umbrel/source/modules/server/index.ts`

**Context:** Open WebUI issues requests to `/_app/...`, `/api/...`, `/assets/...`, `/static/...`, `/manifest.json`, `/ollama/...` which resolve to `os.dominic.pw/_app/...` instead of being proxied to the app. The `Referer` header from the browser contains `/proxy/open-webui/...`.

Steps:

- [ ] **Step 1: Add `isRootAbsoluteAppPath()` helper**

Add this module-level helper after the existing rewrite helpers:

```typescript
const ROOT_ABSOLUTE_APP_PATHS = new Set([
  '/_app/', '/_app', '/api/', '/api', '/assets/', '/assets',
  '/static/', '/static', '/manifest.json', '/favicon.ico',
  '/favicon.png', '/robots.txt', '/sw.js', '/service-worker.js',
  '/socket.io/', '/ws/', '/ws', '/ollama/', '/ollama',
  '/models/', '/models',
])

function isRootAbsoluteAppPath(pathname: string): boolean {
  for (const prefix of ROOT_ABSOLUTE_APP_PATHS) {
    if (pathname === prefix || pathname.startsWith(prefix + '/') || pathname.startsWith(prefix)) {
      return true
    }
  }
  return false
}
```

- [ ] **Step 2: Add `getAppIdFromReferer()` helper**

```typescript
function getAppIdFromReferer(request: http.IncomingMessage): string | undefined {
  const referer = request.headers['referer'] as string | undefined
  if (!referer) return undefined
  try {
    const u = new URL(referer)
    const m = u.pathname.match(/^\/proxy\/([^/]+)/)
    return m?.[1]
  } catch {
    return undefined
  }
}
```

- [ ] **Step 3: Add Referer-based root-absolute middleware in `start()`**

Find the section in `start()` after the `/proxy/:appId` route handler (around line 1493) and BEFORE the Umbrel API routes (`/trpc`, `/api/files`). Add a new middleware block:

```typescript
// Referer-based root-absolute app path proxy
// Handles SPAs that emit /_app/, /api/, /assets/ etc from browser to root domain
app.use(async (request: express.Request, response: express.Response, next: express.NextFunction) => {
  const {pathname, search} = parseUri(request.originalUrl)
  if (!isRootAbsoluteAppPath(pathname) && !pathname.startsWith('/_app') && !pathname.startsWith('/api') && !pathname.startsWith('/assets') && !pathname.startsWith('/static') && !pathname.startsWith('/manifest') && !pathname.startsWith('/ollama') && !pathname.startsWith('/models') && !pathname.startsWith('/favicon') && !pathname.startsWith('/robots') && !pathname.startsWith('/sw') && !pathname.startsWith('/socket.io') && !pathname.startsWith('/ws')) return next()

  // Exclude Umbrel-owned paths
  if (pathname.startsWith('/trpc') || pathname.startsWith('/manager-api') || pathname.startsWith('/api/files') || pathname.startsWith('/api/debug')) return next()

  const appId = getAppIdFromReferer(request)
  if (!appId) return next()

  try {
    const target = await this.#resolveAppTarget(appId)
    const proxy = this.#getAppProxy(appId, target, {rewriteLocation: true})
    proxy(request, response, next)
  } catch {
    next()
  }
})
```

Actually, add it as an Express router-level middleware using `Router()` for cleanliness, after the `/proxy/:appId` block and before `app.use('/trpc'...)`.

**Verification:** After implementing, confirm:
- `/_app/` requests from a browser that loaded `/proxy/open-webui/` get proxied
- `os.dominic.pw/_app/...` with `Referer: https://os.dominic.pw/proxy/open-webui/` → proxies to Open WebUI target
- Other apps' root paths without matching Referer are NOT proxied (fall through to Umbrel routes)

---

## Task 2: Fix OpenClaw WebSocket Query String Preservation

**Files:**
- Modify: `/root/vscode/umbrel/source/modules/server/index.ts`

**Context:** WebSocket upgrade at lines 1543-1703 sets `request.url = strippedPath` without the query string. For `/proxy/openclaw/api/terminal?token=...`, `strippedPath` becomes `/api/terminal` and `?token=...` is lost.

Steps:

- [ ] **Step 1: Find WebSocket upgrade handler and preserve query string**

Find in `start()` the section that handles path-based WebSocket upgrades. It currently does:
```typescript
const strippedPath = appProxyMatch[2] || '/'
request.url = strippedPath
```

Change to:
```typescript
const {pathname, search} = new URL(request.url, 'https://dummy')
const strippedPath = appProxyMatch[2] || '/'
request.url = `${strippedPath}${search || ''}`
```

OR if `request.url` already contains the full path+query, just use `search` from parsing the URL object.

**Verification:** After implementing:
- `wss://os.dominic.pw/proxy/openclaw/api/terminal?token=ABC` should forward to `target/api/terminal?token=ABC`
- Log should show `wsUpgrade: /proxy/openclaw/api/terminal?token=... → target/api/terminal?token=...`

---

## Task 3: Fix Tailscale Gateway Fallback — Serve Explanatory Page Instead of 502 JSON

**Files:**
- Modify: `/root/vscode/umbrel/source/modules/server/index.ts`
- Modify: `/root/vscode/umbrel/source/modules/apps/routes.ts`

**Context:** Tailscale is `host-network`. If no gateway probe succeeds, it returns raw `{"error":"App not reachable","detail":"...Gateway probe failed..."}` JSON. Should serve an HTML explanatory page instead.

Steps:

- [ ] **Step 1: Change gateway probe failure from 502 JSON to informational HTML**

In the host-network failure block around line 1417-1439, replace the `response.writeHead(502, ...)` + JSON body with an HTML page:

```typescript
response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'})
response.end(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Tailscale</title></head>
<body>
<h1>Tailscale</h1>
<p>This app uses your host network and cannot be accessed through the web proxy.</p>
<p>Access Tailscale directly at <a href="http://$(containerIp):$(port)">http://$(containerIp):$(port)</a> from within the network, or via the Tailscale admin panel.</p>
</body>
</html>`)
```

- [ ] **Step 2: Add `bitcoin` as service-only in `#appKinds`**

In `#appKinds`, add:
```typescript
'bitcoin': 'service-only',
'bitcoin-knots': 'service-only',
```

- [ ] **Step 3: Review and improve service-only landing pages**

Ensure `bitcoind`, `bitcoin`, `lightning`, `electrs`, `core-lightning` all return meaningful landing pages. Verify landing page HTML is well-formed and shows correct RPC endpoints.

**Verification:**
- `/proxy/tailscale/` returns HTML page (not 502 JSON)
- `/proxy/bitcoin/` returns service-only landing page (not "App proxy unavailable")

---

## Task 4: Verify No Regressions — Umbrel Routes Intact

**Files:**
- Review: `/root/vscode/umbrel/source/modules/server/index.ts`

**Context:** After adding Referer middleware and other changes, ensure Umbrel's own routes (`/trpc`, `/api/files`, `/api/debug`, `/manager-api`, `/assets/*`, static files) are NOT proxied to apps.

Steps:

- [ ] **Step 1: Confirm Umbrel routes are NOT intercepted by new middleware**

Check that the Referer-based middleware skips paths starting with `/trpc`, `/manager-api`, `/api/files`, `/api/debug`.

- [ ] **Step 2: Confirm `pathRewrite` doesn't corrupt Umbrel routes**

The `/proxy/<appId>` handler should only match paths that START with `/proxy/`. Confirm the regex at line ~1100 only matches `^\/proxy\/([^/]+)`.

**Verification:**
- `curl os.dominic.pw/trpc` → Umbrel TRPC response (not proxied)
- `curl os.dominic.pw/api/files` → Umbrel file API (not proxied)
- `curl os.dominic.pw/proxy/jellyfin/` → Jellyfin proxy

---

## Task 5: Full Code Review — No Syntax Errors, No Logic Bugs

**Files:**
- Review: `/root/vscode/umbrel/source/modules/server/index.ts`
- Review: `/root/vscode/umbrel/source/modules/apps/routes.ts`

**Context:** Final quality gate before deploy.

Steps:

- [ ] **Step 1: TypeScript compile check**

Run `cd /root/vscode/umbrel && npm run build` or equivalent typecheck. Fix any TypeScript errors.

- [ ] **Step 2: Manual logic review of new/changed functions**

Review:
- `isRootAbsoluteAppPath()` — does it cover all SPA root paths?
- `getAppIdFromReferer()` — is URL parsing safe?
- Referer middleware — does it correctly skip Umbrel-owned paths?
- WebSocket query string — is `search` correctly preserved?
- Service-only landing — is HTML well-formed?

- [ ] **Step 3: Confirm no duplicate method definitions**

Ensure `#getAppProxy`, `#resolveAppTarget`, `#repairNextcloud` each appear exactly once.

**Verification:**
- `npm run build` or `npx tsc --noEmit` succeeds with zero errors
- File line count is reasonable (~2000-2100 lines for server/index.ts)
- No `// TODO`, `// FIXME`, or placeholder comments in new code

---

## Execution Notes

- **Deploy command:** `cd /etc/dokploy/compose/n8n-umbrelos-oazure/code/ && docker compose build --no-cache && docker compose up -d`
- **Test commands (from VPS after deploy):**
  - `curl -sI https://os.dominic.pw/proxy/open-webui/_app/` (should proxy to Open WebUI target, not 404)
  - `curl -sI https://os.dominic.pw/proxy/openclaw/api/terminal` (should proxy)
  - `curl -s https://os.dominic.pw/proxy/tailscale/` (should return HTML, not 502 JSON)
  - `curl -s https://os.dominic.pw/trpc` (should return Umbrel TRPC, not app proxy)
  - Browser test for Open WebUI: navigate to `/proxy/open-webui/`, open DevTools Network tab, check for `/_app/` requests going to 200 not 404
