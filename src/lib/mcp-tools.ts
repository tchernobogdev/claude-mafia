import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { prisma } from "./db";
import { escalationManager } from "./escalation";
import { agentPool } from "./agent-pool";

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
      description: `Delegate a task to one or more subordinate agents in parallel. Choose agents based on their specialty.\n\nAvailable targets:\n${targetDesc}`,
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

  // === ask_agent — implicit for ANY connected agent (outgoing + incoming, all types) ===
  const askTargets = new Map<string, { id: string; name: string; role: string; specialty: string | null; systemPrompt: string }>();
  for (const rel of agent.outgoingRels) {
    if (!askTargets.has(rel.toAgent.id) && rel.toAgent.id !== agentId) {
      askTargets.set(rel.toAgent.id, rel.toAgent);
    }
  }
  for (const rel of agent.incomingRels) {
    if (!askTargets.has(rel.fromAgent.id) && rel.fromAgent.id !== agentId) {
      askTargets.set(rel.fromAgent.id, rel.fromAgent);
    }
  }

  if (askTargets.size > 0) {
    const validIds = [...askTargets.keys()];
    const askTargetDesc = [...askTargets.values()].map(describeAgent).join("\n");
    tools.push({
      name: "ask_agent",
      description: `Ask a question to any connected agent. If the agent is already running in the pool, the question is routed to their mailbox (no new spawn). Otherwise, a new instance is spawned.\n\nAvailable targets:\n${askTargetDesc}`,
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

  // wait_for_messages: block until a question arrives or shutdown
  tools.push({
    name: "wait_for_messages",
    description: "Wait for incoming questions from other agents. Blocks until a message arrives or the job ends. Call this after submit_result to enter standby mode.",
    inputSchema: {},
    handler: async () => {
      const instance = agentPool.get(context.conversationId, agentId);
      if (!instance) {
        return { content: [{ type: "text" as const, text: "[No pool instance — session ending]" }] };
      }
      const msg = await instance.mailbox.receive();
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
    description: "Respond to a question received via wait_for_messages. After responding, call wait_for_messages again to continue standby.",
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
