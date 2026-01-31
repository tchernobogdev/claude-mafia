import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { prisma } from "./db";
import { escalationManager } from "./escalation";

interface McpToolContext {
  conversationId: string;
  depth: number;
  agentInvocations: Map<string, number>;
  workingDirectory?: string;
  signal?: AbortSignal;
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
  const askRels = agent.outgoingRels.filter((r) => r.action === "ask");
  const reviewRels = agent.outgoingRels.filter((r) => r.action === "review");
  const summarizeRels = agent.outgoingRels.filter((r) => r.action === "summarize");

  // Helper to build target description
  function describeTargets(rels: typeof delegateRels): string {
    return rels
      .map((r) => {
        const a = r.toAgent;
        let desc = `- "${a.name}" (ID: ${a.id}) — ${a.role}`;
        if (a.specialty) desc += `, specialty: ${a.specialty}`;
        if (a.systemPrompt) desc += ` | prompt: "${a.systemPrompt.slice(0, 120)}${a.systemPrompt.length > 120 ? "..." : ""}"`;
        return desc;
      })
      .join("\n");
  }

  if (delegateRels.length > 0) {
    const validIds = delegateRels.map((r) => r.toAgent.id);
    tools.push({
      name: "delegate_task",
      description: `Delegate a task to one or more subordinate agents in parallel. Choose agents based on their specialty.\n\nAvailable targets:\n${describeTargets(delegateRels)}`,
      inputSchema: {
        targets: z.array(z.string()).describe("Array of agent IDs to delegate to"),
        task: z.string().describe("The task description to delegate"),
      },
      handler: async (args: Record<string, unknown>) => {
        const targets = args.targets as string[];
        const task = args.task as string;

        // Validate targets
        const filteredTargets = targets.filter((t) => validIds.includes(t));
        if (filteredTargets.length === 0) {
          return { content: [{ type: "text" as const, text: `[Error: No valid target IDs. Valid IDs: ${validIds.join(", ")}]` }] };
        }

        // Emit tool_call activity
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

  if (askRels.length > 0) {
    const validIds = askRels.map((r) => r.toAgent.id);
    tools.push({
      name: "ask_agent",
      description: `Ask a question to another agent and get a response.\n\nAvailable targets:\n${describeTargets(askRels)}`,
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

        const result = await context.executeAgent({
          agentId: target,
          task: question,
          conversationId: context.conversationId,
          depth: context.depth + 1,
          agentInvocations: context.agentInvocations,
          workingDirectory: context.workingDirectory,
          signal: context.signal,
        });

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

  if (reviewRels.length > 0) {
    const validIds = reviewRels.map((r) => r.toAgent.id);
    tools.push({
      name: "review_work",
      description: `Send work for peer review.\n\nAvailable targets:\n${describeTargets(reviewRels)}`,
      inputSchema: {
        target: z.string().describe("Agent ID to review the work"),
        content: z.string().describe("The work content to be reviewed"),
      },
      handler: async (args: Record<string, unknown>) => {
        const target = args.target as string;
        const content = args.content as string;

        if (!validIds.includes(target)) {
          return { content: [{ type: "text" as const, text: `[Error: Invalid target. Valid IDs: ${validIds.join(", ")}]` }] };
        }

        const targetAgent = await prisma.agent.findUnique({ where: { id: target }, select: { id: true, name: true, role: true } });
        await context.emitActivity(context.conversationId, "tool_call", {
          agentId: agent.id,
          agentName: agent.name,
          tool: "review_work",
          input: { target, content: content.slice(0, 200) },
          targetAgents: targetAgent ? [targetAgent] : [],
        });

        const result = await context.executeAgent({
          agentId: target,
          task: `Please review the following work and provide feedback:\n\n${content}`,
          conversationId: context.conversationId,
          depth: context.depth + 1,
          agentInvocations: context.agentInvocations,
          workingDirectory: context.workingDirectory,
          signal: context.signal,
        });

        await context.emitActivity(context.conversationId, "tool_result", {
          agentId: agent.id,
          agentName: agent.name,
          tool: "review_work",
          result: result.slice(0, 1000),
        });

        return { content: [{ type: "text" as const, text: result }] };
      },
    });
  }

  if (summarizeRels.length > 0) {
    const validIds = summarizeRels.map((r) => r.toAgent.id);
    tools.push({
      name: "summarize_for",
      description: `Report a summary to another agent.\n\nAvailable targets:\n${describeTargets(summarizeRels)}`,
      inputSchema: {
        target: z.string().describe("Agent ID to send the summary to"),
        content: z.string().describe("The summary content"),
      },
      handler: async (args: Record<string, unknown>) => {
        const target = args.target as string;
        const content = args.content as string;

        if (!validIds.includes(target)) {
          return { content: [{ type: "text" as const, text: `[Error: Invalid target. Valid IDs: ${validIds.join(", ")}]` }] };
        }

        const targetAgent = await prisma.agent.findUnique({ where: { id: target }, select: { id: true, name: true, role: true } });
        await context.emitActivity(context.conversationId, "tool_call", {
          agentId: agent.id,
          agentName: agent.name,
          tool: "summarize_for",
          input: { target, content: content.slice(0, 200) },
          targetAgents: targetAgent ? [targetAgent] : [],
        });

        const result = await context.executeAgent({
          agentId: target,
          task: `Here is a summary for your review:\n\n${content}`,
          conversationId: context.conversationId,
          depth: context.depth + 1,
          agentInvocations: context.agentInvocations,
          workingDirectory: context.workingDirectory,
          signal: context.signal,
        });

        await context.emitActivity(context.conversationId, "tool_result", {
          agentId: agent.id,
          agentName: agent.name,
          tool: "summarize_for",
          result: result.slice(0, 1000),
        });

        return { content: [{ type: "text" as const, text: result }] };
      },
    });
  }

  // Escalation is available to underbosses
  if (agent.role === "underboss") {
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

  // Cast tools to the expected type — the SDK uses zod raw shapes for inputSchema
  return createSdkMcpServer({
    name: "agentmafia",
    version: "1.0.0",
    tools: tools as Parameters<typeof createSdkMcpServer>[0]["tools"],
  });
}
