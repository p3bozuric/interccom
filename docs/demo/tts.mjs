import fs from 'node:fs'
const lines = JSON.parse(fs.readFileSync('lines.json','utf8'))
const VOICE = { you: 'pNInz6obpgDQGcFmaJgB', claude: '21m00Tcm4TlvDq8ikWAM' }
for (const l of lines) {
  const out = `audio/${l.id}.mp3`
  if (fs.existsSync(out)) continue
  const isYou = l.who === 'you'
  // The hub prefixes a session's name when several are connected; the coordinator never announces itself.
  const text = isYou || l.who === 'coordinator' ? l.text : `${l.who}: ${l.text}`
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${isYou ? VOICE.you : VOICE.claude}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }) })
  if (!res.ok) { console.log(l.id, res.status, (await res.text()).slice(0,200)); continue }
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer())); console.log('ok', l.id)
}
