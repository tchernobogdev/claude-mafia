"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { ActivityTree, type TreeActivityItem } from "../../../components/activity-tree";
import { CodeExecutionPanel, type CodeExecutionResult, parseCompilationErrors } from "../../../components/code-execution-panel";

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
  targetAgents?: TargetAgent[];
}

interface TargetAgent {
  id: string;
  name: string;
  role: string;
}

interface ActivityItem {
  id: string;
  type: "start" | "message" | "tool" | "tool_result" | "escalation" | "done";
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  content?: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  targetAgents?: TargetAgent[];
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
  submit_result: "Submitted result",
  wait_for_messages: "Waiting for messages",
  respond_to_message: "Responded",
  escalate_to_boss: "Escalated to Boss",
  read_file: "Read file",
  write_file: "Wrote file",
  list_files: "Listed files",
  run_command: "Ran command",
  // Tester-specific tools
  execute_code: "Executed code",
  run_build: "Built project",
  open_browser: "Opened browser",
  run_tests: "Ran tests",
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
  const [error, setError] = useState<string | null>(null);

  // Follow-up chat state
  const [followUp, setFollowUp] = useState("");
  const [followUpImages, setFollowUpImages] = useState<{ type: "base64"; media_type: string; data: string; name: string }[]>([]);
  const [sending, setSending] = useState(false);
  const followUpFileRef = useRef<HTMLInputElement>(null);

  // Step-through state
  const [stepIndex, setStepIndex] = useState(-1);
  const [isStepMode, setIsStepMode] = useState(false);

  // Dynamic org state
  const [isDynamicOrg, setIsDynamicOrg] = useState(false);
  const [exportCopied, setExportCopied] = useState(false);

  // Activity detail panel
  const [selectedActivity, setSelectedActivity] = useState<ActivityItem | null>(null);

  // Activity view mode: list or tree
  const [activityView, setActivityView] = useState<"list" | "tree">("list");

  // Tester agent execution results
  const [executionResults, setExecutionResults] = useState<CodeExecutionResult[]>([]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const activityBottomRef = useRef<HTMLDivElement>(null);

  const activityLoadedRef = useRef(false);

  const loadConversation = useCallback(async () => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
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
          const restored = activityMessages.map((m: Message): ActivityItem | null => {
            const meta = parseMetadata(m.metadata) || {};
            const eventType = meta.eventType as string;
            let type: ActivityItem["type"] = "message";
            if (eventType === "agent_start") type = "start";
            else if (eventType === "agent_message") type = "message";
            else if (eventType === "tool_call") type = "tool";
            else if (eventType === "tool_result") type = "tool_result";
            else if (eventType === "escalation") type = "escalation";
            else if (eventType === "agent_done") type = "done";
            else return null;
            return {
              id: m.id,
              type,
              agentId: meta.agentId as string | undefined,
              agentName: meta.agentName as string | undefined,
              agentRole: meta.role as string | undefined,
              content: (meta.content || meta.task || meta.question) as string | undefined,
              tool: meta.tool as string | undefined,
              toolInput: meta.input as Record<string, unknown> | undefined,
              toolResult: meta.result as string | undefined,
              targetAgents: meta.targetAgents as TargetAgent[] | undefined,
              timestamp: new Date(m.createdAt).getTime(),
            };
          }).filter((a): a is ActivityItem => a !== null);
          setActivity(restored);
        }
      }
    } catch (err) {
      console.error("LoadConversation:", err);
      // Only set error on initial load failure, not on polling failures
      if (!activityLoadedRef.current) {
        setError("Failed to load conversation. Please try again.");
      }
    }
  }, [conversationId]);

  useEffect(() => {
    loadConversation();
    // Stop polling if conversation is completed or stopped
    if (status === "completed" || status === "stopped") {
      return; // No polling needed for finished conversations
    }
    const interval = setInterval(loadConversation, 3000);
    return () => clearInterval(interval);
  }, [loadConversation, status]);

  // Check if this conversation used dynamic organization
  useEffect(() => {
    fetch(`/api/conversations/${conversationId}/org`)
      .then((res) => res.json())
      .then((data) => { if (data.dynamic) setIsDynamicOrg(true); })
      .catch(() => {});
  }, [conversationId]);

  // SSE connection
  useEffect(() => {
    const evtSource = new EventSource(`/api/stream/${conversationId}`);

    evtSource.addEventListener("agent_message", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setActivity((prev) => [...prev, { id: crypto.randomUUID(), type: "message", agentId: data.agentId, agentName: data.agentName, content: data.content, timestamp: Date.now() }]);
      loadConversation();
    });

    evtSource.addEventListener("agent_start", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setActivity((prev) => [...prev, { id: crypto.randomUUID(), type: "start", agentId: data.agentId, agentName: data.agentName, agentRole: data.role, content: data.task, timestamp: Date.now() }]);
    });

    evtSource.addEventListener("agent_done", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setActivity((prev) => [...prev, { id: crypto.randomUUID(), type: "done", agentId: data.agentId, agentName: data.agentName, timestamp: Date.now() }]);
    });

    evtSource.addEventListener("tool_call", (e) => {
      const data = JSON.parse(e.data);
      setActivity((prev) => [...prev, { id: crypto.randomUUID(), type: "tool", agentId: data.agentId, agentName: data.agentName, tool: data.tool, toolInput: data.input, targetAgents: data.targetAgents, timestamp: Date.now() }]);
    });

    evtSource.addEventListener("tool_result", (e) => {
      const data = JSON.parse(e.data);
      setActivity((prev) => [...prev, { id: crypto.randomUUID(), type: "tool_result", agentId: data.agentId, agentName: data.agentName, tool: data.tool, toolResult: data.result, timestamp: Date.now() }]);
    });

    evtSource.addEventListener("escalation", (e) => {
      const data: SSEEvent = JSON.parse(e.data);
      setActivity((prev) => [...prev, { id: crypto.randomUUID(), type: "escalation", agentId: data.agentId, agentName: data.agentName, content: data.question, timestamp: Date.now() }]);
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

    evtSource.addEventListener("task_stopped", () => {
      setStatus("stopped");
      loadConversation();
    });

    // Tester agent execution events
    evtSource.addEventListener("code_execution", (e) => {
      const data = JSON.parse(e.data);
      const result: CodeExecutionResult = {
        status: data.success ? "success" : "error",
        stdout: data.stdout,
        stderr: data.stderr,
        exitCode: data.exitCode,
        errors: data.stderr ? parseCompilationErrors(data.stderr) : undefined,
        timestamp: Date.now(),
      };
      setExecutionResults((prev) => [...prev, result]);
    });

    evtSource.addEventListener("browser_opened", (e) => {
      const data = JSON.parse(e.data);
      const result: CodeExecutionResult = {
        status: "success",
        browserUrl: data.url,
        browserStatus: data.status || "Browser opened successfully",
        timestamp: Date.now(),
      };
      setExecutionResults((prev) => [...prev, result]);
    });

    evtSource.addEventListener("build_complete", (e) => {
      const data = JSON.parse(e.data);
      const result: CodeExecutionResult = {
        status: data.success ? "success" : "error",
        stdout: data.output,
        stderr: data.errors,
        errors: data.errors ? parseCompilationErrors(data.errors) : undefined,
        timestamp: Date.now(),
      };
      setExecutionResults((prev) => [...prev, result]);
    });

    return () => evtSource.close();
  }, [conversationId, loadConversation]);

  // Auto-scroll only if user is already near the bottom
  const isNearBottom = (el: HTMLElement | null) => {
    if (!el) return false;
    let container = el.parentElement;
    while (container && container.scrollHeight <= container.clientHeight) {
      container = container.parentElement;
    }
    if (!container) return false;
    return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  };

  useEffect(() => {
    if (!isStepMode) {
      if (isNearBottom(bottomRef.current)) {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }
      if (isNearBottom(activityBottomRef.current)) {
        activityBottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }
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
    try {
      setError(null);
      const res = await fetch(`/api/escalations/${escalationId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setAnswer("");
    } catch (err) {
      console.error("SubmitAnswer:", err);
      setError("Failed to submit answer. Please try again.");
    }
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
    setError(null);
    try {
      const payload: Record<string, unknown> = { message: followUp };
      if (followUpImages.length > 0) {
        payload.images = followUpImages.map(({ type, media_type, data }) => ({ type, media_type, data }));
      }
      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setFollowUp("");
      setFollowUpImages([]);
      setStatus("active");
      loadConversation();
    } catch (err) {
      console.error("SendFollowUp:", err);
      setError("Failed to send follow-up. Please try again.");
    } finally {
      setSending(false);
    }
  };

  const enterStepMode = () => { setIsStepMode(true); setStepIndex(0); };
  const exitStepMode = () => { setIsStepMode(false); setStepIndex(-1); };

  const exportDynamicOrg = async () => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}/org`);
      if (!res.ok) throw new Error("Failed to fetch org");
      const data = await res.json();
      const exportData = { agents: data.agents, relationships: data.relationships };
      const jsonString = JSON.stringify(exportData);
      const base64 = btoa(unescape(encodeURIComponent(jsonString)));
      await navigator.clipboard.writeText(base64);
      setExportCopied(true);
      setTimeout(() => setExportCopied(false), 2000);
    } catch (err) {
      console.error("ExportOrg:", err);
      setError("Failed to export organization.");
    }
  };

  const visibleActivity = isStepMode ? activity.slice(0, stepIndex + 1) : activity;
  const currentStep = isStepMode && stepIndex >= 0 ? activity[stepIndex] : null;

  return (
    <div className="space-y-4">
      {error && (
        <div style={{ background: "#fee", color: "#c00", padding: "12px 16px", borderRadius: "8px", margin: "12px 0", fontSize: "14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>{error}</span>
          <button onClick={() => setError(null)} style={{ background: "none", border: "none", color: "#c00", cursor: "pointer", fontSize: "18px" }}>×</button>
        </div>
      )}

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
          {status === "active" && (
            <button
              onClick={async () => {
                try {
                  setError(null);
                  const res = await fetch(`/api/conversations/${conversationId}`, { method: "PATCH" });
                  if (!res.ok) throw new Error(`Request failed (${res.status})`);
                  setStatus("stopped");
                } catch (err) {
                  console.error("StopJob:", err);
                  setError("Failed to stop job. Please try again.");
                }
              }}
              className="text-danger text-xs hover:bg-danger/10 px-3 py-1.5 rounded border border-danger/30 transition-colors font-medium"
            >
              Stop Job
            </button>
          )}
          <button
            onClick={async () => {
              if (!confirm("Delete this operation?")) return;
              try {
                setError(null);
                const res = await fetch(`/api/conversations/${conversationId}`, { method: "DELETE" });
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                router.push("/");
              } catch (err) {
                console.error("DeleteOperation:", err);
                setError("Failed to delete operation. Please try again.");
              }
            }}
            className="text-text-muted text-xs hover:bg-danger/10 hover:text-danger px-3 py-1.5 rounded border border-border hover:border-danger/30 transition-colors"
          >
            Delete
          </button>
          {(status === "completed" || status === "stopped") && (
            <a
              href={`/conversation/${conversationId}/report`}
              className="text-xs px-3 py-1.5 rounded border border-accent text-accent hover:bg-accent hover:text-white transition-colors"
            >
              View Report
            </a>
          )}
          {(status === "completed" || status === "stopped") && activity.length > 0 && (
            <button
              onClick={isStepMode ? exitStepMode : enterStepMode}
              className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                isStepMode ? "bg-accent text-white border-accent" : "border-border text-text-muted hover:text-text hover:border-accent"
              }`}
            >
              {isStepMode ? "Exit Step-Through" : "Step-Through Replay"}
            </button>
          )}
          {isDynamicOrg && (
            <button
              onClick={exportDynamicOrg}
              className="text-xs px-3 py-1.5 rounded border border-accent/50 text-accent hover:bg-accent hover:text-white transition-colors flex items-center gap-1.5"
            >
              {exportCopied ? "✓ Copied!" : "Export Org"}
            </button>
          )}
          <span className={`text-xs px-2 py-0.5 rounded ${status === "active" ? "bg-accent/20 text-accent" : status === "completed" ? "bg-success/20 text-success" : status === "stopped" ? "bg-danger/20 text-danger" : "bg-border text-text-muted"}`}>
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

      {/* Tester Execution Results */}
      {executionResults.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-text flex items-center gap-2">
            <span className="text-accent">⚡</span>
            Code Execution & Testing
          </h2>
          <div className="space-y-3">
            {executionResults.map((result, idx) => (
              <CodeExecutionPanel
                key={idx}
                result={result}
                title={`Execution ${idx + 1}`}
              />
            ))}
          </div>
        </div>
      )}

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
        <div className="bg-bg-card border border-border rounded-lg flex flex-col max-h-[70vh]">
          {/* View toggle header */}
          <div className="px-4 pt-3 pb-1 flex items-center justify-between border-b border-border">
            <h2 className="text-xs text-text-muted font-medium">
              Activity {isStepMode && `(${stepIndex + 1}/${activity.length})`}
            </h2>
            <div className="flex items-center gap-0.5 bg-bg rounded p-0.5">
              <button
                onClick={() => setActivityView("list")}
                className={`text-[10px] px-2 py-0.5 rounded transition-colors ${activityView === "list" ? "bg-accent/20 text-accent" : "text-text-muted hover:text-text"}`}
              >
                List
              </button>
              <button
                onClick={() => setActivityView("tree")}
                className={`text-[10px] px-2 py-0.5 rounded transition-colors ${activityView === "tree" ? "bg-accent/20 text-accent" : "text-text-muted hover:text-text"}`}
              >
                Tree
              </button>
            </div>
          </div>

          {/* Tree view */}
          {activityView === "tree" && (
            <div className="flex-1 overflow-y-auto p-2" style={{ background: "#08080f" }}>
              <ActivityTree conversationId={isDynamicOrg ? conversationId : undefined} activity={activity as TreeActivityItem[]} />
            </div>
          )}

          {/* List view */}
          {activityView === "list" && <div className="p-4 flex-1 overflow-y-auto">
            <div className="space-y-1.5">
              {visibleActivity.length === 0 && <p className="text-xs text-text-muted">Waiting for activity...</p>}
              {visibleActivity.map((item, i) => {
                const isCurrentStep = isStepMode && i === stepIndex;
                const isSelected = selectedActivity?.id === item.id;
                return (
                  <div
                    key={item.id}
                    className={`text-xs p-1.5 rounded transition-colors cursor-pointer ${isCurrentStep ? "bg-accent/10 border border-accent/30" : isSelected ? "bg-accent/10 border border-accent/20" : "hover:bg-bg-hover"}`}
                    onClick={() => {
                      if (isStepMode) setStepIndex(i);
                      setSelectedActivity(isSelected ? null : item);
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-accent">{item.agentName}</span>
                      <StepTypeBadge type={item.type} tool={item.tool} />
                    </div>
                    {item.type === "message" && <p className="text-text-muted mt-0.5 truncate">{item.content}</p>}
                    {item.type === "start" && <p className="text-text-muted mt-0.5 truncate">Task: {item.content}</p>}
                    {item.type === "tool" && item.targetAgents && item.targetAgents.length > 0 && (
                      <p className="text-text-muted mt-0.5 truncate">→ {item.targetAgents.map((a) => a.name).join(", ")}</p>
                    )}
                    {item.type === "tool" && !item.targetAgents && item.toolInput && <p className="text-text-muted mt-0.5 truncate">{JSON.stringify(item.toolInput).slice(0, 80)}</p>}
                    {item.type === "tool_result" && <p className="text-text-muted mt-0.5 truncate">{item.toolResult?.slice(0, 80)}</p>}
                  </div>
                );
              })}
              <div ref={activityBottomRef} />
            </div>
          </div>}

          {/* Activity Detail Panel */}
          {activityView === "list" && selectedActivity && (
            <div className="border-t border-border p-3 max-h-[35vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-accent text-xs font-medium">{selectedActivity.agentName}</span>
                  <StepTypeBadge type={selectedActivity.type} tool={selectedActivity.tool} />
                </div>
                <button onClick={() => setSelectedActivity(null)} className="text-text-muted hover:text-text text-xs">&times;</button>
              </div>

              {selectedActivity.type === "start" && (
                <div className="space-y-2">
                  <div>
                    <span className="text-[10px] text-text-muted uppercase">Task Received</span>
                    <p className="text-xs whitespace-pre-wrap bg-bg rounded p-2 mt-0.5 max-h-40 overflow-y-auto">{selectedActivity.content}</p>
                  </div>
                  {selectedActivity.agentRole && (
                    <div>
                      <span className="text-[10px] text-text-muted uppercase">Role</span>
                      <p className="text-xs mt-0.5" style={{ color: ROLE_COLORS[selectedActivity.agentRole] || "#6a6a7a" }}>{selectedActivity.agentRole}</p>
                    </div>
                  )}
                </div>
              )}

              {selectedActivity.type === "message" && (
                <div>
                  <span className="text-[10px] text-text-muted uppercase">Full Response</span>
                  <p className="text-xs whitespace-pre-wrap bg-bg rounded p-2 mt-0.5 max-h-60 overflow-y-auto">{selectedActivity.content}</p>
                </div>
              )}

              {selectedActivity.type === "tool" && (
                <div className="space-y-2">
                  <div>
                    <span className="text-[10px] text-text-muted uppercase">Action</span>
                    <p className="text-xs mt-0.5">{TOOL_LABELS[selectedActivity.tool || ""] || selectedActivity.tool}</p>
                  </div>
                  {selectedActivity.targetAgents && selectedActivity.targetAgents.length > 0 && (
                    <div>
                      <span className="text-[10px] text-text-muted uppercase">Delegated To</span>
                      <div className="mt-0.5 space-y-0.5">
                        {selectedActivity.targetAgents.map((a) => (
                          <div key={a.id} className="text-xs flex items-center gap-1.5">
                            <span style={{ color: ROLE_COLORS[a.role] || "#6a6a7a" }}>{a.name}</span>
                            <span className="text-text-muted">({a.role})</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {selectedActivity.toolInput && (
                    <div>
                      <span className="text-[10px] text-text-muted uppercase">Input</span>
                      <pre className="text-xs bg-bg rounded p-2 mt-0.5 overflow-x-auto max-h-40 overflow-y-auto">{JSON.stringify(selectedActivity.toolInput, null, 2)}</pre>
                    </div>
                  )}
                </div>
              )}

              {selectedActivity.type === "tool_result" && (
                <div className="space-y-2">
                  <div>
                    <span className="text-[10px] text-text-muted uppercase">Tool</span>
                    <p className="text-xs mt-0.5">{TOOL_LABELS[selectedActivity.tool || ""] || selectedActivity.tool}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-text-muted uppercase">Result</span>
                    <pre className="text-xs bg-bg rounded p-2 mt-0.5 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap">{selectedActivity.toolResult}</pre>
                  </div>
                </div>
              )}

              {selectedActivity.type === "escalation" && (
                <div>
                  <span className="text-[10px] text-text-muted uppercase">Question</span>
                  <p className="text-xs whitespace-pre-wrap bg-bg rounded p-2 mt-0.5">{selectedActivity.content}</p>
                </div>
              )}

              {selectedActivity.type === "done" && (
                <p className="text-xs text-success">Agent completed their work.</p>
              )}
            </div>
          )}
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
    tool_result: { text: tool ? `${TOOL_LABELS[tool] || tool} result` : "result", color: "#a78bfa" },
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
