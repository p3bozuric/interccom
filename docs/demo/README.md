# Demo video

The source of the ~70 second interccom demo: three sessions (Claude Code, Codex, Copilot CLI) sharing one voice channel, then a coordinator.

- `lines.json`: what is said, and who says it.
- `audio/`: the voice lines, generated with ElevenLabs. Your lines use the "Adam" voice, and the agents use interccom's default ElevenLabs voice.
- `scene.html`: the animation. `seek(t)` draws the frame at time `t`, so every frame is deterministic. Open `scene.html?t=22` to see one frame.
- `build-audio.mjs`: lays out the timeline from the lengths of the lines and mixes in the hub's real "sent" chime. Writes `timeline.js`, `envelope.js` and `mix.wav`.
- `render.mjs`: steps through the scene in headless Edge, frame by frame, and encodes `interccom-demo.mp4` with ffmpeg.

## Rebuild

Needs Node, ffmpeg and Microsoft Edge.

```
npm install
npm run audio    # after editing timing or lines
npm run render   # takes a few minutes
```

To re-voice a line, delete its file in `audio/` and run `npm run voices` with `ELEVENLABS_API_KEY` set. The key needs the Text to Speech permission. Only missing lines are generated.

The rendered video is [interccom-demo.mp4](interccom-demo.mp4). A README can't play an MP4 from the repo, so to embed it, upload the same file by dragging it into the editor on github.com.
