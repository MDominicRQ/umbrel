import {execa} from 'execa'

export async function pullAll(
	images: string[],
	onProgress: (progress: number) => void,
): Promise<void> {
	const totalImages = images.length

	for (let i = 0; i < images.length; i++) {
		const image = images[i]
		await execa('docker', ['pull', image], {stdio: 'inherit'})
		onProgress((i + 1) / totalImages)
	}
}