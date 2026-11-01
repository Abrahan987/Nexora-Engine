/** Digits-only user part of a JID, without device/agent suffix. */
export function jidUser(jid: string | undefined | null) {
	if (!jid) return ''
	return (jid.split('@')[0] ?? '').split(':')[0]!.replace(/[^\d]/g, '')
}

export function jidServer(jid: string | undefined | null) {
	return jid?.split('@')[1] ?? ''
}

export function isGroupJid(jid: string | undefined | null) {
	return jidServer(jid) === 'g.us'
}

/** Removes device/agent suffix: `123:4@s.whatsapp.net` -> `123@s.whatsapp.net`. */
export function normalizeJid(jid: string | undefined | null) {
	if (!jid) return ''
	const [user = '', server = ''] = jid.split('@')
	return `${user.split(':')[0]}@${server}`.toLowerCase()
}

export function sameUser(a: string | undefined | null, b: string | undefined | null) {
	const ua = jidUser(a)
	return ua !== '' && ua === jidUser(b)
}

/**
 * Number variants to compare against. Mexican numbers appear both as 521XXXXXXXXXX and
 * 52XXXXXXXXXX depending on the stanza, so both forms are returned.
 */
export function numberVariants(jid: string | undefined | null) {
	const n = jidUser(jid)
	if (!n) return []
	return n.startsWith('521') ? [n, '52' + n.slice(3)] : [n]
}

export function matchesAny(jid: string | undefined | null, candidates: Iterable<string | undefined | null>) {
	const mine = new Set(numberVariants(jid))
	if (!mine.size) return false
	for (const c of candidates) {
		if (numberVariants(c).some(v => mine.has(v))) return true
	}

	return false
}
