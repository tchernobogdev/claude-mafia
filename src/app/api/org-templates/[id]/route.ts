import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const template = await prisma.orgTemplate.findUnique({ where: { id } });
  if (!template) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(template);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const data: Record<string, string> = {};
  if (body.name) data.name = body.name;
  if (body.agents) data.agents = typeof body.agents === "string" ? body.agents : JSON.stringify(body.agents);
  if (body.relationships) data.relationships = typeof body.relationships === "string" ? body.relationships : JSON.stringify(body.relationships);
  const template = await prisma.orgTemplate.update({ where: { id }, data });
  return NextResponse.json(template);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await prisma.orgTemplate.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }
}
