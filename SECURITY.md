# Security

## Reporting a vulnerability

Please report it privately: on GitHub, open the repository's **Security** tab and choose **Report a vulnerability**. If that isn't available, open an issue that says only that you have a security report and asks for a private way to send it. Don't put the details in a public issue.

You'll get an answer within a week. A fix goes out as a new version, with a line in [CHANGELOG.md](CHANGELOG.md).

## What interccom protects

- **The hub** listens only on `127.0.0.1`. Every request needs a random token made at start-up and kept in `~/.interccom/hub.json`. A session finds the hub by checking that it can prove it holds that token before sending it anything.
- **Voice approvals** settle a permission prompt only on the person's own spoken answer. The rules:
  - the answer must be the whole utterance;
  - a destructive action needs a second "confirm";
  - the coordinator never sees the answer;
  - an error or timeout never approves.

  Tools an organization caps at "ask", Claude's own questions, and anything while the mic or interccom is off are never answered by voice.
- **Voice notes** reach Claude with a secret per-session tag, so text in a file or web page that imitates one is treated as untrusted.
- **API keys** come from the plugin settings or the environment, and interccom never writes them to disk.

## Known limits

- Anything on the speakers that the mic picks up is heard as the person: a video saying "Hey Claude, …" is treated as you. Use **Mic off** while such audio plays.
- In wake-word and always-on mode, everything the mic hears goes to the transcription engine you chose. With `local` or `command` engines it stays on your machine.
- Another program running as you can read the hub token, as it could read anything else of yours.
