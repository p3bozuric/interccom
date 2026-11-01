# Local wake word and VAD without native dependencies

Date: 2026-11-01. Status: research only, no code changed.

## Where we are

`hub/listener.mjs` reads 30 ms frames from ffmpeg. `hub/vad.mjs` cuts utterances with an RMS threshold set at 3x a learned noise floor. Every utterance goes to the STT engine, and `hub/router.mjs` looks for "Hey Claude" only after transcription. While the hub plays its own speech, the mic is muted (`isMuted`). This causes three problems:

- With a cloud engine, everything said near the mic goes to the cloud.
- Steady noise, music or video audio trips the energy VAD.
- Speakers playing other audio (anything except the hub's own speech) are heard as the person.

The roadmap asks for a local VAD model and a local wake word. The rule is no node-gyp and no compiled `.node` addons.

## Options

The CPU figures are from a prototype I ran on this Windows machine (Node 24.14, one thread, 16 kHz, streamed in 32 ms or 100 ms chunks, test speech from Windows SAPI voices). "CPU %" means the share of one core.

| Option | Plain Node, no native? | Model size / license | Custom "Hey Claude" | CPU (measured) | Maintenance / install size |
|---|---|---|---|---|---|
| **sherpa-onnx (npm `sherpa-onnx`, WASM build)**: Silero VAD + keyword spotter (KWS) | **Yes.** One `.wasm`, no dependencies. (The other package, `sherpa-onnx-node`, is a native addon. Avoid it.) | KWS: zipformer-gigaspeech-3.3M, int8 is ~5.3 MB on disk (17.6 MB tarball with fp32 included). Model card says Apache-2.0, but it was **trained on GigaSpeech, whose access terms say non-commercial research/education only**. Silero VAD: MIT, 2.3 MB. | **Open-vocabulary, no training.** I typed the keyword as BPE tokens `▁HE Y ▁C LA U DE` with boost and threshold settings. | KWS ≈ 3% (RTF 0.03). VAD ≈ 4% (RTF 0.012). RSS ~145 MB. | Very active (2.0.1, Oct 2026), Apache-2.0 code. 15 MB unpacked. WASM is single-threaded. |
| **onnxruntime-web + Silero VAD** (model taken from `@ricky0123/vad-web`) | **Yes**, it loaded in Node with `require('onnxruntime-web')` | Silero v5/v6: 2.3 MB, MIT | n/a (VAD only) | ≈ 5–7% (RTF 0.02). RSS 185–300 MB. | ORT is MIT and very active (1.31.1, Oct 2026), but the package is **145 MB unpacked** because it ships every bundle. Only ~15 MB (one `.mjs` and one `.wasm`) is needed. |
| **openWakeWord on onnxruntime-web** (hand-written port) | Yes, once ported. There is no official JS port; the README says the pre/post-processing would need porting. | mel 1.1 MB + embedding 1.3 MB + classifier 0.2–1.7 MB. **Pretrained models are CC BY-NC-SA 4.0.** The code is Apache-2.0. | A custom model needs training (Colab, <1 h, synthetic TTS clips plus large negative sets). The README gives no license for user-trained models. | Not measured. The README says 15–20 models run on one RPi3 core, so it is light. | Last release v0.6.0 (Feb 2024), last commit Dec 2025. Slow. |
| `@ricky0123/vad-node`, `avr-vad` | **No.** Both depend on `onnxruntime-node` (prebuilt native addon, 307 MB unpacked) | Silero, MIT | n/a | – | vad-node is stale (0.0.3, 2024) |
| Picovoice Porcupine | **No** for Node: `porcupine-node` ships prebuilt `pv_porcupine.node` binaries. `porcupine-web` (WASM) targets browsers. | Proprietary engine. Requires an AccessKey that is checked online at start. | Custom words via Picovoice Console, with time and platform limits | – | **A Home Assistant forum thread quotes a Picovoice reply: Free Tier keys stop working after 2026-06-30, and no non-commercial tier is planned.** Not usable for an open-source npm tool. |
| Vosk (`vosk` / `vosk-browser`) | `vosk` is native (ffi-napi). `vosk-browser` is WASM but browser-oriented. | Small English model ~40 MB, Apache-2.0 | Grammar-restricted recognition can act as a keyword spotter | – | vosk-browser has been unmaintained since 2022 |
| Local Whisper as the gate (Speaches, today) | Yes. It is a separate process or Docker container. | Whisper: MIT | Any phrase. This is the current regex. | One whole STT pass per utterance, including TV and music | Already supported |

Prototype results. These are anecdotal: synthetic voices and a handful of clips.

- **KWS:** detected "Hey Claude" in 3 of 4 positive clips, at 2.3 s into "Okay. Hey Claude. What is the status…" with both voices.
  - Clips 1–2: the David and Zira voices saying that sentence.
  - Clip 3: a clean David clip, "Hey Claude, run the tests…".
  - The miss: the same David sentence with 3 s of pink noise spliced in front. It was missed at every threshold I tried, so the threshold needs tuning on real mic audio.
- **KWS false accepts:** 0 of 4 negative clips. The negatives were "Hey, could you open the door? Claudia is here." and "…the clouds rolled in.", each in both voices.
- **Silero VAD:** both the onnxruntime-web path and the sherpa-onnx path found exactly the two speech segments and none in the noise.
- **Silero v6 input:** v6 only works if the caller prepends the 64-sample context (576-sample input). v5 tolerates 512.

## When the local STT gate is good enough

If the engine is local (Speaches or a command-line Whisper), nothing leaves the machine. Today's transcribe-then-regex design already acts as a wake word and has the best phrase accuracy. Its costs:

- Whisper runs on every VAD segment, including background speech, music and TV.
- Each false segment adds latency and fan noise.
- Whisper hallucinates text on non-speech, which can occasionally match "Claude".

This is good enough for users with a local engine, a quiet room and spare CPU or GPU. It is **not** enough for cloud engines, where privacy and per-minute cost are the reasons to gate. A better VAD (Phase 1) shrinks the local-Whisper cost on its own.

## Recommendation: sherpa-onnx WASM for both jobs, phased

Run both models in **one dependency, `sherpa-onnx` (WASM)**. It has no dependencies, is 15 MB and Apache-2.0, ships VAD and KWS as a pure JS/WASM package, and also offers speaker embeddings and streaming ASR later. onnxruntime-web would also work for VAD. The cost is a 145 MB package (or vendoring 15 MB of it) and writing the Silero glue ourselves.

1. **Phase 1: Silero VAD.**
   - Add `hub/vad-silero.mjs` behind the same `push`/`reset`/`active` interface as `vad.mjs`.
   - Re-buffer 30 ms frames to 512-sample windows.
   - Keep the energy VAD as the fallback when the module or model fails to load.
   - Ship the Silero ONNX (2.3 MB, MIT) inside the package.
   - Expected effect: fewer noise and music segments sent to STT. Risk is low.
2. **Phase 2: local KWS gate.**
   - Add a config setting, e.g. `INTERCCOM_WAKE=local|stt`.
   - In `local` mode, stream every frame through the KWS. Only after a hit (and during the router's existing 10 s "armed" window) is the current utterance, including pre-roll, sent to STT.
   - The router regex stays as a second check that strips the wake words.
   - Download the KWS model on first use (`interccom setup`) into the user's data folder rather than shipping it in the npm tarball.
   - Default to `local` when the engine is a cloud one and to `stt` when it is local.
3. **Phase 3 (optional): the speakers problem.**
   - A wake word alone already stops most stray audio from reaching agents.
   - Next steps: sherpa-onnx speaker verification (enroll the owner's voice, drop other voices) or echo cancellation against a loopback reference.
   - AEC needs a loopback capture that ffmpeg does not give portably. It is a separate project.

## Risks

- **License of the KWS model:** the weights are tagged Apache-2.0, but their training data (GigaSpeech) is non-commercial. That is fine for MIT hobby use but unclear for commercial users. If this matters, the fallback is a self-trained model (icefall recipe) on a commercially clean corpus.
- **Accuracy is unproven on real mics, accents and far-field audio.**
  - Open-vocabulary KWS is weaker than a dedicated trained model, and "Claude" is close to "cloud" and "clod".
  - Missing the wake word is worse than a false trigger, because the person has to repeat it.
  - Tuning needs a small real-recording test set.
- **WASM is single-threaded:** KWS and VAD together cost about 7% of one core always-on. That is fine on desktops but noticeable on battery.
- **Memory:** about 150 MB RSS per WASM instance, which adds to the hub's footprint.
- **Packaging:** onnxruntime-web is 145 MB unpacked if used whole. Model downloads at setup need checksums, a proxy story and an offline fallback.
- **Latency:** KWS fires about 0.3–0.5 s after the word ends. The utterance buffer must keep everything after the wake word.
- **Upstream churn:** sherpa-onnx's JS API has changed between releases, so pin the version.

## Decisions for the owner

1. **Does a WASM runtime count as "no native"?** It installs with plain npm everywhere and has no compile step and no `.node` file, but it is compiled C++ in a `.wasm`. I recommend yes.
2. **Which runtime:** `sherpa-onnx` (15 MB, VAD + KWS in one) or `onnxruntime-web` (145 MB package, more glue, VAD only unless openWakeWord is ported).
3. **KWS model license:** is "Apache-2.0 weights trained on non-commercial GigaSpeech" acceptable in an MIT package? Or should it be download-only with a notice, or self-trained?
4. **openWakeWord:** its CC BY-NC-SA pretrained models are NonCommercial and ShareAlike. They cannot ship in an MIT package that commercial users rely on. Rule them out, or allow them as an opt-in user download only?
5. **Size:** ship the Silero model in the npm tarball (+2.3 MB)? Download the KWS model (~5 MB int8, 17.6 MB tarball) at setup or on first use?
6. **Default behavior:** should the local wake word be on by default for cloud engines? Should Whisper-as-gate stay the default for local engines?
7. **Picovoice:** confirm it is out of scope (native addon, AccessKey, free tier ended).

## Sources

- sherpa-onnx KWS docs (open vocabulary, keyword format): https://k2-fsa.github.io/sherpa/onnx/kws/index.html
- sherpa-onnx KWS models: https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models
- sherpa-onnx Node examples: https://github.com/k2-fsa/sherpa-onnx/tree/master/nodejs-examples
- WASM vs addon packages: https://k2-fsa.github.io/sherpa/onnx/moonshine/javascript.html
- GigaSpeech access terms: https://huggingface.co/datasets/distil-whisper/gigaspeech-l
- Loquacious Set paper on GigaSpeech's non-commercial status: https://arxiv.org/abs/2505.21578
- Silero VAD (MIT, under 1 ms per chunk): https://github.com/snakers4/silero-vad
- ricky0123/vad (ships Silero v5/v6 ONNX; vad-node uses onnxruntime-node): https://github.com/ricky0123/vad
- ONNX Runtime Web: https://onnxruntime.ai/docs/get-started/with-javascript/web.html
- openWakeWord (license section, training, JS FAQ): https://github.com/dscripka/openWakeWord
- CC BY-NC-SA 4.0: https://creativecommons.org/licenses/by-nc-sa/4.0/
- Picovoice FAQ (AccessKey validation): https://picovoice.ai/docs/faq/general
- Picovoice free tier ending (forum report quoting Picovoice): https://community.home-assistant.io/t/fyi-picovoice-confirmed-free-tier-accesskeys-will-stop-working-after-june-30-2026/1012744
- Vosk browser: https://github.com/ccoreilly/vosk-browser
- npm metadata (`npm view`, 2026-11-01): sherpa-onnx 2.0.1, onnxruntime-web 1.31.1, onnxruntime-node 1.31.1, @ricky0123/vad-node 0.0.3, avr-vad 1.0.10, @picovoice/porcupine-node 4.0.2, vosk 0.3.39, vosk-browser 0.0.8.
- Prototype scripts (not in the repo): `C:\Users\atk\AppData\Local\Temp\claude\C--Users-atk-Desktop-Personal-shit-interccom--claude-worktrees-pull-merged-changes-00f9eb\62ffa639-846e-482a-b26a-3e878e799d29\scratchpad\wakeword\scripts\` (`silero.mjs`, `silero_ctx.mjs`, `svad.mjs`, `kws.mjs`).
