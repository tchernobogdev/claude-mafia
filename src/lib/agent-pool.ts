/**
 * Agent Pool — persistent agent instances that stay alive for the duration of a job.
 *
 * Agents are registered when spawned and remain in the pool after completing their
 * primary task, waiting for follow-up questions via a mailbox. The pool is shut down
 * when the job (conversation) ends.
 */

interface MailboxMessage {
  id: string;
  content: string;
  resolve: (response: string) => void;
}

export class AgentMailbox {
  private queue: MailboxMessage[] = [];
  private waiter: ((msg: MailboxMessage) => void) | null = null;

  /** Send a message to this agent. Returns a promise that resolves when the agent responds. */
  send(id: string, content: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const msg: MailboxMessage = { id, content, resolve };
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  /** Wait for the next message. Returns immediately if one is queued, else blocks. */
  receive(): Promise<MailboxMessage> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }
    return new Promise<MailboxMessage>((resolve) => {
      this.waiter = resolve;
    });
  }

  /** Unblock any waiting receive() with a shutdown sentinel. */
  shutdown(): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ id: "__shutdown__", content: "__shutdown__", resolve: () => {} });
    }
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
}

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
    convMap.set(instance.agentId, instance);
  }

  remove(conversationId: string, agentId: string): void {
    this.pool.get(conversationId)?.delete(agentId);
  }

  /** Shut down all agents for a conversation. */
  shutdownConversation(conversationId: string): void {
    const convMap = this.pool.get(conversationId);
    if (!convMap) return;
    for (const instance of convMap.values()) {
      instance.mailbox.shutdown();
      instance.abortController.abort();
    }
    this.pool.delete(conversationId);
  }

  isRunning(conversationId: string, agentId: string): boolean {
    return !!this.pool.get(conversationId)?.has(agentId);
  }
}

// Singleton, survives HMR in dev
const globalForPool = globalThis as unknown as { agentPool: AgentPool };
export const agentPool = globalForPool.agentPool || new AgentPool();
if (process.env.NODE_ENV !== "production") globalForPool.agentPool = agentPool;
