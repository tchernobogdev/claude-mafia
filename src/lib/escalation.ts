type Resolver = (answer: string) => void;

class EscalationManager {
  private pending = new Map<string, Resolver>();

  waitForAnswer(escalationId: string): Promise<string> {
    return new Promise((resolve) => {
      this.pending.set(escalationId, resolve);
    });
  }

  resolveAnswer(escalationId: string, answer: string): boolean {
    const resolver = this.pending.get(escalationId);
    if (resolver) {
      resolver(answer);
      this.pending.delete(escalationId);
      return true;
    }
    return false;
  }

  hasPending(escalationId: string): boolean {
    return this.pending.has(escalationId);
  }
}

const globalForEsc = globalThis as unknown as { escalationManager: EscalationManager };
export const escalationManager =
  globalForEsc.escalationManager || new EscalationManager();
if (process.env.NODE_ENV !== "production")
  globalForEsc.escalationManager = escalationManager;
