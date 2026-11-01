import type { CommandContext } from '../../src/index.ts'

// Estilo Sukuna: export default { command, category, run } con acceso a { client, m }.
export default {
	command: ['hidetag', 'tag'],
	category: 'group',
	group: true,
	admin: true,
	run: async ({ client, m, chat, rest, engine }: CommandContext) => {
		const meta = await engine.groups.get(client, chat)
		const mentions = meta?.participants.map(p => p.id) ?? []
		await client.sendMessage(chat, { text: rest || '.', mentions }, { quoted: m })
	}
}
