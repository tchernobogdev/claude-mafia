import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Find dynamic agents created for this conversation
  const agents = await prisma.agent.findMany({
    where: { isDynamic: true, conversationId: id },
    include: {
      outgoingRels: true,
      incomingRels: true,
    },
  });

  if (agents.length === 0) {
    return NextResponse.json({ dynamic: false, agents: [], relationships: [] });
  }

  // Collect all relationships between these agents
  const agentIds = new Set(agents.map((a) => a.id));
  const relationships: { fromAgentId: string; toAgentId: string; action: string; cardinality: string }[] = [];
  for (const agent of agents) {
    for (const rel of agent.outgoingRels) {
      if (agentIds.has(rel.toAgentId)) {
        relationships.push({
          fromAgentId: rel.fromAgentId,
          toAgentId: rel.toAgentId,
          action: rel.action,
          cardinality: rel.cardinality,
        });
      }
    }
  }

  // Strip internal fields for export
  const exportAgents = agents.map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    specialty: a.specialty,
    systemPrompt: a.systemPrompt,
    model: a.model,
    parentId: a.parentId,
    posX: a.posX,
    posY: a.posY,
    orderIndex: a.orderIndex,
  }));

  return NextResponse.json({ dynamic: true, agents: exportAgents, relationships });
}
