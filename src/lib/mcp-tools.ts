import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { prisma } from "./db";
import { escalationManager } from "./escalation";
import { agentPool } from "./agent-pool";
import { getProgressTracker } from "./progress-tracker";

interface McpToolContext {
  conversationId: string;
  agentId: string;
  depth: number;
  agentInvocations: Map<string, number>;
  workingDirectory?: string;
  signal?: AbortSignal;
  abortController?: AbortController;
  executeAgent: (opts: {
    agentId: string;
    task: string;
    conversationId: string;
    depth?: number;
    agentInvocations?: Map<string, number>;
    workingDirectory?: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  emitActivity: (
    conversationId: string,
    eventType: string,
    data: Record<string, unknown>
  ) => Promise<void>;
}

export async function buildAgentMcpServer(
  agentId: string,
  context: McpToolContext
): Promise<McpSdkServerConfigWithInstance | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      outgoingRels: { include: { toAgent: true } },
      incomingRels: { include: { fromAgent: true } },
    },
  });

  if (!agent) return null;

  const tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
  }> = [];

  const delegateRels = agent.outgoingRels.filter((r) => r.action === "delegate");
  const outgoingCollabRels = agent.outgoingRels.filter((r) => r.action === "collaborate");
  const incomingCollabRels = agent.incomingRels.filter((r) => r.action === "collaborate");

  // Helper to build target description
  function describeAgent(a: { id: string; name: string; role: string; specialty: string | null; systemPrompt: string }): string {
    let desc = `- "${a.name}" (ID: ${a.id}) — ${a.role}`;
    if (a.specialty) desc += `, specialty: ${a.specialty}`;
    if (a.systemPrompt) desc += ` | prompt: "${a.systemPrompt.slice(0, 120)}${a.systemPrompt.length > 120 ? "..." : ""}"`;
    return desc;
  }

  // === delegate_task (unchanged) ===
  if (delegateRels.length > 0) {
    const validIds = delegateRels.map((r) => r.toAgent.id);
    const targetDesc = delegateRels.map((r) => describeAgent(r.toAgent)).join("\n");
    tools.push({
      name: "delegate_task",
      description: `Delegate a task to one or more subordinate agents in parallel. Choose agents based on their specialty.

IMPORTANT: When you receive a result from delegation:
- If the result is a COMPLETED report → process it and continue
- If the result is an ACKNOWLEDGMENT (e.g., "I'm on it, starting work...") → the subordinate is still working. You MUST call wait_for_messages to wait for their final report. DO NOT just say "I'll wait" - that will end your turn prematurely.

Available targets:
${targetDesc}`,
      inputSchema: {
        targets: z.array(z.string()).describe("Array of agent IDs to delegate to"),
        task: z.string().describe("The task description to delegate"),
      },
      handler: async (args: Record<string, unknown>) => {
        const targets = args.targets as string[];
        const task = args.task as string;

        const filteredTargets = targets.filter((t) => validIds.includes(t));
        if (filteredTargets.length === 0) {
          return { content: [{ type: "text" as const, text: `[Error: No valid target IDs. Valid IDs: ${validIds.join(", ")}]` }] };
        }

        const targetAgents = await prisma.agent.findMany({
          where: { id: { in: filteredTargets } },
          select: { id: true, name: true, role: true },
        });
        await context.emitActivity(context.conversationId, "tool_call", {
          agentId: agent.id,
          agentName: agent.name,
          tool: "delegate_task",
          input: { targets: filteredTargets, task },
          targetAgents,
        });

        const results = await Promise.all(
          filteredTargets.map((tid) =>
            context.executeAgent({
              agentId: tid,
              task,
              conversationId: context.conversationId,
              depth: context.depth + 1,
              agentInvocations: context.agentInvocations,
              workingDirectory: context.workingDirectory,
              signal: context.signal,
            })
          )
        );

        const combined = results
          .map((r, i) => {
            const name = targetAgents.find((a) => a.id === filteredTargets[i])?.name || filteredTargets[i];
            return `[Result from ${name}]:\n${r}`;
          })
          .join("\n\n");

        await context.emitActivity(context.conversationId, "tool_result", {
          agentId: agent.id,
          agentName: agent.name,
          tool: "delegate_task",
          result: combined.slice(0, 1000),
        });

        return { content: [{ type: "text" as const, text: combined }] };
      },
    });
  }

  // === ask_agent — now allows ANY agent in the organization (not just direct relationships) ===
  // Fetch all agents to allow lateral communication between any agents
  const allAgents = await prisma.agent.findMany({
    select: { id: true, name: true, role: true, specialty: true, systemPrompt: true },
  });
  const askTargets = new Map<string, { id: string; name: string; role: string; specialty: string | null; systemPrompt: string }>();
  for (const a of allAgents) {
    if (a.id !== agentId) {
      askTargets.set(a.id, a);
    }
  }

  if (askTargets.size > 0) {
    const validIds = [...askTargets.keys()];
    const askTargetDesc = [...askTargets.values()].map(describeAgent).join("\n");
    tools.push({
      name: "ask_agent",
      description: `Ask a question to ANY agent in the organization. If the agent is already running in the pool, the question is routed to their mailbox (no new spawn). Otherwise, a new instance is spawned.\n\nAvailable targets:\n${askTargetDesc}`,
      inputSchema: {
        target: z.string().describe("Agent ID to ask"),
        question: z.string().describe("The question to ask"),
      },
      handler: async (args: Record<string, unknown>) => {
        const target = args.target as string;
        const question = args.question as string;

        if (!validIds.includes(target)) {
          return { content: [{ type: "text" as const, text: `[Error: Invalid target. Valid IDs: ${validIds.join(", ")}]` }] };
        }

        const targetAgent = await prisma.agent.findUnique({ where: { id: target }, select: { id: true, name: true, role: true } });
        await context.emitActivity(context.conversationId, "tool_call", {
          agentId: agent.id,
          agentName: agent.name,
          tool: "ask_agent",
          input: { target, question },
          targetAgents: targetAgent ? [targetAgent] : [],
        });

        // Check if target is already in the pool — route via mailbox
        const poolInstance = agentPool.get(context.conversationId, target);
        let result: string;
        if (poolInstance) {
          const msgId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          result = await poolInstance.mailbox.send(msgId, question);
        } else {
          // Fallback: spawn via executeAgent (which registers in pool)
          result = await context.executeAgent({
            agentId: target,
            task: question,
            conversationId: context.conversationId,
            depth: context.depth + 1,
            agentInvocations: context.agentInvocations,
            workingDirectory: context.workingDirectory,
            signal: context.signal,
          });
        }

        await context.emitActivity(context.conversationId, "tool_result", {
          agentId: agent.id,
          agentName: agent.name,
          tool: "ask_agent",
          result: result.slice(0, 1000),
        });

        return { content: [{ type: "text" as const, text: result }] };
      },
    });
  }

  // === Lifecycle tools — all agents get these ===

  // submit_result: resolve the delegator's promise with the primary result
  tools.push({
    name: "submit_result",
    description: "Submit your completed result to the agent who delegated this task to you. Call this when your work is done. After submitting, you will enter standby mode where you can answer follow-up questions.",
    inputSchema: {
      result: z.string().describe("Your completed result/report"),
    },
    handler: async (args: Record<string, unknown>) => {
      const result = args.result as string;
      const instance = agentPool.get(context.conversationId, agentId);
      if (instance) {
        instance.resultResolver(result);
      }
      return { content: [{ type: "text" as const, text: "Result submitted. You are now in standby mode. Call wait_for_messages to receive follow-up questions, or end your session." }] };
    },
  });

  // wait_for_messages: block until a question arrives, timeout, or shutdown
  const WAIT_TIMEOUT_MS = 30000; // 30 seconds timeout (reduced from 90s for better responsiveness)
  tools.push({
    name: "wait_for_messages",
    description: `Wait for incoming messages from subordinates or other agents. Blocks until a message arrives, timeout (30s), or the job ends.

CRITICAL: You MUST call this tool when:
1. You delegated work and are waiting for subordinates to report back
2. A subordinate said they're starting multi-phase work (e.g., "I'll do recon then implementation")
3. After submit_result to enter standby mode for follow-up questions

WARNING: If you just say "I'll wait for them to report back" WITHOUT calling this tool, your turn will END and the job will complete prematurely. You must ALWAYS call wait_for_messages to actually wait - don't just describe waiting in text.

NOTE: This tool has a 30-second timeout. If no message arrives, you'll receive a timeout notification. You can then decide to wait again or proceed with what you have.`,
    inputSchema: {},
    handler: async () => {
      const instance = agentPool.get(context.conversationId, agentId);
      if (!instance) {
        return { content: [{ type: "text" as const, text: "[No pool instance — session ending]" }] };
      }
      const msg = await instance.mailbox.receiveWithTimeout(WAIT_TIMEOUT_MS);
      if (msg === null) {
        // Timeout - no message received
        await context.emitActivity(context.conversationId, "wait_timeout", {
          agentId: agent.id,
          agentName: agent.name,
          timeoutMs: WAIT_TIMEOUT_MS,
        });
        return { content: [{ type: "text" as const, text: `[TIMEOUT: No messages received after ${WAIT_TIMEOUT_MS / 1000} seconds. You can call wait_for_messages again to keep waiting, or proceed with what you have. If you're expecting results from a delegated task that hasn't completed, consider that the subordinate may be stuck or the task may be taking longer than expected.]` }] };
      }
      if (msg.id === "__shutdown__") {
        return { content: [{ type: "text" as const, text: "[Job complete — shutting down]" }] };
      }
      // Stash the resolver so respond_to_message can resolve the asker's promise
      let pending = instance._pendingResponses;
      if (!pending) {
        pending = new Map();
        instance._pendingResponses = pending;
      }
      pending.set(msg.id, msg.resolve);
      return { content: [{ type: "text" as const, text: `[Incoming question (messageId: ${msg.id})]:\n${msg.content}\n\nUse respond_to_message with this messageId to reply.` }] };
    },
  });

  // respond_to_message: answer a question received via mailbox
  tools.push({
    name: "respond_to_message",
    description: `Respond to a message received via wait_for_messages.

CRITICAL: After calling this tool, you MUST immediately call wait_for_messages again to continue receiving messages. DO NOT just say "I'll wait for more" - that text-only response will END your turn. Always follow respond_to_message with wait_for_messages.`,
    inputSchema: {
      messageId: z.string().describe("The messageId from the incoming question"),
      response: z.string().describe("Your response to the question"),
    },
    handler: async (args: Record<string, unknown>) => {
      const messageId = args.messageId as string;
      const response = args.response as string;
      const instance = agentPool.get(context.conversationId, agentId);
      if (!instance) {
        return { content: [{ type: "text" as const, text: "[No pool instance]" }] };
      }
      // The mailbox.send() call from the asker holds a resolve function keyed by messageId.
      // We need to find and resolve it. The mailbox message object stores the resolver directly.
      // Since we already delivered the message in wait_for_messages, the resolver is on the message object.
      // We stash received messages on the instance for this purpose.
      const pending = instance._pendingResponses;
      if (pending?.has(messageId)) {
        pending.get(messageId)!(response);
        pending.delete(messageId);
      }
      return { content: [{ type: "text" as const, text: "Response sent. Call wait_for_messages to continue standby." }] };
    },
  });

  // Tester-specific tools for code execution and testing
  if (agent.role === "tester") {
    const { executeCode } = await import("./sandbox");
    const { runTests } = await import("./test-runner");
    const { parseErrors } = await import("./error-parser");

    tools.push({
      name: "execute_code",
      description: "Execute code in a sandboxed environment. Supports Python, TypeScript, and JavaScript. Returns stdout, stderr, exit code, and structured compilation errors if any.",
      inputSchema: {
        code: z.string().describe("The code to execute"),
        language: z.enum(["python", "typescript", "javascript"]).describe("The programming language"),
        timeout: z.number().optional().describe("Optional timeout in milliseconds (default: 30000)"),
      },
      handler: async (args: Record<string, unknown>) => {
        const code = args.code as string;
        const language = args.language as "python" | "typescript" | "javascript";
        const timeout = (args.timeout as number | undefined) || 30000;

        const result = await executeCode({ code, language, timeout });

        // Parse errors from stderr if execution failed
        const errors = result.exitCode !== 0 && result.stderr
          ? parseErrors(result.stderr)
          : [];

        const output = {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          errors: errors.length > 0 ? errors : undefined,
        };

        await context.emitActivity(context.conversationId, "tool_result", {
          agentId: agent.id,
          agentName: agent.name,
          tool: "execute_code",
          result: `Exit code: ${result.exitCode}, Errors: ${errors.length}`,
        });

        return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
      },
    });

    tools.push({
      name: "run_build",
      description: "Run a build command (e.g., 'npm run build', 'tsc --noEmit', 'npx eslint .') in the working directory. Returns structured compilation errors with file, line, column, and message.",
      inputSchema: {
        command: z.string().describe("The build command to execute (e.g., 'npm run build', 'tsc --noEmit')"),
        timeout: z.number().optional().describe("Optional timeout in milliseconds (default: 60000)"),
      },
      handler: async (args: Record<string, unknown>) => {
        const command = args.command as string;
        const timeout = (args.timeout as number | undefined) || 60000;

        const result = await executeCode({
          code: "",
          language: "build",
          buildCommand: command,
          timeout,
        });

        // Parse compilation errors from output
        const errors = parseErrors(result.stderr || result.stdout);

        const output = {
          command,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          compilationErrors: errors.length > 0 ? errors : undefined,
          errorCount: errors.length,
        };

        await context.emitActivity(context.conversationId, "tool_result", {
          agentId: agent.id,
          agentName: agent.name,
          tool: "run_build",
          result: `Exit code: ${result.exitCode}, Errors: ${errors.length}`,
        });

        return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
      },
    });

    tools.push({
      name: "run_tests",
      description: "Execute tests using a test framework (jest, vitest, pytest, mocha). Returns structured test results including passed/failed counts and individual test case details.",
      inputSchema: {
        framework: z.enum(["jest", "vitest", "pytest", "mocha"]).describe("The test framework to use"),
        testPath: z.string().optional().describe("Optional specific test file or pattern to run"),
        timeout: z.number().optional().describe("Optional timeout in milliseconds (default: 60000)"),
      },
      handler: async (args: Record<string, unknown>) => {
        const framework = args.framework as "jest" | "vitest" | "pytest" | "mocha";
        const testPath = args.testPath as string | undefined;
        const timeout = (args.timeout as number | undefined) || 60000;
        const workingDirectory = context.workingDirectory || process.cwd();

        const result = await runTests({
          framework,
          workingDirectory,
          testPath,
          timeout,
        });

        const output = {
          framework,
          testPath,
          passed: result.passed,
          failed: result.failed,
          skipped: result.skipped,
          total: result.total,
          exitCode: result.exitCode,
          errors: result.errors,
          testCases: result.testCases.slice(0, 50), // Limit to first 50 test cases
        };

        await context.emitActivity(context.conversationId, "tool_result", {
          agentId: agent.id,
          agentName: agent.name,
          tool: "run_tests",
          result: `${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`,
        });

        return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
      },
    });
  }

  // === Progress Tracking Tools (available to underbosses and capos) ===
  if (agent.role === "underboss" || agent.role === "capo") {
    const tracker = getProgressTracker(context.conversationId);

    tools.push({
      name: "update_progress",
      description: `Update project progress tracking. Use this to keep track of what's been done on long-running or multi-day projects. Actions available:
- "startPhase": Mark a phase as started (phaseName, optionally assignedTo)
- "completePhase": Mark a phase as completed (phaseName, result)
- "blockPhase": Mark a phase as blocked (phaseName, blockedBy)
- "addDecision": Record a key decision (topic, question, decision, rationale, madeBy)
- "recordFileChange": Record a file modification (filePath, changeType: created|modified|deleted, description)

This helps maintain continuity across multiple sessions and prevents losing track of progress.`,
      inputSchema: {
        action: z.enum(["startPhase", "completePhase", "blockPhase", "addDecision", "recordFileChange"]).describe("The type of progress update"),
        phaseName: z.string().optional().describe("Phase name (for phase actions)"),
        assignedTo: z.string().optional().describe("Agent assigned to this phase"),
        result: z.string().optional().describe("Result summary (for completePhase)"),
        blockedBy: z.string().optional().describe("What's blocking the phase"),
        topic: z.string().optional().describe("Decision topic"),
        question: z.string().optional().describe("Decision question"),
        decision: z.string().optional().describe("The decision made"),
        rationale: z.string().optional().describe("Why this decision was made"),
        madeBy: z.string().optional().describe("Who made the decision"),
        filePath: z.string().optional().describe("File path (for recordFileChange)"),
        changeType: z.enum(["created", "modified", "deleted"]).optional().describe("Type of file change"),
        description: z.string().optional().describe("Description of the change"),
      },
      handler: async (args: Record<string, unknown>) => {
        const action = args.action as string;

        // Check if progress tracking is initialized
        if (!(await tracker.isInitialized())) {
          return { content: [{ type: "text" as const, text: "[Progress tracking not initialized for this conversation. The boss needs to set up project tracking via the API first.]" }] };
        }

        try {
          switch (action) {
            case "startPhase": {
              const phaseName = args.phaseName as string;
              if (!phaseName) return { content: [{ type: "text" as const, text: "[Error: phaseName required for startPhase]" }] };
              await tracker.startPhase(phaseName, args.assignedTo as string | undefined);
              await context.emitActivity(context.conversationId, "progress_update", {
                agentId: agent.id,
                agentName: agent.name,
                action: "startPhase",
                phaseName,
              });
              return { content: [{ type: "text" as const, text: `Phase "${phaseName}" marked as started.` }] };
            }

            case "completePhase": {
              const phaseName = args.phaseName as string;
              const result = args.result as string;
              if (!phaseName || !result) return { content: [{ type: "text" as const, text: "[Error: phaseName and result required for completePhase]" }] };
              await tracker.completePhase(phaseName, result);
              await context.emitActivity(context.conversationId, "progress_update", {
                agentId: agent.id,
                agentName: agent.name,
                action: "completePhase",
                phaseName,
                result: result.slice(0, 200),
              });
              return { content: [{ type: "text" as const, text: `Phase "${phaseName}" marked as completed.` }] };
            }

            case "blockPhase": {
              const phaseName = args.phaseName as string;
              const blockedBy = args.blockedBy as string;
              if (!phaseName || !blockedBy) return { content: [{ type: "text" as const, text: "[Error: phaseName and blockedBy required for blockPhase]" }] };
              await tracker.blockPhase(phaseName, blockedBy);
              await context.emitActivity(context.conversationId, "progress_update", {
                agentId: agent.id,
                agentName: agent.name,
                action: "blockPhase",
                phaseName,
                blockedBy,
              });
              return { content: [{ type: "text" as const, text: `Phase "${phaseName}" marked as blocked by: ${blockedBy}` }] };
            }

            case "addDecision": {
              const { topic, question, decision, rationale, madeBy } = args as Record<string, string | undefined>;
              if (!topic || !question || !decision || !madeBy) {
                return { content: [{ type: "text" as const, text: "[Error: topic, question, decision, and madeBy required for addDecision]" }] };
              }
              await tracker.recordDecision({ topic, question, decision, rationale, madeBy });
              await context.emitActivity(context.conversationId, "progress_update", {
                agentId: agent.id,
                agentName: agent.name,
                action: "addDecision",
                topic,
                decision,
              });
              return { content: [{ type: "text" as const, text: `Decision recorded: "${topic}" → ${decision}` }] };
            }

            case "recordFileChange": {
              const { filePath, changeType, description: desc } = args as Record<string, string | undefined>;
              if (!filePath || !changeType || !desc) {
                return { content: [{ type: "text" as const, text: "[Error: filePath, changeType, and description required for recordFileChange]" }] };
              }
              await tracker.recordFileChange({
                filePath,
                changeType: changeType as "created" | "modified" | "deleted",
                description: desc,
                agentName: agent.name,
              });
              await context.emitActivity(context.conversationId, "progress_update", {
                agentId: agent.id,
                agentName: agent.name,
                action: "recordFileChange",
                filePath,
                changeType,
              });
              return { content: [{ type: "text" as const, text: `File change recorded: [${changeType}] ${filePath}` }] };
            }

            default:
              return { content: [{ type: "text" as const, text: `[Unknown action: ${action}]` }] };
          }
        } catch (err) {
          return { content: [{ type: "text" as const, text: `[Error updating progress: ${err instanceof Error ? err.message : String(err)}]` }] };
        }
      },
    });

    tools.push({
      name: "create_checkpoint",
      description: `Create a checkpoint (save point) for the current project state. Use this:
- At the end of a work session
- Before starting risky changes
- When pausing work for the day
- Before major refactors

The checkpoint saves: current phase states, pending tasks, and a comprehensive context summary. This allows work to be resumed accurately even after days or weeks.`,
      inputSchema: {
        name: z.string().describe("Checkpoint name (e.g., 'End of Day 1', 'Before Auth Refactor')"),
        description: z.string().describe("What state the project is in"),
        pendingTasks: z.array(z.string()).describe("List of tasks still pending"),
      },
      handler: async (args: Record<string, unknown>) => {
        const { name, description: desc, pendingTasks } = args as {
          name: string;
          description: string;
          pendingTasks: string[];
        };

        if (!(await tracker.isInitialized())) {
          return { content: [{ type: "text" as const, text: "[Progress tracking not initialized. Cannot create checkpoint.]" }] };
        }

        try {
          const checkpointId = await tracker.createCheckpoint({
            name,
            description: desc,
            pendingTasks,
          });

          await context.emitActivity(context.conversationId, "checkpoint_created", {
            agentId: agent.id,
            agentName: agent.name,
            checkpointId,
            checkpointName: name,
          });

          return { content: [{ type: "text" as const, text: `Checkpoint "${name}" created successfully. The project state has been saved and can be resumed later.` }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `[Error creating checkpoint: ${err instanceof Error ? err.message : String(err)}]` }] };
        }
      },
    });

    tools.push({
      name: "get_progress_summary",
      description: "Get the current progress summary for this project. Shows completed phases, pending work, key decisions made, and recent file changes. Use this to understand where the project stands.",
      inputSchema: {},
      handler: async () => {
        if (!(await tracker.isInitialized())) {
          return { content: [{ type: "text" as const, text: "[No progress tracking initialized for this conversation.]" }] };
        }

        try {
          const contextSummary = await tracker.buildContextSummary();
          return { content: [{ type: "text" as const, text: contextSummary }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `[Error getting progress: ${err instanceof Error ? err.message : String(err)}]` }] };
        }
      },
    });
  }

  // Escalation is available to underbosses
  if (agent.role === "underboss" || agent.role === "tester") {
    tools.push({
      name: "escalate_to_boss",
      description: "Ask the human user for guidance when you need a decision. Use sparingly.",
      inputSchema: {
        question: z.string().describe("The question to ask the human boss"),
      },
      handler: async (args: Record<string, unknown>) => {
        const question = (args.question as string) || "Need guidance from the boss";

        const escalation = await prisma.escalation.create({
          data: {
            conversationId: context.conversationId,
            fromAgentId: agent.id,
            question,
          },
        });

        await context.emitActivity(context.conversationId, "escalation", {
          escalationId: escalation.id,
          question,
          agentName: agent.name,
        });

        const answer = await escalationManager.waitForAnswer(escalation.id);

        await prisma.escalation.update({
          where: { id: escalation.id },
          data: { answer, status: "answered" },
        });

        await context.emitActivity(context.conversationId, "escalation_answered", {
          escalationId: escalation.id,
        });

        return { content: [{ type: "text" as const, text: answer }] };
      },
    });
  }

  if (tools.length === 0) return null;

  return createSdkMcpServer({
    name: "agentmafia",
    version: "1.0.0",
    tools: tools as Parameters<typeof createSdkMcpServer>[0]["tools"],
  });
}
