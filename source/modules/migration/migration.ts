import path from 'node:path'

import {type Compose} from 'compose-spec-schema'
import checkDiskSpace from 'check-disk-space'
import drivelist from 'drivelist'
import fse from 'fs-extra'
import {execa} from 'execa'
import {globby} from 'globby'
import yaml from 'js-yaml'
import semver from 'semver'

import type Umbreld from '../../index.js'

import isUmbrelHome from '../is-umbrel-home.js'
import type {ProgressStatus} from '../apps/schema.js'
import {reboot} from '../system/system.js'
import {setSystemStatus} from '../system/routes.js'

let migrationStatus: ProgressStatus = {
	running: false,
	progress: 0,
	description: '',
	error: false,
}

function updateMigrationStatus(properties: Partial<ProgressStatus>) {
	migrationStatus = {...migrationStatus, ...properties}
	console.log(migrationStatus)
}

export function getMigrationStatus() {
	return migrationStatus
}

function bytesToGB(bytes: number) {
	return (bytes / 1024 / 1024 / 1024).toFixed(1)
}

async function getDirectorySize(directoryPath: string) {
	let totalSize = 0
	const files = await fse.readdir(directoryPath, {withFileTypes: true})

	for (const file of files) {
		if (file.isSymbolicLink()) {
			const lstats = await fse.lstat(path.join(directoryPath, file.name))
			totalSize += lstats.size
		} else if (file.isFile()) {
			const stats = await fse.stat(path.join(directoryPath, file.name))
			totalSize += stats.size
		} else if (file.isDirectory()) {
			totalSize += await getDirectorySize(path.join(directoryPath, file.name))
		}
	}

	return totalSize
}

export async function findExternalUmbrelInstall() {
	try {
		const drives = await drivelist.list()
		const externalDrives = drives.filter((drive) => drive.isUSB && !drive.isSystem)

		for (const drive of externalDrives) {
			if (drive.mountpoints.length === 0) {
				const device = `${drive.device}1`
				const mountPoint = path.join('/mnt', path.basename(device))

				try {
					await fse.ensureDir(mountPoint)
					await execa('mount', ['--read-only', device, mountPoint])
					drive.mountpoints.push({path: mountPoint} as drivelist.Mountpoint)
				} catch (error) {
					console.error(`Error mounting drive: ${error}`)
					continue
				}
			}

			for (const mountpoint of drive.mountpoints) {
				const umbrelDotFile = path.join(mountpoint.path, 'umbrel/.umbrel')

				if (await fse.pathExists(umbrelDotFile)) {
					return path.dirname(umbrelDotFile)
				}
			}
		}
	} catch (error) {
		console.error(`Error finding external Umbrel install: ${error}`)
	}

	return false
}

export async function unmountExternalDrives() {
	try {
		const drives = await drivelist.list()
		const externalDrives = drives.filter((drive) => drive.isUSB && !drive.isSystem)

		for (const drive of externalDrives) {
			for (const mountpoint of drive.mountpoints) {
				try {
					await execa('umount', [mountpoint.path])
				} catch (error) {
					console.error(`Error unmounting drive: ${error}`)
					continue
				}
			}
		}
	} catch {
	}
}

export async function runPreMigrationChecks(
	currentInstall: string,
	externalUmbrelInstall: string,
	umbreld: Umbreld,
	onlyAllowUmbrelHardware = true,
) {
	if (onlyAllowUmbrelHardware) {
		const [isHome, isPro] = await Promise.all([isUmbrelHome(), umbreld.hardware.umbrelPro.isUmbrelPro()])
		if (!isHome && !isPro) {
			throw new Error('This feature is only supported on Umbrel Home or Umbrel Pro hardware')
		}
	}

	if (migrationStatus.running) {
		throw new Error('Migration is already running')
	}

	if (!externalUmbrelInstall) {
		throw new Error('No drive found with an umbrelOS install')
	}

	let externalVersion = 'unknown'
	if (await fse.exists(`${externalUmbrelInstall}/umbrel.yaml`)) {
		const data = await fse.readFile(`${externalUmbrelInstall}/umbrel.yaml`, 'utf8')
		const {version} = yaml.load(data) as {version: string}
		externalVersion = version
	} else if (await fse.exists(`${externalUmbrelInstall}/info.json`)) {
		const {version} = await fse.readJson(`${externalUmbrelInstall}/info.json`)
		externalVersion = version
	}

	const validVersionRange =
		externalVersion !== 'unknown' && semver.gte(umbreld.version, semver.coerce(externalVersion)!)
	if (!validVersionRange) {
		throw new Error(`Cannot migrate umbrelOS ${externalVersion} data into an umbrelOS ${umbreld.version} install.`)
	}

	const temporaryData = `${currentInstall}/.temporary-migration`
	await fse.remove(temporaryData)
	const {free} = await (checkDiskSpace as any)(currentInstall)
	const buffer = 1024 * 1024 * 1024
	const required = (await getDirectorySize(externalUmbrelInstall)) + buffer
	if (free < required) {
		throw new Error(`Not enough storage available. ${bytesToGB(free)} GB free, ${bytesToGB(required)} GB required.`)
	}

	return externalUmbrelInstall
}

export async function migrateData(currentInstall: string, externalUmbrelInstall: string, umbreld: Umbreld) {
	setSystemStatus('migrating')
	updateMigrationStatus({running: false, progress: 0, description: '', error: false})

	const temporaryData = `${currentInstall}/.temporary-migration`
	const finalData = `${currentInstall}/import`

	updateMigrationStatus({running: true, description: 'Copying data'})

	try {
		await fse.remove(temporaryData)
		const rsync = execa('rsync', [
			'--info=progress2',
			'--archive',
			'--delete',
			`${externalUmbrelInstall}/`,
			temporaryData,
		])

		rsync.stdout!.on('data', (chunk) => {
			const progressUpdate = chunk.toString().match(/.* (\d*)% .*/)
			if (progressUpdate) {
				const percent = Number.parseInt(progressUpdate[1], 10)
				const progress = Number.parseInt(0.6 * percent, 10)
				if (progress > migrationStatus.progress) updateMigrationStatus({progress})
			}
		})

		await rsync

		try {
			let progress = migrationStatus.progress
			updateMigrationStatus({description: 'Downloading apps'})
			const files = await globby(`${temporaryData}/app-data/*/docker-compose.yml`)
			const pulls = []
			const dockerPull = async (image: string) => {
				await execa('docker', ['pull', image])
				progress += 30 / pulls.length
				updateMigrationStatus({progress: Number.parseInt(progress, 10)})
			}

			for (const file of files) {
				const data = await fse.readFile(file, 'utf8')
				const compose = yaml.load(data) as Compose

				for (const {image} of Object.values(compose.services!)) {
					if (image) {
						pulls.push(dockerPull(image))
					}
				}
			}

			await Promise.allSettled(pulls)
		} catch (error) {
			console.error('Error processing docker-compose files:', error)
		}

		updateMigrationStatus({progress: 92, description: 'Cleaning up'})
		await fse.move(temporaryData, finalData, {overwrite: true})
	} catch (error) {
		console.error(error)
		setSystemStatus('running')
		updateMigrationStatus({running: false, progress: 0, description: '', error: 'Failed to migrate data'})
		return
	}

	updateMigrationStatus({progress: 95, description: 'Rebooting'})
	setSystemStatus('restarting')
	await umbreld.stop()
	await reboot()
}
