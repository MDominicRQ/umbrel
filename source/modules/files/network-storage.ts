import os from 'node:os'
import nodePath from 'node:path'
import {setTimeout} from 'node:timers/promises'

import fse from 'fs-extra'
import {$} from 'execa'
import ky from 'ky'

import {getHostname} from '../system/system.js'

import type Umbreld from '../../index.js'

type NetworkShare = {
	host: string
	share: string
	username: string
	password: string
	mountPath: string
}

export default class NetworkStorage {
	#umbreld: Umbreld
	logger: Umbreld['logger']
	mountedShares: Set<string>
	shareWatchInterval = 1000 * 60
	isRunning = false
	watchJobPromise?: Promise<void>

	constructor(umbreld: Umbreld) {
		this.#umbreld = umbreld
		const {name} = this.constructor
		this.logger = umbreld.logger.createChildLogger(`files:${name.toLowerCase()}`)
		this.mountedShares = new Set()
	}

	async start() {
		this.isRunning = true
		this.watchJobPromise = this.#watchAndMountShares().catch((error) =>
			this.logger.error('Error watching and mounting shares', error),
		)
	}

	async stop() {
		this.logger.log('Stopping network storage')
		this.isRunning = false

		const ONE_SECOND = 1000

		if (this.watchJobPromise) {
			await Promise.race([
				setTimeout(ONE_SECOND * 10),
				(async () => {
					this.logger.log('Waiting for background job to finish')
					await this.watchJobPromise!.catch(() => {})
				})(),
			])
		}

		await Promise.race([
			setTimeout(ONE_SECOND * 10),
			(async () => {
				this.logger.log('Unmounting shares')
				await this.#unmountAllShares().catch((error) => this.logger.error('Error unmounting shares', error))
			})(),
		])
	}

	async getShares() {
		return (await this.#umbreld.store.get('files.networkStorage')) || []
	}

	async getShareInfo() {
		const shares = await this.getShares()
		return shares.map(({host, share, mountPath}) => ({
			host,
			share,
			mountPath,
			isMounted: this.mountedShares.has(mountPath),
		}))
	}

	async #watchAndMountShares() {
		this.logger.log('Scheduling network share watch interval')
		let lastRun = 0
		while (this.isRunning) {
			await setTimeout(100)
			const shouldRun = Date.now() - lastRun >= this.shareWatchInterval
			if (!shouldRun) continue
			lastRun = Date.now()

			this.logger.verbose('Running network share watch interval')
			const shares = await this.getShares()
			await Promise.all(
				shares.map(async (share) => {
					try {
						if (await this.#isMounted(share)) {
							this.mountedShares.add(share.mountPath)
						} else {
							this.mountedShares.delete(share.mountPath)
							await this.#mountShare(share)
						}
					} catch (error) {}
				}),
			)
			this.logger.verbose('Network share watch interval complete')
		}
	}

	async #isMounted(share: NetworkShare): Promise<boolean> {
		try {
			const systemMountPath = await this.#umbreld.files.virtualToSystemPathUnsafe(share.mountPath)
			await $`mountpoint ${systemMountPath}`

			return true
		} catch (error) {
			return false
		}
	}

	async #mountShare(share: NetworkShare): Promise<void> {
		this.logger.log(`Mounting network share: ${share.mountPath}`)

		if (/[\r\n]/.test(share.username) || /[\r\n]/.test(share.password)) {
			throw new Error('Network share username and password cannot contain newlines')
		}

		const systemMountPath = this.#umbreld.files.virtualToSystemPathUnsafe(share.mountPath)
		await fse.ensureDir(systemMountPath)

		let credentialsDirectory: string | undefined
		try {
			const smbPath = `//${share.host}/${share.share}`
			const {userId, groupId} = this.#umbreld.files.fileOwner
			credentialsDirectory = await fse.mkdtemp(nodePath.join(os.tmpdir(), 'umbrel-cifs-credentials-'))
			const credentialsPath = nodePath.join(credentialsDirectory, 'credentials')
			await fse.writeFile(credentialsPath, `username=${share.username}\npassword=${share.password}\n`, {mode: 0o600})
			await $`mount -t cifs ${smbPath} ${systemMountPath} -o credentials=${credentialsPath},uid=${userId},gid=${groupId},iocharset=utf8`
			this.mountedShares.add(share.mountPath)
			this.logger.log(`Successfully mounted network share: ${smbPath} to ${share.mountPath}`)
		} catch (error) {
			this.logger.error(`Failed to mount network share: ${share.mountPath}, cleaning up mount directory`)
			this.#unmountShare(share).catch((error) =>
				this.logger.error(`Failed to clean up mount directory after mount failure: ${share.mountPath}`, error),
			)

			throw error
		} finally {
			if (credentialsDirectory) await fse.remove(credentialsDirectory).catch(() => {})
		}
	}

	async #unmountShare(share: NetworkShare): Promise<void> {
		this.logger.log(`Unmounting network share: ${share.mountPath}`)
		try {
			const systemMountPath = this.#umbreld.files.virtualToSystemPathUnsafe(share.mountPath)
			if (await this.#isMounted(share)) await $`umount ${systemMountPath}`

			await fse.rmdir(systemMountPath)

			const parentDirectory = nodePath.dirname(systemMountPath)
			const parentFiles = await fse.readdir(parentDirectory)
			const isParentEmpty = parentFiles.length === 0
			const isParentChildOfNetwork =
				nodePath.dirname(parentDirectory) === this.#umbreld.files.getBaseDirectory('/Network')
			if (isParentEmpty && isParentChildOfNetwork) await fse.rmdir(parentDirectory)

			this.mountedShares.delete(share.mountPath)
			this.logger.log(`Successfully unmounted network share: ${share.mountPath}`)
		} catch (error) {
			this.logger.error(`Failed to unmount network share ${share.mountPath}`, error)
		}
	}

	async #unmountAllShares(): Promise<void> {
		const shares = await this.getShares()
		await Promise.all(shares.map(async (share) => this.#unmountShare(share)))
	}

	async addShare(newShare: Omit<NetworkShare, 'mountPath'>) {
		const sanitize = (string: string) => string.replace(/[^a-zA-Z0-9\-\.\' \(\)]/g, '')
		const mountPath = `/Network/${sanitize(newShare.host)}/${sanitize(newShare.share)}`

		const alreadyExists = await this.getShare(mountPath)
			.then(() => true)
			.catch(() => false)
		if (alreadyExists) throw new Error(`Share with mount path ${mountPath} already exists`)

		const share: NetworkShare = {...newShare, mountPath}

		await this.#mountShare(share)

		await this.#umbreld.store.getWriteLock(async ({set}) => {
			const shares = await this.getShares()
			if (shares.find((existingShare) => existingShare.mountPath === share.mountPath)) return
			shares.push(share)
			await set('files.networkStorage', shares)
		})

		return share.mountPath
	}

	async getShare(mountPath: string) {
		const shares = await this.getShares()
		const share = shares.find((share) => share.mountPath === mountPath)
		if (!share) throw new Error(`Share with mount path ${mountPath} not found`)
		return share
	}

	async removeShare(sharePath: string) {
		const share = await this.getShare(sharePath)

		await this.#unmountShare(share)

		await this.#umbreld.store.getWriteLock(async ({set}) => {
			const shares = await this.getShares()
			const newShares = shares.filter((existingShare) => existingShare.mountPath !== sharePath)
			await set('files.networkStorage', newShares)
		})

		return true
	}

	async discoverServers() {
		const avahiBrowse = await $`avahi-browse --resolve --terminate _smb._tcp --parsable`

		const hostname = await getHostname().catch(() => '')

		const servers = avahiBrowse.stdout
			.split('\n')
			.map((line) => line.split(';')[6])
			.filter((line) => typeof line === 'string' && line !== '')
			.filter((line) => line !== `${hostname}.local`)

		return Array.from(new Set(servers))
	}

	async discoverSharesOnServer(host: string, username: string, password: string) {
		const smbclient = await $`smbclient --list //${host} --user ${username} --password ${password} --grepable`

		const shares = smbclient.stdout
			.split('\n')
			.filter((line) => line.split('|').length === 3)
			.map((line) => line.split('|')[1])
			.filter((share) => share !== 'IPC$')

		return shares
	}

	async isServerAnUmbrelDevice(address: string) {
		try {
			const responseText = (await ky(`http://${address}/trpc/system.version`, {timeout: 1000}).text()) as any
			return responseText.toLowerCase().includes('umbrel')
		} catch {
			return false
		}
	}
}
