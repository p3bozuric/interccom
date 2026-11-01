# interccom

**Talk to Claude Code. Let it talk back.**

interccom is a Claude Code plugin that gives your sessions a voice and ears. Claude says out loud only what you need to hear: conclusions, questions, heads-ups. It never reads out reasoning, code or file paths. You answer by just talking. No push-to-talk, no Enter key, and you can do it while Claude is mid-task.

Run several sessions at once and they share one voice channel. They take turns, each says its name, and you can address one by name: *"Hey Claude, frontend: run the tests."* Or make one session the **coordinator**: you talk only to it, and it keeps track of the others for you.

Speech can run in the cloud (ElevenLabs) or entirely on your machine (any OpenAI-compatible local speech server, or programs such as Piper and whisper.cpp).

> **Status: early alpha (v0.1).** Windows only for now. See the roadmap below.

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

## Requirements

- Claude Code (with plugin support)
- Node.js 18.3 or newer, on PATH
- `ffmpeg` and `ffplay` on PATH. On Windows: `winget install Gyan.FFmpeg`
- Speech engines, either of:
  - an [ElevenLabs](https://elevenlabs.io) API key with **both** permissions: *Text to Speech* and *Speech to Text*, or
  - local engines (see [Local speech](#local-speech)); no key and no cloud
- A microphone

## Install

In Claude Code:

```
/plugin marketplace add p3bozuric/interccom
/plugin install interccom@interccom
```

Then set your API key, either in the plugin's settings (`/plugin` → interccom → configure) or as an environment variable:

```
setx ELEVENLABS_API_KEY your-key-here
```

`setx` only reaches programs started afterwards. interccom also reads the saved Windows setting directly, so a restart isn't strictly needed.

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

## Settings

| Setting | Default | What it does |
|---|---|---|
| `elevenlabs_api_key` | (empty) | Your key. Falls back to `ELEVENLABS_API_KEY`. |
| `voice_id` | `21m00Tcm4TlvDq8ikWAM` | The ElevenLabs voice. |
| `tts_model` | `eleven_flash_v2_5` | Speech model. Flash has the lowest latency. |
| `stt_language` | `en` | Transcription language, or `auto`. |
| `listen_mode` | `wake` | `wake`, `always` or `off`. |
| `muted` | `false` | Keep listening, but play nothing. |
| `tts_engine` / `stt_engine` | `elevenlabs` | `elevenlabs`, `local` or `command`, chosen separately for talking and listening. |
| `local_tts_url`, `local_tts_model`, `local_tts_voice` | `http://127.0.0.1:8880/v1`, `kokoro`, `af_heart` | For `tts_engine = local`. |
| `local_stt_url`, `local_stt_model` | `http://127.0.0.1:8000/v1`, `Systran/faster-whisper-small` | For `stt_engine = local`. |
| `tts_command` / `stt_command` | (empty) | For the `command` engines; see below. |
| `autonomy` | `relay` | What the coordinator may decide alone: `relay`, `routine`, `full`. |
| `autonomy_rules` | (empty) | Your own rules for the coordinator, in plain words. |

Set `INTERCCOM_MIC` to a device name to choose a specific microphone; otherwise the first one found is used.

## Local speech

Talking (`tts_engine`) and listening (`stt_engine`) can each run locally:

- **`local`**: any server with the OpenAI audio API (`/v1/audio/speech`, `/v1/audio/transcriptions`). For example, [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) for voice, and [Speaches](https://github.com/speaches-ai/speaches) (faster-whisper) or the whisper.cpp server (`--inference-path /v1/audio/transcriptions`) for transcription. LocalAI does both. Point the URL settings at it; they end in `/v1`.
- **`command`**: any program, run without a shell.
  - `tts_command` gets the text on stdin and writes audio to `{out}`: `piper --model C:\voices\en_US-amy-medium.onnx --output_file {out}`
  - `stt_command` reads the recording from `{in}` and prints the text: `whisper-cli -m C:\models\ggml-base.en.bin -f {in} -nt -np`

  Quote paths that contain spaces.

After changing engines, close all sessions so the hub restarts with the new settings. Testing steps are in [docs/testing-locally.md](docs/testing-locally.md).

## Privacy and cost

- In wake-word and always-on mode, **audio of everything the mic picks up is sent to the transcription engine**, which is ElevenLabs unless you choose a local one. The wake word is checked on the transcript afterwards. Use `/listen off` when you don't want that.
- ElevenLabs bills per character spoken and per minute transcribed. Local engines cost nothing but CPU or GPU time. The coordinator uses model tokens for every report it handles. Claude is told to keep spoken lines to one to three sentences.
- The hub listens only on `127.0.0.1` and requires a random per-run token. Your key is never written to disk by interccom.
- Speech that reaches Claude mid-task carries a secret per-session tag. Text in a web page or file that imitates a voice note is treated as untrusted.

## Troubleshooting

- **"missing a permission"**: edit your key in ElevenLabs and enable both Text to Speech and Speech to Text.
- **"Couldn't reach the local speech server"**: start it, and check the URL setting ends in `/v1`.
- **"No microphone found"**: plug one in, or set `INTERCCOM_MIC` to its exact name. List devices with `ffmpeg -list_devices true -f dshow -i dummy`.
- **"ffplay not found"**: install ffmpeg and make sure it's on PATH.
- **It cut me off mid-sentence**: about 1.6 seconds of silence ends a message. Pause for less than that, or say "Hey Claude" and pause to arm it first.

## Roadmap

- **Other coding agents:** Codex, GitHub Copilot CLI and other MCP-capable agents on the same voice channel ([design](docs/superpowers/specs/2026-11-01-interccom-hosts.md)).
- **Voice approvals:** approve or deny permission prompts by voice, with read-back and confirmation for anything destructive.
- **Setup:** a `/interccom setup` guide, mic picker, and macOS and Linux support.
- **Claude Code desktop app and phone:** the PC goes quiet when you're on your phone.

## Development

```
npm test                    # Node 22.6+ (uses --experimental-strip-types)
claude plugin validate .
```

Testing on a real Windows PC: [docs/testing-locally.md](docs/testing-locally.md).

Design and plans live in `docs/superpowers/`.

## License

MIT
