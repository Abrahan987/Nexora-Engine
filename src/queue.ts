export class QueueOverflowError extends Error {
	readonly statusCode = 429
	constructor(message = 'queue is full') {
		super(message)
		this.name = 'QueueOverflowError'
	}
}

export interface TaskQueueOptions {
	concurrency?: number
	/** Max waiting tasks; beyond this, `add` rejects with QueueOverflowError. */
	maxPending?: number
}

/** Concurrency-limited FIFO queue for async tasks. */
export class TaskQueue {
	private running = 0
	private readonly waiting: Array<() => void> = []
	private idleWaiters: Array<() => void> = []
	readonly concurrency: number
	private readonly maxPending: number

	constructor({ concurrency = 8, maxPending = Infinity }: TaskQueueOptions = {}) {
		this.concurrency = Math.max(1, concurrency)
		this.maxPending = maxPending
	}

	get pending() {
		return this.waiting.length
	}

	get active() {
		return this.running
	}

	add<T>(task: () => Promise<T> | T): Promise<T> {
		if (this.waiting.length >= this.maxPending) return Promise.reject(new QueueOverflowError())
		return new Promise<T>((resolve, reject) => {
			const run = () => {
				this.running++
				Promise.resolve()
					.then(task)
					.then(resolve, reject)
					.finally(() => {
						this.running--
						this.next()
					})
			}

			if (this.running < this.concurrency) run()
			else this.waiting.push(run)
		})
	}

	private next() {
		const run = this.waiting.shift()
		if (run) run()
		else if (this.running === 0) {
			const waiters = this.idleWaiters
			this.idleWaiters = []
			waiters.forEach(w => w())
		}
	}

	onIdle() {
		if (this.running === 0 && this.waiting.length === 0) return Promise.resolve()
		return new Promise<void>(resolve => this.idleWaiters.push(resolve))
	}
}

/** Runs tasks sequentially per key (e.g. per chat) while different keys run in parallel. */
export class KeyedQueue {
	private readonly tails = new Map<string, Promise<unknown>>()

	get size() {
		return this.tails.size
	}

	run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
		const prev = this.tails.get(key) ?? Promise.resolve()
		const result = prev.then(task, task)
		const tail = result.catch(() => undefined)
		this.tails.set(key, tail)
		// Only remove the entry if nothing was chained after us, so the map never grows unbounded.
		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key)
		})
		return result
	}
}

/** Sliding-window cooldown tracker keyed by arbitrary strings. */
export class Cooldowns {
	private readonly until = new Map<string, number>()

	/** Returns remaining ms if still cooling down; otherwise starts a new cooldown and returns 0. */
	hit(key: string, ms: number) {
		const now = Date.now()
		const end = this.until.get(key) ?? 0
		if (end > now) return end - now
		this.until.set(key, now + ms)
		return 0
	}

	prune() {
		const now = Date.now()
		let removed = 0
		for (const [key, end] of Array.from(this.until)) {
			if (end <= now) {
				this.until.delete(key)
				removed++
			}
		}

		return removed
	}
}
