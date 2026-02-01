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

// Roles that require full tool support (only Anthropic)
const TOOL_REQUIRED_ROLES = ["underboss", "capo", "soldier"];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Validate: non-Anthropic providers can only be used for analysis roles
    const providerId = body.providerId || "anthropic";
    const role = body.role || "soldier";

    if (providerId !== "anthropic" && TOOL_REQUIRED_ROLES.includes(role)) {
      return NextResponse.json(
        {
          error: `Provider "${providerId}" cannot be used for role "${role}". Non-Anthropic providers (Kimi, OpenAI) can only analyze/report, not execute tasks. Use Anthropic for agents that need to delegate, execute code, or use tools.`,
          hint: "Kimi is best used as a visual analysis helper, not as a task executor in the hierarchy."
        },
        { status: 400 }
      );
    }

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
