# imessage-mcp

A stdio MCP server with one tool, `text_user`, that sends an iMessage to a
configured handle. macOS only, Node 18+.

It is only a channel. When an agent should text you, and how often, is for your
harness or agent config to decide, not this server.

## Setup

```sh
npm install && npm run build
```

Requirements on the machine running the server:

- `IMESSAGE_HANDLE` set to the recipient's phone number in E.164 form
  (`+15551234567`) or their Apple ID email
- Messages.app signed in to iMessage
- Automation permission for Messages (System Settings > Privacy & Security >
  Automation). macOS prompts once on the first send.

## Add to Claude Code

```sh
claude mcp add imessage --env IMESSAGE_HANDLE=+15551234567 -- node /absolute/path/to/imessage-mcp/dist/index.js
```

## Tool: `text_user`

One required field, `message` (string), sent verbatim. Returns `{ sent: true }`,
or an error string explaining why it wasn't sent. It never throws.

No rate limit, cooldown, or send cap. Sending is one-way: no receive path, no
`chat.db` reading, no contact lookup, no other tools.

## Notes

`src/send.applescript` is a fixed script file, invoked with the message and
handle as arguments, so message content is never interpolated into its source.
It omits `activate`, so sending won't steal focus.
