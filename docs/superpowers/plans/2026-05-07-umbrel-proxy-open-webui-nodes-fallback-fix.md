# UmbrelOS App Proxy — Open WebUI Nodes + Host-Network Fallback Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two distinct proxy failures: (1) Open WebUI `/proxy/nodes/*.js` returns 502 because `rewriteJsContent()` corrupts relative dynamic-import paths, turning e.g. `../nodes/1.js` into `/proxy/open-webui/../nodes/1.js` which browsers normalize to `/proxy/nodes/...`, causing Umbrel to interpret `nodes` as an app ID. (2) Host-network apps (Tailscale, Home Assistant) show an informational fallback page before attempting the `host.docker.internal:<port>` fallback that is known to work in the real deployment.

**Architecture:** Path-based proxy at `/proxy/<appId>/` using `http-proxy-middleware`. Only root-absolute URL patterns (e.g. `/nodes/`, `/api/`, `/_app/`) get rewritten in JS responses. Relative import paths (`../`, `./`) are left untouched. Host-network apps attempt `host.docker.internal:<port>` before serving informational fallback HTML.

**Tech Stack:** TypeScript, Express, `http-proxy-middleware` v2, `ws`, Docker

---

## Task 1: Fix `rewriteJsContent()` — Do Not Rewrite Relative Import Paths

**Files:**
- Modify: `/root/vscode/umbrel/source/modules/server/index.ts:136-149`

**Context:** The current regexes rewrite dynamic imports like `import("/nodes/foo.js")` because the negative lookahead `(?!\/)` incorrectly matches the opening `/` of an absolute-path string argument. Additionally, the regex `import\(\/(?!\/)([^"']*)\)` is malformed — it matches `import(/foo)` not `import("/foo")`. The result is that relative paths like `../nodes/...` get rewritten, producing paths like `/proxy/open-webui/../nodes/...` which browsers normalize to `/proxy/nodes/...`, causing Umbrel to parse `nodes` as an app ID.

**Steps:**

- [ ] **Step 1: Replace the broken `rewriteJsContent` function**

Locate the existing `rewriteJsContent` function around line 136. Replace it entirely with the following correct implementation:

```typescript
function rewriteJsContent(body: string, prefix: string): string {
	body = body.replace(/(?:href|src)=["'](\/(?!\/)([^"']*))["']/g, (match, p1, p2) => {
		const stripped = p2.startsWith('/') ? p2 : '/' + p2
		return match.replace(p1, prefix + stripped)
	})
	const rootAbsolutes = ['/_app', '/api', '/assets', '/static', '/manifest', '/favicon', '/robots', '/sw', '/service-worker', '/ws', '/socket.io', '/ollama', '/models', '/health', '/api/v1', '/nodes']
	for (const base of rootAbsolutes) {
		body = body.replace(new RegExp(`"(https?://[^"]*)?${base}([^"]*)"`, 'g'), (match, protocol, rest) => {
			if (protocol) return match
			return `"${prefix}${base}${rest}"`
		})
		body = body.replace(new RegExp(`'(${base}[^']*)'`, 'g'), `'${prefix}$1'`)
	}
	return body
}
```

**Why this works:** This version only rewrites string values that start with `/` but not `//` and that match known root-absolute prefixes. Relative paths like `../nodes/...` or `./lib/...` are not touched because they don't start with `/`.

- [ ] **Step 2: Verify the new function is syntactically valid**

Run: `cd /root/vscode/umbrel/source && npx tsc --noEmit --skipLibCheck 2>&1 | head -30`

Expected: No TypeScript errors related to `rewriteJsContent`.

- [ ] **Step 3: Commit**

```bash
cd /root/vscode/umbrel
git add source/modules/server/index.ts
git commit -m "fix: rewriteJsContent only rewrites root-absolute paths, not relative imports"
```

---

## Task 2: Add `/nodes` to `ROOT_ABSOLUTE_PATTERNS` and `prefixes` List

**Files:**
- Modify: `/root/vscode/umbrel/source/modules/server/index.ts:175-188`

**Context:** Open WebUI/SvelteKit emits dynamic imports to `/nodes/...` chunks. Currently `/nodes/` is not in `ROOT_ABSOLUTE_PATTERNS` so root-absolute WebSocket and HTTP requests to `/nodes/...` may not be routed correctly by the Referer-based middleware. Also the hardcoded `prefixes` array in `rewriteJsContent` should include `/nodes`.

**Steps:**

- [ ] **Step 1: Add `/nodes/` to `ROOT_ABSOLUTE_PATTERNS`**

Find the `ROOT_ABSOLUTE_PATTERNS` array around line 175. Update it to include `/nodes/`:

```typescript
const ROOT_ABSOLUTE_PATTERNS = [
	/^\/_app\//, /^\/_app$/,
	/^\/api\//, /^\/api$/,
	/^\/assets\//, /^\/assets$/,
	/^\/static\//, /^\/static$/,
	/^\/manifest\.json$/,
	/^\/favicon\.ico$/, /^\/favicon\.png$/,
	/^\/robots\.txt$/,
	/^\/sw\.js$/, /^\/service-worker\.js$/,
	/^\/socket\.io\//,
	/^\/ws\//, /^\/ws$/,
	/^\/ollama\//, /^\/ollama$/,
	/^\/models\//, /^\/models$/,
	/^\/nodes\//, /^\/nodes$/,
]
```

**Note:** Since Task 1 replaced `rewriteJsContent` with a version that uses a `rootAbsolutes` array internally, the `/nodes` entry is already covered there. No separate change to `rewriteJsContent` is needed for this.

- [ ] **Step 2: Typecheck**

Run: `cd /root/vscode/umbrel/source && npx tsc --noEmit --skipLibCheck 2>&1 | head -20`

Expected: Clean compile, no errors.

- [ ] **Step 3: Commit**

```bash
cd /root/vscode/umbrel
git add source/modules/server/index.ts
git commit -m "feat: add /nodes/ to ROOT_ABSOLUTE_PATTERNS for Open WebUI chunk routing"
```

---

## Task 3: Fix Host-Network Fallback — Attempt `host.docker.internal` Before Showing Page

**Files:**
- Modify: `/root/vscode/umbrel/source/modules/server/index.ts:1507-1533`

**Context:** Currently, if `#probeHostGateway` fails, the code sets `target = http://host.docker.internal:<manifestPort>` but then the handler at line 1507 blocks this exact combination (`hostname === 'host.docker.internal' && !#hostGatewayCache.has(port)`) and shows an informational page instead of attempting the proxy. Since the real deployment has `extra_hosts: host.docker.internal:host-gateway`, this fallback should actually be attempted.

**Steps:**

- [ ] **Step 1: Remove the pre-proxy blocking condition for `host.docker.internal`**

Find the block around line 1507 that checks `targetUrl.hostname === 'host.docker.internal' && !this.#hostGatewayCache.has(targetUrl.port)`. Remove this entire `if` block (lines ~1510-1533). The informational page will be served naturally by the proxy's `onError` handler if the `host.docker.internal` proxy actually fails.

The code to remove:

```typescript
const kind = this.#appKinds.get(appId)
if (kind === 'host-network') {
	const targetUrl = new URL(target)
	if (targetUrl.hostname === 'host.docker.internal' && !this.#hostGatewayCache.has(targetUrl.port)) {
		response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'})
		if (appId === 'tailscale') {
			return response.end(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Tailscale</title></head>
<body>
<h1>Tailscale</h1>
<p>This app uses your host network and cannot be accessed through the web proxy.</p>
<p>Access Tailscale directly from within your network, or via the Tailscale admin panel at <a href="https://login.tailscale.com">login.tailscale.com</a>.</p>
</body>
</html>`)
		}
		return response.end(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${appId}</title></head>
<body>
<h1>${appId}</h1>
<p>This app uses your host network and cannot be accessed through the web proxy.</p>
<p>Try accessing the app directly from within your network.</p>
</body>
</html>`)
	}
}
```

- [ ] **Step 2: Verify the proxy will handle failure gracefully**

The proxy's `onError` callback (lines ~840-848) already handles failures with a `502 App proxy unavailable` message. This is the correct fallback. Removing the pre-emptive block lets `http-proxy-middleware` attempt the actual connection.

- [ ] **Step 3: Typecheck**

Run: `cd /root/vscode/umbrel/source && npx tsc --noEmit --skipLibCheck 2>&1 | head -20`

Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
cd /root/vscode/umbrel
git add source/modules/server/index.ts
git commit -m "fix: allow host.docker.internal proxy attempt for host-network apps before showing fallback"
```

---

## Task 4: Verify No Regressions

**Files:**
- Review: `/root/vscode/umbrel/source/modules/server/index.ts`
- Review: `/root/vscode/umbrel/source/modules/apps/routes.ts`

**Steps:**

- [ ] **Step 1: Confirm `pathRewrite` in `#getAppProxy` still strips the prefix correctly**

The `pathRewrite` function (lines ~835-838) must only strip the `/proxy/<appId>` prefix from paths that start with it. Verify it does not corrupt Umbrel's own routes.

```typescript
pathRewrite: (path: string): string => {
	if (path === prefix) return '/'
	if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length)
	return path
},
```

- [ ] **Step 2: Confirm `ROOT_ABSOLUTE_PATTERNS` excludes Umbrel-owned paths**

Check that `isUmbrelOwnedPath` (line ~199) still returns `true` for `/trpc`, `/manager-api`, `/api/files`, `/api/debug`. The Referer-based root-absolute middleware (line ~1639) must skip these.

- [ ] **Step 3: Confirm WebSocket upgrades preserve query strings**

WebSocket upgrade at line ~1757 sets `request.url = strippedPath + search`. Verify this is still correct after all changes.

- [ ] **Step 4: Run typecheck**

Run: `cd /root/vscode/umbrel/source && npx tsc --noEmit --skipLibCheck`

Expected: Zero TypeScript errors.

- [ ] **Step 5: Verify file line count is reasonable**

Run: `wc -l /root/vscode/umbrel/source/modules/server/index.ts`

Expected: ~2100-2146 lines (was 2146 before changes, removal of 25-line block should bring to ~2121).

---

## Execution Notes

- **Deploy command (external VPS):**
  ```bash
  cd /etc/dokploy/compose/n8n-umbrelos-oazure/code/ && docker compose build --no-cache && docker compose up -d
  ```

- **Test commands (from browser after external deploy):**
  1. Open WebUI: navigate to `/proxy/open-webui/`, open DevTools → Network, check no `/proxy/nodes/` requests return 502.
  2. Home Assistant: navigate to `/proxy/home-assistant/`, confirm UI loads (not informational page).
  3. Tailscale: navigate to `/proxy/tailscale/`, confirm UI loads or proper informational page appears (Tailscale has a web UI at port 8240).
  4. Jellyfin: `/proxy/jellyfin/web/` still works.
  5. Nextcloud: `/proxy/nextcloud/` still works.
  6. Umbrel routes: `os.dominic.pw/trpc` returns Umbrel tRPC (not proxied).