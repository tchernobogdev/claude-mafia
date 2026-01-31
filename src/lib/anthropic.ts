import Anthropic from "@anthropic-ai/sdk";

const globalForAnthropic = globalThis as unknown as { anthropic: Anthropic };

const apiKey = process.env.ANTHROPIC_API_KEY || "";
export const IS_OAUTH = apiKey.startsWith("sk-ant-oat");

/**
 * Get the API key / OAuth token for passing to CLI processes.
 */
export function getAuthToken(): string {
  return apiKey;
}

// Keep Anthropic client available as optional fallback
function createOAuthClient(): Anthropic {
  const client = new Anthropic({ apiKey: "dummy" });

  // @ts-expect-error - overriding with compatible implementation
  client.messages.create = async (params: Record<string, unknown>) => {
    const systemText = typeof params.system === "string" ? params.system : "";
    const transformedParams = {
      ...params,
      system: [
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: "ephemeral" },
        },
        ...(systemText
          ? [
              {
                type: "text",
                text: systemText,
                cache_control: { type: "ephemeral" },
              },
            ]
          : []),
      ],
    };

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "user-agent": "claude-cli/2.1.2 (external, cli)",
        "x-app": "cli",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(transformedParams),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${errText}`);
    }

    return res.json();
  };

  return client;
}

export const anthropic =
  globalForAnthropic.anthropic ||
  (IS_OAUTH ? createOAuthClient() : new Anthropic({ apiKey }));

if (process.env.NODE_ENV !== "production")
  globalForAnthropic.anthropic = anthropic;

export const MODEL_OPTIONS = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { id: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5" },
  { id: "claude-opus-4-5-20251101", label: "Opus 4.5" },
] as const;

export type ModelId = (typeof MODEL_OPTIONS)[number]["id"];
