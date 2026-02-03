"use client";

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

interface Agent {
  id: string;
  name: string;
  role: string;
  specialty: string | null;
  systemPrompt: string;
  model: string;
  parentId: string | null;
  posX: number;
  posY: number;
  outgoingRels: Relationship[];
  incomingRels: Relationship[];
}

interface Relationship {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  action: string;
  cardinality: string;
  fromAgent?: { name: string };
  toAgent?: { name: string };
}

const MODEL_LABELS: Record<string, string> = {
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-sonnet-4-5-20250929": "Sonnet 4.5",
  "claude-opus-4-5-20251101": "Opus 4.5",
};

const ROLE_COLORS: Record<string, string> = {
  boss: "#ef4444",
  underboss: "#8b5cf6",
  capo: "#facc15",
  soldier: "#6a6a7a",
  tester: "#22d3ee",
};

const ACTION_COLORS: Record<string, string> = {
  delegate: "#8b5cf6",
  collaborate: "#3b82f6",
  test: "#22d3ee",
};

const NODE_W = 200;
const NODE_H = 80;
const BOSS_ID = "__boss__";

type ConnectingState = {
  fromId: string;
  fromX: number;
  fromY: number;
  mouseX: number;
  mouseY: number;
} | null;

interface ContextMenu {
  agentId: string;
  x: number;
  y: number;
}

interface RelContextMenu {
  rel: Relationship;
  fromName: string;
  toName: string;
  x: number;
  y: number;
}

interface EditForm {
  agentId: string;
  name: string;
  role: string;
  model: string;
  systemPrompt: string;
  parentId: string;
}

// Big Boss pseudo-agent
const BOSS_NODE: Agent = {
  id: BOSS_ID,
  name: "Big Boss",
  role: "boss",
  specialty: null,
  systemPrompt: "",
  model: "",
  parentId: null,
  posX: 350,
  posY: 30,
  outgoingRels: [],
  incomingRels: [],
};

function ConfigurePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pendingConversationId = searchParams.get("conversationId");
  const pendingTask = searchParams.get("pendingTask");
  const canvasRef = useRef<HTMLDivElement>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [dragging, setDragging] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const [connecting, setConnecting] = useState<ConnectingState>(null);
  const [connectAction, setConnectAction] = useState<string>("delegate");
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [relContextMenu, setRelContextMenu] = useState<RelContextMenu | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    role: "soldier" as string,
    model: "claude-sonnet-4-5-20250929",
    parentId: "",
    systemPrompt: "",
  });
  const [showImportModal, setShowImportModal] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const [importing, setImporting] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [templates, setTemplates] = useState<unknown[]>([]);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [showLoadTemplates, setShowLoadTemplates] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);

  // All nodes including boss
  const allNodes = [BOSS_NODE, ...agents];

  const loadData = useCallback(async () => {
    try {
      const agentsUrl = pendingConversationId
        ? `/api/agents?conversationId=${pendingConversationId}`
        : "/api/agents";
      const agentsRes = await fetch(agentsUrl);
      if (!agentsRes.ok) throw new Error(`Request failed (${agentsRes.status})`);
      const agentsData = await agentsRes.json();
      setAgents(agentsData);

      const relsRes = await fetch("/api/relationships");
      if (!relsRes.ok) throw new Error(`Request failed (${relsRes.status})`);
      const relsData = await relsRes.json();

      if (pendingConversationId) {
        const agentIds = new Set(agentsData.map((a: Agent) => a.id));
        const filteredRels = relsData.filter((r: Relationship) => agentIds.has(r.fromAgentId) && agentIds.has(r.toAgentId));
        setRelationships(filteredRels);
      } else {
        setRelationships(relsData);
      }
    } catch (err) {
      console.error("LoadData:", err);
      setError("Failed to load data. Please try again.");
    }
  }, [pendingConversationId]);

  useEffect(() => { loadData(); }, [loadData]);

  // Close context menu on click anywhere
  useEffect(() => {
    const handler = () => { setContextMenu(null); setRelContextMenu(null); };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, []);

  // Esc to cancel connecting or close modal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConnecting(null);
        setContextMenu(null);
        setRelContextMenu(null);
        setEditForm(null);
        setShowImportModal(false);
        setImportText("");
        setImportError(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const createAgent = async () => {
    if (!form.name.trim()) return;
    try {
      setError(null);
      const cx = -pan.x + 400 + Math.random() * 200;
      const cy = -pan.y + 200 + Math.random() * 200;
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          parentId: form.parentId || null,
          posX: cx,
          posY: cy,
        }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setForm({ name: "", role: "soldier", model: "claude-sonnet-4-5-20250929", parentId: "", systemPrompt: "" });
      setShowForm(false);
      loadData();
    } catch (err) {
      console.error("CreateAgent:", err);
      setError("Failed to create agent. Please try again.");
    }
  };

  const handleExport = async () => {
    try {
      const exportData = { agents, relationships };
      const jsonString = JSON.stringify(exportData);
      const base64 = btoa(unescape(encodeURIComponent(jsonString)));
      await navigator.clipboard.writeText(base64);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error("Export failed:", err);
      setError("Failed to export configuration.");
    }
  };

  const handleImport = async () => {
    try {
      setImportError(null);
      setImporting(true);
      const jsonString = decodeURIComponent(escape(atob(importText.trim())));
      const parsed = JSON.parse(jsonString);

      if (!Array.isArray(parsed.agents) || !Array.isArray(parsed.relationships)) {
        throw new Error("Invalid configuration format");
      }

      const idMapping: Record<string, string> = {};

      // Create agents
      for (const agent of parsed.agents) {
        const randomX = Math.random() * 600 + 100;
        const randomY = Math.random() * 400 + 100;

        const res = await fetch("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: agent.name,
            role: agent.role,
            specialty: agent.specialty,
            systemPrompt: agent.systemPrompt,
            model: agent.model,
            parentId: null,
            posX: randomX,
            posY: randomY,
          }),
        });

        if (!res.ok) throw new Error(`Failed to create agent ${agent.name}`);
        const newAgent = await res.json();
        idMapping[agent.id] = newAgent.id;
      }

      // Remap parentIds
      for (const agent of parsed.agents) {
        if (agent.parentId && idMapping[agent.parentId]) {
          const newId = idMapping[agent.id];
          await fetch(`/api/agents/${newId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parentId: idMapping[agent.parentId] }),
          });
        }
      }

      // Create relationships
      for (const rel of parsed.relationships) {
        const fromId = idMapping[rel.fromAgentId];
        const toId = idMapping[rel.toAgentId];

        if (!fromId || !toId) continue;

        const res = await fetch("/api/relationships", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromAgentId: fromId,
            toAgentId: toId,
            action: rel.action,
            cardinality: rel.cardinality,
          }),
        });

        if (!res.ok) throw new Error(`Failed to create relationship`);
      }

      await loadData();
      setShowImportModal(false);
      setImportText("");
      setImportError(null);
    } catch (err) {
      console.error("Import failed:", err);
      setImportError(err instanceof Error ? err.message : "Invalid import data. Please check the format.");
    } finally {
      setImporting(false);
    }
  };

  const loadTemplates = async () => {
    try {
      const res = await fetch("/api/org-templates");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      setTemplates(data);
    } catch (err) {
      console.error("LoadTemplates:", err);
    }
  };

  const updateAgentPos = async (id: string, posX: number, posY: number) => {
    if (id === BOSS_ID) return; // Boss position is local-only
    try {
      const res = await fetch(`/api/agents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ posX, posY }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
    } catch (err) {
      console.error("UpdateAgentPos:", err);
      setError("Failed to update agent position.");
    }
  };

  const createRelationship = async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    // Boss connections are visual-only for now (boss is not a DB agent)
    if (fromId === BOSS_ID || toId === BOSS_ID) return;
    try {
      setError(null);
      const res = await fetch("/api/relationships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAgentId: fromId,
          toAgentId: toId,
          action: connectAction,
        }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      loadData();
    } catch (err) {
      console.error("CreateRelationship:", err);
      setError("Failed to create relationship. Please try again.");
    }
  };

  const deleteRelationship = async (relId: string) => {
    try {
      setError(null);
      const res = await fetch(`/api/relationships/${relId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      loadData();
    } catch (err) {
      console.error("DeleteRelationship:", err);
      setError("Failed to delete relationship. Please try again.");
    }
  };

  const deleteAgent = async (agentId: string) => {
    if (agentId === BOSS_ID) return;
    const agent = agents.find((a) => a.id === agentId);
    if (!confirm(`Delete ${agent?.name}? This will also delete all subordinates.`)) return;
    try {
      setError(null);
      const res = await fetch(`/api/agents/${agentId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setContextMenu(null);
      loadData();
    } catch (err) {
      console.error("DeleteAgent:", err);
      setError("Failed to delete agent. Please try again.");
    }
  };

  const openEditForm = (agentId: string) => {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;
    setEditForm({
      agentId,
      name: agent.name,
      role: agent.role,
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      parentId: agent.parentId || "",
    });
    setContextMenu(null);
  };

  const saveEditForm = async () => {
    if (!editForm) return;
    setSaving(true);
    try {
      setError(null);
      const res = await fetch(`/api/agents/${editForm.agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editForm.name,
          role: editForm.role,
          model: editForm.model,
          systemPrompt: editForm.systemPrompt,
          parentId: editForm.parentId || null,
        }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setEditForm(null);
      loadData();
    } catch (err) {
      console.error("SaveEditForm:", err);
      setError("Failed to save agent. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  // Node mouse handlers
  const handleNodeMouseDown = (e: React.MouseEvent, nodeId: string) => {
    if (e.button !== 0) return;
    if (connecting) {
      createRelationship(connecting.fromId, nodeId);
      setConnecting(null);
      return;
    }
    e.stopPropagation();
    const node = allNodes.find((a) => a.id === nodeId);
    if (!node) return;
    setDragging({
      id: nodeId,
      offsetX: e.clientX - (node.posX + pan.x),
      offsetY: e.clientY - (node.posY + pan.y),
    });
  };

  const handleNodeContextMenu = (e: React.MouseEvent, nodeId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (nodeId === BOSS_ID) return;
    setContextMenu({ agentId: nodeId, x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (dragging) {
      const newX = e.clientX - dragging.offsetX - pan.x;
      const newY = e.clientY - dragging.offsetY - pan.y;
      if (dragging.id === BOSS_ID) {
        BOSS_NODE.posX = newX;
        BOSS_NODE.posY = newY;
        // Force re-render
        setAgents((prev) => [...prev]);
      } else {
        setAgents((prev) =>
          prev.map((a) =>
            a.id === dragging.id ? { ...a, posX: newX, posY: newY } : a
          )
        );
      }
    }
    if (connecting) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        setConnecting({
          ...connecting,
          mouseX: e.clientX - rect.left - pan.x,
          mouseY: e.clientY - rect.top - pan.y,
        });
      }
    }
    if (isPanning) {
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
    }
  };

  const handleMouseUp = () => {
    if (dragging) {
      if (dragging.id !== BOSS_ID) {
        const agent = agents.find((a) => a.id === dragging.id);
        if (agent) updateAgentPos(agent.id, agent.posX, agent.posY);
      }
      setDragging(null);
    }
    if (isPanning) setIsPanning(false);
  };

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0 && !dragging && !connecting) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
    if (connecting && e.button === 0) {
      setConnecting(null);
    }
  };

  const startConnecting = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    e.preventDefault();
    const node = allNodes.find((a) => a.id === nodeId);
    if (!node) return;
    setConnecting({
      fromId: nodeId,
      fromX: node.posX + NODE_W / 2,
      fromY: node.posY + NODE_H / 2,
      mouseX: node.posX + NODE_W / 2,
      mouseY: node.posY + NODE_H,
    });
  };

  // Group relationships by node pair to compute offsets
  const getRelGroupKey = (fromId: string, toId: string) => {
    return [fromId, toId].sort().join("||");
  };

  const relGroupCounts: Record<string, number> = {};
  const relGroupIndex: Record<string, number> = {};
  for (const rel of relationships) {
    const key = getRelGroupKey(rel.fromAgentId, rel.toAgentId);
    if (!relGroupCounts[key]) relGroupCounts[key] = 0;
    relGroupIndex[rel.id] = relGroupCounts[key];
    relGroupCounts[key]++;
  }

  // Bezier connector path between two nodes with offset for parallel connectors
  const getConnectorPath = (from: Agent, to: Agent, offset: number = 0, totalInGroup: number = 1): { path: string; arrowX: number; arrowY: number; arrowAngle: number; labelX: number; labelY: number } => {
    const fx = from.posX + NODE_W / 2;
    const fy = from.posY + NODE_H / 2;
    const tx = to.posX + NODE_W / 2;
    const ty = to.posY + NODE_H / 2;

    const dx = tx - fx;
    const dy = ty - fy;

    // Spread amount: each connector is offset perpendicular to the main axis
    const SPREAD = 20;
    const spreadOffset = totalInGroup > 1 ? (offset - (totalInGroup - 1) / 2) * SPREAD : 0;

    let x1: number, y1: number, x2: number, y2: number;

    if (Math.abs(dy) > Math.abs(dx)) {
      // Vertical dominant — offset horizontally
      if (dy > 0) {
        x1 = fx + spreadOffset; y1 = from.posY + NODE_H;
        x2 = tx + spreadOffset; y2 = to.posY;
      } else {
        x1 = fx + spreadOffset; y1 = from.posY;
        x2 = tx + spreadOffset; y2 = to.posY + NODE_H;
      }
    } else {
      // Horizontal dominant — offset vertically
      if (dx > 0) {
        x1 = from.posX + NODE_W; y1 = fy + spreadOffset;
        x2 = to.posX; y2 = ty + spreadOffset;
      } else {
        x1 = from.posX; y1 = fy + spreadOffset;
        x2 = to.posX + NODE_W; y2 = ty + spreadOffset;
      }
    }

    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;

    let cx1: number, cy1: number, cx2: number, cy2: number;
    if (Math.abs(dy) > Math.abs(dx)) {
      cx1 = x1; cy1 = midY;
      cx2 = x2; cy2 = midY;
    } else {
      cx1 = midX; cy1 = y1;
      cx2 = midX; cy2 = y2;
    }

    const path = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
    const angle = Math.atan2(y2 - cy2, x2 - cx2);

    return { path, arrowX: x2, arrowY: y2, arrowAngle: angle, labelX: midX, labelY: midY - 8 };
  };

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
          <h1 className="text-2xl font-bold">Organization</h1>
          <p className="text-text-muted text-sm">Drag to move. Hover ports to connect. Right-click to edit.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 bg-bg-card border border-border rounded px-2 py-1">
            <span className="text-xs text-text-muted mr-1">Connect as:</span>
            {["delegate", "collaborate", "test"].map((a) => (
              <button
                key={a}
                onClick={() => setConnectAction(a)}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${
                  connectAction === a ? "text-white" : "text-text-muted hover:text-text"
                }`}
                style={connectAction === a ? { backgroundColor: ACTION_COLORS[a] } : {}}
              >
                {a}
              </button>
            ))}
          </div>
          <button
            onClick={() => {
              setShowSaveTemplate(true);
            }}
            className="bg-bg-card border border-border text-text text-sm px-4 py-2 rounded transition-colors hover:bg-bg-hover"
          >
            Save as Template
          </button>
          <button
            onClick={() => {
              setShowLoadTemplates(true);
              loadTemplates();
            }}
            className="bg-bg-card border border-border text-text text-sm px-4 py-2 rounded transition-colors hover:bg-bg-hover"
          >
            Load Template
          </button>
          <button
            onClick={handleExport}
            className="bg-bg-card border border-border text-text text-sm px-4 py-2 rounded transition-colors hover:bg-bg-hover"
          >
            {copySuccess ? "✓ Copied!" : "Export"}
          </button>
          <button
            onClick={() => setShowImportModal(true)}
            className="bg-bg-card border border-border text-text text-sm px-4 py-2 rounded transition-colors hover:bg-bg-hover"
          >
            Import
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            className="bg-accent hover:bg-accent-hover text-white text-sm px-4 py-2 rounded transition-colors"
          >
            + Add Agent
          </button>
        </div>
      </div>

      {pendingTask && pendingConversationId && (
        <div className="bg-accent/10 border border-accent/30 rounded-lg p-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-accent">Pending Task</div>
            <p className="text-xs text-text-muted mt-1">{decodeURIComponent(pendingTask)}</p>
          </div>
          <button
            onClick={async () => {
              setExecuting(true);
              try {
                const res = await fetch(`/api/conversation/${pendingConversationId}/execute`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ task: decodeURIComponent(pendingTask) }),
                });
                if (!res.ok) throw new Error("Failed to execute");
                router.push(`/conversation/${pendingConversationId}`);
              } catch (err) {
                console.error("Execute:", err);
                setError("Failed to execute task.");
              } finally {
                setExecuting(false);
              }
            }}
            disabled={executing}
            className="bg-accent hover:bg-accent-hover text-white text-sm px-6 py-2 rounded-lg transition-colors font-medium"
          >
            {executing ? "Executing..." : "Execute Task"}
          </button>
        </div>
      )}

      {showForm && (
        <div className="bg-bg-card border border-border rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-text-muted block mb-1">Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
                placeholder="Agent name"
              />
            </div>
            <div>
              <label className="text-xs text-text-muted block mb-1">Role</label>
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
              >
                <option value="underboss">Underboss</option>
                <option value="capo">Capo</option>
                <option value="soldier">Soldier</option>
                <option value="tester">Tester</option>
                <option value="analyst">Analyst (Visual/Kimi)</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-text-muted block mb-1">Model</label>
              <select
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                className="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
              >
                <optgroup label="Anthropic (Claude)">
                  <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
                  <option value="claude-sonnet-4-5-20250929">Sonnet 4.5</option>
                </optgroup>
                <optgroup label="Kimi 2.5 (Moonshot)">
                  <option value="kimi-2.5-latest">Kimi 2.5 Latest</option>
                </optgroup>
                <optgroup label="Anthropic (Other)">
                  <option value="claude-opus-4-5-20251101">Opus 4.5</option>
                </optgroup>
              </select>
            </div>
            <div>
              <label className="text-xs text-text-muted block mb-1">Reports to</label>
              <select
                value={form.parentId}
                onChange={(e) => setForm({ ...form, parentId: e.target.value })}
                className="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
              >
                <option value="">None (top level)</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({a.role})</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-text-muted block mb-1">System Prompt</label>
            <textarea
              value={form.systemPrompt}
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
              className="w-full bg-bg border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-accent resize-none h-20 font-mono"
              placeholder="Instructions for this agent..."
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="text-text-muted text-sm px-3 py-1.5 hover:text-text transition-colors">Cancel</button>
            <button onClick={createAgent} className="bg-accent hover:bg-accent-hover text-white text-sm px-4 py-1.5 rounded transition-colors">Create</button>
          </div>
        </div>
      )}

      {/* Canvas */}
      <div
        ref={canvasRef}
        className="relative bg-bg-card border border-border rounded-lg overflow-hidden select-none"
        style={{ height: "calc(100vh - 220px)", cursor: isPanning ? "grabbing" : connecting ? "crosshair" : "grab" }}
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Grid */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ opacity: 0.15 }}>
          <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse" x={pan.x % 40} y={pan.y % 40}>
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#2a2a3a" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>

        {/* SVG connectors */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ overflow: "visible" }}>
          <defs>
            <marker id="arrow-delegate" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill={ACTION_COLORS.delegate} />
            </marker>
            <marker id="arrow-collaborate" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill={ACTION_COLORS.collaborate} />
            </marker>
            <marker id="arrow-collaborate-rev" markerWidth="8" markerHeight="6" refX="0" refY="3" orient="auto">
              <polygon points="8 0, 0 3, 8 6" fill={ACTION_COLORS.collaborate} />
            </marker>
            <marker id="arrow-reports" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#ef4444" />
            </marker>
          </defs>
          <g transform={`translate(${pan.x}, ${pan.y})`}>
            {/* Relationship connectors */}
            {relationships.map((rel) => {
              const from = allNodes.find((a) => a.id === rel.fromAgentId);
              const to = allNodes.find((a) => a.id === rel.toAgentId);
              if (!from || !to) return null;
              if (!ACTION_COLORS[rel.action]) return null; // skip legacy relationship types

              const color = ACTION_COLORS[rel.action];
              const groupKey = getRelGroupKey(rel.fromAgentId, rel.toAgentId);
              const idx = relGroupIndex[rel.id] ?? 0;
              const total = relGroupCounts[groupKey] ?? 1;
              const info = getConnectorPath(from, to, idx, total);
              const isBidirectional = rel.action === "collaborate";

              return (
                <g
                  key={rel.id}
                  className="pointer-events-auto cursor-pointer"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setRelContextMenu({
                      rel,
                      fromName: from.name,
                      toName: to.name,
                      x: e.clientX,
                      y: e.clientY,
                    });
                  }}
                >
                  {/* Invisible fat hit area for easier clicking */}
                  <path
                    d={info.path}
                    fill="none"
                    stroke="transparent"
                    strokeWidth="12"
                  />
                  <path
                    d={info.path}
                    fill="none"
                    stroke={color}
                    strokeWidth="2"
                    markerEnd={`url(#arrow-${rel.action})`}
                    markerStart={isBidirectional ? `url(#arrow-${rel.action}-rev)` : undefined}
                  />
                  <text
                    x={info.labelX}
                    y={info.labelY}
                    fill={color}
                    fontSize="10"
                    textAnchor="middle"
                    className="font-mono"
                  >
                    {rel.action}
                  </text>
                </g>
              );
            })}

            {/* Underboss → Boss "Reports to" connectors */}
            {agents.filter((a) => a.role === "underboss").map((underboss) => {
              const info = getConnectorPath(underboss, BOSS_NODE);
              return (
                <g key={`reports-${underboss.id}`}>
                  <path
                    d={info.path}
                    fill="none"
                    stroke="#ef4444"
                    strokeWidth="2"
                    markerEnd="url(#arrow-reports)"
                  />
                  <text
                    x={info.labelX}
                    y={info.labelY}
                    fill="#ef4444"
                    fontSize="10"
                    textAnchor="middle"
                    className="font-mono"
                  >
                    Reports to
                  </text>
                </g>
              );
            })}

            {/* Active connector being drawn */}
            {connecting && (
              <line
                x1={connecting.fromX}
                y1={connecting.fromY}
                x2={connecting.mouseX}
                y2={connecting.mouseY}
                stroke={ACTION_COLORS[connectAction] || "#8b5cf6"}
                strokeWidth="2"
                strokeDasharray="6 4"
              />
            )}
          </g>
        </svg>

        {/* Nodes layer */}
        <div className="absolute inset-0" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
          {/* Big Boss node */}
          <NodeComponent
            node={BOSS_NODE}
            isBoss={true}
            connecting={connecting}
            connectAction={connectAction}
            onMouseDown={handleNodeMouseDown}
            onContextMenu={handleNodeContextMenu}
            onStartConnecting={startConnecting}
            onReceiveConnection={(nodeId) => {
              if (connecting) {
                createRelationship(connecting.fromId, nodeId);
                setConnecting(null);
              }
            }}
          />

          {/* Agent nodes */}
          {agents.map((agent) => (
            <NodeComponent
              key={agent.id}
              node={agent}
              isBoss={false}
              connecting={connecting}
              connectAction={connectAction}
              onMouseDown={handleNodeMouseDown}
              onContextMenu={handleNodeContextMenu}
              onStartConnecting={startConnecting}
              onReceiveConnection={(nodeId) => {
                if (connecting) {
                  createRelationship(connecting.fromId, nodeId);
                  setConnecting(null);
                }
              }}
            />
          ))}
        </div>

        {/* Empty state */}
        {agents.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-text-muted text-sm">Add agents to start building your organization.</p>
          </div>
        )}

        {/* Connecting indicator */}
        {connecting && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-bg border border-border rounded px-3 py-1 text-xs text-text-muted z-20">
            Click a target agent &middot; <span style={{ color: ACTION_COLORS[connectAction] }}>{connectAction}</span> &middot; Esc to cancel
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (() => {
        const agentRels = relationships.filter(
          (r) => ACTION_COLORS[r.action] && (r.fromAgentId === contextMenu.agentId || r.toAgentId === contextMenu.agentId)
        );
        return (
          <div
            className="fixed bg-bg-card border border-border rounded-lg shadow-lg py-1 z-50 min-w-[220px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => openEditForm(contextMenu.agentId)}
              className="w-full text-left px-4 py-1.5 text-sm text-text hover:bg-bg-hover transition-colors"
            >
              Edit Agent
            </button>
            <button
              onClick={() => {
                router.push(`/configure/${contextMenu.agentId}`);
                setContextMenu(null);
              }}
              className="w-full text-left px-4 py-1.5 text-sm text-text hover:bg-bg-hover transition-colors"
            >
              Full Config Page
            </button>
            {agentRels.length > 0 && (
              <>
                <div className="border-t border-border my-1" />
                <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-text-muted">Relationships</div>
                {agentRels.map((rel) => {
                  const other = rel.fromAgentId === contextMenu.agentId
                    ? allNodes.find((a) => a.id === rel.toAgentId)
                    : allNodes.find((a) => a.id === rel.fromAgentId);
                  const otherName = other?.name || "?";
                  const arrow = rel.action === "collaborate" ? "\u2194" : (rel.fromAgentId === contextMenu.agentId ? "\u2192" : "\u2190");
                  return (
                    <div key={rel.id} className="flex items-center justify-between px-4 py-1 hover:bg-bg-hover group/rel">
                      <span className="text-xs">
                        <span style={{ color: ACTION_COLORS[rel.action] }}>{rel.action}</span>
                        {" "}{arrow} {otherName}
                      </span>
                      <button
                        onClick={() => { deleteRelationship(rel.id); setContextMenu(null); }}
                        className="text-[10px] text-text-muted hover:text-danger opacity-0 group-hover/rel:opacity-100 transition-opacity"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </>
            )}
            <div className="border-t border-border my-1" />
            <button
              onClick={() => deleteAgent(contextMenu.agentId)}
              className="w-full text-left px-4 py-1.5 text-sm text-danger hover:bg-danger/10 transition-colors"
            >
              Delete Agent
            </button>
          </div>
        );
      })()}

      {/* Relationship context menu */}
      {relContextMenu && (
        <div
          className="fixed bg-bg-card border border-border rounded-lg shadow-lg py-1 z-50 min-w-[200px]"
          style={{ left: relContextMenu.x, top: relContextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-1.5 text-xs text-text-muted border-b border-border">
            <span style={{ color: ACTION_COLORS[relContextMenu.rel.action] || "#6a6a7a" }}>
              {relContextMenu.rel.action}
            </span>
            {" "}
            {relContextMenu.rel.action === "collaborate"
              ? `${relContextMenu.fromName} \u2194 ${relContextMenu.toName}`
              : `${relContextMenu.fromName} \u2192 ${relContextMenu.toName}`}
          </div>
          <button
            onClick={() => {
              deleteRelationship(relContextMenu.rel.id);
              setRelContextMenu(null);
            }}
            className="w-full text-left px-4 py-1.5 text-sm text-danger hover:bg-danger/10 transition-colors"
          >
            Delete Relationship
          </button>
        </div>
      )}

      {/* Edit panel (inline, above canvas like add form) */}
      {editForm && !showForm && (
        <div className="bg-bg-card border border-accent/30 rounded-lg p-4 space-y-3">
          <h2 className="text-sm font-medium text-accent">Editing: {editForm.name}</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-text-muted block mb-1">Name</label>
                <input
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  className="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted block mb-1">Role</label>
                <select
                  value={editForm.role}
                  onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                  className="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
                >
                  <option value="underboss">Underboss</option>
                  <option value="capo">Capo</option>
                  <option value="soldier">Soldier</option>
                  <option value="tester">Tester</option>
                  <option value="analyst">Analyst (Visual/Kimi)</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted block mb-1">Model</label>
                <select
                  value={editForm.model}
                  onChange={(e) => setEditForm({ ...editForm, model: e.target.value })}
                  className="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
                >
                  <optgroup label="Anthropic (Claude)">
                    <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
                    <option value="claude-sonnet-4-5-20250929">Sonnet 4.5</option>
                    <option value="claude-opus-4-5-20251101">Opus 4.5</option>
                  </optgroup>
                  <optgroup label="Kimi 2.5 (Moonshot)">
                    <option value="kimi-2.5-latest">Kimi 2.5 Latest</option>
                  </optgroup>
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted block mb-1">Reports to</label>
                <select
                  value={editForm.parentId}
                  onChange={(e) => setEditForm({ ...editForm, parentId: e.target.value })}
                  className="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
                >
                  <option value="">None (top level)</option>
                  {agents.filter((a) => a.id !== editForm.agentId).map((a) => (
                    <option key={a.id} value={a.id}>{a.name} ({a.role})</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-text-muted block mb-1">System Prompt</label>
              <textarea
                value={editForm.systemPrompt}
                onChange={(e) => setEditForm({ ...editForm, systemPrompt: e.target.value })}
                className="w-full bg-bg border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-accent resize-none h-40 font-mono"
                placeholder="Instructions for this agent..."
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditForm(null)} className="text-text-muted text-sm px-3 py-1.5 hover:text-text transition-colors">Cancel</button>
              <button
                onClick={saveEditForm}
                disabled={saving}
                className="bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-sm px-4 py-1.5 rounded transition-colors"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-6 text-xs text-text-muted">
        <span>Drag to move &middot; Right-click to edit &middot; Hover ports to connect &middot; Right-click connector to delete</span>
        <div className="flex items-center gap-3 ml-auto">
          {Object.entries(ACTION_COLORS).map(([action, color]) => (
            <div key={action} className="flex items-center gap-1">
              <div className="w-3 h-0.5" style={{ backgroundColor: color }} />
              <span>{action}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Import Modal */}
      {showImportModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-bg-card border border-border rounded-lg p-6 w-full max-w-lg">
            <h2 className="text-lg font-bold mb-4">Import Configuration</h2>
            {importError && (
              <div className="text-red-500 text-sm mb-3">{importError}</div>
            )}
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              className="w-full h-40 bg-bg border border-border rounded p-3 text-sm font-mono focus:outline-none focus:border-accent resize-none"
              placeholder="Paste base64 encoded configuration..."
            />
            <div className="flex justify-end gap-3 mt-4">
              <button
                onClick={() => {
                  setShowImportModal(false);
                  setImportText("");
                  setImportError(null);
                }}
                className="text-text-muted text-sm px-3 py-1.5 hover:text-text transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={importing || !importText.trim()}
                className="bg-accent hover:bg-accent-hover text-white text-sm px-4 py-1.5 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {importing ? "Importing..." : "Import"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save Template Modal */}
      {showSaveTemplate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-bg-card border border-border rounded-lg p-6 w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">Save as Template</h2>
            <input
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="Template name..."
              className="w-full bg-bg border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-accent mb-4"
            />
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowSaveTemplate(false);
                  setTemplateName("");
                }}
                className="text-text-muted text-sm px-3 py-1.5 hover:text-text"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (!templateName.trim()) return;
                  setSavingTemplate(true);
                  try {
                    await fetch("/api/org-templates", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name: templateName, agents, relationships }),
                    });
                    setShowSaveTemplate(false);
                    setTemplateName("");
                  } catch (err) {
                    console.error(err);
                    setError("Failed to save template.");
                  } finally {
                    setSavingTemplate(false);
                  }
                }}
                disabled={savingTemplate || !templateName.trim()}
                className="bg-accent hover:bg-accent-hover text-white text-sm px-4 py-1.5 rounded disabled:opacity-50"
              >
                {savingTemplate ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Load Template Modal */}
      {showLoadTemplates && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-bg-card border border-border rounded-lg p-6 w-full max-w-lg">
            <h2 className="text-lg font-bold mb-4">Load Template</h2>
            {templates.length === 0 ? (
              <p className="text-text-muted text-sm">No templates saved yet.</p>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {templates.map((t: any) => (
                  <div key={t.id} className="flex items-center justify-between bg-bg rounded p-3 border border-border">
                    <div>
                      <div className="text-sm font-medium">{t.name}</div>
                      <div className="text-xs text-text-muted">{new Date(t.createdAt).toLocaleDateString()}</div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={async () => {
                          try {
                            const agentsData = typeof t.agents === "string" ? JSON.parse(t.agents) : t.agents;
                            const relsData = typeof t.relationships === "string" ? JSON.parse(t.relationships) : t.relationships;
                            const idMapping: Record<string, string> = {};
                            for (const agent of agentsData) {
                              const res = await fetch("/api/agents", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  name: agent.name,
                                  role: agent.role,
                                  specialty: agent.specialty,
                                  systemPrompt: agent.systemPrompt,
                                  model: agent.model,
                                  parentId: null,
                                  posX: agent.posX ?? 100 + Math.random() * 400,
                                  posY: agent.posY ?? 100 + Math.random() * 300
                                }),
                              });
                              if (!res.ok) throw new Error("Failed to create agent");
                              const newAgent = await res.json();
                              idMapping[agent.id] = newAgent.id;
                            }
                            for (const agent of agentsData) {
                              if (agent.parentId && idMapping[agent.parentId]) {
                                await fetch(`/api/agents/${idMapping[agent.id]}`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ parentId: idMapping[agent.parentId] }),
                                });
                              }
                            }
                            for (const rel of relsData) {
                              const fromId = idMapping[rel.fromAgentId];
                              const toId = idMapping[rel.toAgentId];
                              if (!fromId || !toId) continue;
                              await fetch("/api/relationships", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ fromAgentId: fromId, toAgentId: toId, action: rel.action, cardinality: rel.cardinality }),
                              });
                            }
                            await loadData();
                            setShowLoadTemplates(false);
                          } catch (err) {
                            console.error(err);
                            setError("Failed to load template.");
                          }
                        }}
                        className="text-xs px-3 py-1 rounded bg-accent/10 text-accent hover:bg-accent hover:text-white transition-colors"
                      >
                        Load
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            await fetch(`/api/org-templates/${t.id}`, { method: "DELETE" });
                            loadTemplates();
                          } catch (err) {
                            console.error(err);
                          }
                        }}
                        className="text-xs px-2 py-1 text-danger hover:bg-danger/10 rounded transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end mt-4">
              <button
                onClick={() => setShowLoadTemplates(false)}
                className="text-text-muted text-sm px-3 py-1.5 hover:text-text"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ConfigurePage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <ConfigurePageInner />
    </Suspense>
  );
}

// Node component for both Boss and regular agents
function NodeComponent({
  node,
  isBoss,
  connecting,
  connectAction,
  onMouseDown,
  onContextMenu,
  onStartConnecting,
  onReceiveConnection,
}: {
  node: Agent;
  isBoss: boolean;
  connecting: ConnectingState;
  connectAction: string;
  onMouseDown: (e: React.MouseEvent, id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onStartConnecting: (e: React.MouseEvent, id: string) => void;
  onReceiveConnection: (id: string) => void;
}) {
  const borderColor = ROLE_COLORS[node.role] || "#2a2a3a";
  const portStyle = connecting
    ? { opacity: 1, borderColor: ACTION_COLORS[connectAction], cursor: "pointer" as const }
    : {};

  const portClass = "absolute w-4 h-4 rounded-full border-2 border-border bg-bg-card hover:bg-accent hover:border-accent transition-colors opacity-0 group-hover:opacity-100 z-10";

  return (
    <div
      className="absolute group"
      style={{ left: node.posX, top: node.posY, width: NODE_W, height: NODE_H }}
    >
      <div
        className={`w-full h-full border-2 rounded-lg px-3 py-2 flex flex-col justify-between cursor-move hover:bg-bg-hover transition-colors ${isBoss ? "bg-bg-hover" : "bg-bg"}`}
        style={{ borderColor }}
        onMouseDown={(e) => onMouseDown(e, node.id)}
        onContextMenu={(e) => onContextMenu(e, node.id)}
      >
        <div className="flex items-center justify-between">
          <span className="text-xs font-mono uppercase font-bold" style={{ color: borderColor }}>
            {isBoss ? "BIG BOSS" : node.role}
          </span>
          {!isBoss && (
            <span className="text-[10px] text-text-muted">
              {MODEL_LABELS[node.model] || ""}
            </span>
          )}
        </div>
        <div className="text-sm font-medium truncate">{isBoss ? "You" : node.name}</div>
        {!isBoss && node.systemPrompt && (
          <div className="text-[10px] text-text-muted truncate">{node.systemPrompt.slice(0, 50)}</div>
        )}
        {isBoss && (
          <div className="text-[10px] text-text-muted">Human operator</div>
        )}
      </div>

      {/* Ports on all 4 sides */}
      {/* Bottom */}
      <div
        className={`${portClass} -bottom-2 left-1/2 -translate-x-1/2 cursor-crosshair`}
        style={portStyle}
        onMouseDown={(e) => {
          if (connecting) { e.stopPropagation(); onReceiveConnection(node.id); }
          else onStartConnecting(e, node.id);
        }}
      />
      {/* Top */}
      <div
        className={`${portClass} -top-2 left-1/2 -translate-x-1/2`}
        style={portStyle}
        onMouseDown={(e) => {
          if (connecting) { e.stopPropagation(); onReceiveConnection(node.id); }
          else onStartConnecting(e, node.id);
        }}
      />
      {/* Left */}
      <div
        className={`${portClass} top-1/2 -translate-y-1/2 -left-2`}
        style={portStyle}
        onMouseDown={(e) => {
          if (connecting) { e.stopPropagation(); onReceiveConnection(node.id); }
          else onStartConnecting(e, node.id);
        }}
      />
      {/* Right */}
      <div
        className={`${portClass} top-1/2 -translate-y-1/2 -right-2`}
        style={portStyle}
        onMouseDown={(e) => {
          if (connecting) { e.stopPropagation(); onReceiveConnection(node.id); }
          else onStartConnecting(e, node.id);
        }}
      />
    </div>
  );
}
