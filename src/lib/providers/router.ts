/**
 * Provider router - selects the appropriate LLM provider based on agent config
 *
 * Features:
 * - Automatic retry with exponential backoff for transient errors
 * - Circuit breaker to prevent cascading failures
 * - Provider auto-detection from model name
 */

import {
  LLMProvider,
  ProviderId,
  ProviderRequest,
  ProviderResponse,
  PROVIDER_CAPABILITIES,
} from "./types";
import { anthropicProvider } from "./anthropic";
import { kimiProvider } from "./kimi";
import { withRetryAndCircuitBreaker, getCircuitBreaker } from "../retry";

// Registry of all available providers
const providers = new Map<ProviderId, LLMProvider>([
  ["anthropic", anthropicProvider as LLMProvider],
  ["kimi", kimiProvider as LLMProvider],
]);

/**
 * Get a provider by ID
 */
export function getProvider(providerId: ProviderId): LLMProvider {
  const provider = providers.get(providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  return provider;
}

/**
 * Get all configured providers
 */
export function getConfiguredProviders(): LLMProvider[] {
  return Array.from(providers.values()).filter((p) => p.isConfigured());
}

/**
 * Get provider capabilities
 */
export function getProviderCapabilities(providerId: ProviderId) {
  return PROVIDER_CAPABILITIES[providerId];
}

/**
 * Detect provider from model name
 */
export function detectProviderFromModel(model: string): ProviderId {
  // Claude models
  if (model.startsWith("claude-") || model.includes("claude")) {
    return "anthropic";
  }
  // Kimi models
  if (model.startsWith("kimi-") || model.startsWith("moonshot-")) {
    return "kimi";
  }
  // OpenAI models
  if (model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-")) {
    return "openai";
  }
  // Default to Anthropic
  return "anthropic";
}

/**
 * Route a request to the appropriate provider with retry and circuit breaker
 */
export async function routeRequest(
  providerId: ProviderId | undefined,
  request: ProviderRequest,
  options?: { signal?: AbortSignal }
): Promise<ProviderResponse> {
  // Auto-detect provider from model if not specified
  const actualProviderId = providerId || detectProviderFromModel(request.model);
  const provider = getProvider(actualProviderId);

  if (!provider.isConfigured()) {
    throw new Error(
      `Provider ${actualProviderId} is not configured. Please set the appropriate API key.`
    );
  }

  // Execute with retry and circuit breaker protection
  return withRetryAndCircuitBreaker(
    actualProviderId,
    () => provider.chat(request),
    {
      maxAttempts: 3,
      initialDelayMs: 1000,
      maxDelayMs: 15000,
      signal: options?.signal,
    }
  );
}

/**
 * Check if a provider's circuit breaker is open
 */
export function isProviderAvailable(providerId: ProviderId): boolean {
  const breaker = getCircuitBreaker(providerId);
  return breaker.getState() !== 'open';
}

/**
 * Get provider health status
 */
export function getProviderHealth(providerId: ProviderId): {
  state: string;
  failureCount: number;
} {
  const breaker = getCircuitBreaker(providerId);
  return {
    state: breaker.getState(),
    failureCount: breaker.getFailureCount(),
  };
}

/**
 * Get all available models across all configured providers
 */
export function getAllAvailableModels(): Array<{
  model: string;
  provider: ProviderId;
  providerName: string;
}> {
  const models: Array<{
    model: string;
    provider: ProviderId;
    providerName: string;
  }> = [];

  for (const [providerId, provider] of providers) {
    if (provider.isConfigured()) {
      for (const model of provider.getModels()) {
        models.push({
          model,
          provider: providerId,
          providerName: provider.name,
        });
      }
    }
  }

  return models;
}

/**
 * Filter tools based on provider capabilities
 * Some tools may not work with certain providers
 */
export function filterToolsForProvider(
  providerId: ProviderId,
  tools: Array<{ name: string; [key: string]: unknown }>
): Array<{ name: string; [key: string]: unknown }> {
  const capabilities = PROVIDER_CAPABILITIES[providerId];

  // If provider doesn't support MCP, filter out MCP-specific tools
  if (!capabilities.supportsMCP) {
    const mcpOnlyTools = [
      "mcp__",  // Any MCP-prefixed tool
      "browser_action",
      "computer_use",
    ];

    return tools.filter((tool) => {
      return !mcpOnlyTools.some(
        (prefix) => tool.name.startsWith(prefix) || tool.name === prefix
      );
    });
  }

  return tools;
}

export { providers };
