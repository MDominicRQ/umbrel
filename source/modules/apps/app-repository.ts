import type Umbreld from '../../index.js'

type RepositoryApp = {
	id: string
	name: string
	icon: string
	version: string
	installed: boolean
}

export default class AppRepository {
	umbreld: Umbreld
	url: string
	path: string

	constructor(umbreld: Umbreld, repoUrl: string) {
		this.umbreld = umbreld
		this.url = repoUrl
		this.path = ''
	}

	async getApps(): Promise<RepositoryApp[]> {
		// App repository is not available in Docker
		return []
	}

	async getApp(id: string): Promise<RepositoryApp | null> {
		// App repository is not available in Docker
		return null
	}

	async getCategories(): Promise<string[]> {
		return []
	}

	async readRegistry() {
		return { apps: [], url: this.url }
	}

	async update() {
		return true
	}
}
