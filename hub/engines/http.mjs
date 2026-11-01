// One request to a speech provider, with failures turned into plain-language EngineErrors
// that name the provider and the fix. Shared by every engine except ElevenLabs (which keeps
// its own permission-specific messages).
import { EngineError } from './elevenlabs.mjs'

export async function providerFetch(url, init, { label, keySetting, fetch: fetchFn = globalThis.fetch, timeoutMs = 20_000 }) {
  let res
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new EngineError('network', `${label} didn't answer in time (${url}).`)
    throw new EngineError('network', keySetting
      ? `Couldn't reach ${label} at ${url}. Check your connection.`
      : `Couldn't reach ${label} at ${url}. Check that it is running.`)
  }
  if (res.ok) return res
  const body = (await res.text().catch(() => '')).slice(0, 200)
  if ((res.status === 401 || res.status === 403) && keySetting) {
    throw new EngineError('auth', `${label} rejected the API key (${res.status}). Check ${keySetting}.`)
  }
  if (res.status === 402 || res.status === 429) throw new EngineError('quota', `${label} quota or rate limit reached (${res.status}). Check your plan's usage.`)
  if (res.status === 404) {
    // Speaches answers 404 for a model it hasn't downloaded yet; the path is fine then.
    const model = /Model '([^']+)' is not installed/i.exec(body)?.[1]
    if (model) {
      const models = url.replace(/\/audio\/[^/]+$/, '/models')
      throw new EngineError('config', `${label} hasn't downloaded the model ${model} yet. Download it once: curl -X POST ${models}/${model}`)
    }
    throw new EngineError('config', `${label} has no ${new URL(url).pathname} (404). Check the URL and model name.`)
  }
  throw new EngineError('other', `${label} error ${res.status}: ${body}`)
}

export async function readBuffer(res, label) {
  try {
    return Buffer.from(await res.arrayBuffer())
  } catch {
    throw new EngineError('network', `${label} stopped mid-answer.`)
  }
}

export async function readJson(res, label) {
  try {
    return await res.json()
  } catch {
    throw new EngineError('other', `${label} did not return JSON.`)
  }
}
