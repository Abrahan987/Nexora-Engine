import type { CommandContext } from '../../src/index.ts'

export const command = ['ping', 'p']
export const category = 'info'
export const description = 'Latencia del bot y estado del motor.'
export const cooldown = 3000

export default async function (ctx: CommandContext) {
	const stats = ctx.engine.stats()
	const boost = ctx.engine.booster?.stats()
	await ctx.reply(
		`Pong! comandos: ${stats.commands} (${stats.avgCommandMs}ms prom.)\n` +
			`Cache grupos: ${stats.groupCacheHits} hits / ${stats.groupCacheMisses} misses\n` +
			`Heap: ${boost?.heapUsedMb ?? '?'}MB, lag: ${boost?.eventLoopLagMs ?? '?'}ms`
	)
}
