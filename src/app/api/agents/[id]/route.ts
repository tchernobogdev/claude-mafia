import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agent = await prisma.agent.findUnique({
    where: { id },
    include: {
      children: true,
      parent: true,
      outgoingRels: { include: { toAgent: true } },
      incomingRels: { include: { fromAgent: true } },
    },
  });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(agent);
}

// Roles that require full tool support (only Anthropic)
const TOOL_REQUIRED_ROLES = ["underboss", "capo", "soldier"];

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();

  // Get current agent to check combined state
  const currentAgent = await prisma.agent.findUnique({ where: { id } });
  if (!currentAgent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  // Determine final providerId and role after update
  const finalProviderId = body.providerId ?? currentAgent.providerId ?? "anthropic";
  const finalRole = body.role ?? currentAgent.role ?? "soldier";

  // Validate: non-Anthropic providers can only be used for analysis roles
  if (finalProviderId !== "anthropic" && TOOL_REQUIRED_ROLES.includes(finalRole)) {
    return NextResponse.json(
      {
        error: `Provider "${finalProviderId}" cannot be used for role "${finalRole}". Non-Anthropic providers (Kimi, OpenAI) can only analyze/report, not execute tasks. Use Anthropic for agents that need to delegate, execute code, or use tools.`,
        hint: "Kimi is best used as a visual analysis helper, not as a task executor in the hierarchy."
      },
      { status: 400 }
    );
  }

  const agent = await prisma.agent.update({
    where: { id },
    data: body,
  });
  return NextResponse.json(agent);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Delete children first (cascade)
  await prisma.agent.deleteMany({ where: { parentId: id } });
  await prisma.agent.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
