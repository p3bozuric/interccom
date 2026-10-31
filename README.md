# interccom

**Talk to Claude Code. Let it talk back.**

interccom is a Claude Code plugin that gives your sessions a voice and ears. Claude says out loud only what you need to hear: conclusions, questions, heads-ups. It never reads out reasoning, code or file paths. You answer by just talking. No push-to-talk, no Enter key, and you can do it while Claude is mid-task.

Run several sessions at once and they share one voice channel. They take turns, each says its name, and you can address one by name: *"Hey Claude, frontend: run the tests."*

> **Status: early alpha (v0.1).** Windows only for now, ElevenLabs only for now. See the roadmap below.

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
- An [ElevenLabs](https://elevenlabs.io) API key with **both** permissions: *Text to Speech* and *Speech to Text*
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

## Settings

| Setting | Default | What it does |
|---|---|---|
| `elevenlabs_api_key` | (empty) | Your key. Falls back to `ELEVENLABS_API_KEY`. |
| `voice_id` | `21m00Tcm4TlvDq8ikWAM` | The ElevenLabs voice. |
| `tts_model` | `eleven_flash_v2_5` | Speech model. Flash has the lowest latency. |
| `stt_language` | `en` | Transcription language, or `auto`. |
| `listen_mode` | `wake` | `wake`, `always` or `off`. |
| `muted` | `false` | Keep listening, but play nothing. |

Set `INTERCCOM_MIC` to a device name to choose a specific microphone; otherwise the first one found is used.

## Privacy and cost

- In wake-word and always-on mode, **audio of everything the mic picks up is sent to ElevenLabs** to be transcribed. The wake word is checked on the transcript afterwards. Use `/listen off` when you don't want that.
- ElevenLabs bills per character spoken and per minute transcribed. Claude is told to keep spoken lines to one to three sentences.
- The hub listens only on `127.0.0.1` and requires a random per-run token. Your key is never written to disk by interccom.
- Speech that reaches Claude mid-task carries a secret per-session tag. Text in a web page or file that imitates a voice note is treated as untrusted.

## Troubleshooting

- **"missing a permission"**: edit your key in ElevenLabs and enable both Text to Speech and Speech to Text.
- **"No microphone found"**: plug one in, or set `INTERCCOM_MIC` to its exact name. List devices with `ffmpeg -list_devices true -f dshow -i dummy`.
- **"ffplay not found"**: install ffmpeg and make sure it's on PATH.
- **It cut me off mid-sentence**: about 1.6 seconds of silence ends a message. Pause for less than that, or say "Hey Claude" and pause to arm it first.

## Roadmap

- **Coordinator:** one Claude you talk to that keeps track of all your sessions, gives you a rundown, and acts for you, within limits you set.
- **Voice approvals:** approve or deny permission prompts by voice, with read-back and confirmation for anything destructive.
- **Setup:** a `/interccom setup` guide, mic picker, and macOS and Linux support.
- **More voices:** local text-to-speech and speech-to-text (Kokoro, Piper, Whisper).
- **Claude Code desktop app and phone:** the PC goes quiet when you're on your phone.

## Development

```
npm test                    # Node 22.6+ (uses --experimental-strip-types)
claude plugin validate .
```

Design and plans live in `docs/superpowers/`.

## License

MIT
