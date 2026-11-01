# interccom: other coding agents (Codex, GitHub Copilot CLI, …)

Date: 2026-11-01 · Status: draft for review · Follows: local speech engines (done on this branch)

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
2. **Terminal wrapper**: `interccom run -- codex` (or `-- copilot`, …). It starts the agent in a pseudo-terminal (ConPTY on Windows), passes your keyboard and screen through untouched, and **types routed transcripts into the agent's input**. That works for any TUI agent, with no cooperation needed.
   - Idle: type the text and press Enter. That's the same as you typing.
   - Busy: most agents queue or steer with input typed mid-turn. Where a host doesn't, hold the text until idle.
   - Busy/idle (C) comes from the host's notify hook where there is one, otherwise from output going quiet plus the prompt reappearing.
   - Cost: one native dependency, a PTY library. It's isolated in `hosts/wrapper/` and optional, so the Claude Code plugin stays dependency-free.
3. **Pull fallback**: an MCP tool `heard()` the agent calls between steps. It's chatty and depends on the model remembering to call it, so it's a last resort and is never the default.

### 3. The coordinator stays a Claude Code session in v1

Coordinator → worker messages use Claude Code's `SendMessage`, so permission boundaries hold. Other hosts don't have that. For a non-Claude worker:

- **Reports work unchanged.** Its `speak` goes through the hub to the coordinator, the same as a Claude worker.
- **Relaying your own words**: the coordinator calls a new hub endpoint, `POST /sessions/:id/say`. The hub delivers the text as `heard` to that worker's adapter (wrapper or native), which types it in or submits it. That is the same as you typing at that terminal, so the coordinator **may only send your direct words this way**, labelled as yours ("The person says: …"). It must never send a decision of its own. The coordinator prompt and the hub both enforce that: `say` requires a `quote` of the transcript it relays.
- A non-Claude **coordinator** (e.g. Codex as the one you talk to) is a later step. It would need the same `say` path for every worker, plus its own policy enforcement.

### 4. Platforms

Codex and Copilot CLI users are often on macOS and Linux, so this work needs the audio-module split the original spec already planned: `hub/audio/{windows,macos,linux}.mjs` (dshow, avfoundation, pulse/alsa capture; ffplay or afplay playback). It is required before this is useful outside Windows.

## Order of work

1. ✅ **Local speech engines**: `local` (OpenAI-compatible servers) and `command` (Piper, whisper-cli). Done on this branch.
2. **Audio on macOS and Linux.** Small, and unblocks most Codex and Copilot users.
3. **`interccom mcp` + npm `bin` + AGENTS.md snippet**: every MCP host can speak, and is on the board and the coordinator's reports.
4. **`interccom run --` wrapper**: every TUI host can hear.
5. **Native adapters** for hosts whose hooks allow it (Codex first, then Copilot CLI), replacing the wrapper where they're better.
6. **`/sessions/:id/say`** for coordinator relays to non-Claude workers.
7. Later: local wake-word and VAD models (the transcribe-then-match approach sends room audio to the STT engine; with a local STT engine that's already on-device).

## Open questions for the owner

- Does "GitHub CLI" mean Copilot CLI (assumed above)?
- Which host first after Claude Code: Codex (assumed)?
- Is one optional native dependency (a PTY library) acceptable for the wrapper, given the plugin itself stays dependency-free?
- Should the npm package be `interccom`, if the name is free?
