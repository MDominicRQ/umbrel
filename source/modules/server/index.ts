import http from 'node:http'
import process from 'node:process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'
import {createGzip} from 'node:zlib'
import {pipeline} from 'node:stream/promises'

import {$} from 'execa'
import Docker from 'dockerode'
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
	#docker = new Docker({socketPath: '/var/run/docker.sock'})
	#appProxyCache = new Map<string, ReturnType<typeof createProxyMiddleware>>()
	#appTargetCache = new Map<string, {target: string; expiresAt: number}>()
	// External port as seen by clients — updated from X-Forwarded-Port/Proto on every HTTP request
	#externalPort = 80
	get externalPort(): number {
		return this.#externalPort
	}

	// App-specific override registry for apps that need special handling.
	// 'web'         — normal web app with HTML UI (default)
	// 'api-only'    — no HTML UI, serves API only (e.g. Ollama)
	// 'host-network' — binds to host network, not accessible from bridge (e.g. Tailscale)
	#appKinds = new Map<string, 'web' | 'api-only' | 'host-network'>([
		['ollama', 'api-only'],
		['tailscale', 'host-network'],
	])

	// Cache for resolved host-network gateway probes
	#hostGatewayCache = new Map<string, string>()

	// Runs Nextcloud repair once per startup on first successful proxy request.
	// Guarded by #nextcloudRepaired to prevent repeated repairs.
	#nextcloudRepaired = false

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

	#cacheAppTarget(appId: string, target: string) {
		this.#appTargetCache.set(appId, {target, expiresAt: Date.now() + 60_000})
	}

	// Normalize compose service environment to a flat map of key→value.
	// Handles both YAML object form and array-of-"KEY=value" strings form.
	#parseServiceEnv(env: Record<string, string> | string[] | undefined): Record<string, string> {
		if (!env) return {}
		if (Array.isArray(env)) {
			const result: Record<string, string> = {}
			for (const item of env) {
				const eqIdx = item.indexOf('=')
				if (eqIdx > 0) {
					result[item.slice(0, eqIdx)] = item.slice(eqIdx + 1)
				}
			}
			return result
		}
		return {...env}
	}

	// Resolve the correct proxy target for an app. Strategy (in order):
	// 1. app_proxy.environment.APP_HOST + APP_PORT → inspect container for IP in umbrel_main_network
	//    (uses the official app declaration; works for most multi-service apps like Nextcloud, Jellyfin, Vaultwarden)
	// 2. network_mode: host / service: / container:  → host.docker.internal:<manifestPort>
	// 3. Heuristic: prefer services named server/web/app/frontend, skip db/redis/cron/worker/postgres/mysql/mariadb/machine-learning
	// 4. listContainers by label → real IP in umbrel_main_network (compose unreadable)
	// 5. DNS name fallback (last resort; never uses app_proxy which needs unavailable auth manager)
	async #resolveAppTarget(appId: string): Promise<string> {
		const cached = this.#appTargetCache.get(appId)
		if (cached && Date.now() < cached.expiresAt) {
			this.logger.log(`Proxy target [cache] ${appId} → ${cached.target}`)
			return cached.target
		}

		const app = this.umbreld.apps.getApp(appId)
		const {port: manifestPort} = await app.readManifest()

		try {
			const compose = await app.readCompose()

			// ── Strategy 1: app_proxy environment ──────────────────────────────────
			// Most Umbrel apps declare the real web service via app_proxy.APP_HOST and APP_PORT.
			// We read those directly instead of guessing which service is "main".
			const appProxyEnv = this.#parseServiceEnv(
				(compose.services as any)?.['app_proxy']?.['environment'],
			)
			if (appProxyEnv['APP_HOST'] && appProxyEnv['APP_PORT']) {
				const appHost = appProxyEnv['APP_HOST']
				const appPort = parseInt(appProxyEnv['APP_PORT'], 10)
				if (appPort > 0) {
					// Try to resolve APP_HOST to an IP in umbrel_main_network
					try {
						const container = this.#docker.getContainer(appHost)
						const info = await container.inspect()
						const ip = (info.NetworkSettings.Networks as any)?.['umbrel_main_network']?.IPAddress
						if (ip) {
							const target = `http://${ip}:${appPort}`
							this.#cacheAppTarget(appId, target)
							this.logger.log(`Proxy target [app-proxy] ${appId}: ${appHost}→${target}`)
							// Auto-repair Nextcloud trusted domains on first successful resolution.
							if (appId === 'nextcloud') this.#nextcloudRepaired = false // reset so repair fires
							return target
						}
						this.logger.log(`Proxy target [app-proxy] ${appId}: ${appHost} has no umbrel_main_network IP`)
					} catch {
						this.logger.log(`Proxy target [app-proxy] ${appId}: could not inspect ${appHost}`)
					}
					// Fall through: try DNS-based resolution below
				}
			}

			// ── Strategy 2: host network mode ───────────────────────────────────────
			const services = Object.keys(compose.services ?? {})
			for (const svc of services) {
				if (svc === 'app_proxy' || svc === 'tor_proxy' || svc === 'i2p_daemon') continue
				const networkMode: string = ((compose.services as any)[svc] ?? {})['network_mode'] ?? ''
				if (networkMode === 'host' || networkMode.startsWith('service:') || networkMode.startsWith('container:')) {
					// Mark app as host-network so the proxy handler knows to use gateway probing
					this.#appKinds.set(appId, 'host-network')
					// Try to find a reachable host gateway
					const gatewayTarget = await this.#probeHostGateway(manifestPort)
					if (gatewayTarget) {
						this.#cacheAppTarget(appId, gatewayTarget)
						this.logger.log(`Proxy target [hostnet] ${appId}: ${svc}→${gatewayTarget}`)
						return gatewayTarget
					}
					// Fallback: try host.docker.internal even if it failed before
					const fallback = `http://host.docker.internal:${manifestPort}`
					this.#cacheAppTarget(appId, fallback)
					this.logger.log(`Proxy target [hostnet] ${appId}: ${svc}→${fallback} (unverified)`)
					return fallback
				}
			}

			// ── Strategy 3: heuristic — prefer web/server/app service ───────────────
			const preferredOrder = ['server', 'web', 'app', 'frontend']
			const skipSet = new Set(['db', 'redis', 'postgres', 'mysql', 'mariadb', 'cron', 'worker', 'machine-learning', 'proxy', 'nginx', 'app_proxy', 'tor_proxy', 'i2p_daemon'])
			let chosenService: string | undefined
			// First pass: preferred names
			for (const pref of preferredOrder) {
				chosenService = services.find((s) => s === pref && !skipSet.has(s))
				if (chosenService) break
			}
			// Second pass: any non-skipped service
			if (!chosenService) {
				chosenService = services.find((s) => !skipSet.has(s))
			}

			if (chosenService) {
				const containerName = `${appId}_${chosenService}_1`
				try {
					const container = this.#docker.getContainer(containerName)
					const info = await container.inspect()
					const ip = (info.NetworkSettings.Networks as any)?.['umbrel_main_network']?.IPAddress
					if (ip) {
						const target = `http://${ip}:${manifestPort}`
						this.#cacheAppTarget(appId, target)
						this.logger.log(`Proxy target [heuristic] ${appId}: ${chosenService}→${target}`)
						if (appId === 'nextcloud') this.#nextcloudRepaired = false
						return target
					}
					this.logger.log(`Proxy target [heuristic] ${appId}: ${chosenService} has no umbrel_main_network IP`)
				} catch (inspectError) {
					this.logger.log(`Proxy target [heuristic] ${appId}: inspect failed — ${(inspectError as Error).message}`)
				}
			}

			// ── Strategy 4: listContainers by project label ─────────────────────────
			const containers = await this.#docker.listContainers({
				filters: JSON.stringify({
					label: [`com.docker.compose.project=${appId}`],
					status: ['running'],
				}),
			})
			this.logger.log(`Proxy target [list] ${appId}: found ${containers.length} containers`)

			const mainContainer = containers.find((c) => {
				const service = c.Labels['com.docker.compose.service']
				return service && !skipSet.has(service)
			})

			if (mainContainer) {
				const full = await this.#docker.getContainer(mainContainer.Id).inspect()
				const ip = (full.NetworkSettings.Networks as any)?.['umbrel_main_network']?.IPAddress
				if (ip) {
					const target = `http://${ip}:${manifestPort}`
					this.#cacheAppTarget(appId, target)
					this.logger.log(`Proxy target [list+inspect] ${appId} → ${target}`)
					if (appId === 'nextcloud') this.#nextcloudRepaired = false
					return target
				}
				this.logger.log(`Proxy target [list+inspect] ${appId}: no IP in umbrel_main_network`)
			} else {
				this.logger.log(`Proxy target [list] ${appId}: no non-system container found`)
			}

			// ── Strategy 5: DNS name fallback ───────────────────────────────────────
			if (chosenService) {
				const target = `http://${appId}_${chosenService}_1:${manifestPort}`
				this.#cacheAppTarget(appId, target)
				this.logger.log(`Proxy target [dns] ${appId} → ${target}`)
				return target
			}
		} catch (composeError) {
			this.logger.log(`Proxy target [compose] ${appId}: read failed — ${(composeError as Error).message}`)
		}

		throw new Error(`Cannot resolve proxy target for app ${appId}: no running container found`)
	}

	// Probe the host network gateway for host-network apps (e.g. Tailscale).
	// Tries the umbrel_main_network gateway first, then standard Docker gateway.
	async #probeHostGateway(port: number): Promise<string | undefined> {
		const cacheKey = `${port}`
		if (this.#hostGatewayCache.has(cacheKey)) {
			return this.#hostGatewayCache.get(cacheKey)
		}

		const candidates = [
			`http://10.21.0.1:${port}`,
			`http://172.17.0.1:${port}`,
			`http://host.docker.internal:${port}`,
		]

		for (const candidate of candidates) {
			try {
				const controller = new AbortController()
				const timeout = setTimeout(() => controller.abort(), 1500)
				await fetch(candidate, {
					signal: controller.signal,
					method: 'HEAD',
				})
				clearTimeout(timeout)
				this.#hostGatewayCache.set(cacheKey, candidate)
				this.logger.log(`Host gateway probe: ${candidate} ✓`)
				return candidate
			} catch {
				this.logger.log(`Host gateway probe: ${candidate} ✗`)
			}
		}

		return undefined
	}

	// Run Nextcloud occ commands to configure trusted domains and reverse proxy headers.
	// Idempotent — safe to call multiple times.
	// Uses real forwarded hostname from the incoming request.
	async #repairNextcloud(appId: string, forwardedHost: string): Promise<void> {
		const compose = await this.umbreld.apps.getApp(appId).readCompose()
		const services = Object.keys(compose.services ?? {})
		const webService = services.find((s) => s !== 'app_proxy' && s !== 'tor_proxy' && s !== 'i2p_daemon') ?? 'web'
		const containerName = `${appId}_${webService}_1`
		const occCommands = [
			['config:system:set', 'trusted_domains', '1', `--value=${forwardedHost}`],
			['config:system:set', 'overwrite.cli.url', `--value=https://${forwardedHost}/proxy/${appId}`],
			['config:system:set', 'overwriteprotocol', '--value=https'],
			['config:system:set', 'overwritewebroot', `--value=/proxy/${appId}`],
			['config:system:set', 'trusted_proxies', '0', '--value=10.21.0.0/16'],
		]

		for (const [cmd, ...args] of occCommands) {
			try {
				await $`docker exec -u www-data ${containerName} php occ ${cmd} ${args}`
				this.logger.log(`Nextcloud repair: occ ${cmd} ${args.join(' ')} ✓`)
			} catch (error) {
				this.logger.log(`Nextcloud repair: occ ${cmd} ${args.join(' ')} failed — ${(error as Error).message}`)
			}
		}
	}

	// rewriteLocation: true  → path-based proxy: rewrites Location headers and HTML bodies
	//                          so root-relative URLs stay within /proxy/:appId.
	// rewriteLocation: false → subdomain proxy: plain pass-through.
	#getAppProxy(appId: string, target: string, {rewriteLocation = false} = {}) {
		const cacheKey = `${appId}|${target}|${rewriteLocation}`
		if (!this.#appProxyCache.has(cacheKey)) {
			const prefix = `/proxy/${appId}`

			// Injected into every HTML page.
			// rw()   — rewrites root-relative (/foo) AND absolute same-origin (https://host/foo) URLs.
			// rwws() — same logic for ws:/wss: WebSocket URLs.
			// Also patches history.pushState/replaceState so SPA navigation stays within the proxy path.
			const injectScript =
				`<script>(function(){` +
				`var p=${JSON.stringify(prefix)};` +
				`var org=location.origin;` +
				`var wso=(location.protocol==='https:'?'wss:':'ws:')+'//'+location.host;` +
				`function rw(u){` +
				`if(typeof u!=='string')return u;` +
				`if(u.charCodeAt(0)===47&&u.charCodeAt(1)!==47&&!u.startsWith(p))return p+u;` +
				`if(u.startsWith(org+'/')&&!u.startsWith(org+p+'/'))return org+p+u.slice(org.length);` +
				`return u;}` +
				`function rwws(u){` +
				`if(typeof u!=='string')return u;` +
				`if(u.charCodeAt(0)===47&&u.charCodeAt(1)!==47&&!u.startsWith(p))return wso+p+u;` +
				`if(u.startsWith(wso+'/')&&!u.startsWith(wso+p+'/'))return wso+p+u.slice(wso.length);` +
				`return u;}` +
				`var oF=window.fetch;window.fetch=function(u,i){return oF.call(this,rw(u),i);};` +
				`var oX=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){var a=Array.from(arguments);a[1]=rw(a[1]);return oX.apply(this,a);};` +
				`var oW=window.WebSocket;` +
				`window.WebSocket=function(u,q){return q?new oW(rwws(u),q):new oW(rwws(u));};` +
				`Object.assign(window.WebSocket,oW);window.WebSocket.prototype=oW.prototype;` +
				`var oPS=history.pushState.bind(history);history.pushState=function(s,t,u){return oPS(s,t,u!=null?rw(u):u);};` +
				`var oRS=history.replaceState.bind(history);history.replaceState=function(s,t,u){return oRS(s,t,u!=null?rw(u):u);};` +
				`var oLR=location.replace.bind(location);location.replace=function(u){return oLR(rw(u));};` +
				`var oLA=location.assign.bind(location);location.assign=function(u){return oLA(rw(u));};` +
				`try{var lhd=Object.getOwnPropertyDescriptor(Location.prototype,'href');` +
				`if(lhd)Object.defineProperty(Location.prototype,'href',{get:lhd.get,set:function(u){lhd.set.call(this,rw(String(u)));},configurable:true});}catch(e){}` +
				`})();</script>`

			// http-proxy-middleware v2 uses top-level onProxyReq/onProxyRes/onError options
			// (not the v3 `on: {}` object — that API is silently ignored in v2 and causes
			// all response handlers to never fire, breaking redirect rewriting entirely).
			const proxyOptions: Parameters<typeof createProxyMiddleware>[0] = {
				target,
				changeOrigin: true,
				proxyTimeout: 30000,
				timeout: 30000,
				ws: true,
				cookiePathRewrite: {'/': prefix},
				cookieDomainRewrite: {'*': ''},
				pathRewrite: (path: string): string => {
					// Strip the /proxy/<appId> prefix so the backend receives the correct path.
					// e.g. /proxy/jellyfin/web/ -> /web/
					if (path === prefix) return '/'
					if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length)
					return path
				},
				onError: (err: Error, _req: http.IncomingMessage, res: http.ServerResponse | any) => {
					this.logger.error(`App proxy error (${target}): ${(err as Error).message}`)
					if (!(res as http.ServerResponse).headersSent) {
						;(res as http.ServerResponse).writeHead(502, {'Content-Type': 'text/plain'})
						res.end('App proxy unavailable')
					}
				},
			}

			if (rewriteLocation) {
				proxyOptions.onProxyReq = (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
					// Disable compression so HTML can be rewritten as plain text.
					proxyReq.setHeader('Accept-Encoding', 'identity')

					// For apps behind path-based proxy:
					// - Nextcloud needs X-Forwarded-* headers to generate correct URLs
					// - Other apps (Jellyfin, etc): remove them to prevent absolute redirect URLs
					//   that would bypass the /proxy/<appId> prefix and land on the Umbrel SPA 404.
					const forwardedHost = (req.headers['x-forwarded-host'] as string) || 'os.dominic.pw'
					const forwardedProto = (req.headers['x-forwarded-proto'] as string) || 'https'
					const forwardedPort = (req.headers['x-forwarded-port'] as string) || '443'

					if (appId === 'nextcloud') {
						proxyReq.setHeader('X-Forwarded-Host', forwardedHost)
						proxyReq.setHeader('X-Forwarded-Proto', forwardedProto)
						proxyReq.setHeader('X-Forwarded-Port', forwardedPort)
						proxyReq.setHeader('X-Forwarded-Prefix', prefix)
					} else {
						proxyReq.removeHeader('x-forwarded-host')
						proxyReq.removeHeader('x-forwarded-proto')
						proxyReq.removeHeader('x-forwarded-port')
					}

					// Manually rewrite the proxy path to strip the /proxy/<appId> prefix.
					// The HTTP handler already sets request.url to the stripped path (e.g. /web/).
					// Use proxyReq.path as the authoritative source since HPM may derive it from there.
					const inPath = proxyReq.path ?? req.url ?? '/'
					const outPath = inPath.startsWith(`${prefix}/`) ? inPath.slice(prefix.length) : (inPath === prefix ? '/' : inPath)
					proxyReq.path = outPath
					this.logger.log(`[${appId}] proxyReq: ${inPath} → ${target}${outPath}`)
				}

				proxyOptions.onProxyRes = (proxyRes: http.IncomingMessage, _req: http.IncomingMessage, res: http.ServerResponse) => {
					this.logger.log(`[${appId}] proxyRes: ${proxyRes.statusCode} Location=${proxyRes.headers.location || '-'} CT=${(proxyRes.headers['content-type'] as string || '-').split(';')[0].trim()}`)
					// Rewrite Location headers so redirects stay within /proxy/:appId.
					// Handles root-relative paths (/web/) AND absolute URLs from any host
					// (http://10.21.0.4:8096/web/, https://os.dominic.pw/web/, etc.).
					const loc = proxyRes.headers.location
					const refresh = proxyRes.headers.refresh
					if (typeof loc === 'string') {
						if (loc.startsWith('/') && !loc.startsWith('//') && !loc.startsWith(`${prefix}/`) && loc !== prefix) {
							proxyRes.headers.location = `${prefix}${loc}`
						} else if (/^https?:\/\//i.test(loc) && !loc.includes(`${prefix}/`)) {
							try {
								const locUrl = new URL(loc)
								if (!locUrl.pathname.startsWith(prefix)) {
									proxyRes.headers.location = `${prefix}${locUrl.pathname}${locUrl.search}${locUrl.hash}`
								}
							} catch {
								// unparseable URL — leave as-is
							}
						}
					}
					if (typeof refresh === 'string' && refresh.includes('url=')) {
						const urlMatch = refresh.match(/url=(.+)/i)
						if (urlMatch) {
							const origUrl = urlMatch[1].trim().replace(/^["']|["']$/g, '')
							let newUrl: string
							if (origUrl.startsWith('/') && !origUrl.startsWith('//')) {
								newUrl = `${prefix}${origUrl}`
							} else {
								try {
									const u = new URL(origUrl)
									newUrl = `${prefix}${u.pathname}${u.search}${u.hash}`
								} catch {
									newUrl = origUrl
								}
							}
							proxyRes.headers.refresh = refresh.replace(/url=.+/i, `url=${newUrl}`)
						}
					}

					const contentType = (proxyRes.headers['content-type'] as string) ?? ''
					if (!contentType.includes('text/html')) return

					// HTML response: strip headers that would break our injected content,
					// then buffer the piped body chunks so we can rewrite before sending.
					delete proxyRes.headers['content-security-policy']
					delete proxyRes.headers['content-length']
					delete proxyRes.headers['content-encoding']

					const chunks: Buffer[] = []
					const origWrite = res.write.bind(res)
					const origEnd = res.end.bind(res)

					// Intercept write: buffer chunks instead of sending them immediately.
					;(res as any).write = (chunk: any): boolean => {
						if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
						return true
					}

					// Intercept end: assemble, rewrite, then flush.
					;(res as any).end = (chunk?: any): http.ServerResponse => {
						if (chunk != null && chunk !== '') {
							chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
						}

						// Restore originals before writing to avoid re-interception.
						res.write = origWrite
						res.end = origEnd

						let body = Buffer.concat(chunks).toString('utf8')

						if (/<head[\s>]/i.test(body)) {
							body = body.replace(/<head([\s>])/i, `<head$1${injectScript}`)
						} else {
							body = injectScript + body
						}

						body = body.replace(
							/((?:href|src|action|poster|data-src|data-href)=["'])\/(?!\/|proxy\/)/g,
							`$1${prefix}/`,
						)
						body = body.replace(/(\burl\(["']?)\/(?!\/|proxy\/)/g, `$1${prefix}/`)

						origWrite(Buffer.from(body, 'utf8'))
						origEnd()
						return res
					}
				}
			}

			this.#appProxyCache.set(cacheKey, createProxyMiddleware(proxyOptions))
		}
		return this.#appProxyCache.get(cacheKey)!
	}

	async start() {
		await this.getJwtSecret()

		// UMBREL_DOMAIN enables subdomain routing: each app served at ${appId}.${domain}
		// This makes root-relative HTML/JS paths work correctly in all apps.
		// Requires: DNS wildcard *.${domain} and a Traefik wildcard router (see compose.yml).
		const umbreldDomain = process.env.UMBREL_DOMAIN?.toLowerCase().trim() || undefined

		this.app = express()
		this.server = http.createServer(this.app)
		this.server.requestTimeout = 0

		this.app.use(cookieParser())

		// CSP with reverse proxy support
		this.app.use(
			helmet.contentSecurityPolicy({
				directives: {
					defaultSrc: ["'self'"],
					scriptSrc: this.umbreld.developmentMode ? ["'self'", "'unsafe-inline'"] : ["'self'"],
					styleSrc: ["'self'", "'unsafe-inline'"],
					imgSrc: ["'self'", 'data:', 'blob:', 'https://getumbrel.github.io'],
					fontSrc: ["'self'", 'data:'],
					connectSrc: ["'self'", 'https://apps.umbrel.com'],
					objectSrc: ["'none'"],
					// Allow same-origin frames so apps work via /proxy/<appId>/
					frameSrc: ["'self'"],
					upgradeInsecureRequests: this.umbreld.developmentMode ? undefined : [],
				},
			}),
		)

		// Add dynamic connectSrc based on reverse proxy headers; also cache the external port
		this.app.use((request, response, next) => {
			const forwardedHost = request.headers['x-forwarded-host']
			const forwardedProto = request.headers['x-forwarded-proto']
			const forwardedPort = request.headers['x-forwarded-port']

			// Update external port from forwarded headers so WS-transported tRPC calls can use it
			if (forwardedPort) {
				const ps = Array.isArray(forwardedPort) ? forwardedPort[0] : forwardedPort
				const parsed = parseInt(ps, 10)
				if (parsed > 0) this.#externalPort = parsed
			} else if (forwardedProto) {
				const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto
				if (proto === 'https') this.#externalPort = 443
				else if (proto === 'http') this.#externalPort = 80
			}

			if (forwardedHost) {
				const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost
				const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : (forwardedProto || 'https')
				const dynamicSources = [
					`http://${host}`,
					`https://${host}`,
					`ws://${host}`,
					`wss://${host}`,
				]
				const currentCsp = response.get('Content-Security-Policy') || ''
				const newCsp = currentCsp.replace(
					"connect-src 'self' https://apps.umbrel.com",
					`connect-src 'self' https://apps.umbrel.com ${dynamicSources.join(' ')}`,
				)
				response.set('Content-Security-Policy', newCsp)
			}
			next()
		})
		this.app.use(helmet.referrerPolicy({policy: 'no-referrer'}))
		this.app.disable('x-powered-by')

		this.app.set('umbreld', this.umbreld)
		this.app.set('logger', this.logger)

		this.app.use((request, response, next) => {
			this.logger.verbose(`${request.method} ${request.path}`)
			next()
		})

		// Global proxy handler: runs before any other route, parses request.originalUrl
		// manually so async/await does not corrupt request.url before the proxy is invoked.
		this.app.use(async (request, response, next) => {
			// Only handle /proxy/<appId> paths
			const parsedUrl = new URL(request.originalUrl, 'http://umbrel.local')
			const match = parsedUrl.pathname.match(/^\/proxy\/([a-z0-9][a-z0-9-]*)(\/.*)?$/)
			if (!match) return next()

			// Strip Helmet's CSP — it would block the injected inline URL-rewriting script
			// and all inline scripts from the proxied app.
			response.removeHeader('Content-Security-Policy')

			const appId = match[1]
			// match[2] is the path after /proxy/<appId>, e.g. "/web/" or undefined
			const appPath = match[2] || '/'

			// Jellyfin serves its UI at /web/ — redirect root /proxy/jellyfin/ there
			if (appId === 'jellyfin' && appPath === '/') {
				return response.redirect(302, `/proxy/${appId}/web/`)
			}

			// Canonical redirect: /proxy/<app> (no trailing slash) → /proxy/<app>/
			if (parsedUrl.pathname === `/proxy/${appId}`) {
				return response.redirect(302, `${parsedUrl.pathname}/${parsedUrl.search || ''}`)
			}

			// Ollama has no web UI — serve a landing page at root, proxy API routes normally
			if (appId === 'ollama' && appPath === '/') {
				const openWebUIInstalled = this.umbreld.apps.instances.some((a) => a.id === 'open-webui')
				response.set('Content-Type', 'text/html; charset=utf-8')
				return response.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Ollama</title></head>
<body style="font-family:system-ui;max-width:600px;margin:60px auto;padding:0 20px">
  <h1>Ollama API is running</h1>
  <p>This app provides a raw AI model API and does not include a web interface.</p>
  <p>Connect to this AI backend from other apps using:</p>
  <ul>
    <li><strong>Internal URL:</strong> <code>http://ollama_ollama_1:11434</code></li>
    <li><strong>Proxied API:</strong> <a href="/proxy/ollama/api">/proxy/ollama/api</a></li>
  </ul>
  <h2>Recommended UI</h2>
  <p>Install <strong>Open WebUI</strong> from the Umbrel App Store for a full ChatGPT-style interface.</p>
  ${openWebUIInstalled ? '<p><a href="/proxy/open-webui/" style="background:#0066cc;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">Open WebUI →</a></p>' : '<p><a href="/app-store/open-webui" style="background:#0066cc;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">Install Open WebUI →</a></p>'}
  <h2>API Endpoints</h2>
  <ul>
    <li><a href="/proxy/ollama/api/tags">/api/tags</a> — List available models</li>
    <li><a href="/proxy/ollama/api/version">/api/version</a> — Server version</li>
  </ul>
</body></html>`)
			}

			if (umbreldDomain) {
				const proto = this.#externalPort === 443 ? 'https' : 'http'
				const search = parsedUrl.search || ''
				return response.redirect(302, `${proto}://${appId}.${umbreldDomain}${appPath}${search}`)
			}

			try {
				const target = await this.#resolveAppTarget(appId)

				// Repair Nextcloud trusted domains once per startup on first successful resolution.
				// Uses the real forwarded host from the incoming request, defaulting to os.dominic.pw.
				if (appId === 'nextcloud' && !this.#nextcloudRepaired) {
					const forwardedHost = Array.isArray(request.headers['x-forwarded-host'])
						? request.headers['x-forwarded-host'][0]
						: (request.headers['x-forwarded-host'] as string) || 'os.dominic.pw'
					this.#repairNextcloud(appId, forwardedHost)
						.then(() => {
							this.#nextcloudRepaired = true
							this.logger.log(`Nextcloud repair completed with forwardedHost=${forwardedHost}`)
						})
						.catch((err) => this.logger.log(`Nextcloud repair failed: ${err.message}`))
				}

				// Detect host-network apps whose gateway probe failed
				const kind = this.#appKinds.get(appId)
				if (kind === 'host-network') {
					const targetUrl = new URL(target)
					if (targetUrl.hostname === 'host.docker.internal' && !this.#hostGatewayCache.has(targetUrl.port)) {
						// Gateway probe never succeeded — do not attempt proxy, return clear error
						response.status(502)
						return response.json({
							error: 'App not reachable',
							detail: `The "${appId}" app runs on the host network and its web UI is not reachable from inside the Umbrel container. Gateway probe failed for all candidates.`,
							suggestion: 'Access Tailscale directly at its host IP or via the Tailscale app on your devices.',
						})
					}
				}

				// Manually set request.url to the stripped path so the proxied app
				// receives the correct path (e.g. /web/) without the /proxy/:appId prefix.
				request.url = `${appPath}${parsedUrl.search || ''}`
				this.logger.log(`Proxy HTTP ${appId} → ${target} (req.url=${request.url})`)
				this.#getAppProxy(appId, target, {rewriteLocation: true})(request, response, next)
			} catch (error) {
				this.logger.error(`App proxy setup error for ${appId}`, error)
				response.status(502).json({error: 'App not found or not running'})
			}
		})

		// Subdomain app routing — handles ${appId}.${umbreldDomain} HTTP requests.
		// Must be registered after the global proxy handler so path-based proxy takes priority.
		if (umbreldDomain) {
			this.app.use(async (request, response, next) => {
				const rawHost = request.headers['x-forwarded-host']
				const host = (Array.isArray(rawHost) ? rawHost[0] : rawHost ?? '').toLowerCase().split(':')[0]
				const suffix = `.${umbreldDomain}`
				if (host.endsWith(suffix) && host !== umbreldDomain) {
					const appId = host.slice(0, -suffix.length)
					if (/^[a-z0-9][a-z0-9-]*$/.test(appId)) {
						try {
							const target = await this.#resolveAppTarget(appId)
							return this.#getAppProxy(appId, target)(request, response, next)
						} catch (error) {
							this.logger.error(`Subdomain proxy error for ${appId}`, error)
							return response.status(404).json({error: 'App not found'})
						}
					}
				}
				next()
			})
		}

		this.server?.on('upgrade', async (request, socket, head) => {
			try {
				// Opportunistically capture the external port from upgrade request headers
				// (ensures #externalPort is correct even before any plain HTTP request arrives)
				const upgradeFwdPort = request.headers['x-forwarded-port']
				const upgradeFwdProto = request.headers['x-forwarded-proto']
				if (upgradeFwdPort) {
					const ps = Array.isArray(upgradeFwdPort) ? upgradeFwdPort[0] : upgradeFwdPort
					const parsed = parseInt(ps, 10)
					if (parsed > 0) this.#externalPort = parsed
				} else if (upgradeFwdProto) {
					const proto = Array.isArray(upgradeFwdProto) ? upgradeFwdProto[0] : upgradeFwdProto
					if (proto === 'https') this.#externalPort = 443
					else if (proto === 'http') this.#externalPort = 80
				}

				const {pathname, searchParams} = new URL(`https://localhost${request.url}`)

				// Subdomain WebSocket proxy — handles WS connections from apps running on ${appId}.${umbreldDomain}
				if (umbreldDomain) {
					const upgradeFwdHost = request.headers['x-forwarded-host']
					const upgradeHost = (Array.isArray(upgradeFwdHost) ? upgradeFwdHost[0] : upgradeFwdHost ?? '').toLowerCase().split(':')[0]
					const suffix = `.${umbreldDomain}`
					if (upgradeHost.endsWith(suffix) && upgradeHost !== umbreldDomain) {
						const appId = upgradeHost.slice(0, -suffix.length)
						if (/^[a-z0-9][a-z0-9-]*$/.test(appId)) {
							try {
								const target = await this.#resolveAppTarget(appId)
								const proxy = this.#getAppProxy(appId, target)
								;(proxy as any).upgrade(request, socket, head)
							} catch (error) {
								this.logger.error(`WS subdomain proxy error for ${appId}`, error)
								socket.destroy()
							}
							return
						}
					}
				}

				// Proxy WebSocket upgrades for installed apps (path-based fallback when no umbreldDomain)
				const appProxyMatch = pathname.match(/^\/proxy\/([^/]+)(\/.*)?$/)
				if (appProxyMatch) {
					const appId = appProxyMatch[1]
					// WS upgrades bypass Express — strip /proxy/${appId} from request.url manually
					// so the app container receives just the path it expects (e.g. /ws not /proxy/appId/ws)
					const strippedPath = appProxyMatch[2] || '/'
					request.url = strippedPath
					try {
						const target = await this.#resolveAppTarget(appId)
						const proxy = this.#getAppProxy(appId, target, {rewriteLocation: true})
						;(proxy as any).upgrade(request, socket, head)
					} catch (error) {
						this.logger.error(`WS app proxy error for ${appId}`, error)
						socket.destroy()
					}
					return
				}

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
				// JWT auth errors are expected from pre-login browser connections — log at verbose only
				const msg = (error as Error).message ?? ''
				if (msg.includes('jwt') || msg.includes('JsonWebTokenError') || msg.includes('invalid signature')) {
					this.logger.verbose(`WS auth rejected: ${msg}`)
				} else {
					this.logger.error(`Error upgrading websocket`, error)
				}
				socket.destroy()
			}
		})

		this.app.get('/manager-api/v1/system/update-status', (request, response) => {
			response.json({state: 'success', progress: 100, description: '', updateTo: ''})
		})

		// Diagnostic endpoint: hit /api/debug/proxy/:appId to see target resolution details
		// PROTECTED: only accessible from localhost or with valid proxy auth token.
		// Exposes container IPs, names, and internal network details — never expose publicly.
		this.app.get('/api/debug/proxy/:appId', async (request, response) => {
			const token = request?.cookies?.UMBREL_PROXY_TOKEN
			const isValid = await this.verifyProxyToken(token).catch(() => false)
			if (!isValid) {
				// Check if request comes from localhost (container itself)
				const remoteAddr = request.socket.remoteAddress ?? ''
				const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1'
				if (!isLocal) return response.status(401).json({error: 'unauthorized'})
			}
			const {appId} = request.params
			try {
				// Bypass cache so every call re-resolves
				this.#appTargetCache.delete(appId)
				const app = this.umbreld.apps.getApp(appId)
				const {port} = await app.readManifest()
				const containers = await this.#docker.listContainers({
					filters: JSON.stringify({
						label: [`com.docker.compose.project=${appId}`],
						status: ['running'],
					}),
				})
				const target = await this.#resolveAppTarget(appId)
				response.json({appId, port, target, containers: containers.map((c) => ({
					id: c.Id.slice(0, 12),
					name: c.Names,
					status: c.Status,
					service: c.Labels['com.docker.compose.service'],
					project: c.Labels['com.docker.compose.project'],
					networks: Object.fromEntries(
						Object.entries(c.NetworkSettings.Networks ?? {}).map(([net, info]: [string, any]) => [net, info?.IPAddress]),
					),
				}))})
			} catch (error) {
				response.status(500).json({error: (error as Error).message})
			}
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
