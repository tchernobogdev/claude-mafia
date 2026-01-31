import { prisma } from "./db";

/**
 * Build a prompt section describing available agents and actions for an agent.
 * Used instead of Anthropic tool schemas — CLI agents use a text-based protocol.
 */
export async function buildAgentPromptTools(agentId: string, workingDirectory?: string): Promise<string> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      outgoingRels: { include: { toAgent: true } },
    },
  });

  if (!agent) return "";

  const sections: string[] = [];

  const delegateRels = agent.outgoingRels.filter((r) => r.action === "delegate");
  if (delegateRels.length > 0) {
    const targets = delegateRels
      .map((r) => `  - "${r.toAgent.name}" (ID: ${r.toAgent.id}) — ${r.toAgent.role}${r.toAgent.specialty ? `, specialty: ${r.toAgent.specialty}` : ""}`)
      .join("\n");
    sections.push(
      `**DELEGATE TASK** — Assign work to subordinates (they run in parallel):\n${targets}\nTo delegate, output:\n~~~agentmafia\n{"action":"delegate_task","targets":["<agent-id-1>","<agent-id-2>"],"task":"<task description>"}\n~~~`
    );
  }

  const askRels = agent.outgoingRels.filter((r) => r.action === "ask");
  if (askRels.length > 0) {
    const targets = askRels
      .map((r) => `  - "${r.toAgent.name}" (ID: ${r.toAgent.id})`)
      .join("\n");
    sections.push(
      `**ASK AGENT** — Ask a question to another agent:\n${targets}\nTo ask, output:\n~~~agentmafia\n{"action":"ask_agent","target":"<agent-id>","question":"<your question>"}\n~~~`
    );
  }

  const reviewRels = agent.outgoingRels.filter((r) => r.action === "review");
  if (reviewRels.length > 0) {
    const targets = reviewRels
      .map((r) => `  - "${r.toAgent.name}" (ID: ${r.toAgent.id})`)
      .join("\n");
    sections.push(
      `**REVIEW WORK** — Send work for peer review:\n${targets}\nTo request review, output:\n~~~agentmafia\n{"action":"review_work","target":"<agent-id>","content":"<work to review>"}\n~~~`
    );
  }

  const summarizeRels = agent.outgoingRels.filter((r) => r.action === "summarize");
  if (summarizeRels.length > 0) {
    const targets = summarizeRels
      .map((r) => `  - "${r.toAgent.name}" (ID: ${r.toAgent.id})`)
      .join("\n");
    sections.push(
      `**SUMMARIZE FOR** — Report a summary to another agent:\n${targets}\nTo summarize, output:\n~~~agentmafia\n{"action":"summarize_for","target":"<agent-id>","content":"<summary>"}\n~~~`
    );
  }

  if (agent.role === "underboss") {
    sections.push(
      `**ESCALATE TO BOSS** — Ask the human user for guidance (use sparingly):\nTo escalate, output:\n~~~agentmafia\n{"action":"escalate_to_boss","question":"<your question>"}\n~~~`
    );
  }

  if (agent.role === "soldier" && workingDirectory) {
    sections.push(
      `**READ FILE** — Read a file from the working directory (${workingDirectory}):\nTo read, output:\n~~~agentmafia\n{"action":"read_file","path":"<relative path>"}\n~~~`
    );
    sections.push(
      `**WRITE FILE** — Write/create a file in the working directory:\nTo write, output:\n~~~agentmafia\n{"action":"write_file","path":"<relative path>","content":"<file content>"}\n~~~`
    );
    sections.push(
      `**LIST FILES** — List files in the working directory (or a subdirectory):\nTo list, output:\n~~~agentmafia\n{"action":"list_files","path":"<optional relative subpath>"}\n~~~`
    );
    sections.push(
      `**RUN COMMAND** — Run a shell command in the working directory:\nTo run, output:\n~~~agentmafia\n{"action":"run_command","command":"<shell command>"}\n~~~`
    );
  }

  if (sections.length === 0) return "";

  return (
    "\n\n## Available Actions\n\nYou can invoke actions by outputting a fenced JSON block with ~~~agentmafia delimiters. " +
    "Output EXACTLY ONE action block when you need to use an action. After you receive results back, compile them into your final answer as plain text (no more action blocks).\n\n" +
    sections.join("\n\n")
  );
}

/**
 * Get the list of Claude Code tool names to allow for an agent based on role.
 * Soldiers get full tool access; managers only get text.
 */
export function getAllowedToolsForRole(role: string): string[] | undefined {
  if (role === "soldier") {
    // Soldiers get full Claude Code tool access
    return undefined; // undefined = all tools allowed
  }
  // Capos and underbosses just delegate — no tool access needed
  // They communicate via the agentmafia protocol blocks
  return [];
}
