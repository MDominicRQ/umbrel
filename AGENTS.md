# AGENTS.md

## Project Overview

This is a Docker container project for [UmbrelOS](https://umbrel.com/umbrelos). It wraps the upstream [umbrel](https://github.com/getumbrel/umbrel) repository in a Docker image, applying custom patches from the `source/` directory during build.

## Architecture

- **Dockerfile**: Multi-stage build; pulls upstream umbrel at `VERSION_ARG`, overlays `source/` patches, builds UI and backend, creates final Debian-based image.
- **entry.sh**: Container entry point; sets up Docker networking (`umbrel_main_network` at `10.21.0.0/16`), verifies bind mounts, thenexecs into umbreld.
- **source/**: TypeScript source patches overlaid onto the upstream umbrel at build time (copied to `/packages/umbreld/source` in the base stage).
- **compose.yml**: Builds locally from Dockerfile (no remote image pull needed for local dev).

## Key Commands

```bash
# Deploy with local build (builds image first, then runs containers)
docker compose up --build

# Build only (without running)
docker compose build

# ShellCheck + Hadolint (run via CI, or locally)
shellcheck entry.sh
hadolint Dockerfile
```

## CI/CD

- **Build**: Triggered manually via `workflow_dispatch` on `build.yml`. Builds multi-platform (amd64, arm64) images and pushes to Docker Hub and GHCR.
- **Check**: Shared workflow (`check.yml`) called by build. Runs shellcheck on shell scripts and hadolint on Dockerfile.
- **Version**: Set via `vars.VERSION` in GitHub repo settings, not in code.

## Local Development Notes

- The container requires Docker socket bind mount and a `/data` volume bind.
- `pid: host` is required in compose for container introspection.
- The `source/` directory is not a standalone project—it only contains patches applied during Docker build.

## Styling / Conventions

- Shell scripts: `set -Eeuo pipefail`, trap ERR for error reporting, output uses colored `❯` prefix.
- Dockerfile: Uses BuildKit syntax (`# syntax=docker/dockerfile:1`), multi-stage builds, Debian bookworm base.
