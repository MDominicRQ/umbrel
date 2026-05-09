import { describe, it, expect } from 'vitest'
import { rewriteContent } from './index.js'

describe('rewriteContent', () => {
	describe('standard attribute rewriting (existing)', () => {
		it('rewrites href /assets/foo.js', () => {
			const body = '<a href="/assets/foo.js">'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<a href="/proxy/open-webui/assets/foo.js">')
		})
		it('rewrites src /_app/immutable/chunks/foo.js', () => {
			const body = '<img src="/_app/immutable/chunks/foo.png">'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<img src="/proxy/open-webui/_app/immutable/chunks/foo.png">')
		})
		it('does not rewrite /proxy/open-webui/_app/...', () => {
			const body = '<a href="/proxy/open-webui/_app/foo.js">'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<a href="/proxy/open-webui/_app/foo.js">')
		})
	})

	describe('inline <script type="module"> dynamic imports', () => {
		it('rewrites import "/_app/..." in module script', () => {
			const body = '<script type="module">import "/_app/immutable/chunks/foo.js"</script>'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<script type="module">import "/proxy/open-webui/_app/immutable/chunks/foo.js"</script>')
		})
		it('rewrites import { bar } from "/_app/..." in module script', () => {
			const body = '<script type="module">import { bar } from "/_app/immutable/chunks/foo.js"</script>'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<script type="module">import { bar } from "/proxy/open-webui/_app/immutable/chunks/foo.js"</script>')
		})
		it('rewrites double-quoted import in module script', () => {
			const body = '<script type="module">import "/_app/immutable/entry/start.js"</script>'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<script type="module">import "/proxy/open-webui/_app/immutable/entry/start.js"</script>')
		})
		it('does not rewrite already-proxied import "/proxy/..."', () => {
			const body = '<script type="module">import "/proxy/open-webui/_app/immutable/chunks/foo.js"</script>'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<script type="module">import "/proxy/open-webui/_app/immutable/chunks/foo.js"</script>')
		})
		it('does not rewrite external import "https://..."', () => {
			const body = '<script type="module">import "https://cdn.example.com/foo.js"</script>'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<script type="module">import "https://cdn.example.com/foo.js"</script>')
		})
		it('does not rewrite relative import "./foo.js"', () => {
			const body = '<script type="module">import "./foo.js"</script>'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<script type="module">import "./foo.js"</script>')
		})
		it('handles multiple imports in one script block', () => {
			const body = '<script type="module">import "/_app/immutable/chunks/a.js";import "/_app/immutable/chunks/b.js"</script>'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<script type="module">import "/proxy/open-webui/_app/immutable/chunks/a.js";import "/proxy/open-webui/_app/immutable/chunks/b.js"</script>')
		})
		it('handles template literal import', () => {
			const body = '<script type="module">import `/_app/immutable/chunks/foo.js`</script>'
			const result = rewriteContent(body, '/proxy/open-webui')
			expect(result).toBe('<script type="module">import `/proxy/open-webui/_app/immutable/chunks/foo.js`</script>')
		})
	})
})
