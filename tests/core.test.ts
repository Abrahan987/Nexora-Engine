import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Cooldowns, Deduper, GroupCache, KeyedQueue, TaskQueue, TTLCache, matchesAny, normalizeJid, QueueOverflowError } from '../src/index.ts'
import type { SocketLike } from '../src/index.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('TTLCache', () => {
	it('evicts the least recently used entry beyond max', () => {
		const c = new TTLCache<string, number>({ max: 2 })
		c.set('a', 1).set('b', 2)
		c.get('a')
		c.set('c', 3)
		assert.equal(c.get('b'), undefined)
		assert.equal(c.get('a'), 1)
	})

	it('expires entries after the ttl', async () => {
		const c = new TTLCache<string, number>({ ttlMs: 10 })
		c.set('a', 1)
		await sleep(25)
		assert.equal(c.get('a'), undefined)
	})
})

describe('Deduper', () => {
	it('reports repeated keys as seen', () => {
		const d = new Deduper()
		assert.equal(d.seen('x'), false)
		assert.equal(d.seen('x'), true)
	})
})

describe('TaskQueue', () => {
	it('never exceeds the configured concurrency', async () => {
		const q = new TaskQueue({ concurrency: 2 })
		let active = 0
		let peak = 0
		await Promise.all(
			Array.from({ length: 6 }, () =>
				q.add(async () => {
					peak = Math.max(peak, ++active)
					await sleep(5)
					active--
				})
			)
		)
		assert.equal(peak, 2)
	})

	it('rejects when too many tasks are waiting', async () => {
		const q = new TaskQueue({ concurrency: 1, maxPending: 1 })
		const a = q.add(() => sleep(10))
		const b = q.add(() => sleep(1))
		await assert.rejects(q.add(() => 1), QueueOverflowError)
		await Promise.all([a, b])
	})
})

describe('KeyedQueue', () => {
	it('serializes tasks of the same key and cleans up', async () => {
		const k = new KeyedQueue()
		const order: number[] = []
		await Promise.all([
			k.run('a', async () => {
				await sleep(10)
				order.push(1)
			}),
			k.run('a', () => void order.push(2))
		])
		await sleep(0)
		assert.deepEqual(order, [1, 2])
		assert.equal(k.size, 0)
	})
})

describe('Cooldowns', () => {
	it('returns remaining time while cooling down', () => {
		const c = new Cooldowns()
		assert.equal(c.hit('u', 1000), 0)
		assert.ok(c.hit('u', 1000) > 0)
	})
})

describe('jid helpers', () => {
	it('normalizes device suffixes', () => {
		assert.equal(normalizeJid('123:4@s.whatsapp.net'), '123@s.whatsapp.net')
	})

	it('matches Mexican numbers with and without the 1', () => {
		assert.equal(matchesAny('5215512345678@s.whatsapp.net', ['525512345678']), true)
		assert.equal(matchesAny('999@s.whatsapp.net', ['525512345678']), false)
	})
})

describe('GroupCache', () => {
	it('coalesces concurrent lookups into one query', async () => {
		let calls = 0
		const sock = {
			user: { id: '1:2@s.whatsapp.net' },
			groupMetadata: async (id: string) => {
				calls++
				await sleep(10)
				return { id, participants: [] }
			}
		} as unknown as SocketLike
		const g = new GroupCache()
		await Promise.all([g.get(sock, 'g@g.us'), g.get(sock, 'g@g.us'), g.get(sock, 'g@g.us')])
		await g.get(sock, 'g@g.us')
		assert.equal(calls, 1)
	})
})
