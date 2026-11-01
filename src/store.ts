import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

type Json = Record<string, unknown>

export interface StoreOptions {
	/** JSON file path. Omit for a purely in-memory store. */
	file?: string
	/** Delay before dirty data is written. Many writes inside the window cost one disk write. */
	flushDelayMs?: number
}

/**
 * Collection-based JSON store with write-behind persistence: reads and writes hit memory, and
 * disk is updated in the background with an atomic write (tmp file + rename).
 */
export class Store {
	private data: Record<string, Record<string, Json>> = {}
	private timer?: NodeJS.Timeout
	private dirty = false
	private readonly file?: string
	private readonly flushDelayMs: number

	constructor({ file, flushDelayMs = 2000 }: StoreOptions = {}) {
		this.file = file
		this.flushDelayMs = flushDelayMs
		if (file && existsSync(file)) {
			try {
				this.data = JSON.parse(readFileSync(file, 'utf8')) as typeof this.data
			} catch {
				// A corrupt file must not stop the bot; the next flush overwrites it.
				this.data = {}
			}
		}
	}

	collection<T extends Json = Json>(name: string) {
		const rows = (this.data[name] ??= {})
		const touch = () => this.markDirty()
		return {
			get: (id: string): T | undefined => rows[id] as T | undefined,
			/** Returns the row, creating it from `defaults` when missing. */
			ensure: (id: string, defaults: T): T => {
				if (!rows[id]) {
					rows[id] = { ...defaults }
					touch()
				}

				return rows[id] as T
			},
			set: (id: string, value: T) => {
				rows[id] = value
				touch()
			},
			update: (id: string, patch: Partial<T>) => {
				rows[id] = { ...rows[id], ...patch }
				touch()
				return rows[id] as T
			},
			delete: (id: string) => {
				const had = id in rows
				delete rows[id]
				if (had) touch()
				return had
			},
			all: () => rows as Record<string, T>
		}
	}

	private markDirty() {
		this.dirty = true
		if (!this.file || this.timer) return
		this.timer = setTimeout(() => this.flush(), this.flushDelayMs)
		this.timer.unref()
	}

	flush() {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
		if (!this.file || !this.dirty) return
		this.dirty = false
		mkdirSync(dirname(this.file), { recursive: true })
		const tmp = `${this.file}.tmp`
		writeFileSync(tmp, JSON.stringify(this.data))
		renameSync(tmp, this.file)
	}
}
