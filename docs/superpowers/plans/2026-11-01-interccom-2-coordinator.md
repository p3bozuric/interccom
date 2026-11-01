# interccom Plan 2: Coordinator (as built)

**Spec:** `docs/superpowers/specs/2026-10-31-interccom-design.md`, sections "Coordinator role", "Coordinator ↔ sessions", "Autonomy policy", "Delivery stalls".
**Testing on a real PC:** `docs/testing-locally.md`, sections 4–5.

This records what was built and the builder's calls, so it can be reviewed against the spec.

## What it does

- **Entering the role:** `/interccom coordinator` claims it, `/interccom coordinator take` takes it over from another session, and `/interccom worker` steps down. A slash command was chosen over a dedicated agent type: it needs no new surface, and any session can become the coordinator.
- **One per machine:** the hub answers a second claim with 409, naming the current coordinator. A takeover demotes the old one and sends it a `role` event, which shows as a toast. After a hub restart the session claims the role again by itself.
- **Routing with a live coordinator** (one whose event stream is open):
  - Every transcript goes to the coordinator. A session name after the wake word becomes `addressed`, which the plugin shows as `(to api) …`. The coordinator does the routing.
  - A worker's `speak` doesn't play. It becomes a `report {from, priority, text}` on the coordinator's stream and updates the worker's `lastLine` and `openQuestion` on the board.
  - The coordinator's own speech plays without a name prefix.
  - When the coordinator disconnects, everything goes back to Plan 1 behaviour.
- **Delivery to the coordinator:** reports travel like heard speech. While idle they're submitted as a message (`asUser: false`, falling back to `asUser: true`). Mid-turn they're attached to the next tool result, tagged with the per-session secret and JSON-encoded. Several queued reports arrive together, so the coordinator can merge them.
- **Board:** each row now has `role` and `openQuestion`. A decision log keeps the last 20 entries. A question stays open until the same worker says something else, or until the coordinator resolves it.
- **`mcp__interccom__board` tool:** reads the board, sorted with open questions first, then idle by recency, then busy. The coordinator can also pass `resolve: <name>` or `decision: <sentence>`. The hub refuses those two from a worker with 403.
- **Coordinator prompt section** (`coordinatorGuidance`): describes the job, the rundown order, using ListAgents/SendMessage to act, relaying your words labelled as yours, announcing stalled deliveries, saying and logging every decision it makes alone, never approving permission prompts, never laundering permissions, and never starting sessions.
- **Autonomy** settings: `autonomy` (`relay` by default, `routine`, `full`) plus free-text `autonomy_rules`. The more restrictive rule wins.

## Deliberately not in this plan

- **Voice approvals of permission prompts:** that's Plan 3.
- **Starting new sessions:** there's no supported mechanism, so the coordinator says it can't.
- **Coordinator model setting:** start the coordinator session with the model you want (`claude --model …`). A plugin can't switch it.
- **`external` board rows for sessions without the plugin:** the coordinator sees those through ListAgents directly.
- **Code-level policy enforcement:** v1 relies on the prompt plus logged decisions you can hear, as the spec says.

## Verified only on a real PC

See `docs/testing-locally.md` §8: `asUser: false`, whether a session-scoped prompt section is recomposed after a role change, the board tool's name, and ListAgents/SendMessage in your version.
