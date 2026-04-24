# Fix CSP for Reverse Proxy Access - Design

## Problem

When UmbrelOS is accessed through a reverse proxy (Traefik/Dokploy) via HTTPS with a custom domain:
- Page loads but shows "⚠ Something went wrong"
- Browser console shows CSP violations: `Refused to connect to 'http://domain/trpc/...' because it violates the Content Security Policy directive "connect-src 'self'"`
- The tRPC client constructs HTTP URLs (from `location.protocol` being HTTP due to missing proxy headers)
- CSP blocks these requests since the external domain is not in `connect-src`

## Root Cause Analysis

1. **Upstream code** (`packages/umbreld/source/modules/server/index.ts`):
   ```typescript
   helmet.contentSecurityPolicy({
     directives: {
       connectSrc: ["'self'", 'https://apps.umbrel.com'],
       // ...
     },
   })
   ```
   - `connect-src 'self'` only allows same-origin requests
   - Does NOT include the external domain used via reverse proxy

2. **Upstream tRPC client** (`packages/ui/src/trpc/trpc.ts`):
   ```typescript
   const {protocol, hostname, port} = location
   const httpOrigin = `${protocol}//${hostname}${portPart}`
   ```
   - Uses browser's perceived origin for API calls
   - When Traefik forwards without proper headers, `protocol` may be wrong

## Solution

Modify the CSP configuration in the server to dynamically include the external domain from `X-Forwarded-Host` and `X-Forwarded-Proto` headers.

### Files to Modify

**Primary change:** Create/modify `source/modules/server/index.ts` as a patch

The patch will:
1. Read `X-Forwarded-Host` header to get the external domain
2. Read `X-Forwarded-Proto` to get the external protocol (https)
3. Build a dynamic `connect-src` that includes both `self` and the external origin
4. Apply this to the Helmet CSP configuration

### Implementation Approach

```typescript
// Middleware to capture proxy headers and make them available
// We need to do this BEFORE helmet CSP runs

// In start() method, before app.use(helmet...):

// Helper to extract external origin from proxy headers
const getExternalOrigin = (req: express.Request): string | null => {
  const forwardedHost = req.headers['x-forwarded-host'];
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (forwardedHost) {
    const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || 'https';
    const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
    return `${protocol}://${host}`;
  }
  return null;
};

// We need to configure CSP dynamically per request
// Helmet supports a function for directives that receives the request

this.app.use(
  helmet.contentSecurityPolicy({
    directives: {
      // ... other directives
      connectSrc: (req, res) => {
        const sources = ["'self'", 'https://apps.umbrel.com'];
        const externalOrigin = getExternalOrigin(req);
        if (externalOrigin) {
          sources.push(externalOrigin);
          // Also add wss:// variant for WebSocket
          sources.push(externalOrigin.replace('http:', 'ws:').replace('https:', 'wss:'));
        }
        return sources;
      },
    },
  }),
);
```

## Architecture Notes

- The patch applies to `packages/umbreld/source/modules/server/index.ts` in the upstream repo
- During Docker build, `source/` is copied to `/packages/umbreld/source`
- The TypeScript is compiled during the build stage
- Changes take effect in the final Docker image

## Testing Approach

1. Build Docker image locally (if resources allow)
2. Deploy with Traefik/Dokploy
3. Access via HTTPS domain
4. Verify in browser console: no CSP violations, API calls succeed

## Alternative Considered

**Static env var approach** (`CSP_DOMAINS` env var) - rejected in favor of automatic detection which requires no user configuration.

## Risks & Mitigations

1. **Security**: Adding external domains to CSP could allow unintended connections
   - Mitigation: Only add domains from trusted proxy headers (`X-Forwarded-Host` is set by reverse proxy, not client)

2. **Breaking direct IP access**: The fix must not break direct access via IP:port
   - Mitigation: `'self'` is always included, external origin is additive only when headers present
