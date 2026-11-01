# Plan 4 (proposal): a coordinator in Codex, Copilot CLI, OpenCode or Gemini CLI

**Status:** design proposal, nothing built. **Builds on:** Plan 2 (coordinator), `docs/superpowers/specs/2026-11-01-interccom-hosts.md` §3 ("a non-Claude coordinator is a later step").

Today `setRole` in `hub/server.mjs` refuses any coordinator whose `host` isn't `claude-code`. This proposes how to lift that, host by host.

## What a coordinator needs from its host

1. **Reports and the person's speech, promptly.** Mid-turn (at the next tool step) and while idle (a new turn starts by itself). An idle coordinator that can't be woken is deaf: everything the person says goes to the coordinator first.
2. **The coordinator guidance**: today `coordinatorGuidance` in `hooks/guidance.ts`, Claude-only, with Claude tool names (ListAgents, SendMessage, `mcp__interccom__board`). It must arrive when the role changes mid-session, not only at session start.
3. **A way to reach workers.** Claude uses SendMessage for Claude workers and `board` `relay` { to, quote } for the rest. Relay only passes the person's own words from the last 15 minutes.
4. **The `board` tool with the coordinator's parameters**: `resolve`, `decision`, `relay`. The MCP `board` in `hub/mcp.mjs` (shared by Codex, Gemini, Copilot, OpenCode) takes no parameters today.
5. **A role command**: `/interccom coordinator [take]` and `/interccom worker`, plus reclaiming the role after a hub restart (the Claude plugin does this; `createHostLink` doesn't).

## What each host offers today

From the adapters and the README table; "unsure" means not checked in this repo.

| Host | Delivery | Mid-turn | Idle wake | Guidance | Reach workers | Role command |
|---|---|---|---|---|---|---|
| Codex | pull (inbox, hooks) | PostToolUse context, Stop `block` | yes, `codex queue --resume` (live-tested) | SessionStart context + MCP `instructions` | `board` relay only | none in interccom; unsure whether a Codex plugin can add a slash command |
| Copilot CLI | push (extension) | `onPostToolUse` context | yes, `session.send` | `onSessionStart` context only | `board` relay only | unsure whether extensions can add slash commands |
| OpenCode | push (plugin) | appended in `tool.execute.after` | yes, `promptAsync` (to the last-used session) | `experimental.chat.system.transform`, every request | `board` relay only | unsure; OpenCode has user-defined commands, not checked from a plugin |
| Gemini CLI | pull (inbox, hooks) | AfterTool context, AfterAgent `deny` | **no**: waits for the person's next message (live-tested) | SessionStart context + MCP `instructions` | `board` relay only | unsure; extensions may ship commands, not checked |

Plumbing every host lacks today, independent of the host:
- The hub sends `heard` and `report` to the coordinator only on its event stream. `createHostLink.onEvent` ignores `report`, and for pull hosts `heard` goes nowhere. Pull coordinators need both put in the inbox; push adapters need a `report` handler.
- `hub/hosts/text.mjs` has `voiceNote` but no tagged report note (Claude's `formatReports`) and no coordinator guidance.
- No host has SendMessage. A non-Claude coordinator can reach every worker, Claude ones included, only with `relay`, so it can pass on the person's words but never its own answer.

## Gaps per host

- **Codex:** hub routing into the inbox, guidance on role change (next hook's context), `board` params, role command. No host gap.
- **Copilot CLI:** a `report` handler in the adapter. Guidance is only injected at session start, so a mid-session role change goes in as `additionalContext` on the next prompt or tool and may not survive compaction.
- **OpenCode:** a `report` handler. Guidance is easiest here (system prompt rebuilt per request). Reports go to the last-used session; a second OpenCode session in the same server can't be the coordinator separately.
- **Gemini CLI:** everything Codex needs, plus a blocking gap: while idle, neither reports nor the person's voice arrive until they type. As a voice coordinator it is mostly unusable.

## Options

**A. Relay-only coordinator in hosts that can be woken (Codex, Copilot, OpenCode).** Generalise the hub and adapters as above; port the coordinator guidance to `text.mjs` with each host's tool names, without SendMessage and with autonomy fixed to `relay` (it can't answer a worker in its own words). Gemini stays refused with a clear reason.
- For: no new trust path; the person's words are the only thing that ever reaches a worker. Small, mostly shared code.
- Against: `routine` and `full` autonomy don't work there; the coordinator answers worker questions by asking the person.

**B. A + coordinator messages.** A new `board` `tell` { to, text } (`POST /board/tell`) delivers the coordinator's own words to any worker, in a separately tagged note ("Message from the coordinator, not the person"). Workers' guidance says such a note never authorises anything destructive, outward-facing or beyond what the person asked. Unlocks `routine`/`full` everywhere, including a Claude coordinator talking to Codex workers.
- For: feature parity across hosts.
- Against: this is the permission-laundering path `relay` was designed to avoid. In pull and push hosts the note arrives as user input; the worker's own permission prompts still apply, but the prompt is the only guard against acting on the coordinator's authority.

**C. A + a degraded Gemini mode.** While a Gemini coordinator is idle, the hub falls back to no-coordinator behaviour (workers speak aloud, speech routed by name) and the coordinator catches up from `board` on its next turn.
- For: Gemini can hold the role.
- Against: two routing modes switching on the coordinator's busy state; the person can't predict who hears them. Gemini would be "coordinator only while it's working".

## Recommendation: A, phased

1. **Phase 1, Codex (smallest useful step).** Hub: drop the host check for `codex`; when the live coordinator is a pull session, put `heard` (with its `(to name)` prefix) and `report` into its inbox and wake it with `submitIdle`. `text.mjs`: `reportNote` and `hostCoordinatorGuidance` (relay-only), returned in the next hook's context after a role change. `mcp.mjs`: `board` gets `resolve`, `decision`, `relay`; the link remembers its role and reclaims it after reconnecting. Role command: `interccom coordinator [--take] [--session <name>]` and `interccom worker` in a terminal (host-agnostic, and not something a model can trigger). Test with the stand-in `codex` like Plan 2's Codex flow, then live.
2. **Phase 2, Copilot CLI and OpenCode.** `report` handling in `createVoiceInbox` and both adapters (reports join the next note or start a turn); OpenCode guidance through `system.transform`, Copilot's through the next `additionalContext`.
3. **Phase 3, only if the owner wants it:** option B, behind a setting off by default.
4. **Gemini:** stays refused ("Gemini can't be woken while idle, so it would miss what you say"). Revisit if Gemini CLI gains a way to start a turn from outside.

## Decisions for the owner

1. **Autonomy in other hosts:** relay-only (A), or coordinator-authored messages to workers (B), with or without a setting?
2. **Gemini:** refuse, or allow in the degraded mode (C)?
3. **Role command:** a terminal command (`interccom coordinator`), a `board` tool parameter the model calls when the person asks, per-host slash commands where they exist, or a mix?
4. **First host:** Codex as proposed, or Copilot/OpenCode first (push hosts, guidance easier in OpenCode)?
5. **Claude workers under a non-Claude coordinator:** acceptable that they get only `relay` (the person's words as a voice note), never SendMessage?
6. **OpenCode with several sessions in one server:** accept "the last-used session is the coordinator", or require one session per OpenCode server for the role?
