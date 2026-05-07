# Umbrel Proxy Third-Pass VPS Fix Plan

## Context

Umbrel OS runs inside a Docker container. The container connects to `umbrel_main_network` (10.21.0.0/16) and resolves app containers via Docker DNS. Apps with `network_mode: host` (Home Assistant, Tailscale) do not join Docker bridge networks and cannot be reached via Docker DNS.

This document describes the networking model and how to configure host-network apps for VPS reverse proxy scenarios.

## Networking Model

```
Internet → Traefik/Dokploy → Umbrel wrapper container (bridge) → Normal apps (umbrel_main_network IP)
                                                ↓
                              Host-network apps via host.docker.internal or Docker gateway
```

## Key Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `UMBREL_HOST_PROXY_TARGET_<APP>` | Override host-network app target | `UMBREL_HOST_PROXY_TARGET_HOME_ASSISTANT=http://host.docker.internal:8123` |
| `UMBREL_DOMAIN` | Enable subdomain routing | `UMBREL_DOMAIN=os.example.com` |
| `UMBREL_APP_PROXY_NETWORK` | Network for new app containers | `umbrel_main_network` (default) |
| `UMBREL_HOST_BRIDGE_ENABLED` | Enable/disable host-loopback bridge | `UMBREL_HOST_BRIDGE_ENABLED=false` |
| `UMBREL_HOST_BRIDGE_IMAGE` | Custom image for bridge sidecar | `UMBREL_HOST_BRIDGE_IMAGE=umbrel-os:local` |

## Networking Model

```
Internet → Traefik/Dokploy → Umbrel wrapper container (bridge) → Normal apps (umbrel_main_network IP)
                                                 ↓
                              Host-network apps via bridge sidecar (socat → host loopback)
```

In `configuration.yaml`:
```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 10.21.0.0/16
    - 172.16.0.0/12
```

### Tailscale

Tailscale does not typically expose a normal web UI. Access via:
- Admin console: https://login.tailscale.com
- Tailscale Serve/Funnel for exposing services

### CasaOS-Style Apps

CasaOS-style apps (dockurr/casa pattern) use:
- Bridge networking with published ports (not `network_mode: host`)
- Docker socket mount for app management
- A dedicated app network (e.g., `casa-net` on `10.22.0.0/16`)

Umbrel follows a similar model: one primary dashboard port, `/data` persistence, `/var/run/docker.sock` access.

## Troubleshooting

1. **"App not found or not running"** — App container not found in `docker ps`. Check the app is installed and running.
2. **Host-network app unreachable** — App binds to `127.0.0.1`. Check if bridge sidecar is running (`docker ps | grep bridge`). Use `/api/debug/proxy/<appId>` to diagnose bridge target.
3. **Home Assistant returns 400** — Configure `trusted_proxies` in `configuration.yaml`.
4. **Home Assistant UI loads but shows "Unable to connect"** — Check WebSocket support and HA version.
5. **Bridge port conflict** — Ports 18000-37999 are reserved. Ensure no other service binds on these ports on Docker gateway interfaces.

## Host-Loopback Bridge Architecture (VPS)

On a VPS, host-network apps (Home Assistant, Tailscale) may bind to `127.0.0.1` instead of a bridge interface. The Umbrel container cannot reach host loopback directly from Docker bridge networks.

Umbrel solves this with a **host-loopback bridge sidecar** — a small `socat` container that:
1. Listens on a Docker bridge gateway IP (e.g., `10.21.0.1`) on a high port (18000-37999)
2. Forwards TCP connections to `127.0.0.1:<appPort>` on the host

```
Umbrel container → http://10.21.0.1:18xxx → socat (host net) → 127.0.0.1:8123
```

**Security:** The bridge NEVER binds to `0.0.0.0` or public interfaces. It only binds to Docker gateway IPs that are reachable from within the Docker network.

**Port:** Each app gets a deterministic port in 18000-37999 based on its appId — stable across restarts.

**Disable:** Set `UMBREL_HOST_BRIDGE_ENABLED=false` to disable bridge creation.

**Debug:** Check `/api/debug/proxy/<appId>` for bridge diagnostics including expected bridge target.

## Changes Implemented (Fourth Pass)

| Task | Change | Commit |
|------|--------|--------|
| 1 | Hardened malformed proxy recovery + cache busting | 121a9cd |
| 2 | Cookie/recent-app fallback for root-absolute assets | (see git log) |
| 3 | Stale Open WebUI node chunk URL repair | 685baa1 |
| 4 | Preserve reverse proxy headers for host-network | (see git log) |
| 5 | Discover Docker gateway targets dynamically | (see git log) |
| 6 | Explicit host-network target overrides via env | (see git log) |
| 7 | Host-loopback bridge (deferred) | — |
| 8 | Home Assistant compatibility improvements | (see git log) |

## Changes Implemented (Fourth Pass — 2026-05-07 Late)

| Task | Change | Commit |
|------|--------|--------|
| 1 | Fix req.url authority for recovered malformed proxy paths | 34f8bcc |
| 2 | Move host override before compose heuristics + compose env pass-through | 999df66 |
| 3 | Add secure host-loopback bridge sidecars (socat) | (see git log) |
| 4 | Add X-Forwarded-For + WebSocket forwarded headers | (see git log) |
| 5 | Tailscale VPS-aware fallback page | (see git log) |
| 6 | Expand diagnostics (bridge/override info) | (see git log) |
| 7 | Update documentation | c002860 |
