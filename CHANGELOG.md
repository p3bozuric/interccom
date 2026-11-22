# Changelog

The version is the same in `package.json`, `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`.

## Unreleased

- CI runs the tests on Windows, macOS and Linux (Node 22 and 24), and loads every hub module on Node 20.
- Node 20 or newer is now required (it was 18.3; Node 18 is past its end of life).
- Release docs: this changelog, `SECURITY.md`, and `docs/release-readiness.md`.

## 0.7.0

- **A system voice.** New talking engine `system`: your computer's own voice (Windows speech, macOS `say`, Linux `espeak-ng`), with no key and no server. It's also the fallback when the chosen voice fails, so you still hear the line and are told what failed. `tts_fallback = off` keeps silence.
- **Dictation.** The bar's **Dictate** button, `/interccom dictate`, or the `dictation` setting: what a session hears goes into its prompt box for you to edit and send. Off by default.
- **The wave, drawn.** In the desktop app, the bar's sound wave is drawn like the desktop's own dictation meter. Terminals keep the text wave.
- **Turn off / Turn on** in the bar (and `/interccom off|on`): no listening, no speech, no voice approvals, for every session.
- **A sound wave** in the bar while your voice comes in.
- **`speak` tells the truth.** It no longer answers "Speaking." when nothing played: it waits up to 4 seconds and reports a failed voice engine, so Claude puts the line in text.

## 0.6.0

- **Gemini CLI**: `interccom gemini-setup` writes an extension, loaded with `gemini extensions link`.
- A plugin icon.
- Fixes from live testing:
  - session names of up to five spoken words, in addressing and approvals;
  - `claude "/interccom coordinator"` waits for the hub link;
  - a second coordinator gets a plain refusal;
  - the coordinator relays through the board when it can't tell sessions apart;
  - clearer failure messages.

## 0.5.0

- **Permission prompts by voice.** Say "approve" or "deny". A destructive action is read back and needs "confirm". The dialog still works, and whichever answer comes first wins. The person's voice decides, never the coordinator.

## Between 0.4.0 and 0.5.0

- A session's name follows its title (`/rename`, the desktop sidebar).
- Chimes, and a one-word status (Talking, Listening, Processing, Waiting, Not connected, Mic off).
- A bar above the prompt with Stop and Mic on/off, usable mid-turn.
- The test suite passes on Windows. The hooks are type-checked against Claude Code's API.

## 0.4.0

- Cloud speech providers: Deepgram, Soniox, OpenAI, Groq and Cartesia, beside ElevenLabs.
- Setup: `/interccom setup` and `interccom setup` check engines, keys, ffmpeg and the mic.

## 0.3.0

- GitHub Copilot CLI and OpenCode.

## 0.2.0

- Codex, and the `interccom` npm package: the hub and the adapters for agents other than Claude Code.

## 0.1.0

- One voice for all your Claude Code sessions: a local hub, the `speak` tool, "Hey Claude" with addressing by name, voice notes mid-turn, and the coordinator role.
- Local speech engines (any OpenAI-compatible server, or any program), and macOS and Linux audio.
