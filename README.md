# imessage-mcp

A minimal stdio MCP server exposing one tool, `text_user`, which sends an iMessage
to a configured handle. macOS only, Node 18+.

It is only a channel. It has no opinion about when an agent should use it — that
belongs to whatever harness, system prompt, or agent config is driving the tool.

## Setup

```sh
npm install && npm run build
```

Set `IMESSAGE_HANDLE` to the recipient's phone number in E.164 form
(`+15551234567`) or their Apple ID email. Messages.app must be signed in to
iMessage on the machine running the server, and the process running the server
needs Automation permission for Messages (System Settings → Privacy & Security →
Automation) — macOS prompts once on the first send.

## Add to Claude Code

```sh
claude mcp add imessage --env IMESSAGE_HANDLE=+15551234567 -- node /absolute/path/to/imessage-mcp/dist/index.js
```

## Tool: `text_user`

| Field | Type | |
| --- | --- | --- |
| `message` | string | required — the text to send, verbatim |

The message is sent exactly as given; the server adds no prefix, suffix, or
context of its own.

Returns `{ sent: true }` on success, or a plain error string explaining why it
wasn't sent. It never throws.

## Rate limits

Enforced by the server, not left to the caller:

- at most 1 send per 10 minutes
- at most 5 sends per server session

A send over either limit is not delivered and returns an error saying so. An
attempt that reaches `osascript` and fails still counts, which keeps a broken
setup from retrying in a loop.

## Notes

The message and handle are passed to `osascript` as `argv` and never interpolated
into the AppleScript source, so message content can't alter the script. The script
doesn't call `activate`, so sending won't steal focus.

Sending is one-way. There is no receive path, no `chat.db` reading, no contact
lookup, and no other tools.
