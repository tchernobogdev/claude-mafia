import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ACTION_CARDINALITY } from "@/types";
import type { RelationshipAction } from "@/types";

export async function GET() {
  const rels = await prisma.relationship.findMany({
    include: { fromAgent: true, toAgent: true },
  });
  return NextResponse.json(rels);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const action = body.action as RelationshipAction;
  const cardinality = ACTION_CARDINALITY[action] || "1:1";

  const rel = await prisma.relationship.create({
    data: {
      fromAgentId: body.fromAgentId,
      toAgentId: body.toAgentId,
      action,
      cardinality,
    },
    include: { fromAgent: true, toAgent: true },
  });
  return NextResponse.json(rel, { status: 201 });
}
