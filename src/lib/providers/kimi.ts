/**
 * Kimi 2.5 provider implementation
 * Uses OpenAI-compatible API format
 */

import {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderTool,
  ProviderToolCall,
  ProviderMessage,
} from "./types";

const KIMI_API_BASE = "https://api.moonshot.ai/v1";

const KIMI_MODELS = [
  "kimi-2.5-latest",          // Latest Kimi 2.5
  "moonshot-v1-128k",         // 128k context
  "moonshot-v1-32k",          // 32k context
  "moonshot-v1-8k",           // 8k context
];

// OpenAI-compatible content types for multimodal messages
type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

interface OpenAIMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

interface OpenAIResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class KimiProvider implements LLMProvider {
  id = "kimi" as const;
  name = "Kimi 2.5 (Moonshot)";

  isConfigured(): boolean {
    return !!process.env.KIMI_API_KEY || !!process.env.MOONSHOT_API_KEY;
  }

  getModels(): string[] {
    return KIMI_MODELS;
  }

  private getApiKey(): string {
    const key = process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY;
    if (!key) {
      throw new Error("KIMI_API_KEY or MOONSHOT_API_KEY not configured");
    }
    return key;
  }

  convertTools(tools: ProviderTool[]): OpenAITool[] {
    // Convert to OpenAI function calling format
    return tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object" as const,
          properties: tool.parameters.properties,
          required: tool.parameters.required || [],
        },
      },
    }));
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    const messages = this.convertMessages(request.messages, request.system);

    const body: Record<string, unknown> = {
      model: request.model || "kimi-2.5-latest",
      messages,
      max_tokens: request.max_tokens || 8192,
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = this.convertTools(request.tools);
      body.tool_choice = "auto";
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.stop_sequences && request.stop_sequences.length > 0) {
      body.stop = request.stop_sequences;
    }

    const response = await fetch(`${KIMI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.getApiKey()}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Kimi API error: ${response.status} - ${errorText}`);
    }

    const data: OpenAIResponse = await response.json();
    return this.parseResponse(data);
  }

  private convertMessages(
    messages: ProviderMessage[],
    system?: string
  ): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];

    // Add system message first if provided
    if (system) {
      result.push({ role: "system", content: system });
    }

    for (const msg of messages) {
      if (msg.role === "system") {
        // Combine with existing system or add new
        if (result.length > 0 && result[0].role === "system") {
          const existingContent = result[0].content;
          if (typeof existingContent === "string") {
            result[0].content = existingContent + "\n" + (typeof msg.content === "string" ? msg.content : "");
          }
        } else {
          result.unshift({
            role: "system",
            content: typeof msg.content === "string" ? msg.content : "",
          });
        }
        continue;
      }

      if (typeof msg.content === "string") {
        result.push({ role: msg.role, content: msg.content });
      } else {
        // Handle content blocks with multimodal support
        const contentParts: OpenAIContentPart[] = [];
        const toolCalls: OpenAIToolCall[] = [];
        let hasImages = false;

        for (const block of msg.content) {
          if (block.type === "text") {
            contentParts.push({ type: "text", text: block.text || "" });
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id || "",
              type: "function",
              function: {
                name: block.name || "",
                arguments: JSON.stringify(block.input || {}),
              },
            });
          } else if (block.type === "tool_result") {
            // Tool results go as separate tool messages
            result.push({
              role: "tool",
              content: typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content),
              tool_call_id: block.tool_use_id,
            });
            continue;
          } else if (block.type === "image" && block.source) {
            hasImages = true;
            // Convert to OpenAI vision format
            // Kimi uses the same format as OpenAI for vision: image_url with data URI
            if (block.source.type === "base64" && block.source.data) {
              const mediaType = block.source.media_type || "image/png";
              const dataUri = `data:${mediaType};base64,${block.source.data}`;
              contentParts.push({
                type: "image_url",
                image_url: {
                  url: dataUri,
                  detail: "high", // Use high detail for better visual analysis
                },
              });
            } else if (block.source.type === "url" && block.source.url) {
              contentParts.push({
                type: "image_url",
                image_url: {
                  url: block.source.url,
                  detail: "high",
                },
              });
            }
          }
        }

        if (contentParts.length > 0 || toolCalls.length > 0) {
          const openAIMsg: OpenAIMessage = {
            role: msg.role,
            // Use array format for multimodal content, string for text-only
            content: hasImages
              ? contentParts
              : contentParts.length > 0
                ? contentParts.map((p) => (p.type === "text" ? p.text : "")).join("\n")
                : null,
          };
          if (toolCalls.length > 0) {
            openAIMsg.tool_calls = toolCalls;
          }
          result.push(openAIMsg);
        }
      }
    }

    return result;
  }

  private parseResponse(response: OpenAIResponse): ProviderResponse {
    const choice = response.choices[0];
    const toolCalls: ProviderToolCall[] = [];

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        try {
          toolCalls.push({
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        } catch {
          // Handle invalid JSON in arguments
          toolCalls.push({
            id: tc.id,
            name: tc.function.name,
            input: { raw: tc.function.arguments },
          });
        }
      }
    }

    return {
      id: response.id,
      content: choice.message.content || "",
      toolCalls,
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      },
      raw: response,
    };
  }

  private mapStopReason(
    reason: string
  ): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
    switch (reason) {
      case "tool_calls":
        return "tool_use";
      case "length":
        return "max_tokens";
      case "stop":
        return "end_turn";
      default:
        return "end_turn";
    }
  }
}

// Singleton instance
export const kimiProvider = new KimiProvider();
