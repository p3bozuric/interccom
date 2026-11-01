# interccom

**Talk to your coding agents. Let them talk back.**

interccom gives your coding agents a voice and ears: Claude Code, Codex, GitHub Copilot CLI and OpenCode. The agent says out loud only what you need to hear: conclusions, questions, heads-ups. It never reads out reasoning, code or file paths. You answer by just talking. No push-to-talk, no Enter key, and you can do it while Claude is mid-task.

Run several sessions at once and they share one voice channel. They take turns, each says its name, and you can address one by name: *"Hey Claude, frontend: run the tests."* Or make one session the **coordinator**: you talk only to it, and it keeps track of the others for you.

Speech can run in the cloud (ElevenLabs, Deepgram, Soniox, OpenAI, Groq, Cartesia) or entirely on your machine (any OpenAI-compatible local speech server, or programs such as Piper and whisper.cpp).

> **Status: early alpha (v0.1).** Tested on Windows. macOS and Linux support is new and still needs testing on real machines. See the roadmap below.

## How it works

```
 mic ─► hub (one per machine) ─► speakers
          ▲            │
   speak  │            │  what you said
          │            ▼
   Claude Code sessions (interccom plugin in each)
```

- A small **hub** process runs in the background on your machine. It owns the mic and the speakers, so two sessions never talk over each other, and Claude never hears itself.
- Each Claude Code session gets a `speak` tool and instructions to use it sparingly, the way a colleague would.
- What you say is transcribed and routed:
  - If Claude is idle, it arrives as your next message.
  - If Claude is mid-task, it's attached to Claude's next step, so Claude can change course right away.

## Other coding agents: Codex, Copilot CLI, OpenCode

Sessions of every supported agent share one voice channel: one voice at a time, addressable by name ("Hey Claude, *api*: …", whatever the agent), all on the same board. With a coordinator running, they report to it.

| Agent | Install | How it hears you |
|---|---|---|
| Claude Code | `/plugin install interccom@interccom` (see [Install](#install)) | in-process plugin |
| Codex CLI 0.166+ | `codex plugin marketplace add p3bozuric/interccom`, then `codex plugin add interccom` | hooks + `codex queue` |
| GitHub Copilot CLI 1.0+ | `npx -y interccom copilot-setup` | in-process extension |
| OpenCode 1.19+ | `npx -y interccom opencode-setup` | in-process plugin |
| Any other MCP agent | add `interccom mcp` as an MCP server | speaks only, can't hear yet |

Until the npm package is published, run the same commands from a clone: `node path/to/interccom/hub/cli.mjs copilot-setup`.

- **Setup commands:**
  - `copilot-setup` writes `~/.copilot/extensions/interccom/extension.mjs`.
  - `opencode-setup` writes `~/.config/opencode/plugins/interccom.js`.
  - Each is a few lines that load interccom from wherever it's installed, so updating interccom needs no new setup. `--print` shows the file without writing it, and `--remove` deletes it. Neither command ever overwrites a file interccom didn't write.
- **Settings:** these agents have no interccom settings screen. Run `interccom setup` once (see [Setup](#setup)), or set `INTERCCOM_*` environment variables. The hub uses the settings of whichever session connected most recently.
- **Node.js:** the hub always runs on Node, even inside OpenCode (a Bun program) or Copilot. interccom finds `node` on PATH; set `INTERCCOM_NODE` if it's elsewhere.
- **Built-in voice:** Codex and Copilot CLI have voice input of their own. Keep it off while interccom listens, because only one program can own the mic.
- **Coordinator:** only a Claude Code session can be the coordinator, and Claude Code's SendMessage can't reach other agents. The coordinator can still pass your exact words to them (`relay`), but never instructions of its own.

### Codex

- **Hooks:** speech heard mid-turn is attached at Codex's next tool step, and speech heard as a turn ends keeps the turn going. Codex may ask you to trust the hooks the first time.
- **Idle:** speech heard while Codex is idle goes through `codex queue`. If Codex isn't on PATH as `codex`, set `INTERCCOM_CODEX_BIN`.
- **Manual setup:** without the plugin, `interccom codex-setup` prints a `~/.codex/config.toml` entry and a `~/.codex/hooks.json` to add.

### GitHub Copilot CLI

The extension runs alongside each Copilot session:
- it adds the `interccom_speak` and `interccom_board` tools;
- it puts the speaking guidance into the session;
- speech heard mid-turn arrives with the next tool result;
- speech heard while idle is sent as your next message.

Restart Copilot (or `/clear`) after setup.

### OpenCode

The plugin runs inside the OpenCode server:
- it adds `interccom_speak` and `interccom_board`;
- it adds the guidance to the system prompt;
- speech heard mid-turn is appended to the next tool result;
- speech heard while idle is sent to the session you last used. Subagent sessions are ignored.

OpenCode installs the `@opencode-ai/plugin` package the plugin needs by itself. Restart OpenCode after setup.

## Requirements

- Claude Code (with plugin support)
- Node.js 18.3 or newer, on PATH
- `ffmpeg` on PATH, plus `ffplay` on Windows and Linux (macOS plays through its built-in `afplay`):
  - Windows: `winget install Gyan.FFmpeg`
  - macOS: `brew install ffmpeg`. Allow your terminal to use the microphone when macOS asks.
  - Linux: `sudo apt install ffmpeg` (or your distribution's package). The mic is read through PulseAudio or PipeWire.
- Speech engines: an API key for a cloud provider (ElevenLabs, Deepgram, Soniox, OpenAI, Groq, Cartesia), or local models with no key and no cloud. See [Speech engines](#speech-engines).
- A microphone

## Install

In Claude Code (for other agents, see above):

```
/plugin marketplace add p3bozuric/interccom
/plugin install interccom@interccom
```

Claude Code asks which engines to use for talking and listening. Add the API key for each cloud engine you choose there, or as an environment variable (`setx DEEPGRAM_API_KEY your-key`, …). Then run `/interccom setup` to check everything. See [Setup](#setup).

## Using it

- **Talk:** start with the wake word, "Hey Claude, …". You can also say "Hey Claude", pause, and then talk within 10 seconds.
- **Address a session:** "Hey Claude, *api*: what's failing?" Session names come from the project folder; rename one with `/interccom name <name>`.
- **Stop it talking:** `/interccom stop`. Saying "Hey Claude, stop" works between sentences, not while audio is playing.
- **See all sessions:** `/interccom status`.
- **Listening mode:** `/listen wake` (default), `/listen always` (everything you say is sent), `/listen off`.

### The coordinator

Run `/interccom coordinator` in one session, ideally a dedicated one in an empty folder. From then on:

- everything you say goes to the coordinator. "Hey Claude, *api*: …" tells it which session you mean.
- the other sessions stop talking out loud and report to the coordinator. It decides what's worth saying, merges updates and names the session it's about.
- "Hey Claude, where are we?" gets a rundown, one sentence per session, open questions first.
- it passes your instructions on with Claude Code's own messaging (SendMessage), labelled as your words, so each session's permissions still apply.

How much it may decide on its own is the `autonomy` setting:

- `relay` (default): only passes things on and asks you about everything else.
- `routine`: also answers routine questions.
- `full`: decides like a careful senior engineer would.

Even with `full`, anything destructive or outward-facing comes back to you. Add your own rules in `autonomy_rules`; the stricter rule wins. Every decision it makes on its own is said out loud and logged (`/interccom status`). It never approves permission prompts.

Only one coordinator runs at a time. `/interccom coordinator take` moves the role, and `/interccom worker` steps down. Start the coordinator session with whichever model you want it to use (`claude --model …`).

## Speech engines

Talking (`tts_engine`) and listening (`stt_engine`) are chosen separately. Mix them freely, e.g. Deepgram for talking and Soniox for listening, or everything on your own machine.

| Engine | Talking | Listening | Key | Default models |
|---|---|---|---|---|
| `elevenlabs` | ✓ | ✓ | `elevenlabs_api_key` / `ELEVENLABS_API_KEY` (needs Text to Speech **and** Speech to Text) | `eleven_flash_v2_5`, `scribe_v1` |
| `deepgram` | ✓ | ✓ | `deepgram_api_key` / `DEEPGRAM_API_KEY` | `aura-2-thalia-en`, `nova-3` |
| `soniox` | ✓ | ✓ | `soniox_api_key` / `SONIOX_API_KEY` | `tts-rt-v2` (voice `Adrian`), `stt-async-v5` |
| `openai` | ✓ | ✓ | `openai_api_key` / `OPENAI_API_KEY` | `gpt-4o-mini-tts` (voice `alloy`), `gpt-4o-mini-transcribe` |
| `groq` | | ✓ | `groq_api_key` / `GROQ_API_KEY` | `whisper-large-v3-turbo` |
| `cartesia` | ✓ | | `cartesia_api_key` / `CARTESIA_API_KEY` | `sonic-3`. Set `tts_voice` to your Cartesia voice ID. |
| `local` | ✓ | ✓ | none | your server's models (`kokoro` / `af_heart`, `Systran/faster-whisper-small`) |
| `command` | ✓ | ✓ | none | your program |

**Local models:**
- **`local`**: any server with the OpenAI audio API (`/v1/audio/speech`, `/v1/audio/transcriptions`), on this machine or your LAN. For example:
  - [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) for the voice;
  - [Speaches](https://github.com/speaches-ai/speaches) (faster-whisper) or the whisper.cpp server (`--inference-path /v1/audio/transcriptions`) for transcription;
  - LocalAI, which does both.

  Point `local_tts_url` / `local_stt_url` at it. The URLs end in `/v1`.
- **`command`**: any program, run without a shell. Quote paths that contain spaces.
  - `tts_command` gets the text on stdin and writes audio to `{out}`: `piper --model C:\voices\en_US-amy-medium.onnx --output_file {out}`
  - `stt_command` reads the recording from `{in}` and prints the text: `whisper-cli -m C:\models\ggml-base.en.bin -f {in} -nt -np`

**Choosing a model or voice:** `tts_voice`, `tts_model` and `stt_model` apply to whichever engine is chosen. Leave them blank for that engine's default. Deepgram picks the voice through the model name, e.g. `aura-2-orion-en`.

## Setup

- **Claude Code:** installing the plugin asks for the talking and listening engines; add the key for each cloud engine you picked. To change them later: `/plugin` → interccom → configure.
- **Check:** `/interccom setup` shows:
  - what each direction will use;
  - any missing key, with where to get one;
  - whether ffmpeg and the audio player are installed;
  - the microphone state.

  `/interccom setup test` plays a test line. A session that starts with something missing tells you once, and points to `/interccom setup`.
- **Codex, Copilot CLI, OpenCode:** run `interccom setup` in a terminal.
  - It asks for both engines, plus model, voice, language and listening mode, and saves them to `~/.interccom/config.json`.
  - For each missing key it shows the `setx` or `export` line to set.
  - It then runs the same check. Flags skip the questions: `interccom setup --tts deepgram --stt soniox --language hr`. Also `--show` and `--test`.
- **Precedence:** Claude Code's plugin settings, or `INTERCCOM_<SETTING>` environment variables, win over `config.json`.
- **API keys are never written to disk by interccom.** They come from the plugin settings (stored by Claude Code) or environment variables. On Windows the saved user environment is read too, so `setx` works without a restart.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `tts_engine` / `stt_engine` | (asked at install) | See [Speech engines](#speech-engines). |
| `*_api_key` | (empty) | One per cloud provider. Falls back to the provider's own variable. |
| `tts_voice` | engine default | A voice of the chosen talking engine. (`voice_id` is the old name; it still works.) |
| `tts_model` / `stt_model` | engine default | A model of the chosen engine. |
| `stt_language` | `en` | The language you speak, or `auto`. |
| `listen_mode` | `wake` | `wake`, `always` or `off`. |
| `local_tts_url` / `local_stt_url` | `http://127.0.0.1:8880/v1` / `http://127.0.0.1:8000/v1` | For the `local` engines. |
| `tts_command` / `stt_command` | (empty) | For the `command` engines. |
| `muted` | `false` | Keep listening, but play nothing. |
| `autonomy` | `relay` | What the coordinator may decide alone: `relay`, `routine`, `full`. |
| `autonomy_rules` | (empty) | Your own rules for the coordinator, in plain words. |

Every setting also works as an environment variable: `INTERCCOM_` plus the name in capitals, e.g. `INTERCCOM_STT_ENGINE=soniox`.

Set `INTERCCOM_MIC` to a device name to choose a specific microphone; otherwise the first one found is used.

- **Windows:** the device name as listed by `ffmpeg -list_devices true -f dshow -i dummy`.
- **macOS:** the device name or index as listed by `ffmpeg -f avfoundation -list_devices true -i ""`.
- **Linux:** a PulseAudio source from `pactl list short sources`, or `alsa:<device>` (e.g. `alsa:hw:1,0`) to read ALSA directly.

## Privacy and cost

- In wake-word and always-on mode, **audio of everything the mic picks up is sent to the transcription engine** you chose. With `local` or `command`, it never leaves your machine or LAN. Soniox transcriptions and uploads are deleted right after each one. The wake word is checked on the transcript afterwards. Use `/listen off` when you don't want that.
- Cloud providers bill per character spoken and per minute transcribed. Local engines cost nothing but CPU or GPU time. The coordinator uses model tokens for every report it handles. Claude is told to keep spoken lines to one to three sentences.
- The hub listens only on `127.0.0.1` and requires a random per-run token. Your key is never written to disk by interccom.
- Speech that reaches Claude mid-task carries a secret per-session tag. Text in a web page or file that imitates a voice note is treated as untrusted.

## Troubleshooting

- **Start with `/interccom setup`** (or `interccom setup --show`): it names what's missing and how to fix it.
- **"missing a permission"**: edit your key in ElevenLabs and enable both Text to Speech and Speech to Text.
- **"… rejected the API key"**: the key for that provider is wrong or expired. The message names the setting to fix.
- **"Couldn't reach the local speech server"**: start it, and check the URL setting ends in `/v1`.
- **"No microphone found"**: plug one in, or set `INTERCCOM_MIC` to its exact name (see Settings for how to list devices on your platform).
- **macOS hears nothing**: System Settings → Privacy & Security → Microphone, and allow the terminal or app that runs Claude Code.
- **Linux "Microphone capture stopped … No such process"**: no PulseAudio/PipeWire server is running. Start one, or set `INTERCCOM_MIC=alsa:default`.
- **"ffplay not found"**: install ffmpeg and make sure it's on PATH.
- **It cut me off mid-sentence**: about 1.6 seconds of silence ends a message. Pause for less than that, or say "Hey Claude" and pause to arm it first.

## Roadmap

- **More coding agents:** Gemini CLI and others hearing too, and a coordinator in agents other than Claude Code ([design](docs/superpowers/specs/2026-11-01-interccom-hosts.md)).
- **Voice approvals:** approve or deny permission prompts by voice, with read-back and confirmation for anything destructive.
- **Setup:** a `/interccom setup` guide and a mic picker.
- **Claude Code desktop app and phone:** the PC goes quiet when you're on your phone.

## Development

```
npm test                    # Node 22.6+ (uses --experimental-strip-types)
claude plugin validate .
```

Testing on a real Windows PC: [docs/testing-locally.md](docs/testing-locally.md).

The npm package `interccom` (bin `interccom`: `mcp`, `codex-hook`, `codex-setup`, `copilot-setup`, `opencode-setup`) is the hub plus the adapters for agents other than Claude Code. `npm pack --dry-run` shows what it ships.

Design and plans live in `docs/superpowers/`. Handoff notes for the current branch: [docs/HANDOFF.md](docs/HANDOFF.md).

## License

MIT
