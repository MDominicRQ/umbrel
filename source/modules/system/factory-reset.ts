import type Umbreld from '../../index.js'

// Docker-safe stub: factory reset is not supported in containers (remove the volume instead)
export async function performReset(): Promise<void> {
	return
}

// Docker-safe stub: rugix state paths (/run/rugix/mounts/data/state) don't exist in Docker
export async function cleanupFactoryResetBackups(_umbreld: Umbreld): Promise<void> {
	return
}
