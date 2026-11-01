import { TTLCache } from './cache.ts'
import { jidUser, matchesAny } from './jid.ts'
import type { GroupMetadataLike, SocketLike } from './types.ts'

/**
 * Group metadata cache that coalesces concurrent lookups for the same group, so a burst of
 * messages in one group triggers a single `groupMetadata` query instead of one per message.
 */
export class GroupCache {
	private readonly cache: TTLCache<string, GroupMetadataLike>
	private readonly inflight = new Map<string, Promise<GroupMetadataLike | null>>()
	private readonly attached = new WeakSet<object>()
	hits = 0
	misses = 0

	constructor(opts: { max?: number; ttlMs?: number } = {}) {
		this.cache = new TTLCache({ max: opts.max ?? 500, ttlMs: opts.ttlMs ?? 300_000 })
	}

	async get(sock: SocketLike, jid: string): Promise<GroupMetadataLike | null> {
		const key = `${jidUser(sock.user?.id)}:${jid}`
		const cached = this.cache.get(key)
		if (cached) {
			this.hits++
			return cached
		}

		this.misses++
		const pending = this.inflight.get(key)
		if (pending) return pending
		if (!sock.groupMetadata) return null

		const request = sock
			.groupMetadata(jid)
			.then(meta => {
				if (meta) this.cache.set(key, meta)
				return meta ?? null
			})
			.catch(() => null)
			.finally(() => this.inflight.delete(key))
		this.inflight.set(key, request)
		return request
	}

	invalidate(jid: string) {
		this.cache.deleteWhere(key => key.endsWith(`:${jid}`))
	}

	prune() {
		return this.cache.prune()
	}

	/** Invalidates entries when WhatsApp reports group changes. Safe to call more than once per socket. */
	attach(sock: SocketLike) {
		if (this.attached.has(sock)) return
		this.attached.add(sock)
		const onChange = (updates: Array<{ id?: string }>) => {
			for (const u of updates ?? []) if (u?.id) this.invalidate(u.id)
		}

		const onParticipants = (ev: { id?: string }) => {
			if (ev?.id) this.invalidate(ev.id)
		}

		sock.ev.on('groups.update', onChange as never)
		sock.ev.on('group-participants.update', onParticipants as never)
	}
}

export function isGroupAdmin(meta: GroupMetadataLike | null, jid: string | undefined | null) {
	if (!meta || !jid) return false
	return meta.participants.some(
		p => (p.admin === 'admin' || p.admin === 'superadmin') && matchesAny(jid, [p.id, p.lid, p.phoneNumber])
	)
}
