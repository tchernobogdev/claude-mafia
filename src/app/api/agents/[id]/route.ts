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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
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
