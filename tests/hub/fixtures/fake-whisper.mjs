// Stand-in for whisper-cli: prints a timestamped transcript naming how many bytes {in} held.
import { readFileSync } from 'node:fs'
const f = process.argv[process.argv.indexOf('-f') + 1]
const n = readFileSync(f).length
process.stdout.write(`\n[00:00:00.000 --> 00:00:01.500]   heard ${n}\n[00:00:01.500 --> 00:00:02.000]  bytes\n`)
