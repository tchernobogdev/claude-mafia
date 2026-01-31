"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useToast } from "./components/Toast";
import ConfirmDialog from "./components/ConfirmDialog";
import Spinner from "./components/Spinner";

interface Conversation {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  _count: { messages: number };
}

export default function Dashboard() {
  const router = useRouter();
  const { toast } = useToast();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<unknown[]>([]);
  const [task, setTask] = useState("");
  const [workingDir, setWorkingDir] = useState("");
  const [images, setImages] = useState<{ type: "base64"; media_type: string; data: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadConversations = useCallback(() => {
    fetch("/api/conversations")
      .then((r) => r.json())
      .then(setConversations);
  }, []);

  const loadAgents = useCallback(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setAgents(data); });
  }, []);

  useEffect(() => {
    loadConversations();
    loadAgents();
    // Poll every 5 seconds to catch status updates
    const interval = setInterval(loadConversations, 5000);
    return () => clearInterval(interval);
  }, [loadConversations, loadAgents]);

  const deleteConversation = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    setConversations((prev) => prev.filter((c) => c.id !== id));
    toast("Operation deleted", "success");
  };

  const addImageFiles = (files: File[]) => {
    files.forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const [header, data] = dataUrl.split(",");
        const media_type = header.match(/:(.*?);/)?.[1] || "image/png";
        setImages((prev) => [...prev, { type: "base64", media_type, data, name: file.name }]);
      };
      reader.readAsDataURL(file);
    });
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addImageFiles(Array.from(e.target.files));
    e.target.value = "";
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length > 0) addImageFiles(files);
  };

  const startTask = async () => {
    if (!task.trim()) return;
    setLoading(true);
    try {
      const payload: Record<string, unknown> = { task };
      if (workingDir.trim()) payload.workingDirectory = workingDir.trim();
      if (images.length > 0) {
        payload.images = images.map(({ type, media_type, data }) => ({ type, media_type, data }));
      }
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.conversationId) {
        // Add to list immediately so it's visible if user navigates back
        setConversations((prev) => [
          { id: data.conversationId, title: task.slice(0, 100), status: "active", createdAt: new Date().toISOString(), _count: { messages: 1 } },
          ...prev.filter((c) => c.id !== data.conversationId),
        ]);
        setTask("");
        setImages([]);
        toast("Operation started", "success");
        router.push(`/conversation/${data.conversationId}`);
      } else {
        toast(data.error || "Failed to start task", "error");
      }
    } finally {
      setLoading(false);
    }
  };

  const activeOps = conversations.filter((c) => c.status === "active").length;
  const successRate = conversations.length > 0
    ? Math.round((conversations.filter((c) => c.status === "completed").length / conversations.length) * 100)
    : 0;

  return (
    <div className="space-y-8 animate-fadeIn">
      <div>
        <h1 className="text-3xl font-bold mb-1 gradient-text">Command Center</h1>
        <p className="text-text-muted text-sm">Issue orders to your organization.</p>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="glass-card p-4 animate-slideUp" style={{ animationDelay: "0.1s" }}>
          <div className="text-text-muted text-xs uppercase tracking-wide mb-1">Active Ops</div>
          <div className="text-2xl font-bold text-accent">{activeOps}</div>
        </div>
        <div className="glass-card p-4 animate-slideUp" style={{ animationDelay: "0.2s" }}>
          <div className="text-text-muted text-xs uppercase tracking-wide mb-1">Total Agents</div>
          <div className="text-2xl font-bold text-success">{agents.length}</div>
        </div>
        <div className="glass-card p-4 animate-slideUp" style={{ animationDelay: "0.3s" }}>
          <div className="text-text-muted text-xs uppercase tracking-wide mb-1">Success Rate</div>
          <div className="text-2xl font-bold text-gold">{successRate}%</div>
        </div>
      </div>

      {/* Task Input */}
      <div className="glass-card p-6 space-y-4 animate-slideUp" style={{ animationDelay: "0.4s" }}>
        <label className="text-sm font-medium text-text block">New Operation</label>
        <div className="bg-bg border-2 border-success/30 rounded-lg p-4">
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="> Issue your orders, Boss..."
            className="w-full bg-transparent text-success font-mono text-sm placeholder:text-success/40 focus:outline-none resize-none h-24"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) startTask();
            }}
            onPaste={handlePaste}
            aria-label="Task description"
          />
        </div>
        <div className="flex gap-2">
          <input
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            placeholder="C:\\path\\to\\project (optional working directory)"
            className="flex-1 bg-bg border border-border rounded px-3 py-2 text-xs text-text placeholder:text-text-muted focus:outline-none focus:border-accent transition-all"
          />
          <button
            type="button"
            onClick={async () => {
              const res = await fetch("/api/browse-folder", { method: "POST" });
              const data = await res.json();
              if (data.path) setWorkingDir(data.path);
            }}
            className="hover-lift text-xs text-text-muted hover:text-text border border-border hover:border-accent px-4 py-2 rounded transition-all whitespace-nowrap"
            aria-label="Browse for working directory"
          >
            Browse...
          </button>
        </div>
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={`data:${img.media_type};base64,${img.data}`}
                  alt={img.name}
                  className="h-24 w-24 object-cover rounded border border-border hover-lift"
                />
                <button
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 bg-danger text-white text-xs w-5 h-5 rounded-full leading-none opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                  aria-label="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-between items-center">
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              multiple
              onChange={handleImageSelect}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="hover-lift text-xs text-text-muted hover:text-text border border-border hover:border-accent px-4 py-2 rounded transition-all"
              aria-label="Attach images"
            >
              + Attach Images
            </button>
          </div>
          <button
            onClick={startTask}
            disabled={loading || !task.trim()}
            className="bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-sm px-6 py-2.5 rounded-lg transition-all hover-lift font-medium flex items-center gap-2"
            aria-label="Send orders"
          >
            {loading && <Spinner className="text-white" />}
            {loading ? "Sending..." : "Send Orders"}
          </button>
        </div>
      </div>

      {/* Conversations List */}
      <div>
        <h2 className="text-lg font-semibold mb-4 gradient-text">Recent Operations</h2>
        {conversations.length === 0 ? (
          <div className="glass-card p-12 text-center">
            <div className="text-6xl mb-4">🎯</div>
            <p className="text-text-muted text-sm">No operations yet. Issue your first order above.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {conversations.map((c, idx) => (
              <Link
                key={c.id}
                href={`/conversation/${c.id}`}
                className="block glass-card hover-lift p-4 transition-all animate-slideUp"
                style={{ animationDelay: `${0.5 + idx * 0.05}s` }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="text-sm font-medium mb-1">{c.title}</div>
                    <div className="flex items-center gap-3 text-xs text-text-muted">
                      <span>{c._count.messages} messages</span>
                      <span>•</span>
                      <span>{new Date(c.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
                        c.status === "active"
                          ? "bg-success/20 text-success status-pulse"
                          : c.status === "pending"
                          ? "bg-gold/20 text-gold"
                          : "bg-border/20 text-text-muted"
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        c.status === "active"
                          ? "bg-success"
                          : c.status === "pending"
                          ? "bg-gold"
                          : "bg-text-muted"
                      }`} />
                      {c.status}
                    </span>
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setConfirmDelete(c.id);
                      }}
                      className="text-danger hover:bg-danger/10 px-2 py-1 rounded transition-colors text-lg"
                      title="Delete"
                      aria-label="Delete operation"
                    >
                      ×
                    </button>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete Operation"
        message="You sure about this? This conversation is gone forever."
        onConfirm={async () => {
          if (confirmDelete) {
            await fetch(`/api/conversations/${confirmDelete}`, { method: "DELETE" });
            setConversations((prev) => prev.filter((c) => c.id !== confirmDelete));
            toast("Operation deleted", "success");
            setConfirmDelete(null);
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
