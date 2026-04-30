import http from 'node:http'
import process from 'node:process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'
import {createGzip, createGunzip, createInflate, createBrotliDecompress} from 'node:zlib'
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
	#appProxyCache = new Map<string, ReturnType<typeof createProxyMiddleware>>()
	#appTargetCache = new Map<string, string>()
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

	// Resolve the correct proxy target for an app.
	// Always bypasses the Umbrel app_proxy (which relies on a legacy auth manager we don't run)
	// and connects directly to the main app service container.
	// For services that use host/container network mode, falls back to host.docker.internal.
	async #resolveAppTarget(appId: string): Promise<string> {
		if (this.#appTargetCache.has(appId)) {
			return this.#appTargetCache.get(appId)!
		}

		const app = this.umbreld.apps.getApp(appId)
		const {port} = await app.readManifest()
		// Fallback: the app_proxy hostname alias (set by app-script via APP_PROXY_HOSTNAME)
		let target = `http://app_proxy_${appId}:${port}`

		try {
			const compose = await app.readCompose()
			const services = Object.keys(compose.services ?? {})
			const systemServices = new Set(['app_proxy', 'tor_proxy', 'i2p_daemon'])
			const mainService = services.find((s) => !systemServices.has(s)) ?? services[0]

			if (mainService) {
				const serviceConfig = (compose.services as any)[mainService] ?? {}
				const networkMode: string = serviceConfig.network_mode ?? ''

				if (networkMode === 'host' || networkMode.startsWith('service:') || networkMode.startsWith('container:')) {
					// Shared or host network stack: container is not in umbrel_main_network.
					// Reach it via the Docker host gateway (compose.yml maps host.docker.internal).
					target = `http://host.docker.internal:${port}`
				} else {
					// Normal bridge networking: resolve by the container name set by patchComposeFile.
					target = `http://${appId}_${mainService}_1:${port}`
				}
			}
		} catch {
			// compose unreadable — keep the app_proxy hostname fallback
		}

		this.#appTargetCache.set(appId, target)
		return target
	}

	// rewriteLocation: true  → path-based proxy: buffers HTML responses, rewrites root-relative
	//                          URLs in attributes and injects a fetch/XHR/WS interceptor script.
	// rewriteLocation: false → subdomain proxy: pass-through (root-relative URLs work natively).
	#getAppProxy(appId: string, target: string, {rewriteLocation = false} = {}) {
		const cacheKey = `${appId}|${target}|${rewriteLocation}`
		if (!this.#appProxyCache.has(cacheKey)) {
			this.#appProxyCache.set(
				cacheKey,
				createProxyMiddleware({
					target,
					changeOrigin: true,
					// When rewriting, we handle the response ourselves so we can buffer + patch HTML.
					selfHandleResponse: rewriteLocation,
					on: {
						proxyRes: rewriteLocation
							? (proxyRes, _req, res) => {
									this.#rewriteHtmlResponse(appId, proxyRes as http.IncomingMessage, res as http.ServerResponse).catch(
										(err) => {
											this.logger.error(`HTML rewrite error for ${appId}: ${(err as Error).message}`)
											if (!(res as http.ServerResponse).headersSent) {
												;(res as http.ServerResponse).writeHead(502, {'Content-Type': 'text/plain'})
												;(res as http.ServerResponse).end('Proxy error')
											}
										},
									)
								}
							: undefined,
						error: (err, _req, res) => {
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

	async #rewriteHtmlResponse(appId: string, proxyRes: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const prefix = `/proxy/${appId}`

		// Copy headers so we can mutate them
		const headers: Record<string, string | string[] | undefined> = {...proxyRes.headers}

		// Rewrite Location header for any redirect response
		if (typeof headers.location === 'string') {
			const loc = headers.location
			if (loc.startsWith('/') && !loc.startsWith('//') && !loc.startsWith(`${prefix}/`) && loc !== prefix) {
				headers.location = `${prefix}${loc}`
			}
		}

		const contentType = (headers['content-type'] as string) ?? ''
		if (!contentType.includes('text/html')) {
			// Non-HTML: forward as-is (with possibly rewritten Location)
			res.writeHead(proxyRes.statusCode!, headers)
			proxyRes.pipe(res)
			return
		}

		// HTML: decompress → rewrite → send uncompressed
		const encoding = (headers['content-encoding'] as string) ?? ''
		let stream: NodeJS.ReadableStream = proxyRes
		if (encoding === 'gzip') stream = proxyRes.pipe(createGunzip())
		else if (encoding === 'deflate') stream = proxyRes.pipe(createInflate())
		else if (encoding === 'br') stream = proxyRes.pipe(createBrotliDecompress())

		const chunks: Buffer[] = []
		for await (const chunk of stream) chunks.push(Buffer.from(chunk))
		let body = Buffer.concat(chunks).toString('utf8')

		// Script injected at the top of <head> — intercepts fetch/XHR/WebSocket so that
		// root-relative API calls (/api/..., /Users/..., etc.) get the /proxy/:appId prefix.
		// This is necessary because JS apps often construct URLs from window.location.origin
		// without knowing they're behind a path-based reverse proxy.
		const escapedPrefix = JSON.stringify(prefix) // safely quoted for inline JS
		const injectScript =
			`<script>(function(){` +
			`var p=${escapedPrefix};` +
			`function rw(u){if(typeof u==='string'&&u.charCodeAt(0)===47&&u.charCodeAt(1)!==47&&!u.startsWith(p))return p+u;return u;}` +
			`var oF=window.fetch;window.fetch=function(u,i){return oF.call(this,rw(u),i);};` +
			`var oX=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){var a=Array.from(arguments);a[1]=rw(a[1]);return oX.apply(this,a);};` +
			`var oW=window.WebSocket;` +
			`window.WebSocket=function(u,q){if(typeof u==='string'&&u.charCodeAt(0)===47)u=(location.protocol==='https:'?'wss:':'ws:')+'//'+(location.host)+rw(u);return q?new oW(u,q):new oW(u);};` +
			`Object.assign(window.WebSocket,oW);window.WebSocket.prototype=oW.prototype;` +
			`})();</script>`

		// Inject before the first <head> tag (or prepend if none)
		if (/<head[\s>]/i.test(body)) {
			body = body.replace(/<head([\s>])/i, `<head$1${injectScript}`)
		} else {
			body = injectScript + body
		}

		// Rewrite root-relative paths in HTML attributes so static assets load via the proxy.
		// (?!\/|proxy\/) skips protocol-relative (//...) and already-proxied (/proxy/...) paths.
		body = body.replace(
			/((?:href|src|action|poster|data-src|data-href)=["'])\/(?!\/|proxy\/)/g,
			`$1${prefix}/`,
		)
		// CSS url() — quoted and unquoted variants
		body = body.replace(/(\burl\(["']?)\/(?!\/|proxy\/)/g, `$1${prefix}/`)

		delete headers['content-encoding'] // we decompressed
		delete headers['content-length'] // body size changed
		delete headers['content-security-policy'] // would block our injected script

		res.writeHead(proxyRes.statusCode!, headers)
		res.end(body)
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
