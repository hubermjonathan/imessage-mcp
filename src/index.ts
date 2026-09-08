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

const TOOL_DESCRIPTION = `Send the user a single iMessage to interrupt them, right now, on their phone.

This is an interruption, not a notification channel. The user is away from the
terminal and cannot see anything you write there. Use it only when continuing
without them is worse than interrupting them.

Use it when:
- You have hit a decision you cannot make alone — the options are genuinely
  ambiguous, they hinge on the user's intent or priorities, and any further work
  would likely be thrown away once they answer. Say what the decision is and what
  the options are.
- You found something the user would want to know before you finish — data loss,
  a credential in the repo, a broken production path, a bug that is much worse
  than the task you were given, a task premise that turns out to be false.

Do not use it for:
- Progress updates, status pings, or "starting on X now."
- "Done", "finished", summaries, or anything that can wait for your final reply.
- Questions you can answer yourself by reading the code, running the tests, or
  making a reasonable, stated assumption.
- Anything you could just as well put in your final response.

If in doubt, do not send. Pick the most defensible option, state the assumption
in your final answer, and keep working.

One message per interruption: put the decision or finding, the options, and what
you will do absent a reply in this single message — there is no reply channel and
no second send. Rate limits are enforced by the server (1 per 10 minutes, 5 per
session); a suppressed send returns an error and the user never sees it, so do
not retry a suppressed message.`;

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
          "The message to send. Self-contained: the user is reading it on a phone with no other context.",
        ),
      urgency: z
        .enum(["low", "normal", "high"])
        .default("normal")
        .describe("How badly this needs the user's attention right now."),
      reason: z
        .string()
        .min(1)
        .describe(
          "Why this warrants interrupting the user, in one line. If you cannot state a reason that survives scrutiny, do not send.",
        ),
    },
    outputSchema: { sent: z.boolean() },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ message, urgency, reason }) => {
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
      const why = reason.trim();
      if (!why) return errorResult("Not sent: reason is empty.");

      if (sentThisSession >= MAX_PER_SESSION) {
        return errorResult(
          `Suppressed: session limit reached (${MAX_PER_SESSION} messages). The user did ` +
            "NOT see this message and will not see any further ones this session. Do not " +
            "retry — put it in your final response instead.",
        );
      }

      if (lastSentAt !== null) {
        const remaining = COOLDOWN_MS - (Date.now() - lastSentAt);
        if (remaining > 0) {
          return errorResult(
            `Suppressed: rate limited (1 message per 10 minutes; ${formatDuration(remaining)} ` +
              "left). The user did NOT see this message. Do not retry — carry on and put it " +
              "in your final response instead.",
          );
        }
      }

      const prefix = urgency === "normal" ? "[Claude]" : `[Claude · ${urgency}]`;
      const body = `${prefix} ${text}\n\nWhy now: ${why}`;

      // Reserve the slot before sending so a hung/failed send cannot be retried
      // in a tight loop.
      lastSentAt = Date.now();
      sentThisSession += 1;

      try {
        await sendViaMessages(body, handle);
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
        `Sent to ${handle} (${sentThisSession}/${MAX_PER_SESSION} this session). There is no ` +
          "reply channel — do not wait for an answer.",
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
