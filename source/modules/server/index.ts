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

	// Resolve the correct proxy target for an app using dockerode to get the container's
	// actual IP in umbrel_main_network. Never falls back to app_proxy (requires an auth
	// manager at 10.21.21.4:3006 that we don't run). Cache result for 60 s so container
	// restarts (which may change the IP) are reflected promptly.
	async #resolveAppTarget(appId: string): Promise<string> {
		const cached = this.#appTargetCache.get(appId)
		if (cached && Date.now() < cached.expiresAt) {
			return cached.target
		}

		const app = this.umbreld.apps.getApp(appId)
		const {port} = await app.readManifest()

		const systemServices = new Set(['app_proxy', 'tor_proxy', 'i2p_daemon'])
		let mainServiceName: string | undefined
		let useHostNetwork = false

		try {
			const compose = await app.readCompose()
			const services = Object.keys(compose.services ?? {})
			mainServiceName = services.find((s) => !systemServices.has(s)) ?? services[0]
			if (mainServiceName) {
				const networkMode: string = ((compose.services as any)[mainServiceName] ?? {}).network_mode ?? ''
				if (networkMode === 'host' || networkMode.startsWith('service:') || networkMode.startsWith('container:')) {
					useHostNetwork = true
				}
			}
		} catch {
			// compose unreadable — proceed with dockerode lookup
		}

		if (useHostNetwork) {
			const target = `http://host.docker.internal:${port}`
			this.#cacheAppTarget(appId, target)
			return target
		}

		// Use dockerode to find the running container and get its IP in umbrel_main_network.
		// This is more reliable than DNS: works even when the compose file is unreadable and
		// avoids the brief window after container start when DNS hasn't propagated yet.
		try {
			const containers = await this.#docker.listContainers({
				filters: JSON.stringify({
					label: [`com.docker.compose.project=${appId}`],
					status: ['running'],
				}),
			})

			const mainContainer = containers.find((c) => {
				const service = c.Labels['com.docker.compose.service']
				return service && !systemServices.has(service)
			})

			if (mainContainer) {
				const ip = (mainContainer.NetworkSettings.Networks as any)?.['umbrel_main_network']?.IPAddress
				if (ip) {
					const target = `http://${ip}:${port}`
					this.#cacheAppTarget(appId, target)
					return target
				}
			}
		} catch (error) {
			this.logger.verbose(`Dockerode lookup failed for ${appId}: ${(error as Error).message}`)
		}

		// Last resort: DNS-based container name set by patchComposeFile. Never use app_proxy.
		if (mainServiceName) {
			const target = `http://${appId}_${mainServiceName}_1:${port}`
			this.#cacheAppTarget(appId, target)
			return target
		}

		throw new Error(`Cannot resolve proxy target for app ${appId}: no running container found`)
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
				`})();</script>`

			this.#appProxyCache.set(
				cacheKey,
				createProxyMiddleware({
					target,
					changeOrigin: true,
					proxyTimeout: 30000,
					timeout: 30000,
					on: {
						...(rewriteLocation && {
							proxyReq: (proxyReq: http.ClientRequest) => {
								// Disable compression so HTML can be rewritten as plain text.
								proxyReq.setHeader('Accept-Encoding', 'identity')
							},
							proxyRes: (proxyRes: http.IncomingMessage, _req: http.IncomingMessage, res: http.ServerResponse) => {
								// Rewrite Location headers so redirects stay within /proxy/:appId.
								const loc = proxyRes.headers.location
								if (
									typeof loc === 'string' &&
									loc.startsWith('/') &&
									!loc.startsWith('//') &&
									!loc.startsWith(`${prefix}/`) &&
									loc !== prefix
								) {
									proxyRes.headers.location = `${prefix}${loc}`
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
							},
						}),
						error: (err: Error, _req: http.IncomingMessage, res: http.ServerResponse | any) => {
							this.logger.error(`App proxy error (${target}): ${(err as Error).message}`)
							if (!(res as http.ServerResponse).headersSent) {
								;(res as http.ServerResponse).writeHead(502, {'Content-Type': 'text/plain'})
								res.end('App proxy unavailable')
							}
						},
					},
				}),
			)
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

		// Subdomain app routing — handles ${appId}.${umbreldDomain} HTTP requests.
		// Must be registered before /proxy/:appId so subdomain requests are never redirected.
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
				const appProxyMatch = pathname.match(/^\/proxy\/([^/]+)/)
				if (appProxyMatch) {
					const appId = appProxyMatch[1]
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

		// App entry point: redirect to subdomain when UMBREL_DOMAIN is set (universal fix),
		// otherwise fall back to path-based proxy with Location rewriting.
		this.app.use('/proxy/:appId', async (request, response, next) => {
			// Strip Helmet's CSP — it would block the injected inline URL-rewriting script
			// and all inline scripts from the proxied app.
			response.removeHeader('Content-Security-Policy')
			const {appId} = request.params
			if (umbreldDomain) {
				const proto = this.#externalPort === 443 ? 'https' : 'http'
				return response.redirect(302, `${proto}://${appId}.${umbreldDomain}${request.url}`)
			}
			try {
				const target = await this.#resolveAppTarget(appId)
				this.#getAppProxy(appId, target, {rewriteLocation: true})(request, response, next)
			} catch (error) {
				this.logger.error(`App proxy setup error for ${appId}`, error)
				response.status(404).json({error: 'App not found or not running'})
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
