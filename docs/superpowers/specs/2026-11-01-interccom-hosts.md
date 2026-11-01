# interccom: other coding agents (Codex, GitHub Copilot CLI, …)

Date: 2026-11-01 · Status: approved direction. Codex first, no native dependency. · Follows: local speech engines and macOS/Linux audio (both done on this branch)

## Intent

interccom shouldn't only work with Claude Code. Any terminal coding agent should be able to share the one voice channel: OpenAI Codex CLI, GitHub Copilot CLI, Gemini CLI, and others like Aider, OpenCode or Cursor's CLI. It should work with the same hub, the same wake word and the same session names. A Codex session and a Claude Code session in the same room take turns, and you can address either by name.

"GitHub CLI" here means **GitHub Copilot CLI** (`copilot`), the agent. `gh` itself isn't an agent. It's already reachable from any session as a tool, so it needs nothing from interccom. If `gh copilot` or something else was meant, this doc needs correcting.

## Why it's feasible: the hub is already host-agnostic

Everything that matters already lives in `hub/` and talks plain HTTP on 127.0.0.1 with a token: the mic, the speakers, the engines (cloud or local), routing, the board and the coordinator. `hooks/` is the only Claude Code-specific part, and it's thin. Every host needs the same four things:

| Need | Claude Code today | What other hosts can offer |
|---|---|---|
| **A. Speak:** a `speak` tool | mod API `$.tool.register` | **MCP**: every target host supports MCP servers. One stdio MCP server covers them all. |
| **B. Guidance:** how to talk like a colleague | `prompt.compose` section | MCP server `instructions` (sent at initialize), plus an `AGENTS.md` snippet (Codex, Copilot CLI and others read it) |
| **C. Busy/idle** | `turn.start` / `turn.complete` | host hooks or notify programs where they exist, otherwise inferred from MCP activity and the terminal wrapper (D) |
| **D. Hear:** speech in as a message, or mid-turn | `$.prompt.submit`, `tool.call` context | the hardest part; see below |

A and B are the same for every host, and that gives a useful first version: the agent can talk. D is what makes it a conversation.

## Design

### 1. `interccom mcp`: one MCP server for every host (needs A + B)

- New entry point `hub/mcp.mjs`: stdio MCP, built on Node only, with no SDK dependency. It reuses `connect.mjs`'s `ensureHub` and registration, so the hub starts on demand as it does today.
- Tools: `speak {text, priority}` and `board {resolve?, decision?}`, the same contract as the Claude Code tools.
- `instructions`: the text of `guidance()`, ported to plain JS so it's shared, not duplicated.
- Session name: the cwd's folder name, as now. The board row gets `host: 'codex' | 'copilot' | 'claude-code' | …` so the coordinator and `/interccom status` can show it.
- Distribution: publish the package to npm with a `bin`, so a host config can say `npx -y interccom mcp`. Until then, `node C:\path\to\interccom\hub\mcp.mjs`.
- Per-host setup snippets go in the README. These are to verify against each host's current docs while building:
  - Codex: `~/.codex/config.toml` → `[mcp_servers.interccom] command = "npx" args = ["-y", "interccom", "mcp"]`
  - Copilot CLI: `/mcp add`, or its MCP config file
  - Gemini CLI: `settings.json` → `mcpServers`

### 2. Hearing (D): from most native to most universal

1. **Host-native injection** wherever a host has hooks that can add context to a turn or start one. This is the Claude Code path. Codex and Copilot CLI both have been adding hook and notification features. The builder **must check each host's current docs**, because they move fast. Each host that has them gets a small adapter in `hosts/<name>/`.
2. **Terminal wrapper** (last resort, only for a host with no hooks; not needed for Codex, see 2a): `interccom run -- <agent>`. It starts the agent in a pseudo-terminal (ConPTY on Windows), passes your keyboard and screen through untouched, and **types routed transcripts into the agent's input**. That works for any TUI agent, with no cooperation needed.
   - Idle: type the text and press Enter. That's the same as you typing.
   - Busy: most agents queue or steer with input typed mid-turn. Where a host doesn't, hold the text until idle.
   - Busy/idle (C) comes from the host's notify hook where there is one, otherwise from output going quiet plus the prompt reappearing.
   - Cost: one native dependency, a PTY library. If it's ever built, it ships as a separate optional package, so interccom itself stays dependency-free.
3. **Pull fallback**: an MCP tool `heard()` the agent calls between steps. It's chatty and depends on the model remembering to call it, so it's a last resort and is never the default.

### 2a. Codex: checked against Codex CLI 0.166.0 (owner's choice: first host)

Codex now has what interccom needs natively, so **Codex needs no terminal wrapper and no native dependency** (owner's decision). These facts come from `codex --help`, `codex features list` and the hook JSON schemas built into the 0.166.0 binary. Recheck them against the Codex docs when building:

- **Hooks** (feature `hooks`, stable, on), with Claude-style command hooks: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, plus compact, interrupt and permission-request events. Hook input carries `session_id`, `turn_id`, `cwd` and `transcript_path`.
  - `SessionStart` → `hookSpecificOutput.additionalContext`: **the speaking guidance** (need B).
  - `PostToolUse` → `hookSpecificOutput.additionalContext`: **speech heard mid-turn** reaches the model at its next tool step, like interccom's voice notes today (need D, busy).
  - `Stop` → `decision: "block"` + `reason`: **speech still waiting at turn end** keeps the turn going with it (need D, turn end). `stop_hook_active` guards against loops.
  - `UserPromptSubmit` / `Stop`: **busy/idle** (need C), and "the person typed here" for routing.
- **`codex queue --thread <session_id> --message <text> --resume`**: **speech heard while Codex is idle** becomes its next message (need D, idle). It goes through Codex's own app-server daemon.
- **Plugins and marketplaces** (`codex plugin marketplace add`, `codex plugin add`), with a `hooks/hooks.json` inside the plugin. interccom can ship a Codex plugin from this same repo, much like the Claude Code one.
- **MCP servers** (`codex mcp`, `[mcp_servers.*]` in `config.toml`): the `speak` and `board` tools (need A).
- **Codex has its own voice** (`in_app_voice`, stable, with a `codex-voice-host` binary). Two programs must not own the mic: the interccom Codex setup tells you to keep Codex's own voice off while interccom is in use.

**Shape of the Codex adapter** (`hosts/codex/`):
- The **MCP server process lives as long as the Codex session**, so it is that session's link, the way `connect.mjs` is for Claude Code. It registers with the hub (`host: 'codex'`), keeps the event stream open, and holds heard text and reports in a small inbox.
- **Hooks are short-lived Node scripts.** They read the hook JSON on stdin and ask the hub for that session's inbox, keyed by Codex `session_id`. The MCP server learns the id from the first hook (SessionStart) through the hub. They answer with `additionalContext` or a Stop block.
- **Idle delivery** runs `codex queue … --resume` from the hub side with the session's id, with no shell, and the session's cwd as `-C`.
- **Coordinator relays to a Codex worker** use the same inbox. That is the `/sessions/:id/say` endpoint in section 3.

### 3. The coordinator stays a Claude Code session in v1

Coordinator → worker messages use Claude Code's `SendMessage`, so permission boundaries hold. Other hosts don't have that. For a non-Claude worker:

- **Reports work unchanged.** Its `speak` goes through the hub to the coordinator, the same as a Claude worker.
- **Relaying your own words**: the coordinator calls a new hub endpoint, `POST /sessions/:id/say`. The hub delivers the text as `heard` to that worker's adapter (wrapper or native), which types it in or submits it. That is the same as you typing at that terminal, so the coordinator **may only send your direct words this way**, labelled as yours ("The person says: …"). It must never send a decision of its own. The coordinator prompt and the hub both enforce that: `say` requires a `quote` of the transcript it relays.
- A non-Claude **coordinator** (e.g. Codex as the one you talk to) is a later step. It would need the same `say` path for every worker, plus its own policy enforcement.

### 4. Platforms

Done: `hub/audio/{windows,macos,linux}.mjs`, selected by `hub/audio/index.mjs`. Capture is dshow, avfoundation, or pulse (alsa with `INTERCCOM_MIC=alsa:…`). Playback is ffplay, afplay or ffplay. It still needs testing on real macOS and Linux machines.

## Order of work

1. ✅ **Local speech engines**: `local` (OpenAI-compatible servers) and `command` (Piper, whisper-cli). Done on this branch.
2. ✅ **Audio on macOS and Linux.** Done on this branch; still to be tested on real machines.
3. **`interccom mcp`**: the stdio MCP server with `speak` and `board`, acting as the session link. Any MCP host can speak, and it shows up on the board and in the coordinator's reports.
4. **Codex adapter** (section 2a): Codex plugin, hooks for guidance, mid-turn, turn-end and busy/idle, idle delivery through `codex queue`, and a Codex section in the testing guide.
5. **`/sessions/:id/say`** for coordinator relays to non-Claude workers.
6. **Copilot CLI, Gemini CLI**: the same pattern where their hooks allow it; the wrapper only for a host without hooks.
7. Later: local wake-word and VAD models (the transcribe-then-match approach sends room audio to the STT engine; with a local STT engine that's already on-device).

## Decisions

- First host after Claude Code: **Codex** (owner).
- Native dependency: **none**. Codex integrates through hooks + MCP + `codex queue`; the wrapper is deferred, and would be a separate optional package (builder's recommendation, accepted).

## Open questions for the owner

- Does "GitHub CLI" mean Copilot CLI (assumed above)?
- Should the npm package be `interccom`, if the name is free?
