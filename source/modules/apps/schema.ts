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
}

export interface validateManifest {
	manifest: AppManifest
}
