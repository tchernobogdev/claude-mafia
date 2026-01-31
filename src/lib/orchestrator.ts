import { prisma } from "./db";
import { runAgent, type ImageInput } from "./anthropic-agent";
import { buildAgentPromptTools } from "./tools";
import { escalationManager } from "./escalation";
import { sseManager } from "./sse";

interface ExecuteOptions {
  agentId: string;
  task: string;
  conversationId: string;
  depth?: number;
  visitedAgentIds?: Set<string>;
  images?: ImageInput[];
}

interface AgentAction {
  action: string;
  targets?: string[];
  target?: string;
  task?: string;
  question?: string;
  content?: string;
}

const MAFIA_PERSONALITY = `PERSONALITY DIRECTIVE: You talk like a member of the Soprano crime family. Use Italian-American slang, mafia lingo, and Jersey attitude. Say things like "capisce?", "fuggedaboutit", "this thing of ours", "whaddya gonna do", "madone!", "stugots". Refer to tasks as "jobs" or "pieces of work". Call colleagues by their role — "the boss", "the underboss", "capo", "soldier". Be colorful but still get the actual work done correctly. Never break character.`;

const DELEGATION_DIRECTIVE = (role: string) =>
  `CRITICAL OPERATIONAL DIRECTIVE: You are a ${role} in a hierarchical organization. When you FIRST receive a task, you MUST delegate it to your subordinates using the delegate action if available — do NOT answer directly, that is their job. Underbosses delegate to capos. Capos delegate to soldiers. Soldiers do the actual work using their tools. HOWEVER: once you have already delegated and received results back from your subordinates, you MUST compile/summarize those results into a final text report and STOP. Do NOT delegate again. Just give your final answer as plain text with no action blocks.`;

/**
 * Parse an agentmafia action block from CLI output.
 * Format: ~~~agentmafia\n{...json...}\n~~~
 */
function parseActionBlock(text: string): AgentAction | null {
  const match = text.match(/~~~agentmafia\s*\n([\s\S]*?)\n\s*~~~/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim()) as AgentAction;
  } catch {
    return null;
  }
}

/**
 * Strip action blocks from text to get the surrounding prose.
 */
function stripActionBlocks(text: string): string {
  return text.replace(/~~~agentmafia\s*\n[\s\S]*?\n\s*~~~/g, "").trim();
}

export async function executeAgent({
  agentId,
  task,
  conversationId,
  depth = 0,
  visitedAgentIds = new Set(),
  images,
}: ExecuteOptions): Promise<string> {
  if (depth > 5) return "[Max delegation depth reached]";

  if (visitedAgentIds.has(agentId)) {
    return "[Agent already involved in this task chain — skipping to prevent loop]";
  }
  visitedAgentIds.add(agentId);

  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) return "[Agent not found]";

  sseManager.emit(conversationId, "agent_start", {
    agentId: agent.id,
    agentName: agent.name,
    role: agent.role,
    task,
  });

  // Build system prompt
  const toolPrompt = await buildAgentPromptTools(agentId);
  const basePrompt =
    agent.systemPrompt ||
    `You are ${agent.name}, a ${agent.role} in the organization. ${agent.specialty ? `Your specialty is: ${agent.specialty}.` : ""}`;
  const systemPrompt = `${basePrompt}\n\n${DELEGATION_DIRECTIVE(agent.role)}\n\n${MAFIA_PERSONALITY}${toolPrompt}`;

  let result: string;
  try {
    const agentResult = await runAgent({
      prompt: task,
      systemPrompt,
      model: agent.model,
      images,
      onDelta: (delta) => {
        sseManager.emit(conversationId, "agent_stream", {
          agentId: agent.id,
          agentName: agent.name,
          delta,
        });
      },
    });
    result = agentResult.text;
  } catch (err) {
    result = `[Agent error]: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[AgentMafia] Agent error for ${agent.name}:`, err);
    sseManager.emit(conversationId, "agent_error", {
      agentId: agent.id,
      agentName: agent.name,
      error: result,
    });
    return result;
  }

  // Check for action blocks in output
  const action = parseActionBlock(result);

  if (action) {
    sseManager.emit(conversationId, "tool_call", {
      agentId: agent.id,
      agentName: agent.name,
      tool: action.action,
      input: action,
    });

    let actionResult: string;

    switch (action.action) {
      case "delegate_task": {
        const targetIds = action.targets || [];
        const delegateTask = action.task || task;
        const results = await Promise.all(
          targetIds.map((tid) =>
            executeAgent({
              agentId: tid,
              task: delegateTask,
              conversationId,
              depth: depth + 1,
              visitedAgentIds,
            })
          )
        );
        actionResult = results
          .map((r, i) => `[Result from agent ${targetIds[i]}]: ${r}`)
          .join("\n\n");
        break;
      }

      case "ask_agent": {
        const targetId = action.target!;
        actionResult = await executeAgent({
          agentId: targetId,
          task: action.question || task,
          conversationId,
          depth: depth + 1,
          visitedAgentIds,
        });
        break;
      }

      case "review_work": {
        const targetId = action.target!;
        actionResult = await executeAgent({
          agentId: targetId,
          task: `Please review the following work and provide feedback:\n\n${action.content}`,
          conversationId,
          depth: depth + 1,
          visitedAgentIds,
        });
        break;
      }

      case "summarize_for": {
        const targetId = action.target!;
        actionResult = await executeAgent({
          agentId: targetId,
          task: `Here is a summary for your review:\n\n${action.content}`,
          conversationId,
          depth: depth + 1,
          visitedAgentIds,
        });
        break;
      }

      case "escalate_to_boss": {
        const question = action.question || "Need guidance from the boss";
        const escalation = await prisma.escalation.create({
          data: {
            conversationId,
            fromAgentId: agent.id,
            question,
          },
        });

        sseManager.emit(conversationId, "escalation", {
          escalationId: escalation.id,
          question,
          agentName: agent.name,
        });

        actionResult = await escalationManager.waitForAnswer(escalation.id);

        await prisma.escalation.update({
          where: { id: escalation.id },
          data: { answer: actionResult, status: "answered" },
        });

        sseManager.emit(conversationId, "escalation_answered", {
          escalationId: escalation.id,
        });
        break;
      }

      default:
        actionResult = "[Unknown action]";
    }

    // Re-invoke agent with results to compile final answer
    const compilationPrompt = `You previously received this task: ${task}\n\nYou delegated/asked and here are the results:\n\n${actionResult}\n\nNow compile these results into your final answer. Do NOT output any action blocks. Just give your compiled report as plain text.`;

    try {
      const compilationResult = await runAgent({
        prompt: compilationPrompt,
        systemPrompt,
        model: agent.model,
        onDelta: (delta) => {
          sseManager.emit(conversationId, "agent_stream", {
            agentId: agent.id,
            agentName: agent.name,
            delta,
          });
        },
      });
      result = stripActionBlocks(compilationResult.text);
    } catch {
      // If compilation fails, use the raw action results
      result = stripActionBlocks(result) + "\n\n" + actionResult;
    }
  }

  // Emit final message
  sseManager.emit(conversationId, "agent_message", {
    agentId: agent.id,
    agentName: agent.name,
    content: result,
  });

  // Save message
  await prisma.message.create({
    data: {
      conversationId,
      agentId: agent.id,
      role: "assistant",
      content: result,
      metadata: JSON.stringify({ depth }),
    },
  });

  sseManager.emit(conversationId, "agent_done", {
    agentId: agent.id,
    agentName: agent.name,
  });

  return result;
}

export async function startTask(task: string, images?: ImageInput[]): Promise<string> {
  const underbosses = await prisma.agent.findMany({
    where: { role: "underboss" },
  });

  if (underbosses.length === 0) {
    throw new Error("No underboss configured. Set up your mafia hierarchy first.");
  }

  const conversation = await prisma.conversation.create({
    data: { title: task.slice(0, 100) },
  });

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: task,
    },
  });

  sseManager.emit(conversation.id, "task_start", { task });

  // Run orchestration in background — don't block the HTTP response
  const underboss = underbosses[0];
  runOrchestration(underboss.id, task, conversation.id, images).catch((err) => {
    console.error("Orchestration failed:", err);
    sseManager.emit(conversation.id, "task_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    prisma.conversation
      .update({ where: { id: conversation.id }, data: { status: "failed" } })
      .catch(console.error);
  });

  return conversation.id;
}

async function runOrchestration(
  agentId: string,
  task: string,
  conversationId: string,
  images?: ImageInput[]
): Promise<void> {
  const result = await executeAgent({ agentId, task, conversationId, images });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: "completed" },
  });

  sseManager.emit(conversationId, "task_complete", { result });
}
