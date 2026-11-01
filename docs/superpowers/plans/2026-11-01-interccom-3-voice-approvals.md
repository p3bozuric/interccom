# Plan 3, as built: permission prompts by voice (0.5.0)

The design's "Permission prompts by voice" section, built after the first local test runs. This records what was built and why it looks the way it does.

## Feasibility (the spike the design asked for)

Read from the API types Claude Code 2.1.304 writes:

- A hook has 10 s of its own time, but the clock stops while any `$` call is in flight. A hook can wait minutes on `$.http.fetch` calls to the hub.
- `$.http.fetch` takes no abort signal, so the wait is a series of short long-polls (4 s each). The hook checks `next.signal` between them.
- The engine alone draws the permission dialog. A plugin can add a line under it with `$.ui.notice(tool_use_id, text)`.
- `classic.PermissionRequest` answers `{ decision: { behavior: 'allow' | 'deny' } }`. Its input has no `tool_use_id`.
- `tool.check` has `tool_use_id`, the organization's `ceiling`, and core's verdict through `next(e)`, including `decider` when another plugin put the call to the person.

Not provable from types, so left to check on a real machine (testing-locally.md 8.12 and 8.13):

- that the dialog shows while the PermissionRequest hook waits;
- that a voice answer closes it;
- that answering the dialog ends the wait.

## How it works

1. `tool.check` (hooks/register.ts → hooks/approvals.ts `rememberCheck`) never changes the verdict. It remembers a call when core asks the person's dialog (`decision: 'ask'`, no `decider`). It skips calls whose ceiling is `ask`, `AskUserQuestion` and `ExitPlanMode`, and queries.
2. `classic.PermissionRequest` runs the settings hooks beneath first, and a decision there stands. It then matches the call by tool name plus the input JSON. With the link up, the mic on and the session not muted, it calls `askByVoice`:
   - `POST /approvals` opens the request;
   - a notice goes under the dialog;
   - `GET /approvals/:id?wait=4000` repeats until it gets an answer, `next.signal` aborts, or 60 s pass;
   - `DELETE` withdraws an unanswered request.
3. The hub (hub/server.mjs, hub/approvals.mjs):
   - It announces "<session> wants to <summary>. Approve?" as a question under no session's name.
   - It checks every heard phrase for an answer before routing, so the coordinator never sees one.
   - A settled answer is kept for 60 s, so a late poll still gets it.
   - Requests are cancelled when their session goes, and dropped after 10 minutes without polls.
4. Answers (hub/approvals.mjs `matchAnswer`):
   - The whole utterance must be the answer, at most 7 words, with or without the wake word.
   - "approve / allow / yes approve", "deny / no / don't allow", and "confirm".
   - A session name at either end picks that session's request.
   - Approving or confirming without a name needs exactly one request it could mean, so a request that arrives just before the answer is never approved by mistake. An unnamed deny goes to the newest request; a wrong deny only costs a retry.
   - A bare "yes" counts only when exactly one request is open, and never as a confirm. Only "confirm" lets a destructive request through; another "approve" just asks for the confirm again.
5. Destructive or outward-facing actions are read back and need "confirm". These are:
   - shell commands that delete, push, reset hard, publish, merge PRs, deploy, or drop/truncate data;
   - MCP tools whose names send, post, publish, delete, merge, deploy, email or message.

## Builder's calls

- 60 s voice timeout, 4 s polls, 60 s to keep an answer, 10 min before a request is stale.
- No wake word is needed for an answer while a request is open, because the answer must be the whole utterance. Speech that merely contains "yes" or "no" never counts.
- After the automated security review: a destructive request can't be approved by repeating "approve"; an unnamed approve or confirm with several requests open does nothing; a later `tool.check` of the same call that isn't for voice clears the remembered one.
- No chime-only answers: approving and denying both play the "sent" chime; the confirm read-back is spoken.
- The board (`/interccom status`, `mcp__interccom__board`) lists waiting requests, so the coordinator can mention them.
