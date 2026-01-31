"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Conversation {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  _count: { messages: number };
}

export default function Dashboard() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [task, setTask] = useState("");
  const [images, setImages] = useState<{ type: "base64"; media_type: string; data: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadConversations = useCallback(() => {
    fetch("/api/conversations")
      .then((r) => r.json())
      .then(setConversations);
  }, []);

  useEffect(() => {
    loadConversations();
    // Poll every 5 seconds to catch status updates
    const interval = setInterval(loadConversations, 5000);
    return () => clearInterval(interval);
  }, [loadConversations]);

  const deleteConversation = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    setConversations((prev) => prev.filter((c) => c.id !== id));
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
        router.push(`/conversation/${data.conversationId}`);
      } else {
        alert(data.error || "Failed to start task");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold mb-1">Dashboard</h1>
        <p className="text-text-muted text-sm">Issue orders to your organization.</p>
      </div>

      <div className="bg-bg-card border border-border rounded-lg p-4 space-y-3">
        <label className="text-sm text-text-muted block">New Task</label>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Give your orders, Boss..."
          className="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent resize-none h-24"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) startTask();
          }}
          onPaste={handlePaste}
        />
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={`data:${img.media_type};base64,${img.data}`}
                  alt={img.name}
                  className="h-16 w-16 object-cover rounded border border-border"
                />
                <button
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 bg-danger text-white text-[10px] w-4 h-4 rounded-full leading-none opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-between">
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
              className="text-xs text-text-muted hover:text-text border border-border hover:border-accent px-3 py-1.5 rounded transition-colors"
            >
              + Attach Images
            </button>
          </div>
          <button
            onClick={startTask}
            disabled={loading || !task.trim()}
            className="bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-sm px-4 py-2 rounded transition-colors"
          >
            {loading ? "Sending..." : "Send Orders"}
          </button>
        </div>
      </div>

      <div>
        <h2 className="text-sm font-medium text-text-muted mb-3">Recent Operations</h2>
        {conversations.length === 0 ? (
          <p className="text-text-muted text-sm">No operations yet.</p>
        ) : (
          <div className="space-y-2">
            {conversations.map((c) => (
              <Link
                key={c.id}
                href={`/conversation/${c.id}`}
                className="block bg-bg-card border border-border rounded-lg p-3 hover:bg-bg-hover transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm">{c.title}</span>
                  <div className="flex items-center gap-3 text-xs text-text-muted">
                    <span>{c._count.messages} messages</span>
                    <span
                      className={`px-2 py-0.5 rounded ${
                        c.status === "active"
                          ? "bg-accent/20 text-accent"
                          : c.status === "completed"
                          ? "bg-success/20 text-success"
                          : "bg-border text-text-muted"
                      }`}
                    >
                      {c.status}
                    </span>
                    <button
                      onClick={(e) => deleteConversation(c.id, e)}
                      className="text-danger hover:bg-danger/10 px-1.5 py-0.5 rounded transition-colors"
                      title="Delete"
                    >
                      &times;
                    </button>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
