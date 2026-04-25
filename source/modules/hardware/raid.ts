import crypto from 'node:crypto'
import os from 'node:os'
import {setTimeout} from 'node:timers/promises'

import fse from 'fs-extra'
import {$} from 'execa'
import pRetry from 'p-retry'
import prettyBytes from 'pretty-bytes'

import type Umbreld from '../../index.js'
import FileStore from '../utilities/file-store.js'
import {reboot} from '../system/system.js'
import {setSystemStatus} from '../system/routes.js'
import runEvery from '../utilities/run-every.js'

async function getDeviceSize(device: string): Promise<number> {
	const {stdout} = await $`lsblk --output SIZE --bytes --nodeps --noheadings ${device}`
	return parseInt(stdout.trim(), 10)
}

export function getRoundedDeviceSize(sizeInBytes: number): number {
	const twoFiftyGigabytes = 250_000_000_000
	const oneTerabyte = 1_000_000_000_000
	const twentyFiveGigabytes = 25_000_000_000
	if (sizeInBytes >= oneTerabyte) return Math.floor(sizeInBytes / twoFiftyGigabytes) * twoFiftyGigabytes
	if (sizeInBytes >= twoFiftyGigabytes) return Math.floor(sizeInBytes / twentyFiveGigabytes) * twentyFiveGigabytes
	return sizeInBytes
}

export type RaidType = 'storage' | 'failsafe'
export type Topology = 'stripe' | 'raidz' | 'mirror'

export type ExpansionStatus = {
	state: 'expanding' | 'finished' | 'canceled'
	progress: number
}

export type FailsafeTransitionStatus = {
	state: 'syncing' | 'rebooting' | 'rebuilding' | 'complete' | 'error'
	progress: number
	error?: string
}

export type RebuildStatus = {
	state: 'rebuilding' | 'finished' | 'canceled'
	progress: number
}

export type FailsafeMirrorTransitionPair = {
	existingDeviceId: string
	newDeviceId: string
}

export type ReplaceStatus = {
	state: 'rebuilding' | 'expanding' | 'finished' | 'canceled'
	progress: number
}

type AcceleratorConfig = {
	devices: string[]
}

type State = 'ONLINE' | 'DEGRADED' | 'FAULTED' | 'OFFLINE' | 'UNAVAIL' | 'REMOVED' | 'CANT_OPEN'
type Vdev = {
	vdev_type: 'root' | 'raidz' | 'mirror' | 'disk' | 'file'
	path?: string
	rep_dev_size?: number
	phys_space?: number
	slow_ios?: number
	name: string
	guid: number
	class: 'normal' | 'special' | 'l2cache' | string
	parent?: string
	state: State
	alloc_space: number
	total_space: number
	def_space: number
	read_errors: number
	write_errors: number
	checksum_errors: number
}
type ScanStats = {
	function: 'SCRUB' | 'RESILVER'
	state: 'SCANNING' | 'FINISHED' | 'CANCELED'
	start_time: number
	end_time: number
	to_examine: number
	examined: number
	skipped: number
	processed: number
	errors: number
	bytes_per_scan: number
	pass_start: number
	scrub_pause: number
	scrub_spent_paused: number
	issued_bytes_per_scan: number
	issued: number
}
type RaidzExpandStats = {
	name: string
	state: 'SCANNING' | 'FINISHED' | 'CANCELED'
	expanding_vdev: number
	start_time: number
	end_time: number
	to_reflow: number
	reflowed: number
	waiting_for_resilver: number
}
type Pool = {
	name: string
	state: State
	pool_guid: number
	txg: number
	spa_version: number
	zpl_version: number
	error_count: number
	status?: string
	action?: string
	msgid?: string
	moreinfo?: string
	scan_stats?: ScanStats
	raidz_expand_stats?: RaidzExpandStats
	vdevs: Record<string, Vdev>
}
type ZpoolStatusOutput = {
	output_version: {
		command: string
		vers_major: number
		vers_minor: number
	}
	pools: Record<string, Pool>
}

type AcceleratorPoolDevice = {
	id: string
	status: State
	l2arcPartition: string
	l2arcSize: number
	specialPartition: string
	specialSize: number
}

type ParsedAccelerator = {
	devices: AcceleratorPoolDevice[]
	totalL2arcSize: number
	totalSpecialUsableSize: number
}

type ConfigStore = {
	user?: {
		name: string
		hashedPassword?: string
		password?: string
		language: string
	}
	raid?: {
		poolName: string
		state: 'normal' | 'transitioning-to-failsafe'
		devices: string[]
		raidType: RaidType
		accelerator?: AcceleratorConfig
	}
}

export default class Raid {
	#umbreld: Umbreld
	logger: Umbreld['logger']
	configStore: FileStore<ConfigStore>
	isTransitioningToFailsafe = false
	isReplacing = false
	failsafeTransitionStatus?: FailsafeTransitionStatus
	replaceStatus?: ReplaceStatus
	initialRaidSetupError?: Error
	poolNameBase = 'umbrelos'
	temporaryDevicePath = '/tmp/umbrelos-temporary-migration-device.img'
	#lastExpansionProgress = 0
	#lastRebuildProgress = 0
	#stopPoolMonitor?: () => void
	#lastEmittedExpansion?: ExpansionStatus
	#lastEmittedRebuild?: RebuildStatus
	#lastEmittedReplace?: ReplaceStatus

	constructor(umbreld: Umbreld) {
		this.#umbreld = umbreld
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(`hardware:${name.toLowerCase()}`)

		const configPartition = '/run/rugix/mounts/config'
		const configFile = `${configPartition}/umbrel.yaml`
		this.configStore = new FileStore<ConfigStore>({
			filePath: configFile,
			onBeforeWrite: () => $`mount -o remount,rw ${configPartition}`,
			onAfterWrite: () =>
				pRetry(() => $`mount -o remount,ro ${configPartition}`, {
					retries: 5,
					factor: 1.1,
					minTimeout: 100,
				}).catch((error) => {
					this.logger.error('Failed to remount config partition read-only', error)
				}),
		})
	}

	async hasConfigStore() {
		return await fse.pathExists(this.configStore.filePath)
	}

	generatePoolName(): string {
		const suffix = crypto.randomBytes(4).toString('hex')
		return `${this.poolNameBase}-${suffix}`
	}

	async start() {
		this.logger.log('Starting RAID')

		try {
			const totalMemory = os.totalmem()
			const arcMin = Math.max(32 * 1024 * 1024, Math.floor(totalMemory / 64))
			await fse.writeFile('/sys/module/zfs/parameters/zfs_arc_min', String(arcMin))
			this.logger.log(`Set ZFS ARC min to ${prettyBytes(arcMin)}`)
		} catch (error) {
			this.logger.error('Failed to set ZFS ARC min', error)
		}

		try {
			await fse.writeFile('/sys/module/zfs/parameters/l2arc_exclude_special', '1')
			this.logger.log('Set ZFS l2arc_exclude_special to 1')
		} catch (error) {
			this.logger.error('Failed to set ZFS l2arc_exclude_special', error)
		}

		try {
			this.#startPoolMonitor()
		} catch (error) {
			this.logger.error('Failed to start pool monitor', error)
		}

		await this.handlePostBootRaidSetupProcess().catch((error) =>
			this.logger.error('Failed to handle initial RAID setup boot', error),
		)

		await this.#updateConfigDevicePaths().catch((error) => {
			this.logger.error('Failed to update RAID config device paths', error)
		})

		await this.#completeFailsafeTransition().catch((error) => {
			this.logger.error('Failed to complete FailSafe transition:', error)
		})
	}

	async stop() {
		this.logger.log('Stopping RAID')
		this.#stopPoolMonitor?.()
	}

	async #updateConfigDevicePaths(): Promise<void> {
		const status = await this.getStatus()
		if (!status.exists || status.status !== 'ONLINE') return

		const devices = status.devices!.map((device) => `/dev/disk/by-umbrel-id/${device.id}`)
		await this.configStore.set('raid.devices', devices)

		if (status.accelerator?.devices) {
			const acceleratorDevices = status.accelerator.devices.map((device) => `/dev/disk/by-umbrel-id/${device.id}`)
			await this.configStore.set('raid.accelerator.devices', acceleratorDevices)
		}
	}

	async #completeFailsafeTransition(): Promise<void> {
		const raidState = await this.configStore.get('raid.state')
		if (raidState !== 'transitioning-to-failsafe') return

		const pool = await this.getStatus()
		const previousPoolName = `${pool.name}-previous-migration`

		const previousPool = await this.getPoolStatus(previousPoolName)
		if (!previousPool.exists) {
			this.logger.error('Config indicates transition in progress but previous pool not found')
			return
		}

		this.logger.log('Failsafe transition detected, finishing off migration')
		this.isTransitioningToFailsafe = true

		this.failsafeTransitionStatus = {state: 'rebuilding', progress: 50}
		this.#umbreld.eventBus.emit('raid:failsafe-transition-progress', this.failsafeTransitionStatus)

		try {
			const oldDevice = previousPool.devices?.[0]?.id
			if (!oldDevice) throw new Error('Could not determine old device from previous migration pool')
			const oldDevicePath = `/dev/disk/by-umbrel-id/${oldDevice}`
			this.logger.log(`Old device: ${oldDevice}`)

			this.logger.log('Destroying previous migration pool')
			await $`zpool destroy ${previousPoolName}`

			this.logger.log(`Partitioning old device: ${oldDevice}`)
			const {dataPartition: oldDataPartition} = await this.#partitionDevice(oldDevicePath)

			this.logger.log('Replacing temp device with old device in pool')
			await $`zpool replace -f ${pool.name} ${this.temporaryDevicePath} ${oldDataPartition}`

			this.logger.log('Updating RAID config')
			await this.configStore.getWriteLock(async ({set}) => {
				const pool = await this.getStatus()
				const devices = pool.devices!.map((device) => `/dev/disk/by-umbrel-id/${device.id}`)
				const raid = await this.configStore.get('raid')
				await set('raid', {
					...raid,
					raidType: 'failsafe',
					devices,
					state: 'normal',
				})
			})

			this.logger.log('Monitoring rebuild progress...')
			while (true) {
				try {
					const status = await this.getPoolStatus(pool.name)
					if (status.rebuild) {
						const scaledProgress = 51 + Math.floor((status.rebuild.progress / 100) * 48)
						const cappedProgress = Math.min(scaledProgress, 99)
						if (cappedProgress > (this.failsafeTransitionStatus?.progress ?? 0)) {
							this.failsafeTransitionStatus = {state: 'rebuilding', progress: cappedProgress}
							this.logger.log(`Rebuild progress: ${cappedProgress}%`)
							this.#umbreld.eventBus.emit('raid:failsafe-transition-progress', this.failsafeTransitionStatus)
						}
						if (status.rebuild.state === 'finished') {
							this.failsafeTransitionStatus = {state: 'complete', progress: 100}
							this.logger.log('Rebuild progress: 100%')
							this.#umbreld.eventBus.emit('raid:failsafe-transition-progress', this.failsafeTransitionStatus)
							break
						}
					}
				} catch (error) {
					this.logger.error('Error polling rebuild progress', error)
				}
				await setTimeout(1000)
			}

			this.logger.log('Migration to failsafe mode complete')
		} catch (error) {
			this.failsafeTransitionStatus = {state: 'error', progress: 0, error: (error as Error).message}
			this.#umbreld.eventBus.emit('raid:failsafe-transition-progress', this.failsafeTransitionStatus)
			throw error
		} finally {
			this.logger.log('Cleaning up leftover snapshots')
			await $`zfs destroy -r ${pool.name}@migration`.catch((error) =>
				this.logger.error('Failed to destroy migration snapshot', error),
			)
			await $`zfs destroy -r ${pool.name}@migration-final`.catch((error) =>
				this.logger.error('Failed to destroy migration final snapshot', error),
			)

			this.isTransitioningToFailsafe = false
		}
	}

	#startPoolMonitor() {
		this.#stopPoolMonitor = runEvery(
			'1 second',
			async () => {
				try {
					const pool = await this.getStatus()

					if (pool.expansion) {
						const last = this.#lastEmittedExpansion
						if (last?.state !== pool.expansion.state || last?.progress !== pool.expansion.progress) {
							this.#lastEmittedExpansion = pool.expansion
							this.#umbreld.eventBus.emit('raid:expansion-progress', pool.expansion)
						}
					}

					if (pool.rebuild) {
						const last = this.#lastEmittedRebuild
						if (last?.state !== pool.rebuild.state || last?.progress !== pool.rebuild.progress) {
							this.#lastEmittedRebuild = pool.rebuild
							this.#umbreld.eventBus.emit('raid:rebuild-progress', pool.rebuild)
						}
					}
				} catch {
				}
			},
			{runInstantly: true},
		)
	}

	async getStatus() {
		const name = await this.configStore.get('raid.poolName')
		const status = await this.getPoolStatus(name)

		return {
			name,
			...status,
			replace: this.replaceStatus,
			failsafeTransitionStatus: this.failsafeTransitionStatus,
			status:
				this.failsafeTransitionStatus?.state === 'rebuilding' && status.status === 'DEGRADED'
					? 'ONLINE'
					: status.status,
		}
	}

	async getPoolStatus(poolName: string): Promise<{
		exists: boolean
		raidType?: RaidType
		totalSpace?: number
		usableSpace?: number
		usedSpace?: number
		freeSpace?: number
		status?: State
		devices?: Array<{
			id: string
			status: State
			readErrors: number
			writeErrors: number
			checksumErrors: number
		}>
		mirrors?: string[][]
		topology?: Topology
		accelerator?: {
			exists: boolean
			l2arcSize?: number
			specialSize?: number
			devices?: Array<{
				id: string
				status: State
			}>
		}
		expansion?: ExpansionStatus
		rebuild?: RebuildStatus
	}> {
		const pool = await this.#getZpoolStatus(poolName)
		if (!pool) return {exists: false}

		const vdevs = Object.values(pool.vdevs)
		const isDataVdev = (vdev: Vdev) => vdev.class === 'normal'
		const dataVdevs = vdevs.filter(isDataVdev)

		const isRaidz = dataVdevs.some((v) => v.vdev_type === 'raidz')
		const isMirror = dataVdevs.some((v) => v.vdev_type === 'mirror')
		const raidType = isRaidz || isMirror ? 'failsafe' : 'storage'
		let topology: Topology = 'stripe'
		if (isRaidz) topology = 'raidz'
		if (isMirror) topology = 'mirror'

		const rootVdev = dataVdevs.find((v) => v.vdev_type === 'root')
		const diskVdevs = dataVdevs.filter((v) => v.vdev_type === 'disk')
		const fileVdevs = dataVdevs.filter((v) => v.vdev_type === 'file')
		const mirrorVdevs = dataVdevs.filter((v) => v.vdev_type === 'mirror')
		if (!rootVdev) return {exists: false}

		let expansion: ExpansionStatus | undefined
		if (pool.raidz_expand_stats) {
			const stats = pool.raidz_expand_stats
			const stateMap = {SCANNING: 'expanding', FINISHED: 'finished', CANCELED: 'canceled'} as const
			const state = stateMap[stats.state]

			let progress: number
			if (state === 'finished' || state === 'canceled') {
				this.#lastExpansionProgress = 0
				progress = state === 'finished' ? 100 : 0
			} else {
				const rawProgress = stats.to_reflow > 0 ? Math.floor((stats.reflowed / stats.to_reflow) * 100) : 0
				const cappedProgress = Math.min(rawProgress, 99)
				progress = Math.max(cappedProgress, this.#lastExpansionProgress)
				this.#lastExpansionProgress = progress
			}

			expansion = {state, progress}
		}

		let rebuild: RebuildStatus | undefined
		if (pool.scan_stats?.function === 'RESILVER') {
			const stats = pool.scan_stats
			const stateMap = {SCANNING: 'rebuilding', FINISHED: 'finished', CANCELED: 'canceled'} as const
			const state = stateMap[stats.state]

			let progress: number
			if (state === 'finished' || state === 'canceled') {
				this.#lastRebuildProgress = 0
				progress = state === 'finished' ? 100 : 0
			} else {
				const rawProgress = stats.to_examine > 0 ? Math.floor((stats.issued / stats.to_examine) * 100) : 0
				const cappedProgress = Math.min(rawProgress, 99)
				progress = Math.max(cappedProgress, this.#lastRebuildProgress)
				this.#lastRebuildProgress = progress
			}

			rebuild = {state, progress}
		}

		const toDeviceId = (path: string) => path.replace('/dev/disk/by-umbrel-id/', '').replace(/-part\d+$/, '')

		const devices = diskVdevs.map((device) => ({
			id: toDeviceId(device.path!),
			size: device.phys_space,
			status: device.state,
			readErrors: device.read_errors,
			writeErrors: device.write_errors,
			checksumErrors: device.checksum_errors,
		}))

		const accelerator = this.#parsePoolAccelerator(pool)
		const acceleratorDevices = accelerator.devices.map(({id, status}) => ({id, status}))
		const hasAccelerator = acceleratorDevices.length > 0

		let mirrors: string[][] | undefined
		if (isMirror) {
			const membersByMirrorVdev = new Map<string, string[]>()

			for (const diskVdev of diskVdevs) {
				const mirrorVdevName = diskVdev.parent
				if (!mirrorVdevName) continue
				const members = membersByMirrorVdev.get(mirrorVdevName) ?? []
				members.push(toDeviceId(diskVdev.path!))
				membersByMirrorVdev.set(mirrorVdevName, members)
			}

			mirrors = mirrorVdevs
				.map((mirrorVdev) => (membersByMirrorVdev.get(mirrorVdev.name) ?? []).sort())
				.filter((mirror) => mirror.length > 0)
				.sort((a, b) => a.join(',').localeCompare(b.join(',')))
		}

		let totalSpace = rootVdev.total_space
		let usableSpace = rootVdev.def_space
		let usedSpace = rootVdev.alloc_space
		if (isRaidz && diskVdevs.length > 2) {
			let numberOfDevices = diskVdevs.length + fileVdevs.length

			const isReplacing = [...diskVdevs, ...fileVdevs].some((vdev) => vdev.parent?.includes('replacing'))
			if (isReplacing) numberOfDevices -= 1

			const smallestDeviceSize = Math.min(...devices.map((d) => d.size).filter((size) => size !== undefined))
			usableSpace = smallestDeviceSize * (numberOfDevices - 1)

			totalSpace = [...diskVdevs, ...fileVdevs]
				.filter((vdev) => !(vdev.state === 'CANT_OPEN' && vdev.parent?.includes('replacing')))
				.reduce((sum, vdev) => sum + (vdev.phys_space || vdev.rep_dev_size || 0), 0)

			const usedPercentage = rootVdev.alloc_space / totalSpace
			usedSpace = Math.ceil(usableSpace * usedPercentage)
		}

		if (isRaidz && diskVdevs.length <= 2) usedSpace /= 2

		if (isMirror) totalSpace = devices.reduce((sum, device) => sum + (device.size ?? 0), 0)

		return {
			exists: true,
			raidType,
			topology,
			totalSpace,
			usableSpace,
			usedSpace,
			freeSpace: usableSpace - usedSpace,
			status: pool.state,
			devices,
			mirrors,
			accelerator: {
				exists: hasAccelerator,
				l2arcSize: accelerator.totalL2arcSize,
				specialSize: accelerator.totalSpecialUsableSize,
				devices: acceleratorDevices,
			},
			expansion,
			rebuild,
		}
	}

	async #getZpoolStatus(poolName: string): Promise<Pool | undefined> {
		try {
			const {stdout} = await $`zpool status --json --json-int --json-flat-vdevs ${poolName}`
			const zpoolStatus = JSON.parse(stdout) as ZpoolStatusOutput
			return zpoolStatus.pools?.[poolName]
		} catch {
			return undefined
		}
	}

	#parsePoolAccelerator(pool: Pool): ParsedAccelerator {
		const toDeviceId = (path: string) => path.replace('/dev/disk/by-umbrel-id/', '').replace(/-part\d+$/, '')
		const getVdevSize = (vdev: Vdev) => vdev.phys_space || vdev.rep_dev_size || vdev.total_space || 0
		const vdevs = Object.values(pool.vdevs)
		const cacheVdevs = vdevs.filter((v) => v.vdev_type === 'disk' && v.class === 'l2cache' && v.path)
		const specialVdevs = vdevs.filter((v) => v.vdev_type === 'disk' && v.class === 'special' && v.path)

		const specialByDeviceId = new Map(specialVdevs.map((v) => [toDeviceId(v.path!), v]))

		const devices: AcceleratorPoolDevice[] = cacheVdevs
			.map((cacheVdev) => {
				const id = toDeviceId(cacheVdev.path!)
				const specialVdev = specialByDeviceId.get(id)
				if (!specialVdev) return undefined

				let status: State = cacheVdev.state
				if (specialVdev.state !== 'ONLINE') status = specialVdev.state

				return {
					id,
					status,
					l2arcPartition: cacheVdev.path!,
					l2arcSize: getVdevSize(cacheVdev),
					specialPartition: specialVdev.path!,
					specialSize: getVdevSize(specialVdev),
				}
			})
			.filter((d): d is AcceleratorPoolDevice => d !== undefined)
			.sort((a, b) => a.id.localeCompare(b.id))

		return {
			devices,
			totalL2arcSize: devices.reduce((sum, d) => sum + d.l2arcSize, 0),
			totalSpecialUsableSize: devices.length === 0 ? 0 : Math.min(...devices.map((d) => d.specialSize)),
		}
	}

	async triggerInitialRaidSetupBootFlow(
		raidDevices: string[],
		raidType: RaidType,
		acceleratorDevices: string[] | undefined,
		user: {name: string; password: string; language: string},
	) {
		await this.setup(raidDevices, raidType, acceleratorDevices)

		await this.configStore.set('user', user)

		setTimeout(1000).then(() => reboot())

		return true
	}

	async handlePostBootRaidSetupProcess() {
		const raidConfigUser = await this.configStore.get('user')
		const userExists = await this.#umbreld.user.exists()
		if (raidConfigUser?.name && raidConfigUser?.password && !userExists) {
			this.logger.log('Detected first boot after RAID setup, creating user')
			try {
				await this.#umbreld.user.register(raidConfigUser.name, raidConfigUser.password, raidConfigUser.language ?? 'en')

				await this.configStore
					.delete('user.password')
					.catch((error) => this.logger.error('Failed to delete password from RAID config', error))
			} catch (error) {
				this.logger.error('Failed to create user', error)
				this.initialRaidSetupError = error as Error
			}
		}
	}

	async checkInitialRaidSetupStatus(): Promise<boolean> {
		if (this.initialRaidSetupError) throw this.initialRaidSetupError

		const pool = await this.getStatus()
		if (!pool.exists) return false

		const userExists = await this.#umbreld.user.exists()
		if (!userExists) return false

		if (!this.#umbreld.appStore.attemptedInitialAppStoreUpdate) return false

		return true
	}

	async checkRaidMountFailure(): Promise<boolean> {
		return fse.pathExists('/run/rugix/mounts/data/.rugix/data-mount-error.log')
	}

	async checkRaidMountFailureDevices(): Promise<Array<{name: string; isOk: boolean}>> {
		const {stdout} = await $`zpool import -N -d /dev/disk/by-umbrel-id`
		const expectedDevices = ((await this.configStore.get('raid.devices')) ?? []) as string[]

		return expectedDevices.map((device) => {
			const name = device.replace('/dev/disk/by-umbrel-id/', '')
			const isOk = stdout.split('\n').some((line) => line.includes(name) && line.includes('ONLINE'))
			return {name, isOk}
		})
	}

	async #partitionDevice(device: string): Promise<{statePartition: string; dataPartition: string}> {
		const isDiskById = device.startsWith('/dev/disk/by-umbrel-id/')
		if (!isDiskById) throw new Error('Must pass disk by id')

		this.logger.log(`Wiping signatures from ${device}`)
		await $`wipefs --all ${device}`

		this.logger.log(`Creating partition table on ${device}`)
		await $`sgdisk --zap-all ${device}`

		const oneMiB = 1024 * 1024

		const bufferSizeBytes = 10 * oneMiB

		const statePartitionSizeBytes = 100 * oneMiB

		const deviceSize = await getDeviceSize(device)
		const roundedDeviceSize = getRoundedDeviceSize(deviceSize)

		const dataPartitionSizeBytes = roundedDeviceSize - statePartitionSizeBytes - bufferSizeBytes

		const statePartitionSizeMiB = Math.floor(statePartitionSizeBytes / oneMiB)
		const dataPartitionSizeMiB = Math.floor(dataPartitionSizeBytes / oneMiB)

		this.logger.log(
			`Device size: ${deviceSize} bytes, rounded: ${roundedDeviceSize} bytes, data partition: ${dataPartitionSizeBytes} bytes (${dataPartitionSizeMiB} MiB)`,
		)

		this.logger.log(`Creating state partition (${statePartitionSizeMiB} MiB) on ${device}`)
		await $`sgdisk --new=1:0:+${statePartitionSizeMiB}M --change-name=1:umbrel-raid-state ${device}`

		this.logger.log(`Creating data partition (${dataPartitionSizeMiB} MiB) on ${device}`)
		await $`sgdisk --new=2:0:+${dataPartitionSizeMiB}M --change-name=2:umbrel-raid-data ${device}`

		const statePartition = `${device}-part1`
		const dataPartition = `${device}-part2`

		this.logger.log(`Waiting for partitions to appear on ${device}`)
		await $`udevadm settle`

		const partitionsExist = await Promise.all([fse.pathExists(statePartition), fse.pathExists(dataPartition)])
		if (!partitionsExist[0]) throw new Error(`State partition ${statePartition} does not exist`)
		if (!partitionsExist[1]) throw new Error(`Data partition ${dataPartition} does not exist`)

		this.logger.log(`Successfully partitioned ${device}`)
		return {statePartition, dataPartition}
	}

	async #partitionAcceleratorDevice(
		device: string,
		sizes?: {l2arcSizeBytes: number; specialSizeBytes: number},
	): Promise<{statePartition: string; l2arcPartition: string; specialPartition: string}> {
		const isDiskById = device.startsWith('/dev/disk/by-umbrel-id/')
		if (!isDiskById) throw new Error('Must pass disk by id')

		this.logger.log(`Wiping signatures from accelerator device ${device}`)
		await $`wipefs --all ${device}`

		this.logger.log(`Creating partition table on accelerator device ${device}`)
		await $`sgdisk --zap-all ${device}`

		const oneMiB = 1024 * 1024
		const bufferSizeBytes = 10 * oneMiB
		const statePartitionSizeBytes = 100 * oneMiB

		const deviceSize = await getDeviceSize(device)
		const roundedDeviceSize = getRoundedDeviceSize(deviceSize)
		const usableBytes = roundedDeviceSize - statePartitionSizeBytes - bufferSizeBytes
		if (usableBytes <= 0) throw new Error('Accelerator device is too small to partition')

		const requestedL2arcSizeBytes =
			sizes?.l2arcSizeBytes ?? Math.floor(Math.min(roundedDeviceSize * 0.5, os.totalmem() * 5))
		const l2arcSizeBytes = requestedL2arcSizeBytes
		if (l2arcSizeBytes <= 0) throw new Error('Accelerator device is too small for an L2ARC partition')

		const specialSizeBytes = sizes?.specialSizeBytes ?? usableBytes - l2arcSizeBytes
		if (specialSizeBytes <= 0) throw new Error('Accelerator device is too small for a special partition')
		if (l2arcSizeBytes + specialSizeBytes > usableBytes)
			throw new Error('Accelerator device is too small for the requested partition sizes')

		const statePartitionSizeMiB = Math.floor(statePartitionSizeBytes / oneMiB)
		const l2arcPartitionSizeMiB = Math.floor(l2arcSizeBytes / oneMiB)
		const specialPartitionSizeMiB = Math.floor(specialSizeBytes / oneMiB)

		this.logger.log(
			`Accelerator size: ${deviceSize} bytes, rounded: ${roundedDeviceSize} bytes, l2arc: ${l2arcSizeBytes} bytes (${l2arcPartitionSizeMiB} MiB), special: ${specialSizeBytes} bytes (${specialPartitionSizeMiB} MiB)`,
		)

		await $`sgdisk --new=1:0:+${statePartitionSizeMiB}M --change-name=1:umbrel-raid-accelerator-state ${device}`
		await $`sgdisk --new=2:0:+${l2arcPartitionSizeMiB}M --change-name=2:umbrel-raid-l2arc ${device}`
		await $`sgdisk --new=3:0:+${specialPartitionSizeMiB}M --change-name=3:umbrel-raid-special ${device}`

		const statePartition = `${device}-part1`
		const l2arcPartition = `${device}-part2`
		const specialPartition = `${device}-part3`

		this.logger.log(`Waiting for accelerator partitions to appear on ${device}`)
		await $`udevadm settle`

		const partitionsExist = await Promise.all([
			fse.pathExists(statePartition),
			fse.pathExists(l2arcPartition),
			fse.pathExists(specialPartition),
		])
		if (!partitionsExist[0]) throw new Error(`State partition ${statePartition} does not exist`)
		if (!partitionsExist[1]) throw new Error(`L2ARC partition ${l2arcPartition} does not exist`)
		if (!partitionsExist[2]) throw new Error(`Special partition ${specialPartition} does not exist`)

		this.logger.log(`Successfully partitioned accelerator device ${device}`)
		return {statePartition, l2arcPartition, specialPartition}
	}

	async #createPool(poolName: string, dataPartitions: string[], topology: Topology): Promise<void> {
		let vdevSpec = dataPartitions
		if (topology === 'raidz') {
			vdevSpec = ['raidz1', ...dataPartitions]
		} else if (topology === 'mirror') {
			vdevSpec = []
			for (let i = 0; i < dataPartitions.length; i += 2) {
				vdevSpec.push('mirror', dataPartitions[i], dataPartitions[i + 1])
			}
		}

		this.logger.log(`Creating ZFS pool '${poolName}' (${topology}) with partitions: ${dataPartitions.join(', ')}`)
		await $`zpool create -f -o ashift=12 -o autotrim=on -o autoexpand=on -o cachefile=none -m none ${poolName} ${vdevSpec}`
		this.logger.log(`ZFS pool '${poolName}' created successfully`)
	}

	async #createDataset(poolName: string): Promise<void> {
		const defaultEncryptionPassword = 'umbrelumbrel'

		this.logger.log(`Creating data dataset on pool '${poolName}'`)
		await $({
			input: defaultEncryptionPassword,
		})`zfs create -o encryption=aes-256-gcm -o keyformat=passphrase -o keylocation=prompt -o mountpoint=legacy -o compression=lz4 -o atime=off -o xattr=sa -o acltype=posixacl ${poolName}/data`
		this.logger.log(`Encrypted dataset created successfully`)
	}

	async setup(deviceIds: string[], raidType: RaidType, acceleratorDeviceIds?: string[]): Promise<boolean> {
		if (!(await this.#umbreld.hardware.umbrelPro.isUmbrelPro()))
			throw new Error('RAID is currently only supported on Umbrel Pro hardware')
		if (deviceIds.length === 0) throw new Error('At least one device is required')
		if (raidType === 'failsafe' && deviceIds.length < 2) throw new Error('Failsafe mode requires at least two devices')

		const devices = deviceIds.map((id) => `/dev/disk/by-umbrel-id/${id}`)
		for (const device of devices) {
			if (!(await fse.pathExists(device))) throw new Error(`Device not found: ${device}`)
		}
		this.logger.log(`Setting up RAID with ${devices.length} device(s): ${devices.join(', ')}`)

		const internalDevices = await this.#umbreld.hardware.internalStorage.getDevices()
		const selectedDeviceTypes = deviceIds.map((id) => internalDevices.find((device) => device.id === id)?.type)
		if (selectedDeviceTypes.some((deviceType) => deviceType === undefined))
			throw new Error('Could not determine device type for selected devices')
		const uniqueDeviceTypes = [...new Set(selectedDeviceTypes)]
		if (uniqueDeviceTypes.length > 1) throw new Error('Cannot mix SSDs and HDDs in the same RAID array')
		const [deviceType] = uniqueDeviceTypes
		if (!deviceType) throw new Error('Could not determine device type for selected devices')

		if (raidType === 'failsafe' && deviceType === 'hdd' && deviceIds.length % 2 !== 0)
			throw new Error('HDD failsafe mode requires an even number of devices')

		if (acceleratorDeviceIds?.length) {
			if (deviceType !== 'hdd') throw new Error('Accelerators are only supported for HDD RAID arrays')

			const expectedCount = raidType === 'failsafe' ? 2 : 1
			if (acceleratorDeviceIds.length !== expectedCount)
				throw new Error(
					raidType === 'failsafe'
						? 'Failsafe mode requires exactly two SSDs for the accelerator'
						: 'Storage mode requires exactly one SSD for the accelerator',
				)

			const uniqueAcceleratorDeviceIds = new Set(acceleratorDeviceIds)
			if (uniqueAcceleratorDeviceIds.size !== acceleratorDeviceIds.length)
				throw new Error('Accelerator devices must be unique')

			const raidDeviceIds = new Set(deviceIds)
			for (const acceleratorDeviceId of acceleratorDeviceIds) {
				const acceleratorDevice = `/dev/disk/by-umbrel-id/${acceleratorDeviceId}`
				if (!(await fse.pathExists(acceleratorDevice))) throw new Error(`Device not found: ${acceleratorDevice}`)
				if (raidDeviceIds.has(acceleratorDeviceId)) throw new Error('Cannot add a RAID data device as an accelerator')
				await this.#assertAcceleratorDeviceType(acceleratorDeviceId)
			}
		}

		const poolName = this.generatePoolName()
		this.logger.log(`Generated unique pool name: ${poolName}`)

		this.logger.log(`Partitioning ${devices.length} device(s) concurrently`)
		const partitionResults = await Promise.all(devices.map((device) => this.#partitionDevice(device)))
		const dataPartitions = partitionResults.map((result) => result.dataPartition)
		this.logger.log(`All devices partitioned successfully`)

		let topology: Topology = 'stripe'
		if (raidType === 'failsafe' && deviceType === 'ssd') topology = 'raidz'
		if (raidType === 'failsafe' && deviceType === 'hdd') topology = 'mirror'

		await this.#createPool(poolName, dataPartitions, topology)
		await this.#createDataset(poolName)

		this.logger.log(`Writing RAID config to config partition`)
		await this.configStore.set('raid', {poolName, state: 'normal', raidType, devices})

		if (acceleratorDeviceIds?.length) await this.addAccelerator(acceleratorDeviceIds)

		this.logger.log('RAID setup complete')
		return true
	}

	async #assertDeviceTypeMatchesPool(deviceId: string): Promise<void> {
		const devices = await this.#umbreld.hardware.internalStorage.getDevices()
		const pool = await this.getStatus()
		const poolDeviceId = pool.devices?.[0]?.id
		if (!poolDeviceId) throw new Error("RAID array doesn't exist or has no devices")
		const newDevice = devices.find((d) => d.id === deviceId)
		const poolDevice = devices.find((d) => d.id === poolDeviceId)
		if (!newDevice) throw new Error(`Device not found: ${deviceId}`)
		if (!poolDevice) throw new Error(`Device not found: ${poolDeviceId}`)
		if (newDevice.type !== poolDevice.type) throw new Error(`Cannot mix SSDs and HDDs in the same RAID array`)
	}

	async #getPoolDeviceType(): Promise<'ssd' | 'hdd'> {
		const pool = await this.getStatus()
		const poolDeviceId = pool.devices?.[0]?.id
		if (!poolDeviceId) throw new Error("RAID array doesn't exist or has no devices")
		const devices = await this.#umbreld.hardware.internalStorage.getDevices()
		const device = devices.find((d) => d.id === poolDeviceId)
		if (!device) throw new Error(`Device not found: ${poolDeviceId}`)
		return device.type
	}

	async #getDeviceInfo(deviceId: string) {
		const devices = await this.#umbreld.hardware.internalStorage.getDevices()
		const device = devices.find((d) => d.id === deviceId)
		if (!device) throw new Error(`Device not found: ${deviceId}`)
		return device
	}

	async #assertAcceleratorDeviceType(deviceId: string): Promise<void> {
		const device = await this.#getDeviceInfo(deviceId)
		if (device.type !== 'ssd') throw new Error('Accelerator devices must be SSDs')
	}

	async addDevice(deviceId: string): Promise<boolean> {
		const pool = await this.getStatus()
		if (!pool.exists) throw new Error("RAID array doesn't exist")
		if (pool.topology === 'mirror')
			throw new Error('addDevice is not supported for mirror failsafe mode, use addMirror')
		if (pool.topology !== 'stripe' && pool.topology !== 'raidz')
			throw new Error(`Unsupported RAID topology for addDevice: ${pool.topology}`)

		const poolDeviceIds = pool.devices?.map((d) => d.id) ?? []
		const device = `/dev/disk/by-umbrel-id/${deviceId}`

		if (!(await fse.pathExists(device))) throw new Error(`Device not found: ${device}`)
		if (poolDeviceIds.includes(deviceId)) throw new Error('Cannot add a device that is already in the RAID array')
		await this.#assertDeviceTypeMatchesPool(deviceId)

		this.logger.log(`Adding device to RAID array: ${device}`)

		this.logger.log(`Partitioning device ${device}`)
		const {dataPartition} = await this.#partitionDevice(device)

		if (pool.topology === 'raidz') {
			this.logger.log(`Attaching ${dataPartition} to raidz1-0 in pool '${pool.name}'`)
			await $`zpool attach -f ${pool.name} raidz1-0 ${dataPartition}`
		} else {
			this.logger.log(`Adding ${dataPartition} as stripe to pool '${pool.name}'`)
			await $`zpool add -f ${pool.name} ${dataPartition}`
		}

		const updatedDevices = [...poolDeviceIds.map((id) => `/dev/disk/by-umbrel-id/${id}`), device]
		this.logger.log(`Updating RAID config with ${updatedDevices.length} device(s)`)
		await this.configStore.set('raid.devices', updatedDevices)

		this.logger.log(`Device added to RAID array successfully`)
		return true
	}

	async addMirror(deviceIds: [string, string]): Promise<boolean> {
		const pool = await this.getStatus()
		if (!pool.exists) throw new Error("RAID array doesn't exist")
		if (pool.topology !== 'mirror') throw new Error('addMirror is only supported for mirror failsafe mode')

		if (deviceIds[0] === deviceIds[1]) throw new Error('Mirror pair requires two different devices')

		const poolDeviceIds = pool.devices?.map((d) => d.id) ?? []
		const devices = deviceIds.map((id) => `/dev/disk/by-umbrel-id/${id}`)

		for (const deviceId of deviceIds) {
			const device = `/dev/disk/by-umbrel-id/${deviceId}`
			if (!(await fse.pathExists(device))) throw new Error(`Device not found: ${device}`)
			if (poolDeviceIds.includes(deviceId)) throw new Error('Cannot add a device that is already in the RAID array')
			await this.#assertDeviceTypeMatchesPool(deviceId)
		}

		this.logger.log(`Adding mirror pair to RAID array: ${devices.join(', ')}`)

		this.logger.log(`Partitioning mirror pair devices: ${devices.join(', ')}`)
		const partitionResults = await Promise.all(devices.map((device) => this.#partitionDevice(device)))
		const [leftPartition, rightPartition] = partitionResults.map((result) => result.dataPartition)

		this.logger.log(`Adding mirror pair (${leftPartition}, ${rightPartition}) to pool '${pool.name}'`)
		await $`zpool add -f ${pool.name} mirror ${leftPartition} ${rightPartition}`

		const updatedDevices = [...poolDeviceIds.map((id) => `/dev/disk/by-umbrel-id/${id}`), ...devices]
		this.logger.log(`Updating RAID config with ${updatedDevices.length} device(s)`)
		await this.configStore.set('raid.devices', updatedDevices)

		this.logger.log(`Mirror pair added to RAID array successfully`)
		return true
	}

	async addAccelerator(deviceIds: string[]): Promise<boolean> {
		const pool = await this.getStatus()
		if (!pool.exists) throw new Error("RAID array doesn't exist")
		if ((await this.#getPoolDeviceType()) !== 'hdd')
			throw new Error('Accelerators are only supported for HDD RAID arrays')
		if (pool.accelerator?.exists) throw new Error('RAID array already has an accelerator')

		const expectedCount = pool.raidType === 'failsafe' ? 2 : 1
		if (deviceIds.length !== expectedCount)
			throw new Error(
				pool.raidType === 'failsafe'
					? 'Failsafe mode requires exactly two SSDs for the accelerator'
					: 'Storage mode requires exactly one SSD for the accelerator',
			)

		const uniqueDeviceIds = new Set(deviceIds)
		if (uniqueDeviceIds.size !== deviceIds.length) throw new Error('Accelerator devices must be unique')

		const poolDeviceIds = new Set(pool.devices?.map((d) => d.id) ?? [])
		const acceleratorDevices = deviceIds.map((id) => `/dev/disk/by-umbrel-id/${id}`)

		for (const deviceId of deviceIds) {
			const device = `/dev/disk/by-umbrel-id/${deviceId}`
			if (!(await fse.pathExists(device))) throw new Error(`Device not found: ${device}`)
			if (poolDeviceIds.has(deviceId)) throw new Error('Cannot add a RAID data device as an accelerator')
			await this.#assertAcceleratorDeviceType(deviceId)
		}

		this.logger.log(`Adding accelerator to RAID array: ${acceleratorDevices.join(', ')}`)

		const partitionResults = await Promise.all(
			acceleratorDevices.map((device) => this.#partitionAcceleratorDevice(device)),
		)
		const l2arcPartitions = partitionResults.map((result) => result.l2arcPartition)
		const specialPartitions = partitionResults.map((result) => result.specialPartition)

		await $`zpool add -f ${pool.name} cache ${l2arcPartitions}`
		if (pool.raidType === 'failsafe') {
			await $`zpool add -f ${pool.name} special mirror ${specialPartitions[0]} ${specialPartitions[1]}`
		} else {
			await $`zpool add -f ${pool.name} special ${specialPartitions[0]}`
		}

		await this.configStore.set('raid.accelerator', {devices: acceleratorDevices})

		this.logger.log(`Accelerator added to RAID array successfully`)
		return true
	}
}
