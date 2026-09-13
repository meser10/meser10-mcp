#!/usr/bin/env node
/**
 * Meser10 MCP server.
 *
 * Startup sequence:
 *   1. Load config. Fail loudly and specifically if it is wrong - a bad env var
 *      should produce a sentence a developer can act on, not a stack trace.
 *   2. Fetch and parse the live WSDL.
 *   3. Derive the tool surface from it.
 *   4. Expose only the tools the configured mode allows.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, modeAllows, redact, ConfigError, type Config } from "./config.js";
import { fetchWsdl, parseWsdl, type ApiModel } from "./wsdl.js";
import { buildTools, type ToolDef } from "./tools.js";
import { callOperation, ApiCallError, SoapFault } from "./soap.js";

const NAME = "meser10";
const VERSION = "0.1.0";

/** Recipient-bearing parameters, for the send cap. */
const RECIPIENT_PARAMS = ["saPhoneNumbers", "saEMailAddresses", "saGroups"];

function countRecipients(args: Record<string, unknown>): number {
  let n = 0;
  for (const key of RECIPIENT_PARAMS) {
    const v = args[key];
    if (Array.isArray(v)) n += v.length;
  }
  return n;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

async function main(): Promise<void> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n[meser10-mcp] Configuration error\n  ${err.message}\n\n`);
      process.exit(2);
    }
    throw err;
  }

  let model: ApiModel;
  try {
    model = parseWsdl(await fetchWsdl(cfg.endpoint));
  } catch (err) {
    process.stderr.write(
      `\n[meser10-mcp] Could not read the API contract from ${cfg.endpoint}\n` +
        `  ${(err as Error).message}\n` +
        `  The server derives its tools from the live WSDL, so it cannot start without it.\n\n`,
    );
    process.exit(3);
  }

  const all = buildTools(model);
  const exposeLegacy = process.env.MESER10_EXPOSE_LEGACY === "true";
  const exposed = all.filter((t) => modeAllows(cfg.mode, t.mode) && (exposeLegacy || !t.legacy));
  const byName = new Map<string, ToolDef>(exposed.map((t) => [t.name, t]));

  process.stderr.write(
    `[meser10-mcp] ${model.operations.length} operations in the contract, ` +
      `${exposed.length} exposed at mode "${cfg.mode}"` +
      `${exposeLegacy ? "" : ` (${all.filter((t) => t.legacy).length} legacy variants hidden)`}.\n`,
  );

  const server = new Server({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposed.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      const hidden = all.find((t) => t.name === req.params.name);
      if (hidden) {
        return textResult(
          `Tool "${req.params.name}" exists but is not enabled. It is classified "${hidden.mode}" ` +
            `and the server is running in mode "${cfg.mode}". ` +
            `Raise MESER10_MODE to "${hidden.mode}" to enable it - this is a deliberate safety gate.`,
          true,
        );
      }
      return textResult(`Unknown tool "${req.params.name}".`, true);
    }

    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    if (tool.mode === "send") {
      const n = countRecipients(args);
      if (n > cfg.maxRecipients) {
        return textResult(
          `Refusing to send: this call targets ${n} recipients and MESER10_MAX_RECIPIENTS is ${cfg.maxRecipients}. ` +
            `Raise the cap deliberately if that is really the intent.`,
          true,
        );
      }
    }

    try {
      const result = await callOperation(tool.operation, args, cfg, model);
      return textResult(JSON.stringify(result, null, 2));
    } catch (err) {
      if (err instanceof ApiCallError) return textResult(err.message, true);
      if (err instanceof SoapFault) return textResult(`Transport error: ${err.message}`, true);
      return textResult(`Unexpected error: ${redact(String((err as Error).message ?? err), cfg)}`, true);
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`[meser10-mcp] fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
