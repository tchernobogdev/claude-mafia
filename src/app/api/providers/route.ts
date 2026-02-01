import { NextResponse } from "next/server";
import {
  getAllAvailableModels,
  getConfiguredProviders,
  PROVIDER_CAPABILITIES,
} from "@/lib/providers";

export async function GET() {
  try {
    // Get all configured providers
    const configuredProviders = getConfiguredProviders();

    // Get all available models
    const models = getAllAvailableModels();

    // Build provider info
    const providers = configuredProviders.map((p) => ({
      id: p.id,
      name: p.name,
      isConfigured: p.isConfigured(),
      models: p.getModels(),
      capabilities: PROVIDER_CAPABILITIES[p.id],
    }));

    // Also include unconfigured providers for info
    const allProviderIds = ["anthropic", "kimi", "openai"] as const;
    const unconfiguredProviders = allProviderIds
      .filter((id) => !configuredProviders.some((p) => p.id === id))
      .map((id) => ({
        id,
        name: id === "anthropic" ? "Anthropic (Claude)" : id === "kimi" ? "Kimi 2.5 (Moonshot)" : "OpenAI",
        isConfigured: false,
        models: [],
        capabilities: PROVIDER_CAPABILITIES[id],
        configHint:
          id === "anthropic"
            ? "Set ANTHROPIC_API_KEY in .env"
            : id === "kimi"
              ? "Set KIMI_API_KEY or MOONSHOT_API_KEY in .env"
              : "Set OPENAI_API_KEY in .env",
      }));

    return NextResponse.json({
      providers: [...providers, ...unconfiguredProviders],
      models,
    });
  } catch (error) {
    console.error("Failed to get providers:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get providers" },
      { status: 500 }
    );
  }
}
