import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as macos from '../../hub/audio/macos.mjs'
import * as linux from '../../hub/audio/linux.mjs'
import * as windows from '../../hub/audio/windows.mjs'
import { platformAudio } from '../../hub/audio/index.mjs'

const PCM = ['-ac', '1', '-ar', '16000', '-f', 's16le', '-']

test('platformAudio picks the module per platform; other Unix-likes get Linux', () => {
  assert.equal(platformAudio('win32'), windows)
  assert.equal(platformAudio('darwin'), macos)
  assert.equal(platformAudio('linux'), linux)
  assert.equal(platformAudio('freebsd'), linux)
  for (const m of [windows, macos, linux]) {
    for (const fn of ['listMics', 'captureArgv', 'playArgv', 'playOutcome']) assert.equal(typeof m[fn], 'function', fn)
    assert.match(m.FFMPEG_HINT, /ffmpeg/i)
  }
})

// ---- macOS ----

const AVF = [
  '[AVFoundation indev @ 0x7f8e1] AVFoundation video devices:',
  '[AVFoundation indev @ 0x7f8e1] [0] FaceTime HD Camera',
  '[AVFoundation indev @ 0x7f8e1] [1] Capture screen 0',
  '[AVFoundation indev @ 0x7f8e1] AVFoundation audio devices:',
  '[AVFoundation indev @ 0x7f8e1] [0] MacBook Pro Microphone',
  '[AVFoundation indev @ 0x7f8e1] [1] Yeti Stereo Microphone ',
  '[in#0 @ 0x600] Error opening input: Input/output error',
].join('\n')

test('macOS: parses audio devices only, by name', () => {
  assert.deepEqual(macos.parseAvfoundationDevices(AVF), ['MacBook Pro Microphone', 'Yeti Stereo Microphone'])
  assert.deepEqual(macos.parseAvfoundationDevices(''), [])
})

test('macOS: listMics reads stderr whatever the exit code; a missing ffmpeg is no mics', () => {
  const calls = []
  const spawnSync = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 1, stdout: '', stderr: AVF } }
  assert.deepEqual(macos.listMics({ spawnSync }), ['MacBook Pro Microphone', 'Yeti Stereo Microphone'])
  assert.deepEqual(calls[0].args, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''])
  assert.equal(calls[0].opts.cwd, process.cwd())
  assert.deepEqual(macos.listMics({ spawnSync: () => ({ error: new Error('ENOENT') }) }), [])
})

test('macOS: capture is audio-only avfoundation; playback is afplay', () => {
  assert.deepEqual(macos.captureArgv('MacBook Pro Microphone'),
    ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', ':MacBook Pro Microphone', ...PCM])
  assert.deepEqual(macos.playArgv('/tmp/a.wav'), ['afplay', ['/tmp/a.wav']])
  assert.match(macos.playOutcome({ code: 1, aborted: false, stderr: 'bad file' }).message, /afplay exit 1\): bad file/)
  assert.equal(macos.playOutcome({ code: 0, aborted: false }), null)
})

// ---- Linux ----

const PACTL = [
  '0\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED',
  '1\talsa_input.pci-0000_00_1f.3.analog-stereo\tPipeWire\ts32le 2ch 48000Hz\tRUNNING',
  '2\talsa_input.usb-Blue_Yeti-00.analog-stereo\tPipeWire\ts16le 2ch 48000Hz\tIDLE',
  '',
].join('\n')

test('Linux: pactl sources without monitors; fallback to default', () => {
  assert.deepEqual(linux.parsePactlSources(PACTL), [
    'alsa_input.pci-0000_00_1f.3.analog-stereo', 'alsa_input.usb-Blue_Yeti-00.analog-stereo',
  ])
  assert.deepEqual(linux.listMics({ spawnSync: () => ({ status: 0, stdout: PACTL }) }).length, 2)
  assert.deepEqual(linux.listMics({ spawnSync: () => ({ error: new Error('ENOENT') }) }), ['default'])
  assert.deepEqual(linux.listMics({ spawnSync: () => ({ status: 1, stdout: '' }) }), ['default'])
  assert.deepEqual(linux.listMics({ spawnSync: () => ({ status: 0, stdout: PACTL.split('\n')[0] }) }), ['default'])
})

test('Linux: pulse capture by default, alsa with an alsa: prefix; ffplay playback', () => {
  assert.deepEqual(linux.captureArgv('default'), ['-hide_banner', '-loglevel', 'error', '-f', 'pulse', '-i', 'default', ...PCM])
  assert.deepEqual(linux.captureArgv('alsa:hw:1,0'), ['-hide_banner', '-loglevel', 'error', '-f', 'alsa', '-i', 'hw:1,0', ...PCM])
  assert.deepEqual(linux.playArgv('a.mp3'), ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', 'a.mp3']])
  const enoent = Object.assign(new Error('spawn ffplay ENOENT'), { code: 'ENOENT' })
  assert.match(linux.playOutcome({ error: enoent, aborted: false }).message, /^ffplay not found\. .*apt install ffmpeg.*ffplay is on PATH/)
})
