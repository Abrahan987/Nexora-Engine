import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createEngine, type RawMessage, type SocketLike } from '../src/index.ts'

function fakeSocket(admins: string[] = []) {
	const sent: Array<{ jid: string; text: string }> = []
	let metaCalls = 0
	const sock = {
		user: { id: '111:1@s.whatsapp.net' },
		ev: { on() {}, off() {} },
		groupMetadata: async (id: string) => {
			metaCalls++
			return { id, participants: admins.map(a => ({ id: a, admin: 'admin' })) }
		},
		sendMessage: async (jid: string, content: Record<string, unknown>) => {
			sent.push({ jid, text: String(content.text) })
		}
	} as unknown as SocketLike
	return { sock, sent, metaCalls: () => metaCalls }
}

const msg = (id: string, text: string, chat = 'u@s.whatsapp.net', participant?: string): RawMessage => ({
	key: { id, remoteJid: chat, participant },
	message: { conversation: text }
})

async function setup(files: Record<string, string>, opts = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'nexora-'))
	for (const [name, src] of Object.entries(files)) await writeFile(join(dir, name), src)
	const engine = createEngine({ pluginsDir: dir, booster: false, owners: ['999'], ...opts })
	await engine.start()
	return engine
}

describe('NexoraEngine', () => {
	it('runs plugins in both named-export and default-object styles', async () => {
		const engine = await setup({
			'a.mjs': `export const command = ['ping']; export default async (ctx) => ctx.reply('pong ' + ctx.args.join(','))`,
			'b.mjs': `export default { command: ['hola'], run: async ({ client, m }) => client.sendMessage(m.key.remoteJid, { text: 'hi' }) }`
		})
		const { sock, sent } = fakeSocket()
		await engine.handle(sock, msg('1', '.ping a b'))
		await engine.handle(sock, msg('2', '.hola'))
		assert.deepEqual(sent.map(s => s.text), ['pong a,b', 'hi'])
		await engine.stop()
	})

	it('drops duplicate message ids', async () => {
		const engine = await setup({ 'a.mjs': `export const command = ['ping']; export default (c) => c.reply('x')` })
		const { sock, sent } = fakeSocket()
		await engine.handle(sock, msg('1', '.ping'))
		await engine.handle(sock, msg('1', '.ping'))
		assert.equal(sent.length, 1)
		assert.equal(engine.stats().duplicates, 1)
		await engine.stop()
	})

	it('enforces owner and admin permissions', async () => {
		const engine = await setup({
			'o.mjs': `export const command = ['own']; export const owner = true; export default (c) => c.reply('ok')`,
			'a.mjs': `export const command = ['adm']; export const admin = true; export default (c) => c.reply('ok')`
		})
		const { sock, sent, metaCalls } = fakeSocket(['5@s.whatsapp.net'])
		const g = '1@g.us'
		await engine.handle(sock, msg('1', '.own', 'u@s.whatsapp.net'))
		await engine.handle(sock, msg('2', '.adm', g, '6@s.whatsapp.net'))
		await engine.handle(sock, msg('3', '.adm', g, '5:7@s.whatsapp.net'))
		await engine.handle(sock, msg('4', '.adm', g, '5@s.whatsapp.net'))
		assert.equal(sent[0]?.text.includes('owner'), true)
		assert.equal(sent[1]?.text.includes('admins'), true)
		assert.equal(sent[2]?.text, 'ok')
		assert.equal(sent[3]?.text, 'ok')
		assert.equal(metaCalls(), 1)
		await engine.stop()
	})

	it('applies per-user cooldowns', async () => {
		const engine = await setup({ 'c.mjs': `export const command = ['c']; export const cooldown = 5000; export default (c) => c.reply('ok')` })
		const { sock, sent } = fakeSocket()
		await engine.handle(sock, msg('1', '.c'))
		await engine.handle(sock, msg('2', '.c'))
		assert.equal(sent[0]?.text, 'ok')
		assert.match(sent[1]?.text ?? '', /Espera/)
		await engine.stop()
	})

	it('reports command errors without crashing', async () => {
		let seen: unknown
		const engine = await setup({ 'e.mjs': `export const command = ['boom']; export default () => { throw new Error('x') }` }, { onError: (e: unknown) => (seen = e) })
		const { sock } = fakeSocket()
		await engine.handle(sock, msg('1', '.boom'))
		assert.ok(seen instanceof Error)
		assert.equal(engine.stats().errors, 1)
		await engine.stop()
	})

	it('lets middleware short-circuit processing', async () => {
		const engine = await setup({ 'a.mjs': `export const command = ['ping']; export default (c) => c.reply('x')` })
		engine.use(ctx => ctx.text.includes('spam'))
		const { sock, sent } = fakeSocket()
		await engine.handle(sock, msg('1', '.ping spam'))
		assert.equal(sent.length, 0)
		await engine.stop()
	})
})
