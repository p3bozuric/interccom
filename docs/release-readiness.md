# Release readiness

What stands between interccom 0.7 and a release people can install and rely on. Assessed on 2026-11-22.

**Done** means it's in the repo. **Owner** means only the owner can do it. **To do** is open work.

## Must have before release

| # | Item | Status |
|---|---|---|
| 1 | **Tests run on every PR, on Windows, macOS and Linux.** Until now they ran only on one Windows PC. | Done: `.github/workflows/test.yml` (Node 22 and 24 on all three; Node 20 loads every hub module). Whatever the first runs on macOS and Linux turn up still needs fixing. |
| 2 | **A voice with no setup.** A new user with no key, no local server and no Docker heard nothing. | Done: the `system` engine (Windows speech, macOS `say`, Linux `espeak-ng`) and the automatic fallback to it. Checked live on Windows; macOS and Linux only in unit tests. |
| 3 | **Real macOS and Linux audio.** Capture, playback, device names and permissions have only run under unit tests (testing-locally.md 7c). | Owner, or a tester with a Mac or a Linux PC. |
| 4 | **Accurate docs.** The README said "early alpha (v0.1)", required Node 18.3, left Gemini out of the intro and setup, and listed a stale roadmap. | Done: README, package description, Node 20 requirement, an Uninstall section, CHANGELOG.md, SECURITY.md. |
| 5 | **Publishing.** The npm name `interccom` is free. Releases have no git tags or GitHub releases yet. | Owner: `npm publish`, then tag `v0.7.0` and write the GitHub release from CHANGELOG.md. |
| 6 | **The Claude Code marketplace installs from `main`.** Whatever is on `main` reaches users on their next update. | Owner decision: keep `main` releasable (CI helps), or point the marketplace at a release branch or tag. |

## Should have

| # | Item | Status |
|---|---|---|
| 7 | **Unverified in real use:** dictation while Claude works; the drawn wave in the desktop app; voice approvals in the desktop app; a real Gemini turn; the autonomy presets `routine` and `full` (testing-locally.md 5.2–5.4); the missing-permission and unplugged-mic messages (6.1, 6.3). | Owner at the mic, mostly a few minutes each. |
| 8 | **Other audio is heard as you.** A video saying "Hey Claude, …" on the speakers is treated as the person. | To do: a local wake word and voice detection ([research](research/2026-11-01-local-wake-word.md)) narrows it. Needs the owner's decisions listed there. Documented in SECURITY.md meanwhile. |
| 9 | **Privacy default.** In wake mode, everything the mic hears goes to the chosen transcription engine, because the wake word is checked on the transcript afterwards. | Documented. The local wake word (8) fixes it for cloud engines. |
| 10 | **The hint under the permission dialog** ("say approve or deny") never shows in the terminal. Claude Code accepts the call and draws nothing. | Claude Code's side. The spoken "…Approve?" is the cue meanwhile. |
| 11 | **Same-folder sessions** (`api`, `api-2`) can swap numbers when the hub restarts. | To do: keep a session's number when it reconnects with its old id. |

## Nice to have

- A coordinator in agents other than Claude Code ([proposal](superpowers/plans/2026-11-01-interccom-4-coordinator-in-other-agents.md)), and more agents.
- A mic picker in setup.
- The wave beside the message box, once Claude Code ships that slot (its published types document `BesidePrompt`; 2.1.330 doesn't have it yet).
- The PC going quiet while you use Claude on your phone.

## Already in place

- **Security:** a localhost hub with a per-run token, voice approvals reviewed twice, tagged voice notes, and no keys on disk (SECURITY.md).
- **No runtime dependencies,** and no native addons.
- **Tests:** about 280 in the suite. Each feature was checked live in real Claude Code sessions, as recorded in `docs/test-results/`.
- **Versions** agree across `package.json` and both plugin manifests, which a test enforces. So does the changelog's entry for the current version.
