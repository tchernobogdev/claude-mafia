import { NextRequest, NextResponse } from "next/server";
import { escalationManager } from "@/lib/escalation";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const answer = body.answer as string;

  if (!answer) {
    return NextResponse.json({ error: "Answer is required" }, { status: 400 });
  }

  const resolved = escalationManager.resolveAnswer(id, answer);
  if (!resolved) {
    return NextResponse.json(
      { error: "No pending escalation found with this ID" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true });
}
