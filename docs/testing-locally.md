# Testing interccom locally (Windows)

This guide is for testing on a real PC: you, or a Claude Code session you run there and point at this file. It covers v0.1 core, the **coordinator**, the **local speech engines**, macOS/Linux audio, and the other agents: **Codex**, **GitHub Copilot CLI** and **OpenCode**.

The automated tests run in the cloud with fakes. Nothing there touches a real microphone, real speakers, or a real Claude Code session that loads the plugin. Those are what this guide checks.

> **For the Claude Code session running this guide:** work through the sections in order. Give each check one of these results: ✅ pass, ❌ fail (with the exact text you saw), or ⏭ skipped (with the reason). Write the results to `docs/test-results/<YYYY-MM-DD>.md`; section 9 has the template. Never write an API key, the person's mic name or their home path into any file. Use PowerShell. You can't hear the speakers or talk into the mic, so ask the person to do each "say" step and to confirm what they heard.

---

## 0. Prerequisites

| Need | Check | Install |
|---|---|---|
| Windows 10/11 | — | — |
| Node 22.6+ (tests). Node 18.3+ is enough to run it | `node --version` | `winget install OpenJS.NodeJS.LTS` |
| ffmpeg and ffplay on PATH | `ffmpeg -version`, `ffplay -version` | `winget install Gyan.FFmpeg`, then open a new terminal |
| Claude Code 2.1.316 or newer | `claude --version` | — |
| A microphone | `ffmpeg -hide_banner -list_devices true -f dshow -i dummy` lists an `(audio)` device | — |
| A key for at least one cloud speech provider (ElevenLabs, Deepgram, Soniox, OpenAI, Groq or Cartesia), or local engines (section 7) | `/interccom setup` | see section 1b |
| Docker Desktop, or Piper / whisper.cpp binaries (section 7) | `docker --version` | see section 7 |

## 1. Get the branch and run the checks

```powershell
git clone https://github.com/p3bozuric/interccom.git
cd interccom
git checkout ccr-874bfdbe-ieq0ah
npm test                    # expect: all pass, 0 cancelled
claude plugin validate .    # expect: "Validation passed" (warnings about author/icon are known)
```

**Install from your local folder** (do this once). Inside Claude Code:

```
/plugin marketplace add C:\path\to\interccom
/plugin install interccom@interccom
```

If you already have interccom installed from GitHub, uninstall it first, so you know which copy is running. After pulling new commits, update the marketplace (`/plugin` → Marketplaces → interccom → Update) and restart Claude Code.

**Clean slate before each section:** close every Claude Code window, then stop any hub that's still running:

```powershell
$h = Get-Content "$env:USERPROFILE\.interccom\hub.json" -ErrorAction SilentlyContinue | ConvertFrom-Json
if ($h) { Stop-Process -Id $h.pid -ErrorAction SilentlyContinue }
```

**Peek at the hub at any time.** It's the same data the `board` tool and `/interccom status` show:

```powershell
function Get-Hub { Get-Content "$env:USERPROFILE\.interccom\hub.json" | ConvertFrom-Json }
function Get-Board { $h = Get-Hub; Invoke-RestMethod "http://127.0.0.1:$($h.port)/board" -Headers @{ 'x-interccom-token' = $h.token } | ConvertTo-Json -Depth 6 }
Get-Board
```

**Type instead of talking (optional).** Start the *first* Claude Code session of the run from a terminal where you've set `$env:INTERCCOM_DEBUG_HEAR = '1'`. Then this line goes through exactly the same routing as a transcript, with no mic or STT cost:

```powershell
function Send-Heard($text) { $h = Get-Hub; Invoke-RestMethod -Method Post "http://127.0.0.1:$($h.port)/debug/hear" -Headers @{ 'x-interccom-token' = $h.token } -ContentType 'application/json' -Body (@{ text = $text } | ConvertTo-Json) }
Send-Heard "Hey Claude, where are we?"
```

The variable only reaches the hub if that session is the one that starts it, which is why you clear the slate first. Use typed input for routing checks. Keep spoken input for at least sections 2 and 5, because the mic path is what's under test there.

## 1b. Setup: the plugin's install questions and the setup check

| # | Do | Expect |
|---|---|---|
| 1b.1 | Install the plugin (section 1) | Claude Code asks for **Talking: speech engine** and **Listening: speech engine** (required), plus optional keys, voice and models. Record exactly how the questions appear. |
| 1b.2 | Pick engines but skip the key, then start a session | One toast: "interccom: not set up yet: No <Provider> API key … Run /interccom setup." |
| 1b.3 | `/interccom setup` | A ✓/✗ list: talking, listening, ffmpeg, ffplay, microphone. Every ✗ has a "→" line with the fix, including where to get the key. |
| 1b.4 | Add the key (`/plugin` → interccom → configure), start a new session, `/interccom setup` | All ✓. "All set." |
| 1b.5 | `/interccom setup test` | You hear "interccom is working. This is how I'll sound." |
| 1b.6 | In a terminal: `node hub\cli.mjs setup` | It asks for both engines, then only what the choice needs (URL for `local`, command for `command`), then voice, models, language and mode. It saves `~/.interccom/config.json` **without any key**, shows a `setx …` line for each missing key, then the same check. |
| 1b.7 | `node hub\cli.mjs setup --tts deepgram --stt soniox --language hr`, then `--show`, then `--test` | Saved without questions. `--show` reports, and `--test` plays the test line. |

## 2. One session (v0.1 baseline)

Use whichever engines you set up in 1b. Open one Claude Code session in any project folder.

| # | Do | Expect |
|---|---|---|
| 2.1 | Start the session | Status line shows `mic: listening` within a few seconds. `Get-Board` lists one session named after the folder. |
| 2.2 | Type: "Tell me out loud what 2+2 is." | One short spoken line. No markdown or code read out. |
| 2.3 | Say: "Hey Claude, what folder are we in?" | It arrives as your message; Claude answers out loud. |
| 2.4 | Say "Hey Claude", pause about 2 s, then say "what time is it" | The second utterance is accepted (armed for 10 s). |
| 2.5 | Give Claude a long task ("read every file and summarize"). While it works, say "Hey Claude, also count the lines." | A toast `heard: ...`. Claude takes it into account at its next tool step and acknowledges it out loud. |
| 2.6 | `/listen off`, then speak | Status shows `mic: off`. Nothing is sent. `/listen wake` turns it back on. |
| 2.7 | Ask for a long spoken reply, then `/interccom stop` while it plays | Playback stops at once. |
| 2.8 | Talk while Claude is speaking | Ignored (echo guard). Claude never hears itself. |

## 3. Two sessions, no coordinator

Open a second session in another folder. To test a name collision, use a folder with the same name in a different place, e.g. `C:\a\api` and `C:\b\api`.

| # | Do | Expect |
|---|---|---|
| 3.1 | Ask both sessions to speak at about the same time | One voice at a time, each prefixed with its session name. |
| 3.2 | Same-name folders | Names `api` and `api-2` (`/interccom status`). |
| 3.3 | Say "Hey Claude, api-2: what's your folder?" | Only the second session receives it. |
| 3.4 | Say something with no name | Goes to the session you last typed in or spoke to. |
| 3.5 | `/interccom name frontend` in one session, then "Hey Claude, frontend: hi" | Reaches the renamed session. |

## 3b. Permission prompts by voice

Use a session in the default permission mode, so commands ask. Keep the mic on.

| # | Do | Expect |
|---|---|---|
| 3b.1 | Ask Claude to run `npm test` (or any command that asks) | The dialog appears, with the line 'interccom: say "approve" or "deny", or answer here' under it. You hear "<session> wants to run npm test. Approve?" |
| 3b.2 | Say "approve" | Falling chime. The dialog closes and the command runs. **Record whether the dialog closed by itself**, or stayed until you clicked (see 8.12). |
| 3b.3 | Again, and say "deny" | The command is refused; Claude reads "The person said no, by voice." |
| 3b.4 | Again, and answer in the dialog instead | It goes on as usual. A later "approve" does nothing (`/interccom status` shows no waiting request). |
| 3b.5 | Ask for something destructive (`git push`, `rm -rf build`) and say "approve" | "Confirm: <session> will run …. Say confirm, or deny." "yes" does nothing; "confirm" lets it run. |
| 3b.6 | Two sessions asking at once; say "yes" | Nothing: two are open. "approve <name>" picks one. |
| 3b.7 | Say nothing for a minute | The request is withdrawn; the dialog still waits for you. |
| 3b.8 | `/listen off` (Mic off), then trigger a prompt | No announcement; the dialog only. |
| 3b.9 | With a coordinator: a worker asks for permission | The coordinator can mention it (`board`) but your "approve" goes to the request, never to the coordinator. |

## 4. Coordinator: role and routing

Keep the two worker sessions open and open a third session, e.g. in an empty folder `C:\work\boss`. Run `/interccom coordinator` in it.

| # | Do | Expect |
|---|---|---|
| 4.1 | `/interccom coordinator` | Confirmation text. `Get-Board` shows `"coordinator": "boss"` and its row has `role: coordinator`. |
| 4.2 | Ask the coordinator: "What is your interccom role, and what is your autonomy preset?" | It knows it's the coordinator, preset `relay`. **If it doesn't,** the coordinator prompt section didn't take effect (see 8.2). Send one more message and ask again. Record which happened. |
| 4.3 | In a worker, type: "Say out loud that the build passed." | **Nothing plays from the worker.** The coordinator gets a session report (a new turn, or a note during its current turn) and says something like "api says the build passed." |
| 4.4 | Watch how 4.3's report showed up in the coordinator's transcript | It should appear as a message from the interccom plugin, not from you (see 8.1). |
| 4.5 | In two workers at once: "Ask me out loud which port to use." (priority question) | The coordinator relays both questions, merged or one after the other, questions first. `Get-Board` shows `openQuestion` on both rows. |
| 4.6 | Say "Hey Claude, where are we?" | The coordinator calls `mcp__interccom__board`, then gives one sentence per session: open questions first, then recently finished, then busy. |
| 4.7 | Say "Hey Claude, api: use port 8080." | The coordinator gets `(to api) use port 8080.` It uses ListAgents to find the api session, then SendMessage with "The person says: use port 8080". The worker receives it. The coordinator marks api's question resolved, and `openQuestion` clears in `Get-Board`. |
| 4.8 | Open a fourth session and run `/interccom coordinator` | Refused: "boss is already the coordinator". |
| 4.9 | In that fourth session: `/interccom coordinator take` | It becomes coordinator. The old one gets a toast saying it's a worker again. |
| 4.10 | `/interccom worker` in the coordinator | Back to no-coordinator mode. Workers speak directly again, with name prefixes. |
| 4.11 | Make a coordinator again, then stop the hub process (Clean slate snippet, but keep the windows open) | Within about 10–60 s a new hub starts. The coordinator session reclaims the role by itself (`Get-Board`). Workers re-register. |
| 4.12 | Close the coordinator window | Workers fall back to speaking and hearing directly within a few seconds. |
| 4.13 | Ask the coordinator to start a new session | It says it can't. |
| 4.14 | Ask the coordinator to approve a permission prompt for a worker | It refuses. Approvals stay yours. |

## 5. Coordinator: autonomy policy

Set it in `/plugin` → interccom → configure, then restart the coordinator session.

| # | Setting | Do | Expect |
|---|---|---|---|
| 5.1 | `autonomy = relay` (default) | A worker asks a routine question ("should I name it utils or helpers?") | The coordinator asks **you** and doesn't answer for you. |
| 5.2 | `autonomy = routine` | Same question | The coordinator answers the worker itself, **says the decision out loud in one line**, and logs it. `Get-Board` → `decisions` has it. |
| 5.3 | `routine` | A worker asks "should I force-push to main?" | The coordinator asks you. Outward-facing or destructive actions always go to you. |
| 5.4 | `autonomy_rules = never approve installing dependencies`, `full` | A worker asks "can I npm install lodash?" | The coordinator asks you, because the rule is stricter than the preset. |

## 6. Failure messages (cloud engine)

| # | Do | Expect |
|---|---|---|
| 6.1 | Use a key with only Text to Speech | One toast naming the missing permission (`speech_to_text`) and the fix, once a minute at most. Speaking still works. |
| 6.2 | Remove the key entirely, then ask Claude to speak | The mic stays off (`mic: off`). When Claude speaks, one toast says which key is missing, the setting and variable to set, and where to get one. |
| 6.3b | Use a wrong key for Deepgram, Soniox, OpenAI, Groq or Cartesia | One toast: "<Provider> rejected the API key (401). Check <provider>_api_key (or <PROVIDER>_API_KEY)." |
| 6.3 | Unplug the mic | "No microphone found …" once. Plug it back in and restart the session; listening resumes. |

## 7. Local speech engines

The TTS (`tts_engine`) and STT (`stt_engine`) engines are chosen independently. Change them in `/plugin` → interccom → configure, then open a new session: each new session sends its settings to the hub. No key is needed when both engines are local.

### 7a. `local` engines through an OpenAI-compatible server (Docker)

The servers and images below are examples. Image names and tags change, so check each project's README for the current command.

```powershell
# TTS: Kokoro-FastAPI (default port 8880). GPU image also available.
docker run -d --name kokoro -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
# STT: Speaches (faster-whisper; default port 8000)
docker run -d --name speaches -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu
# Speaches downloads models only when asked (once; about 15 s for small):
curl.exe -X POST http://127.0.0.1:8000/v1/models/Systran/faster-whisper-small
```

Settings: `tts_engine = local`, `stt_engine = local`. The URLs and the models `kokoro` (voice `af_heart`) and `Systran/faster-whisper-small` are the defaults; `tts_voice`, `tts_model` and `stt_model` override them. Some servers download the model on the first request, which can take a minute.

Check the servers directly first:

```powershell
Invoke-WebRequest -Method Post http://127.0.0.1:8880/v1/audio/speech -ContentType 'application/json' -Body '{"model":"kokoro","voice":"af_heart","input":"Hello there.","response_format":"wav"}' -OutFile "$env:TEMP\t.wav"; ffplay -autoexit -nodisp "$env:TEMP\t.wav"
curl.exe -s -F "file=@$env:TEMP\t.wav" -F model=Systran/faster-whisper-small http://127.0.0.1:8000/v1/audio/transcriptions
```

| # | Do | Expect |
|---|---|---|
| 7.1 | Rerun 2.2–2.5 | Same behaviour, in the local voice. No requests to elevenlabs.io. |
| 7.2 | Stop the TTS container, ask Claude to speak | One toast: "Couldn't reach the local speech server at … Is it running?" |
| 7.3 | Set `local_stt_url` to `http://127.0.0.1:8000` (no `/v1`) | A toast explaining the 404 and that the URL should end in `/v1`. |
| 7.4 | Mixed: `tts_engine = elevenlabs`, `stt_engine = local` | Cloud voice, local transcription. |
| 7.5 | whisper.cpp server instead of Speaches: `whisper-server -m ggml-base.en.bin --port 8000 --inference-path /v1/audio/transcriptions` | Transcription works. `stt_model` can be anything. |

### 7b. `command` engines (Piper, whisper.cpp CLI)

Download [Piper](https://github.com/rhasspy/piper/releases) with a voice (`.onnx` plus its `.onnx.json`), and [whisper.cpp](https://github.com/ggml-org/whisper.cpp/releases) with a model (e.g. `ggml-base.en.bin`).

```
tts_engine  = command
tts_command = "C:\tools\piper\piper.exe" --model C:\voices\en_US-amy-medium.onnx --output_file {out}
stt_engine  = command
stt_command = "C:\tools\whisper\whisper-cli.exe" -m C:\models\ggml-base.en.bin -f {in} -nt -np -l en
```

Quote paths that contain spaces. Backslashes are fine. No shell is used, so `|`, `>` and `%VAR%` don't work.

| # | Do | Expect |
|---|---|---|
| 7.6 | Rerun 2.2–2.5 | Works. Latency is noticeably higher on CPU; record roughly how long. |
| 7.7 | Point `tts_command` at a missing exe | One toast: "Couldn't run … Install it, or put its full path in the tts_command setting." |
| 7.8 | Remove `{in}` from `stt_command` | A toast saying it must contain `{in}`. |

## 7c. macOS and Linux (if you have one)

This support is new. Unit tests cover the device parsing and the commands, and in the cloud container ffplay playback worked and Linux capture failed with a clear message (it has no audio server). It hasn't run with a real mic yet.

| # | Platform | Do | Expect |
|---|---|---|---|
| 7.9 | macOS | `ffmpeg -f avfoundation -list_devices true -i ""`, then start a session | The first audio device is used. macOS asks for mic permission for the terminal or app; after allowing it, `mic: listening`. |
| 7.10 | macOS | Rerun 2.2–2.5 | Plays through `afplay`. `/interccom stop` cuts it off. |
| 7.11 | Linux | `pactl list short sources`, then start a session | The first non-monitor source is used, or `default` without pactl. `mic: listening`. |
| 7.12 | Linux | `INTERCCOM_MIC=alsa:default` | Captures through ALSA instead. |
| 7.13 | Linux | Rerun 2.2–2.5 | Plays through `ffplay`. |

## 7c-2. Cloud providers: Deepgram, Soniox, OpenAI, Groq, Cartesia

These were built from each provider's official SDK on npm (endpoints, fields, default models): `@deepgram/sdk` 5.17, `@soniox/node` 2.4 and `@cartesia/cartesia-js` 4.2, plus OpenAI's audio API. Tests cover every request with a fake network. None has made a real call yet, because the cloud container had no keys and couldn't reach the providers. Test each one you have a key for:

| # | Engine | Do | Expect |
|---|---|---|---|
| 7.p1 | Deepgram talking (`aura-2-thalia-en`) | Rerun 2.2 | Plays. Try `tts_model = aura-2-orion-en`: a different voice. |
| 7.p2 | Deepgram listening (`nova-3`) | Rerun 2.3–2.5. Also `stt_language = auto`. | Correct transcripts. `auto` uses language detection. |
| 7.p3 | Soniox talking (`tts-rt-v2`, voice `Adrian`) | Rerun 2.2, then set `tts_voice` to another Soniox voice | Plays in each voice. |
| 7.p4 | Soniox listening (`stt-async-v5`) | Rerun 2.3, and in another language with `stt_language` set (e.g. `hr`) | Correct transcripts. **Record the delay**: it uploads, then polls. Check in the Soniox console that no files or transcriptions are left behind. |
| 7.p5 | OpenAI talking and listening | Rerun 2.2–2.3. Try `tts_voice = nova`. | Works. |
| 7.p6 | Groq listening | Rerun 2.3 | Works, and fast. |
| 7.p7 | Cartesia talking (`sonic-3`) | Set `tts_voice` to a voice ID from play.cartesia.ai and rerun 2.2 | Plays. With `tts_voice` blank, it uses the voice from Cartesia's SDK example; record whether that works. |
| 7.p8 | Mixed, e.g. talking `deepgram` + listening `soniox` | 2.2–2.5 | Each direction uses its own provider and key. |

## 7d. Codex

You need Codex CLI 0.166 or newer, signed in. In the cloud, everything below ran end to end against real processes, with a stand-in `codex` binary. Codex itself has not run with it yet.

**Install as a plugin** (first try):
```powershell
codex plugin marketplace add C:\path\to\interccom    # or p3bozuric/interccom for the pushed branch's default
codex plugin add interccom
```
**Or by hand:** `node C:\path\to\interccom\hub\cli.mjs codex-setup` and paste what it prints into `~/.codex/config.toml` and `~/.codex/hooks.json`. Settings come from `INTERCCOM_*` environment variables (e.g. `$env:INTERCCOM_TTS_ENGINE='local'`) set before starting `codex`, or from the MCP entry's `env`.

Turn off Codex's own voice input for these tests.

| # | Do | Expect |
|---|---|---|
| 7.14 | Start `codex` in a project folder | `Get-Board` shows a row with `host: codex`. Within a turn or so, `hostSessionId` is filled in (the SessionStart hook bound it). Codex may first ask you to trust the hooks. |
| 7.15 | Ask Codex: "What does interccom ask you to do?" | It describes the speaking guidance. If not, record whether it saw the MCP `instructions`, the SessionStart context, both or neither. |
| 7.16 | "Tell me out loud when you're done: list the files here." | One short spoken line through the hub, with a `shop:`-style name prefix if more sessions are connected. |
| 7.17 | Give a long task, then say "Hey Claude, also count the lines" mid-task | Codex acknowledges it at its next tool step (PostToolUse context). |
| 7.18 | Say something as Codex is finishing a turn | The turn continues with it (Stop blocked once) rather than ending. |
| 7.19 | With Codex idle, say "Hey Claude, what changed?" | Codex starts a new turn with it (`codex queue … --resume`). **Record whether it shows up in the open TUI**, or only in the daemon or another session. |
| 7.20 | Codex and Claude Code sessions both open: "Hey Claude, <codex-name>: hi" | Only the Codex session gets it. |
| 7.21 | Make a Claude Code session coordinator. Say "Hey Claude, tell <codex-name> to run the tests" | The coordinator relays your words with `board` `relay`. Codex receives "run the tests" (or your full phrasing). Ask the coordinator to tell Codex something you never said: refused (403). |
| 7.22 | `/interccom coordinator` can't be run in Codex, but check: Codex speaking while a coordinator runs | Codex's lines arrive at the coordinator as reports, not as audio. |
| 7.23 | Rename `codex` off PATH (or set `INTERCCOM_CODEX_BIN` to a wrong path), speak while idle | One error naming `INTERCCOM_CODEX_BIN`. The speech is kept and delivered at Codex's next hook. |

## 7e. GitHub Copilot CLI

You need Copilot CLI 1.0+, signed in (`copilot login`). In the cloud, the loader file `copilot-setup` writes ran against a real hub, with a stand-in for Copilot's SDK module: it joined with both tools and three hooks, injected the guidance, spoke, and passed heard speech to `session.send`. Copilot itself has not loaded it yet.

```powershell
node C:\path\to\interccom\hub\cli.mjs copilot-setup    # writes ~/.copilot/extensions/interccom/extension.mjs
copilot                                                     # start in a project folder
```

Turn off Copilot's own voice input for these tests.

| # | Do | Expect |
|---|---|---|
| 7.24 | Start `copilot` | `Get-Board` shows `host: copilot`, named after the folder. `/env` (or Copilot's extension list) shows the interccom extension. |
| 7.25 | "Say out loud what this project is." | Copilot calls `interccom_speak`, and you hear one short line. |
| 7.26 | Long task, then "Hey Claude, also check the README" mid-task | Arrives with the next tool result (`onPostToolUse` context), and Copilot acknowledges it. |
| 7.27 | Idle: "Hey Claude, what did you change?" | Appears as your next message in the open Copilot window, and a turn starts. |
| 7.28 | Several sessions: "Hey Claude, <copilot-name>: hi" | Only the Copilot session gets it. |
| 7.29 | Coordinator in a Claude Code session: "Hey Claude, tell <copilot-name> to run the tests" | Relayed with `board` `relay`, and Copilot receives the words. |
| 7.30 | `interccom copilot-setup --remove`, restart Copilot | The extension is gone, and so is the board row. |

## 7f. OpenCode

You need OpenCode 1.19+ with a model provider configured. **In the cloud this ran against real OpenCode 1.19.5** (`opencode serve`):
- the plugin loaded from the file `opencode-setup` wrote, and OpenCode installed `@opencode-ai/plugin` by itself;
- the hub started from inside OpenCode;
- the session showed on the board as `host: opencode`;
- `interccom_speak` and `interccom_board` were in OpenCode's tool list;
- typed speech became a real user message in the session.

The model's side (guidance, speaking, mid-turn notes) needs a provider, which the cloud container didn't have.

```powershell
node C:\path\to\interccom\hub\cli.mjs opencode-setup    # writes ~/.config/opencode/plugins/interccom.js
opencode                                                     # start in a project folder
```

| # | Do | Expect |
|---|---|---|
| 7.31 | Start `opencode` | `Get-Board` shows `host: opencode`. The first start may take a moment while OpenCode installs `@opencode-ai/plugin` in its config folder. |
| 7.32 | "Say out loud what this project is." | OpenCode calls `interccom_speak`, and you hear it. |
| 7.33 | Long task, then speak mid-task | The voice note is appended to the next tool's output, and OpenCode acknowledges it. |
| 7.34 | Idle: speak | It becomes your next message in the open TUI, and a turn starts. |
| 7.35 | Ask OpenCode to use a subagent, and speak while it runs | The speech goes to your main session, never to the subagent. |
| 7.36 | Two OpenCode windows on the same project, then switch between them | Speech goes to the session you last sent a message in. Record whether that holds across windows: each `opencode` process has its own plugin instance. |

## 8. Things that couldn't be verified in the cloud: check them

These are assumptions about Claude Code's plugin API that only a real session can confirm.

1. **Reports as the plugin's message** (check 4.4). They're submitted with `$.prompt.submit({ text })`, no `asUser`, which the types say Claude reads as "The interccom plugin sent a message: …". Confirm the coordinator sees them that way.
2. **The coordinator prompt section** (check 4.2). It's added in `prompt.compose` with `scope: 'session'`. If Claude Code caches session sections, a role switch mid-session may only take effect after a restart.
3. **The tool name `mcp__interccom__board`** (check 4.6). It's assumed to follow the same naming as `mcp__interccom__speak`.
4. **ListAgents / SendMessage / idle notices** (check 4.7). They're built into Claude Code. Confirm they're available in your local version and permission mode. If the worker is in a different permission mode, the message waits for approval, and the coordinator should say so.
5. **Command quoting on Windows** (7b). Paths with spaces in `tts_command` and `stt_command`.
6. **Codex plugin format** (7d). Check that `.codex-plugin/plugin.json`, `hosts/codex/mcp.json` and `hosts/codex/hooks.json` load, that `${PLUGIN_ROOT}` expands in hook commands, and that the marketplace is found through `.claude-plugin/marketplace.json`. These were inferred from the Codex 0.166 binary, not from docs.
7. **Codex specifics** (7d):
   - Whether the MCP server gets `CODEX_THREAD_ID` (if not, binding falls back to the folder).
   - Whether the MCP server's working directory is the project folder (folder binding needs it; otherwise `--cwd`).
   - Whether `codex queue --resume` reaches the open TUI.
8. **Copilot extension** (7e): that Copilot loads `~/.copilot/extensions/interccom/extension.mjs`, and resolves `@github/copilot-sdk/extension` for a loader that imports interccom from outside that folder. Also that `session.send` shows in the open window, and that `onPostToolUse` context reaches the model.
9. **OpenCode, model side** (7f): that `experimental.chat.system.transform` guidance reaches the model, and that the voice note appended in `tool.execute.after` is seen.
10. **Cloud providers** (7c-2): first real calls to Deepgram, Soniox, OpenAI, Groq and Cartesia. In particular: the Soniox polling delay and cleanup, and whether Cartesia's `cartesia-version: 2026-08-14` header is accepted.
11. **Install questions** (1b.1): how Claude Code presents the two required engine choices.
12. **The PermissionRequest hook runs while the dialog is up** (3b.2, 3b.4). The plugin waits for your voice inside `classic.PermissionRequest` (its own time budget stops during `$` calls). Confirm: the dialog shows at once rather than after the wait; a voice answer closes it; a dialog answer ends the wait (`next.signal`). If the dialog only appears after the wait ends, the hook has to answer `ask` at once and the feature becomes announce-only.
13. **tool.check and PermissionRequest see the same input** (3b.1). The two are matched by tool name plus the input JSON; if they differ, nothing is announced.

## 9. Results template

````markdown
# interccom local test — <date>
Branch/commit: <git rev-parse --short HEAD>   Claude Code: <version>   Node: <version>   Windows: <build>
Engines tested: <elevenlabs / local (which server) / command (which programs)>

| Check | Result | Notes (exact error text, latency, what was heard) |
|---|---|---|
| 1 npm test / validate | | |
| 2.1 … | | |
…
| 8.1 plugin's message | | how reports appeared |
| 8.2 prompt section | | took effect immediately / after restart |

## Bugs
- <check #>: what happened vs expected, steps, toast/console text
````
