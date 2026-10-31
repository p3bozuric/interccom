# interccom: design

Date: 2026-10-31 · Status: draft for review

## Intent

Have a real spoken conversation with Claude Code while it works: Claude says out loud only what matters (conclusions, questions, heads-ups), you answer by voice without pressing anything, and when several Claude Code sessions run at once you talk to **one coordinator Claude** that keeps you up to date on all of them and acts for you.

The name is "intercom" with "cc" (Claude Code) inside it. Plugin names starting with `claude-` are reserved by Claude Code's validator, so `claude-voice` is not an option.

## What exists today (proof of concept)

A working Claude Code mod, `voice-reply`, at `~/.claude/dev-mods/<session-id>/voice-reply/`, verified on Windows 11 (USB mic, `ffmpeg`/`ffplay` from winget):

- `hooks/register.ts`: the hooks module. It does five things:
  - registers a `speak` tool (non-deferred)
  - adds spoken-style guidance to the system prompt (`prompt.compose`)
  - registers a `/listen [always|wake|off]` command
  - tracks turn state through `turn.start` and `turn.complete`
  - attaches speech heard mid-turn to the next tool result as `context`; speech heard while idle is sent with `$.prompt.submit({ asUser: true })`
- `helper/speak.mjs`: text on stdin → ElevenLabs TTS (mp3) → `ffplay`. Playback is serialized machine-wide through a `speaking.lock` directory in `%TEMP%/voice-reply`.
- `helper/listen.mjs`: `ffmpeg -f dshow` reads the mic as 16 kHz mono PCM. A loudness-based voice activity detector cuts speech into utterances: 90 ms of sound starts one, 1.6 s of silence ends it. Each utterance goes to ElevenLabs Scribe for transcription, and one JSON line per transcript is printed. A single listener owns the mic machine-wide through `mic.lock`, and `--takeover` claims it. Audio is ignored while `speaking.lock` exists, so it never hears Claude.
- Wake word: `hey/hi/ok/okay` + `claude|claud|cloud|clod|klod`, or a bare leading "Claude". Saying only "hey Claude" accepts the next utterance within 10 s. The transcription language is pinned (default `en`).
- API key: comes from plugin config, then `ELEVENLABS_API_KEY`, then (Windows) `HKCU\Environment`, because `setx` doesn't reach processes started earlier. The key needs both TTS and STT permissions.

The POC proves the hard parts work: mid-turn voice injection, cross-session no-overlap, and wake-word filtering. interccom grows it into the system below and replaces `voice-reply`.

## Goals

1. **One voice channel per machine.** However many sessions run, you hear one orderly stream, one speaker at a time, always told who is talking when more than one session is involved.
2. **Hands-free input.** A wake word by default; always-on and off are selectable. Speech mid-task reaches Claude within one tool step.
3. **A coordinator Claude.** It is a Claude Code session dedicated to talking with you. It:
   - receives what working sessions want you to know
   - decides what is worth saying and merges it
   - gives a status rundown on request ("hey Claude, where are we?")
   - **acts for you**: passes your instructions to a session, answers sessions' questions within the limits you set, and starts new sessions
4. **Configurable by each user**:
   - the autonomy policy: what the coordinator may decide alone and what it must ask you about
   - the models: which Claude model runs the coordinator, plus the TTS and STT engines
5. **Shareable.** It installs as a normal Claude Code plugin from a marketplace and runs entirely through Claude Code.
6. **Works with a single session too.** With no coordinator running, interccom behaves like the POC: the session speaks and listens itself.

## Non-goals (v1)

- Playing audio on, or listening through, the phone during Remote Control (see Surfaces).
- Local TTS/STT engines. v1 ships ElevenLabs only, behind an engine interface that a local engine (Kokoro, Piper, Whisper) can plug into later.
- A proper on-device wake-word detector. v1 keeps the transcribe-then-match approach.
- Guaranteed Linux support. v1 supports Windows and macOS (see Distribution). Linux is best-effort.
- Cloud sessions reporting to the hub. They can still be messaged by the coordinator; see Session reach.

## Anti-goals (failure even if it "works")

- The coordinator **approves or decides something the user would have wanted to be asked about**. When the policy is unclear, it asks.
- The coordinator gets a session to do something that session's own permissions, or the coordinator's, would block (permission laundering).
- Two voices at once, or Claude hearing itself.
- Chatter: reading out every routine step, reasoning, code, file paths or command output.
- Speech from the room (TV, other people) gets sent as instructions in wake-word mode.

## Architecture

```
            mic ─┐                        ┌─ speakers
                 ▼                        ▲
          ┌──────────────── hub (one per machine) ────────────────┐
          │ listener → wake/route → transcript    talk queue → TTS │
          └────▲──────────────────────────▲────────────────────────┘
               │ local IPC                 │ local IPC
   ┌───────────┴──────────┐   ┌────────────┴───────────┐
   │ coordinator session   │   │ working sessions (N)    │
   │ (interccom plugin,    │◀──│ (interccom plugin,      │
   │  coordinator role)    │   │  worker role)           │
   │                       │──▶│                         │
   └───────────────────────┘   └─────────────────────────┘
        built-in ListAgents / SendMessage / notify_when_idle
```

### 1. The hub

One background process per machine. It is the only thing that touches the mic and the speakers.

- **Lifecycle:** the first interccom session to start launches the hub if none is running. The hub keeps running while any session is connected, and exits a short while after the last one disconnects.
- **IPC:** local only, reachable only from this user account. The builder chooses the transport, either a localhost HTTP/WebSocket server or a named pipe. Note: a mod's `$.http.fetch` can use a Unix socket, but its response bodies are text only. Audio never needs to cross into the mod; the hub does all synthesis and playback itself.
- **Listening:** the POC listener moves into the hub. Transcripts are routed:
  - to the coordinator when one is connected
  - otherwise to the session the user last typed in or spoke to
  - otherwise to the most recently started session
- **Talking:** a single queue. Each item has a source (session name or "coordinator"), a priority (`question` > `heads-up` > `status`), and text. Items play one at a time.
  - When a coordinator is connected, it is the only speaker. Worker items go to the coordinator as reports, not to the speakers.
  - Without a coordinator, worker items play directly. They are prefixed with the session name whenever more than one session is connected.
- **Echo guard:** the listener ignores audio while the hub is playing, plus 400 ms after.
- **Status board:** for every connected session it keeps the name, folder, role, busy/idle, the last spoken line, any open question, and when it last changed.

### 2. The interccom plugin (installed in every session)

The same plugin runs in every session, in one of two roles.

**Worker role** (the default):
- The `speak` tool and the spoken-style guidance from the POC. `speak` hands text to the hub instead of playing it. The hub plays it, or forwards it to the coordinator.
- Reports busy/idle (`turn.start`/`turn.complete`) and its session name to the hub.
- Receives transcripts routed to it (no-coordinator mode) and delivers them as the POC does: mid-turn as tool-result context, idle as `$.prompt.submit`.

**Coordinator role:**
- Entered through a slash command (`/interccom coordinator`) or a dedicated agent type the plugin registers. The builder picks which.
- Only one coordinator per machine; the hub rejects or hands over a second one.
- Receives every transcript and every worker report, delivered the same two ways (idle → prompt, busy → tool-result context).
- Gets a system-prompt section describing its job, the user's autonomy policy, and the current status board.
- May use tools the plugin registers to read the hub's status board in detail.

**Session naming:** taken from the project folder by default, overridable with `/interccom name <name>`. Names must be unique and speakable. The hub resolves collisions by adding a suffix.

### 3. Coordinator ↔ sessions: built-in messaging

Claude Code already supports messaging between sessions, and the coordinator uses it to act:
- `ListAgents` shows peer sessions (local, cloud, Remote Control) with busy/idle.
- `SendMessage` delivers to a busy session at its next tool step.
- `notify_when_idle` sends one notice when a local session finishes.

The coordinator:
- passes on instructions ("tell the API session to skip the migration") with `SendMessage`
- answers a worker's question with `SendMessage`, within policy
- watches for completion with `notify_when_idle` instead of polling
- starts new sessions in a way the builder determines. This hasn't been verified yet; if Claude Code offers no supported way, v1 ships without it, and that limitation must be stated.

Worker → coordinator traffic (reports, questions) goes through the **hub**, not `SendMessage`. Messages between sessions in different permission modes wait for the receiving user's approval, and the hub path avoids that friction for reporting. Coordinator → worker traffic uses `SendMessage` on purpose, so Claude Code's permission boundaries and approval prompts stay in force when the coordinator acts.

**Authority (my call):**
- An instruction the user said directly ("tell the API session to run the migration") carries the user's own authority. The coordinator relays it as the user's words and labels it that way.
- The rule against asking a peer to do something your own permissions would block applies to decisions the coordinator makes **on its own** under the autonomy policy.
- v1 enforces this through the coordinator's prompt plus a spoken, logged line for every decision it makes alone. There is no code-level policy engine.

**Worker questions don't block (my call):**
- `speak` always returns immediately, whatever the priority.
- A question ends up as an open item on the status board. The answer reaches the worker later: through `SendMessage` from the coordinator, or as routed speech in no-coordinator mode. It arrives mid-turn as context, or as a new prompt when idle.

**Addressing by name works in every mode (my call).** "Hey Claude, frontend: …" routes to the session named frontend even when no coordinator runs. Without a name, routing falls back to the last-used session.

**Starting sessions (my call):** v1 uses a supported Claude Code mechanism if one exists. Otherwise it ships without the ability and the coordinator says so. Workarounds, such as the hub launching `claude` in a new terminal, are out of scope for v1.

Built-in constraints that bind the design:
- Messages to sessions in a different permission mode wait for that user's approval.
- Cloud, Desktop and Remote Control sessions give no delivery confirmation.
- The coordinator must never ask a peer to do something its own permissions would block.

### Session reach

- **Local sessions with interccom** are full participants: they report, get routed speech, and are on the status board.
- **Other sessions in `ListAgents`** (cloud, Remote Control, or local without the plugin): the coordinator can message them and see busy/idle, but they don't report spoken lines. The status board shows them as "external".

## Autonomy policy (user-configured)

This is a plugin setting, and it is injected into the coordinator's system prompt.

- **Presets:**
  - `relay` (**the default**): pass on instructions the user gave, read out reports and questions, and ask the user about everything else.
  - `routine`: also answer clarifying and routine questions (naming, which of two equivalent approaches, "should I continue?"), and ask about anything destructive, irreversible, costly, outward-facing (pushes, deploys, messages to people), or a design decision.
  - `full`: decide anything a careful senior engineer acting for the user would. Still ask about destructive, irreversible or outward-facing actions.
- **Custom rules:** free text the user writes ("never approve database migrations", "always ask before installing dependencies"), appended after the preset. On conflict, the more restrictive rule wins.
- **Every decision the coordinator makes alone** is said out loud in one line ("I told the API session to use the existing table.") and recorded on the status board, so the user can undo it.

## Permission prompts by voice (owner's decision: in v1)

When a session hits a permission prompt (for example "allow running this command?"), the user can approve or deny it by voice.

- **Mechanism:** the worker's plugin hooks the permission decision. Candidates are `tool.check` (when core's verdict is `ask` and `approver` is `person`) or the classic `PermissionRequest` hook. The hub then announces the request: "API wants to run: npm test. Approve?"
- **Who can approve:** only the **user's own voice**. The coordinator never approves a permission prompt on its own, whatever the autonomy policy says. It may announce and relay the request, but the decision is the user's.
- **What counts as an answer:**
  - an explicit phrase ("approve", "yes, approve", "deny", "no")
  - addressed to that request: either the most recent open one, or one named by session ("approve API")
  - a bare "yes" counts only when exactly one request is open
  - for anything destructive or outward-facing (deletes, force pushes, deploys, sending messages), the hub reads the action back and requires a second "confirm"
- **Fallbacks:**
  - The normal on-screen dialog stays available the whole time, and whichever answers first wins.
  - If no voice answer comes within a timeout, the request falls back to the dialog alone. It is never silently allowed.
- **Never allowed by voice:** anything the organization's policy marks `deny` or caps at `ask`; tools that require the person, such as plan approval and questions put to the user. The hook can only tighten those, never answer them.
- **Feasibility spike first:** the builder must confirm that a hook can wait for a spoken answer within its time budget. If it can't, the hook answers `ask` immediately and a separate path settles the dialog, if Claude Code allows one. If neither works, this is reduced to announce-only (the user approves at the keyboard), and that must be said in the README.

## Delivery stalls (owner's decision: accept and announce)

When the coordinator's `SendMessage` to a session is held for approval because the permission modes differ, the coordinator says so out loud ("My message to API is waiting for approval at its terminal."). The status board records it as pending.

- **Local sessions:** the `[Cross-session delivery notice]` tells it this happened.
- **Cloud, Desktop and Remote Control sessions:** there is no delivery notice, so the coordinator treats a message as unconfirmed until that session responds or goes idle with nothing changed. The README explains that keeping workers and the coordinator in the same permission mode avoids stalls.

## Distribution (owner's decision: public plugin)

interccom ships publicly, for anyone to install.

- **Packaging:** a GitHub repository holding a `.claude-plugin/marketplace.json` that lists the plugin. Install with `/plugin install interccom --marketplace <owner>/<repo>`. License: MIT (my call).
- **Platforms (my call):**
  - Windows: `ffmpeg`/`ffplay`, dshow mic
  - macOS: `ffmpeg` avfoundation mic, `afplay` or `ffplay` playback
  - Linux: best-effort, pulse or alsa
  - Platform-specific code lives in one audio module inside the hub.
- **Prerequisites:** Node 18+ and `ffmpeg` on PATH. The plugin does not bundle binaries. Instead, `/interccom setup` checks each prerequisite and prints the exact install command for the user's platform (`winget install Gyan.FFmpeg`, `brew install ffmpeg`, …).
- **First-run setup (`/interccom setup`):** a guided check that:
  - checks prerequisites
  - asks for the API key, stored in plugin config as sensitive
  - verifies it has **both** TTS and STT permissions; the owner hit exactly this
  - lists microphones and lets the user pick one, with no hard-coded device
  - plays a test phrase, records a test phrase, and shows the transcript
  - sets the listening mode, autonomy preset and voice
- **Errors:** every failure names the cause and the fix in plain words, and shows on every surface (see Surfaces), not only in the terminal.
- **Configuration guide:** a README covering what interccom does, install, setup, every setting (listening mode, wake word, language, voice, models, autonomy presets and custom rules), multi-session use, the coordinator, voice approvals and their safety rules, costs (ElevenLabs bills per character and per audio minute; the coordinator uses model tokens), privacy (in wake-word mode, room audio is sent to the STT provider), and troubleshooting.
- **Before publishing:** no personal data in the repository (the key, the owner's mic name, paths), and pass `claude plugin validate` with no errors.

## Models and engines (user-configured)

- **Coordinator model:** any model Claude Code can run. The default is the session default. The setting applies when the coordinator session starts.
- **TTS engine:** `elevenlabs` (v1), with settings for voice ID and model. Default model: `eleven_flash_v2_5`.
- **STT engine:** `elevenlabs` (Scribe, v1), with a language setting (default `en`, or `auto`).
- **Engine interface:** the hub calls an engine with text → audio file, or audio → text, so a local engine is one new module plus a setting value.
- **API keys:** come from plugin config (sensitive), then environment variables, then the Windows user environment.

## Voice interaction

- **Wake word** (default mode), as in the POC, with the same tolerant matching. In coordinator mode, a session name right after the wake word ("hey Claude, frontend: …") is passed to the coordinator as an addressing hint; the coordinator does the routing.
- **"Status" / "where are we"** asks the coordinator for a rundown: one sentence per session, ordered by open question first, then recently finished, then busy.
- **Spoken style:** one to three sentences, no reasoning, code, paths or lists. Name the source session when relaying. Questions come before status.
- **Batching:** when several reports arrive while something is playing, the coordinator merges them into one utterance.
- **Mute and stop:** `/listen off|wake|always` stays. Add a spoken "stop" or "quiet" that cuts current playback and flushes queued status items (questions stay).

## Surfaces

- **Terminal:** primary.
- **Claude Code desktop app:** desktop sessions run on the same machine, so the hub works unchanged.
  - The plugin must not rely on terminal-only UI. Failures and important state use a mechanism visible on every surface; `$.ui.notify` or a transcript row are candidates for the builder to verify.
  - It must load in desktop sessions, which means it is installed as a regular plugin, not a dev-mod.
- **Phone through Remote Control:** the plugin API cannot play audio or capture the mic on the phone. When a session detects a `mobile` surface attaching (`session.attach`), the hub mutes PC playback and pauses PC listening for as long as the phone is the active surface. The user then reads replies and uses the phone's own voice input. Phone audio (a companion web page) is a later project.

## Constraints and known facts about the mod API (Claude Code 2.1.316)

- Plugin names may not start with `claude-`, `anthropic-` or `cc-plugin-`.
- In a hooks module, any helper that receives `$` must be a top-level function declaration. The validator rejects closures that take `$`.
- `$.http.fetch` returns only text bodies, and `$.audio.play` plays nothing on Windows. Audio work happens in Node helpers or the hub.
- `$.prompt.submit` never folds into a running turn. Mid-turn delivery is done by returning `context` from a `tool.call` hook; anything still unsent at `turn.complete` is submitted then.
- `$.process.spawn` children die when the module unloads, which happens on every hot reload. The hub must therefore be launched detached from any session, so a reload doesn't kill it.
- `setx` doesn't reach processes that are already running. Keep the registry fallback for the key.

## Settled vs. left to the builder

**Settled by the owner:**
- the coordinator is a Claude session that acts for the user
- the autonomy policy and models are per-user settings
- the wake word is the default, and the listening mode is configurable
- ElevenLabs first, local later
- it runs through Claude Code
- the name `interccom`
- permission prompts can be approved by voice in v1
- stalled coordinator messages are accepted and announced
- it is a public plugin with a configuration guide

**My calls, open to the owner's review:**
- the `relay` default
- hub-based worker→coordinator reporting
- `SendMessage` for coordinator→worker
- the priority order
- muting the PC while the phone is attached
- the project location (a standalone repository)
- authority of direct instructions
- non-blocking questions
- name addressing in all modes
- no session-start workaround
- voice-approval safety rules (user's voice only, read-back plus confirm for destructive actions, timeout falls back to the dialog)
- Windows + macOS with Linux best-effort
- MIT license
- no bundled binaries

**Left to the builder:**
- the IPC transport
- hub lifecycle details
- how the coordinator role is entered
- the exact system-prompt wording
- voice activity detection tuning
- the test strategy
- how to migrate the POC code (rename, move into the project folder, retire `voice-reply`)
