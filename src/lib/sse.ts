type Listener = (event: string, data: unknown) => void;

class SSEManager {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(conversationId: string, listener: Listener) {
    if (!this.listeners.has(conversationId)) {
      this.listeners.set(conversationId, new Set());
    }
    this.listeners.get(conversationId)!.add(listener);
    return () => {
      this.listeners.get(conversationId)?.delete(listener);
    };
  }

  emit(conversationId: string, event: string, data: unknown) {
    this.listeners.get(conversationId)?.forEach((fn) => fn(event, data));
  }
}

const globalForSSE = globalThis as unknown as { sseManager: SSEManager };
export const sseManager =
  globalForSSE.sseManager || new SSEManager();
if (process.env.NODE_ENV !== "production") globalForSSE.sseManager = sseManager;
