import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const agents = await prisma.agent.findMany({
    include: { children: true, outgoingRels: true, incomingRels: true },
    orderBy: { orderIndex: "asc" },
  });
  return NextResponse.json(agents);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const agent = await prisma.agent.create({
    data: {
      name: body.name,
      role: body.role,
      specialty: body.specialty || null,
      systemPrompt: body.systemPrompt || "",
      model: body.model || "claude-sonnet-4-5-20250929",
      parentId: body.parentId || null,
      posX: body.posX ?? 100,
      posY: body.posY ?? 100,
      orderIndex: body.orderIndex || 0,
    },
  });
  return NextResponse.json(agent, { status: 201 });
}
