/**
 * Progress Tracking Service for Multi-Day Projects
 *
 * Tracks project phases, file changes, decisions, and checkpoints
 * to ensure the mafia never loses track of where they are on long jobs.
 */

import { prisma } from "./db";

// ==================== TYPES ====================

export interface PhaseSpec {
  name: string;
  description: string;
  orderIndex?: number;
}

export interface FileChangeSpec {
  filePath: string;
  changeType: "created" | "modified" | "deleted";
  description: string;
  agentName?: string;
  phaseId?: string;
}

export interface DecisionSpec {
  topic: string;
  question: string;
  decision: string;
  rationale?: string;
  madeBy: string;
  phaseId?: string;
}

export interface CheckpointSpec {
  name: string;
  description: string;
  pendingTasks: string[];
}

export interface ProgressSummary {
  projectName: string;
  objective: string;
  currentPhase: string;
  overallStatus: string;
  progress: string; // e.g., "3/7 phases complete"
  lastActive: Date;
  phases: Array<{
    name: string;
    status: string;
    result?: string;
  }>;
  recentFileChanges: Array<{
    filePath: string;
    changeType: string;
    description: string;
  }>;
  keyDecisions: Array<{
    topic: string;
    decision: string;
  }>;
  pendingWork: string[];
}

// ==================== PROGRESS TRACKER CLASS ====================

export class ProgressTracker {
  private conversationId: string;
  private progressId: string | null = null;

  constructor(conversationId: string) {
    this.conversationId = conversationId;
  }

  /**
   * Initialize progress tracking for a new project
   */
  async initializeProject(
    projectName: string,
    objective: string,
    phases: PhaseSpec[]
  ): Promise<string> {
    // Check if progress already exists
    const existing = await prisma.projectProgress.findUnique({
      where: { conversationId: this.conversationId },
    });

    if (existing) {
      this.progressId = existing.id;
      return existing.id;
    }

    // Create new progress record
    const progress = await prisma.projectProgress.create({
      data: {
        conversationId: this.conversationId,
        projectName,
        objective,
        totalPhases: phases.length,
        completedPhases: 0,
      },
    });

    this.progressId = progress.id;

    // Create phases
    for (let i = 0; i < phases.length; i++) {
      await prisma.progressPhase.create({
        data: {
          progressId: progress.id,
          name: phases[i].name,
          description: phases[i].description,
          orderIndex: phases[i].orderIndex ?? i,
        },
      });
    }

    return progress.id;
  }

  /**
   * Get the progress ID, loading from DB if needed
   */
  private async getProgressId(): Promise<string | null> {
    if (this.progressId) return this.progressId;

    const progress = await prisma.projectProgress.findUnique({
      where: { conversationId: this.conversationId },
    });

    if (progress) {
      this.progressId = progress.id;
      return progress.id;
    }

    return null;
  }

  /**
   * Update overall project status
   */
  async updateStatus(
    status: "in_progress" | "blocked" | "paused" | "complete",
    currentPhase?: string
  ): Promise<void> {
    const progressId = await this.getProgressId();
    if (!progressId) return;

    const updates: Record<string, unknown> = {
      overallStatus: status,
      lastActiveAt: new Date(),
    };

    if (currentPhase) updates.currentPhase = currentPhase;
    if (status === "complete") updates.completedAt = new Date();

    await prisma.projectProgress.update({
      where: { id: progressId },
      data: updates,
    });
  }

  /**
   * Start a phase
   */
  async startPhase(phaseName: string, assignedTo?: string): Promise<void> {
    const progressId = await this.getProgressId();
    if (!progressId) return;

    const phase = await prisma.progressPhase.findFirst({
      where: { progressId, name: phaseName },
    });

    if (phase) {
      await prisma.progressPhase.update({
        where: { id: phase.id },
        data: {
          status: "in_progress",
          assignedTo,
          startedAt: new Date(),
        },
      });
    }

    await prisma.projectProgress.update({
      where: { id: progressId },
      data: { currentPhase: phaseName, lastActiveAt: new Date() },
    });
  }

  /**
   * Complete a phase
   */
  async completePhase(phaseName: string, result: string): Promise<void> {
    const progressId = await this.getProgressId();
    if (!progressId) return;

    const phase = await prisma.progressPhase.findFirst({
      where: { progressId, name: phaseName },
    });

    if (phase) {
      await prisma.progressPhase.update({
        where: { id: phase.id },
        data: {
          status: "completed",
          result,
          completedAt: new Date(),
        },
      });
    }

    // Update completed count
    const completedCount = await prisma.progressPhase.count({
      where: { progressId, status: "completed" },
    });

    await prisma.projectProgress.update({
      where: { id: progressId },
      data: { completedPhases: completedCount, lastActiveAt: new Date() },
    });
  }

  /**
   * Block a phase
   */
  async blockPhase(phaseName: string, blockedBy: string): Promise<void> {
    const progressId = await this.getProgressId();
    if (!progressId) return;

    const phase = await prisma.progressPhase.findFirst({
      where: { progressId, name: phaseName },
    });

    if (phase) {
      await prisma.progressPhase.update({
        where: { id: phase.id },
        data: { status: "blocked", blockedBy },
      });
    }
  }

  /**
   * Add a new phase dynamically
   */
  async addPhase(spec: PhaseSpec): Promise<string | null> {
    const progressId = await this.getProgressId();
    if (!progressId) return null;

    // Get max orderIndex
    const maxPhase = await prisma.progressPhase.findFirst({
      where: { progressId },
      orderBy: { orderIndex: "desc" },
    });
    const nextIndex = (maxPhase?.orderIndex ?? 0) + 1;

    const phase = await prisma.progressPhase.create({
      data: {
        progressId,
        name: spec.name,
        description: spec.description,
        orderIndex: spec.orderIndex ?? nextIndex,
      },
    });

    // Update total count
    const totalCount = await prisma.progressPhase.count({
      where: { progressId },
    });

    await prisma.projectProgress.update({
      where: { id: progressId },
      data: { totalPhases: totalCount },
    });

    return phase.id;
  }

  /**
   * Record a file change
   */
  async recordFileChange(change: FileChangeSpec): Promise<void> {
    const progressId = await this.getProgressId();
    if (!progressId) return;

    await prisma.fileChange.create({
      data: {
        progressId,
        filePath: change.filePath,
        changeType: change.changeType,
        description: change.description,
        agentName: change.agentName,
        phaseId: change.phaseId,
      },
    });
  }

  /**
   * Record a decision
   */
  async recordDecision(decision: DecisionSpec): Promise<void> {
    const progressId = await this.getProgressId();
    if (!progressId) return;

    await prisma.decision.create({
      data: {
        progressId,
        topic: decision.topic,
        question: decision.question,
        decision: decision.decision,
        rationale: decision.rationale,
        madeBy: decision.madeBy,
        phaseId: decision.phaseId,
      },
    });
  }

  /**
   * Create a checkpoint (save point)
   */
  async createCheckpoint(spec: CheckpointSpec): Promise<string | null> {
    const progressId = await this.getProgressId();
    if (!progressId) return null;

    // Get current phase states
    const phases = await prisma.progressPhase.findMany({
      where: { progressId },
      orderBy: { orderIndex: "asc" },
    });

    const phaseSnapshot = phases.map((p) => ({
      name: p.name,
      status: p.status,
      result: p.result,
    }));

    // Build context summary
    const summary = await this.buildContextSummary();

    const checkpoint = await prisma.checkpoint.create({
      data: {
        progressId,
        name: spec.name,
        description: spec.description,
        phaseSnapshot: JSON.stringify(phaseSnapshot),
        pendingTasks: JSON.stringify(spec.pendingTasks),
        contextSummary: summary,
      },
    });

    return checkpoint.id;
  }

  /**
   * Get the latest checkpoint for resuming
   */
  async getLatestCheckpoint(): Promise<{
    name: string;
    description: string;
    contextSummary: string;
    pendingTasks: string[];
    createdAt: Date;
  } | null> {
    const progressId = await this.getProgressId();
    if (!progressId) return null;

    const checkpoint = await prisma.checkpoint.findFirst({
      where: { progressId },
      orderBy: { createdAt: "desc" },
    });

    if (!checkpoint) return null;

    return {
      name: checkpoint.name,
      description: checkpoint.description,
      contextSummary: checkpoint.contextSummary,
      pendingTasks: JSON.parse(checkpoint.pendingTasks) as string[],
      createdAt: checkpoint.createdAt,
    };
  }

  /**
   * Build a comprehensive context summary for resuming work
   */
  async buildContextSummary(): Promise<string> {
    const progressId = await this.getProgressId();
    if (!progressId) return "No progress tracking initialized.";

    const progress = await prisma.projectProgress.findUnique({
      where: { id: progressId },
      include: {
        phases: { orderBy: { orderIndex: "asc" } },
        fileChanges: { orderBy: { createdAt: "desc" }, take: 20 },
        decisions: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    });

    if (!progress) return "No progress found.";

    const lines: string[] = [];

    // Header
    lines.push(`# PROJECT: ${progress.projectName}`);
    lines.push(`**Objective:** ${progress.objective}`);
    lines.push(`**Status:** ${progress.overallStatus} (Phase: ${progress.currentPhase})`);
    lines.push(`**Progress:** ${progress.completedPhases}/${progress.totalPhases} phases complete`);
    lines.push(`**Last Active:** ${progress.lastActiveAt.toISOString()}`);
    lines.push("");

    // Phases
    lines.push("## PHASES");
    for (const phase of progress.phases) {
      const status = phase.status === "completed" ? "✅" : phase.status === "in_progress" ? "🔄" : phase.status === "blocked" ? "🚫" : "⏳";
      lines.push(`${status} **${phase.name}**: ${phase.status}`);
      if (phase.result) {
        lines.push(`   Result: ${phase.result.slice(0, 200)}${phase.result.length > 200 ? "..." : ""}`);
      }
      if (phase.blockedBy) {
        lines.push(`   Blocked by: ${phase.blockedBy}`);
      }
    }
    lines.push("");

    // Key Decisions
    if (progress.decisions.length > 0) {
      lines.push("## KEY DECISIONS MADE");
      for (const decision of progress.decisions) {
        lines.push(`- **${decision.topic}**: ${decision.decision}`);
        if (decision.rationale) {
          lines.push(`  Rationale: ${decision.rationale}`);
        }
      }
      lines.push("");
    }

    // Recent File Changes
    if (progress.fileChanges.length > 0) {
      lines.push("## RECENT FILE CHANGES");
      for (const change of progress.fileChanges.slice(0, 10)) {
        lines.push(`- [${change.changeType}] ${change.filePath}: ${change.description}`);
      }
      lines.push("");
    }

    // Pending work
    const pendingPhases = progress.phases.filter((p) => p.status === "pending" || p.status === "in_progress");
    if (pendingPhases.length > 0) {
      lines.push("## PENDING WORK");
      for (const phase of pendingPhases) {
        lines.push(`- ${phase.name}: ${phase.description}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Get a summary of current progress
   */
  async getSummary(): Promise<ProgressSummary | null> {
    const progressId = await this.getProgressId();
    if (!progressId) return null;

    const progress = await prisma.projectProgress.findUnique({
      where: { id: progressId },
      include: {
        phases: { orderBy: { orderIndex: "asc" } },
        fileChanges: { orderBy: { createdAt: "desc" }, take: 10 },
        decisions: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    });

    if (!progress) return null;

    const pendingPhases = progress.phases
      .filter((p) => p.status === "pending" || p.status === "in_progress" || p.status === "blocked")
      .map((p) => `${p.name} (${p.status})${p.blockedBy ? ` - blocked by: ${p.blockedBy}` : ""}`);

    return {
      projectName: progress.projectName,
      objective: progress.objective,
      currentPhase: progress.currentPhase,
      overallStatus: progress.overallStatus,
      progress: `${progress.completedPhases}/${progress.totalPhases} phases complete`,
      lastActive: progress.lastActiveAt,
      phases: progress.phases.map((p) => ({
        name: p.name,
        status: p.status,
        result: p.result || undefined,
      })),
      recentFileChanges: progress.fileChanges.map((f) => ({
        filePath: f.filePath,
        changeType: f.changeType,
        description: f.description,
      })),
      keyDecisions: progress.decisions.map((d) => ({
        topic: d.topic,
        decision: d.decision,
      })),
      pendingWork: pendingPhases,
    };
  }

  /**
   * Check if progress tracking is initialized for this conversation
   */
  async isInitialized(): Promise<boolean> {
    const progressId = await this.getProgressId();
    return progressId !== null;
  }
}

// ==================== HELPER FUNCTIONS ====================

/**
 * Get or create a progress tracker for a conversation
 */
export function getProgressTracker(conversationId: string): ProgressTracker {
  return new ProgressTracker(conversationId);
}

/**
 * Build resume context for a follow-up on a long-running project
 * This is called at the start of continueTask to give agents full context
 */
export async function buildResumeContext(conversationId: string): Promise<string | null> {
  const tracker = new ProgressTracker(conversationId);

  if (!(await tracker.isInitialized())) {
    return null; // No progress tracking, use standard context
  }

  const summary = await tracker.buildContextSummary();
  const checkpoint = await tracker.getLatestCheckpoint();

  let context = `\n\n=== PROJECT PROGRESS CONTEXT ===\n${summary}`;

  if (checkpoint) {
    context += `\n\n=== LAST CHECKPOINT: ${checkpoint.name} (${checkpoint.createdAt.toISOString()}) ===\n`;
    context += checkpoint.description;
    if (checkpoint.pendingTasks.length > 0) {
      context += `\n\nPending tasks from checkpoint:\n`;
      for (const task of checkpoint.pendingTasks) {
        context += `- ${task}\n`;
      }
    }
  }

  context += `\n=== END PROGRESS CONTEXT ===\n`;

  return context;
}
