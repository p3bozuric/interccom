# interccom Plan 1: Core (hub + session plugin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `voice-reply` POC with `interccom` core. One hub per machine owns the mic and the speakers. Every Claude Code session runs the interccom plugin, speaks through the hub and receives routed speech. Sessions have speakable names, can be addressed by name, and never talk over each other.

**Architecture:** A detached Node process (the hub) serves a token-protected HTTP API on 127.0.0.1. It runs the listener (ffmpeg → VAD → STT → router) and a single talk queue (priority → TTS → ffplay). Each session's hooks module spawns `hub/connect.mjs`. That process makes sure the hub is running, registers the session, and streams hub events to the module as NDJSON on stdout. The module calls the hub API with `$.http.fetch`. Pure logic (text cleanup, routing, VAD, board, queue, delivery) lives in small modules tested with `node --test`.

**Tech Stack:**
- Node 18+ ESM, no npm dependencies (built-ins only: `node:http`, `node:test`, `fetch`, `FormData`)
- Claude Code hooks module in TypeScript (`claude-code` types, Claude Code 2.1.316)
- ffmpeg/ffplay
- ElevenLabs TTS (`/v1/text-to-speech`) and STT (Scribe, `/v1/speech-to-text`)

**Spec:** `docs/superpowers/specs/2026-10-31-interccom-design.md`. This plan covers: The hub; The interccom plugin (worker role only); Voice interaction (wake word, name addressing, stop/quiet); Models and engines (ElevenLabs, engine interface); the no-coordinator behaviour of goals 1, 2 and 6. Plans 2 to 4 cover the coordinator, voice approvals, and the public release (setup, macOS/Linux, surfaces, README).

**POC to port from:** the `voice-reply` proof-of-concept dev-mod (not part of this repo). Read `hooks/register.ts`, `helper/speak.mjs` and `helper/listen.mjs` before starting; most logic moves over as-is.

## Global Constraints

- **Plugin name:** `interccom`. Its tool is called `mcp__interccom__speak`. No name may start with `claude-`.
- **Hooks module:** every function that receives `$` is a top-level `function` declaration, either in the hooks file or in a file the module imports. The validator rejects closures that take `$`. The module never uses `import()`.
- **Audio never enters the hooks module.** `$.http.fetch` bodies are text, and `$.audio.play` plays nothing on Windows.
- **The hub is spawned detached** (`detached: true`, `stdio: 'ignore'`, `.unref()`), so a hot reload, which kills `$.process.spawn` children, doesn't kill it.
- **Hub network exposure:**
  - it listens only on `127.0.0.1`
  - every request needs the header `x-interccom-token: <token>`
  - it writes `{ port, token, pid }` to `<stateDir>/hub.json`, where `stateDir = path.join(os.homedir(), '.interccom')`
- **Defaults:**

  | Setting | Value |
  |---|---|
  | voice | `21m00Tcm4TlvDq8ikWAM` |
  | TTS model | `eleven_flash_v2_5` |
  | STT model | `scribe_v1` |
  | STT language | `en` (`auto` sends no language) |
  | listen mode | `wake` |

- **Spoken text** is capped at 400 characters.
- **Priority order:** `question` > `heads-up` > `status`, first in, first out within each level.
- **Echo guard:** ignore mic audio while playing and for 400 ms after.
- **VAD** (16 kHz mono s16le, 480-sample frames = 30 ms):

  | Parameter | Frames | Time |
  |---|---|---|
  | start | 3 | 90 ms |
  | end silence | 54 | 1.6 s |
  | preroll | 10 | 300 ms |
  | minimum loud | 12 | 360 ms |
  | max length | 1000 | 30 s |

  Threshold `max(floor*3, 350)`. The floor follows quiet frames as an exponential moving average: `floor = floor*0.98 + level*0.02`, starting at 200.
- **Wake regex:** `/^\s*(?:(?:hey|hi|okay|ok)[\s,.!-]*(?:claude|claud|cloud|clod|klod)|claude)\b[\s,.!?:-]*/i`. A bare wake word arms the next utterance for 10 000 ms.
- **API key order:** plugin config, then `ELEVENLABS_API_KEY`, then on Windows `reg query HKCU\Environment /v ELEVENLABS_API_KEY`.
- **Hub idle exit:** 30 000 ms after the last event stream closes.
- **Tests:** `npm test` runs `node --test` over `tests/**/*.test.mjs` and `tests/**/*.test.ts`. Node 23.6+ strips types natively. On Node 18 to 22 the `.ts` tests need `--experimental-strip-types`; the `test` script passes it.

## Review Focus

1. **The hub dies mid-session** (crash, killed by Task Manager, laptop sleep). Expected: within about 10 s, sessions reconnect and a new hub starts. No session is left permanently mute. → Task 7 `relaunches after the hub is killed`.
2. **Two sessions start at the same moment.** Expected: exactly one hub; both sessions register with it. → Task 7 `concurrent ensureHub calls start one hub`.
3. **Two sessions in folders with the same name** (`~/a/api` and `~/b/api`). Expected: names `api` and `api-2`; "hey Claude, api-2: …" reaches the second one. → Task 4 `dedupes names`, Task 6 `routes by deduped name`.
4. **The key lacks STT permission, or is invalid or out of quota.** Expected: one plain-language error event naming the fix (enable "Speech to Text" on the key), not one per utterance. Speaking keeps working. → Task 5 `maps 401 missing_permissions to permission error`, Task 6 `rate-limits identical errors`.
5. **Claude passes markdown, code, a path or a URL to speak.** Expected: code blocks dropped, markdown symbols removed, URLs said as "a link", capped at 400 characters at a sentence boundary when there is one. → Task 2 `toSpeakable` tests.

---

## File structure

```
interccom/
  .claude-plugin/plugin.json        manifest + userConfig
  .claude-plugin/marketplace.json   local/dev + later public marketplace (source "./")
  hooks/hooks.json                  { "modules": ["./register.ts"] }
  hooks/register.ts                 hook wiring only
  hooks/hub-link.ts                 top-level fns taking $: start/stop connection, hub calls, event handling
  hooks/delivery.ts                 pure: busy flag + heard-mid-turn queue
  hooks/guidance.ts                 GUIDANCE system-prompt text
  hub/main.mjs                      hub CLI entry (detached process)
  hub/server.mjs                    createHub(): HTTP API, events, wiring
  hub/board.mjs                     Board: sessions, names, active, busy
  hub/queue.mjs                     TalkQueue: priority queue
  hub/text.mjs                      toSpeakable()
  hub/router.mjs                    route(): wake word, arming, name addressing, stop
  hub/vad.mjs                       createVad()
  hub/wav.mjs                       pcmToWav()
  hub/keys.mjs                      resolveApiKey()
  hub/engines/elevenlabs.mjs        tts(), stt(), EngineError
  hub/audio/windows.mjs             listMics(), captureArgv(), playArgv()
  hub/listener.mjs                  startListener(): ffmpeg → VAD → onUtterance
  hub/player.mjs                    createPlayer(): queue → tts → play, echo guard state
  hub/launch.mjs                    ensureHub()
  hub/connect.mjs                   CLI the plugin spawns: ensureHub → register → stream events
  tests/...                         mirrors hub/ and hooks/
  package.json  .gitignore  LICENSE (MIT)
```

---

### Task 1: Repository and empty plugin that loads

**Files:**
- Create: `package.json`, `.gitignore`, `LICENSE`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `hooks/register.ts`, `tests/smoke.test.mjs`

**Interfaces:**
- Produces: the plugin loads as `interccom` from a folder marketplace; `npm test` runs.

- [ ] **Step 1:** `git init` in the repo folder (the folder already holds `docs/`), then `git branch -m main`.
- [ ] **Step 2:** Write `package.json`. Contents:
  - `"name": "interccom"`, `"private": true`, `"type": "module"`
  - `"engines": { "node": ">=18" }`
  - `"scripts": { "test": "node --experimental-strip-types --test tests/" }`; on Node 25 the flag is accepted and does nothing
- [ ] **Step 3:** Write `.gitignore` with `node_modules/`, `.claude-plugin/types/` and `*.log`. Write the MIT `LICENSE` with copyright holder "interccom contributors".
- [ ] **Step 4:** Write `.claude-plugin/plugin.json`:
  - `name: "interccom"`, `version: "0.1.0"`, `license: "MIT"`
  - description: "One voice for all your Claude Code sessions: hear conclusions and questions, talk back hands-free."
  - `userConfig` fields:

    | Field | Type | Settings |
    |---|---|---|
    | `elevenlabs_api_key` | string | sensitive |
    | `voice_id` | string | default `21m00Tcm4TlvDq8ikWAM` |
    | `tts_model` | string | default `eleven_flash_v2_5`, options `eleven_flash_v2_5`, `eleven_turbo_v2_5`, `eleven_multilingual_v2` |
    | `stt_language` | string | default `en` |
    | `listen_mode` | string | default `wake`, options `always`, `wake`, `off` |
    | `muted` | boolean | default `false` |

  - Copy each field's title and description from the POC's manifest, adjusted for the new name.
- [ ] **Step 5:** Write `.claude-plugin/marketplace.json` listing one plugin `interccom` with `"source": "./"`. Write `hooks/hooks.json` as `{ "modules": ["./register.ts"] }`. Write `hooks/register.ts` exporting a `register: Register` that hooks nothing yet.
- [ ] **Step 6:** Write `tests/smoke.test.mjs`. Test `manifest names the plugin interccom`: read `.claude-plugin/plugin.json` and `assert.equal(json.name, 'interccom')`.
- [ ] **Step 7:** Run `npm test` and expect 1 pass. Run `claude plugin validate .` and expect `✔ Validation passed`; warnings are allowed, errors are not.
- [ ] **Step 8:** Commit: `chore: scaffold interccom plugin`.

---

### Task 2: Speakable text and routing (pure)

**Files:**
- Create: `hub/text.mjs`, `hub/router.mjs`, `tests/hub/text.test.mjs`, `tests/hub/router.test.mjs`

**Interfaces:**
- Produces:
  - `toSpeakable(text: string, max = 400): string`
  - `route(text: string, ctx: { mode: 'always'|'wake'|'off', names: string[], armedUntil: number, now: number, armMs?: number }): RouteResult`, where
    `RouteResult = { kind: 'deliver', text: string, name?: string } | { kind: 'stop' } | { kind: 'arm', until: number } | { kind: 'ignore' }`

- [ ] **Step 1: Write the failing tests.**

```js
// tests/hub/text.test.mjs
test('drops fenced code', () => assert.equal(toSpeakable('Done.\n```js\nx()\n```\nAll good.'), 'Done. All good.'))
test('strips markdown symbols', () => assert.equal(toSpeakable('**Tests** _pass_ in `api`'), 'Tests pass in api'))
test('says URLs as a link', () => assert.equal(toSpeakable('See https://x.io/a?b=1 now'), 'See a link now'))
test('caps at a sentence boundary', () => {
  const s = 'One sentence here. ' + 'x'.repeat(500)
  assert.equal(toSpeakable(s), 'One sentence here.')
})
test('hard-caps without a boundary', () => assert.equal(toSpeakable('y'.repeat(500)).length, 400))
test('collapses whitespace', () => assert.equal(toSpeakable('a\n\n  b'), 'a b'))

// tests/hub/router.test.mjs
const base = { mode: 'wake', names: ['api', 'frontend'], armedUntil: 0, now: 1000 }
test('wake + text delivers stripped text', () => assert.deepEqual(route('Hey Claude, run the tests.', base), { kind: 'deliver', text: 'run the tests.' }))
test('cloud spelling counts', () => assert.deepEqual(route('Hey, Cloud. What time is it?', base), { kind: 'deliver', text: 'What time is it?' }))
test('no wake word is ignored', () => assert.deepEqual(route('Cloud deployment is broken', base), { kind: 'ignore' }))
test('bare wake arms 10s', () => assert.deepEqual(route('hey claude', base), { kind: 'arm', until: 11000 }))
test('armed accepts next utterance', () => assert.deepEqual(route('run it', { ...base, armedUntil: 5000 }), { kind: 'deliver', text: 'run it' }))
test('expired arm ignores', () => assert.deepEqual(route('run it', { ...base, armedUntil: 900 }), { kind: 'ignore' }))
test('name addressing', () => assert.deepEqual(route('Hey Claude, frontend: run the tests', base), { kind: 'deliver', text: 'run the tests', name: 'frontend' }))
test('name addressing is case-insensitive and allows comma', () => assert.deepEqual(route('hey claude API, status?', base), { kind: 'deliver', text: 'status?', name: 'api' }))
test('unknown name stays in text', () => assert.deepEqual(route('hey claude backend: go', base), { kind: 'deliver', text: 'backend: go' }))
test('stop and quiet', () => {
  assert.deepEqual(route('Hey Claude, stop.', base), { kind: 'stop' })
  assert.deepEqual(route('hey claude quiet', base), { kind: 'stop' })
})
test('always mode delivers without wake word and still strips one', () => {
  assert.deepEqual(route('run it', { ...base, mode: 'always' }), { kind: 'deliver', text: 'run it' })
  assert.deepEqual(route('Hey Claude, run it', { ...base, mode: 'always' }), { kind: 'deliver', text: 'run it' })
})
test('off ignores everything', () => assert.deepEqual(route('hey claude run', { ...base, mode: 'off' }), { kind: 'ignore' }))
```

- [ ] **Step 2:** Run `npm test` and expect these tests to FAIL (modules missing).
- [ ] **Step 3: Implement `toSpeakable`.** Order:
  1. remove fenced blocks
  2. replace `https?://\S+` with `a link`
  3. remove `` ` ``, `*`, `_`, `#` and leading `>`
  4. collapse whitespace and trim
  5. if longer than `max`, cut at the last `. `, `! ` or `? ` at or before `max`; with no such boundary, take the first `max` characters
- [ ] **Step 4: Implement `route`.**
  - Use the wake regex from Global Constraints.
  - A stop phrase, after the wake word or while armed, matches `^(stop|quiet|be quiet|shut up)\W*$`.
  - Name addressing matches `^([\w-]{1,30})[,:]\s+(.+)$` against the remaining text. It applies only when `$1.toLowerCase()` is in `names` (compared lower-case).
  - `deliver` that results from an armed state also counts as consumed. The caller resets `armedUntil` to 0 on any `deliver` or `stop`.
- [ ] **Step 5:** Run `npm test` and expect PASS.
- [ ] **Step 6:** Commit: `feat(hub): speakable text and voice routing`.

---

### Task 3: VAD and WAV (pure)

**Files:**
- Create: `hub/vad.mjs`, `hub/wav.mjs`, `tests/hub/vad.test.mjs`, `tests/hub/wav.test.mjs`

**Interfaces:**
- Produces:
  - `createVad(opts?: Partial<{ startFrames: 3, endFrames: 54, preroll: 10, minLoud: 12, maxFrames: 1000, minThreshold: 350 }>): { push(frame: Buffer): Buffer | null, reset(): void }`. `frame` is exactly 960 bytes (480 s16le samples). `push` returns the finished utterance's PCM, or `null`.
  - `pcmToWav(pcm: Buffer, rate = 16000): Buffer` (44-byte header, mono, 16-bit)

- [ ] **Step 1: Write the failing tests.** Use a helper `tone(amplitude)` that makes a 960-byte frame of a 440 Hz sine, and `silence()` that makes zeros.
  - `ignores silence`: 200 silent frames → every `push` returns `null`.
  - `ends after 54 quiet frames`: 20 silent, 30 loud (amplitude 8000), then quiet. The first non-null return is at exactly the 54th quiet frame. Its length equals `(10 preroll + 30 loud + 54 quiet) * 960`. The preroll holds the last 10 frames before the start, including the 3 start frames, which belong to the segment.
  - `drops blips under minLoud`: 5 loud frames, then 60 quiet → all `null`.
  - `caps at maxFrames`: 1100 loud frames → a non-null return at frame index ≤ 1000 + 10.
  - `reset clears a segment in progress`: 30 loud, `reset()`, 60 quiet → all `null`.
  - wav: `pcmToWav(Buffer.alloc(32000))` has length 32044; bytes 0–3 are `RIFF`; `readUInt32LE(24) === 16000`; `readUInt16LE(22) === 1`.
- [ ] **Step 2:** Run `npm test` and expect FAIL.
- [ ] **Step 3:** Implement both, porting `onFrame`/`rms`/`wav` from the POC's `helper/listen.mjs` (values in Global Constraints).
- [ ] **Step 4:** Run `npm test` and expect PASS.
- [ ] **Step 5:** Commit: `feat(hub): VAD and WAV encoding`.

---

### Task 4: Session board and talk queue (pure)

**Files:**
- Create: `hub/board.mjs`, `hub/queue.mjs`, `tests/hub/board.test.mjs`, `tests/hub/queue.test.mjs`

**Interfaces:**
- Produces:
  - `class Board`. All times are ms since epoch, passed in.
    - `register({ name: string, cwd: string, pid: number }, now: number): { sessionId: string, name: string }`
    - `remove(sessionId: string): void`
    - `rename(sessionId: string, name: string): string` (returns the deduped name)
    - `setBusy(sessionId: string, busy: boolean, now: number): void`
    - `markActive(sessionId: string, now: number): void`
    - `setLastLine(sessionId: string, text: string, now: number): void`
    - `get(sessionId: string): SessionRow | undefined`
    - `byName(name: string): SessionRow | undefined` (case-insensitive)
    - `defaultTarget(): SessionRow | undefined`: the most recent `lastActiveAt`, else the most recently registered
    - `list(): SessionRow[]`
    - `get size(): number`
  - `SessionRow = { sessionId, name, cwd, pid, busy, registeredAt, lastActiveAt: number|0, lastLine: string|'', changedAt }`
  - `normalizeName(raw: string): string`: lower-case; spaces and underscores become `-`; drop everything except `[a-z0-9-]`; trim `-`; at most 30 characters; empty becomes `session`.
  - `class TalkQueue`:
    - `push(item: { sessionId: string, name: string, text: string, priority: 'question'|'heads-up'|'status' }): void`
    - `next(): item | undefined`
    - `flush(): number` (removes non-questions; returns how many)
    - `get size(): number`

- [ ] **Step 1: Write the failing tests.**
  - `dedupes names`:

    ```js
    const b = new Board()
    const r1 = b.register({ name: 'api', cwd: '/a/api', pid: 1 }, 1)
    const r2 = b.register({ name: 'API', cwd: '/b/api', pid: 2 }, 2)
    assert.equal(r1.name, 'api')
    assert.equal(r2.name, 'api-2')
    ```

  - `freed name is reused`: register `api`, remove it, register again → `api`.
  - `normalizeName`: `'My Project_X!'` → `'my-project-x'`; `''` → `'session'`.
  - `defaultTarget prefers last active`: register A at t=1 and B at t=2 → B. `markActive(A, 3)` → A.
  - `byName is case-insensitive`.
  - queue `orders by priority then FIFO`: push status s1, question q1, heads-up h1, question q2 → `next()` gives q1, q2, h1, s1.
  - queue `flush keeps questions`: push s1, q1, h1 → `flush()` returns 2, then `next()` is q1 and `size` is 0.
- [ ] **Step 2:** Run `npm test` and expect FAIL.
- [ ] **Step 3:** Implement. `sessionId` = `crypto.randomUUID()`. Dedupe: try `name`, then `name-2`, `name-3`, and so on, against the names currently held.
- [ ] **Step 4:** Run `npm test` and expect PASS.
- [ ] **Step 5:** Commit: `feat(hub): session board and priority talk queue`.

---

### Task 5: ElevenLabs engine and key resolution

**Files:**
- Create: `hub/engines/elevenlabs.mjs`, `hub/keys.mjs`, `tests/hub/elevenlabs.test.mjs`, `tests/hub/keys.test.mjs`

**Interfaces:**
- Produces:
  - `class EngineError extends Error { code: 'auth'|'permission'|'quota'|'network'|'other' }`. `message` is plain words plus the fix.
  - `tts(text: string, o: { apiKey, voiceId, modelId, fetch?: typeof fetch }): Promise<Buffer>` (mp3). POST `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, body `{ text, model_id }`, header `xi-api-key`.
  - `stt(wav: Buffer, o: { apiKey, model = 'scribe_v1', language?: string, fetch? }): Promise<string>`. POST `https://api.elevenlabs.io/v1/speech-to-text`. Multipart fields `model_id`, `tag_audio_events='false'`, `language_code` (only when `language` is set and not `auto`), and `file` (`utterance.wav`, `audio/wav`). Returns `json.text.trim()`.
  - `resolveApiKey(o: { configKey?: string, env: Record<string,string|undefined>, platform: string, readRegistry?: () => string }): string`

- [ ] **Step 1: Write the failing tests** with a fake `fetch` that records the request and returns a canned `Response`.
  - `tts posts text and model and returns bytes`: the fake returns `new Response(new Uint8Array([1,2,3]))`. Assert the URL contains `/text-to-speech/v1`, the body JSON is `{ text: 'hi', model_id: 'm' }`, the header is `xi-api-key: k`, and the result equals `Buffer.from([1,2,3])`.
  - `stt sends language only when set`: call with `language: 'en'` → the form has `language_code=en`. Call with `'auto'` → no `language_code`.
  - `maps 401 missing_permissions to permission error`: the fake returns status 401 with body `{"detail":{"status":"missing_permissions","message":"The API key you used is missing the permission speech_to_text to execute this operation."}}` → it rejects with `code === 'permission'`, and `message` contains `Speech to Text`.
  - `maps 401 invalid key to auth`: body `{"detail":{"status":"invalid_api_key"}}` → `code === 'auth'`.
  - `maps 429 and quota_exceeded to quota`.
  - `maps fetch rejection to network`.
  - keys: config wins over env; env wins over registry; on `platform !== 'win32'` the registry is not called; registry output `"    ELEVENLABS_API_KEY    REG_SZ    sk_abc\r\n"` → `sk_abc`; nothing found → `''`.
- [ ] **Step 2:** Run `npm test` and expect FAIL.
- [ ] **Step 3: Implement.** `readRegistry` defaults to `execFileSync('reg', ['query','HKCU\\Environment','/v','ELEVENLABS_API_KEY'], { encoding: 'utf8', windowsHide: true })`, inside try/catch returning `''`. Error messages, verbatim:
  - permission: `Your ElevenLabs API key is missing a permission (<speech_to_text|text_to_speech>). In ElevenLabs → API keys, edit the key and enable Speech to Text and Text to Speech.` Name the permission from the response.
  - auth: `ElevenLabs rejected the API key. Check it in /plugin settings for interccom or in ELEVENLABS_API_KEY.`
  - quota: `ElevenLabs quota or rate limit reached. Check your plan's usage at elevenlabs.io.`
  - network: `Couldn't reach ElevenLabs. Check your internet connection.`
- [ ] **Step 4:** Run `npm test` and expect PASS.
- [ ] **Step 5:** Commit: `feat(hub): ElevenLabs TTS/STT engine with plain-language errors`.

---

### Task 6: Hub server

**Files:**
- Create: `hub/server.mjs`, `hub/player.mjs`, `hub/main.mjs`, `tests/hub/server.test.mjs`

**Interfaces:**
- Consumes: Board, TalkQueue (Task 4); `route` and `toSpeakable` (Task 2); `tts`/`stt`/`EngineError` (Task 5)
- Produces:
  - `createHub(o: { token: string, engines: { tts(text, cfg): Promise<Buffer>, stt(wav, cfg): Promise<string> }, audio: { play(mp3: Buffer, signal: AbortSignal): Promise<void> }, now?: () => number, idleExitMs?: number = 30000, onIdleExit?: () => void }): { listen(port?: number): Promise<{ port: number }>, close(): Promise<void>, hear(text: string): Promise<void>, isPlaying(): boolean, mutedUntil(): number }`
    - `hear` is how the listener (Task 8) feeds transcripts in.
    - `isPlaying`/`mutedUntil` are the listener's echo guard: `mutedUntil` is the end of the last playback + 400.
  - `createPlayer(o: { queue, engines, audio, getConfig, onError, boardSize: () => number, now })`: an internal helper of `server.mjs`, exported for tests.
  - **HTTP API.** Every route needs `x-interccom-token`; without it the hub answers 401. JSON in and out.
    - `GET /health` → `{ ok: true, sessions: number }`
    - `POST /sessions {name, cwd, pid}` → `{ sessionId, name }`
    - `DELETE /sessions/:id` → `{}`
    - `POST /sessions/:id/name {name}` → `{ name }`
    - `POST /sessions/:id/state {busy}` → `{}`
    - `POST /sessions/:id/active` → `{}`
    - `POST /config {apiKey?, voiceId?, ttsModel?, sttLanguage?, listenMode?, muted?}` → `{}`. Fields merge; a later session's non-empty field overrides. Only `listenMode` from `POST /listen` is sticky.
    - `POST /speak {sessionId, text, priority}` → `{ queued: true, spoken: string }`. `spoken` is the `toSpeakable` result; an empty result → `{ queued: false }`.
    - `POST /listen {mode}` → `{ mode }`
    - `POST /stop` → `{ flushed: number }`. It aborts current playback.
    - `GET /board` → `{ sessions: SessionRow[], mode, playing: boolean }`
    - `GET /events?session=:id` keeps the response open. It writes NDJSON lines:
      - `{type:'hello', sessionId, name}` right away
      - `{type:'heard', text}`
      - `{type:'mic', state: 'listening'|'off'|'paused'}`
      - `{type:'error', message}`

      Closing the stream removes the session from the board. When the board becomes empty, the idle timer starts.

- [ ] **Step 1: Write the failing tests** (in-process: `createHub` with fake engines and audio, `listen(0)`, real `fetch`).
  - `rejects requests without token` → 401.
  - `register, stream hello, deregister on close`: POST `/sessions`, open `/events`, read the first line (hello with the same name). Abort the stream → after a tick, `/health.sessions === 0`.
  - `plays one item at a time in priority order`:
    - Fake `tts` returns `Buffer.from(text)`.
    - Fake `audio.play` waits on a `gate` promise the test controls, then records `mp3.toString()`.
    - Register one session. POST status 'a', question 'b', heads-up 'c'. Then open the gate.
    - Played order: `['a', 'b', 'c']`, since 'a' was already taken off the queue when the others arrived.
    - Repeat with a fresh hub where the gate is closed before the first POST, and `createPlayer` takes items only once the gate opens (test option `startPaused: true`) → `['b', 'c', 'a']`.
    - Peak concurrent `play` calls is 1 in both cases.
  - `prefixes the name when more than one session`: two sessions → played text `'api: done'`. One session → `'done'`.
  - `routes by deduped name`: register `api` twice (→ `api`, `api-2`), open both event streams, `hear('Hey Claude, api-2: hello')` → only stream 2 gets `{type:'heard', text:'hello'}`.
  - `routes to last active without a name`: two sessions; POST `/active` for the first; `hear('hey claude go')` → the first stream gets `heard`.
  - `stop flushes non-questions and aborts playback`: the abort signal passed to `play` fires; `flushed` equals the number of queued non-questions.
  - `rate-limits identical errors`: the fake `stt` throws `EngineError('permission', 'X')`. A loop calling `hub.hear` won't trigger `stt`, so instead call the exported `reportError(err)` twice within 60 s → each stream gets exactly one `error` line. Export `reportError` on the returned object for tests; identical messages are suppressed for 60 000 ms.
  - `idle exit after last stream closes`: `idleExitMs: 50`, open and close one stream → `onIdleExit` called within 200 ms. Opening a stream before it fires cancels it.
- [ ] **Step 2:** Run `npm test` and expect FAIL.
- [ ] **Step 3: Implement `createHub`.** Use `node:http` only.
  - Routing: `route()` with `ctx.names = board.list().map(r => r.name)` and the hub's `armedUntil`. The target is `board.byName(name) ?? board.defaultTarget()`, and the result goes to that session's open stream as `heard`.
  - `kind: 'stop'` → same as `POST /stop`. `kind: 'arm'` → set `armedUntil`.
- [ ] **Step 4: Implement `createPlayer`.** Loop: `queue.next()`, `tts`, `audio.play`. Then set `mutedUntil = now() + 400`, and record `board.setLastLine`. If `muted`, drop items without playing. TTS errors go to `onError`.
- [ ] **Step 5: Implement `hub/main.mjs`.**
  - Parse `--state-dir`. Generate the token with `crypto.randomBytes(24).toString('hex')`.
  - Real `engines`: Task 5's `tts`/`stt` bound to the config's key and models. Real `audio.play`: write the mp3 to `os.tmpdir()/interccom/<uuid>.mp3`, spawn the `playArgv(file)` from Task 8, kill it on `signal` abort, then delete the file.
  - `listen(0)`, then write `hub.json` `{ port, token, pid: process.pid }` with mode 0o600.
  - `onIdleExit`: delete `hub.json` if it still holds this pid, then exit.
  - Start the listener (Task 8) once `listenMode !== 'off'` and a key is configured.
- [ ] **Step 6:** Run `npm test` and expect PASS.
- [ ] **Step 7:** Commit: `feat(hub): HTTP hub with routing, priority playback, events`.

---

### Task 7: Launching and connecting

**Files:**
- Create: `hub/launch.mjs`, `hub/connect.mjs`, `tests/hub/launch.test.mjs`

**Interfaces:**
- Consumes: `hub/main.mjs` CLI (Task 6)
- Produces:
  - `ensureHub(o: { stateDir: string, hubEntry: string, timeoutMs?: 5000 }): Promise<{ port: number, token: string }>`:
    1. Read `hub.json` and `GET /health`. If it is OK, return.
    2. Otherwise take the launch lock: `mkdir <stateDir>/launch.lock`. A lock older than 10 s, or whose owner pid is dead, counts as stale and is removed.
    3. Re-check health.
    4. Spawn `process.execPath hubEntry --state-dir stateDir` detached.
    5. Poll `hub.json` and health every 100 ms until `timeoutMs`.
    6. Release the lock.
  - `hub/connect.mjs` CLI:
    - args `--name <n> --cwd <dir> --pid <n>`
    - env `INTERCCOM_API_KEY`, `INTERCCOM_VOICE_ID`, `INTERCCOM_TTS_MODEL`, `INTERCCOM_STT_LANGUAGE`, `INTERCCOM_LISTEN_MODE`, `INTERCCOM_MUTED`
    - steps: `ensureHub` → `POST /config` → `POST /sessions` → print `{type:'link', port, token, sessionId, name}` → open `/events` and copy each line to stdout. Exits with code 0 when the stream ends, 1 on errors (printing `{type:'error', message}` first).

- [ ] **Step 1: Write the failing tests** with a temp `stateDir` (`fs.mkdtempSync`) and the real `hub/main.mjs`. The listener is disabled by `listenMode: 'off'`, because no `/config` key is sent; Task 6's `main.mjs` doesn't start the listener without a key.
  - `starts a hub and reuses it`: two sequential `ensureHub` calls → the same port, one `hub.json` pid.
  - `concurrent ensureHub calls start one hub`: `Promise.all` of 3 calls → all return the same port. The file named by `INTERCCOM_TEST_LOG`, where `main.mjs` appends its pid on start whenever that env var is set, contains exactly one line.
  - `relaunches after the hub is killed`: `ensureHub`, `process.kill(pid)`, `ensureHub` again → a different pid, health OK.
  - Teardown kills any hub pid it saw.
- [ ] **Step 2:** Run `npm test` and expect FAIL.
- [ ] **Step 3:** Implement `ensureHub` and `connect.mjs`. `spawn(process.execPath, [hubEntry, '--state-dir', stateDir], { detached: true, stdio: 'ignore', windowsHide: true }).unref()`.
- [ ] **Step 4:** Run `npm test` and expect PASS.
- [ ] **Step 5:** Commit: `feat(hub): single-instance launch and session connect`.

---

### Task 8: Windows audio and the listener

**Files:**
- Create: `hub/audio/windows.mjs`, `hub/listener.mjs`, `tests/hub/windows-audio.test.mjs`, `tests/hub/listener.test.mjs`
- Modify: `hub/main.mjs` (start and stop the listener as the mode changes)

**Interfaces:**
- Consumes: `createVad`, `pcmToWav` (Task 3); `stt` (Task 5); `hub.hear`, `hub.isPlaying`, `hub.mutedUntil` (Task 6)
- Produces:
  - `parseDshowDevices(stderr: string): string[]` (audio devices only)
  - `listMics(): string[]`: runs `ffmpeg -hide_banner -list_devices true -f dshow -i dummy` with `spawnSync` and parses **both** stdout and stderr, whatever the exit code. That is the POC bug.
  - `captureArgv(mic: string): string[]` → `['-hide_banner','-loglevel','error','-f','dshow','-i',`audio=${mic}`,'-ac','1','-ar','16000','-f','s16le','-']`
  - `playArgv(file: string): [cmd: string, args: string[]]` → `['ffplay', ['-nodisp','-autoexit','-loglevel','error', file]]`
  - `startListener(o: { mic: string, spawn?: typeof child_process.spawn, vad, isMuted: () => boolean, onUtterance: (pcm: Buffer) => void, onError: (msg: string) => void, backoffMs?: [2000, 30000] }): { stop(): void }`

- [ ] **Step 1: Write the failing tests.**
  - `parseDshowDevices` against this captured fixture (a real Windows capture):

    ```
    [dshow @ 0000020000000000] "HD Webcam" (video)
    [dshow @ 0000020000000000]   Alternative name "@device_pnp_\\?\usb#vid_046d"
    [dshow @ 0000020000000000] "Microphone (USB Audio Device)" (audio)
    [dshow @ 0000020000000000]   Alternative name "@device_cm_{33D9A762}"
    ```

    → `['Microphone (USB Audio Device)']`. An empty string → `[]`.
  - `captureArgv` exact array equality.
  - listener with a fake `spawn` that returns an EventEmitter-based fake child (`stdout` PassThrough):
    - `emits utterance from VAD`: write 20 silent + 30 loud + 60 quiet frames → `onUtterance` called once.
    - `drops audio while muted`: `isMuted` returns true → no utterance.
    - `restarts ffmpeg with backoff after exit`: the fake child emits `close` with code 1 → `onError` called with a message containing `mic`; `spawn` is called again after ≥ 2000 ms. Use `t.mock.timers`.
    - `stop kills the child and doesn't restart`.
- [ ] **Step 2:** Run `npm test` and expect FAIL.
- [ ] **Step 3:** Implement. Muting: `isMuted = () => hub.isPlaying() || Date.now() < hub.mutedUntil()`; while muted, call `vad.reset()` per frame. `onUtterance` → `stt(pcmToWav(pcm), cfg)` → `hub.hear(text)`. STT errors → `hub.reportError`.
- [ ] **Step 4: Wire into `hub/main.mjs`.**
  - `POST /listen` and `POST /config` changes start or stop the listener.
  - The mic is the first entry of `listMics()` unless `INTERCCOM_MIC` is set. Plan 4 adds the picker.
  - Broadcast `{type:'mic', state}` to all streams.
- [ ] **Step 5:** Run `npm test` and expect PASS.
- [ ] **Step 6:** Commit: `feat(hub): Windows mic capture and listener`.

---

### Task 9: The session plugin

**Files:**
- Create: `hooks/delivery.ts`, `hooks/guidance.ts`, `hooks/hub-link.ts`, `tests/hooks/delivery.test.ts`
- Modify: `hooks/register.ts`

**Interfaces:**
- Consumes: the `connect.mjs` CLI and NDJSON (Task 7); the HTTP API (Task 6)
- Produces:
  - `createDelivery(): { setBusy(b: boolean): void, heard(text: string): 'submit' | 'queued', takeForToolResult(): string | undefined, takeAtTurnEnd(): string | undefined }`
  - `takeForToolResult` returns `The person just said (by voice, while you were working): "a" then "b"` and clears the queue.
  - `takeAtTurnEnd` returns the queued texts joined by `' '` and clears them.
  - `GUIDANCE: string`: the POC's text with these changes:
    - the tool is `mcp__interccom__speak`
    - it takes a `priority` (`question` for anything needing an answer, `heads-up` for "this will take a while", `status` for results)
    - add the line "Your session is called <name>; the person may address you by it."

    The name goes in through a function: `guidance(name: string): string`.

- [ ] **Step 1: Write the failing tests** (`tests/hooks/delivery.test.ts`):
  - idle → `heard('x') === 'submit'`
  - busy → `'queued'`, and `takeForToolResult()` is exactly `The person just said (by voice, while you were working): "x"`
  - two queued → `"a" then "b"`; a second take → `undefined`
  - `takeAtTurnEnd` after two queued → `'a b'`
- [ ] **Step 2:** Run `npm test` and expect FAIL. Implement `delivery.ts` and `guidance.ts`. Run again and expect PASS.
- [ ] **Step 3: Implement `hub-link.ts`.** Top-level functions only.
  - `startLink($: EngineInterface, opts: Record<string, unknown>, cwd: string): void`
    - Spawns `node ${$.plugin.root}/hub/connect.mjs --name <basename of cwd> --cwd <cwd> --pid 0` with the `INTERCCOM_*` env from `opts`.
    - Parses stdout lines:
      - `link` → keep `{port, token, sessionId, name}` in module state
      - `heard` → `onHeard`
      - `mic` → `$.ui.status('mic: ' + state)`
      - `error` → `$.ui.toast`
    - When the stream ends unintentionally, restart after 2000 ms with `$.clock.after`, following the POC's generation-counter pattern.
  - `stopLink(): void`
  - `hubCall($: EngineInterface, method: string, path: string, body?: unknown): Promise<unknown>`: `$.http.fetch('http://127.0.0.1:'+port+path, { method, headers: { 'x-interccom-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) })`. It throws a readable error when not linked.
- [ ] **Step 4: Rewrite `register.ts`.** Port the POC's hooks:
  - `session.start`: register the `speak` tool (`isDeferred: false`, input `{ text: string, priority?: 'question'|'heads-up'|'status' }`, default `status`); register `/listen` (`immediate: true`, `[always|wake|off]`) and `/interccom` (`immediate: true`, `name <name>` | `status`); then `startLink`.
  - `prompt.compose`: append the section `interccom:guidance` with `guidance(currentName)`.
  - `turn.start` / `turn.complete` (main loop only): `setBusy`, `POST /sessions/:id/state`. At `turn.complete`, `takeAtTurnEnd()` → `$.prompt.submit({ text, asUser: true })`.
  - `tool.call` (all tools, with `.catch(($, e, next) => next(e))`): after `next`, attach `takeForToolResult()` as `context`. Skip denies and subagent calls.
  - `tool.call` on `mcp__interccom__speak`: `POST /speak` → result `Speaking.`, or `Muted; nothing played.` when `opts.muted`. With the `.catch` fallback.
  - `prompt.submit`: when `e.origin.kind === 'composer'`, call `POST /sessions/:id/active`, then `next(e)`.
  - `command.run listen`: `POST /listen` → text `Listening mode: <mode>.`
  - `command.run interccom`:
    - `name <n>` → `POST /sessions/:id/name` → `This session is now called <name>.`
    - `status` → `GET /board` → one line per session: `<name> — busy|idle — <lastLine>`
  - Heard text → `delivery.heard()`. On `'submit'` → `$.prompt.submit({ text, asUser: true })`; on `'queued'` → `$.ui.toast('heard: ' + text.slice(0, 80))`.
- [ ] **Step 5:** Run `claude plugin validate .` and expect no errors.
- [ ] **Step 6:** Type-check. Once the plugin has loaded once, `.claude-plugin/types/tsconfig.json` exists: `npx -y -p typescript@5.6.3 tsc -p .` with a root `tsconfig.json` extending it → exit 0. Before the first load, use the scratch tsconfig approach the POC used.
- [ ] **Step 7:** Commit: `feat(plugin): session plugin talking to the hub`.

---

### Task 10: Switch over and test end to end

**Files:**
- Delete (outside the repo, after confirming with the owner): the `voice-reply` proof-of-concept dev-mod (not part of this repo)
- Create: `docs/testing/manual-e2e.md` (the checklist below, with results filled in)

- [ ] **Step 1:** Ask the owner to confirm, then delete the `voice-reply` dev-mod folder, so the two plugins don't both speak and listen.
- [ ] **Step 2: Install from the local marketplace.**

  ```
  claude plugin marketplace add <path to this repo>
  claude plugin install interccom@interccom
  ```

  Start two new terminals and sessions, in two different folders. Set the API key through `/plugin` config, or rely on the registry fallback.
- [ ] **Step 3: Run the manual checklist**, recording pass or fail and any notes in `docs/testing/manual-e2e.md`:
  1. Session A: "hey Claude, what's two plus two?" → A answers out loud, without its name (only one session).
  2. Start session B. Ask both to speak at once → no overlap, and each line is prefixed with its name.
  3. "Hey Claude, <B-name>: say hello" → only B responds.
  4. Speak to A mid-task (give A a 30-second job) → A acknowledges mid-task.
  5. "Hey Claude, stop" while it's talking → playback stops.
  6. `/listen off` → speech is ignored; `/listen wake` → it works again.
  7. End the hub process in Task Manager → within about 10 s speech works again.
  8. `/interccom status` lists both sessions.
- [ ] **Step 4:** Commit: `test: manual end-to-end results for core`.
