type Metadata = {
	title?: string
	description?: string
	image?: string
}

export async function fetchPageMetadata(url: string): Promise<Metadata> {
	// Network access is not available in Docker for external URLs
	// Return empty metadata
	return {
		title: '',
		description: '',
		image: '',
		favicon: ''
	}
}
