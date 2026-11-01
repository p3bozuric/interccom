import type { EngineInterface } from 'claude-code'

// Permission prompts by voice, the session side. tool.check sees core's verdict first and
// remembers which calls go to the person's dialog; the classic PermissionRequest hook then
// opens a request on the hub and waits for the person's spoken answer while the dialog
// stays up. Whichever answers first wins; no answer in time leaves the dialog alone.
// Never by voice: a tool the organization caps at "ask", one another plugin put to the
// person, and the tools that are questions to the person themselves.

const PERSON_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
export const VOICE_TIMEOUT_MS = 60_000
const POLL_MS = 4_000
const REMEMBER_MS = 5 * 60_000

type Verdict = { decision: string; decider?: string }
type CheckEvent = { tool: string; input: unknown; tool_use_id?: string; ceiling?: string }
export type Answer = 'approved' | 'denied' | undefined

const eligible = new Map<string, { toolUseId: string; at: number }>()

export function requestKey(tool: string, input: unknown): string {
  return `${tool}\u0000${JSON.stringify(input ?? null)}`
}

export function voiceEligible(e: CheckEvent, v: Verdict): boolean {
  return v.decision === 'ask' && v.decider === undefined && e.ceiling !== 'ask'
    && !PERSON_TOOLS.has(e.tool) && Boolean(e.tool_use_id)
}

export function rememberCheck(e: CheckEvent, v: Verdict, now = Date.now()): void {
  for (const [k, r] of eligible) if (now - r.at > REMEMBER_MS) eligible.delete(k)
  const key = requestKey(e.tool, e.input)
  // A later check of the same call that may not be answered by voice clears an earlier one.
  if (voiceEligible(e, v)) eligible.set(key, { toolUseId: String(e.tool_use_id), at: now })
  else eligible.delete(key)
}

// The call's tool_use_id when tool.check found it may be answered by voice; used once.
export function takeEligible(tool: string, input: unknown): string | undefined {
  const key = requestKey(tool, input)
  const r = eligible.get(key)
  eligible.delete(key)
  return r?.toolUseId
}

type Call = (method: string, path: string, body?: unknown) => Promise<unknown>

// Open the request, then wait in short long-polls (a $ call stops the hook's own clock) until
// the person answers, the dialog answers first (the signal), or the timeout.
export async function askByVoice(
  $: EngineInterface, call: Call, sessionId: string, tool: string, input: unknown, toolUseId: string,
  signal: AbortSignal | undefined, timeoutMs = VOICE_TIMEOUT_MS,
): Promise<Answer> {
  const req = (await call('POST', '/approvals', { sessionId, tool, input })) as { id?: unknown; destructive?: unknown }
  const id = String(req.id ?? '')
  if (!id) return undefined
  try {
    $.ui.notice(toolUseId, req.destructive
      ? 'interccom: say "approve", then "confirm" (or "deny"), or answer here'
      : 'interccom: say "approve" or "deny", or answer here')
  } catch { /* the dialog is already gone */ }
  let settled = false
  try {
    const end = Date.now() + timeoutMs
    while (!signal?.aborted && Date.now() < end) {
      const wait = Math.min(POLL_MS, end - Date.now())
      const out = (await call('GET', `/approvals/${encodeURIComponent(id)}?wait=${wait}`)) as { status?: unknown }
      if (out.status === 'approved' || out.status === 'denied') { settled = true; return out.status }
      if (out.status === 'cancelled' || out.status === 'gone') { settled = true; return undefined }
    }
    return undefined
  } finally {
    if (!settled) await call('DELETE', `/approvals/${encodeURIComponent(id)}`).catch(() => undefined)
  }
}
