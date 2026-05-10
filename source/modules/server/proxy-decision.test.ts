import { describe, it, expect } from 'vitest'
import {
	isRefererRequiredRootPath,
	getRootAbsoluteProxyAppId,
	isImmutableChunkPath,
	isUmbrelReservedRootPath,
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

describe('isImmutableChunkPath', () => {
	it('returns true for /_app/immutable/chunks/foo.js', () => {
		expect(isImmutableChunkPath('/_app/immutable/chunks/foo.js')).toBe(true)
	})
	it('returns true for /_app/immutable/entry/start.js', () => {
		expect(isImmutableChunkPath('/_app/immutable/entry/start.js')).toBe(true)
	})
	it('returns true for /_app/immutable', () => {
		expect(isImmutableChunkPath('/_app/immutable')).toBe(true)
	})
	it('returns false for /_app/foo.js', () => {
		expect(isImmutableChunkPath('/_app/foo.js')).toBe(false)
	})
	it('returns false for /_app/immutable/../chunks/foo.js', () => {
		expect(isImmutableChunkPath('/_app/immutable/../chunks/foo.js')).toBe(false)
	})
})

describe('getRootAbsoluteProxyAppId with immutable chunks', () => {
	it('returns cookieAppId for /_app/immutable/chunks/foo.js when no referer', () => {
		const result = getRootAbsoluteProxyAppId(
			'/_app/immutable/chunks/foo.js',
			undefined,
			'open-webui',
			undefined,
		)
		expect(result).toBe('open-webui')
	})
	it('returns recentAppId for /_app/immutable/entry/start.js when no referer or cookie', () => {
		const result = getRootAbsoluteProxyAppId(
			'/_app/immutable/entry/start.js',
			undefined,
			undefined,
			'open-webui',
		)
		expect(result).toBe('open-webui')
	})
	it('returns refererAppId for /_app/immutable/chunks/foo.js when referer present', () => {
		const result = getRootAbsoluteProxyAppId(
			'/_app/immutable/chunks/foo.js',
			'jellyfin',
			'open-webui',
			undefined,
		)
		expect(result).toBe('jellyfin')
	})
})

describe('isRefererRequiredRootPath — unchanged behavior', () => {
	it('still returns true for /_app/foo.js (non-immutable)', () => {
		expect(isRefererRequiredRootPath('/_app/foo.js')).toBe(true)
	})
	it('still returns true for /_app (root)', () => {
		expect(isRefererRequiredRootPath('/_app')).toBe(true)
	})
	it('still returns true for /assets/foo.js', () => {
		expect(isRefererRequiredRootPath('/assets/foo.js')).toBe(true)
	})
})

describe('isUmbrelReservedRootPath', () => {
	describe('should return true for Umbrel dashboard paths', () => {
		it('/', () => {
			expect(isUmbrelReservedRootPath('/')).toBe(true)
		})
		it('/trpc', () => {
			expect(isUmbrelReservedRootPath('/trpc')).toBe(true)
		})
		it('/trpc/query', () => {
			expect(isUmbrelReservedRootPath('/trpc/query')).toBe(true)
		})
		it('/manager-api', () => {
			expect(isUmbrelReservedRootPath('/manager-api')).toBe(true)
		})
		it('/api/files', () => {
			expect(isUmbrelReservedRootPath('/api/files')).toBe(true)
		})
		it('/api/debug', () => {
			expect(isUmbrelReservedRootPath('/api/debug')).toBe(true)
		})
		it('/app-store', () => {
			expect(isUmbrelReservedRootPath('/app-store')).toBe(true)
		})
		it('/settings', () => {
			expect(isUmbrelReservedRootPath('/settings')).toBe(true)
		})
		it('/widgets', () => {
			expect(isUmbrelReservedRootPath('/widgets')).toBe(true)
		})
		it('/wallpaper', () => {
			expect(isUmbrelReservedRootPath('/wallpaper')).toBe(true)
		})
		it('/login', () => {
			expect(isUmbrelReservedRootPath('/login')).toBe(true)
		})
		it('/logout', () => {
			expect(isUmbrelReservedRootPath('/logout')).toBe(true)
		})
		it('/locales/en.json', () => {
			expect(isUmbrelReservedRootPath('/locales/en.json')).toBe(true)
		})
		it('/assets/index.js', () => {
			expect(isUmbrelReservedRootPath('/assets/index.js')).toBe(true)
		})
		it('/assets/', () => {
			expect(isUmbrelReservedRootPath('/assets/')).toBe(true)
		})
	})

	describe('should return false for app routes', () => {
		it('/admin/setup', () => {
			expect(isUmbrelReservedRootPath('/admin/setup')).toBe(false)
		})
		it('/admin/js/vendor.js', () => {
			expect(isUmbrelReservedRootPath('/admin/js/vendor.js')).toBe(false)
		})
		it('/lovelace/default_view', () => {
			expect(isUmbrelReservedRootPath('/lovelace/default_view')).toBe(false)
		})
		it('/api/websocket', () => {
			expect(isUmbrelReservedRootPath('/api/websocket')).toBe(false)
		})
		it('/web/', () => {
			expect(isUmbrelReservedRootPath('/web/')).toBe(false)
		})
		it('/manifest.json', () => {
			expect(isUmbrelReservedRootPath('/manifest.json')).toBe(false)
		})
		it('/_app/immutable/chunks/foo.js', () => {
			expect(isUmbrelReservedRootPath('/_app/immutable/chunks/foo.js')).toBe(false)
		})
		it('/nodes/1.js', () => {
			expect(isUmbrelReservedRootPath('/nodes/1.js')).toBe(false)
		})
		it('/ws', () => {
			expect(isUmbrelReservedRootPath('/ws')).toBe(false)
		})
		it('/socket.io/', () => {
			expect(isUmbrelReservedRootPath('/socket.io/')).toBe(false)
		})
	})
})