#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const COOLDOWN_MS = 10 * 60 * 1000;
const MAX_PER_SESSION = 5;
const SEND_TIMEOUT_MS = 20_000;

let lastSentAt: number | null = null;
let sentThisSession = 0;

const run = promisify(execFile);

/**
 * Fixed script source; the message and handle arrive as argv, so nothing from
 * the model is interpolated into the script text. No `activate` — sending must
 * not steal focus.
 */
const APPLESCRIPT = `on run argv
  tell application "Messages"
    set svc to 1st service whose service type = iMessage
    send item 1 of argv to buddy (item 2 of argv) of svc
  end tell
end run`;

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

const server = new McpServer({ name: "imessage-mcp", version: "0.1.0" });

server.registerTool(
  "text_user",
  {
    title: "Text the user on iMessage",
    description:
      "Send an iMessage to the user's configured handle. One-way: there is no reply " +
      "channel, so the message must stand on its own. Requires macOS with Messages.app " +
      `signed in to iMessage. Rate limited to 1 send per ${COOLDOWN_MS / 60_000} minutes ` +
      `and ${MAX_PER_SESSION} per server session; a send over either limit is not ` +
      "delivered and returns an error.",
    inputSchema: {
      message: z
        .string()
        .trim()
        .min(1)
        .describe(
          "The message to send. The user reads it on a phone with no other context, so make it self-contained.",
        ),
    },
    outputSchema: { sent: z.boolean() },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ message }) => {
    const handle = (process.env.IMESSAGE_HANDLE ?? "").trim();
    if (!handle) {
      return errorResult(
        "Not sent: IMESSAGE_HANDLE is not set. Set it to the user's phone number in " +
          "E.164 form (e.g. +15551234567) or their Apple ID email.",
      );
    }

    if (sentThisSession >= MAX_PER_SESSION) {
      return errorResult(
        `Not sent: session limit reached (${MAX_PER_SESSION} messages). No further ` +
          "messages will be delivered this session.",
      );
    }

    const remaining = lastSentAt === null ? 0 : COOLDOWN_MS - (Date.now() - lastSentAt);
    if (remaining > 0) {
      return errorResult(
        `Not sent: rate limited, ${Math.ceil(remaining / 1000)}s left before the next send.`,
      );
    }

    // Reserve the slot before sending so a hung or failed send cannot be
    // retried in a tight loop.
    lastSentAt = Date.now();
    sentThisSession += 1;

    try {
      await run("/usr/bin/osascript", ["-e", APPLESCRIPT, message, handle], {
        timeout: SEND_TIMEOUT_MS,
      });
    } catch (err) {
      const detail = (err instanceof Error ? err.message : String(err)).trim();
      return errorResult(
        `Not sent: ${detail}\nCommon causes: not running on macOS, Messages.app is not ` +
          "signed in to iMessage, the handle is not reachable over iMessage, or this " +
          "process lacks Automation permission for Messages (System Settings → Privacy " +
          "& Security → Automation). This attempt still counted against the rate limit.",
      );
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Sent to ${handle} (${sentThisSession}/${MAX_PER_SESSION} this session).`,
        },
      ],
      structuredContent: { sent: true },
    };
  },
);

await server.connect(new StdioServerTransport());
