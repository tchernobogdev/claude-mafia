/**
 * Monitoring and Health Module for AgentMafia
 *
 * Provides:
 * - Periodic deadlock detection
 * - System metrics collection
 * - Agent heartbeat monitoring
 * - Database maintenance (WAL checkpointing)
 */

import { agentPool } from "./agent-pool";
import { prisma } from "./db";
import { getCircuitBreaker } from "./retry";

// ==================== TYPES ====================

export interface SystemMetrics {
  timestamp: number;
  uptime: number;
  agents: {
    total: number;
    conversations: number;
    withWaiters: number;
    queuedMessages: number;
    oldestAgentMs: number;
  };
  providers: {
    [providerId: string]: {
      state: string;
      failureCount: number;
    };
  };
  database: {
    conversationCount: number;
    messageCount: number;
    activeConversations: number;
  };
  deadlocks: {
    detected: boolean;
    involvedAgents: string[];
  };
}

export interface HealthStatus {
  healthy: boolean;
  checks: {
    database: boolean;
    agentPool: boolean;
    circuitBreakers: boolean;
  };
  issues: string[];
}

// ==================== METRICS COLLECTION ====================

let startTime = Date.now();
let lastDeadlockCheck: { conversationId: string; agents: string[] }[] = [];

/**
 * Collect current system metrics
 */
export async function collectMetrics(): Promise<SystemMetrics> {
  const poolMetrics = agentPool.getMetrics();

  // Get provider circuit breaker states
  const providerStates: SystemMetrics["providers"] = {};
  for (const providerId of ["anthropic", "kimi", "openai"]) {
    const breaker = getCircuitBreaker(providerId);
    providerStates[providerId] = {
      state: breaker.getState(),
      failureCount: breaker.getFailureCount(),
    };
  }

  // Get database stats
  let dbStats = {
    conversationCount: 0,
    messageCount: 0,
    activeConversations: 0,
  };

  try {
    const [convCount, msgCount, activeCount] = await Promise.all([
      prisma.conversation.count(),
      prisma.message.count(),
      prisma.conversation.count({ where: { status: "active" } }),
    ]);
    dbStats = {
      conversationCount: convCount,
      messageCount: msgCount,
      activeConversations: activeCount,
    };
  } catch (e) {
    console.error("[Monitoring] Failed to collect database stats:", e);
  }

  return {
    timestamp: Date.now(),
    uptime: Date.now() - startTime,
    agents: {
      total: poolMetrics.totalAgents,
      conversations: poolMetrics.totalConversations,
      withWaiters: poolMetrics.agentsWithWaiters,
      queuedMessages: poolMetrics.totalQueuedMessages,
      oldestAgentMs: poolMetrics.oldestAgentMs,
    },
    providers: providerStates,
    database: dbStats,
    deadlocks: {
      detected: lastDeadlockCheck.length > 0,
      involvedAgents: lastDeadlockCheck.flatMap((d) => d.agents),
    },
  };
}

/**
 * Perform health check
 */
export async function checkHealth(): Promise<HealthStatus> {
  const issues: string[] = [];
  const checks = {
    database: true,
    agentPool: true,
    circuitBreakers: true,
  };

  // Check database connectivity
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    checks.database = false;
    issues.push(`Database unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Check agent pool health
  const poolMetrics = agentPool.getMetrics();
  if (poolMetrics.totalQueuedMessages > 500) {
    checks.agentPool = false;
    issues.push(`Agent pool has ${poolMetrics.totalQueuedMessages} queued messages (threshold: 500)`);
  }
  if (poolMetrics.oldestAgentMs > 60 * 60 * 1000) {
    issues.push(`Oldest agent running for ${Math.round(poolMetrics.oldestAgentMs / 60000)} minutes`);
  }

  // Check circuit breakers
  for (const providerId of ["anthropic", "kimi"]) {
    const breaker = getCircuitBreaker(providerId);
    if (breaker.getState() === "open") {
      checks.circuitBreakers = false;
      issues.push(`Circuit breaker for ${providerId} is OPEN`);
    }
  }

  // Check for deadlocks
  if (lastDeadlockCheck.length > 0) {
    issues.push(`Deadlocks detected in ${lastDeadlockCheck.length} conversation(s)`);
  }

  return {
    healthy: checks.database && checks.agentPool && checks.circuitBreakers && issues.length === 0,
    checks,
    issues,
  };
}

// ==================== DEADLOCK DETECTION ====================

/**
 * Run deadlock detection across all active conversations
 */
export async function runDeadlockDetection(): Promise<{ conversationId: string; agents: string[] }[]> {
  const deadlocks: { conversationId: string; agents: string[] }[] = [];

  try {
    // Get all active conversations
    const activeConversations = await prisma.conversation.findMany({
      where: { status: "active" },
      select: { id: true },
    });

    for (const conv of activeConversations) {
      const deadlockedAgents = agentPool.detectDeadlocks(conv.id);
      if (deadlockedAgents.length > 0) {
        deadlocks.push({
          conversationId: conv.id,
          agents: deadlockedAgents,
        });
        console.warn(`[Monitoring] Deadlock detected in ${conv.id}: agents ${deadlockedAgents.join(", ")}`);
      }
    }
  } catch (e) {
    console.error("[Monitoring] Deadlock detection failed:", e);
  }

  lastDeadlockCheck = deadlocks;
  return deadlocks;
}

// ==================== DATABASE MAINTENANCE ====================

/**
 * Run WAL checkpoint to prevent unbounded growth
 */
export async function runWalCheckpoint(): Promise<{ success: boolean; error?: string }> {
  try {
    // PRAGMA wal_checkpoint(RESTART) forces a checkpoint and restarts the WAL file
    await prisma.$executeRawUnsafe("PRAGMA wal_checkpoint(RESTART)");
    console.log("[Monitoring] WAL checkpoint completed successfully");
    return { success: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[Monitoring] WAL checkpoint failed:", error);
    return { success: false, error };
  }
}

/**
 * Clean up old completed conversations (optional maintenance)
 */
export async function cleanupOldConversations(daysOld: number = 30): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
    const result = await prisma.conversation.deleteMany({
      where: {
        status: { in: ["completed", "failed", "stopped"] },
        updatedAt: { lt: cutoff },
      },
    });
    console.log(`[Monitoring] Cleaned up ${result.count} old conversations`);
    return result.count;
  } catch (e) {
    console.error("[Monitoring] Cleanup failed:", e);
    return 0;
  }
}

// ==================== MONITORING SERVICE ====================

let monitoringInterval: ReturnType<typeof setInterval> | null = null;
let walCheckpointInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the monitoring service
 */
export function startMonitoring(options: {
  deadlockCheckIntervalMs?: number;
  walCheckpointIntervalMs?: number;
} = {}): void {
  const deadlockInterval = options.deadlockCheckIntervalMs ?? 60000; // 1 minute
  const walInterval = options.walCheckpointIntervalMs ?? 3600000; // 1 hour

  // Stop existing intervals if any
  stopMonitoring();

  console.log(`[Monitoring] Starting monitoring service (deadlock check: ${deadlockInterval}ms, WAL checkpoint: ${walInterval}ms)`);

  // Periodic deadlock detection
  monitoringInterval = setInterval(async () => {
    try {
      const deadlocks = await runDeadlockDetection();
      if (deadlocks.length > 0) {
        console.warn(`[Monitoring] ${deadlocks.length} deadlock(s) detected`);
      }
    } catch (e) {
      console.error("[Monitoring] Deadlock check error:", e);
    }
  }, deadlockInterval);

  // Periodic WAL checkpoint
  walCheckpointInterval = setInterval(async () => {
    await runWalCheckpoint();
  }, walInterval);

  // Run initial checks
  runDeadlockDetection().catch(console.error);
}

/**
 * Stop the monitoring service
 */
export function stopMonitoring(): void {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
  if (walCheckpointInterval) {
    clearInterval(walCheckpointInterval);
    walCheckpointInterval = null;
  }
  console.log("[Monitoring] Monitoring service stopped");
}

/**
 * Check if monitoring is running
 */
export function isMonitoringRunning(): boolean {
  return monitoringInterval !== null;
}
