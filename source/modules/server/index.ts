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
	#appProxyCache = new Map<string, ReturnType<typeof createProxyMiddleware>>()
	#appTargetCache = new Map<string, string>()

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

	// Resolve the correct proxy target for an app:
	// - Apps WITH app_proxy service: target is the app_proxy container
	// - Apps WITHOUT app_proxy service: target is the app's main service container directly
	async #resolveAppTarget(appId: string): Promise<string> {
		if (this.#appTargetCache.has(appId)) {
			return this.#appTargetCache.get(appId)!
		}

		const app = this.umbreld.apps.getApp(appId)
		const {port} = await app.readManifest()
		let target = `http://app_proxy_${appId}:${port}`

		try {
			const compose = await app.readCompose()
			const services = Object.keys(compose.services ?? {})
			const hasAppProxy = services.includes('app_proxy')

			if (!hasAppProxy) {
				const systemServices = new Set(['app_proxy', 'tor_proxy', 'i2p_daemon'])
				const mainService = services.find((s) => !systemServices.has(s)) ?? services[0]
				if (mainService) {
					target = `http://${appId}_${mainService}_1:${port}`
				}
			}
		} catch {
			// compose unreadable, fall back to app_proxy target
		}

		this.#appTargetCache.set(appId, target)
		return target
	}

	#getAppProxy(target: string) {
		if (!this.#appProxyCache.has(target)) {
			this.#appProxyCache.set(
				target,
				createProxyMiddleware({
					target,
					changeOrigin: true,
					on: {
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
		return this.#appProxyCache.get(target)!
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

		// Add dynamic connectSrc based on reverse proxy headers
		this.app.use((request, response, next) => {
			const forwardedHost = request.headers['x-forwarded-host']
			const forwardedProto = request.headers['x-forwarded-proto']
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

		this.server?.on('upgrade', async (request, socket, head) => {
			try {
				const {pathname, searchParams} = new URL(`https://localhost${request.url}`)

				// Proxy WebSocket upgrades for installed apps
				const appProxyMatch = pathname.match(/^\/proxy\/([^/]+)/)
				if (appProxyMatch) {
					const appId = appProxyMatch[1]
					try {
						const target = await this.#resolveAppTarget(appId)
						const proxy = this.#getAppProxy(target)
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

		// Reverse proxy for installed apps: /proxy/:appId/* → app container
		this.app.use('/proxy/:appId', async (request, response, next) => {
			const {appId} = request.params
			try {
				const target = await this.#resolveAppTarget(appId)
				this.#getAppProxy(target)(request, response, next)
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
