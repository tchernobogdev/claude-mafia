"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";

interface Message {
  id: string;
  agentId: string | null;
  role: string;
  content: string;
  metadata: string | null;
  createdAt: string;
  agent: { name: string; role: string } | null;
}

interface Escalation {
  id: string;
  question: string;
  status: string;
}

interface SSEEvent {
  agentId?: string;
  agentName?: string;
  content?: string;
  role?: string;
  task?: string;
  tool?: string;
  input?: Record<string, unknown>;
  question?: string;
  escalationId?: string;
  result?: string;
}

interface ActivityItem {
  id: string;
  type: "start" | "message" | "tool" | "escalation" | "done";
  agentName?: string;
  agentRole?: string;
  content?: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  timestamp: number;
}

const ROLE_COLORS: Record<string, string> = {
  underboss: "#8b5cf6",
  capo: "#facc15",
  soldier: "#6a6a7a",
};

const TOOL_LABELS: Record<string, string> = {
  delegate_task: "Delegated",
  ask_agent: "Asked",
  review_work: "Sent for review",
  summarize_for: "Summarized",
  escalate_to_boss: "Escalated to Boss",
};

export default function ConversationPage() {
  const params = useParams();
  const router = useRouter();
  const conversationId = params.id as string;

  const [messages, setMessages] = useState<Message[]>([]);
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState("active");

  // Step-through state
  const [stepIndex, setStepIndex] = useState(-1); // -1 = show all (live mode)
  const [isStepMode, setIsStepMode] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const activityBottomRef = useRef<HTMLDivElement>(null);

  const loadConversation = useCallback(() => {
    fetch(`/api/conversations/${conversationId}`)
      .then((r) => r.json())
      .then((data) => {
        setMessages(data.messages || []);
        setEscalations(data.escalations || []);
        setStatus(data.status);
      });
  }, [conversationId]);

  useEffect(() => {
    loadConversation();
    // Poll for new messages every 3s so the Messages panel stays current
    // even if the SSE connection drops or misses events
    const interval = setInterval(loadConversation, 3000);
    return () => clearInterval(interval);
  }, [loadConversation]);

  // SSE connection
  useEffect(() => {
    const evtSource = new EventSource(`/api/stream/${conversationId}`);

    evtSource.addEventListener("agent_message", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setActivity((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          type: "message",
          agentName: data.agentName,
          content: data.content,
          timestamp: Date.now(),
        },
      ]);
      loadConversation();
    });

    evtSource.addEventListener("agent_start", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setActivity((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          type: "start",
          agentName: data.agentName,
          agentRole: data.role,
          content: data.task,
          timestamp: Date.now(),
        },
      ]);
    });

    evtSource.addEventListener("agent_done", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setActivity((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          type: "done",
          agentName: data.agentName,
          timestamp: Date.now(),
        },
      ]);
    });

    evtSource.addEventListener("tool_call", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setActivity((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          type: "tool",
          agentName: data.agentName,
          tool: data.tool,
          toolInput: data.input,
          timestamp: Date.now(),
        },
      ]);
    });

    evtSource.addEventListener("escalation", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setActivity((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          type: "escalation",
          agentName: data.agentName,
          content: data.question,
          timestamp: Date.now(),
        },
      ]);
      setEscalations((prev) => [
        ...prev,
        { id: data.escalationId!, question: data.question!, status: "pending" },
      ]);
    });

    evtSource.addEventListener("escalation_answered", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setEscalations((prev) =>
        prev.filter((esc) => esc.id !== data.escalationId)
      );
    });

    evtSource.addEventListener("task_complete", () => {
      setStatus("completed");
      loadConversation();
    });

    return () => evtSource.close();
  }, [conversationId, loadConversation]);

  // Auto-scroll in live mode
  useEffect(() => {
    if (!isStepMode) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      activityBottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [activity, messages, isStepMode]);

  // Keyboard handler for step-through
  useEffect(() => {
    if (!isStepMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setStepIndex((prev) => Math.min(prev + 1, activity.length - 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setStepIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Home") {
        setStepIndex(0);
      } else if (e.key === "End") {
        setStepIndex(activity.length - 1);
      } else if (e.key === "Escape") {
        setIsStepMode(false);
        setStepIndex(-1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isStepMode, activity.length]);

  const submitAnswer = async (escalationId: string) => {
    if (!answer.trim()) return;
    await fetch(`/api/escalations/${escalationId}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    });
    setAnswer("");
  };

  const enterStepMode = () => {
    setIsStepMode(true);
    setStepIndex(0);
  };

  const exitStepMode = () => {
    setIsStepMode(false);
    setStepIndex(-1);
  };

  // Visible activity based on step mode
  const visibleActivity = isStepMode
    ? activity.slice(0, stepIndex + 1)
    : activity;

  const currentStep = isStepMode && stepIndex >= 0 ? activity[stepIndex] : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <a href="/" className="text-xs text-text-muted hover:text-text mb-1 block">&larr; Dashboard</a>
          <h1 className="text-xl font-bold">Operation</h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={async () => {
              if (!confirm("Delete this operation?")) return;
              await fetch(`/api/conversations/${conversationId}`, { method: "DELETE" });
              router.push("/");
            }}
            className="text-danger text-xs hover:bg-danger/10 px-3 py-1.5 rounded border border-danger/30 transition-colors"
          >
            Delete
          </button>
          {status === "completed" && (
            <a
              href={`/conversation/${conversationId}/report`}
              className="text-xs px-3 py-1.5 rounded border border-accent text-accent hover:bg-accent hover:text-white transition-colors"
            >
              View Report
            </a>
          )}
          {status === "completed" && activity.length > 0 && (
            <button
              onClick={isStepMode ? exitStepMode : enterStepMode}
              className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                isStepMode
                  ? "bg-accent text-white border-accent"
                  : "border-border text-text-muted hover:text-text hover:border-accent"
              }`}
            >
              {isStepMode ? "Exit Step-Through" : "Step-Through Replay"}
            </button>
          )}
          <span
            className={`text-xs px-2 py-0.5 rounded ${
              status === "active"
                ? "bg-accent/20 text-accent"
                : "bg-success/20 text-success"
            }`}
          >
            {status}
          </span>
        </div>
      </div>

      {/* Step-through controls */}
      {isStepMode && (
        <div className="bg-bg-card border border-accent/30 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-muted">
              Step {stepIndex + 1} of {activity.length}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setStepIndex(0)}
                disabled={stepIndex <= 0}
                className="text-xs px-2 py-1 rounded bg-bg border border-border disabled:opacity-30 hover:border-accent transition-colors"
              >
                &#x23EE; First
              </button>
              <button
                onClick={() => setStepIndex(Math.max(0, stepIndex - 1))}
                disabled={stepIndex <= 0}
                className="text-xs px-2 py-1 rounded bg-bg border border-border disabled:opacity-30 hover:border-accent transition-colors"
              >
                &#x25C0; Prev
              </button>
              <button
                onClick={() => setStepIndex(Math.min(activity.length - 1, stepIndex + 1))}
                disabled={stepIndex >= activity.length - 1}
                className="text-xs px-2 py-1 rounded bg-bg border border-border disabled:opacity-30 hover:border-accent transition-colors"
              >
                Next &#x25B6;
              </button>
              <button
                onClick={() => setStepIndex(activity.length - 1)}
                disabled={stepIndex >= activity.length - 1}
                className="text-xs px-2 py-1 rounded bg-bg border border-border disabled:opacity-30 hover:border-accent transition-colors"
              >
                Last &#x23ED;
              </button>
            </div>
          </div>
          {/* Scrubber bar */}
          <input
            type="range"
            min={0}
            max={Math.max(0, activity.length - 1)}
            value={stepIndex}
            onChange={(e) => setStepIndex(parseInt(e.target.value))}
            className="w-full h-1 appearance-none bg-border rounded cursor-pointer accent-accent"
          />
          {/* Current step detail */}
          {currentStep && (
            <div className="bg-bg rounded p-3 border border-border">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-accent text-xs font-medium">{currentStep.agentName}</span>
                <StepTypeBadge type={currentStep.type} tool={currentStep.tool} />
              </div>
              {currentStep.type === "start" && (
                <p className="text-sm text-text-muted">Received task: {currentStep.content}</p>
              )}
              {currentStep.type === "message" && (
                <p className="text-sm whitespace-pre-wrap">{currentStep.content}</p>
              )}
              {currentStep.type === "tool" && (
                <div>
                  <p className="text-sm">{TOOL_LABELS[currentStep.tool || ""] || currentStep.tool}</p>
                  {currentStep.toolInput && (
                    <pre className="text-xs text-text-muted mt-1 bg-bg-card p-2 rounded overflow-x-auto">
                      {JSON.stringify(currentStep.toolInput, null, 2)}
                    </pre>
                  )}
                </div>
              )}
              {currentStep.type === "escalation" && (
                <p className="text-sm text-danger">{currentStep.content}</p>
              )}
              {currentStep.type === "done" && (
                <p className="text-sm text-success">Completed work</p>
              )}
            </div>
          )}
          <p className="text-[10px] text-text-muted">Arrow keys to navigate &middot; Home/End for first/last &middot; Esc to exit</p>
        </div>
      )}

      {/* Escalation Banner */}
      {escalations.filter((e) => e.status === "pending").map((esc) => (
        <div key={esc.id} className="bg-danger/10 border border-danger/30 rounded-lg p-4 space-y-2">
          <div className="text-sm font-medium text-danger">Escalation - Your input needed</div>
          <p className="text-sm">{esc.question}</p>
          <div className="flex gap-2">
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Your answer, Boss..."
              className="flex-1 bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAnswer(esc.id);
              }}
            />
            <button
              onClick={() => submitAnswer(esc.id)}
              className="bg-accent hover:bg-accent-hover text-white text-sm px-4 py-1.5 rounded transition-colors"
            >
              Answer
            </button>
          </div>
        </div>
      ))}

      <div className="grid grid-cols-3 gap-4">
        {/* Messages */}
        <div className="col-span-2 bg-bg-card border border-border rounded-lg p-4 max-h-[70vh] overflow-y-auto">
          <h2 className="text-xs text-text-muted font-medium mb-3">Messages</h2>
          <div className="space-y-3">
            {messages.map((msg) => (
              <div key={msg.id} className={`text-sm ${msg.agentId ? "" : "bg-bg-hover rounded px-3 py-2"}`}>
                <div className="flex items-center gap-2 text-xs mb-0.5">
                  {msg.agent ? (
                    <>
                      <span style={{ color: ROLE_COLORS[msg.agent.role] || "#6a6a7a" }}>
                        {msg.agent.name}
                      </span>
                      <span className="text-text-muted">({msg.agent.role})</span>
                    </>
                  ) : (
                    <span className="text-accent font-medium">Boss</span>
                  )}
                </div>
                <div className="whitespace-pre-wrap">{msg.content}</div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Activity Feed */}
        <div className="bg-bg-card border border-border rounded-lg p-4 max-h-[70vh] overflow-y-auto">
          <h2 className="text-xs text-text-muted font-medium mb-3">
            Activity {isStepMode && `(${stepIndex + 1}/${activity.length})`}
          </h2>
          <div className="space-y-1.5">
            {visibleActivity.length === 0 && (
              <p className="text-xs text-text-muted">Waiting for activity...</p>
            )}
            {visibleActivity.map((item, i) => {
              const isCurrentStep = isStepMode && i === stepIndex;
              return (
                <div
                  key={item.id}
                  className={`text-xs p-1.5 rounded transition-colors cursor-pointer ${
                    isCurrentStep
                      ? "bg-accent/10 border border-accent/30"
                      : "hover:bg-bg-hover"
                  }`}
                  onClick={() => {
                    if (isStepMode) setStepIndex(i);
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-accent">{item.agentName}</span>
                    <StepTypeBadge type={item.type} tool={item.tool} />
                  </div>
                  {item.type === "message" && (
                    <p className="text-text-muted mt-0.5 truncate">{item.content}</p>
                  )}
                  {item.type === "start" && (
                    <p className="text-text-muted mt-0.5 truncate">Task: {item.content}</p>
                  )}
                  {item.type === "tool" && item.toolInput && (
                    <p className="text-text-muted mt-0.5 truncate">
                      {JSON.stringify(item.toolInput).slice(0, 80)}
                    </p>
                  )}
                </div>
              );
            })}
            <div ref={activityBottomRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

function StepTypeBadge({ type, tool }: { type: string; tool?: string }) {
  const labels: Record<string, { text: string; color: string }> = {
    start: { text: "started", color: "#3b82f6" },
    message: { text: "response", color: "#22c55e" },
    tool: { text: tool ? TOOL_LABELS[tool] || tool : "tool", color: "#f59e0b" },
    escalation: { text: "escalated", color: "#ef4444" },
    done: { text: "done", color: "#22c55e" },
  };
  const label = labels[type] || { text: type, color: "#6a6a7a" };
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded"
      style={{ backgroundColor: `${label.color}20`, color: label.color }}
    >
      {label.text}
    </span>
  );
}

