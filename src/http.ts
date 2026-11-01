import { TTLCache } from './cache.ts'

export class HttpError extends Error {
	constructor(
		message: string,
		readonly statusCode: number,
		readonly url: string
	) {
		super(message)
		this.name = 'HttpError'
	}
}

export interface HttpOptions {
	timeoutMs?: number
	retries?: number
	retryDelayMs?: number
	headers?: Record<string, string>
	/** Cache TTL for GET requests in ms. 0 disables caching. */
	cacheTtlMs?: number
	baseUrl?: string
}

export interface RequestOptions extends Omit<HttpOptions, 'baseUrl'> {
	method?: string
	body?: unknown
	query?: Record<string, string | number | boolean | undefined>
	signal?: AbortSignal
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * fetch wrapper for bot APIs: timeouts, exponential-backoff retries, TTL cache for GETs and
 * coalescing of identical in-flight GETs.
 */
export class HttpClient {
	private readonly cache = new TTLCache<string, unknown>({ max: 300 })
	private readonly inflight = new Map<string, Promise<unknown>>()

	constructor(private readonly defaults: HttpOptions = {}) {}

	buildUrl(url: string, query?: RequestOptions['query']) {
		const full = this.defaults.baseUrl && !/^https?:\/\//.test(url) ? new URL(url, this.defaults.baseUrl) : new URL(url)
		for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) full.searchParams.set(k, String(v))
		return full.toString()
	}

	async json<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
		return this.request<T>(url, opts, 'json')
	}

	async text(url: string, opts: RequestOptions = {}): Promise<string> {
		return this.request<string>(url, opts, 'text')
	}

	async buffer(url: string, opts: RequestOptions = {}): Promise<Buffer> {
		return this.request<Buffer>(url, opts, 'buffer')
	}

	private async request<T>(url: string, opts: RequestOptions, as: 'json' | 'text' | 'buffer'): Promise<T> {
		const merged = { ...this.defaults, ...opts }
		const method = (opts.method ?? 'GET').toUpperCase()
		const full = this.buildUrl(url, opts.query)
		const ttl = merged.cacheTtlMs ?? 0
		const cacheable = method === 'GET' && ttl > 0
		const key = `${as}:${full}`

		if (cacheable) {
			const hit = this.cache.get(key)
			if (hit !== undefined) return hit as T
			const pending = this.inflight.get(key)
			if (pending) return pending as Promise<T>
		}

		const run = this.execute<T>(full, method, merged, opts, as)
		if (!cacheable) return run

		this.inflight.set(key, run)
		try {
			const value = await run
			this.cache.set(key, value, ttl)
			return value
		} finally {
			this.inflight.delete(key)
		}
	}

	private async execute<T>(
		url: string,
		method: string,
		cfg: HttpOptions,
		opts: RequestOptions,
		as: 'json' | 'text' | 'buffer'
	): Promise<T> {
		const retries = cfg.retries ?? 2
		const timeoutMs = cfg.timeoutMs ?? 15_000
		const delay = cfg.retryDelayMs ?? 300
		const headers: Record<string, string> = { ...cfg.headers }
		let body: string | undefined
		if (opts.body !== undefined) {
			body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
			if (typeof opts.body !== 'string') headers['content-type'] ??= 'application/json'
		}

		let lastError: unknown
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const signals = [AbortSignal.timeout(timeoutMs)]
				if (opts.signal) signals.push(opts.signal)
				const res = await fetch(url, { method, headers, body, signal: AbortSignal.any(signals) })
				if (!res.ok) {
					const err = new HttpError(`${method} ${url} -> ${res.status}`, res.status, url)
					if (RETRYABLE.has(res.status) && attempt < retries) {
						lastError = err
						await sleep(delay * 2 ** attempt)
						continue
					}

					throw err
				}

				if (as === 'json') return (await res.json()) as T
				if (as === 'text') return (await res.text()) as T
				return Buffer.from(await res.arrayBuffer()) as T
			} catch (err) {
				if (err instanceof HttpError || opts.signal?.aborted || attempt >= retries) throw err
				lastError = err
				await sleep(delay * 2 ** attempt)
			}
		}

		throw lastError
	}
}
