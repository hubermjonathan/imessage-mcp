#!/usr/bin/env node
import { execFile } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const COOLDOWN_MS = 10 * 60 * 1000;
const MAX_PER_SESSION = 5;
const SEND_TIMEOUT_MS = 20_000;

let lastSentAt: number | null = null;
let sentThisSession = 0;

/**
 * AppleScript is passed as fixed source; the message and handle arrive as argv,
 * so nothing from the model is ever interpolated into the script text.
 * No `activate` — sending must not steal focus.
 */
const APPLESCRIPT = `on run argv
	set msgText to item 1 of argv
	set handleName to item 2 of argv
	tell application "Messages"
		set svc to 1st service whose service type = iMessage
		send msgText to buddy handleName of svc
	end tell
end run`;

const TOOL_DESCRIPTION = `Send an iMessage to the user's configured handle.

One-way: the message is delivered to the user's phone and there is no reply
channel, so it must stand on its own. Requires macOS with Messages.app signed in
to iMessage.

The server rate limits sends to 1 per 10 minutes and 5 per server session. A send
over either limit is not delivered and returns an error saying so.`;

function errorResult(text: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  };
}

function okResult(payload: { sent: boolean }, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: payload,
  };
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function sendViaMessages(message: string, handle: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-", message, handle],
      { timeout: SEND_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || "").trim();
          reject(new Error(detail || "osascript failed"));
          return;
        }
        resolve();
      },
    ).stdin?.end(APPLESCRIPT);
  });
}

const server = new McpServer(
  { name: "imessage-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.registerTool(
  "text_user",
  {
    title: "Text the user on iMessage",
    description: TOOL_DESCRIPTION,
    inputSchema: {
      message: z
        .string()
        .min(1)
        .describe(
          "The message to send. The user reads it on a phone with no other context, so make it self-contained.",
        ),
    },
    outputSchema: { sent: z.boolean() },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ message }) => {
    try {
      if (process.platform !== "darwin") {
        return errorResult(
          "Not sent: iMessage sending requires macOS (this server is running on " +
            `${process.platform}).`,
        );
      }

      const handle = (process.env.IMESSAGE_HANDLE ?? "").trim();
      if (!handle) {
        return errorResult(
          "Not sent: IMESSAGE_HANDLE is not set. Set it to the user's phone number in " +
            "E.164 form (e.g. +15551234567) or their Apple ID email.",
        );
      }

      const text = message.trim();
      if (!text) return errorResult("Not sent: message is empty.");

      if (sentThisSession >= MAX_PER_SESSION) {
        return errorResult(
          `Not sent: session limit reached (${MAX_PER_SESSION} messages). This message was not ` +
            "delivered, and no further messages will be delivered this session.",
        );
      }

      if (lastSentAt !== null) {
        const remaining = COOLDOWN_MS - (Date.now() - lastSentAt);
        if (remaining > 0) {
          return errorResult(
            `Not sent: rate limited (1 message per 10 minutes; ${formatDuration(remaining)} ` +
              "left). This message was not delivered.",
          );
        }
      }

      // Reserve the slot before sending so a hung or failed send cannot be
      // retried in a tight loop.
      lastSentAt = Date.now();
      sentThisSession += 1;

      try {
        await sendViaMessages(text, handle);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return errorResult(
          `Not sent: Messages rejected the send (${detail}). Common causes: Messages.app is ` +
            "not signed in to iMessage, the handle is not reachable over iMessage, or this " +
            "process lacks Automation permission for Messages (System Settings → Privacy & " +
            "Security → Automation). This attempt still counted against the rate limit.",
        );
      }

      return okResult(
        { sent: true },
        `Sent to ${handle} (${sentThisSession}/${MAX_PER_SESSION} this session).`,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return errorResult(`Not sent: unexpected error (${detail}).`);
    }
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`imessage-mcp: fatal: ${detail}\n`);
  process.exit(1);
});
