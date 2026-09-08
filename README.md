# imessage-mcp

A minimal stdio MCP server with exactly one tool: `text_user`, which sends you an
iMessage. macOS only, Node 18+.

It exists so an agent can interrupt you on your phone when it has hit a decision
it can't make alone, or found something you'd want to know before it finishes.
Not for progress updates. Not for "done."

## Setup

```sh
npm install && npm run build
```

Set `IMESSAGE_HANDLE` to your phone number in E.164 form (`+15551234567`) or your
Apple ID email. Messages.app must be signed in to iMessage on the machine running
the server, and the process running the server needs Automation permission for
Messages (System Settings → Privacy & Security → Automation) — macOS prompts once
on the first send.

## Add to Claude Code

```sh
claude mcp add imessage --env IMESSAGE_HANDLE=+15551234567 -- node /absolute/path/to/imessage-mcp/dist/index.js
```

## Tool: `text_user`

| Field | Type | |
| --- | --- | --- |
| `message` | string | required — the text to send, self-contained |
| `urgency` | `"low" \| "normal" \| "high"` | optional, defaults to `normal` |
| `reason` | string | required — why this warrants interrupting you |

Returns `{ sent: true }` on success, or a plain error string explaining why it
wasn't sent. It never throws.

## Rate limits

Enforced by the server, not by the model's judgment:

- at most 1 send per 10 minutes
- at most 5 sends per server session

A send over either limit is suppressed and returns an error saying so, so the
model knows you never saw it. An attempt that reaches `osascript` and fails still
counts, which keeps a broken setup from retrying in a loop.

## Notes

The message and handle are passed to `osascript` as `argv` and never interpolated
into the AppleScript source, so message content can't alter the script. The script
doesn't call `activate`, so sending won't steal focus.

There is no receive path, no `chat.db` reading, no contact lookup, and no other
tools. Sending is one-way; the model can't see your reply.
