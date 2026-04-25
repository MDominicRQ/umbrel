import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'

import {execa} from 'execa'

import type Umbreld from '../../../index.js'

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'app-script')
const DOCKER_FRAGMENTS_PATH = dirname(fileURLToPath(import.meta.url))

export default async function appScript(
	umbreld: Umbreld,
	command: string,
	appId: string,
	...args: unknown[]
): Promise<{stdout: string}> {
	const env: Record<string, string> = {
		SCRIPT_UMBREL_ROOT: umbreld.dataDirectory,
		SCRIPT_APP_REPO_DIR: '',
		SCRIPT_DOCKER_FRAGMENTS: DOCKER_FRAGMENTS_PATH,
	}

	const execaOptions = {
		env,
		extendEnv: true,
	}

	const argArray = [command, appId, ...args]
	const result = await execa({
		...execaOptions,
		shell: true,
	})`bash ${SCRIPT_PATH} ${argArray}`

	return {stdout: result.stdout}
}
