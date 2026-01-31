import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { continueTask, cancelOrchestration } from "@/lib/orchestrator";
import type { ImageInput } from "@/lib/anthropic-agent";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const conversation = await prisma.conversation.findUnique({
    where: { id },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        include: { agent: { select: { name: true, role: true } } },
      },
      escalations: {
        where: { status: "pending" },
      },
    },
  });
  if (!conversation)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(conversation);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const message = body.message as string;
  const images = body.images as ImageInput[] | undefined;

  if (!message) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }

  try {
    await continueTask(id, message, images);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const cancelled = cancelOrchestration(id);
  if (cancelled) {
    await prisma.conversation.update({
      where: { id },
      data: { status: "stopped" },
    });
  }
  return NextResponse.json({ ok: true, cancelled });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.conversation.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
