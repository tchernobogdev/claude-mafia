import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  try {
    const settings = await prisma.setting.findMany();
    const settingsMap: Record<string, string> = {};
    for (const s of settings) {
      settingsMap[s.key] = s.value;
    }
    return NextResponse.json(settingsMap);
  } catch (err) {
    console.error("GET /api/settings:", err);
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { key, value } = body;

    if (!key || typeof key !== "string") {
      return NextResponse.json({ error: "Missing or invalid key" }, { status: 400 });
    }

    if (value === undefined || typeof value !== "string") {
      return NextResponse.json({ error: "Missing or invalid value" }, { status: 400 });
    }

    // Validate maxAgentTurns is a positive integer
    if (key === "maxAgentTurns") {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) {
        return NextResponse.json({ error: "maxAgentTurns must be a positive integer" }, { status: 400 });
      }
    }

    const setting = await prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });

    return NextResponse.json(setting);
  } catch (err) {
    console.error("PATCH /api/settings:", err);
    return NextResponse.json({ error: "Failed to update setting" }, { status: 500 });
  }
}
