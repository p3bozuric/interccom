# Handoff: work done in the cloud session (2026-11-01)

Branch `ccr-874bfdbe-ieq0ah`, 7 commits on top of `f0a0f1d` (v0.1.0), now **v0.4.0**. Everything is tested in the cloud (240 tests, `claude plugin validate .` passes). **Nothing has run on a real PC with a real mic, speakers or a signed-in agent yet.** That is the next step, in [testing-locally.md](testing-locally.md).

## Start here (local session)

```powershell
git fetch origin; git checkout ccr-874bfdbe-ieq0ah
npm test                     # Node 22.6+; expect 240 pass, 0 fail
claude plugin validate .     # warnings about author/icon are known
```

Then work through [docs/testing-locally.md](testing-locally.md) in order and record results in `docs/test-results/<date>.md` (template in its §9). Its §8 lists the assumptions only a real machine can confirm.

## What was built, commit by commit

| Commit | What |
|---|---|
| `6855698` | **Coordinator** (Plan 2): `/interccom coordinator [take]` and `/interccom worker`. One coordinator per machine. It hears everything, and workers' `speak` calls become tagged reports to it. Board tracks role, open questions and a decision log. `mcp__interccom__board` tool. `autonomy` (relay/routine/full) and `autonomy_rules` settings. Also fixed 2 cancelled ElevenLabs tests. |
| `4f9d1a9` | **Local speech engines**: `local` (OpenAI-compatible server) and `command` (any CLI: Piper, whisper-cli). |
| `2f1401c` | Testing guide, Plan 2 as-built record, other-agents design doc. Opt-in `POST /debug/hear` (`INTERCCOM_DEBUG_HEAR=1`) to type instead of speak. |
| `bfca681` | **macOS and Linux audio** (`hub/audio/{windows,macos,linux}.mjs`). |
| `08a807a` | **Codex** (0.166+): `interccom mcp` (stdio MCP server, the session's link to the hub), Codex plugin (`.codex-plugin/`, `hosts/codex/`), `interccom codex-hook`, idle speech through `codex queue`. Coordinator `relay` for agents SendMessage can't reach. npm package `interccom` (not published). |
| `ba750b2` | **GitHub Copilot CLI** (extension: `hub/hosts/copilot.mjs`, `interccom copilot-setup`) and **OpenCode** (plugin: `hub/hosts/opencode.mjs`, `interccom opencode-setup`). Fix: the hub launcher finds a real Node inside Bun or packaged CLIs (`resolveNode`, `INTERCCOM_NODE`). Deflaked the relaunch test. |
| `338d27f` | **Cloud speech providers**: Deepgram, Soniox, OpenAI, Groq, Cartesia, next to ElevenLabs/local/command. **Setup flow**: required engine choice at plugin install, `/interccom setup [test]`, and `interccom setup` (wizard/flags) writing `~/.interccom/config.json` without keys. |

## How it fits together

```
hub/ (one detached Node process per machine, 127.0.0.1 + token)
  server.mjs        board, talk queue, routing, coordinator, pull inbox, /host/event, /board/relay, /setup
  engines/          index.mjs (PROVIDERS table: defaults, keys, problems) + one module per provider
  audio/            per-platform capture/playback, picked by audio/index.mjs
  hosts/            text.mjs (guidance, voice notes), codex.mjs, copilot.mjs, opencode.mjs, setup.mjs (loaders)
  mcp.mjs           createHostLink (any non-Claude session's link) + stdio MCP server
  config-env.mjs    every setting: plugin option = config.json key = INTERCCOM_<NAME>
  cli.mjs           bin `interccom`: setup, mcp, codex-hook, codex-setup, copilot-setup, opencode-setup
hooks/ (Claude Code hooks module, TypeScript)
  register.ts, hub-link.ts, delivery.ts, guidance.ts, board-view.ts, link-env.ts
```

How each agent receives what you say:

| Agent | Delivery | Mid-turn | Idle |
|---|---|---|---|
| Claude Code | push (event stream) | `tool.call` context | `$.prompt.submit` |
| Codex | pull (hub inbox, hooks) | PostToolUse `additionalContext`, Stop `block` | `codex queue --resume` |
| Copilot CLI | push | `onPostToolUse` `additionalContext` | `session.send` |
| OpenCode | push | appended in `tool.execute.after` | `client.session.promptAsync` |
| Other MCP agents | none | — | — (speak only) |

Only Claude Code sessions can be the coordinator (the role relies on SendMessage).

## Decisions made with the owner

- Coordinator first, then local models, then other agents. Codex first, then Copilot CLI ("GitHub CLI" meant Copilot) and OpenCode.
- No native dependency: no PTY wrapper. Every agent integrates through its own hooks, extension or plugin API.
- npm package name `interccom`. **Not published**: `npm publish` is the owner's call.
- Engine choice happens at plugin install (`required: true`), and Cloud providers include Deepgram and Soniox.

## Builder's calls worth reviewing

- Reports to the coordinator are submitted with `asUser: false`, falling back to `asUser: true` if Claude Code rejects it.
- The coordinator may relay only a quote of what you said to it in the last 15 minutes (whole words), never its own instructions.
- API keys are never written to disk by interccom. `config.json` holds choices only.
- `local_tts_model` / `local_tts_voice` / `local_stt_model` were replaced by `tts_model` / `tts_voice` / `stt_model`. `voice_id` is still read.
- The hub uses the settings of whichever session connected most recently.

## Verified vs. not

**Verified in the cloud:**
- the real hub end to end;
- Codex flow with real processes and a stand-in `codex`;
- the Copilot loader with a stand-in SDK;
- **real OpenCode 1.19.5** (plugin loads, tools registered, heard text became a real user message);
- `interccom setup` against a real hub;
- Linux playback.

**Not verified (needs your PC):**
- mic and speakers on any OS;
- Claude Code loading the plugin: install questions, `asUser: false`, the coordinator prompt section, SendMessage relay;
- the real Codex and Copilot runs;
- the OpenCode model side;
- **first real calls to Deepgram, Soniox, OpenAI, Groq and Cartesia.** They were built from their official npm SDKs because their docs were blocked in the cloud session. Check especially Soniox latency and cleanup, and Cartesia's `cartesia-version: 2026-08-14` header and default voice.

The full list is in testing-locally.md §8.

## Known gaps and next steps

- Saying "stop" doesn't interrupt audio while it plays: the mic is deaf during playback, by design.
- Hooks-module types (`claude-code`) weren't available in the cloud, so the TypeScript in `hooks/` has never been type-checked. The validator accepts it.
- Next on the roadmap:
  - voice approvals of permission prompts (Plan 3);
  - Gemini CLI and other agents;
  - a coordinator in agents other than Claude Code;
  - a local wake-word/VAD model;
  - a plugin icon;
  - `npm publish`.
- Design and plans: `docs/superpowers/specs/` (original design, other agents) and `docs/superpowers/plans/`.
