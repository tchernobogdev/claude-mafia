/**
 * Anthropic (Claude) provider implementation
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderTool,
  ProviderToolCall,
  ProviderContentBlock,
} from "./types";

// Reuse the shared client from anthropic.ts
import { anthropic as sharedAnthropicClient } from "../anthropic";

const CLAUDE_MODELS = [
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-5-20250929",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229",
];

export class AnthropicProvider implements LLMProvider {
  id = "anthropic" as const;
  name = "Anthropic (Claude)";

  isConfigured(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  getModels(): string[] {
    return CLAUDE_MODELS;
  }

  private getClient(): Anthropic {
    return sharedAnthropicClient;
  }

  convertTools(tools: ProviderTool[]): Anthropic.Tool[] {
    // Anthropic tools are already in the right format
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object" as const,
        properties: tool.parameters.properties,
        required: tool.parameters.required || [],
      },
    }));
  }

  async chat(request: ProviderRequest): Promise<ProviderResponse> {
    const client = this.getClient();

    // Convert messages to Anthropic format
    const messages: Anthropic.MessageParam[] = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: this.convertContent(m.content),
      }));

    // Build system message
    let system = request.system || "";
    const systemMessages = request.messages.filter((m) => m.role === "system");
    if (systemMessages.length > 0) {
      const systemContent = systemMessages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");
      system = system ? `${system}\n${systemContent}` : systemContent;
    }

    const anthropicRequest: Anthropic.MessageCreateParams = {
      model: request.model,
      max_tokens: request.max_tokens || 8192,
      messages,
      system: system || undefined,
    };

    if (request.tools && request.tools.length > 0) {
      anthropicRequest.tools = this.convertTools(request.tools);
    }

    if (request.temperature !== undefined) {
      anthropicRequest.temperature = request.temperature;
    }

    if (request.stop_sequences && request.stop_sequences.length > 0) {
      anthropicRequest.stop_sequences = request.stop_sequences;
    }

    const response = await client.messages.create(anthropicRequest);

    return this.parseResponse(response);
  }

  private convertContent(
    content: string | ProviderContentBlock[]
  ): Anthropic.ContentBlockParam[] | string {
    if (typeof content === "string") {
      return content;
    }

    return content.map((block): Anthropic.ContentBlockParam => {
      if (block.type === "text") {
        return { type: "text", text: block.text || "" };
      }
      if (block.type === "image" && block.source) {
        if (block.source.type === "base64") {
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: (block.source.media_type || "image/png") as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: block.source.data || "",
            },
          };
        }
        // URL images - Anthropic doesn't support URL directly, would need to fetch
        return { type: "text", text: `[Image URL: ${block.source.url}]` };
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id || "",
          name: block.name || "",
          input: block.input || {},
        };
      }
      if (block.type === "tool_result") {
        return {
          type: "tool_result",
          tool_use_id: block.tool_use_id || "",
          content:
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content),
          is_error: block.is_error,
        };
      }
      return { type: "text", text: "" };
    });
  }

  private parseResponse(response: Anthropic.Message): ProviderResponse {
    const toolCalls: ProviderToolCall[] = [];
    let textContent = "";

    for (const block of response.content) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      id: response.id,
      content: textContent,
      toolCalls,
      stopReason: this.mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      raw: response,
    };
  }

  private mapStopReason(
    reason: string | null
  ): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
    switch (reason) {
      case "tool_use":
        return "tool_use";
      case "max_tokens":
        return "max_tokens";
      case "stop_sequence":
        return "stop_sequence";
      default:
        return "end_turn";
    }
  }
}

// Singleton instance
export const anthropicProvider = new AnthropicProvider();
