import http from 'node:http'

import net from 'node:net'

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



class HostNetworkTargetUnavailableError extends Error {
	constructor(
		readonly appId: string,
		readonly port: number,
		readonly probeTargets: string[],
	) {
		super(`Host-network app ${appId} is not reachable on port ${port}`)
		this.name = 'HostNetworkTargetUnavailableError'
	}
}


const wrapHandlersWithAsyncHandler = (router: express.Router) => {

	for (const layer of router.stack) {

		if (layer.name === 'router') wrapHandlersWithAsyncHandler(layer.handle)

		else if (layer.route) {

			for (const routeLayer of layer.route.stack) routeLayer.handle = asyncHandler(routeLayer.handle)

		}

	}

}

function rewriteRedirectLocation(loc: string | undefined, prefix: string): string | undefined {
	if (typeof loc !== 'string') return loc
	if (loc.startsWith('/') && !loc.startsWith('//') && !loc.startsWith(`${prefix}/`) && loc !== prefix) {
		return `${prefix}${loc}`
	}
	if (/^https?:\/\//i.test(loc) && !loc.includes(`${prefix}/`)) {
		try {
			const u = new URL(loc)
			if (!u.pathname.startsWith(prefix)) {
				return `${prefix}${u.pathname}${u.search}${u.hash}`
			}
		} catch {
			// leave as-is
		}
	}
	return loc
}

function buildInjectScript(prefix: string): string {
	const p = JSON.stringify(prefix)
	const org = 'location.origin'
	const h = 'location.host'
	const wso = "(location.protocol==='https:'?'wss:':'ws:')+'//'+location.host"
	const rwwsBody = `if(u.startsWith(p))return u;if(u.includes('://')){try{var u2=new URL(u);if(u2.host===h)return l+p+u2.pathname+u2.search;}catch(e){}return u;}if(u.charCodeAt(0)===47&&u.charCodeAt(1)!==47)return l+p+u;return u;`
	const rw = `function rw(u){if(typeof u!=='string'){if(u&&u.url)u=String(u.url);else if(u&&u.href)u=String(u.href);else return u;}if(u.startsWith(p))return u;if(u.startsWith(${org}+'/')&&!u.startsWith(${org}+p+'/'))return ${org}+p+u.slice(${org}.length);try{if(new URL(u).host===location.host&&u.startsWith('/'))return p+u;}catch(e){}if(u.charCodeAt(0)===47&&u.charCodeAt(1)!==47&&!u.startsWith(p))return p+u;return u;}`
	const rwws = `function rwws(u){if(typeof u!=='string'){if(u&&(u.href||(u.url&&typeof u.url!=='string')))u=String(u.href||u.url);else if(u&&u.url)u=String(u.url);else return u;}var l=${wso};if(u.startsWith(p))return u;${rwwsBody}}`
	return `<script>(function(){var p=${p};var o=${org};var h=${h};${rw};${rwws};var oF=window.fetch;window.fetch=function(u,i){if(u&&u instanceof Request){var r=new Request(rw(u.url),u);if(i)return oF.call(this,r,i);return oF.call(this,r);}return oF.call(this,rw(u),i);};var oX=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){var a=Array.from(arguments);a[1]=rw(a[1]);return oX.apply(this,a);};var oW=window.WebSocket;window.WebSocket=function(u,q){var s=u&&u.href?String(u.href):(u&&u.url?String(u.url):rw(u));return q?new oW(rwws(s),q):new oW(rwws(s));};Object.assign(window.WebSocket,oW);window.WebSocket.prototype=oW.prototype;var oES=window.EventSource;window.EventSource=function(u,q){return new oES(rw(u),q);};EventSource.prototype=oES.prototype;var oWkr=window.Worker;window.Worker=function(u,c){return new oWkr(rw(u),c);};var oSW=window.SharedWorker;window.SharedWorker=function(u,c){return new oSW(rw(u),c);};if(navigator.serviceWorker){var oSWR=navigator.serviceWorker.register.bind(navigator.serviceWorker);navigator.serviceWorker.register=function(u,opts){return oSWR(rw(u),opts);};}var oPS=history.pushState.bind(history);history.pushState=function(s,t,u){return oPS(s,t,u!=null?rw(u):u);};var oRS=history.replaceState.bind(history);history.replaceState=function(s,t,u){return oRS(s,t,u!=null?rw(u):u);};var oLR=location.replace.bind(location);location.replace=function(u){return oLR(rw(u));};var oLA=location.assign.bind(location);location.assign=function(u){return oLA(rw(u));};try{var lhd=Object.getOwnPropertyDescriptor(Location.prototype,'href');if(lhd)Object.defineProperty(Location.prototype,'href',{get:lhd.get,set:function(u){lhd.set.call(this,rw(String(u)));},configurable:true});}catch(e){}})();</script>`
}

function rewriteContent(body: string, prefix: string): string {
	body = body.replace(/((?:href|src|action|poster|data-src|data-href)=["'])\/(?!\/|proxy\/)/g, `$1${prefix}/`)
	body = body.replace(/(\burl\(["']?)\/(?!\/|proxy\/)/g, `$1${prefix}/`)
	return body
}

function rewriteJsContent(body: string, prefix: string): string {
	const rootAbsolutes = ['/_app', '/api', '/assets', '/static', '/manifest', '/favicon', '/robots', '/sw', '/service-worker', '/ws', '/socket.io', '/ollama', '/models', '/health', '/api/v1', '/nodes']
	for (const base of rootAbsolutes) {
		body = body.replace(new RegExp(`"(https?://[^"]*)?${base}([^"]*)"`, 'g'), (match, protocol, rest) => {
			if (protocol) return match
			return `"${prefix}${base}${rest}"`
		})
		body = body.replace(new RegExp(`'(${base}[^']*)'`, 'g'), `'${prefix}$1'`)
		body = body.replace(new RegExp(`\`(${base}[^\`]*)\``, 'g'), `\`${prefix}$1\``)
	}
	// Repair already-malformed URLs: /proxy/nodes/ appearing inside string literals
	// e.g., from previous buggy rewrites that produced "/proxy/open-webui/../nodes/..."
	body = body.replace(/(["'`])\/proxy\/nodes\//g, `$1${prefix}/nodes/`)
	return body
}

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

function getProxyAppCookie(request: http.IncomingMessage | express.Request): string | undefined {
	const cookies = (request as express.Request).cookies
	const cookieId = cookies?.['umbrel_proxy_app']
	if (cookieId && /^[a-z0-9][a-z0-9-]*$/.test(cookieId)) return cookieId
	return undefined
}

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

const UMBREL_OWNED_PATHS = ['/trpc', '/manager-api', '/api/files', '/api/debug']

function isRootAbsoluteAppPath(pathname: string): boolean {
	for (const pattern of ROOT_ABSOLUTE_PATTERNS) {
		if (pattern.test(pathname)) return true
	}
	return false
}

function isUmbrelOwnedPath(pathname: string): boolean {
	return UMBREL_OWNED_PATHS.some(p => pathname.startsWith(p))
}

function getRootAbsoluteProxyAppId(
	pathname: string,
	refererAppId: string | undefined,
	cookieAppId: string | undefined,
	recentAppId: string | undefined,
): string | undefined {
	const requiresReferer = isRefererRequiredRootPath(pathname)
	if (requiresReferer) {
		return refererAppId
	}
	return refererAppId ?? cookieAppId ?? recentAppId
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

	// Cache for app_proxy container names resolved by Strategy 1 (appId -> container hostname)

	#appProxyContainerCache = new Map<string, string>()

	#recentProxyApps = new Map<string, {appId: string; expiresAt: number}>()

	#isInstalledApp(appId: string): boolean {
		return this.umbreld.apps.instances.some((app) => app.id === appId)
	}

	// External port as seen by clients — updated from X-Forwarded-Port/Proto on every HTTP request

	#externalPort = 80

	get externalPort(): number {

		return this.#externalPort

	}



	// App-specific override registry for apps that need special handling.

	// 'web'          — normal web app with HTML UI (default)

	// 'api-only'     — no HTML UI, serves API only (e.g. Ollama)

	// 'host-network' — binds to host network, not accessible from bridge (e.g. Tailscale)

	// 'service-only' — exposes an API but no web UI (e.g. bitcoind, lightning, electrs)

	#appKinds = new Map<string, 'web' | 'api-only' | 'host-network' | 'service-only'>([

		['ollama', 'api-only'],

		['tailscale', 'host-network'],

['bitcoind', 'service-only'],
		['bitcoin', 'service-only'],
		['bitcoin-knots', 'service-only'],
		['lightning', 'service-only'],
		['electrs', 'service-only'],
		['core-lightning', 'service-only'],

	])



// Cache for resolved host-network gateway probes
	#hostGatewayCache = new Map<string, string>()

	// Cache for host loopback bridge targets (appId → {target, expiresAt})
	#hostBridgeCache = new Map<string, {target: string; expiresAt: number}>()

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

	//    (on inspect failure for service-only apps, immediately falls through to Strategy 5 DNS fallback)

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

		const overrideTarget = this.#getHostProxyOverride(appId)
		if (overrideTarget) {
			this.#cacheAppTarget(appId, overrideTarget)
			this.#appKinds.set(appId, 'host-network')
			this.logger.log(`Proxy target [host override] ${appId} → ${overrideTarget}`)
			return overrideTarget
		}

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

							this.#appProxyContainerCache.set(appId, appHost)

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
			// For apps with network_mode: host, we cannot reach them via Docker DNS.
			// On a VPS, the container and host share the same network namespace when using host-mode.
			// Try: (1) explicit override env var, (2) Docker gateway probes, (3) error with diagnostic page.

			const services = Object.keys(compose.services ?? {})

			for (const svc of services) {

				if (svc === 'app_proxy' || svc === 'tor_proxy' || svc === 'i2p_daemon') continue

				const networkMode: string = ((compose.services as any)[svc] ?? {})['network_mode'] ?? ''

				if (networkMode === 'host' || networkMode.startsWith('service:') || networkMode.startsWith('container:')) {
					this.#appKinds.set(appId, 'host-network')

					// Check explicit override first
					const overrideTarget = this.#getHostProxyOverride(appId)
					if (overrideTarget) {
						this.#cacheAppTarget(appId, overrideTarget)
						this.logger.log(`Proxy target [host override] ${appId}: ${svc}→${overrideTarget}`)
						return overrideTarget
					}

					const gatewayTarget = await this.#probeHostGateway(manifestPort)
					if (gatewayTarget) {
						this.#cacheAppTarget(appId, gatewayTarget)
						this.logger.log(`Proxy target [hostnet] ${appId}: ${svc}→${gatewayTarget}`)
						return gatewayTarget
					}

					const bridgeTarget = await this.#ensureHostLoopbackBridge(appId, manifestPort)
					if (bridgeTarget) {
						this.#cacheAppTarget(appId, bridgeTarget)
						this.logger.log(`Proxy target [host bridge] ${appId}: ${svc}→${bridgeTarget}`)
						return bridgeTarget
					}

					const probeTargets = await this.#getDockerGatewayCandidates(manifestPort)
					throw new HostNetworkTargetUnavailableError(appId, manifestPort, probeTargets)
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

						return target

					}

					this.logger.log(`Proxy target [heuristic] ${appId}: ${chosenService} has no umbrel_main_network IP`)

				} catch (inspectError) {

					this.logger.log(`Proxy target [heuristic] ${appId}: inspect failed — ${(inspectError as Error).message}`)

					// For service-only apps, the container name may not match our heuristic pattern

					// (e.g. bitcoind uses service name "bitcoind" but container might be "${appId}_1" or "${appId}_bitcoind_1").

					// Immediately try DNS name fallback before going to Strategy 4 listContainers.

					if (this.#appKinds.get(appId) === 'service-only') {

						const dnsTarget = `http://${appId}_${chosenService}_1:${manifestPort}`

						this.#cacheAppTarget(appId, dnsTarget)

						this.logger.log(`Proxy target [service-only dns] ${appId} → ${dnsTarget}`)

						return dnsTarget

					}

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
			if (composeError instanceof HostNetworkTargetUnavailableError) throw composeError

			this.logger.log(`Proxy target [compose] ${appId}: read failed — ${(composeError as Error).message}`)

		}



		throw new Error(`Cannot resolve proxy target for app ${appId}: no running container found`)

	}

	#getProxyClientKey(request: http.IncomingMessage): string {
		const forwardedFor = request.headers['x-forwarded-for']
		const ip = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor
		const ua = request.headers['user-agent'] ?? ''
		return `${ip ?? (request.socket as any).remoteAddress ?? 'unknown'}|${ua}`
	}

	#rememberProxyApp(request: http.IncomingMessage, appId: string) {
		this.#recentProxyApps.set(this.#getProxyClientKey(request), {
			appId,
			expiresAt: Date.now() + 60 * 60 * 1000,
		})
	}

	#shouldForwardProxyHeaders(appId: string): boolean {
		const kind = this.#appKinds.get(appId)
		return appId === 'nextcloud' || kind === 'host-network'
	}

	#getRecentProxyApp(request: http.IncomingMessage): string | undefined {
		const entry = this.#recentProxyApps.get(this.#getProxyClientKey(request))
		if (!entry) return undefined
		if (Date.now() > entry.expiresAt) return undefined
		if (!this.#isInstalledApp(entry.appId)) return undefined
		return entry.appId
	}


	#getHostProxyOverride(appId: string): string | undefined {
		const key = `UMBREL_HOST_PROXY_TARGET_${appId.toUpperCase().replace(/-/g, '_')}`
		const value = process.env[key]?.trim()
		if (!value) return undefined
		try {
			const url = new URL(value)
			if (url.protocol === 'http:' || url.protocol === 'https:') return value
		} catch {
		}
		return undefined
	}

	async #getDockerGatewayCandidates(port: number): Promise<string[]> {
		const candidates = new Set<string>()

		candidates.add(`http://host.docker.internal:${port}`)

		try {
			const self = await this.#docker.getContainer(process.env.HOSTNAME ?? '').inspect()
			for (const network of Object.values(self.NetworkSettings?.Networks ?? {}) as any[]) {
				if (network?.Gateway) {
					candidates.add(`http://${network.Gateway}:${port}`)
				}
			}
		} catch {
		}

		candidates.add(`http://10.21.0.1:${port}`)
		candidates.add(`http://172.17.0.1:${port}`)

		return [...candidates]
	}

	// Probe the host network gateway for host-network apps (e.g. Tailscale).

	// Tries the umbrel_main_network gateway first, then standard Docker gateway.

	async #probeHostGateway(port: number): Promise<string | undefined> {

		const cacheKey = `${port}`

		if (this.#hostGatewayCache.has(cacheKey)) {

			return this.#hostGatewayCache.get(cacheKey)

		}



		const candidates = await this.#getDockerGatewayCandidates(port)



		for (const candidate of candidates) {
			if (await this.#probeTcp(candidate)) {
				this.#hostGatewayCache.set(cacheKey, candidate)
				this.logger.log(`Host gateway probe: ${candidate} ✓`)
				return candidate
			}
			this.logger.log(`Host gateway probe: ${candidate} ✗`)
		}
		return undefined
	}

	async #probeTcp(target: string): Promise<boolean> {
		return new Promise((resolve) => {
			const url = new URL(target)
			const socket = net.createConnection({
				host: url.hostname,
				port: Number(url.port),
				timeout: 1500,
			})
			const done = (result: boolean) => {
				socket.destroy()
				resolve(result)
			}
			socket.once('connect', () => done(true))
			socket.once('timeout', () => done(false))
			socket.once('error', () => done(false))
		})
	}

	#getHostBridgePort(appId: string, appPort: number): number {
		let hash = 0
		for (const char of appId) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0
		return 18000 + (Math.abs(hash) % 20000)
	}

	#getHostBridgeContainerName(appId: string): string {
		return `umbrel-host-bridge-${appId}`
	}

	async #getDockerGatewayBindAddresses(): Promise<string[]> {
		const addresses = new Set<string>()
		try {
			const self = await this.#docker.getContainer(process.env.HOSTNAME ?? '').inspect()
			for (const network of Object.values(self.NetworkSettings?.Networks ?? {}) as any[]) {
				if (network?.Gateway) addresses.add(network.Gateway)
			}
		} catch {
		}
		addresses.add('10.21.0.1')
		addresses.add('172.17.0.1')
		return [...addresses]
	}

	async #getSelfImage(): Promise<string> {
		try {
			const self = await this.#docker.getContainer(process.env.HOSTNAME ?? '').inspect()
			return process.env.UMBREL_HOST_BRIDGE_IMAGE?.trim() || self.Config.Image
		} catch {
			return process.env.UMBREL_HOST_BRIDGE_IMAGE?.trim() || 'umbrel-os:local'
		}
	}

	async #ensureHostLoopbackBridge(appId: string, targetPort: number): Promise<string | undefined> {
		if (process.env.UMBREL_HOST_BRIDGE_ENABLED === 'false') return undefined

		const cached = this.#hostBridgeCache.get(appId)
		if (cached && Date.now() < cached.expiresAt) {
			this.logger.log(`Proxy target [host bridge cache] ${appId} → ${cached.target}`)
			return cached.target
		}

		const bridgePort = this.#getHostBridgePort(appId, targetPort)
		const containerName = this.#getHostBridgeContainerName(appId)
		const image = await this.#getSelfImage()
		const bindAddresses = await this.#getDockerGatewayBindAddresses()

		for (const bindAddress of bindAddresses) {
			const target = `http://${bindAddress}:${bridgePort}`
			if (await this.#probeTcp(target)) {
				this.logger.log(`Proxy target [host bridge cache] ${appId} → ${target}`)
				this.#hostBridgeCache.set(appId, {target, expiresAt: Date.now() + 60_000})
				return target
			}
		}

		try {
			await this.#docker.getContainer(containerName).remove({force: true}).catch(() => undefined)

			const bindAddress = bindAddresses[0]
			if (!bindAddress) return undefined

			const container = await this.#docker.createContainer({
				Image: image,
				name: containerName,
				Entrypoint: ['socat'],
				Cmd: [
					'-d', '-d',
					`TCP-LISTEN:${bridgePort},bind=${bindAddress},fork,reuseaddr`,
					`TCP:127.0.0.1:${targetPort}`,
				],
				Labels: {
					'umbrel.host-bridge': 'true',
					'umbrel.host-bridge.app': appId,
				},
				HostConfig: {
					NetworkMode: 'host',
					RestartPolicy: {Name: 'unless-stopped'},
				},
			})

			await container.start()

			const target = `http://${bindAddress}:${bridgePort}`

			for (let attempt = 0; attempt < 10; attempt++) {
				if (await this.#probeTcp(target)) {
					this.logger.log(`Proxy target [host bridge] ${appId}: ${target} → 127.0.0.1:${targetPort}`)
					this.#hostBridgeCache.set(appId, {target, expiresAt: Date.now() + 60_000})
					return target
				}
				await new Promise((resolve) => setTimeout(resolve, 300))
			}

			this.logger.log(`Proxy target [host bridge] ${appId}: bridge started but ${target} is not reachable`)
			return undefined
		} catch (error) {
			this.logger.log(`Proxy target [host bridge] ${appId}: failed — ${(error as Error).message}`)
			return undefined
		}
	}

	// Run Nextcloud occ commands to configure trusted domains and reverse proxy headers.

	// Idempotent — safe to call multiple times.

	// Uses real forwarded hostname from the incoming request.

	async #repairNextcloud(appId: string, containerName: string, forwardedHost: string): Promise<void> {

		const occCommands = [

			['config:system:set', 'trusted_domains', '1', `--value=${forwardedHost}`],

			['config:system:set', 'overwrite.cli.url', `--value=https://${forwardedHost}/proxy/${appId}`],

			['config:system:set', 'overwriteprotocol', '--value=https'],

			['config:system:set', 'overwritewebroot', `--value=/proxy/${appId}`],

			['config:system:set', 'overwritehost', `--value=${forwardedHost.split(':')[0]}`],

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
		if (this.#appProxyCache.has(cacheKey)) {
			return this.#appProxyCache.get(cacheKey)!
		}

		const prefix = `/proxy/${appId}`
		const injectScript = buildInjectScript(prefix)

		const proxyOptions: Parameters<typeof createProxyMiddleware>[0] = {
			target,
			changeOrigin: true,
			proxyTimeout: 30000,
			timeout: 30000,
			ws: false,
			cookiePathRewrite: {'/': prefix},
			cookieDomainRewrite: {'*': ''},
			pathRewrite: (path: string): string => {
				if (path === prefix) return '/'
				if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length)
				return path
			},
			onError: (err: Error, _req: http.IncomingMessage, res: http.ServerResponse | any) => {
				this.logger.error(`[${appId}] proxy error (${target}): ${(err as Error).message}`)
				if ((res as http.ServerResponse).headersSent) return
				if (typeof (res as any).writeHead === 'function') {
					;(res as http.ServerResponse).writeHead(502, {'Content-Type': 'text/plain'})
					;(res as http.ServerResponse).end('App proxy unavailable')
				} else {
					;(res as any).destroy?.()
				}
			},
		}

		if (rewriteLocation) {
			proxyOptions.onProxyReq = (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
				proxyReq.setHeader('Accept-Encoding', 'identity')
				proxyReq.removeHeader('if-none-match')
				proxyReq.removeHeader('if-modified-since')
				proxyReq.removeHeader('if-unmodified-since')

				const forwardedHost = (req.headers['x-forwarded-host'] as string) || 'os.dominic.pw'
				const forwardedProto = (req.headers['x-forwarded-proto'] as string) || 'https'
				const forwardedPort = (req.headers['x-forwarded-port'] as string) || '443'

				if (this.#shouldForwardProxyHeaders(appId)) {
					proxyReq.setHeader('X-Forwarded-Host', forwardedHost)
					proxyReq.setHeader('X-Forwarded-Proto', forwardedProto)
					proxyReq.setHeader('X-Forwarded-Port', forwardedPort)
					const forwardedFor = req.headers['x-forwarded-for']
					const clientIp = Array.isArray(forwardedFor)
						? forwardedFor[0]
						: forwardedFor || req.socket.remoteAddress || ''
					if (clientIp) proxyReq.setHeader('X-Forwarded-For', clientIp)
					if (appId === 'nextcloud') {
						proxyReq.setHeader('X-Forwarded-Prefix', prefix)
						proxyReq.setHeader('Host', forwardedHost.split(':')[0])
						proxyReq.setHeader('Overwritehost', forwardedHost.split(':')[0])
					}
				} else {
					proxyReq.removeHeader('x-forwarded-host')
					proxyReq.removeHeader('x-forwarded-proto')
					proxyReq.removeHeader('x-forwarded-port')
				}

				const inPath = req.url ?? proxyReq.path ?? '/'
				const outPath = inPath.startsWith(`${prefix}/`)
					? inPath.slice(prefix.length)
					: (inPath === prefix ? '/' : inPath)
				proxyReq.path = outPath
				this.logger.log(`[${appId}] proxyReq: ${inPath} → ${target}${outPath}`)
			}

			proxyOptions.onProxyReqWs = (proxyReq: http.ClientRequest, req: http.IncomingMessage) => {
				const fwdHost = (req.headers['x-forwarded-host'] as string) || 'os.dominic.pw'
				proxyReq.setHeader('Host', fwdHost)
				proxyReq.setHeader('Origin', `https://${fwdHost}`)
				if (this.#shouldForwardProxyHeaders(appId)) {
					proxyReq.setHeader('X-Forwarded-Host', fwdHost)
					proxyReq.setHeader('X-Forwarded-Proto', 'https')
					const forwardedFor = req.headers['x-forwarded-for']
					const clientIp = Array.isArray(forwardedFor)
						? forwardedFor[0]
						: forwardedFor || req.socket.remoteAddress || ''
					if (clientIp) proxyReq.setHeader('X-Forwarded-For', clientIp)
				}
				this.logger.log(`[${appId}] wsUpgrade: ${req.url} → ${target}`)
			}

			proxyOptions.onProxyRes = (proxyRes: http.IncomingMessage, _req: http.IncomingMessage, res: http.ServerResponse) => {
				const contentType = (proxyRes.headers['content-type'] as string) ?? ''
				this.logger.log(
					`[${appId}] proxyRes: ${proxyRes.statusCode} ` +
					`Location=${proxyRes.headers.location || '-'} ` +
					`CT=${contentType.split(';')[0].trim() || '-'}`,
				)

				const loc = proxyRes.headers.location
				if (typeof loc === 'string') {
					proxyRes.headers.location = rewriteRedirectLocation(loc, prefix) ?? loc
				}
				const refresh = proxyRes.headers.refresh
				if (typeof refresh === 'string' && refresh.includes('url=')) {
					const m = refresh.match(/url=(.+)/i)
					if (m) {
						const orig = m[1].trim().replace(/^["']|["']$/g, '')
						let rewritten: string
						if (orig.startsWith('/') && !orig.startsWith('//')) {
							rewritten = `${prefix}${orig}`
						} else {
							try {
								const u = new URL(orig)
								rewritten = `${prefix}${u.pathname}${u.search}${u.hash}`
							} catch {
								rewritten = orig
							}
						}
						proxyRes.headers.refresh = refresh.replace(/url=.+/i, `url=${rewritten}`)
					}
				}

				const isHtml = contentType.includes('text/html')
				const isCss = contentType.includes('text/css')
				const isJs =
					contentType.includes('application/javascript') ||
					contentType.includes('text/javascript')
				const isManifest = contentType.includes('application/manifest+json')

				if (!isHtml && !isCss && !isJs && !isManifest) return

				if (appId === 'nextcloud') return

				delete proxyRes.headers['content-security-policy']
				delete proxyRes.headers['referrer-policy']
				proxyRes.headers['referrer-policy'] = 'same-origin'
				delete proxyRes.headers['content-length']
				delete proxyRes.headers['content-encoding']
				delete proxyRes.headers['etag']
				delete proxyRes.headers['last-modified']
				delete proxyRes.headers['cache-control']
				proxyRes.headers['cache-control'] = 'no-store'

				const chunks: Buffer[] = []
				const origWrite = res.write.bind(res)
				const origEnd = res.end.bind(res)

				;(res as any).write = (chunk: any): boolean => {
					if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
					return true
				}

				;(res as any).end = (chunk?: any): http.ServerResponse => {
					if (chunk != null && chunk !== '') {
						chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
					}

					res.write = origWrite
					res.end = origEnd

					let body = Buffer.concat(chunks).toString('utf8')

					res.setHeader('Set-Cookie', `umbrel_proxy_app=${appId}; Path=/; SameSite=Lax; Max-Age=3600`)

					if (isHtml) {
						if (/<head\b/i.test(body)) {
							body = body.replace(/(<head\b[^>]*)(>)/i, `$1$2${injectScript}`, 1)
						} else {
							body = injectScript + body
						}
						body = rewriteContent(body, prefix)
					}

					if (isJs) {
						body = rewriteJsContent(body, prefix)
					}

					origWrite(Buffer.from(body, 'utf8'))
					origEnd()
					return res
				}
			}
		}

		const pm = createProxyMiddleware(proxyOptions)
		this.#appProxyCache.set(cacheKey, pm)
		return pm
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
			response.removeHeader('Referrer-Policy')
			response.setHeader('Referrer-Policy', 'same-origin')



			let appId = match[1]

			// match[2] is the path after /proxy/<appId>, e.g. "/web/" or undefined

			let appPath = match[2] || '/'


			// Recover malformed /proxy/<root-absolute-path> — browser asked for
			// /proxy/nodes/file.js thinking it was an app, but "nodes" is not an app.
			// Reconstruct the real appId from Referer/cookie and rebase the path.
			if (!this.#isInstalledApp(appId)) {
				const recoveredAppId = getAppIdFromReferer(request) ?? getProxyAppCookie(request) ?? this.#getRecentProxyApp(request)
				const recoveredAppPath = `/${appId}${appPath === '/' ? '' : appPath}`

				if (
					recoveredAppId &&
					recoveredAppId !== appId &&
					this.#isInstalledApp(recoveredAppId) &&
					isRootAbsoluteAppPath(recoveredAppPath)
				) {
					this.logger.log(`[${recoveredAppId}] recovered malformed proxy path: ${parsedUrl.pathname} → ${recoveredAppPath}`)
					appId = recoveredAppId
					appPath = recoveredAppPath
				}
				else if (isRootAbsoluteAppPath(recoveredAppPath)) {
					this.logger.log(`[proxy] malformed proxy path has no app context: ${parsedUrl.pathname}`)
					return response.status(409).json({
						error: 'Could not recover proxied app context',
						path: recoveredAppPath,
					})
				}
			}


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



			// Service-only apps (bitcoind, lightning, etc.) have no web UI — serve a landing page

			const appKind = this.#appKinds.get(appId)

			if (appKind === 'service-only' && appPath === '/') {

				let appName = appId

				let appDescription = 'This app does not have a web interface.'

				let connectionInfo = ''

				let furtherHelp = ''



				if (appId === 'bitcoind') {

					appName = 'Bitcoin Node'

					appDescription = 'Bitcoin Core is running as a background service with no web interface.'

					connectionInfo = `

<h2>RPC Configuration</h2>

<p>Connect to your Bitcoin Node from other apps using:</p>

<ul>

  <li><strong>Host:</strong> <code>bitcoind</code> or <code>bitcoind_1</code></li>

  <li><strong>RPC Port:</strong> <code>8332</code> (HTTP)</li>

  <li><strong>ZMQ Pub Port:</strong> <code>28332</code></li>

</ul>

<p>For RPC calls, you may need to configure a <code>bitcoin.conf</code> with <code>rpcuser</code> and <code>rpcpassword</code>.</p>

`

					furtherHelp = `

<h2>Setup RPC Credentials</h2>

<p>If you haven't already, generate RPC credentials via theumbrel terminal:</p>

<pre style="background:#f4f4f4;padding:15px;border-radius:6px;overflow-x:auto">

# Show default credentials (auto-generated on first start)

cat /data/umbrel/app-data/bitcoind/data/bitcoin/.bitcoin/bitcoin.conf

</pre>

`

				} else if (appId === 'bitcoin' || appId === 'bitcoin-knots') {

					appName = 'Bitcoin Node'

					appDescription = 'Bitcoin Core is running as a background service with no web interface.'

					connectionInfo = `

<h2>Bitcoin Core RPC</h2>

<p>Connect to your Bitcoin Node from other apps using the RPC interface:</p>

<ul>

  <li><strong>Host:</strong> <code>${appId}</code> or <code>${appId}_1</code></li>

  <li><strong>RPC Port:</strong> <code>8332</code> (HTTP)</li>

  <li><strong>ZMQ Pub Port:</strong> <code>28332</code></li>

</ul>

<p>RPC credentials are stored in the app's environment. Access them via the Umbrel terminal:</p>

<pre style="background:#f4f4f4;padding:15px;border-radius:6px;overflow-x:auto">

# View RPC credentials

cat /data/umbrel/app-data/${appId}/data/bitcoin/.bitcoin/bitcoin.conf | grep "^rpc"

</pre>

<p>See <a href="https://developer.bitcoin.org/reference/rpc/" target="_blank">Bitcoin Core RPC Documentation</a> for available endpoints.</p>

`

				} else if (appId === 'lightning') {

					appName = 'Lightning Node'

					appDescription = 'Lightning Daemon (LND) is running as a background service with no web interface.'

					connectionInfo = `

<h2>Connection Details</h2>

<ul>

  <li><strong>Host:</strong> <code>lightning</code> or <code>lightning_1</code></li>

  <li><strong>gRPC Port:</strong> <code>10009</code></li>

  <li><strong>REST Port:</strong> <code>8080</code></li>

</ul>

`

					furtherHelp = `

<h2>Connecting to Your Lightning Node</h2>

<p>Use the connection strings below to connect wallets and apps:</p>

<pre style="background:#f4f4f4;padding:15px;border-radius:6px;overflow-x:auto">

# REST endpoint (for browser wallets, etc.)

http://lightning:8080



# gRPC endpoint (for programmatic access)

lightning:10009

</pre>

`

				} else if (appId === 'electrs') {

					appName = 'Electrs'

					appDescription = 'Electrum Server is running as a background service with no web interface.'

					connectionInfo = `

<h2>Connection Details</h2>

<ul>

  <li><strong>Host:</strong> <code>electrs</code> or <code>electrs_1</code></li>

  <li><strong>Port:</strong> <code>50001</code> (TCP Electrum protocol)</li>

</ul>

<p>Connect using any Electrum-compatible wallet (e.g. Sparrow, Blue Wallet).</p>

`

				} else if (appId === 'core-lightning') {

					appName = 'Core Lightning'

					appDescription = 'Core Lightning (c-lightning) is running as a background service with no web interface.'

					connectionInfo = `

<h2>Connection Details</h2>

<ul>

  <li><strong>Host:</strong> <code>core-lightning</code> or <code>core-lightning_1</code></li>

  <li><strong>RPC Socket:</strong> <code>/lightningd/lightning-rpc</code></li>

</ul>

`

				}



				response.set('Content-Type', 'text/html; charset=utf-8')

				return response.send(`<!DOCTYPE html>

<html lang="en">

<head><meta charset="utf-8"><title>${appName}</title></head>

<body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px">

  <h1>${appName}</h1>

  <p>${appDescription}</p>

  ${connectionInfo}

  ${furtherHelp}

  <h2>Proxy API</h2>

  <p>You can access the app API via the proxy prefix:</p>

  <ul>

    <li><a href="/proxy/${appId}/api/">/proxy/${appId}/api/</a></li>

  </ul>

</body></html>`)

			}



			try {

				const target = await this.#resolveAppTarget(appId)

				this.#rememberProxyApp(request, appId)


				// Repair Nextcloud trusted domains once per startup on first successful resolution.

				// Uses the real forwarded host from the incoming request, defaulting to os.dominic.pw.

				if (appId === 'nextcloud' && !this.#nextcloudRepaired) {

					const forwardedHost = Array.isArray(request.headers['x-forwarded-host'])

						? request.headers['x-forwarded-host'][0]

						: (request.headers['x-forwarded-host'] as string) || 'os.dominic.pw'

					const containerName = this.#appProxyContainerCache.get(appId) ?? appId + '_nextcloud_1'

					await this.#repairNextcloud(appId, containerName, forwardedHost)

					this.#nextcloudRepaired = true


				}



// Manually set request.url to the stripped path so the proxied app

				// receives the correct path (e.g. /web/) without the /proxy/:appId prefix.

				request.url = `${appPath}${parsedUrl.search || ''}`

				this.logger.log(`Proxy HTTP ${appId} → ${target} (req.url=${request.url})`)

				this.#getAppProxy(appId, target, {rewriteLocation: true})(request, response, next)

			} catch (error) {

				this.logger.error(`App proxy setup error for ${appId}`, error)

				if (error instanceof HostNetworkTargetUnavailableError) {
					response.status(502).set('Content-Type', 'text/html; charset=utf-8')
					const probeList = error.probeTargets.map((t) => `<li><code>${t}</code></li>`).join('')
					let nextChecks = ''
					if (error.appId === 'home-assistant') {
						nextChecks = `
    <li>Confirm the app is listening on the host port <code>${error.port}</code>.</li>
    <li>Confirm it binds to <code>0.0.0.0</code> (not <code>127.0.0.1</code>).</li>
    <li>In <code>configuration.yaml</code>, configure:</li>
    <ul>
      <li><code>http:</code></li>
      <li><code>  use_x_forwarded_for: true</code></li>
      <li><code>  trusted_proxies:</code></li>
      <li><code>    - 10.21.0.0/16</code></li>
      <li><code>    - 172.16.0.0/12</code></li>
    </ul>
    <li>Set the env var: <code>UMBREL_HOST_PROXY_TARGET_HOME_ASSISTANT=http://host.docker.internal:8123</code></li>
  `
					} else if (error.appId === 'tailscale') {
						return response.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Tailscale</title></head>
<body style="font-family:system-ui;max-width:760px;margin:60px auto;padding:0 20px;line-height:1.5">
  <h1>Tailscale</h1>
  <p>This is a host-network app that runs Tailscale on your VPS.</p>
  <p>Tailscale does not provide a traditional local web interface on this VPS. To manage this node:</p>

  <h2>Access Tailscale Admin Console</h2>
  <ul>
    <li><a href="https://login.tailscale.com/admin/machines">Open Tailscale Admin Console (login.tailscale.com)</a></li>
  </ul>

  <h2>Check Tailscale Status</h2>
  <p>Run these commands on your VPS host to check Tailscale status:</p>
  <pre>docker logs tailscale_web_1
docker exec tailscale_web_1 tailscale status</pre>

  <h2>What This Page Means</h2>
  <p>The Umbrel proxy cannot reach Tailscale because it uses Docker host networking and either:</p>
  <ul>
    <li>Tailscale's web UI is not exposed on port 8240</li>
    <li>The port is firewalled from the Docker bridge network</li>
    <li>Tailscale is configured to only listen on a specific interface</li>
  </ul>
</body></html>`)
					} else {
						nextChecks = `
    <li>Confirm the app is listening on the host port <code>${error.port}</code>.</li>
    <li>Confirm it binds to <code>0.0.0.0</code> or a host interface reachable from Docker bridge networks.</li>
    <li>Set a target override: <code>UMBREL_HOST_PROXY_TARGET_${error.appId.toUpperCase()}=http://host.docker.internal:${error.port}</code></li>
    <li>Override configured: <code>${this.#getHostProxyOverride(error.appId) || 'none'}</code></li>
    <li>Host bridge enabled: <code>${process.env.UMBREL_HOST_BRIDGE_ENABLED !== 'false' ? 'yes' : 'no'}</code></li>
    <li>Bridge container: <code>${this.#getHostBridgeContainerName(error.appId)}</code></li>
    <li>Expected bridge target: <code>http://10.21.0.1:${this.#getHostBridgePort(error.appId, error.port)}</code></li>
  `
					}
					return response.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${error.appId}</title></head>
<body style="font-family:system-ui;max-width:760px;margin:60px auto;padding:0 20px;line-height:1.5">
  <h1>${error.appId}</h1>
  <p>This app uses Docker host networking and its port is not reachable from the Umbrel container.</p>

  <h2>What was checked</h2>
  <ul>
    ${probeList}
  </ul>

  <h2>What this means</h2>
  <p>The app may be bound to <code>127.0.0.1</code>, blocked by host firewall rules, not running, or not exposing its web UI on port <code>${error.port}</code>.</p>

  <h2>Next checks</h2>
  <ul>
    ${nextChecks}
  </ul>
</body></html>`)
				}

				// For service-only apps, a 502 is confusing — they don't have a web UI anyway

				if (this.#appKinds.get(appId) === 'service-only') {

					// Fallback: show a landing page even though target resolution failed

					response.set('Content-Type', 'text/html; charset=utf-8')

					return response.send(`<!DOCTYPE html>

<html lang="en">

<head><meta charset="utf-8"><title>${appId}</title></head>

<body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px">

  <h1>${appId}</h1>

  <p>This app is running but the proxy could not resolve its container address.</p>

  <p>Error: ${(error as Error).message}</p>

  <p>Try accessing the API directly at <code>/proxy/${appId}/api/</code></p>

</body></html>`)

				}

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

		// Referer-based root-absolute SPA asset proxy
		// Handles SPAs that emit /_app/, /api/, /assets/ etc — browser sends them to root domain
		this.app.use(async (request: express.Request, response: express.Response, next: express.NextFunction) => {
			const urlObj = new URL(request.originalUrl, 'https://os.dominic.pw')
			const pathname = urlObj.pathname
			const search = urlObj.search

			if (!isRootAbsoluteAppPath(pathname)) return next()
			if (isUmbrelOwnedPath(pathname)) return next()

			const refererBasedAppId = getAppIdFromReferer(request)
			const cookieBasedAppId = getProxyAppCookie(request)
			const recentAppId = this.#getRecentProxyApp(request)

			const appId = getRootAbsoluteProxyAppId(pathname, refererBasedAppId, cookieBasedAppId, recentAppId)
			if (!appId) return next()
			if (!this.#isInstalledApp(appId)) return next()

			try {
				const target = await this.#resolveAppTarget(appId)
				const via = refererBasedAppId ? 'Referer' : cookieBasedAppId ? 'cookie' : recentAppId ? 'recent' : 'none'
				this.logger.log(`[${appId}] root-absolute proxy: ${pathname}${search || ''} (via ${via})`)
				const proxy = this.#getAppProxy(appId, target, {rewriteLocation: true})
				proxy(request, response, next)
			} catch (err) {
				this.logger.error(`[${appId}] root-absolute proxy failed: ${(err as Error).message}`)
				next()
			}
		})



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



				let rawUrl = request.url || '/'
				if (!rawUrl.startsWith('/') || rawUrl.includes('://')) {
					try {
						const u = new URL(rawUrl, 'https://dummy')
						rawUrl = u.pathname + u.search
					} catch {
						rawUrl = '/'
					}
				}
				const {pathname, searchParams} = new URL(rawUrl, 'https://localhost')



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

				const appProxyMatch = pathname.match(/^\/proxy\/([a-z0-9][a-z0-9-]*)(\/.*)?$/)

				if (appProxyMatch) {

					const appId = appProxyMatch[1]

					// WS upgrades bypass Express — strip /proxy/${appId} from request.url manually

					// so the app container receives just the path it expects (e.g. /ws not /proxy/appId/ws)

					const strippedPath = appProxyMatch[2] || '/'

					const search = searchParams.toString() ? `?${searchParams.toString()}` : ''

					request.url = `${strippedPath}${search}`

					try {

						const target = await this.#resolveAppTarget(appId)

						const proxy = this.#getAppProxy(appId, target, {rewriteLocation: true})

						;(proxy as any).upgrade(request, socket, head)

						this.logger.log(`[${appId}] wsUpgrade: ${pathname}${search} → ${target}${strippedPath}${search}`)

					} catch (error) {

						this.logger.error(`WS app proxy error for ${appId}`, error)

						socket.destroy()

					}

					return

				}


				// Root-absolute WebSocket fallback (e.g. /api/terminal, /ws, /socket.io)
				// Proxies to the correct app when browser connects to root path
				if (isRootAbsoluteAppPath(pathname) && !isUmbrelOwnedPath(pathname)) {
					const upgradeReq = request as any
					if (upgradeReq.headers?.cookie) {
						const cookieMatch = upgradeReq.headers.cookie.match(/umbrel_proxy_app=([a-z0-9][a-z0-9-]*)/)
						if (cookieMatch) {
							const appId = cookieMatch[1]
							try {
								const target = await this.#resolveAppTarget(appId)
								const proxy = this.#getAppProxy(appId, target, {rewriteLocation: true})
								this.logger.log(`[${appId}] root-absolute wsUpgrade: ${pathname}${rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : ''} → ${target}${pathname}`)
								;(proxy as any).upgrade(request, socket, head)
								return
							} catch (err) {
								this.logger.error(`[${appId}] root-absolute wsUpgrade failed: ${(err as Error).message}`)
							}
						}
					}
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

				const overrideTarget = this.#getHostProxyOverride(appId)

				const bridgePort = this.#getHostBridgePort(appId, port)

				const bridgeContainer = this.#getHostBridgeContainerName(appId)

				const gatewayAddresses = await this.#getDockerGatewayBindAddresses()

				const bridgeTarget = await this.#probeTcp(`http://${gatewayAddresses[0] || '10.21.0.1'}:${bridgePort}`).catch(() => false)
					? `http://${gatewayAddresses[0]}:${bridgePort}`
					: undefined

				response.json({
					appId,
					port,
					target,
					overrideTarget,
					hostBridge: {
						enabled: process.env.UMBREL_HOST_BRIDGE_ENABLED !== 'false',
						container: bridgeContainer,
						port: bridgePort,
						target: bridgeTarget,
					},
					containers: containers.map((c) => ({

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

ws: false,

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
