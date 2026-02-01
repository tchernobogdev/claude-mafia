import { NextRequest, NextResponse } from "next/server";
import { executeConversation } from "@/lib/orchestrator";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { task, images } = body;
  if (!task) return NextResponse.json({ error: "Task required" }, { status: 400 });
  try {
    const conversationId = await executeConversation(id, task, images);
    return NextResponse.json({ conversationId });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
