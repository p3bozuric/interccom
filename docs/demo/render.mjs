// Steps the scene frame by frame in headless Edge and pipes JPEGs straight into ffmpeg.
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const browser = await chromium.launch({ channel: 'msedge' })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.goto(pathToFileURL(process.cwd() + '/scene.html').href)
const { total, fps } = await page.evaluate(() => ({ total: window.TOTAL, fps: window.FPS }))
const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', '-i', 'mix.wav',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', 'interccom-demo.raw.mp4'], { stdio: ['pipe', 'inherit', 'inherit'] })
const frames = total * fps
for (let f = 0; f < frames; f++) {
  await page.evaluate(t => window.seek(t), f / fps)
  const buf = await page.screenshot({ type: 'jpeg', quality: 95 })
  if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r))
  if (f % 300 === 0) console.log(`frame ${f}/${frames}`)
}
ff.stdin.end()
await new Promise(r => ff.on('close', r))
await browser.close()
// Loudness-normalise the audio so it plays at a sensible level on social feeds.
await new Promise((resolve, reject) => spawn('ffmpeg', ['-y', '-v', 'error', '-i', 'interccom-demo.raw.mp4', '-c:v', 'copy', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', 'interccom-demo.mp4'], { stdio: 'inherit' }).on('close', c => c ? reject(new Error('ffmpeg ' + c)) : resolve()))
console.log('done: interccom-demo.mp4')
