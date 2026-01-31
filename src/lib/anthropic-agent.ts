import { query, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

export interface ImageInput {
  type: "base64";
  media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
}

interface RunAgentOptions {
  prompt: string;
  systemPrompt: string;
  model: string;
  role: string;
  images?: ImageInput[];
  workingDirectory?: string;
  maxTurns?: number;
  onDelta?: (text: string) => void;
  onToolUse?: (toolName: string, toolInput: unknown) => void;
  signal?: AbortSignal;
  abortController?: AbortController;
  mcpServer?: McpSdkServerConfigWithInstance | null;
}

interface RunAgentResult {
  text: string;
}

/**
 * Run an agent using the Claude Agent SDK (spawns a Claude Code instance).
 * All agents get native Claude Code tools. Managers also get MCP delegation tools.
 */
export async function runAgent({
  prompt,
  systemPrompt,
  model,
  role,
  workingDirectory,
  maxTurns: maxTurnsOverride,
  onDelta,
  onToolUse,
  signal,
  abortController: providedAbortController,
  mcpServer,
}: RunAgentOptions): Promise<RunAgentResult> {
  const abortController = providedAbortController || new AbortController();
  if (signal && !providedAbortController) {
    if (signal.aborted) return { text: "[Job stopped by the boss]" };
    signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  // Strip ANTHROPIC_API_KEY from env so the CLI uses its own stored credentials
  // (the .env OAuth token confuses the CLI if passed through)
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "ANTHROPIC_API_KEY" && v !== undefined) cleanEnv[k] = v;
  }

  const options: Parameters<typeof query>[0]["options"] = {
    systemPrompt,
    model,
    maxTurns: maxTurnsOverride ?? 15,
    persistSession: false,
    abortController,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    env: cleanEnv,
  };

  if (workingDirectory) {
    options.cwd = workingDirectory;
  }

  // Attach MCP server if provided (delegation tools for managers, or subordinate tools for soldiers with reports)
  if (mcpServer) {
    options.mcpServers = { agentmafia: mcpServer };
  }

  // Soldiers with no MCP server (leaf nodes) get full native tools
  // Managers with MCP server also get native tools now (SDK handles tool loop)
  // No need to restrict allowedTools — all agents get tools

  let resultText = "";
  let lastAssistantText = "";

  try {
    const q = query({ prompt, options });

    for await (const msg of q) {
      // Debug: log all message types to understand SDK output
      const msgType = (msg as Record<string, unknown>).type;
      if (msgType !== "assistant" && msgType !== "result") {
        console.log(`[AgentMafia SDK] Unknown msg type: ${msgType}`, JSON.stringify(msg).slice(0, 300));
      }
      // Capture assistant message text
      if (msg.type === "assistant" && msg.message?.content) {
        const textParts: string[] = [];
        const blockTypes = (msg.message.content as unknown as Array<Record<string, unknown>>).map((b) => b.type);
        if (blockTypes.some((t) => t !== "text")) {
          console.log(`[AgentMafia SDK] Assistant content block types: ${blockTypes.join(", ")}`);
        }
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text);
          }
        }
        if (textParts.length > 0) {
          lastAssistantText = textParts.join("");
          onDelta?.(lastAssistantText);
        }
      }

      // Detect tool use and notify callback
      if (onToolUse) {
        // Check assistant messages for tool_use content blocks (all variants)
        if (msg.type === "assistant" && msg.message?.content) {
          for (const block of msg.message.content) {
            const b = block as unknown as Record<string, unknown>;
            // Standard tool_use, server_tool_use (Claude Code builtins), and mcp_tool_use
            if ((b.type === "tool_use" || b.type === "server_tool_use" || b.type === "mcp_tool_use") && b.name && typeof b.name === "string") {
              console.log(`[AgentMafia SDK] Tool use detected (${b.type}): ${b.name}`);
              onToolUse(b.name, b.input);
            }
          }
        }
        // Also check for tool_use as a top-level message type (some SDK versions)
        if ((msg as Record<string, unknown>).type === "tool_use" || (msg as Record<string, unknown>).type === "server_tool_use") {
          const toolMsg = msg as Record<string, unknown>;
          if (toolMsg.name && typeof toolMsg.name === "string") {
            console.log(`[AgentMafia SDK] Tool use (top-level) detected: ${toolMsg.name}`);
            onToolUse(toolMsg.name, toolMsg.input);
          }
        }
        // Handle tool_progress messages (SDK fires these for built-in tools like Read, Write, Bash, etc.)
        if ((msg as Record<string, unknown>).type === "tool_progress") {
          const toolMsg = msg as Record<string, unknown>;
          if (toolMsg.tool_name && typeof toolMsg.tool_name === "string") {
            console.log(`[AgentMafia SDK] Tool progress detected: ${toolMsg.tool_name}`);
            onToolUse(toolMsg.tool_name, toolMsg);
          }
        }
        // Handle tool_use_summary messages
        if ((msg as Record<string, unknown>).type === "tool_use_summary") {
          const toolMsg = msg as Record<string, unknown>;
          if (toolMsg.tool_name && typeof toolMsg.tool_name === "string") {
            console.log(`[AgentMafia SDK] Tool use summary detected: ${toolMsg.tool_name}`);
            onToolUse(toolMsg.tool_name, toolMsg);
          }
        }
        // Handle stream_event messages for early tool detection
        if ((msg as Record<string, unknown>).type === "stream_event") {
          const streamMsg = msg as Record<string, unknown>;
          const event = streamMsg.event as Record<string, unknown> | undefined;
          if (event && event.type === "content_block_start") {
            const contentBlock = event.content_block as Record<string, unknown> | undefined;
            if (contentBlock && (contentBlock.type === "tool_use" || contentBlock.type === "server_tool_use" || contentBlock.type === "mcp_tool_use") && contentBlock.name && typeof contentBlock.name === "string") {
              console.log(`[AgentMafia SDK] Tool use (stream) detected: ${contentBlock.name}`);
              onToolUse(contentBlock.name, contentBlock.input);
            }
          }
        }
      }

      // Capture final result
      if (msg.type === "result") {
        if (msg.subtype === "success" && !("is_error" in msg && msg.is_error)) {
          resultText = msg.result || lastAssistantText;
        } else {
          console.error(`[AgentMafia SDK] Agent result error:`, JSON.stringify(msg).slice(0, 500));
          resultText = lastAssistantText || `[Agent error: ${msg.subtype}]`;
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) return { text: "[Job stopped by the boss]" };
    if (abortController.signal.aborted) return { text: lastAssistantText || resultText || "[Agent completed]" };
    console.error("[AgentMafia SDK] Query error:", err);
    if (lastAssistantText) return { text: lastAssistantText };
    throw err;
  }

  if (!resultText && lastAssistantText) resultText = lastAssistantText;

  return { text: resultText };
}
