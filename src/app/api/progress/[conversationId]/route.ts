import { NextRequest, NextResponse } from "next/server";
import { getProgressTracker, type PhaseSpec } from "@/lib/progress-tracker";

type Context = {
  params: Promise<{ conversationId: string }>;
};

/**
 * GET /api/progress/[conversationId]
 * Get progress summary for a conversation
 */
export async function GET(req: NextRequest, context: Context) {
  const params = await context.params;
  const { conversationId } = params;

  try {
    const tracker = getProgressTracker(conversationId);

    if (!(await tracker.isInitialized())) {
      return NextResponse.json(
        { error: "No progress tracking for this conversation" },
        { status: 404 }
      );
    }

    const summary = await tracker.getSummary();
    const contextSummary = await tracker.buildContextSummary();

    return NextResponse.json({
      summary,
      contextSummary,
    });
  } catch (error) {
    console.error("Error getting progress:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/progress/[conversationId]
 * Initialize progress tracking for a conversation
 *
 * Body: {
 *   projectName: string,
 *   objective: string,
 *   phases: Array<{ name: string, description: string }>
 * }
 */
export async function POST(req: NextRequest, context: Context) {
  const params = await context.params;
  const { conversationId } = params;

  try {
    const body = await req.json();
    const { projectName, objective, phases } = body as {
      projectName: string;
      objective: string;
      phases: PhaseSpec[];
    };

    if (!projectName || !objective || !phases || !Array.isArray(phases)) {
      return NextResponse.json(
        { error: "Missing required fields: projectName, objective, phases" },
        { status: 400 }
      );
    }

    const tracker = getProgressTracker(conversationId);
    const progressId = await tracker.initializeProject(projectName, objective, phases);

    return NextResponse.json({
      success: true,
      progressId,
      message: `Progress tracking initialized with ${phases.length} phases`,
    });
  } catch (error) {
    console.error("Error initializing progress:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/progress/[conversationId]
 * Update progress: complete phase, add decision, record file change, create checkpoint
 *
 * Body: {
 *   action: "completePhase" | "startPhase" | "blockPhase" | "addDecision" | "recordFileChange" | "createCheckpoint" | "updateStatus",
 *   ...action-specific fields
 * }
 */
export async function PATCH(req: NextRequest, context: Context) {
  const params = await context.params;
  const { conversationId } = params;

  try {
    const body = await req.json();
    const { action, ...data } = body as { action: string; [key: string]: unknown };

    const tracker = getProgressTracker(conversationId);

    if (!(await tracker.isInitialized())) {
      return NextResponse.json(
        { error: "No progress tracking for this conversation. Initialize first." },
        { status: 404 }
      );
    }

    switch (action) {
      case "startPhase": {
        const { phaseName, assignedTo } = data as { phaseName: string; assignedTo?: string };
        await tracker.startPhase(phaseName, assignedTo);
        return NextResponse.json({ success: true, message: `Phase "${phaseName}" started` });
      }

      case "completePhase": {
        const { phaseName, result } = data as { phaseName: string; result: string };
        await tracker.completePhase(phaseName, result);
        return NextResponse.json({ success: true, message: `Phase "${phaseName}" completed` });
      }

      case "blockPhase": {
        const { phaseName, blockedBy } = data as { phaseName: string; blockedBy: string };
        await tracker.blockPhase(phaseName, blockedBy);
        return NextResponse.json({ success: true, message: `Phase "${phaseName}" blocked` });
      }

      case "addPhase": {
        const { name, description } = data as { name: string; description: string };
        const phaseId = await tracker.addPhase({ name, description });
        return NextResponse.json({ success: true, phaseId, message: `Phase "${name}" added` });
      }

      case "addDecision": {
        const { topic, question, decision, rationale, madeBy, phaseId } = data as {
          topic: string;
          question: string;
          decision: string;
          rationale?: string;
          madeBy: string;
          phaseId?: string;
        };
        await tracker.recordDecision({ topic, question, decision, rationale, madeBy, phaseId });
        return NextResponse.json({ success: true, message: `Decision on "${topic}" recorded` });
      }

      case "recordFileChange": {
        const { filePath, changeType, description, agentName, phaseId } = data as {
          filePath: string;
          changeType: "created" | "modified" | "deleted";
          description: string;
          agentName?: string;
          phaseId?: string;
        };
        await tracker.recordFileChange({ filePath, changeType, description, agentName, phaseId });
        return NextResponse.json({ success: true, message: `File change recorded: ${filePath}` });
      }

      case "createCheckpoint": {
        const { name, description, pendingTasks } = data as {
          name: string;
          description: string;
          pendingTasks: string[];
        };
        const checkpointId = await tracker.createCheckpoint({ name, description, pendingTasks });
        return NextResponse.json({
          success: true,
          checkpointId,
          message: `Checkpoint "${name}" created`,
        });
      }

      case "updateStatus": {
        const { status, currentPhase } = data as {
          status: "in_progress" | "blocked" | "paused" | "complete";
          currentPhase?: string;
        };
        await tracker.updateStatus(status, currentPhase);
        return NextResponse.json({ success: true, message: `Status updated to "${status}"` });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error("Error updating progress:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
