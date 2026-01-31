"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

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
};

const ACTION_COLORS: Record<string, string> = {
  delegate: "#8b5cf6",
  ask: "#3b82f6",
  review: "#22c55e",
  summarize: "#f59e0b",
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

export default function ConfigurePage() {
  const router = useRouter();
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
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    role: "soldier" as string,
    model: "claude-sonnet-4-5-20250929",
    parentId: "",
    systemPrompt: "",
  });

  // All nodes including boss
  const allNodes = [BOSS_NODE, ...agents];

  const loadData = useCallback(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then(setAgents);
    fetch("/api/relationships")
      .then((r) => r.json())
      .then(setRelationships);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Close context menu on click anywhere
  useEffect(() => {
    const handler = () => setContextMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, []);

  // Esc to cancel connecting or close modal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConnecting(null);
        setContextMenu(null);
        setEditForm(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const createAgent = async () => {
    if (!form.name.trim()) return;
    const cx = -pan.x + 400 + Math.random() * 200;
    const cy = -pan.y + 200 + Math.random() * 200;
    await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        parentId: form.parentId || null,
        posX: cx,
        posY: cy,
      }),
    });
    setForm({ name: "", role: "soldier", model: "claude-sonnet-4-5-20250929", parentId: "", systemPrompt: "" });
    setShowForm(false);
    loadData();
  };

  const updateAgentPos = async (id: string, posX: number, posY: number) => {
    if (id === BOSS_ID) return; // Boss position is local-only
    await fetch(`/api/agents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posX, posY }),
    });
  };

  const createRelationship = async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    // Boss connections are visual-only for now (boss is not a DB agent)
    if (fromId === BOSS_ID || toId === BOSS_ID) return;
    await fetch("/api/relationships", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromAgentId: fromId,
        toAgentId: toId,
        action: connectAction,
      }),
    });
    loadData();
  };

  const deleteRelationship = async (relId: string) => {
    await fetch(`/api/relationships/${relId}`, { method: "DELETE" });
    loadData();
  };

  const deleteAgent = async (agentId: string) => {
    if (agentId === BOSS_ID) return;
    const agent = agents.find((a) => a.id === agentId);
    if (!confirm(`Delete ${agent?.name}? This will also delete all subordinates.`)) return;
    await fetch(`/api/agents/${agentId}`, { method: "DELETE" });
    setContextMenu(null);
    loadData();
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
    await fetch(`/api/agents/${editForm.agentId}`, {
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
    setSaving(false);
    setEditForm(null);
    loadData();
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

  // Hierarchy lines
  const hierarchyLines: { from: Agent; to: Agent }[] = [];
  for (const agent of agents) {
    if (agent.parentId) {
      const parent = agents.find((a) => a.id === agent.parentId);
      if (parent) hierarchyLines.push({ from: parent, to: agent });
    }
    // Underbosses connect to big boss
    if (agent.role === "underboss") {
      hierarchyLines.push({ from: BOSS_NODE, to: agent });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Organization</h1>
          <p className="text-text-muted text-sm">Drag to move. Hover ports to connect. Right-click to edit.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 bg-bg-card border border-border rounded px-2 py-1">
            <span className="text-xs text-text-muted mr-1">Connect as:</span>
            {["delegate", "ask", "review", "summarize"].map((a) => (
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
            onClick={() => setShowForm(!showForm)}
            className="bg-accent hover:bg-accent-hover text-white text-sm px-4 py-2 rounded transition-colors"
          >
            + Add Agent
          </button>
        </div>
      </div>

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
              </select>
            </div>
            <div>
              <label className="text-xs text-text-muted block mb-1">Model</label>
              <select
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                className="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
              >
                <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
                <option value="claude-sonnet-4-5-20250929">Sonnet 4.5</option>
                <option value="claude-opus-4-5-20251101">Opus 4.5</option>
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
            <marker id="arrow-ask" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill={ACTION_COLORS.ask} />
            </marker>
            <marker id="arrow-review" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill={ACTION_COLORS.review} />
            </marker>
            <marker id="arrow-summarize" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill={ACTION_COLORS.summarize} />
            </marker>
          </defs>
          <g transform={`translate(${pan.x}, ${pan.y})`}>
            {/* Hierarchy lines (dashed) */}
            {hierarchyLines.map(({ from, to }) => {
              const info = getConnectorPath(from, to);
              return (
                <path
                  key={`h-${from.id}-${to.id}`}
                  d={info.path}
                  fill="none"
                  stroke="#2a2a3a"
                  strokeWidth="1.5"
                  strokeDasharray="6 4"
                />
              );
            })}

            {/* Relationship connectors */}
            {relationships.map((rel) => {
              const from = allNodes.find((a) => a.id === rel.fromAgentId);
              const to = allNodes.find((a) => a.id === rel.toAgentId);
              if (!from || !to) return null;

              const color = ACTION_COLORS[rel.action] || "#6a6a7a";
              const groupKey = getRelGroupKey(rel.fromAgentId, rel.toAgentId);
              const idx = relGroupIndex[rel.id] ?? 0;
              const total = relGroupCounts[groupKey] ?? 1;
              const info = getConnectorPath(from, to, idx, total);

              return (
                <g key={rel.id} className="pointer-events-auto cursor-pointer" onClick={() => deleteRelationship(rel.id)}>
                  <path
                    d={info.path}
                    fill="none"
                    stroke={color}
                    strokeWidth="2"
                    markerEnd={`url(#arrow-${rel.action})`}
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
      {contextMenu && (
        <div
          className="fixed bg-bg-card border border-border rounded-lg shadow-lg py-1 z-50"
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
          <div className="border-t border-border my-1" />
          <button
            onClick={() => deleteAgent(contextMenu.agentId)}
            className="w-full text-left px-4 py-1.5 text-sm text-danger hover:bg-danger/10 transition-colors"
          >
            Delete Agent
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
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted block mb-1">Model</label>
                <select
                  value={editForm.model}
                  onChange={(e) => setEditForm({ ...editForm, model: e.target.value })}
                  className="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
                >
                  <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
                  <option value="claude-sonnet-4-5-20250929">Sonnet 4.5</option>
                  <option value="claude-opus-4-5-20251101">Opus 4.5</option>
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
        <span>Drag to move &middot; Right-click to edit &middot; Hover ports to connect &middot; Click connector to delete</span>
        <div className="flex items-center gap-3 ml-auto">
          {Object.entries(ACTION_COLORS).map(([action, color]) => (
            <div key={action} className="flex items-center gap-1">
              <div className="w-3 h-0.5" style={{ backgroundColor: color }} />
              <span>{action}</span>
            </div>
          ))}
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 border-t border-dashed border-border" />
            <span>hierarchy</span>
          </div>
        </div>
      </div>
    </div>
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
