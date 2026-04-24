# CSP Reverse Proxy Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow UmbrelOS to work behind a reverse proxy (Traefik/Dokploy) by dynamically adjusting the Content Security Policy to include the external domain from proxy headers.

**Architecture:** Modify the CSP configuration in the server module to read `X-Forwarded-Host` and `X-Forwarded-Proto` headers and dynamically add the external origin to `connect-src` directives.

**Tech Stack:** TypeScript, Express, Helmet, Docker multi-stage build

---

## File Structure

- **Create:** `source/modules/server/index.ts` — Patch file that overlays the upstream umbreld server module with fixed CSP configuration

---

## Task 1: Create CSP Reverse Proxy Patch

**Files:**
- Create: `source/modules/server/index.ts`

- [ ] **Step 1: Create the patch file with dynamic CSP support**

```typescript
import http from 'node:http'
import process from 'node:process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'
import {createGzip} from 'node:zlib'
import {pipeline} from 'node:stream/promises'

import {$} from 'execa'
import express from 'express'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'

import {WebSocketServer} from 'ws'
import {createProxyMiddleware} from 'http-proxy-middleware'

import getOrCreateFile from '../utilities/get-or-create-file.js'
import randomToken from '../utilities/random-token.js'

import type Umbreld from '../../index.js'
import * as jwt from '../jwt.js'
import {trpcExpressHandler, trpcWssHandler} from './trpc/index.js'
import createTerminalWebSocketHandler from './terminal-socket.js'

import fileApi from '../files/api.js'

export type ServerOptions = {umbreld: Umbreld}

export type ApiOptions = {
	publicApi: express.Router
	privateApi: express.Router
	umbreld: Umbreld
}

const asyncHandler = (
	handler: (request: express.Request, response: express.Response, next: express.NextFunction) => Promise<any>,
) =>
	function asyncHandlerWrapper(request: express.Request, response: express.Response, next: express.NextFunction) {
		return Promise.resolve(handler(request, response, next)).catch(next)
	}

const wrapHandlersWithAsyncHandler = (router: express.Router) => {
	for (const layer of router.stack) {
		if (layer.name === 'router') wrapHandlersWithAsyncHandler(layer.handle)
		else if (layer.route) {
			for (const routeLayer of layer.route.stack) routeLayer.handle = asyncHandler(routeLayer.handle)
		}
	}
}

class Server {
	umbreld: Umbreld
	logger: Umbreld['logger']
	port: number | undefined
	app?: express.Express
	server?: http.Server
	webSocketRouter = new Map<string, WebSocketServer>()

	constructor({umbreld}: ServerOptions) {
		this.umbreld = umbreld
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(name.toLowerCase())
	}

	async getJwtSecret() {
		const jwtSecretPath = `${this.umbreld.dataDirectory}/secrets/jwt`
		return getOrCreateFile(jwtSecretPath, randomToken(256))
	}

	async signToken() {
		return jwt.sign(await this.getJwtSecret())
	}

	async signProxyToken() {
		return jwt.signProxyToken(await this.getJwtSecret())
	}

	async verifyToken(token: string) {
		return jwt.verify(token, await this.getJwtSecret())
	}

	async verifyProxyToken(token: string) {
		return jwt.verifyProxyToken(token, await this.getJwtSecret())
	}

	mountWebSocketServer(path: string, setupHandler: (wss: WebSocketServer) => void) {
		const wss = new WebSocketServer({noServer: true})
		setupHandler(wss)
		this.webSocketRouter.set(path, wss)
	}

	async start() {
		await this.getJwtSecret()

		this.app = express()
		this.server = http.createServer(this.app)
		this.server.requestTimeout = 0

		this.app.use(cookieParser())

		// CSP with reverse proxy support
		this.app.use(
			helmet.contentSecurityPolicy({
				directives: {
					scriptSrc: this.umbreld.developmentMode ? ["'self'", "'unsafe-inline'"] : null,
					imgSrc: ['*', 'blob:'],
					connectSrc: (req, _res) => {
						const sources = ["'self'", 'https://apps.umbrel.com']
						const forwardedHost = req.headers['x-forwarded-host']
						const forwardedProto = req.headers['x-forwarded-proto']
						if (forwardedHost) {
							const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost
							const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : (forwardedProto || 'https')
							const externalOrigin = `${proto}://${host}`
							sources.push(externalOrigin)
							// Add WebSocket variant
							const wsProto = proto === 'https' ? 'wss' : 'ws'
							sources.push(`${wsProto}://${host}`)
						}
						return sources
					},
					upgradeInsecureRequests: null,
				},
			}),
		)
		this.app.use(helmet.referrerPolicy({policy: 'no-referrer'}))
		this.app.disable('x-powered-by')

		this.app.set('umbreld', this.umbreld)
		this.app.set('logger', this.logger)

		this.app.use((request, response, next) => {
			this.logger.verbose(`${request.method} ${request.path}`)
			next()
		})

		this.server?.on('upgrade', async (request, socket, head) => {
			try {
				const {pathname, searchParams} = new URL(`https://localhost${request.url}`)
				const wss = this.webSocketRouter.get(pathname)

				if (!wss) {
					if (this.umbreld.developmentMode) return
					throw new Error(`No WebSocket server mounted for ${pathname}`)
				}

				const token = searchParams.get('token')
				if (await this.verifyToken(token!)) {
					this.logger.verbose(`WS upgrade for ${pathname}`)
					wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request))
				}
			} catch (error) {
				this.logger.error(`Error upgrading websocket`, error)
				socket.destroy()
			}
		})

		this.app.get('/manager-api/v1/system/update-status', (request, response) => {
			response.json({state: 'success', progress: 100, description: '', updateTo: ''})
		})

		this.app.use('/trpc', trpcExpressHandler)
		this.mountWebSocketServer('/trpc', (wss) => {
			trpcWssHandler({wss, umbreld: this.umbreld, logger: this.logger})
		})

		this.mountWebSocketServer('/terminal', (wss) => {
			const logger = this.logger.createChildLogger('terminal')
			wss.on('connection', createTerminalWebSocketHandler({umbreld: this.umbreld, logger}))
		})

		const createApi = (registerApi: ({publicApi, privateApi, umbreld}: ApiOptions) => void) => {
			const publicApi = express.Router()
			const privateApi = express.Router()
			privateApi.use(async (request, response, next) => {
				const token = request?.cookies?.UMBREL_PROXY_TOKEN
				const isValid = await this.verifyProxyToken(token).catch(() => false)
				if (!isValid) return response.status(401).json({error: 'unauthorized'})
				next()
			})

			registerApi({publicApi, privateApi, umbreld: this.umbreld})

			const api = express.Router()
			api.use(publicApi)
			api.use(privateApi)

			return api
		}
		this.app.use('/api/files', createApi(fileApi))

		this.app.get('/logs/', async (request, response) => {
			try {
				await this.verifyProxyToken(request?.cookies?.UMBREL_PROXY_TOKEN)
			} catch (error) {
				return response.status(401).send('Unauthorized')
			}

			try {
				response.set('Content-Disposition', `attachment;filename=umbrel-${Date.now()}.log.gz`)
				const journal = $`journalctl`
				await pipeline(journal.stdout!, createGzip(), response)
			} catch (error) {
				this.logger.error(`Error streaming logs`, error)
			}
		})

		if (process.env.UMBREL_UI_PROXY) {
			this.app.use(
				'/',
				createProxyMiddleware({
					target: process.env.UMBREL_UI_PROXY,
					ws: true,
					logProvider: () => ({
						log: this.logger.verbose,
						debug: this.logger.verbose,
						info: this.logger.verbose,
						warn: this.logger.verbose,
						error: this.logger.error,
					}),
				}),
			)
		} else {
			const currentFilename = fileURLToPath(import.meta.url)
			const currentDirname = dirname(currentFilename)
			const uiPath = join(currentDirname, '../../../ui')

			const cacheAggressively: express.RequestHandler = (_, response, next) => {
				const approximatelyOneYearInSeconds = 365 * 24 * 60 * 60
				response.set('Cache-Control', `public, max-age=${approximatelyOneYearInSeconds}, immutable`)
				next()
			}
			this.app.get('/assets/*', cacheAggressively)
			this.app.get('/wallpapers/*', cacheAggressively)

			const staticOptions = {cacheControl: true, etag: true, lastModified: true, maxAge: 0}
			this.app.use('/', express.static(uiPath, staticOptions))

			this.app.get('*', (request, response) => {
				response.sendFile(join(uiPath, 'index.html'), staticOptions)
			})
		}

		this.app.use(
			(error: Error, request: express.Request, response: express.Response, next: express.NextFunction): void => {
				this.logger.error(`${request.method} ${request.path}`, error)
				if (response.headersSent) return
				response.status(500).json({error: true})
			},
		)

		wrapHandlersWithAsyncHandler(this.app._router)

		const listen = promisify(this.server.listen.bind(this.server)) as (port: number) => Promise<void>
		await listen(this.umbreld.port)
		this.port = (this.server.address() as any).port
		this.logger.log(`Listening on port ${this.port}`)

		return this
	}
}

export default Server
```

- [ ] **Step 2: Verify the file is syntactically correct TypeScript**

Run: `npx tsc --noEmit source/modules/server/index.ts --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 2>&1 || echo "Note: Full type checking requires upstream dependencies"`

Expected: No syntax errors shown

- [ ] **Step 3: Commit the patch**

```bash
git add source/modules/server/index.ts
git commit -m "feat: add dynamic CSP for reverse proxy support

Reads X-Forwarded-Host and X-Forwarded-Proto headers to dynamically
add the external origin to connect-src CSP directive, allowing
UmbrelOS to work behind Traefik/Dokploy reverse proxies.
"
```

Expected: Commit created successfully

---

## Verification Checklist

After implementation, verify:

- [ ] The `source/modules/server/index.ts` file exists and contains the CSP fix
- [ ] The `connectSrc` directive uses a function that reads `X-Forwarded-*` headers
- [ ] Both `http://` and `wss://` variants are added for the external origin
- [ ] `'self'` is always included first in the sources
- [ ] The Dockerfile copies `source/` to `/packages/umbreld/source` in the base stage
- [ ] Build would apply this patch during `docker build`

---

## How It Works

1. **Build time**: The `source/` directory is copied to `/packages/umbreld/source` in the Dockerfile's base stage, overlaying the upstream umbrel code
2. **Request time**: When a request comes in through Traefik:
   - Traefik sets `X-Forwarded-Host: domain.com` and `X-Forwarded-Proto: https`
   - The CSP function reads these headers
   - The resulting `connect-src` becomes: `['self', 'https://apps.umbrel.com', 'https://domain.com', 'wss://domain.com']`
3. **Result**: Browser allows tRPC requests to the external domain since it's in the CSP whitelist
