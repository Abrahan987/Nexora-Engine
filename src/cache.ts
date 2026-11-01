export interface TTLCacheOptions {
	/** Maximum number of entries; the least recently used is evicted first. */
	max?: number
	/** Time to live in milliseconds. */
	ttlMs?: number
}

interface Entry<V> {
	value: V
	expires: number
}

/** Small LRU cache with per-entry expiry. Map insertion order is used as recency. */
export class TTLCache<K, V> {
	private readonly store = new Map<K, Entry<V>>()
	private readonly max: number
	private readonly ttlMs: number

	constructor({ max = 500, ttlMs = 300_000 }: TTLCacheOptions = {}) {
		this.max = max
		this.ttlMs = ttlMs
	}

	get size() {
		return this.store.size
	}

	get(key: K): V | undefined {
		const entry = this.store.get(key)
		if (!entry) return undefined
		if (entry.expires <= Date.now()) {
			this.store.delete(key)
			return undefined
		}

		this.store.delete(key)
		this.store.set(key, entry)
		return entry.value
	}

	has(key: K) {
		return this.get(key) !== undefined
	}

	set(key: K, value: V, ttlMs = this.ttlMs) {
		this.store.delete(key)
		this.store.set(key, { value, expires: Date.now() + ttlMs })
		while (this.store.size > this.max) {
			const oldest = this.store.keys().next()
			if (oldest.done) break
			this.store.delete(oldest.value)
		}

		return this
	}

	delete(key: K) {
		return this.store.delete(key)
	}

	deleteWhere(predicate: (key: K) => boolean) {
		let removed = 0
		for (const key of Array.from(this.store.keys())) {
			if (predicate(key)) {
				this.store.delete(key)
				removed++
			}
		}

		return removed
	}

	clear() {
		this.store.clear()
	}

	/** Drops expired entries. Returns how many were removed. */
	prune() {
		const now = Date.now()
		let removed = 0
		for (const [key, entry] of Array.from(this.store)) {
			if (entry.expires <= now) {
				this.store.delete(key)
				removed++
			}
		}

		return removed
	}
}

/** Remembers recently seen keys (message ids, events) to drop duplicates. */
export class Deduper {
	private readonly cache: TTLCache<string, true>

	constructor(opts: TTLCacheOptions = {}) {
		this.cache = new TTLCache({ max: opts.max ?? 5000, ttlMs: opts.ttlMs ?? 60_000 })
	}

	/** Returns true if the key was already seen; otherwise records it and returns false. */
	seen(key: string) {
		if (this.cache.has(key)) return true
		this.cache.set(key, true)
		return false
	}

	prune() {
		return this.cache.prune()
	}
}
