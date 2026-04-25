import fse from 'fs-extra'
import path from 'node:path'

export default async function getDirectorySize(directoryPath: string): Promise<number> {
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
