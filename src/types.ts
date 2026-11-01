export interface Logger {
	debug(obj: object | string, msg?: string): void
	info(obj: object | string, msg?: string): void
	warn(obj: object | string, msg?: string): void
	error(obj: object | string, msg?: string): void
}

export interface GroupParticipant {
	id: string
	lid?: string
	phoneNumber?: string
	admin?: 'admin' | 'superadmin' | null | string
}

export interface GroupMetadataLike {
	id: string
	subject?: string
	participants: GroupParticipant[]
}

/** Structural subset of a Baileys WASocket so the engine does not depend on Baileys at runtime. */
export interface SocketLike {
	user?: { id?: string; lid?: string }
	groupMetadata?(jid: string): Promise<GroupMetadataLike>
	sendMessage(jid: string, content: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>
	ev: {
		on(event: string, listener: (...args: never[]) => void): void
		off(event: string, listener: (...args: never[]) => void): void
	}
}

export interface RawMessage {
	key: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null }
	message?: Record<string, unknown> | null
	pushName?: string | null
	messageTimestamp?: number | { toNumber(): number } | null
}

export interface CommandContext {
	sock: SocketLike
	/** Alias of `sock` for Sukuna-style plugins: `run({ client, m })`. */
	client: SocketLike
	msg: RawMessage
	/** Alias of `msg`. */
	m: RawMessage
	engine: import('./engine.ts').NexoraEngine
	chat: string
	sender: string
	pushName: string
	isGroup: boolean
	isOwner: boolean
	isAdmin: boolean
	isBotAdmin: boolean
	text: string
	prefix: string
	command: string
	args: string[]
	/** Everything after the command name. */
	rest: string
	reply(text: string): Promise<unknown>
}

export type CommandHandler = (ctx: CommandContext) => unknown

export interface PluginMeta {
	commands: string[]
	category: string
	description: string
	admin: boolean
	botAdmin: boolean
	owner: boolean
	group: boolean
	private: boolean
	/** Per-user cooldown in ms. */
	cooldown: number
	file: string
}

export interface Plugin extends PluginMeta {
	run: CommandHandler
}

export type Middleware = (ctx: Omit<CommandContext, 'command' | 'args' | 'rest' | 'prefix'>) => unknown
