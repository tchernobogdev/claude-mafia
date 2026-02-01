/**
 * Provider abstraction layer types
 * Enables multi-LLM support (Claude, Kimi, etc.)
 */

export type ProviderId = "anthropic" | "kimi" | "openai";

export interface ProviderMessage {
  role: "user" | "assistant" | "system";
  content: string | ProviderContentBlock[];
}

export interface ProviderContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  // For images
  source?: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
  // For tool use
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // For tool result
  tool_use_id?: string;
  content?: string | ProviderContentBlock[];
  is_error?: boolean;
}

export interface ProviderTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ProviderRequest {
  model: string;
  messages: ProviderMessage[];
  tools?: ProviderTool[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
  stop_sequences?: string[];
}

export interface ProviderToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProviderResponse {
  id: string;
  content: string;
  toolCalls: ProviderToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  raw?: unknown; // Original provider response for debugging
}

export interface LLMProvider {
  id: ProviderId;
  name: string;

  /**
   * Check if the provider is configured (has API key, etc.)
   */
  isConfigured(): boolean;

  /**
   * Get available models for this provider
   */
  getModels(): string[];

  /**
   * Convert MCP tools to provider-specific format
   */
  convertTools(tools: ProviderTool[]): unknown;

  /**
   * Send a request to the LLM
   */
  chat(request: ProviderRequest): Promise<ProviderResponse>;

  /**
   * Stream a request to the LLM (optional)
   */
  chatStream?(request: ProviderRequest): AsyncIterable<ProviderResponse>;
}

/**
 * Provider capabilities - what each provider can/cannot do
 */
export interface ProviderCapabilities {
  supportsTools: boolean;
  supportsImages: boolean;
  supportsStreaming: boolean;
  supportsMCP: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
}

export const PROVIDER_CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  anthropic: {
    supportsTools: true,
    supportsImages: true,
    supportsStreaming: true,
    supportsMCP: true,
    maxContextTokens: 200000,
    maxOutputTokens: 8192,
  },
  kimi: {
    supportsTools: true,
    supportsImages: true,
    supportsStreaming: true,
    supportsMCP: false, // No native MCP - we convert tools
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
  },
  openai: {
    supportsTools: true,
    supportsImages: true,
    supportsStreaming: true,
    supportsMCP: false,
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
  },
};
