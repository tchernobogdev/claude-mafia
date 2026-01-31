import { prisma } from "./db";
import { runAgent, type ImageInput } from "./anthropic-agent";
import { buildAgentMcpServer } from "./mcp-tools";
import { sseManager } from "./sse";
import { agentPool, AgentMailbox, type AgentInstance } from "./agent-pool";
import * as fs from "fs";
import * as path from "path";

const DEBUG_LOG_PATH = path.join(process.cwd(), "debug-latest.json");

function debugLogInit() {
  fs.writeFileSync(DEBUG_LOG_PATH, "[]", "utf-8");
}

function debugLogAppend(event: string, data: Record<string, unknown>) {
  let entries: unknown[] = [];
  try {
    const raw = fs.readFileSync(DEBUG_LOG_PATH, "utf-8");
    entries = JSON.parse(raw);
  } catch {
    entries = [];
  }
  entries.push({ timestamp: new Date().toISOString(), event, data });
  fs.writeFileSync(DEBUG_LOG_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

interface ExecuteOptions {
  agentId: string;
  task: string;
  conversationId: string;
  depth?: number;
  agentInvocations?: Map<string, number>;
  images?: ImageInput[];
  workingDirectory?: string;
  signal?: AbortSignal;
}

/** Emit an SSE event and persist it as an activity message for replay. */
async function emitActivity(
  conversationId: string,
  eventType: string,
  data: Record<string, unknown>
) {
  sseManager.emit(conversationId, eventType, data);
  // Write to debug log file
  if (eventType !== "agent_stream") {
    debugLogAppend(eventType, { conversationId, ...data });
  }
  // Persist activity events (skip high-frequency stream events)
  if (eventType !== "agent_stream") {
    await prisma.message.create({
      data: {
        conversationId,
        role: "activity",
        content: "",
        metadata: JSON.stringify({ eventType, ...data }),
      },
    });
  }
}

const MAFIA_PERSONALITY = `PERSONALITY DIRECTIVE: You talk like a member of the Soprano crime family. Use Italian-American slang, mafia lingo, and Jersey attitude. Say things like "capisce?", "fuggedaboutit", "this thing of ours", "whaddya gonna do", "madone!", "stugots". Refer to tasks as "jobs" or "pieces of work". Call colleagues by their role — "the boss", "the underboss", "capo", "soldier". Be colorful but still get the actual work done correctly. Never break character.`;

const COMMUNICATION_DIRECTIVE = `CRITICAL COMMUNICATION RULE: When reporting results to superiors or delegating tasks to subordinates, NEVER include raw file contents, full code listings, or large data dumps in your messages. Communicate like a professional team:
- Share PLANS, TASKS, SUMMARIES, and KEY FINDINGS only
- Reference files by path/name — every agent can read files themselves
- Describe what you found or changed, don't paste the entire file
- When reporting code changes, describe WHAT you changed and WHY, not the full before/after
- Keep delegation messages focused: what to do, where to look, what to watch out for
- Keep results focused: what was done, what was found, any issues

BAD: "Here is the contents of src/app/page.tsx: [500 lines of code]..."
GOOD: "I read src/app/page.tsx — it's the main dashboard component, exports a React component that fetches conversations and renders them in a grid."`;

// Track active orchestrations so they can be cancelled
const activeOrchestrations = new Map<string, AbortController>();

export function cancelOrchestration(conversationId: string): boolean {
  const controller = activeOrchestrations.get(conversationId);
  if (controller) {
    agentPool.shutdownConversation(conversationId);
    controller.abort();
    activeOrchestrations.delete(conversationId);
    return true;
  }
  return false;
}

const DELEGATION_DIRECTIVE = (role: string) => {
  const base = `CRITICAL OPERATIONAL DIRECTIVE: You are a ${role} in a hierarchical organization. Soldiers do the actual work using their tools. Capos delegate to soldiers. Underbosses delegate to capos.

MULTI-PHASE WORK: You may delegate in multiple rounds. For example, first send agents to do recon (list files, read code, investigate), review their findings, then delegate again with specific write/modify instructions. Agents CAN be called multiple times — use this for recon-then-write patterns.

WHEN DONE: Once you have all the results you need and no further delegation is required, compile/summarize the results into a final text report.`;

  if (role === "underboss") {
    return base + `

PLANNING MODE (UNDERBOSS ONLY): Before delegating, you MUST first output a plan. Think through:
1. What are the sub-tasks needed to complete this job?
2. Which capos/agents are best suited for each sub-task based on their specialty and system prompt?
3. What is the correct ORDER of operations? Some tasks depend on the output of others.
4. Which tasks can run in PARALLEL (independent) vs which must be SEQUENTIAL (dependent)?

Output your plan as plain text FIRST, describing the phases. Then begin executing phase 1 by calling the delegate_task tool. After receiving results, proceed to the next phase. Example flow:
- Phase 1: Delegate recon/research to the relevant capo → wait for results
- Phase 2: Using phase 1 results, delegate implementation to the relevant capo → wait for results
- Phase 3: Compile final report

Do NOT delegate everything at once unless the tasks are truly independent. Sequential phases produce better results because later phases can use earlier results.`;
  }

  if (role === "capo") {
    return base + `

As a capo, when you receive a task, delegate it to your soldiers. Review their results and compile a report for the underboss. You may send soldiers on multiple rounds (recon first, then implementation).`;
  }

  if (role === "tester") {
    return base + `\n\nTESTER DIRECTIVE: You are a tester with browser automation capabilities via the --chrome flag. Your job is to verify, test, and validate work done by other agents. You can:\n- Navigate to web pages and interact with the UI\n- Verify visual elements, layouts, and user flows\n- Check console errors, network requests, and page behavior\n- Take screenshots and record test results\n- Report bugs and issues back to the underboss\n\nAfter testing, compile a detailed test report with: what was tested, pass/fail status for each test, any bugs found, and screenshots if relevant.`;
  }

  return base + `

As a soldier, you do the actual hands-on work. You have full access to Claude Code tools: Read files, Write files, use Bash for shell commands, Glob for file searching, and Grep for content searching. Be thorough — read before writing, verify your work. If you have subordinates, use the delegation tools provided via MCP to assign them work.`;
};



export async function executeAgent({
  agentId,
  task,
  conversationId,
  depth = 0,
  agentInvocations = new Map(),
  images,
  workingDirectory,
  signal,
}: ExecuteOptions): Promise<string> {
  if (signal?.aborted) return "[Job stopped by the boss]";
  if (depth > 15) return "[Max delegation depth reached]";

  const MAX_INVOCATIONS_PER_AGENT = 5;
  const invocations = agentInvocations.get(agentId) || 0;
  if (invocations >= MAX_INVOCATIONS_PER_AGENT) {
    return "[Agent already called too many times in this task chain — skipping to prevent loop]";
  }
  agentInvocations.set(agentId, invocations + 1);

  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) return "[Agent not found]";

  // --- Pool-aware two-path dispatch ---
  // If agent is already running in pool, route via mailbox
  const existingInstance = agentPool.get(conversationId, agentId);
  if (existingInstance) {
    const msgId = `delegate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return existingInstance.mailbox.send(msgId, task);
  }

  await emitActivity(conversationId, "agent_start", {
    agentId: agent.id,
    agentName: agent.name,
    role: agent.role,
    task,
  });

  // Load previous context for this agent in this conversation
  const previousContext = await prisma.agentContext.findUnique({
    where: { conversationId_agentId: { conversationId, agentId } },
  });

  // Build system prompt
  const basePrompt =
    agent.systemPrompt ||
    `You are ${agent.name}, a ${agent.role} in the organization. ${agent.specialty ? `Your specialty is: ${agent.specialty}.` : ""}`;
  const workingDirContext = workingDirectory
    ? `\n\nWORKING DIRECTORY: This task has a project directory at "${workingDirectory}". All agents have file tools (Read, Write, Bash, Glob, Grep) to work with files. When delegating, mention the working directory so subordinates know where to work.`
    : "";
  const contextBlock = previousContext
    ? `\n\nPREVIOUS CONTEXT FROM THIS OPERATION:\n${previousContext.summary}\n\nUse this context to inform your work. The boss is following up on a previous request.`
    : "";
  const lifecycleDirective = `\n\nAGENT LIFECYCLE: After completing your work, call submit_result with your final report. Then call wait_for_messages to enter standby mode where other agents can ask you follow-up questions. When you receive a question via wait_for_messages, answer it using respond_to_message, then call wait_for_messages again.`;
  const systemPrompt = `${basePrompt}\n\n${DELEGATION_DIRECTIVE(agent.role)}\n\n${COMMUNICATION_DIRECTIVE}\n\n${MAFIA_PERSONALITY}${workingDirContext}${contextBlock}${lifecycleDirective}`;

  // Create abortController for this agent execution
  const agentAbortController = new AbortController();
  if (signal) {
    if (signal.aborted) return "[Job stopped by the boss]";
    signal.addEventListener("abort", () => agentAbortController.abort(), { once: true });
  }

  // Create pool instance before starting the agent
  let resultResolver!: (result: string) => void;
  const resultPromise = new Promise<string>((resolve) => {
    resultResolver = resolve;
  });
  const instance: AgentInstance = {
    agentId,
    mailbox: new AgentMailbox(),
    resultPromise,
    resultResolver,
    abortController: agentAbortController,
    queryPromise: Promise.resolve(""), // will be set below
  };
  agentPool.register(conversationId, instance);

  // Build MCP server with delegation tools scoped to this agent's relationships
  const mcpServer = await buildAgentMcpServer(agentId, {
    conversationId,
    agentId,
    depth,
    agentInvocations,
    workingDirectory,
    signal,
    abortController: agentAbortController,
    executeAgent,
    emitActivity,
  });

  // Start query in background — agent stays alive until maxTurns or shutdown
  const queryPromise = (async () => {
    try {
      const agentResult = await runAgent({
        prompt: task,
        systemPrompt,
        model: agent.model,
        role: agent.role,
        workingDirectory,
        maxTurns: 200,
        signal,
        abortController: agentAbortController,
        mcpServer,
        onToolUse: (toolName, toolInput) => {
          emitActivity(conversationId, "tool_call", {
            agentId: agent.id,
            agentName: agent.name,
            tool: toolName,
            input: typeof toolInput === 'object' ? toolInput : { value: toolInput },
          });
        },
        onDelta: (delta) => {
          sseManager.emit(conversationId, "agent_stream", {
            agentId: agent.id,
            agentName: agent.name,
            delta,
          });
        },
      });
      return agentResult.text;
    } catch (err) {
      const errMsg = `[Agent error]: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[AgentMafia] Agent error for ${agent.name}:`, err);
      await emitActivity(conversationId, "agent_error", {
        agentId: agent.id,
        agentName: agent.name,
        error: errMsg,
      });
      return errMsg;
    }
  })();
  instance.queryPromise = queryPromise;

  // Fallback: if query ends without submit_result, resolve with last text
  queryPromise.then((lastText) => {
    // If resultPromise hasn't been resolved yet, resolve it now
    resultResolver(lastText);
    agentPool.remove(conversationId, agentId);
  });

  // Wait for the agent to submit_result (or for query to end as fallback)
  const result = await resultPromise;

  // Emit final message
  await emitActivity(conversationId, "agent_message", {
    agentId: agent.id,
    agentName: agent.name,
    content: result,
  });

  // Debug log: full untruncated agent result
  debugLogAppend("agent_full_result", {
    conversationId,
    agentId: agent.id,
    agentName: agent.name,
    role: agent.role,
    depth,
    fullResultText: result,
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

  // Save agent context for follow-up continuity
  const contextSummary = `TASK: ${task}\nRESULT SUMMARY: ${result.slice(0, 2000)}`;
  const existingSummary = previousContext?.summary || "";
  const combinedSummary = existingSummary
    ? `${existingSummary}\n\n---\n\n${contextSummary}`.slice(-4000)
    : contextSummary;
  await prisma.agentContext.upsert({
    where: { conversationId_agentId: { conversationId, agentId } },
    create: { conversationId, agentId, summary: combinedSummary },
    update: { summary: combinedSummary },
  });

  await emitActivity(conversationId, "agent_done", {
    agentId: agent.id,
    agentName: agent.name,
  });

  return result;
}

export async function startTask(task: string, images?: ImageInput[], workingDirectory?: string): Promise<string> {
  // Initialize debug log for this run (overwrites previous)
  debugLogInit();

  const underbosses = await prisma.agent.findMany({
    where: { role: "underboss" },
  });

  if (underbosses.length === 0) {
    throw new Error("No underboss configured. Set up your mafia hierarchy first.");
  }

  const conversation = await prisma.conversation.create({
    data: { title: task.slice(0, 100), workingDirectory },
  });

  const userMeta: Record<string, unknown> = {};
  if (images && images.length > 0) userMeta.images = images;
  if (workingDirectory) userMeta.workingDirectory = workingDirectory;

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: task,
      metadata: Object.keys(userMeta).length > 0 ? JSON.stringify(userMeta) : null,
    },
  });

  sseManager.emit(conversation.id, "task_start", { task });

  // Run orchestration in background — don't block the HTTP response
  const underboss = underbosses[0];
  runOrchestration(underboss.id, task, conversation.id, images, workingDirectory).catch((err) => {
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
  images?: ImageInput[],
  workingDirectory?: string
): Promise<void> {
  const controller = new AbortController();
  activeOrchestrations.set(conversationId, controller);

  try {
    const result = await executeAgent({ agentId, task, conversationId, images, workingDirectory, signal: controller.signal });

    if (controller.signal.aborted) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { status: "stopped" },
      });
      sseManager.emit(conversationId, "task_stopped", {});
    } else {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { status: "completed" },
      });
      sseManager.emit(conversationId, "task_complete", { result });
    }
  } finally {
    agentPool.shutdownConversation(conversationId);
    activeOrchestrations.delete(conversationId);
  }
}

export async function continueTask(
  conversationId: string,
  followUp: string,
  images?: ImageInput[]
): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });
  if (!conversation) throw new Error("Conversation not found");

  const underbosses = await prisma.agent.findMany({
    where: { role: "underboss" },
  });
  if (underbosses.length === 0) throw new Error("No underboss configured.");

  const userMeta: Record<string, unknown> = {};
  if (images && images.length > 0) userMeta.images = images;

  await prisma.message.create({
    data: {
      conversationId,
      role: "user",
      content: followUp,
      metadata: Object.keys(userMeta).length > 0 ? JSON.stringify(userMeta) : null,
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: "active" },
  });

  // Build conversation history context for the follow-up
  const previousMessages = await prisma.message.findMany({
    where: {
      conversationId,
      role: { in: ["user", "assistant"] },
    },
    orderBy: { createdAt: "asc" },
    include: { agent: true },
  });

  const historyLines = previousMessages
    .slice(-20) // last 20 messages max
    .map((m) => {
      const speaker = m.role === "user" ? "USER" : (m.agent?.name || "AGENT");
      return `${speaker}: ${m.content.slice(0, 500)}`;
    });

  const historyPrefix = historyLines.length > 0
    ? `CONVERSATION HISTORY:\n${historyLines.join("\n\n")}\n\n---\nFOLLOW-UP REQUEST: `
    : "";

  const taskWithHistory = `${historyPrefix}${followUp}`;

  sseManager.emit(conversationId, "task_start", { task: followUp });

  const underboss = underbosses[0];
  const workingDirectory = conversation.workingDirectory || undefined;

  runOrchestration(underboss.id, taskWithHistory, conversationId, images, workingDirectory).catch((err) => {
    console.error("Orchestration failed:", err);
    sseManager.emit(conversationId, "task_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    prisma.conversation
      .update({ where: { id: conversationId }, data: { status: "failed" } })
      .catch(console.error);
  });
}
