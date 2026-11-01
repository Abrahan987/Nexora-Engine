# Nexora Engine

Motor ligero y **sin dependencias en runtime** para acelerar bots de WhatsApp hechos con [Baileys](https://github.com/WhiskeySockets/Baileys). Nace de los patrones repetidos en bots como Yae-Miku-Bot y SUKUNA-V3-BETA (loader de plugins, cache de metadata de grupos, deduplicación de mensajes, base de datos) y los empaqueta en piezas reutilizables.

## Qué incluye

| Módulo | Qué hace |
|---|---|
| `NexoraEngine` | Pipeline completo: dedupe → middlewares → prefijo → permisos → cooldown → cola → plugin. |
| `PluginRegistry` | Carga plugins en paralelo y recarga en caliente **solo el archivo modificado**. Acepta estilo Yae (`export const command` + `export default fn`) y estilo Sukuna (`export default { command, run }`). |
| `GroupCache` | Cache LRU+TTL de `groupMetadata` que fusiona consultas simultáneas (una ráfaga de mensajes = 1 consulta) y se invalida con `groups.update` / `group-participants.update`. |
| `TaskQueue` / `KeyedQueue` | Concurrencia limitada con contrapresión, y ejecución en serie por chat opcional. |
| `HttpClient` | `fetch` con timeout, reintentos con backoff, cache TTL y fusión de GET idénticos en vuelo. Ideal para APIs externas. |
| `Store` | Colecciones JSON en memoria con persistencia diferida y atómica (write-behind). |
| `Booster` | Potenciador en segundo plano: poda caches, guarda el store, limpia temporales, mide lag del event loop y reacciona a presión de memoria. Sus timers no bloquean el cierre del proceso. |
| Helpers JID | `normalizeJid`, `jidUser`, `sameUser`, `matchesAny` (incluye variante `521`/`52` de México). |

## Uso

```ts
import { createEngine } from 'nexora-engine'
import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys'

const engine = createEngine({
  prefixes: ['.', '#'],
  owners: ['5210000000000'],
  pluginsDir: './plugins',
  watchPlugins: true,
  maxMessageAgeSec: 60,
  store: { file: './data/nexora.json' },
  booster: { intervalMs: 60_000, heapLimitMb: 512, tmpDir: './tmp' }
})
await engine.start()

const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
const sock = makeWASocket({ auth: state })
sock.ev.on('creds.update', saveCreds)
engine.attach(sock)
```

### Plugins

```ts
// Estilo Yae
export const command = ['ping']
export const cooldown = 3000
export default async (ctx) => ctx.reply('pong')

// Estilo Sukuna
export default {
  command: ['kick'], group: true, admin: true, botAdmin: true,
  run: async ({ client, m, chat, args }) => { /* ... */ }
}
```

Metadatos soportados: `command`, `category`, `description`, `admin`, `botAdmin`, `owner`, `group`, `private`, `cooldown` (ms por usuario).
El handler recibe un único `ctx` con `sock`/`client`, `msg`/`m`, `chat`, `sender`, `isGroup`, `isOwner`, `isAdmin`, `isBotAdmin`, `args`, `rest`, `reply()` y `engine`.

> Los plugins con firma antigua `(sock, msg, extra)` deben adaptarse a `(ctx)`.
> `isAdmin`/`isBotAdmin` solo se calculan cuando el plugin declara `admin`/`botAdmin`, para no consultar metadata innecesariamente.

### Middlewares

```ts
engine.use(ctx => ctx.text.includes('spam')) // devolver true detiene el procesamiento
```

### HTTP y store

```ts
const data = await engine.http.json('https://api.example.com/x', { query: { q: 'hola' }, cacheTtlMs: 30_000 })
const users = engine.store.collection<{ yen: number }>('users')
users.update(jid, { yen: 10 })
```

## Desarrollo

```bash
npm install
npm run typecheck
npm test
npm run build
```

Requiere Node >= 20.

## Licencia

MIT
