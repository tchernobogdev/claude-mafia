/**
 * Agent Pool — persistent agent instances that stay alive for the duration of a job.
 *
 * Agents are registered when spawned and remain in the pool after completing their
 * primary task, waiting for follow-up questions via a mailbox. The pool is shut down
 * when the job (conversation) ends.
 *
 * FIXES IMPLEMENTED:
 * - Mutex lock to prevent race conditions between multiple receivers
 * - Proper timer cleanup on early resolution
 * - Shutdown sentinel is always queued (not lost if no waiter)
 * - Queue size limits to prevent memory leaks
 * - Deadlock detection via pool-level tracking
 */

interface MailboxMessage {
  id: string;
  content: string;
  resolve: (response: string) => void;
  timestamp: number;
}

// Simple mutex implementation for async locking
class Mutex {
  private locked = false;
  private waitQueue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

const MAX_QUEUE_SIZE = 100;
const MESSAGE_TTL_MS = 5 * 60 * 1000; // 5 minutes - messages older than this are dropped

export class AgentMailbox {
  private queue: MailboxMessage[] = [];
  private waiter: ((msg: MailboxMessage) => void) | null = null;
  private waiterTimer: ReturnType<typeof setTimeout> | null = null;
  private mutex = new Mutex();
  private isShutdown = false;

  /** Send a message to this agent. Returns a promise that resolves when the agent responds. */
  async send(id: string, content: string): Promise<string> {
    await this.mutex.acquire();
    try {
      // If shutdown, reject immediately
      if (this.isShutdown) {
        return "[Agent has shut down]";
      }

      // Check queue size limit
      if (this.queue.length >= MAX_QUEUE_SIZE) {
        console.warn(`[AgentMailbox] Queue full (${MAX_QUEUE_SIZE}), dropping oldest message`);
        const dropped = this.queue.shift();
        if (dropped) {
          dropped.resolve("[Message dropped due to queue overflow]");
        }
      }

      return new Promise<string>((resolve) => {
        const msg: MailboxMessage = { id, content, resolve, timestamp: Date.now() };

        if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          // Clear any pending timer
          if (this.waiterTimer) {
            clearTimeout(this.waiterTimer);
            this.waiterTimer = null;
          }
          w(msg);
        } else {
          this.queue.push(msg);
        }
      });
    } finally {
      this.mutex.release();
    }
  }

  /** Wait for the next message. Returns immediately if one is queued, else blocks. */
  async receive(): Promise<MailboxMessage> {
    await this.mutex.acquire();
    try {
      // Clean up stale messages
      this.cleanupStaleMessages();

      if (this.queue.length > 0) {
        return this.queue.shift()!;
      }

      // If already shutdown, return sentinel immediately
      if (this.isShutdown) {
        return { id: "__shutdown__", content: "__shutdown__", resolve: () => {}, timestamp: Date.now() };
      }

      // Need to wait - release mutex while waiting
      return new Promise<MailboxMessage>((resolve) => {
        this.waiter = resolve;
        this.mutex.release();
      });
    } catch (e) {
      this.mutex.release();
      throw e;
    }
  }

  /** Wait for the next message with a timeout. Returns null if timeout expires. */
  async receiveWithTimeout(timeoutMs: number): Promise<MailboxMessage | null> {
    await this.mutex.acquire();
    try {
      // Clean up stale messages
      this.cleanupStaleMessages();

      if (this.queue.length > 0) {
        return this.queue.shift()!;
      }

      // If already shutdown, return sentinel immediately
      if (this.isShutdown) {
        return { id: "__shutdown__", content: "__shutdown__", resolve: () => {}, timestamp: Date.now() };
      }

      // Need to wait with timeout - release mutex while waiting
      return new Promise<MailboxMessage | null>((resolve) => {
        let resolved = false;

        const timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            // Re-acquire mutex to safely clear waiter
            this.mutex.acquire().then(() => {
              if (this.waiter === wrappedResolve) {
                this.waiter = null;
              }
              this.waiterTimer = null;
              this.mutex.release();
              resolve(null);
            });
          }
        }, timeoutMs);

        const wrappedResolve = (msg: MailboxMessage) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            this.waiterTimer = null;
            resolve(msg);
          }
        };

        this.waiter = wrappedResolve;
        this.waiterTimer = timer;
        this.mutex.release();
      });
    } catch (e) {
      this.mutex.release();
      throw e;
    }
  }

  /** Unblock any waiting receive() with a shutdown sentinel. */
  async shutdown(): Promise<void> {
    await this.mutex.acquire();
    try {
      this.isShutdown = true;

      // Clear any pending timer
      if (this.waiterTimer) {
        clearTimeout(this.waiterTimer);
        this.waiterTimer = null;
      }

      // Notify waiter if present
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w({ id: "__shutdown__", content: "__shutdown__", resolve: () => {}, timestamp: Date.now() });
      }

      // Resolve all pending messages in queue with shutdown notice
      for (const msg of this.queue) {
        msg.resolve("[Agent shut down before responding]");
      }
      this.queue = [];
    } finally {
      this.mutex.release();
    }
  }

  /** Clean up messages older than TTL */
  private cleanupStaleMessages(): void {
    const now = Date.now();
    const staleCount = this.queue.filter(m => now - m.timestamp > MESSAGE_TTL_MS).length;

    if (staleCount > 0) {
      console.warn(`[AgentMailbox] Cleaning up ${staleCount} stale messages`);
      this.queue = this.queue.filter(m => {
        if (now - m.timestamp > MESSAGE_TTL_MS) {
          m.resolve("[Message expired - agent did not respond in time]");
          return false;
        }
        return true;
      });
    }
  }

  /** Get current queue depth for monitoring */
  getQueueDepth(): number {
    return this.queue.length;
  }

  /** Check if there's a waiter blocked */
  hasWaiter(): boolean {
    return this.waiter !== null;
  }
}

export interface AgentInstance {
  agentId: string;
  mailbox: AgentMailbox;
  /** Resolves when the agent submits its primary result. */
  resultPromise: Promise<string>;
  resultResolver: (result: string) => void;
  abortController: AbortController;
  /** The background query() promise — resolves when the agent session ends. */
  queryPromise: Promise<string>;
  _pendingResponses?: Map<string, (r: string) => void>;
  /** Timestamp when agent was registered */
  registeredAt: number;
  /** Timestamp of last activity (heartbeat) */
  lastActivityAt: number;
  /** Agent currently waiting for which other agents (for deadlock detection) */
  waitingFor?: Set<string>;
}

// Pool health metrics
interface PoolMetrics {
  totalAgents: number;
  totalConversations: number;
  agentsWithWaiters: number;
  totalQueuedMessages: number;
  oldestAgentMs: number;
  staleAgents: number; // Agents with no activity for >5 minutes
}

const MAX_AGENTS_PER_CONVERSATION = 100;
const AGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes - agents older than this get cleaned up

class AgentPool {
  // conversationId -> agentId -> AgentInstance
  private pool = new Map<string, Map<string, AgentInstance>>();

  get(conversationId: string, agentId: string): AgentInstance | undefined {
    return this.pool.get(conversationId)?.get(agentId);
  }

  register(conversationId: string, instance: AgentInstance): void {
    let convMap = this.pool.get(conversationId);
    if (!convMap) {
      convMap = new Map();
      this.pool.set(conversationId, convMap);
    }

    // Check pool size limit
    if (convMap.size >= MAX_AGENTS_PER_CONVERSATION) {
      console.warn(`[AgentPool] Conversation ${conversationId} has ${convMap.size} agents, cleaning up old ones`);
      this.cleanupOldAgents(conversationId);
    }

    // Ensure registeredAt is set
    if (!instance.registeredAt) {
      instance.registeredAt = Date.now();
    }

    convMap.set(instance.agentId, instance);
  }

  remove(conversationId: string, agentId: string): void {
    this.pool.get(conversationId)?.delete(agentId);
  }

  /** Shut down all agents for a conversation. */
  async shutdownConversation(conversationId: string): Promise<void> {
    const convMap = this.pool.get(conversationId);
    if (!convMap) return;

    // Shutdown all mailboxes and abort controllers
    const shutdownPromises: Promise<void>[] = [];
    for (const instance of convMap.values()) {
      shutdownPromises.push(instance.mailbox.shutdown());
      instance.abortController.abort();
    }

    // Wait for all shutdowns to complete
    await Promise.all(shutdownPromises);
    this.pool.delete(conversationId);
  }

  isRunning(conversationId: string, agentId: string): boolean {
    return !!this.pool.get(conversationId)?.has(agentId);
  }

  /** Get all agent IDs for a conversation */
  getAgentIds(conversationId: string): string[] {
    const convMap = this.pool.get(conversationId);
    return convMap ? Array.from(convMap.keys()) : [];
  }

  /** Clean up agents that have been running too long */
  private cleanupOldAgents(conversationId: string): void {
    const convMap = this.pool.get(conversationId);
    if (!convMap) return;

    const now = Date.now();
    const toRemove: string[] = [];

    for (const [agentId, instance] of convMap.entries()) {
      if (now - instance.registeredAt > AGENT_TIMEOUT_MS) {
        toRemove.push(agentId);
      }
    }

    for (const agentId of toRemove) {
      const instance = convMap.get(agentId);
      if (instance) {
        console.warn(`[AgentPool] Cleaning up stale agent ${agentId} (running for ${Math.round((now - instance.registeredAt) / 1000)}s)`);
        instance.mailbox.shutdown();
        instance.abortController.abort();
        convMap.delete(agentId);
      }
    }
  }

  /** Detect potential deadlocks - returns agent IDs involved in circular waits */
  detectDeadlocks(conversationId: string): string[] {
    const convMap = this.pool.get(conversationId);
    if (!convMap) return [];

    // Build wait-for graph
    const waitingFor = new Map<string, Set<string>>();
    for (const [agentId, instance] of convMap.entries()) {
      if (instance.waitingFor && instance.waitingFor.size > 0) {
        waitingFor.set(agentId, instance.waitingFor);
      }
    }

    // DFS to detect cycles
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const deadlocked: string[] = [];

    const dfs = (node: string): boolean => {
      if (inStack.has(node)) {
        return true; // Cycle detected
      }
      if (visited.has(node)) {
        return false;
      }

      visited.add(node);
      inStack.add(node);

      const targets = waitingFor.get(node);
      if (targets) {
        for (const target of targets) {
          if (dfs(target)) {
            deadlocked.push(node);
            return true;
          }
        }
      }

      inStack.delete(node);
      return false;
    };

    for (const agentId of waitingFor.keys()) {
      if (!visited.has(agentId)) {
        dfs(agentId);
      }
    }

    return deadlocked;
  }

  /** Set what agents this agent is waiting for (for deadlock detection) */
  setWaitingFor(conversationId: string, agentId: string, waitingFor: string[]): void {
    const instance = this.get(conversationId, agentId);
    if (instance) {
      instance.waitingFor = new Set(waitingFor);
    }
  }

  /** Clear waiting status */
  clearWaitingFor(conversationId: string, agentId: string): void {
    const instance = this.get(conversationId, agentId);
    if (instance) {
      instance.waitingFor = undefined;
    }
  }

  /** Update agent heartbeat (call when agent performs activity) */
  heartbeat(conversationId: string, agentId: string): void {
    const instance = this.get(conversationId, agentId);
    if (instance) {
      instance.lastActivityAt = Date.now();
    }
  }

  /** Get all stale agents (no activity for specified duration) */
  getStaleAgents(staleThresholdMs: number = 5 * 60 * 1000): Array<{ conversationId: string; agentId: string; lastActivityMs: number }> {
    const stale: Array<{ conversationId: string; agentId: string; lastActivityMs: number }> = [];
    const now = Date.now();

    for (const [conversationId, convMap] of this.pool.entries()) {
      for (const [agentId, instance] of convMap.entries()) {
        const lastActivity = now - instance.lastActivityAt;
        if (lastActivity > staleThresholdMs) {
          stale.push({ conversationId, agentId, lastActivityMs: lastActivity });
        }
      }
    }

    return stale;
  }

  /** Get pool health metrics */
  getMetrics(): PoolMetrics {
    let totalAgents = 0;
    let agentsWithWaiters = 0;
    let totalQueuedMessages = 0;
    let oldestAgentMs = 0;
    let staleAgents = 0;
    const now = Date.now();
    const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

    for (const convMap of this.pool.values()) {
      for (const instance of convMap.values()) {
        totalAgents++;
        if (instance.mailbox.hasWaiter()) {
          agentsWithWaiters++;
        }
        totalQueuedMessages += instance.mailbox.getQueueDepth();
        const age = now - instance.registeredAt;
        if (age > oldestAgentMs) {
          oldestAgentMs = age;
        }
        // Check for stale agents (no activity for 5+ minutes)
        const lastActivity = now - instance.lastActivityAt;
        if (lastActivity > STALE_THRESHOLD_MS) {
          staleAgents++;
        }
      }
    }

    return {
      totalAgents,
      totalConversations: this.pool.size,
      agentsWithWaiters,
      totalQueuedMessages,
      oldestAgentMs,
      staleAgents,
    };
  }
}

// Singleton, survives HMR in dev
const globalForPool = globalThis as unknown as { agentPool: AgentPool };
export const agentPool = globalForPool.agentPool || new AgentPool();
if (process.env.NODE_ENV !== "production") globalForPool.agentPool = agentPool;
