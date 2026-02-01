import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest) {
  try {
    const conversationId = req.nextUrl.searchParams.get("conversationId");
    const where = conversationId
      ? { conversationId }
      : { isDynamic: false };
    const agents = await prisma.agent.findMany({
      where,
      include: { children: true, outgoingRels: true, incomingRels: true },
      orderBy: { orderIndex: "asc" },
    });
    return NextResponse.json(agents);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const agent = await prisma.agent.create({
      data: {
        name: body.name,
        role: body.role,
        specialty: body.specialty || null,
        systemPrompt: body.systemPrompt || "",
        model: body.model || "claude-sonnet-4-5-20250929",
        providerId: body.providerId || "anthropic",
        parentId: body.parentId || null,
        posX: body.posX ?? 100,
        posY: body.posY ?? 100,
        orderIndex: body.orderIndex || 0,
        conversationId: body.conversationId || null,
        isDynamic: body.isDynamic || false,
      },
    });
    return NextResponse.json(agent, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
