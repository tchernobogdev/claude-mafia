import { NextRequest, NextResponse } from "next/server";
import {
  collectMetrics,
  checkHealth,
  runDeadlockDetection,
  runWalCheckpoint,
  startMonitoring,
  stopMonitoring,
  isMonitoringRunning,
} from "@/lib/monitoring";

/**
 * GET /api/health
 * Get system health status and metrics
 *
 * Query params:
 * - metrics=true: Include full metrics
 * - check=deadlock: Run deadlock detection
 * - check=wal: Run WAL checkpoint
 */
export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const includeMetrics = searchParams.get("metrics") === "true";
  const check = searchParams.get("check");

  try {
    // Run specific checks if requested
    if (check === "deadlock") {
      const deadlocks = await runDeadlockDetection();
      return NextResponse.json({
        check: "deadlock",
        deadlocks,
        count: deadlocks.length,
      });
    }

    if (check === "wal") {
      const result = await runWalCheckpoint();
      return NextResponse.json({
        check: "wal_checkpoint",
        ...result,
      });
    }

    // Get health status
    const health = await checkHealth();

    // Optionally include full metrics
    if (includeMetrics) {
      const metrics = await collectMetrics();
      return NextResponse.json({
        ...health,
        metrics,
        monitoring: isMonitoringRunning(),
      });
    }

    return NextResponse.json({
      ...health,
      monitoring: isMonitoringRunning(),
    });
  } catch (error) {
    console.error("[Health API] Error:", error);
    return NextResponse.json(
      {
        healthy: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/health
 * Control monitoring service
 *
 * Body:
 * - action: "start" | "stop"
 * - deadlockCheckIntervalMs?: number
 * - walCheckpointIntervalMs?: number
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, deadlockCheckIntervalMs, walCheckpointIntervalMs } = body as {
      action: string;
      deadlockCheckIntervalMs?: number;
      walCheckpointIntervalMs?: number;
    };

    if (action === "start") {
      startMonitoring({
        deadlockCheckIntervalMs,
        walCheckpointIntervalMs,
      });
      return NextResponse.json({
        success: true,
        message: "Monitoring service started",
        monitoring: true,
      });
    }

    if (action === "stop") {
      stopMonitoring();
      return NextResponse.json({
        success: true,
        message: "Monitoring service stopped",
        monitoring: false,
      });
    }

    return NextResponse.json(
      { error: `Unknown action: ${action}. Use "start" or "stop".` },
      { status: 400 }
    );
  } catch (error) {
    console.error("[Health API] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
