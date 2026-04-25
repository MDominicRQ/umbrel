export type ProgressStatus = 'pending' | 'installing' | 'running' | 'stopping' | 'updating' | 'migrating' | 'backing-up' | 'restoring' | 'resetting'

export type AppSettings = {
	bitcoinP2pPort?: number
	bitcoinRpcPort?: number
	lndPort?: number
	lndRestPort?: number
}

export type AppManifest = {
	id: string
	name: string
	version: string
	permissions?: string[]
	required Ports?: number[]
	readonly?: boolean
	architecture?: string[]
	category?: string
	handleMigration?: boolean
	dependencies?: string[]
	widgets?: Array<{
		id: string
		name: string
		description: string
		endpoint: string
		filePath?: string
	}>
}

export function validateManifest(manifest: AppManifest): AppManifest {
	if (!manifest.id) throw new Error('App manifest is missing the "id" property')
	if (!manifest.name) throw new Error('App manifest is missing the "name" property')
	if (!manifest.version) throw new Error('App manifest is missing the "version" property')
	if (typeof manifest.id !== 'string') throw new Error('App manifest "id" must be a string')
	if (typeof manifest.name !== 'string') throw new Error('App manifest "name" must be a string')
	if (typeof manifest.version !== 'string') throw new Error('App manifest "version" must be a string')
	return manifest
}
