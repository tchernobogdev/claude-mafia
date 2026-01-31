import { NextRequest } from "next/server";
import { sseManager } from "@/lib/sse";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const { conversationId } = await params;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      // Send heartbeat
      send("connected", { conversationId });

      const unsubscribe = sseManager.subscribe(conversationId, send);

      // Heartbeat every 30s
      const interval = setInterval(() => {
        try {
          send("heartbeat", {});
        } catch {
          clearInterval(interval);
          unsubscribe();
        }
      }, 30000);

      // Cleanup on close
      _req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        unsubscribe();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
