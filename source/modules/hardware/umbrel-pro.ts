import {open} from 'node:fs/promises'
import {setTimeout} from 'node:timers/promises'

import PQueue from 'p-queue'

import type Umbreld from '../../index.js'
import runEvery from '../utilities/run-every.js'
import {detectDevice} from '../system/system.js'

// Docker-incompatible: EC access via /dev/port not available in Docker
const IS_DOCKER = !require('fs').existsSync('/dev/port')

const EC_STATUS_COMMAND_PORT_ADDRESS = 0x66
const EC_DATA_PORT_ADDRESS = 0x62

const EC_INPUT_BUFFER_FULL_VALUE = 0x02

async function readPort(port: number): Promise<number> {
	const fd = await open('/dev/port', 'r')
	try {
		const buffer = new Uint8Array(1)
		await fd.read(buffer, 0, 1, port)
		return buffer[0]
	} finally {
		await fd.close()
	}
}

async function writePort(port: number, value: number): Promise<void> {
	const fd = await open('/dev/port', 'r+')
	try {
		const buffer = new Uint8Array([value & 0xff])
		await fd.write(buffer, 0, 1, port)
	} finally {
		await fd.close()
	}
}

async function waitForEcReady(): Promise<void> {
	for (let i = 0; i < 20_000; i++) {
		const status = await readPort(EC_STATUS_COMMAND_PORT_ADDRESS)
		if ((status & EC_INPUT_BUFFER_FULL_VALUE) === 0) return
		await setTimeout(0)
	}
	throw new Error('EC timeout waiting for input buffer to clear')
}

async function writeEcRegister(register: number, value: number): Promise<void> {
	const EC_WRITE_COMMAND_VALUE = 0x81
	await waitForEcReady()
	await writePort(EC_STATUS_COMMAND_PORT_ADDRESS, EC_WRITE_COMMAND_VALUE)
	await waitForEcReady()
	await writePort(EC_DATA_PORT_ADDRESS, register)
	await waitForEcReady()
	await writePort(EC_DATA_PORT_ADDRESS, value & 0xff)
}

async function readEcRegister(register: number): Promise<number> {
	const EC_READ_COMMAND_VALUE = 0x80
	await waitForEcReady()
	await writePort(EC_STATUS_COMMAND_PORT_ADDRESS, EC_READ_COMMAND_VALUE)
	await waitForEcReady()
	await writePort(EC_DATA_PORT_ADDRESS, register)
	await waitForEcReady()
	return readPort(EC_DATA_PORT_ADDRESS)
}

export default class UmbrelPro {
	#umbreld: Umbreld
	#ecRegisterCommandQueue = new PQueue({concurrency: 1})
	#stopManagingFan?: () => void
	#lastFanSpeed?: number
	logger: Umbreld['logger']
	#isDocker: boolean

	constructor(umbreld: Umbreld) {
		this.#umbreld = umbreld
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(`hardware:${name.toLowerCase()}`)
		// Docker-incompatible: /dev/port not available in Docker
		this.#isDocker = IS_DOCKER
	}

	async isUmbrelPro(): Promise<boolean> {
		const {productName} = await detectDevice()
		return productName === 'Umbrel Pro'
	}

	async start() {
		if (!(await this.isUmbrelPro())) return

		// Docker-incompatible: EC registers not accessible in Docker
		if (this.#isDocker) {
			this.logger.log('Starting Umbrel Pro (EC access unavailable in Docker, fan management disabled)')
			return
		}

		this.logger.log('Starting Umbrel Pro')

		this.logger.log('Setting LED to default state')
		await this.setLedDefault().catch((error) => this.logger.error('Failed to set LED to default state', error))

		this.logger.log('Clearing min fan speed')
		await this.setMinFanSpeed(0).catch((error) => this.logger.error('Failed to clear min fan speed', error))

		this.logger.log('Starting fan speed management')
		this.#stopManagingFan = runEvery('1 minute', () => this.#manageFanSpeed())
	}

	async stop() {
		this.logger.log('Stopping Umbrel Pro')
		this.#stopManagingFan?.()
	}

	async #writeEcRegister(register: number, value: number): Promise<void> {
		// Docker-incompatible: EC register access not available in Docker
		if (this.#isDocker) throw new Error('EC register access not available in Docker')
		if (!(await this.isUmbrelPro())) throw new Error('Refusing to write EC register on non Umbrel Pro hardware')
		return this.#ecRegisterCommandQueue.add(async () => writeEcRegister(register, value))
	}

	async #readEcRegister(register: number): Promise<number> {
		// Docker-incompatible: EC register access not available in Docker
		if (this.#isDocker) throw new Error('EC register access not available in Docker')
		if (!(await this.isUmbrelPro())) throw new Error('Refusing to read EC register on non Umbrel Pro hardware')
		return this.#ecRegisterCommandQueue.add(async () => readEcRegister(register)) as Promise<number>
	}

	async #manageFanSpeed(): Promise<void> {
		const FAN_MIN_TEMP = 50
		const FAN_DEFAULT_WARNING_TEMP = 70

		try {
			const allDevices = await this.#umbreld.hardware.internalStorage.getDevices()
			const devices = allDevices.filter((device) => device.type === 'ssd')

			const deviceFanSpeeds = devices.map((device) => {
				if (device.temperature === undefined) return {device, fanSpeed: 0}

				const warningTemp = device.temperatureWarning ?? FAN_DEFAULT_WARNING_TEMP

				if (device.temperature <= FAN_MIN_TEMP) return {device, fanSpeed: 0}

				if (device.temperature >= warningTemp) return {device, fanSpeed: 100}

				const tempRange = warningTemp - FAN_MIN_TEMP
				const tempAboveMin = device.temperature - FAN_MIN_TEMP
				return {device, fanSpeed: Math.round((tempAboveMin / tempRange) * 100)}
			})

			const highest = deviceFanSpeeds.reduce((max, current) => (current.fanSpeed > max.fanSpeed ? current : max))

			const lastFanSpeed = this.#lastFanSpeed ?? 0
			const shouldIncrease = highest.fanSpeed > lastFanSpeed
			const shouldDecrease = highest.fanSpeed <= lastFanSpeed - 5 || (highest.fanSpeed === 0 && lastFanSpeed !== 0)
			if (shouldIncrease || shouldDecrease) {
				await this.setMinFanSpeed(highest.fanSpeed)
				this.#lastFanSpeed = highest.fanSpeed
				this.logger.log(
					`Min fan speed set to ${highest.fanSpeed}% (${highest.device.id} at ${highest.device.temperature}°C)`,
				)
			}
		} catch (error) {
			this.logger.error('Failed to manage fan speed', error)
		}
	}

	async setMinFanSpeed(percent: number): Promise<void> {
		// Docker-incompatible: EC access not available in Docker
		if (this.#isDocker) return
		const EC_MIN_FAN_SPEED_ENABLE_ADDRESS = 0x5e
		const EC_MIN_FAN_SPEED_ADDRESS = 0x5f

		const clampedPercent = Math.max(0, Math.min(100, percent))

		const fanSpeedValue = Math.round((clampedPercent / 100) * 255)

		await this.#writeEcRegister(EC_MIN_FAN_SPEED_ENABLE_ADDRESS, 1)
		await this.#writeEcRegister(EC_MIN_FAN_SPEED_ADDRESS, fanSpeedValue)
	}

	setFanManagementEnabled(enabled: boolean) {
		if (enabled) {
			if (!this.#stopManagingFan) {
				this.logger.log('Resuming automatic fan management')
				this.#stopManagingFan = runEvery('1 minute', () => this.#manageFanSpeed())
			}
		} else {
			this.logger.log('Pausing automatic fan management')
			this.#stopManagingFan?.()
			this.#stopManagingFan = undefined
		}
	}

	EC_LED_STATE_ADDRESS = 0x50

	async setLedOff(): Promise<void> {
		// Docker-incompatible: EC access not available in Docker
		if (this.#isDocker) return
		const LED_STATE_OFF_VALUE = 0
		await this.#writeEcRegister(this.EC_LED_STATE_ADDRESS, LED_STATE_OFF_VALUE)
	}

	async setLedStatic(): Promise<void> {
		// Docker-incompatible: EC access not available in Docker
		if (this.#isDocker) return
		const LED_STATE_STATIC_VALUE = 1
		await this.#writeEcRegister(this.EC_LED_STATE_ADDRESS, LED_STATE_STATIC_VALUE)
	}

	async setLedColor({red, green, blue}: {red: number; green: number; blue: number}): Promise<void> {
		// Docker-incompatible: EC access not available in Docker
		if (this.#isDocker) return
		const EC_LED_RED_ADDRESS = 0x51
		const EC_LED_GREEN_ADDRESS = 0x59
		const EC_LED_BLUE_ADDRESS = 0x55

		red = Math.max(0, Math.min(255, Math.round(red)))
		green = Math.max(0, Math.min(255, Math.round(green)))
		blue = Math.max(0, Math.min(255, Math.round(blue)))

		await this.#writeEcRegister(EC_LED_RED_ADDRESS, red)
		await this.#writeEcRegister(EC_LED_GREEN_ADDRESS, green)
		await this.#writeEcRegister(EC_LED_BLUE_ADDRESS, blue)
	}

	async setLedWhite(): Promise<void> {
		// Docker-incompatible: EC access not available in Docker
		if (this.#isDocker) return
		await this.setLedColor({red: 255, green: 100, blue: 128})
	}

	async setLedDefault(): Promise<void> {
		// Docker-incompatible: EC access not available in Docker
		if (this.#isDocker) return
		await this.setLedStatic()
		await this.setLedWhite()
	}

	async setLedBlinking(): Promise<void> {
		// Docker-incompatible: EC access not available in Docker
		if (this.#isDocker) return
		const LED_STATE_BLINKING_VALUE = 2
		await this.#writeEcRegister(this.EC_LED_STATE_ADDRESS, LED_STATE_BLINKING_VALUE)
	}

	async setLedBreathe(duration: number = 14): Promise<void> {
		// Docker-incompatible: EC access not available in Docker
		if (this.#isDocker) return
		const EC_LED_BREATHING_DURATION_ADDRESS = 0x52
		const LED_STATE_BREATHING_VALUE = 3

		const clampedDuration = Math.max(0, Math.min(19, Math.round(duration)))
		await this.#writeEcRegister(EC_LED_BREATHING_DURATION_ADDRESS, clampedDuration)
		await this.#writeEcRegister(EC_LED_STATE_ADDRESS, LED_STATE_BREATHING_VALUE)
	}

	EC_RESET_BOOT_FLAG_ADDRESS = 0xa8

	async wasBootedViaResetButton(): Promise<boolean> {
		// Docker-incompatible: EC access not available in Docker
		if (this.#isDocker) return false
		const flag = await this.#readEcRegister(this.EC_RESET_BOOT_FLAG_ADDRESS)
		return flag === 1
	}

	async clearResetBootFlag(): Promise<void> {
		// Docker-incompatible: EC access not available in Docker
		if (this.#isDocker) return
		await this.#writeEcRegister(this.EC_RESET_BOOT_FLAG_ADDRESS, 0)
	}

	getSsdSlotFromPciSlotNumber(pciSlotNumber: number | undefined): number | undefined {
		if (pciSlotNumber === 12) return 1
		if (pciSlotNumber === 14) return 2
		if (pciSlotNumber === 4) return 3
		if (pciSlotNumber === 6) return 4

		return undefined
	}
}
