// Permission prompts answered by voice: what an open request is called out loud, which
// actions need a second "confirm", and which spoken answers settle which request.
// Only the person's voice decides; the coordinator never sees these answers.
import { normalizeName } from './board.mjs'

const NUMBERS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' }
const APPROVE = new Set(['approve', 'approved', 'allow', 'allowed', 'yes approve', 'yes allow', 'approve it', 'allow it', 'yes approve it', 'yes allow it'])
const DENY = new Set(['deny', 'denied', 'reject', 'no', 'nope', 'no deny', 'deny it', 'reject it', 'dont', 'do not', 'dont allow', 'do not allow', 'dont allow it', 'do not allow it'])
const CONFIRM = new Set(['confirm', 'confirmed', 'yes confirm', 'i confirm', 'confirm it'])
const YES = new Set(['yes', 'yeah', 'yep', 'sure', 'ok', 'okay'])
const MAX_WORDS = 7

// Deletes, force pushes, publishing, deploys, messages to people: read back, then "confirm".
const DESTRUCTIVE = [
  /\brm\s+(-\w*\s+)*-\w*[rf]/i, /\brm\s+\S/i, /\brmdir\b/i, /\bdel(ete)?\s/i, /\bRemove-Item\b/i, /\brd\s+\/s\b/i,
  /\bgit\s+push\b/i, /\bgit\s+reset\s+--hard\b/i, /\bgit\s+clean\b/i, /\bgit\s+branch\s+-D\b/i, /\bgit\s+checkout\s+--\s/i,
  /\b(npm|pnpm|yarn)\s+publish\b/i, /\bgh\s+(pr\s+merge|release\s+create|repo\s+delete)\b/i,
  /\bdeploy\b/i, /\bdrop\s+(table|database)\b/i, /\btruncate\b/i, /\bkubectl\s+delete\b/i, /\bterraform\s+(apply|destroy)\b/i,
  /\bformat\s+[a-z]:/i, /\bmkfs\b/i, /\bshutdown\b/i,
]
const OUTWARD_TOOL = /(send|post|publish|delete|remove|merge|deploy|email|message|reply|comment|create_issue|create_pull)/i

function words(text) {
  return String(text ?? '').toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/-/g, ' ')
    .split(/\s+/).filter(Boolean).map(w => NUMBERS[w] ?? w)
}

function lastPart(p) {
  return String(p ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? ''
}

function clip(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n - 3)}...` : s
}

// What the request is, said out loud: "run npm test", "edit server.mjs".
export function describeRequest(tool, input = {}) {
  const i = input && typeof input === 'object' ? input : {}
  if (tool === 'Bash' || tool === 'PowerShell') return `run ${clip(i.command, 120)}`
  if (tool === 'Edit' || tool === 'MultiEdit') return `edit ${lastPart(i.file_path) || 'a file'}`
  if (tool === 'Write') return `write ${lastPart(i.file_path) || 'a file'}`
  if (tool === 'NotebookEdit') return `edit ${lastPart(i.notebook_path) || 'a notebook'}`
  if (tool === 'WebFetch') {
    try { return `fetch ${new URL(String(i.url)).hostname}` } catch { return 'fetch a web page' }
  }
  if (tool === 'WebSearch') return `search the web for ${clip(i.query, 60)}`
  const mcp = /^mcp__(.+?)__(.+)$/.exec(String(tool))
  if (mcp) return `use ${mcp[1].replace(/[_-]+/g, ' ')} ${mcp[2].replace(/[_-]+/g, ' ')}`
  return `use ${tool}`
}

export function isDestructive(tool, input = {}) {
  const i = input && typeof input === 'object' ? input : {}
  if (tool === 'Bash' || tool === 'PowerShell') return DESTRUCTIVE.some(re => re.test(String(i.command ?? '')))
  if (/^mcp__/.test(String(tool))) return OUTWARD_TOOL.test(String(tool))
  return false
}

// A spoken answer to the open requests, or undefined when it isn't one. `open` is newest last:
// { id, name, confirming }. The utterance must be the answer alone ("approve", "deny api",
// "api, approve"), so speech that merely contains "yes" or "no" never settles anything.
// Approving or confirming without a name needs exactly one request it could mean, so a
// request that arrives just before the answer is never approved by mistake; denying without
// a name goes to the newest, since a wrong deny only costs a retry.
export function matchAnswer(text, open) {
  if (!open.length) return undefined
  const w = words(text)
  if (!w.length || w.length > MAX_WORDS) return undefined
  const names = new Map(open.map(a => [a.name, a]))
  // A session name at either end: "approve api 2", "api 2 approve".
  let target
  let rest = w
  for (let n = Math.min(3, w.length - 1); n >= 1 && !target; n--) {
    const tail = normalizeName(w.slice(-n).join(' '))
    const head = normalizeName(w.slice(0, n).join(' '))
    const byTail = [...names.keys()].find(k => k === tail)
    const byHead = [...names.keys()].find(k => k === head)
    if (byTail) { target = names.get(byTail); rest = w.slice(0, -n) } else if (byHead) { target = names.get(byHead); rest = w.slice(n) }
  }
  const phrase = rest.join(' ')
  const newest = list => list.at(-1)
  const confirming = open.filter(a => a.confirming)
  if (CONFIRM.has(phrase)) {
    const a = target ? (target.confirming ? target : undefined) : (confirming.length === 1 ? confirming[0] : undefined)
    return a ? { action: 'confirm', id: a.id } : undefined
  }
  if (APPROVE.has(phrase)) {
    const a = target ?? (open.length === 1 ? open[0] : undefined)
    return a ? { action: 'approve', id: a.id } : undefined
  }
  if (DENY.has(phrase)) {
    const a = target ?? newest(open)
    return { action: 'deny', id: a.id }
  }
  // A bare "yes" is an approval only when there is exactly one request to mean.
  if (YES.has(phrase) && !target && open.length === 1 && !open[0].confirming) return { action: 'approve', id: open[0].id }
  return undefined
}
