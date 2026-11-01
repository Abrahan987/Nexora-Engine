import { createEngine } from '../src/index.ts'
// import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys'

const engine = createEngine({
	prefixes: ['.', '!', '#'],
	owners: ['5210000000000'],
	pluginsDir: new URL('./plugins', import.meta.url).pathname,
	watchPlugins: true,
	concurrency: 8,
	maxMessageAgeSec: 60,
	store: { file: './data/nexora.json' },
	booster: { intervalMs: 60_000, heapLimitMb: 512, tmpDir: './tmp' }
})

await engine.start()

// const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
// const sock = makeWASocket({ auth: state })
// sock.ev.on('creds.update', saveCreds)
// engine.attach(sock)

process.on('SIGINT', async () => {
	await engine.stop()
	process.exit(0)
})
