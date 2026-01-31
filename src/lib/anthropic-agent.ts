import { anthropic, IS_OAUTH } from "./anthropic";

export interface ImageInput {
  type: "base64";
  media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
}

interface RunAgentOptions {
  prompt: string;
  systemPrompt: string;
  model: string;
  images?: ImageInput[];
  onDelta?: (text: string) => void;
}

interface RunAgentResult {
  text: string;
}

/**
 * Run an agent using the Anthropic SDK directly.
 * Replaces the CLI-based approach to avoid shell escaping and OAuth issues.
 */
export async function runAgent({
  prompt,
  systemPrompt,
  model,
  images,
  onDelta,
}: RunAgentOptions): Promise<RunAgentResult> {
  // Build content blocks: images first, then text
  const content: Array<
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
    | { type: "text"; text: string }
  > = [];

  if (images && images.length > 0) {
    for (const img of images) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.media_type, data: img.data },
      });
    }
  }
  content.push({ type: "text", text: prompt });

  if (IS_OAUTH) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: [{ role: "user", content: content as any }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => ("text" in b ? (b as { text: string }).text : ""))
      .join("");

    onDelta?.(text);
    return { text };
  }

  // Standard API key — use streaming
  const stream = anthropic.messages.stream({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: [{ role: "user", content: content as any }],
  });

  const parts: string[] = [];

  stream.on("text", (text) => {
    parts.push(text);
    onDelta?.(text);
  });

  await stream.finalMessage();
  return { text: parts.join("") };
}
