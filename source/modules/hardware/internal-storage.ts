import fse from 'fs-extra'
import nodePath from 'node:path'

import {$} from 'execa'

import type Umbreld from '../../index.js'
import {getRoundedDeviceSize} from './raid.js'

function kelvinToCelsius(kelvin: number): number {
	return kelvin - 273
}

export type SsdDevice = {
	type: 'ssd'
	transport: 'nvme' | 'sata'
	device: string
	id?: string
	pciSlotNumber?: number
	slot?: number
	name: string
	model: string
	serial: string
	size: number
	roundedSize: number
	temperature?: number
	temperatureWarning?: number
	temperatureCritical?: number
	lifetimeUsed?: number
	smartStatus: 'healthy' | 'unhealthy' | 'unknown'
}

export type HddDevice = {
	type: 'hdd'
	transport: 'sata'
	device: string
	id?: string
	slot?: number
	name: string
	model: string
	serial: string
	size: number
	roundedSize: number
	temperature?: number
	smartStatus: 'healthy' | 'unhealthy' | 'unknown'
}

export type StorageDevice = SsdDevice | HddDevice

type SmartData = {
	temperature?: number
	temperatureWarning?: number
	temperatureCritical?: number
	lifetimeUsed?: number
	smartStatus: 'healthy' | 'unhealthy' | 'unknown'
}

async function getSmartData(devicePath: string): Promise<SmartData> {
	try {
		const {stdout} = await $({reject: false})`smartctl -a ${devicePath} --json`
		const data = JSON.parse(stdout)

		let temperature: number | undefined
		if (typeof data.temperature?.current === 'number') {
			temperature = data.temperature.current
		}

		let lifetimeUsed: number | undefined
		if (typeof data.nvme_smart_health_information_log?.percentage_used === 'number') {
			lifetimeUsed = data.nvme_smart_health_information_log.percentage_used
		}

		const smartStatus = data.smart_status?.passed === false ? 'unhealthy' : 'healthy'

		return {temperature, lifetimeUsed, smartStatus}
	} catch {
		return {smartStatus: 'unknown'}
	}
}

async function getNvmeTemperatureThresholds(
	devicePath: string,
): Promise<{temperatureWarning?: number; temperatureCritical?: number}> {
	try {
		const {stdout} = await $`nvme id-ctrl ${devicePath} --output-format=json`
		const idCtrlData = JSON.parse(stdout)

		let temperatureWarning: number | undefined
		let temperatureCritical: number | undefined
		if (typeof idCtrlData.wctemp === 'number' && idCtrlData.wctemp > 0) {
			temperatureWarning = kelvinToCelsius(idCtrlData.wctemp)
		}
		if (typeof idCtrlData.cctemp === 'number' && idCtrlData.cctemp > 0) {
			temperatureCritical = kelvinToCelsius(idCtrlData.cctemp)
		}

		return {temperatureWarning, temperatureCritical}
	} catch {
		return {}
	}
}

async function getDeviceId(deviceName: string): Promise<string | undefined> {
	const byIdDir = '/dev/disk/by-umbrel-id'
	try {
		const entries = await fse.readdir(byIdDir)
		const matchingIds: string[] = []

		for (const entry of entries) {
			try {
				if (/-part\d+$/.test(entry)) continue

				const fullPath = nodePath.join(byIdDir, entry)
				const target = await fse.readlink(fullPath)
				const resolvedTarget = nodePath.resolve(byIdDir, target)

				if (resolvedTarget === `/dev/${deviceName}`) matchingIds.push(entry)
			} catch {
			}
		}

		if (matchingIds.length === 0) return undefined

		matchingIds.sort((a, b) => a.localeCompare(b))
		return matchingIds[0]
	} catch {
	}
	return undefined
}

async function getDevicePciSlotNumber(deviceName: string): Promise<number | undefined> {
	try {
		const controllerName = deviceName.replace(/n\d+$/, '')
		const sysfsPath = `/sys/class/nvme/${controllerName}/device`

		const devicePath = await fse.realpath(sysfsPath)

		const match = devicePath.match(/(0000:00:[0-9a-f]+\.[0-9a-f]+)\//)
		if (!match) return undefined

		const rootPortAddress = match[1]

		const {stdout} = await $`lspci -vvs ${rootPortAddress}`
		const slotMatch = stdout.match(/Slot #(\d+)/)
		if (slotMatch) return parseInt(slotMatch[1], 10)
	} catch {
	}
	return undefined
}

export async function getInternalStorageDevices(): Promise<StorageDevice[]> {
	type LsBlkDevice = {
		name: string
		model?: string
		serial?: string
		size?: number
		type?: string
		tran?: string
		rota?: boolean
	}

	const {stdout} = await $`lsblk --output NAME,MODEL,SERIAL,SIZE,TYPE,TRAN,ROTA --json --bytes`
	const {blockdevices} = JSON.parse(stdout) as {blockdevices: LsBlkDevice[]}

	const supportedTransports = ['nvme', 'sata']
	const internalBlockDevices = blockdevices.filter(
		(device) => device.type === 'disk' && supportedTransports.includes(device.tran ?? ''),
	)

	const devices: StorageDevice[] = await Promise.all(
		internalBlockDevices.map(async (device): Promise<StorageDevice> => {
			const devicePath = `/dev/${device.name}`
			const id = await getDeviceId(device.name).catch(() => undefined)
			const size = device.size ?? 0
			const isNvme = device.tran === 'nvme'
			const name = device.model?.trim() ?? (isNvme ? 'Unknown NVMe Device' : 'Unknown SATA Device')
			const model = device.model?.trim() ?? 'Unknown'
			const serial = device.serial?.trim() ?? 'Unknown'
			const roundedSize = getRoundedDeviceSize(size)
			const [smartData, temperatureThresholds, pciSlotNumber] = await Promise.all([
				getSmartData(devicePath),
				isNvme
					? getNvmeTemperatureThresholds(devicePath)
					: ({} as {temperatureWarning?: number; temperatureCritical?: number}),
				isNvme ? getDevicePciSlotNumber(device.name).catch(() => undefined) : undefined,
			])

			const isSsd = isNvme || device.rota === false

			if (isSsd) {
				return {
					type: 'ssd' as const,
					transport: device.tran as 'nvme' | 'sata',
					device: device.name,
					id,
					pciSlotNumber,
					name,
					model,
					serial,
					size,
					roundedSize,
					temperature: smartData.temperature,
					temperatureWarning: temperatureThresholds.temperatureWarning,
					temperatureCritical: temperatureThresholds.temperatureCritical,
					lifetimeUsed: smartData.lifetimeUsed,
					smartStatus: smartData.smartStatus,
				}
			}

			return {
				type: 'hdd' as const,
				transport: 'sata' as const,
				device: device.name,
				id,
				name,
				model,
				serial,
				size,
				roundedSize,
				temperature: smartData.temperature,
				smartStatus: smartData.smartStatus,
			}
		}),
	)

	return devices.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''))
}

export default class InternalStorage {
	#umbreld: Umbreld
	logger: Umbreld['logger']

	constructor(umbreld: Umbreld) {
		this.#umbreld = umbreld
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(`hardware:${name.toLowerCase()}`)
	}

	async start() {
		this.logger.log('Starting internal storage')
	}

	async stop() {
		this.logger.log('Stopping internal storage')
	}

	async getDevices(): Promise<StorageDevice[]> {
		let devices = await getInternalStorageDevices()

		if (await this.#umbreld.hardware.umbrelPro.isUmbrelPro()) {
			const ssdDevices = devices.filter((device) => device.type === 'ssd')
			const otherDevices = devices.filter((device) => device.type !== 'ssd')
			devices = [
				...ssdDevices.map((device) => ({
					...device,
					slot: this.#umbreld.hardware.umbrelPro.getSsdSlotFromPciSlotNumber(device.pciSlotNumber),
				})),
				...otherDevices,
			]
		}

		const haveMissingSlots = devices.some((device) => device.slot === undefined)
		if (!haveMissingSlots) devices.sort((a, b) => a.slot! - b.slot!)

		return devices
	}
}
