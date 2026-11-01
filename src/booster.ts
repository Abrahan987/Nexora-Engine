import { monitorEventLoopDelay } from 'node:perf_hooks'
import { rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from './types.ts'

export interface BoosterOptions {
	/** How often the background maintenance loop runs. */
	intervalMs?: number
	/** Heap usage (MB) above which `onPressure` is fired and GC is requested if exposed. */
	heapLimitMb?: number
	/** Directory of temporary files to sweep. */
	tmpDir?: string
	tmpMaxAgeMs?: number
	logger?: Logger
	/** Functions run every cycle, e.g. cache `prune()` methods. Errors are logged, never thrown. */
	tasks?: Array<() => unknown>
	/** Called when heap exceeds the limit, so the app can drop caches. */
	onPressure?: (stats: BoosterStats) => void
}

export interface BoosterStats {
	heapUsedMb: number
	rssMb: number
	eventLoopLagMs: number
	uptimeSec: number
	cycles: number
}

const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10

/**
 * Background maintenance loop. It never blocks the bot: timers are unref'd, work is async and
 * every task is isolated. It prunes caches, sweeps temp files, and reacts to memory pressure.
 */
export class Booster {
	private timer?: NodeJS.Timeout
	private readonly histogram = monitorEventLoopDelay({ resolution: 20 })
	private cycles = 0
	private running = false
	private readonly opts: Required<Pick<BoosterOptions, 'intervalMs' | 'heapLimitMb' | 'tmpMaxAgeMs'>> & BoosterOptions

	constructor(opts: BoosterOptions = {}) {
		this.opts = { intervalMs: 60_000, heapLimitMb: 512, tmpMaxAgeMs: 3_600_000, ...opts }
	}

	addTask(task: () => unknown) {
		this.opts.tasks = [...(this.opts.tasks ?? []), task]
	}

	get started() {
		return this.timer !== undefined
	}

	start() {
		if (this.timer) return
		this.histogram.enable()
		this.timer = setInterval(() => void this.tick(), this.opts.intervalMs)
		this.timer.unref()
	}

	stop() {
		if (this.timer) clearInterval(this.timer)
		this.timer = undefined
		this.histogram.disable()
	}

	stats(): BoosterStats {
		const mem = process.memoryUsage()
		const lag = Number.isFinite(this.histogram.mean) ? this.histogram.mean / 1e6 : 0
		return {
			heapUsedMb: mb(mem.heapUsed),
			rssMb: mb(mem.rss),
			eventLoopLagMs: Math.round(lag * 10) / 10,
			uptimeSec: Math.round(process.uptime()),
			cycles: this.cycles
		}
	}

	async tick() {
		if (this.running) return
		this.running = true
		try {
			this.cycles++
			for (const task of this.opts.tasks ?? []) {
				try {
					await task()
				} catch (err) {
					this.opts.logger?.warn({ err }, 'booster task failed')
				}
			}

			if (this.opts.tmpDir) await this.sweepTmp(this.opts.tmpDir).catch(() => undefined)

			const stats = this.stats()
			if (stats.heapUsedMb > this.opts.heapLimitMb) {
				this.opts.logger?.warn({ stats }, 'memory pressure')
				this.opts.onPressure?.(stats)
				// Only available when node runs with --expose-gc.
				;(globalThis as { gc?: () => void }).gc?.()
			}

			this.histogram.reset()
		} finally {
			this.running = false
		}
	}

	private async sweepTmp(dir: string) {
		const now = Date.now()
		for (const name of await readdir(dir)) {
			const file = join(dir, name)
			const info = await stat(file)
			if (info.isFile() && now - info.mtimeMs > this.opts.tmpMaxAgeMs) await rm(file, { force: true })
		}
	}
}
