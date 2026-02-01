import { NextRequest, NextResponse } from "next/server";
import { createDynamicOrg } from "@/lib/orchestrator";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { task, workingDirectory } = body;
  if (!task) return NextResponse.json({ error: "Task required" }, { status: 400 });
  try {
    const result = await createDynamicOrg(task, workingDirectory);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
