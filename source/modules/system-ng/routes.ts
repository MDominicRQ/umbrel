import {privateProcedure, publicProcedureWhenNoUserExists, router} from '../server/trpc/trpc.js'

const device = router({
	// Public during onboarding to show device-specific UI (Pro/Home images, video background)
	getIdentity: publicProcedureWhenNoUserExists.query(async ({ctx}) => {
		try {
			return await ctx.umbreld.systemNg.device.getIdentity()
		} catch (error) {
			return { id: '', name: '' }
		}
	}),
	// Returns device identity and hardware specs (CPU, memory, storage)
	getSpecs: privateProcedure.query(({ctx}) => ctx.umbreld.systemNg.device.getSpecs()),
})

export default router({
	device,
})