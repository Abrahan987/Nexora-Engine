import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CommandHandler, Logger, Plugin } from './types.ts'

type Loose = Record<string, unknown>

const isPluginFile = (f: string) => /\.(c|m)?(j|t)s$/.test(f) && !f.endsWith('.d.ts') && !f.endsWith('.test.ts')

const asList = (v: unknown): string[] =>
	(Array.isArray(v) ? v : [v]).filter(x => typeof x === 'string' && x).map(x => (x as string).toLowerCase())

const pick = (...vals: unknown[]) => vals.find(v => v !== undefined)

async function walk(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true })
	const nested = await Promise.all(
		entries.map(e => (e.isDirectory() ? walk(join(dir, e.name)) : Promise.resolve([join(dir, e.name)])))
	)
	return nested.flat()
}

/**
 * Normalizes the plugin shapes used by existing bots into a single `Plugin`:
 *  - Named exports + default function (`export const command = [...]; export default fn`)
 *  - Default object (`export default { command, category, run }`)
 */
export function normalizePlugin(mod: Loose, file: string): Plugin | null {
	const def = mod.default as Loose | CommandHandler | undefined
	const obj: Loose = typeof def === 'object' && def !== null ? (def as Loose) : {}
	const run = (typeof def === 'function' ? def : (obj.run ?? mod.run)) as CommandHandler | undefined
	if (typeof run !== 'function') return null

	const commands = asList(pick(mod.command, mod.cmd, mod.alias, obj.command, obj.cmd, obj.alias, []))
	if (!commands.length) return null

	return {
		commands,
		run,
		file,
		category: String(pick(mod.category, obj.category, 'misc')).toLowerCase(),
		description: String(pick(mod.description, mod.desc, obj.description, obj.desc, '')),
		admin: Boolean(pick(mod.admin, obj.admin)),
		botAdmin: Boolean(pick(mod.botAdmin, mod.botadmin, obj.botAdmin, obj.botadmin)),
		owner: Boolean(pick(mod.owner, mod.isOwner, obj.owner, obj.isOwner)),
		group: Boolean(pick(mod.group, obj.group)),
		private: Boolean(pick(mod.private, obj.private)),
		cooldown: Number(pick(mod.cooldown, obj.cooldown, 0)) || 0
	}
}

export class PluginRegistry {
	private readonly byCommand = new Map<string, Plugin>()
	private readonly byFile = new Map<string, Plugin>()
	private watcher?: FSWatcher
	private debounce = new Map<string, NodeJS.Timeout>()

	constructor(private readonly logger?: Logger) {}

	get(command: string) {
		return this.byCommand.get(command.toLowerCase())
	}

	list() {
		return Array.from(this.byFile.values())
	}

	register(plugin: Plugin) {
		this.unregisterFile(plugin.file)
		this.byFile.set(plugin.file, plugin)
		for (const c of plugin.commands) this.byCommand.set(c, plugin)
	}

	private unregisterFile(file: string) {
		const old = this.byFile.get(file)
		if (!old) return
		for (const c of old.commands) if (this.byCommand.get(c) === old) this.byCommand.delete(c)
		this.byFile.delete(file)
	}

	async loadFile(file: string) {
		try {
			// Cache-busting query forces a fresh import when hot-reloading.
			const mod = (await import(`${pathToFileURL(file).href}?v=${Date.now()}`)) as Loose
			const plugin = normalizePlugin(mod, file)
			if (plugin) this.register(plugin)
			else this.unregisterFile(file)
			return plugin
		} catch (err) {
			this.logger?.error({ err, file }, 'failed to load plugin')
			return null
		}
	}

	/** Loads every plugin file under `dir` in parallel. Returns the number of plugins loaded. */
	async loadDir(dir: string) {
		const root = resolve(dir)
		if (!existsSync(root)) return 0
		const files = (await walk(root)).filter(isPluginFile)
		const loaded = await Promise.all(files.map(f => this.loadFile(f)))
		return loaded.filter(Boolean).length
	}

	/** Reloads only the changed file, so editing one plugin does not re-import all of them. */
	watch(dir: string) {
		const root = resolve(dir)
		if (this.watcher || !existsSync(root)) return
		this.watcher = watch(root, { recursive: true }, (_event, name) => {
			if (!name || !isPluginFile(name)) return
			const file = join(root, name)
			clearTimeout(this.debounce.get(file))
			this.debounce.set(
				file,
				setTimeout(() => {
					this.debounce.delete(file)
					if (existsSync(file)) void this.loadFile(file)
					else this.unregisterFile(file)
				}, 250)
			)
		})
		this.watcher.unref()
	}

	close() {
		this.watcher?.close()
		this.watcher = undefined
		this.debounce.forEach(t => clearTimeout(t))
		this.debounce.clear()
	}
}
