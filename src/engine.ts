import { readFileSync } from 'node:fs'
import { Deduper } from './cache.ts'
import { Cooldowns, KeyedQueue, TaskQueue } from './queue.ts'
import { Booster, type BoosterOptions } from './booster.ts'
import { GroupCache, isGroupAdmin } from './groups.ts'
import { HttpClient, type HttpOptions } from './http.ts'
import { isGroupJid, matchesAny, normalizeJid } from './jid.ts'
import { PluginRegistry } from './plugins.ts'
import { Store, type StoreOptions } from './store.ts'
import type { CommandContext, Logger, Middleware, RawMessage, SocketLike } from './types.ts'

const DEFAULT_MESSAGES = {
	owner: 'Este comando es solo para el owner.',
	admin: 'Este comando es solo para admins del grupo.',
	botAdmin: 'Necesito ser admin del grupo para ejecutar este comando.',
	group: 'Este comando solo funciona en grupos.',
	private: 'Este comando solo funciona en chats privados.',
	cooldown: (seconds: number) => `Espera ${seconds}s antes de volver a usar este comando.`,
	busy: 'Estoy muy ocupado, intenta de nuevo en unos segundos.'
}

export interface EngineOptions {
	prefixes?: string[]
	/** Accept commands without any prefix (e.g. "ping"). */
	allowNoPrefix?: boolean
	/** Owner numbers or JIDs. */
	owners?: string[]
	logger?: Logger
	/** Max commands running at once across all chats. */
	concurrency?: number
	/** Reject new commands when this many are already waiting. */
	maxPending?: number
	/** Run commands from the same chat one after another. */
	serialPerChat?: boolean
	/** Ignore messages older than this many seconds (avoids replaying history after reconnects). 0 disables. */
	maxMessageAgeSec?: number
	/** Process messages sent by the bot itself. */
	handleOwnMessages?: boolean
	pluginsDir?: string
	watchPlugins?: boolean
	groupCache?: { max?: number; ttlMs?: number }
	/** Pass `false` to disable the background booster. */
	booster?: false | BoosterOptions
	store?: StoreOptions
	http?: HttpOptions
	messages?: Partial<typeof DEFAULT_MESSAGES>
	onError?: (err: unknown, ctx: CommandContext) => void
	/** Print the startup banner. Defaults to true. */
	banner?: boolean
}

export interface EngineStats {
	received: number
	duplicates: number
	stale: number
	commands: number
	errors: number
	avgCommandMs: number
	groupCacheHits: number
	groupCacheMisses: number
	queuePending: number
	queueActive: number
}

type Loose = Record<string, any>

const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage', 'editedMessage']

function unwrap(message: RawMessage['message']): Loose | undefined {
	let cur = (message ?? undefined) as Loose | undefined
	for (let i = 0; cur && i < 5; i++) {
		const current: Loose = cur
		const key = WRAPPERS.find(w => current[w])
		const inner: Loose | undefined = key ? current[key]?.message : undefined
		if (!inner) break
		cur = inner
	}

	return cur
}

/** Extracts the text of a message, including captions and interactive replies. */
export function extractText(message: RawMessage['message']): string {
	const m = unwrap(message)
	if (!m) return ''
	return String(
		m.conversation ??
			m.extendedTextMessage?.text ??
			m.imageMessage?.caption ??
			m.videoMessage?.caption ??
			m.documentMessage?.caption ??
			m.buttonsResponseMessage?.selectedButtonId ??
			m.listResponseMessage?.singleSelectReply?.selectedRowId ??
			m.templateButtonReplyMessage?.selectedId ??
			''
	)
}

export class NexoraEngine {
	readonly logger?: Logger
	readonly plugins: PluginRegistry
	readonly groups: GroupCache
	readonly http: HttpClient
	readonly store: Store
	readonly booster?: Booster
	readonly cooldowns = new Cooldowns()
	private readonly dedupe = new Deduper()
	private readonly queue: TaskQueue
	private readonly chatQueue = new KeyedQueue()
	private readonly middlewares: Middleware[] = []
	private readonly messages: typeof DEFAULT_MESSAGES
	private readonly prefixes: string[]
	private readonly counters = { received: 0, duplicates: 0, stale: 0, commands: 0, errors: 0, totalMs: 0 }
	private readonly listeners = new Map<SocketLike, (ev: { messages: RawMessage[]; type: string }) => void>()

	constructor(private readonly opts: EngineOptions = {}) {
		this.logger = opts.logger
		this.prefixes = [...(opts.prefixes ?? ['.', '!', '/', '#'])].sort((a, b) => b.length - a.length)
		this.messages = { ...DEFAULT_MESSAGES, ...opts.messages }
		this.queue = new TaskQueue({ concurrency: opts.concurrency ?? 8, maxPending: opts.maxPending ?? 200 })
		this.plugins = new PluginRegistry(opts.logger)
		this.groups = new GroupCache(opts.groupCache)
		this.http = new HttpClient(opts.http)
		this.store = new Store(opts.store)

		if (opts.booster !== false) {
			this.booster = new Booster({
				logger: opts.logger,
				...opts.booster,
				tasks: [
					() => this.dedupe.prune(),
					() => this.groups.prune(),
					() => this.cooldowns.prune(),
					() => this.store.flush(),
					...(opts.booster?.tasks ?? [])
				]
			})
		}
	}

	use(middleware: Middleware) {
		this.middlewares.push(middleware)
		return this
	}

	/** Loads plugins, starts the booster and hot-reload (when enabled). */
	async start() {
		if (this.opts.banner !== false) {
			let version = ''
			try {
				const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
				version = pkg.version ? ` v${pkg.version}` : ''
			} catch {
				// Version is cosmetic; never fail startup over it.
			}

			process.stdout.write(`\n  ⚡ Nexora Engine${version}\n     by ABRAHAN-M\n\n`)
		}

		if (this.opts.pluginsDir) {
			const count = await this.plugins.loadDir(this.opts.pluginsDir)
			this.logger?.info({ count }, 'plugins loaded')
			if (this.opts.watchPlugins) this.plugins.watch(this.opts.pluginsDir)
		}

		this.booster?.start()
		return this
	}

	async stop() {
		this.plugins.close()
		this.booster?.stop()
		for (const [sock, listener] of this.listeners) sock.ev.off('messages.upsert', listener as never)
		this.listeners.clear()
		await this.queue.onIdle()
		this.store.flush()
	}

	/** Subscribes to `messages.upsert` on a socket. Calling it twice for the same socket is a no-op. */
	attach(sock: SocketLike) {
		if (this.listeners.has(sock)) return this
		const listener = (ev: { messages: RawMessage[]; type: string }) => {
			if (ev.type !== 'notify') return
			for (const msg of ev.messages) {
				this.handle(sock, msg).catch(err => this.logger?.error({ err }, 'unhandled engine error'))
			}
		}

		this.listeners.set(sock, listener)
		sock.ev.on('messages.upsert', listener as never)
		this.groups.attach(sock)
		return this
	}

	stats(): EngineStats {
		const c = this.counters
		return {
			received: c.received,
			duplicates: c.duplicates,
			stale: c.stale,
			commands: c.commands,
			errors: c.errors,
			avgCommandMs: c.commands ? Math.round(c.totalMs / c.commands) : 0,
			groupCacheHits: this.groups.hits,
			groupCacheMisses: this.groups.misses,
			queuePending: this.queue.pending,
			queueActive: this.queue.active
		}
	}

	private parse(text: string) {
		const trimmed = text.trimStart()
		let prefix = this.prefixes.find(p => trimmed.startsWith(p))
		if (prefix === undefined) {
			if (!this.opts.allowNoPrefix) return null
			prefix = ''
		}

		const body = trimmed.slice(prefix.length).trim()
		if (!body) return null
		const [name = '', ...args] = body.split(/\s+/)
		return { prefix, command: name.toLowerCase(), args, rest: body.slice(name.length).trim() }
	}

	async handle(sock: SocketLike, msg: RawMessage): Promise<void> {
		const id = msg.key.id
		const chat = msg.key.remoteJid
		if (!id || !chat || !msg.message) return
		this.counters.received++

		if (msg.key.fromMe && !this.opts.handleOwnMessages) return
		if (this.dedupe.seen(`${chat}:${id}`)) {
			this.counters.duplicates++
			return
		}

		const maxAge = this.opts.maxMessageAgeSec ?? 0
		if (maxAge > 0 && msg.messageTimestamp) {
			const ts = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : msg.messageTimestamp.toNumber()
			if (Date.now() / 1000 - ts > maxAge) {
				this.counters.stale++
				return
			}
		}

		const isGroup = isGroupJid(chat)
		const sender = normalizeJid(msg.key.fromMe ? sock.user?.id : isGroup ? msg.key.participant : chat)
		const text = extractText(msg.message)
		const base = {
			sock,
			client: sock,
			msg,
			m: msg,
			engine: this,
			chat,
			sender,
			pushName: msg.pushName ?? '',
			isGroup,
			isOwner: matchesAny(sender, this.opts.owners ?? []),
			isAdmin: false,
			isBotAdmin: false,
			text,
			reply: (t: string) => sock.sendMessage(chat, { text: t }, { quoted: msg })
		}

		for (const mw of this.middlewares) {
			try {
				if ((await mw(base)) === true) return
			} catch (err) {
				this.logger?.error({ err }, 'middleware failed')
			}
		}

		const parsed = this.parse(text)
		if (!parsed) return
		const plugin = this.plugins.get(parsed.command)
		if (!plugin) return

		const ctx: CommandContext = { ...base, ...parsed }
		const deny = (reason: string) =>
			ctx.reply(reason).then(
				() => undefined,
				() => undefined
			)

		if (plugin.owner && !ctx.isOwner) return deny(this.messages.owner)
		if (plugin.group && !isGroup) return deny(this.messages.group)
		if (plugin.private && isGroup) return deny(this.messages.private)

		if (isGroup && (plugin.admin || plugin.botAdmin)) {
			const meta = await this.groups.get(sock, chat)
			ctx.isAdmin = ctx.isOwner || isGroupAdmin(meta, sender)
			ctx.isBotAdmin = isGroupAdmin(meta, sock.user?.id) || isGroupAdmin(meta, sock.user?.lid)
			if (plugin.admin && !ctx.isAdmin) return deny(this.messages.admin)
			if (plugin.botAdmin && !ctx.isBotAdmin) return deny(this.messages.botAdmin)
		} else if (plugin.admin && !ctx.isOwner) {
			return deny(this.messages.admin)
		}

		if (plugin.cooldown > 0 && !ctx.isOwner) {
			const left = this.cooldowns.hit(`${plugin.file}:${sender}`, plugin.cooldown)
			if (left > 0) return deny(this.messages.cooldown(Math.ceil(left / 1000)))
		}

		const execute = async () => {
			const started = Date.now()
			try {
				await plugin.run.call(sock, ctx)
			} catch (err) {
				this.counters.errors++
				this.logger?.error({ err, command: parsed.command }, 'command failed')
				this.opts.onError?.(err, ctx)
			} finally {
				this.counters.commands++
				this.counters.totalMs += Date.now() - started
			}
		}

		try {
			await this.queue.add(() => (this.opts.serialPerChat ? this.chatQueue.run(chat, execute) : execute()))
		} catch {
			await deny(this.messages.busy)
		}
	}
}

export function createEngine(opts: EngineOptions = {}) {
	return new NexoraEngine(opts)
}
