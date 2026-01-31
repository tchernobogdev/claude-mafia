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
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
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
  onDelta,
  signal,
  mcpServer,
}: RunAgentOptions): Promise<RunAgentResult> {
  const abortController = new AbortController();
  if (signal) {
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
    maxTurns: 15,
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
      // Capture assistant message text
      if (msg.type === "assistant" && msg.message?.content) {
        const textParts: string[] = [];
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
    console.error("[AgentMafia SDK] Query error:", err);
    if (lastAssistantText) return { text: lastAssistantText };
    throw err;
  }

  if (!resultText && lastAssistantText) resultText = lastAssistantText;

  return { text: resultText };
}
