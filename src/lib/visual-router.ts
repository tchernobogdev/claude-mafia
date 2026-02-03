/**
 * Visual Task Router
 *
 * Detects visual/frontend tasks and routes them through Kimi for analysis
 * before handing off to Claude for implementation.
 */

import { prisma } from "./db";
import { routeRequest, getProvider, type ProviderId } from "./providers";
import type { ProviderMessage, ProviderContentBlock } from "./providers/types";
import type { ImageInput } from "./anthropic-agent";

// Keywords that indicate a visual/frontend task
const VISUAL_KEYWORDS = [
  /\bscreenshot\b/i,
  /\bstyling\b/i,
  /\bcss\b/i,
  /\bui\b/i,
  /\bux\b/i,
  /\bdesign\b/i,
  /\blayout\b/i,
  /\bvisual\b/i,
  /\bfrontend\b/i,
  /\blooks?\s+(like|wrong|broken|off|weird)/i,
  /\bappearance\b/i,
  /\bcolor\b/i,
  /\bfont\b/i,
  /\bspacing\b/i,
  /\bmargin\b/i,
  /\bpadding\b/i,
  /\bborder\b/i,
  /\bresponsive\b/i,
  /\bmobile\b/i,
  /\banimation\b/i,
  /\btransition\b/i,
  /\btheme\b/i,
  /\bdark\s*mode\b/i,
  /\blight\s*mode\b/i,
  /\bicon\b/i,
  /\bimage\b/i,
  /\bpixel\b/i,
  /\balign(ment)?\b/i,
  /\bbutton\b.*\b(style|look|color)/i,
  /\bcomponent\b.*\b(look|style)/i,
];

// Image path patterns in text (e.g., temp file paths mentioned in prompts)
const IMAGE_PATH_PATTERNS = [
  /\.(png|jpg|jpeg|gif|webp|svg)\b/i,
  /image-\d+/i,
  /screenshot/i,
  /agentmafia-.*\.(png|jpg|jpeg|gif|webp)/i,
];

export interface VisualTaskDetection {
  isVisual: boolean;
  hasImages: boolean;
  matchedKeywords: string[];
  confidence: "high" | "medium" | "low";
  reason: string;
}

/**
 * Detect if a task is a visual/frontend task that should be routed to Kimi
 */
export function detectVisualTask(
  task: string,
  hasImages: boolean = false
): VisualTaskDetection {
  const matchedKeywords: string[] = [];

  // Check for visual keywords
  for (const pattern of VISUAL_KEYWORDS) {
    const match = task.match(pattern);
    if (match) {
      matchedKeywords.push(match[0]);
    }
  }

  // Check for image paths in text
  let hasImagePaths = false;
  for (const pattern of IMAGE_PATH_PATTERNS) {
    if (pattern.test(task)) {
      hasImagePaths = true;
      break;
    }
  }

  // Determine if visual and confidence level
  const keywordCount = matchedKeywords.length;
  const hasAnyImages = hasImages || hasImagePaths;

  if (hasAnyImages && keywordCount >= 2) {
    return {
      isVisual: true,
      hasImages: hasAnyImages,
      matchedKeywords,
      confidence: "high",
      reason: `Task has images and multiple visual keywords: ${matchedKeywords.slice(0, 3).join(", ")}`,
    };
  }

  if (hasAnyImages && keywordCount >= 1) {
    return {
      isVisual: true,
      hasImages: hasAnyImages,
      matchedKeywords,
      confidence: "high",
      reason: `Task has images and visual keyword: ${matchedKeywords[0]}`,
    };
  }

  if (hasAnyImages) {
    return {
      isVisual: true,
      hasImages: hasAnyImages,
      matchedKeywords,
      confidence: "medium",
      reason: "Task has images attached (likely visual task)",
    };
  }

  if (keywordCount >= 2) {
    return {
      isVisual: true,
      hasImages: false,
      matchedKeywords,
      confidence: "medium",
      reason: `Multiple visual keywords: ${matchedKeywords.slice(0, 3).join(", ")}`,
    };
  }

  // Single strong visual indicator - still route to Kimi if available
  const strongIndicators = [/\bcss\b/i, /\bstyling\b/i, /\blayout\b/i, /\bfrontend\b/i, /\bresponsive\b/i, /\bpadding\b/i, /\bmargin\b/i, /\bspacing\b/i];
  const hasStrongIndicator = matchedKeywords.some((kw) =>
    strongIndicators.some((pattern) => pattern.test(kw))
  );

  if (keywordCount >= 1 && hasStrongIndicator) {
    return {
      isVisual: true,
      hasImages: false,
      matchedKeywords,
      confidence: "low",
      reason: `Contains strong visual indicator: ${matchedKeywords[0]}`,
    };
  }

  if (keywordCount >= 1) {
    return {
      isVisual: false,
      hasImages: false,
      matchedKeywords,
      confidence: "low",
      reason: `Contains visual keyword but not enough evidence: ${matchedKeywords[0]}`,
    };
  }

  return {
    isVisual: false,
    hasImages: false,
    matchedKeywords: [],
    confidence: "low",
    reason: "No visual indicators found",
  };
}

/**
 * Find a Kimi agent in the organization that can handle visual analysis
 */
export async function findKimiAgent(): Promise<{
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
} | null> {
  // Look for an agent with providerId = "kimi"
  const kimiAgent = await prisma.agent.findFirst({
    where: {
      providerId: "kimi",
      isDynamic: false,
    },
    select: {
      id: true,
      name: true,
      model: true,
      systemPrompt: true,
    },
  });

  return kimiAgent;
}

/**
 * Perform visual analysis using Kimi
 * Returns analysis that can be passed to Claude for implementation
 */
export async function analyzeWithKimi(
  task: string,
  images: ImageInput[],
  kimiAgent: { model: string; systemPrompt: string }
): Promise<{
  success: boolean;
  analysis: string;
  error?: string;
}> {
  const provider = getProvider("kimi");

  if (!provider.isConfigured()) {
    return {
      success: false,
      analysis: "",
      error: "Kimi API is not configured. Set KIMI_API_KEY or MOONSHOT_API_KEY in .env",
    };
  }

  // Build system prompt for visual analysis
  const systemPrompt = `${kimiAgent.systemPrompt || "You are a visual analysis expert."}

YOUR ROLE: You are a visual analyst in a multi-agent system. Your job is to:
1. Carefully analyze any images/screenshots provided
2. Identify specific visual issues, styling problems, or UI/UX concerns
3. Provide DETAILED, ACTIONABLE findings that another agent can implement

OUTPUT FORMAT: Your analysis should be structured and specific:
- List exact CSS properties that need changing (colors, spacing, fonts, etc.)
- Note specific pixel values or measurements when visible
- Describe the current state vs. the expected state
- Be precise about element locations and identifiers if visible

DO NOT attempt to write code or make changes yourself - just analyze and report findings.`;

  // Build message with images
  const content: ProviderContentBlock[] = [
    { type: "text", text: task },
  ];

  // Add images
  for (const img of images) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.media_type,
        data: img.data,
      },
    });
  }

  const messages: ProviderMessage[] = [
    { role: "user", content },
  ];

  try {
    console.log(`[VisualRouter] Sending ${images.length} image(s) to Kimi for analysis...`);

    const response = await provider.chat({
      model: kimiAgent.model || "kimi-k2.5",
      messages,
      system: systemPrompt,
      max_tokens: 4096,
    });

    console.log(`[VisualRouter] Kimi analysis complete (${response.usage.outputTokens} tokens)`);

    return {
      success: true,
      analysis: response.content,
    };
  } catch (err) {
    console.error("[VisualRouter] Kimi analysis failed:", err);
    return {
      success: false,
      analysis: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Create an enhanced task that includes Kimi's visual analysis
 * This is what gets passed to Claude for implementation
 */
export function createEnhancedTask(
  originalTask: string,
  kimiAnalysis: string,
  imagePaths: string[]
): string {
  return `## Original Task
${originalTask}

## Visual Analysis (from Kimi)
${kimiAnalysis}

## Reference Images
The following images were analyzed:
${imagePaths.map((p, i) => `${i + 1}. ${p}`).join("\n")}

## Your Job
Using the visual analysis above, implement the required changes. The analysis includes specific CSS properties, measurements, and issues to fix. Make the changes to the actual code files.`;
}

/**
 * Route a visual task through Kimi first, then to Claude
 * Returns the enhanced task with Kimi's analysis included
 */
export async function routeVisualTask(
  task: string,
  images: ImageInput[],
  imagePaths: string[]
): Promise<{
  shouldUseKimi: boolean;
  enhancedTask: string;
  kimiAnalysis?: string;
  detection: VisualTaskDetection;
}> {
  // Detect if this is a visual task
  const detection = detectVisualTask(task, images.length > 0);

  if (!detection.isVisual) {
    return {
      shouldUseKimi: false,
      enhancedTask: task,
      detection,
    };
  }

  // Find a Kimi agent
  const kimiAgent = await findKimiAgent();

  if (!kimiAgent) {
    console.log("[VisualRouter] No Kimi agent configured - proceeding without visual analysis");
    return {
      shouldUseKimi: false,
      enhancedTask: task,
      detection,
    };
  }

  // Check if Kimi is configured
  const provider = getProvider("kimi");
  if (!provider.isConfigured()) {
    console.log("[VisualRouter] Kimi API not configured - proceeding without visual analysis");
    return {
      shouldUseKimi: false,
      enhancedTask: task,
      detection,
    };
  }

  // Only do Kimi analysis if we have actual images
  if (images.length === 0) {
    console.log("[VisualRouter] Visual task detected but no images - skipping Kimi analysis");
    return {
      shouldUseKimi: false,
      enhancedTask: task,
      detection,
    };
  }

  // Perform visual analysis with Kimi
  console.log(`[VisualRouter] Visual task detected (${detection.confidence} confidence): ${detection.reason}`);

  const analysisResult = await analyzeWithKimi(task, images, kimiAgent);

  if (!analysisResult.success) {
    console.warn(`[VisualRouter] Kimi analysis failed: ${analysisResult.error}`);
    return {
      shouldUseKimi: false,
      enhancedTask: task,
      detection,
    };
  }

  // Create enhanced task with Kimi's analysis
  const enhancedTask = createEnhancedTask(task, analysisResult.analysis, imagePaths);

  console.log("[VisualRouter] Task enhanced with Kimi visual analysis");

  return {
    shouldUseKimi: true,
    enhancedTask,
    kimiAnalysis: analysisResult.analysis,
    detection,
  };
}
