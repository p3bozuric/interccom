import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDshowDevices, listMics, captureArgv, playArgv, playOutcome } from '../../hub/audio/windows.mjs'

const FIXTURE = [
  '[dshow @ 0000012345abcdef] "HD Webcam" (video)',
  '[dshow @ 0000012345abcdef]   Alternative name "@device_pnp_\\\\?\\usb#vid_1234"',
  '[dshow @ 0000012345abcdef] "Microphone (USB Audio Device)" (audio)',
  '[dshow @ 0000012345abcdef]   Alternative name "@device_cm_{00000000-1111}"',
].join('\n')

test('parseDshowDevices returns audio devices only', () => {
  assert.deepEqual(parseDshowDevices(FIXTURE), ['Microphone (USB Audio Device)'])
})

test('parseDshowDevices on empty input is empty', () => {
  assert.deepEqual(parseDshowDevices(''), [])
})

test('captureArgv is exact', () => {
  assert.deepEqual(captureArgv('Mic X'), [
    '-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', 'audio=Mic X',
    '-ac', '1', '-ar', '16000', '-f', 's16le', '-',
  ])
})

test('playArgv is exact', () => {
  assert.deepEqual(playArgv('a.mp3'), ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', 'a.mp3']])
})

test('listMics parses stderr whatever the exit code, in a safe cwd, hidden', () => {
  const calls = []
  const spawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return { status: 1, stdout: '', stderr: FIXTURE }
  }
  assert.deepEqual(listMics({ spawnSync }), ['Microphone (USB Audio Device)'])
  assert.equal(calls[0].cmd, 'ffmpeg')
  assert.deepEqual(calls[0].args, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'])
  assert.equal(calls[0].opts.windowsHide, true)
  assert.equal(calls[0].opts.cwd, process.cwd())
})

test('listMics also reads stdout and survives a missing ffmpeg', () => {
  assert.deepEqual(listMics({ spawnSync: () => ({ status: 0, stdout: FIXTURE, stderr: '' }) }), ['Microphone (USB Audio Device)'])
  assert.deepEqual(listMics({ spawnSync: () => ({ error: new Error('ENOENT'), status: null }) }), [])
})

test('playOutcome: clean exit or an abort is fine', () => {
  assert.equal(playOutcome({ code: 0, aborted: false, stderr: 'noise' }), null)
  assert.equal(playOutcome({ code: 1, aborted: true, stderr: 'killed' }), null)
  assert.equal(playOutcome({ code: null, aborted: true, stderr: '' }), null)
})

test('playOutcome: a failed exit carries the code and the last 200 chars of stderr', () => {
  const stderr = 'x'.repeat(250) + 'y'.repeat(200)
  const err = playOutcome({ code: 1, aborted: false, stderr })
  assert.equal(err.message, `Couldn't play audio (ffplay exit 1): ${'y'.repeat(200)}`)
})

test('playOutcome: missing ffplay gets install guidance; other spawn errors pass through', () => {
  const enoent = Object.assign(new Error('spawn ffplay ENOENT'), { code: 'ENOENT' })
  assert.equal(playOutcome({ error: enoent, aborted: false }).message,
    "ffplay not found. Install ffmpeg (Windows: winget install Gyan.FFmpeg) and make sure it's on PATH.")
  const other = new Error('EACCES')
  assert.equal(playOutcome({ error: other, aborted: false }), other)
})
