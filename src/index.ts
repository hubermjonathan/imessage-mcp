#!/usr/bin/env node
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SEND_TIMEOUT_MS = 20_000;

const run = promisify(execFile);

const SCRIPT_PATH = fileURLToPath(new URL("./send.applescript", import.meta.url));

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

const server = new McpServer({ name: "imessage-mcp", version: "1.0.0" });

server.registerTool(
  "text_user",
  {
    title: "Text the user",
    description:
      "Send a text message to the user's phone. Use it when the user has asked to " +
      "be texted, for example \"text me when the deploy finishes\" or \"text me if you " +
      "get stuck\". One-way: there is no reply channel, so the message must stand on " +
      "its own.",
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
          "E.164 form (e.g. +11234567890) or their Apple ID email.",
      );
    }

    try {
      await run("/usr/bin/osascript", [SCRIPT_PATH, message, handle], {
        timeout: SEND_TIMEOUT_MS,
      });
    } catch (err) {
      const detail = (err instanceof Error ? err.message : String(err)).trim();
      return errorResult(
        `Not sent: ${detail}\nCommon causes: not running on macOS, Messages.app is not ` +
          "signed in to iMessage, the handle is not reachable over iMessage, or this " +
          "process lacks Automation permission for Messages (System Settings > Privacy " +
          "& Security > Automation).",
      );
    }

    return {
      content: [{ type: "text" as const, text: `Sent to ${handle}.` }],
      structuredContent: { sent: true },
    };
  },
);

await server.connect(new StdioServerTransport());
