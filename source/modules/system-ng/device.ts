import type Umbreld from '../../index.js'

type DeviceInfo = {
	manufacturer: string
	model: string
	serial: string
	deviceId: string
}

export default class Device {
	umbreld: Umbreld

	constructor(umbreld: Umbreld) {
		this.umbreld = umbreld
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
}
