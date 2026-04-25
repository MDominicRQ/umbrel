import type Umbreld from '../../index.js'

type DeviceInfo = {
	manufacturer: string
	model: string
	serial: string
	deviceId: string
}

export default class Device {
	umbreld: Umbreld
	logger: Umbreld['logger']

	constructor(umbreld: Umbreld) {
		this.umbreld = umbreld
		const { name } = this.constructor
		this.logger = umbreld.logger.createChildLogger(name.toLowerCase())
	}

	async getInfo(): Promise<DeviceInfo> {
		// Device info is not available in Docker
		return {
			manufacturer: 'Unknown',
			model: 'Docker',
			serial: '00000000',
			deviceId: 'docker',
		}
	}

	async isOnline(): Promise<boolean> {
		return true
	}

	async start(): Promise<void> {
		this.logger.log('Device: skipped (not applicable in Docker)')
	}

	async stop(): Promise<void> {}

	async getIdentity(): Promise<{ manufacturer: string; model: string; deviceId: string }> {
		return {
			manufacturer: 'Docker',
			model: 'Container',
			deviceId: 'docker',
		}
	}

	async getSpecs(): Promise<{ cpu: string; memory: string; storage: string }> {
		return {
			cpu: 'Docker',
			memory: 'Docker',
			storage: 'Docker',
		}
	}
}
