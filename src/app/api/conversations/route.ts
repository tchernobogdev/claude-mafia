import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { startTask } from "@/lib/orchestrator";
import type { ImageInput } from "@/lib/anthropic-agent";

export async function GET() {
  const conversations = await prisma.conversation.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { messages: true } } },
  });
  return NextResponse.json(conversations);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const task = body.task as string;
  const images = body.images as ImageInput[] | undefined;

  if (!task) {
    return NextResponse.json({ error: "Task is required" }, { status: 400 });
  }

  // Start task in background - don't await
  const conversationIdPromise = startTask(task, images);

  // We need to return the conversation ID, so we await it briefly
  // The orchestrator will continue running
  try {
    const conversationId = await conversationIdPromise;
    return NextResponse.json({ conversationId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
