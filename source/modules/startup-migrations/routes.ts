import z from 'zod'

import {router, privateProcedure} from '../server/trpc/trpc.js'
import {getMigrationStatus} from './index.js'

export default router({
	status: privateProcedure.query(() => getMigrationStatus()),

	// Manually trigger a rollback
	rollback: privateProcedure
		.input(
			z.object({
				backupId: z.string(),
			}),
		)
		.mutation(async ({ctx, input}) => {
			return ctx.umbreld.backups.restoreBackup(input.backupId)
		}),
})