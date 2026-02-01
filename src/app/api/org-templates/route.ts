import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const templates = await prisma.orgTemplate.findMany({
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(templates);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, agents, relationships } = body;
  if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });
  if (!agents) return NextResponse.json({ error: "Agents required" }, { status: 400 });
  if (!relationships) return NextResponse.json({ error: "Relationships required" }, { status: 400 });

  // Validate they can be stringified/parsed
  try {
    const agentsStr = typeof agents === "string" ? agents : JSON.stringify(agents);
    const relsStr = typeof relationships === "string" ? relationships : JSON.stringify(relationships);
    // Try to parse them if they're strings to validate format
    if (typeof agents === "string") JSON.parse(agents);
    if (typeof relationships === "string") JSON.parse(relationships);

    const template = await prisma.orgTemplate.create({
      data: { name, agents: agentsStr, relationships: relsStr },
    });
    return NextResponse.json(template, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: "Invalid agents or relationships format" }, { status: 400 });
  }
}
