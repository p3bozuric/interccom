// Stand-in for piper: reads text on stdin, writes "RIFF" + text to the --output_file path (or stdout).
import { writeFileSync } from 'node:fs'
let text = ''
process.stdin.on('data', d => { text += d })
process.stdin.on('end', () => {
  const i = process.argv.indexOf('--output_file')
  const audio = Buffer.from(`RIFF${text}`)
  if (process.argv.includes('--fail')) { process.stderr.write('model not found'); process.exit(3) }
  if (i >= 0) writeFileSync(process.argv[i + 1], audio)
  else process.stdout.write(audio)
})
