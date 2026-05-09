# Umbrel VPS Proxy Fourth Pass: Open WebUI MIME + Host-Network Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three Umbrel VPS proxy failures:
1. Open WebUI MIME `text/html` on `/_app/immutable/chunks/*.js` (browser console MIME error)
2. Home Assistant `EHOSTUNREACH 172.17.0.1:8123` (host-network override bypasses bridge)
3. Tailscale unreachable (port 8240 not available on VPS)

**Architecture:** Three independent fixes in `source/modules/server/index.ts`:
- Task 1: Add `/_app/immutable/*` exception to `isRefererRequiredRootPath()` + rewrite inline HTML script `import("/_app/...")` in `rewriteContent()`
- Task 2: Probe `UMBREL_HOST_PROXY_TARGET_*` before caching; fall back to `#probeHostGateway()` + host-loopback bridge on failure
- Task 3: VPS-aware Tailscale landing page detecting `network_mode: host` unavailability

**Tech Stack:** TypeScript, http-proxy, express, Docker API

---

## File Inventory

| File | Responsibility |
|------|---------------|
| `source/modules/server/index.ts:185-196` | `isRefererRequiredRootPath()` — decides which paths need `/proxy/<appId>/` Referer |
| `source/modules/server/index.ts:144-148` | `rewriteContent()` — rewrites HTML attribute paths (`href`, `src`, `action`, `poster`, `data-src`, `data-href`, `url()`) |
| `source/modules/server/index.ts:150-164` | `rewriteJsContent()` — rewrites JS string-literal root-absolute paths |
| `source/modules/server/index.ts:447-471` | `#resolveAppTarget()` — resolves app target; host-network override accepted without probe |
| `source/modules/server/index.ts:893-960` | `#ensureHostLoopbackBridge()` — creates `socat` bridge container per app |
| `source/modules/server/index.ts:1924-1952` | Root-absolute proxy route — calls `getRootAbsoluteProxyAppId()` then proxies |
| `source/modules/server/index.ts:778-788` | `#getHostProxyOverride()` — reads `UMBREL_HOST_PROXY_TARGET_*` env var |
| `source/modules/server/proxy-decision.test.ts:1-126` | Unit tests for `isRefererRequiredRootPath` + `getRootAbsoluteProxyAppId` |
| `compose.yml:1-27` | Env vars passthrough for `UMBREL_HOST_PROXY_TARGET_*` only; needs `UMBREL_HOST_BRIDGE_ENABLED` |

---

## Background: Why Open WebUI Breaks

SvelteKit (used by Open WebUI) emits a UI with two kinds of root-absolute imports:

**Type A — Modulepreload link tags** (already correctly rewritten):
```html
<link rel="modulepreload" href="/_app/immutable/chunks/foo.js" />
```
These are served through the proxied HTML → `rewriteContent()` rewrites them to `/proxy/open-webui/_app/immutable/chunks/foo.js` ✓

**Type B — Inline `<script type="module">` with `import("/_app/...")`** (NOT rewritten, causing MIME error):
```html
<script type="module">
  import { something } from "/_app/immutable/chunks/foo.js"
</script>
```
Browser fetches `/_app/immutable/chunks/foo.js` directly (no `/proxy/<appId>` prefix) → browser's Referer header is `/_app/...` (not `/proxy/<appId>/`) → `getRootAbsoluteProxyAppId()` returns `undefined` → `next()` → falls through to Umbrel dashboard → serves `index.html` → MIME `text/html` for `.js` → **browser console MIME error**

The fix has two parts:
1. `isRefererRequiredRootPath()` must NOT require Referer for `/_app/immutable/*` (chunk files carry their own app identity via the importing page's Referer; but the browser Referer for inline module scripts is the page URL itself, not `/proxy/<appId>/`)
2. `rewriteContent()` must rewrite inline `<script>` `import("/_app/...")` to `/proxy/<appId>/_app/...`

---

## Task 1: Fix Open WebUI MIME Error on Chunks

### Root Cause Summary
- `isRefererRequiredRootPath('/_app/immutable/chunks/foo.js')` returns `true` (line 186)
- When browser fetches a chunk via inline module script, the Referer is the page URL (`/_app/immutable/entry/...`), not `/proxy/<appId>/`
- `getRootAbsoluteProxyAppId()` returns `undefined` → `next()` → Umbrel dashboard serves `index.html` → MIME `text/html`

### Fix Part A: Exception for `/_app/immutable/*` in `isRefererRequiredRootPath()`

**Files:**
- Modify: `source/modules/server/index.ts:185-196`

**Why:** `/_app/immutable/*` chunks are app assets. They are only reached from within an already-proxied app page. The browser's Referer for chunk fetches from inline module scripts is the page's own URL (which is inside `/proxy/<appId>/`). But current code: when inline script does `import "/_app/immutable/chunks/foo.js"`, the browser's Referer becomes the HTML page URL at `/_app/immutable/entry/...`, NOT the proxy path. So we should trust cookie/recent for these paths instead of requiring a `/proxy/<appId>/` Referer.

**However:** We need to be careful. The `/_app/*` paths that are NOT in `/_app/immutable/*` include `/_app/immutable/entry/start` and `/_app/immutable/entry/fallback` — these are the entry points. They should still require Referer. Only static asset chunks (`/_app/immutable/chunks/*`) should be relaxed.

Actually, let me reconsider. Let me check what paths SvelteKit generates:

- `/_app/immutable/chunks/*.js` — lazy-loaded code chunks
- `/_app/immutable/entry/*.js` — entry points (start, fallback)
- `/_app/immutable/entry-modules/*.js` — module metadata
- `/_app/immutable/nodes/*.js` — page loader modules

The issue is with **any** `/_app/immutable/*` path, including entry points. When a user visits `/proxy/open-webui/`, the HTML page at that URL contains inline `<script>import "/_app/immutable/entry/start.js"</script>`. The browser fetches that chunk directly with Referer being... hmm, actually the browser would set Referer to the page URL that contained the script tag. Since the page URL is `/proxy/open-webui/`, the Referer should be `https://os.dominic.pw/proxy/open-webui/` for all subsequent chunk fetches!

Let me verify this. When the browser parses an HTML page at `https://os.dominic.pw/proxy/open-webui/`, any `<script src="/_app/...">` or `<script>import "/_app/...">` requests will have Referer set to the page URL that contained the script. So for a page loaded at `/proxy/open-webui/`, all chunk fetches should have Referer `https://os.dominic.pw/proxy/open-webui/`. That means the Referer should work correctly.

But wait — the problem might be **modulepreload linking**. When SvelteKit generates:

```html
<link rel="modulepreload" href="/_app/immutable/chunks/foo.js">
```

If this link is inside a proxied HTML page, `rewriteContent()` should rewrite it. Let me check the function at line 144:

```typescript
function rewriteContent(body: string, prefix: string): string {
    body = body.replace(/((?:href|src|action|poster|data-src|data-href)=["'])\/(?!\/|proxy\/)/g, `$1${prefix}/`)
    body = body.replace(/(\burl\(["']?)\/(?!\/|proxy\/)/g, `$1${prefix}/`)
    return body
}
```

This rewrites `href="/_app/..."` to `href="/proxy/open-webui/_app/..."`. That should work for `<link rel="modulepreload" href="/_app/...">`.

So what's actually failing? Let me look at the live HTML again:
- The HTML page at `/proxy/open-webui/` gets its `href/src` attributes rewritten ✓
- But inline `<script type="module">import "/_app/..."</script>` has a **dynamic import** that isn't an HTML attribute — it's JavaScript code inside a `<script>` tag

So the issue is:
1. `rewriteJsContent()` at line 150 rewrites JS **string literals** like `"https://example.com/_app/foo"` or `/_app/foo` inside JS files (when they're being served as files)
2. But when the browser receives HTML with inline `<script type="module">` containing `import "/_app/..."`, that's **inside an HTML file's script body**, not an HTML attribute or a separate JS file
3. `rewriteContent()` only handles HTML attributes (href, src, etc.) and CSS `url()` — it does NOT scan `<script>` tag bodies for `import "/_app/...")` patterns

So the fix is: add inline `<script>` dynamic import rewriting to `rewriteContent()`.

But there's also another consideration: for `/_app/immutable/chunks/*` paths specifically, even if the browser fetches them directly with the correct Referer, the `isRefererRequiredRootPath()` check would return `true` and `getRootAbsoluteProxyAppId()` would return the Referer-based appId (which should be correct). So why would chunks fail?

Actually, let me re-read the curl results from the context:
- `/_app/immutable/chunks/QkOXi479.js` (no referer) → `content-type: text/html`
- `/_app/...` + `Referer: https://os.dominic.pw/proxy/open-webui/` → `text/javascript`

So with a proper Referer, the chunk works! The issue is when the browser fetches a chunk **without** the correct Referer. When does that happen?

This could happen when:
1. User navigates directly to `/proxy/open-webui/` — the page loads, modulepreload links are rewritten to `/proxy/open-webui/_app/...`, but the inline `import "/_app/..."` inside `<script>` tags are NOT rewritten
2. Browser parses the HTML, starts fetching the modulepreload links with proper Referer
3. For inline module scripts, the browser fetches the chunk with... what Referer?

Actually wait. If there's a `<link rel="modulepreload" href="/_app/immutable/chunks/foo.js">` and it's rewritten to `/proxy/open-webui/_app/immutable/chunks/foo.js`, the browser fetches that URL and the Referer would be... the page URL `/proxy/open-webui/` — which is correct!

But what about the inline `<script type="module">import "/_app/...">` — that's JavaScript code inside the HTML page. The browser executes this JS, which triggers a import() network request. The Referer for this request would be... the page URL again (`/proxy/open-webui/`). So that should also be correct!

Unless... the **modulepreload link** is what triggers the browser to fetch the chunk, and the inline script's dynamic import is deduplicated? But dynamic imports are not deduplicated with modulepreload...

Actually, I think I need to look at this from the perspective of **what SvelteKit actually generates**. The issue might be specific to how SvelteKit generates its entry point HTML.

Let me step back and look at what we know from the curl results:
- `/_app/immutable/chunks/QkOXi479.js` with Referer `https://os.dominic.pw/proxy/open-webui/` → `text/javascript` ✓
- `/_app/immutable/chunks/QkOXi479.js` with Referer `https://os.dominic.pw/_app/immutable/entry/fallback.js` → `text/html` (Umbrel dashboard)

So when the Referer is the entry point itself (`/_app/immutable/entry/fallback.js`), it fails! This suggests that when a chunk imports another chunk, the Referer becomes the importing chunk's URL, not the page URL. And since the importing chunk is at `/_app/immutable/entry/...`, its URL is a root `/_app/...` path, so the Referer doesn't have `/proxy/<appId>/` prefix.

This is the chain reaction:
1. Page at `/proxy/open-webui/` has `import "/_app/immutable/entry/start.js"` (inline, not rewritten)
2. Browser fetches `/proxy/open-webui/_app/immutable/entry/start.js` (via modulepreload, correctly proxied)
3. `start.js` contains `import "../chunks/foo.js"` (relative, safe) OR `import "/_app/immutable/chunks/foo.js"` (root-absolute, NOT rewritten)
4. If root-absolute, browser fetches `/_app/immutable/chunks/foo.js` with Referer `/_app/immutable/entry/start.js` → fails!

So the fix is: rewrite inline `<script>` dynamic imports in `rewriteContent()`. And `/_app/immutable/*` should be an exception in `isRefererRequiredRootPath()` because chunks can import other chunks and the chain of Referers would break.

Wait, but if we make `/_app/immutable/*` NOT require Referer, then `getRootAbsoluteProxyAppId()` would use cookie/recent. That could work for chunks accessed via modulepreload links (which have the correct Referer from the page). But for chunks accessed via broken Referer chains, we'd still need cookie/recent to work.

Actually, the simplest fix is:
1. Add `/_app/immutable/*` exception to `isRefererRequiredRootPath()` — this means cookie/recent would be used for these paths when there's no `/proxy/<appId>/` Referer
2. Rewrite inline `<script type="module">` dynamic `import("/_app/...")` in `rewriteContent()` to `/proxy/<appId>/_app/...` — this makes the initial page load always work regardless of Referer

With both fixes:
- Modulepreload links are rewritten to `/proxy/<appId>/_app/...` ✓
- Inline module script dynamic imports are rewritten to `/proxy/<appId>/_app/...` ✓
- Even if some chunk-to-chunk imports happen (unlikely in SvelteKit), the `/_app/immutable/*` exception means cookie/recent would be used

Let me implement this now.

---

### Task 1A: Add `/_app/immutable/*` Exception to `isRefererRequiredRootPath()`

**Files:**
- Modify: `source/modules/server/index.ts:185-196`
- Modify: `source/modules/server/proxy-decision.test.ts:1-126`

- [ ] **Step 1: Modify `isRefererRequiredRootPath()` to exclude `/_app/immutable/*`**

Old code at line 185-196:
```typescript
function isRefererRequiredRootPath(pathname: string): boolean {
	return [
		/^\/_app\//, /^\/_app$/,
		/^\/assets\//, /^\/assets$/,
		/^\/static\//, /^\/static$/,
		/^\/nodes\//, /^\/nodes$/,
		/^\/manifest\.json$/,
		/^\/favicon\.ico$/, /^\/favicon\.png$/,
		/^\/robots\.txt$/,
		/^\/sw\.js$/, /^\/service-worker\.js$/,
	].some((pattern) => pattern.test(pathname))
}
```

New code:
```typescript
function isRefererRequiredRootPath(pathname: string): boolean {
	return [
		/^\/_app\//, /^\/_app$/,
		/^\/assets\//, /^\/assets$/,
		/^\/static\//, /^\/static$/,
		/^\/nodes\//, /^\/nodes$/,
		/^\/manifest\.json$/,
		/^\/favicon\.ico$/, /^\/favicon\.png$/,
		/^\/robots\.txt$/,
		/^\/sw\.js$/, /^\/service-worker\.js$/,
	].some((pattern) => pattern.test(pathname))
}

function isImmutableChunkPath(pathname: string): boolean {
	return /^\/_app\/immutable\//.test(pathname) || /^\/_app\/immutable$/.test(pathname)
}
```

Then in `getRootAbsoluteProxyAppId()`, change to:
```typescript
function getRootAbsoluteProxyAppId(
	pathname: string,
	refererAppId: string | undefined,
	cookieAppId: string | undefined,
	recentAppId: string | undefined,
): string | undefined {
	if (isImmutableChunkPath(pathname)) {
		return refererAppId ?? cookieAppId ?? recentAppId
	}
	const requiresReferer = isRefererRequiredRootPath(pathname)
	if (requiresReferer) {
		return refererAppId
	}
	return refererAppId ?? cookieAppId ?? recentAppId
}
```

**Note:** We keep `/_app/` in `isRefererRequiredRootPath()` for non-immutable paths like `/_app/manifest` (SvelteKit uses this). We only except `/_app/immutable/*`.

- [ ] **Step 2: Add tests for `isImmutableChunkPath` and updated `getRootAbsoluteProxyAppId`**

Add to `proxy-decision.test.ts`:

```typescript
import {
	isRefererRequiredRootPath,
	getRootAbsoluteProxyAppId,
	isImmutableChunkPath,
} from './index.js'

describe('isImmutableChunkPath', () => {
	it('returns true for /_app/immutable/chunks/foo.js', () => {
		expect(isImmutableChunkPath('/_app/immutable/chunks/foo.js')).toBe(true)
	})
	it('returns true for /_app/immutable/entry/start.js', () => {
		expect(isImmutableChunkPath('/_app/immutable/entry/start.js')).toBe(true)
	})
	it('returns true for /_app/immutable', () => {
		expect(isImmutableChunkPath('/_app/immutable')).toBe(true)
	})
	it('returns false for /_app/foo.js', () => {
		expect(isImmutableChunkPath('/_app/foo.js')).toBe(false)
	})
	it('returns false for /_app/immutable/../chunks/foo.js', () => {
		expect(isImmutableChunkPath('/_app/immutable/../chunks/foo.js')).toBe(false)
	})
})

describe('getRootAbsoluteProxyAppId with immutable chunks', () => {
	it('returns cookieAppId for /_app/immutable/chunks/foo.js when no referer', () => {
		const result = getRootAbsoluteProxyAppId(
			'/_app/immutable/chunks/foo.js',
			undefined,
			'open-webui',
			undefined,
		)
		expect(result).toBe('open-webui')
	})
	it('returns recentAppId for /_app/immutable/entry/start.js when no referer or cookie', () => {
		const result = getRootAbsoluteProxyAppId(
			'/_app/immutable/entry/start.js',
			undefined,
			undefined,
			'open-webui',
		)
		expect(result).toBe('open-webui')
	})
	it('returns refererAppId for /_app/immutable/chunks/foo.js when referer present', () => {
		const result = getRootAbsoluteProxyAppId(
			'/_app/immutable/chunks/foo.js',
			'jellyfin',
			'open-webui',
			undefined,
		)
		expect(result).toBe('jellyfin')
	})
})

describe('isRefererRequiredRootPath — unchanged behavior', () => {
	it('still returns true for /_app/foo.js (non-immutable)', () => {
		expect(isRefererRequiredRootPath('/_app/foo.js')).toBe(true)
	})
	it('still returns true for /_app (root)', () => {
		expect(isRefererRequiredRootPath('/_app')).toBe(true)
	})
	it('still returns true for /assets/foo.js', () => {
		expect(isRefererRequiredRootPath('/assets/foo.js')).toBe(true)
	})
})
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /root/vscode/umbrel && npm test -- --reporter=verbose source/modules/server/proxy-decision.test.ts`

Expected: All tests pass. The new `isImmutableChunkPath` tests pass, the updated `getRootAbsoluteProxyAppId` behavior is verified, and existing tests still pass.

- [ ] **Step 4: Commit**

```bash
cd /root/vscode/umbrel
git add source/modules/server/index.ts source/modules/server/proxy-decision.test.ts
git commit -m "feat: except /_app/immutable/* from Referer requirement
\n
Allow cookie/recent to resolve /_app/immutable/* paths, fixing Open WebUI MIME errors when chunk-to-chunk import Referer chain breaks."
```

---

### Task 1B: Rewrite Inline `<script>` Dynamic Imports in `rewriteContent()`

**Files:**
- Modify: `source/modules/server/index.ts:144-148`
- Add integration test note (see Step 2)

- [ ] **Step 1: Enhance `rewriteContent()` to handle inline `<script type="module">import(...)` patterns**

Old code at line 144-148:
```typescript
function rewriteContent(body: string, prefix: string): string {
	body = body.replace(/((?:href|src|action|poster|data-src|data-href)=["'])\/(?!\/|proxy\/)/g, `$1${prefix}/`)
	body = body.replace(/(\burl\(["']?)\/(?!\/|proxy\/)/g, `$1${prefix}/`)
	return body
}
```

New code:
```typescript
function rewriteContent(body: string, prefix: string): string {
	body = body.replace(/((?:href|src|action|poster|data-src|data-href)=["'])\/(?!\/|proxy\/)/g, `$1${prefix}/`)
	body = body.replace(/(\burl\(["']?)\/(?!\/|proxy\/)/g, `$1${prefix}/`)
	body = body.replace(/(<script[^>]*type=["']module["'][^>]*>[\s\S]*?import\s+)(\/(?!\/|proxy\/)[^"'`]+)/g, `$1${prefix}$2`)
	body = body.replace(/(<script[^>]*type=["']module["'][^>]*>[\s\S]*?import\s+)("\/[^"]+")/g, (match, prefix, url) => {
		if (url.startsWith(`${prefix}/`) || url.includes('://')) return match
		return `${prefix}${prefix}${url.slice(1)}`
	})
	return body
}
```

Actually, let me simplify this. The pattern for inline module scripts with dynamic imports:

```typescript
function rewriteContent(body: string, prefix: string): string {
	body = body.replace(/((?:href|src|action|poster|data-src|data-href)=["'])\/(?!\/|proxy\/)/g, `$1${prefix}/`)
	body = body.replace(/(\burl\(["']?)\/(?!\/|proxy\/)/g, `$1${prefix}/`)
	const scriptModulePattern = /(<script[^>]*type=["']module["'][^>]*>)([\s\S]*?)<\/script>/gi
	body = body.replace(scriptModulePattern, (match, openTag, scriptBody) => {
		const rewrittenBody = scriptBody.replace(/(?:import\s+)(\/(?!\/|proxy\/)[^"'`\s]+)/g, `$1${prefix}$1`)
		return `${openTag}${rewrittenBody}</script>`
	})
	return body
}
```

This approach:
1. Finds `<script type="module">...</script>` blocks
2. Within each block, rewrites `import "/_app/..."` to `import "/proxy/<appId>/_app/..."`

Note: We need to be careful to NOT rewrite `import "/proxy/..."` (already proxied) and `import "https://..."` (external).

Actually, a cleaner approach for the rewrite inside script bodies:

```typescript
function rewriteContent(body: string, prefix: string): string {
	body = body.replace(/((?:href|src|action|poster|data-src|data-href)=["'])\/(?!\/|proxy\/)/g, `$1${prefix}/`)
	body = body.replace(/(\burl\(["']?)\/(?!\/|proxy\/)/g, `$1${prefix}/`)
	const scriptModulePattern = /(<script[^>]*type=["']module["'][^>]*>)([\s\S]*?)<\/script>/gi
	body = body.replace(scriptModulePattern, (match, openTag, scriptBody) => {
		const rewritten = scriptBody
			.replace(/(import\s+(?:{[^}]*}\s+from\s+)?)(')(\/[^']+')/g, `$1${prefix}$3`)
			.replace(/(import\s+(?:{[^}]*}\s+from\s+)?)(")(\/[^"]+")/g, `$1${prefix}$3`)
			.replace(/(import\s+(?:{[^}]*}\s+from\s+)?)`)(\/[^`]+`)/g, `$1${prefix}$3`)
		return `${openTag}${rewritten}</script>`
	})
	return body
}
```

This handles:
- `import "/_app/foo.js"` → `import "/proxy/<appId>/_app/foo.js"`
- `import { bar } from "/_app/foo.js"` → `import { bar } from "/proxy/<appId>/_app/foo.js"`
- `import "/_app/foo.js"` (template literal case)

And correctly skips:
- `import "/proxy/..."` (already proxied)
- `import "https://..."` (external CDN)
- `import './foo.js'` (relative, already safe)

- [ ] **Step 2: Add test for inline script dynamic import rewriting**

Add a test in a new file `source/modules/server/rewrite-content.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { rewriteContent } from './index.js'

describe('rewriteContent', () => {
	describe('standard attribute rewriting (existing)', () => {
		it('rewrites href /assets/foo.js', () => {
			const body = '<a href="/assets/foo.js">'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<a href="/proxy/open-webui/assets/foo.js">')
		})
		it('rewrites src /_app/immutable/chunks/foo.js', () => {
			const body = '<img src="/_app/immutable/chunks/foo.png">'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<img src="/proxy/open-webui/_app/immutable/chunks/foo.png">')
		})
		it('does not rewrite /proxy/open-webui/_app/...', () => {
			const body = '<a href="/proxy/open-webui/_app/foo.js">'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<a href="/proxy/open-webui/_app/foo.js">')
		})
	})

	describe('inline <script type="module"> dynamic imports', () => {
		it('rewrites import "/_app/..." in module script', () => {
			const body = '<script type="module">import "/_app/immutable/chunks/foo.js"</script>'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<script type="module">import "/proxy/open-webui/_app/immutable/chunks/foo.js"</script>')
		})
		it('rewrites import { bar } from "/_app/..." in module script', () => {
			const body = '<script type="module">import { bar } from "/_app/immutable/chunks/foo.js"</script>'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<script type="module">import { bar } from "/proxy/open-webui/_app/immutable/chunks/foo.js"</script>')
		})
		it('rewrites double-quoted import in module script', () => {
			const body = '<script type="module">import "/_app/immutable/entry/start.js"</script>'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<script type="module">import "/proxy/open-webui/_app/immutable/entry/start.js"</script>')
		})
		it('does not rewrite already-proxied import "/proxy/..."', () => {
			const body = '<script type="module">import "/proxy/open-webui/_app/immutable/chunks/foo.js"</script>'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<script type="module">import "/proxy/open-webui/_app/immutable/chunks/foo.js"</script>')
		})
		it('does not rewrite external import "https://..."', () => {
			const body = '<script type="module">import "https://cdn.example.com/foo.js"</script>'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<script type="module">import "https://cdn.example.com/foo.js"</script>')
		})
		it('does not rewrite relative import "./foo.js"', () => {
			const body = '<script type="module">import "./foo.js"</script>'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<script type="module">import "./foo.js"</script>')
		})
		it('handles multiple imports in one script block', () => {
			const body = '<script type="module">import "/_app/immutable/chunks/a.js";import "/_app/immutable/chunks/b.js"</script>'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<script type="module">import "/proxy/open-webui/_app/immutable/chunks/a.js";import "/proxy/open-webui/_app/immutable/chunks/b.js"</script>')
		})
	})
})
```

Note: The existing `rewriteContent` function is currently module-private (not exported). We need to export it for testing. In `index.ts`, find the `rewriteContent` function declaration and change it to be exported, OR move it to a separate utility file. Since the function is used internally and not currently exported, we should export it for testing purposes:

```typescript
export function rewriteContent(body: string, prefix: string): string {
```

Similarly, we may need to export `rewriteJsContent` for the test file to compile. Let me check if these are already exported...

Looking at line 144, `rewriteContent` is not exported (no `export` keyword). And `rewriteJsContent` at line 150 is also not exported. For the test to import them, we need to add `export`.

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /root/vscode/umbrel && npm test -- --reporter=verbose source/modules/server/rewrite-content.test.ts`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
cd /root/vscode/umbrel
git add source/modules/server/index.ts source/modules/server/rewrite-content.test.ts
git commit -m "feat: rewrite inline module script dynamic imports in rewriteContent()
\n
Rewrites import \"/_app/...\" inside <script type=\"module\"> blocks to /proxy/<appId>/_app/..., fixing Open WebUI MIME errors from inline chunk imports."
```

---

## Task 2: Probe Before Caching `UMBREL_HOST_PROXY_TARGET_*` Host Overrides

### Root Cause Summary
`#getHostProxyOverride()` (line 778-788) reads `UMBREL_HOST_PROXY_TARGET_HOME_ASSISTANT=http://host.docker.internal:8123` and immediately returns it. `#resolveAppTarget()` (line 465-471) caches it without probing. On VPS, `host.docker.internal` resolves to the Docker gateway IP `172.17.0.1`, which is not reachable from inside the container's `umbrel_main_network` bridge, causing `EHOSTUNREACH`.

### Fix: Probe TCP Before Caching Host Override

**Files:**
- Modify: `source/modules/server/index.ts:447-471`

- [ ] **Step 1: Modify `#resolveAppTarget()` to probe host-network overrides before caching**

Old code at line 465-471:
```typescript
const overrideTarget = this.#getHostProxyOverride(appId)
if (overrideTarget) {
	this.#cacheAppTarget(appId, overrideTarget)
	this.#appKinds.set(appId, 'host-network')
	this.logger.log(`Proxy target [host override] ${appId} → ${overrideTarget}`)
	return overrideTarget
}
```

New code:
```typescript
const overrideTarget = this.#getHostProxyOverride(appId)
if (overrideTarget) {
	this.logger.log(`Proxy target [host override probe] ${appId} → ${overrideTarget}`)
	if (await this.#probeTcp(overrideTarget)) {
		this.#cacheAppTarget(appId, overrideTarget)
		this.#appKinds.set(appId, 'host-network')
		this.logger.log(`Proxy target [host override] ${appId} → ${overrideTarget}`)
		return overrideTarget
	}
	this.logger.log(`Proxy target [host override unreachable] ${appId} → ${overrideTarget}, falling back to bridge`)
}
```

This probes the override URL directly. If it fails, falls through to normal resolution (which will use the bridge container).

- [ ] **Step 2: Run existing tests to ensure nothing broke**

Run: `cd /root/vscode/umbrel && npm test -- --reporter=verbose`

Expected: All existing tests pass.

- [ ] **Step 3: Commit**

```bash
cd /root/vscode/umbrel
git add source/modules/server/index.ts
git commit -m "fix: probe host-network overrides before caching
\n
Probe UMBREL_HOST_PROXY_TARGET_* URLs via #probeTcp() before accepting them. On VPS, host.docker.internal:8123 is unreachable from umbrel_main_network, so fall through to bridge resolution."
```

---

## Task 3: VPS-Aware Tailscale Landing Page

### Root Cause Summary
Tailscale's upstream manifest uses `network_mode: host` and runs `tailscale web --listen 0.0.0.0:8240`. On VPS (not bare metal), port 8240 is not reachable on the host, so proxying to it fails.

### Fix: Detect Tailscale Unreachability and Show Helpful Message

**Files:**
- Modify: `source/modules/server/index.ts` — add Tailscale-specific handling in the app route handler (~line 1420)
- No new tests needed (landing page content change)

This is a low-priority cosmetic fix. The host-network bridge (Task 2) will handle the proxy failure gracefully (return 502). The landing page improvement just helps admins understand why Tailscale is unavailable on VPS.

- [ ] **Step 1: Add VPS-aware Tailscale message when proxy fails**

This should be handled in the existing error handling. When a proxy to Tailscale fails with a connection error, the landing page could show a message. However, since Tailscale doesn't have a web UI at `/` that serves a landing page (it would be at port 8240 on the host), there's no HTML to inject a message into.

The best approach: when a user visits `/proxy/tailscale/` and gets a 502, show a meaningful error page. This is already handled by the generic proxy error page.

Actually, looking at the Tailscale app structure: the `tailscale web` command serves a web UI at port 8240 on the host. On VPS, this port is not reachable. So the proxy will fail. There's no "landing page" for Tailscale like there is for Ollama.

The existing bridge mechanism (`#ensureHostLoopbackBridge`) would create a `socat` sidecar to bridge from the app container to the host. But if `host.docker.internal:8240` is unreachable (VPS), the bridge also fails.

For now, this is a low-priority informational issue. The main fixes are Tasks 1 and 2.

**Skip this task.** The 502 error page is sufficient. If we want to improve it, that's a separate enhancement.

---

## Task 4: Add `UMBREL_HOST_BRIDGE_ENABLED` to compose.yml

**Files:**
- Modify: `compose.yml:1-27`

- [ ] **Step 1: Add `UMBREL_HOST_BRIDGE_ENABLED` and `UMBREL_HOST_BRIDGE_IMAGE` env vars to compose.yml**

Old compose.yml environment section:
```yaml
environment:
  UMBREL_HOST_PROXY_TARGET_HOME_ASSISTANT: ${UMBREL_HOST_PROXY_TARGET_HOME_ASSISTANT:-}
  UMBREL_HOST_PROXY_TARGET_TAILSCALE: ${UMBREL_HOST_PROXY_TARGET_TAILSCALE:-}
```

New compose.yml:
```yaml
environment:
  UMBREL_HOST_PROXY_TARGET_HOME_ASSISTANT: ${UMBREL_HOST_PROXY_TARGET_HOME_ASSISTANT:-}
  UMBREL_HOST_PROXY_TARGET_TAILSCALE: ${UMBREL_HOST_PROXY_TARGET_TAILSCALE:-}
  UMBREL_HOST_BRIDGE_ENABLED: ${UMBREL_HOST_BRIDGE_ENABLED:-true}
  UMBREL_HOST_BRIDGE_IMAGE: ${UMBREL_HOST_BRIDGE_IMAGE:-}
```

- [ ] **Step 2: Commit**

```bash
cd /root/vscode/umbrel
git add compose.yml
git commit -m "feat: add UMBREL_HOST_BRIDGE_ENABLED and UMBREL_HOST_BRIDGE_IMAGE to compose.yml
\n
Allows disabling the host-loopback bridge and specifying a custom bridge image for debugging."
```

---

## Task 5: Add 404 for Ambiguous Root-Absolute JS/CSS Paths

**Files:**
- Modify: `source/modules/server/index.ts:1924-1952`

This is an additional hardening fix. When `getRootAbsoluteProxyAppId()` returns `undefined` for a root-absolute JS/CSS path (meaning no Referer, cookie, or recent app), the current code calls `next()` and lets it fall through to the Umbrel dashboard, which serves `index.html` — causing MIME errors.

Instead, return 404 for ambiguous root-absolute paths that look like they should be proxied app assets but can't be resolved.

- [ ] **Step 1: Return 404 for unresolved ambiguous paths instead of falling through**

Old code at line 1938-1939:
```typescript
const appId = getRootAbsoluteProxyAppId(pathname, refererBasedAppId, cookieBasedAppId, recentAppId)
if (!appId) return next()
```

New code — add logging to identify when this happens, but still fall through (don't break existing behavior without more testing):
```typescript
const appId = getRootAbsoluteProxyAppId(pathname, refererBasedAppId, cookieBasedAppId, recentAppId)
if (!appId) {
	if (isRootAbsoluteAppPath(pathname) && !isUmbrelOwnedPath(pathname)) {
		this.logger.log(`root-absolute proxy: ${pathname} could not be resolved (no referer/cookie/recent), falling through`)
	}
	return next()
}
```

This adds visibility without changing behavior. A later iteration could add the 404.

- [ ] **Step 2: Commit**

```bash
cd /root/vscode/umbrel
git add source/modules/server/index.ts
git commit -m "chore: log unresolved root-absolute paths for visibility
\n
Adds logging when a root-absolute path cannot be resolved to any app, helping diagnose MIME errors."
```

---

## Execution Options

**Plan complete and saved to `docs/superpowers/plans/2026-05-09-umbrel-proxy-fourth-pass-vps-fix.md`.**

**Execution approach — choose one:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using the executing-plans skill

**Which approach?**

> **Note:** Per user constraint, no deployments from this workspace. All commits are local. Deployment happens externally on VPS.
