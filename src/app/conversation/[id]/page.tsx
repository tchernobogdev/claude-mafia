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
  read_file: "Read file",
  write_file: "Wrote file",
  list_files: "Listed files",
  run_command: "Ran command",
};

function parseMetadata(meta: string | null): Record<string, unknown> | null {
  if (!meta) return null;
  try { return JSON.parse(meta); } catch { return null; }
}

export default function ConversationPage() {
  const params = useParams();
  const router = useRouter();
  const conversationId = params.id as string;

  const [messages, setMessages] = useState<Message[]>([]);
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState("active");
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);

  // Follow-up chat state
  const [followUp, setFollowUp] = useState("");
  const [followUpImages, setFollowUpImages] = useState<{ type: "base64"; media_type: string; data: string; name: string }[]>([]);
  const [sending, setSending] = useState(false);
  const followUpFileRef = useRef<HTMLInputElement>(null);

  // Step-through state
  const [stepIndex, setStepIndex] = useState(-1);
  const [isStepMode, setIsStepMode] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const activityBottomRef = useRef<HTMLDivElement>(null);

  const activityLoadedRef = useRef(false);

  const loadConversation = useCallback(() => {
    fetch(`/api/conversations/${conversationId}`)
      .then((r) => r.json())
      .then((data) => {
        const allMessages: Message[] = data.messages || [];
        // Separate activity messages from display messages
        const displayMessages = allMessages.filter((m: Message) => m.role !== "activity");
        setMessages(displayMessages);
        setEscalations(data.escalations || []);
        setStatus(data.status);
        if (data.workingDirectory) setWorkingDirectory(data.workingDirectory);

        // Reconstruct activity feed from persisted activity messages (only on first load)
        if (!activityLoadedRef.current) {
          activityLoadedRef.current = true;
          const activityMessages = allMessages.filter((m: Message) => m.role === "activity");
          if (activityMessages.length > 0) {
            const restored: ActivityItem[] = activityMessages.map((m: Message) => {
              const meta = parseMetadata(m.metadata) || {};
              const eventType = meta.eventType as string;
              let type: ActivityItem["type"] = "message";
              if (eventType === "agent_start") type = "start";
              else if (eventType === "agent_message") type = "message";
              else if (eventType === "tool_call") type = "tool";
              else if (eventType === "escalation") type = "escalation";
              else if (eventType === "agent_done") type = "done";
              else return null;
              return {
                id: m.id,
                type,
                agentName: meta.agentName as string | undefined,
                agentRole: meta.role as string | undefined,
                content: (meta.content || meta.task || meta.question) as string | undefined,
                tool: meta.tool as string | undefined,
                toolInput: meta.input as Record<string, unknown> | undefined,
                timestamp: new Date(m.createdAt).getTime(),
              };
            }).filter((a): a is ActivityItem => a !== null);
            setActivity(restored);
          }
        }
      });
  }, [conversationId]);

  useEffect(() => {
    loadConversation();
    const interval = setInterval(loadConversation, 3000);
    return () => clearInterval(interval);
  }, [loadConversation]);

  // SSE connection
  useEffect(() => {
    const evtSource = new EventSource(`/api/stream/${conversationId}`);

    evtSource.addEventListener("agent_message", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setActivity((prev) => [...prev, { id: crypto.randomUUID(), type: "message", agentName: data.agentName, content: data.content, timestamp: Date.now() }]);
      loadConversation();
    });

    evtSource.addEventListener("agent_start", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setActivity((prev) => [...prev, { id: crypto.randomUUID(), type: "start", agentName: data.agentName, agentRole: data.role, content: data.task, timestamp: Date.now() }]);
    });

    evtSource.addEventListener("agent_done", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setActivity((prev) => [...prev, { id: crypto.randomUUID(), type: "done", agentName: data.agentName, timestamp: Date.now() }]);
    });

    evtSource.addEventListener("tool_call", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setActivity((prev) => [...prev, { id: crypto.randomUUID(), type: "tool", agentName: data.agentName, tool: data.tool, toolInput: data.input, timestamp: Date.now() }]);
    });

    evtSource.addEventListener("escalation", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setActivity((prev) => [...prev, { id: crypto.randomUUID(), type: "escalation", agentName: data.agentName, content: data.question, timestamp: Date.now() }]);
      setEscalations((prev) => [...prev, { id: data.escalationId!, question: data.question!, status: "pending" }]);
    });

    evtSource.addEventListener("escalation_answered", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setEscalations((prev) => prev.filter((esc) => esc.id !== data.escalationId));
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
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); setStepIndex((prev) => Math.min(prev + 1, activity.length - 1)); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); setStepIndex((prev) => Math.max(prev - 1, 0)); }
      else if (e.key === "Home") setStepIndex(0);
      else if (e.key === "End") setStepIndex(activity.length - 1);
      else if (e.key === "Escape") { setIsStepMode(false); setStepIndex(-1); }
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

  const addFollowUpImages = (files: File[]) => {
    files.forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const [header, data] = dataUrl.split(",");
        const media_type = header.match(/:(.*?);/)?.[1] || "image/png";
        setFollowUpImages((prev) => [...prev, { type: "base64", media_type, data, name: file.name }]);
      };
      reader.readAsDataURL(file);
    });
  };

  const sendFollowUp = async () => {
    if (!followUp.trim() || sending) return;
    setSending(true);
    try {
      const payload: Record<string, unknown> = { message: followUp };
      if (followUpImages.length > 0) {
        payload.images = followUpImages.map(({ type, media_type, data }) => ({ type, media_type, data }));
      }
      await fetch(`/api/conversations/${conversationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setFollowUp("");
      setFollowUpImages([]);
      setStatus("active");
      loadConversation();
    } finally {
      setSending(false);
    }
  };

  const enterStepMode = () => { setIsStepMode(true); setStepIndex(0); };
  const exitStepMode = () => { setIsStepMode(false); setStepIndex(-1); };

  const visibleActivity = isStepMode ? activity.slice(0, stepIndex + 1) : activity;
  const currentStep = isStepMode && stepIndex >= 0 ? activity[stepIndex] : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <a href="/" className="text-xs text-text-muted hover:text-text mb-1 block">&larr; Dashboard</a>
          <h1 className="text-xl font-bold">Operation</h1>
          {workingDirectory && (
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">DIR</span>
              <span className="text-[10px] text-text-muted font-mono">{workingDirectory}</span>
            </div>
          )}
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
                isStepMode ? "bg-accent text-white border-accent" : "border-border text-text-muted hover:text-text hover:border-accent"
              }`}
            >
              {isStepMode ? "Exit Step-Through" : "Step-Through Replay"}
            </button>
          )}
          <span className={`text-xs px-2 py-0.5 rounded ${status === "active" ? "bg-accent/20 text-accent" : status === "completed" ? "bg-success/20 text-success" : "bg-border text-text-muted"}`}>
            {status}
          </span>
        </div>
      </div>

      {/* Step-through controls */}
      {isStepMode && (
        <div className="bg-bg-card border border-accent/30 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-muted">Step {stepIndex + 1} of {activity.length}</span>
            <div className="flex items-center gap-1">
              <button onClick={() => setStepIndex(0)} disabled={stepIndex <= 0} className="text-xs px-2 py-1 rounded bg-bg border border-border disabled:opacity-30 hover:border-accent transition-colors">&#x23EE; First</button>
              <button onClick={() => setStepIndex(Math.max(0, stepIndex - 1))} disabled={stepIndex <= 0} className="text-xs px-2 py-1 rounded bg-bg border border-border disabled:opacity-30 hover:border-accent transition-colors">&#x25C0; Prev</button>
              <button onClick={() => setStepIndex(Math.min(activity.length - 1, stepIndex + 1))} disabled={stepIndex >= activity.length - 1} className="text-xs px-2 py-1 rounded bg-bg border border-border disabled:opacity-30 hover:border-accent transition-colors">Next &#x25B6;</button>
              <button onClick={() => setStepIndex(activity.length - 1)} disabled={stepIndex >= activity.length - 1} className="text-xs px-2 py-1 rounded bg-bg border border-border disabled:opacity-30 hover:border-accent transition-colors">Last &#x23ED;</button>
            </div>
          </div>
          <input type="range" min={0} max={Math.max(0, activity.length - 1)} value={stepIndex} onChange={(e) => setStepIndex(parseInt(e.target.value))} className="w-full h-1 appearance-none bg-border rounded cursor-pointer accent-accent" />
          {currentStep && (
            <div className="bg-bg rounded p-3 border border-border">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-accent text-xs font-medium">{currentStep.agentName}</span>
                <StepTypeBadge type={currentStep.type} tool={currentStep.tool} />
              </div>
              {currentStep.type === "start" && <p className="text-sm text-text-muted">Received task: {currentStep.content}</p>}
              {currentStep.type === "message" && <p className="text-sm whitespace-pre-wrap">{currentStep.content}</p>}
              {currentStep.type === "tool" && (
                <div>
                  <p className="text-sm">{TOOL_LABELS[currentStep.tool || ""] || currentStep.tool}</p>
                  {currentStep.toolInput && <pre className="text-xs text-text-muted mt-1 bg-bg-card p-2 rounded overflow-x-auto">{JSON.stringify(currentStep.toolInput, null, 2)}</pre>}
                </div>
              )}
              {currentStep.type === "escalation" && <p className="text-sm text-danger">{currentStep.content}</p>}
              {currentStep.type === "done" && <p className="text-sm text-success">Completed work</p>}
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
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer, Boss..." className="flex-1 bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent" onKeyDown={(e) => { if (e.key === "Enter") submitAnswer(esc.id); }} />
            <button onClick={() => submitAnswer(esc.id)} className="bg-accent hover:bg-accent-hover text-white text-sm px-4 py-1.5 rounded transition-colors">Answer</button>
          </div>
        </div>
      ))}

      <div className="grid grid-cols-3 gap-4">
        {/* Messages */}
        <div className="col-span-2 bg-bg-card border border-border rounded-lg flex flex-col max-h-[70vh]">
          <div className="p-4 flex-1 overflow-y-auto">
            <h2 className="text-xs text-text-muted font-medium mb-3">Messages</h2>
            <div className="space-y-3">
              {messages.map((msg) => {
                const meta = parseMetadata(msg.metadata);
                const msgImages = meta?.images as { type: string; media_type: string; data: string }[] | undefined;
                const msgWorkDir = meta?.workingDirectory as string | undefined;

                return (
                  <div key={msg.id} className={`text-sm ${msg.agentId ? "" : "bg-bg-hover rounded px-3 py-2"}`}>
                    <div className="flex items-center gap-2 text-xs mb-0.5">
                      {msg.agent ? (
                        <>
                          <span style={{ color: ROLE_COLORS[msg.agent.role] || "#6a6a7a" }}>{msg.agent.name}</span>
                          <span className="text-text-muted">({msg.agent.role})</span>
                        </>
                      ) : (
                        <span className="text-accent font-medium">Boss</span>
                      )}
                    </div>
                    {/* Working directory badge on user messages */}
                    {msgWorkDir && (
                      <div className="flex items-center gap-1 mb-1">
                        <span className="text-[10px] px-1 py-0.5 rounded bg-accent/10 text-accent">DIR</span>
                        <span className="text-[10px] text-text-muted font-mono">{msgWorkDir}</span>
                      </div>
                    )}
                    {/* Attached images */}
                    {msgImages && msgImages.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-1.5">
                        {msgImages.map((img, i) => (
                          <img key={i} src={`data:${img.media_type};base64,${img.data}`} alt="attachment" className="h-20 rounded border border-border object-cover" />
                        ))}
                      </div>
                    )}
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
          </div>

          {/* Follow-up input */}
          <div className="border-t border-border p-3 space-y-2">
            {followUpImages.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {followUpImages.map((img, i) => (
                  <div key={i} className="relative group">
                    <img src={`data:${img.media_type};base64,${img.data}`} alt={img.name} className="h-12 w-12 object-cover rounded border border-border" />
                    <button onClick={() => setFollowUpImages((prev) => prev.filter((_, j) => j !== i))} className="absolute -top-1 -right-1 bg-danger text-white text-[9px] w-3.5 h-3.5 rounded-full leading-none opacity-0 group-hover:opacity-100 transition-opacity">&times;</button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                ref={followUpFileRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                multiple
                onChange={(e) => { if (e.target.files) addFollowUpImages(Array.from(e.target.files)); e.target.value = ""; }}
                className="hidden"
              />
              <button type="button" onClick={() => followUpFileRef.current?.click()} className="text-text-muted hover:text-text border border-border hover:border-accent px-2 py-1.5 rounded transition-colors text-xs" title="Attach image">
                +
              </button>
              <input
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
                placeholder="Follow up with the crew..."
                className="flex-1 bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
                disabled={status === "active" && sending}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendFollowUp(); } }}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.items).filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((f): f is File => f !== null);
                  if (files.length > 0) addFollowUpImages(files);
                }}
              />
              <button
                onClick={sendFollowUp}
                disabled={!followUp.trim() || sending}
                className="bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-sm px-4 py-1.5 rounded transition-colors"
              >
                {sending ? "..." : "Send"}
              </button>
            </div>
          </div>
        </div>

        {/* Activity Feed */}
        <div className="bg-bg-card border border-border rounded-lg p-4 max-h-[70vh] overflow-y-auto">
          <h2 className="text-xs text-text-muted font-medium mb-3">
            Activity {isStepMode && `(${stepIndex + 1}/${activity.length})`}
          </h2>
          <div className="space-y-1.5">
            {visibleActivity.length === 0 && <p className="text-xs text-text-muted">Waiting for activity...</p>}
            {visibleActivity.map((item, i) => {
              const isCurrentStep = isStepMode && i === stepIndex;
              return (
                <div
                  key={item.id}
                  className={`text-xs p-1.5 rounded transition-colors cursor-pointer ${isCurrentStep ? "bg-accent/10 border border-accent/30" : "hover:bg-bg-hover"}`}
                  onClick={() => { if (isStepMode) setStepIndex(i); }}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-accent">{item.agentName}</span>
                    <StepTypeBadge type={item.type} tool={item.tool} />
                  </div>
                  {item.type === "message" && <p className="text-text-muted mt-0.5 truncate">{item.content}</p>}
                  {item.type === "start" && <p className="text-text-muted mt-0.5 truncate">Task: {item.content}</p>}
                  {item.type === "tool" && item.toolInput && <p className="text-text-muted mt-0.5 truncate">{JSON.stringify(item.toolInput).slice(0, 80)}</p>}
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
    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: `${label.color}20`, color: label.color }}>
      {label.text}
    </span>
  );
}
