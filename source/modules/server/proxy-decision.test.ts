import { describe, it, expect } from 'vitest'
import {
	isRefererRequiredRootPath,
	getRootAbsoluteProxyAppId,
} from './index.js'

describe('isRefererRequiredRootPath', () => {
	describe('should return true for ambiguous UI paths', () => {
		it('/assets/foo.js', () => {
			expect(isRefererRequiredRootPath('/assets/foo.js')).toBe(true)
		})
		it('/assets/', () => {
			expect(isRefererRequiredRootPath('/assets/')).toBe(true)
		})
		it('/_app/bar.js', () => {
			expect(isRefererRequiredRootPath('/_app/bar.js')).toBe(true)
		})
		it('/static/baz.css', () => {
			expect(isRefererRequiredRootPath('/static/baz.css')).toBe(true)
		})
		it('/nodes/1.js', () => {
			expect(isRefererRequiredRootPath('/nodes/1.js')).toBe(true)
		})
		it('/manifest.json', () => {
			expect(isRefererRequiredRootPath('/manifest.json')).toBe(true)
		})
		it('/favicon.ico', () => {
			expect(isRefererRequiredRootPath('/favicon.ico')).toBe(true)
		})
		it('/favicon.png', () => {
			expect(isRefererRequiredRootPath('/favicon.png')).toBe(true)
		})
		it('/robots.txt', () => {
			expect(isRefererRequiredRootPath('/robots.txt')).toBe(true)
		})
		it('/sw.js', () => {
			expect(isRefererRequiredRootPath('/sw.js')).toBe(true)
		})
		it('/service-worker.js', () => {
			expect(isRefererRequiredRootPath('/service-worker.js')).toBe(true)
		})
	})

	describe('should return false for non-ambiguous app paths', () => {
		it('/api/v1/models', () => {
			expect(isRefererRequiredRootPath('/api/v1/models')).toBe(false)
		})
		it('/ws/stream', () => {
			expect(isRefererRequiredRootPath('/ws/stream')).toBe(false)
		})
		it('/socket.io/socket.io.js', () => {
			expect(isRefererRequiredRootPath('/socket.io/socket.io.js')).toBe(false)
		})
		it('/ollama/api/generate', () => {
			expect(isRefererRequiredRootPath('/ollama/api/generate')).toBe(false)
		})
		it('/models/list', () => {
			expect(isRefererRequiredRootPath('/models/list')).toBe(false)
		})
	})
})

describe('getRootAbsoluteProxyAppId', () => {
	describe('ambiguous path + referer', () => {
		it('returns refererAppId', () => {
			const result = getRootAbsoluteProxyAppId('/assets/foo.js', 'open-webui', 'jellyfin', 'home-assistant')
			expect(result).toBe('open-webui')
		})
	})

	describe('ambiguous path + cookie but no referer', () => {
		it('returns undefined (not cookie)', () => {
			const result = getRootAbsoluteProxyAppId('/assets/foo.js', undefined, 'open-webui', undefined)
			expect(result).toBe(undefined)
		})
	})

	describe('ambiguous path + recent but no referer', () => {
		it('returns undefined', () => {
			const result = getRootAbsoluteProxyAppId('/assets/foo.js', undefined, undefined, 'open-webui')
			expect(result).toBe(undefined)
		})
	})

	describe('non-ambiguous path + referer', () => {
		it('returns refererAppId (takes precedence)', () => {
			const result = getRootAbsoluteProxyAppId('/api/v1/models', 'open-webui', 'jellyfin', 'home-assistant')
			expect(result).toBe('open-webui')
		})
	})

	describe('non-ambiguous path + cookie but no referer', () => {
		it('returns cookieAppId', () => {
			const result = getRootAbsoluteProxyAppId('/api/v1/models', undefined, 'jellyfin', undefined)
			expect(result).toBe('jellyfin')
		})
	})

	describe('non-ambiguous path + recent but no referer/cookie', () => {
		it('returns recentAppId', () => {
			const result = getRootAbsoluteProxyAppId('/api/v1/models', undefined, undefined, 'home-assistant')
			expect(result).toBe('home-assistant')
		})
	})

	describe('non-ambiguous path + no fallbacks', () => {
		it('returns undefined', () => {
			const result = getRootAbsoluteProxyAppId('/api/v1/models', undefined, undefined, undefined)
			expect(result).toBe(undefined)
		})
	})

	describe('ambiguous path + all fallbacks', () => {
		it('returns only referer (ignores cookie/recent)', () => {
			const result = getRootAbsoluteProxyAppId('/assets/foo.js', 'open-webui', 'jellyfin', 'home-assistant')
			expect(result).toBe('open-webui')
		})
	})

	describe('critical bug fix: ambiguous assets path without referer returns undefined even with cookie', () => {
		it('/assets/index.js without referer returns undefined even with cookie', () => {
			const result = getRootAbsoluteProxyAppId('/assets/index.js', undefined, 'open-webui', undefined)
			expect(result).toBe(undefined)
		})
	})
})