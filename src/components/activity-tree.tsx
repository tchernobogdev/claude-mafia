"use client";

import { useEffect, useState, useRef, useMemo } from "react";

interface Agent {
  id: string;
  name: string;
  role: string;
  specialty?: string | null;
  parentId: string | null;
}

interface TargetAgent {
  id: string;
  name: string;
  role: string;
}

export interface TreeActivityItem {
  id: string;
  type: string;
  agentId?: string;
  agentName?: string;
  tool?: string;
  targetAgents?: TargetAgent[];
  timestamp: number;
}

interface ArrowAnim {
  id: string;
  fromId: string;
  toId: string;
  color: string;
  label: string;
  createdAt: number;
  lifetime: number;
}

const ROLE_COLORS: Record<string, string> = {
  underboss: "#8b5cf6",
  capo: "#facc15",
  soldier: "#6a6a7a",
};

const ACTION_COLORS: Record<string, string> = {
  delegate_task: "#a78bfa",
  ask_agent: "#60a5fa",
  review_work: "#fbbf24",
  summarize_for: "#34d399",
  escalate_to_boss: "#f87171",
  read_file: "#22d3ee",
  write_file: "#fb923c",
  list_files: "#22d3ee",
  run_command: "#c084fc",
  response: "#22c55e",
  thinking: "#94a3b8",
  delegating: "#a78bfa",
};

const ACTION_SHORT: Record<string, string> = {
  delegate_task: "delegate",
  ask_agent: "ask",
  review_work: "review",
  summarize_for: "summarize",
  escalate_to_boss: "escalate",
  response: "response",
};

const ARROW_LIFETIME = 4000;
const RESPONSE_ARROW_LIFETIME = 6000;
const NODE_RADIUS = 18;
const NODE_COL_WIDTH = 120;
const LEVEL_HEIGHT = 110;

interface Props {
  activity: TreeActivityItem[];
}

export function ActivityTree({ activity }: Props) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [arrows, setArrows] = useState<ArrowAnim[]>([]);
  const [activeAgentIds, setActiveAgentIds] = useState<Set<string>>(new Set());
  const [activeAgentStatus, setActiveAgentStatus] = useState<Map<string, string>>(new Map());
  const processedRef = useRef(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data: Agent[]) => setAgents(data));
  }, []);

  // Build tree layout with no overlap — each node gets its own column
  const { nodes, staticEdges, viewW, viewH, parentMap } = useMemo(() => {
    if (agents.length === 0) return { nodes: [], staticEdges: [], viewW: 400, viewH: 300, parentMap: new Map<string, string>() };

    // Build parent→children map
    const childrenMap = new Map<string | null, Agent[]>();
    const pMap = new Map<string, string>();
    for (const a of agents) {
      const k = a.parentId;
      if (!childrenMap.has(k)) childrenMap.set(k, []);
      childrenMap.get(k)!.push(a);
      if (a.parentId) pMap.set(a.id, a.parentId);
    }

    const roots = agents.filter((a) => !a.parentId);
    if (roots.length === 0) return { nodes: [], staticEdges: [], viewW: 400, viewH: 300, parentMap: pMap };

    // Compute subtree widths (leaf count) for centering parents over children
    const leafCount = new Map<string, number>();
    function countLeaves(id: string): number {
      const children = childrenMap.get(id) || [];
      if (children.length === 0) { leafCount.set(id, 1); return 1; }
      const total = children.reduce((sum, c) => sum + countLeaves(c.id), 0);
      leafCount.set(id, total);
      return total;
    }
    for (const r of roots) countLeaves(r.id);

    const totalLeaves = roots.reduce((s, r) => s + (leafCount.get(r.id) || 1), 0);
    const PADDING_X = 40;
    const viewW = Math.max(400, totalLeaves * NODE_COL_WIDTH + PADDING_X * 2);
    const PADDING_Y = 45;

    // BFS to find max depth
    const levels: Agent[][] = [];
    let current = roots;
    while (current.length > 0) {
      levels.push(current);
      const next: Agent[] = [];
      for (const a of current) next.push(...(childrenMap.get(a.id) || []));
      current = next;
    }
    const viewH = Math.max(280, levels.length * LEVEL_HEIGHT + PADDING_Y * 2);

    // Position nodes: each leaf gets a column, parents center above their children
    const positions: { agent: Agent; x: number; y: number }[] = [];
    const posMap = new Map<string, { x: number; y: number }>();
    let leafIndex = 0;

    function layout(agentId: string, depth: number): { x: number } {
      const children = childrenMap.get(agentId) || [];
      const y = PADDING_Y + depth * LEVEL_HEIGHT;
      const agent = agents.find((a) => a.id === agentId)!;

      if (children.length === 0) {
        const x = PADDING_X + leafIndex * NODE_COL_WIDTH + NODE_COL_WIDTH / 2;
        leafIndex++;
        positions.push({ agent, x, y });
        posMap.set(agentId, { x, y });
        return { x };
      }

      const childPositions = children.map((c) => layout(c.id, depth + 1));
      const x = (childPositions[0].x + childPositions[childPositions.length - 1].x) / 2;
      positions.push({ agent, x, y });
      posMap.set(agentId, { x, y });
      return { x };
    }

    for (const r of roots) layout(r.id, 0);

    // Static edges
    const edgeList: { from: { x: number; y: number }; to: { x: number; y: number } }[] = [];
    for (const a of agents) {
      if (a.parentId && posMap.has(a.parentId) && posMap.has(a.id)) {
        edgeList.push({ from: posMap.get(a.parentId)!, to: posMap.get(a.id)! });
      }
    }

    return { nodes: positions, staticEdges: edgeList, viewW, viewH, parentMap: pMap };
  }, [agents]);

  const posMap = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const n of nodes) m.set(n.agent.id, { x: n.x, y: n.y });
    return m;
  }, [nodes]);

  const nameToId = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.name, a.id);
    return m;
  }, [agents]);

  // Process activity into arrows — both downward (delegation) and upward (responses)
  useEffect(() => {
    if (processedRef.current >= activity.length) return;
    const newItems = activity.slice(processedRef.current);
    processedRef.current = activity.length;

    const newArrows: ArrowAnim[] = [];
    const active = new Set(activeAgentIds);
    const statuses = new Map(activeAgentStatus);

    for (const item of newItems) {
      const sourceId = item.agentId || (item.agentName ? nameToId.get(item.agentName) : undefined);

      if (item.type === "start" && sourceId) {
        active.add(sourceId);
        statuses.set(sourceId, "thinking");
      }

      // Delegation / ask / review arrows: parent → child (downward)
      if (item.type === "tool" && sourceId && item.targetAgents && item.targetAgents.length > 0) {
        const color = ACTION_COLORS[item.tool || ""] || "#a78bfa";
        const label = ACTION_SHORT[item.tool || ""] || item.tool || "";
        // Update status to delegating for delegation tools
        const delegationTools = ["delegate_task", "ask_agent", "review_work", "summarize_for"];
        if (item.tool && delegationTools.includes(item.tool)) {
          statuses.set(sourceId, "delegating");
        }
        for (const t of item.targetAgents) {
          newArrows.push({
            id: crypto.randomUUID(),
            fromId: sourceId,
            toId: t.id,
            color,
            label,
            createdAt: Date.now(),
            lifetime: ARROW_LIFETIME,
          });
        }
      }

      // Tool result arrows: child → parent (upward) for tool responses
      if (item.type === "tool_result" && sourceId) {
        const parentId = parentMap.get(sourceId);
        if (parentId) {
          const toolShort = ACTION_SHORT[item.tool || ""] || item.tool || "result";
          const color = ACTION_COLORS[item.tool || ""] || ACTION_COLORS.response;
          newArrows.push({
            id: crypto.randomUUID(),
            fromId: sourceId,
            toId: parentId,
            color,
            label: `${toolShort} ←`,
            createdAt: Date.now(),
            lifetime: RESPONSE_ARROW_LIFETIME,
          });
        }
      }

      // Response arrows: child → parent (upward) when agent finishes or sends a message
      if ((item.type === "done" || item.type === "message") && sourceId) {
        if (item.type === "done") {
          active.delete(sourceId);
          statuses.delete(sourceId);
        }
        const parentId = parentMap.get(sourceId);
        if (parentId) {
          const agentLabel = item.agentName || "agent";
          newArrows.push({
            id: crypto.randomUUID(),
            fromId: sourceId,
            toId: parentId,
            color: ACTION_COLORS.response,
            label: `response ← ${agentLabel}`,
            createdAt: Date.now(),
            lifetime: RESPONSE_ARROW_LIFETIME,
          });
        }
      }
    }

    if (newArrows.length > 0) setArrows((prev) => [...prev, ...newArrows]);
    setActiveAgentIds(active);
    setActiveAgentStatus(statuses);
  }, [activity, activeAgentIds, activeAgentStatus, nameToId, parentMap]);

  // Animation tick + cleanup
  useEffect(() => {
    const interval = setInterval(() => {
      setTick((t) => t + 1);
      setArrows((prev) => {
        const now = Date.now();
        const filtered = prev.filter((a) => now - a.createdAt < a.lifetime);
        return filtered.length !== prev.length ? filtered : prev;
      });
    }, 60);
    return () => clearInterval(interval);
  }, []);

  if (nodes.length === 0) {
    return <div className="flex items-center justify-center h-full text-xs text-text-muted">Loading hierarchy...</div>;
  }

  return (
    <>
      <style>{`
        @keyframes neon-draw {
          0% { stroke-dashoffset: 1; opacity: 0; }
          8% { stroke-dashoffset: 0.2; opacity: 1; }
          18% { stroke-dashoffset: 0; opacity: 1; }
          30% { stroke-dashoffset: 0; opacity: 0.75; }
          100% { stroke-dashoffset: 0; opacity: 0; }
        }
        .neon-arrow {
          animation: neon-draw ${ARROW_LIFETIME}ms ease-out forwards;
          stroke-dasharray: 1;
        }
        @keyframes pulse-ring {
          0%, 100% { opacity: 0.15; }
          50% { opacity: 0.45; }
        }
        @keyframes status-pulse {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
      `}</style>
      <svg viewBox={`0 0 ${viewW} ${viewH}`} className="w-full h-full" style={{ minHeight: "280px" }}>
        <defs>
          <filter id="neon-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Static hierarchy edges */}
        {staticEdges.map((e, i) => (
          <line key={`e-${i}`} x1={e.from.x} y1={e.from.y} x2={e.to.x} y2={e.to.y} stroke="#1e1e2e" strokeWidth="1" strokeDasharray="4 3" />
        ))}

        {/* Animated neon arrows */}
        {arrows.map((arrow) => {
          const from = posMap.get(arrow.fromId);
          const to = posMap.get(arrow.toId);
          if (!from || !to) return null;

          // Curve the arrow to the side so it doesn't overlap the static edge
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const nx = -dy / len;
          const ny = dx / len;
          const curveMag = Math.min(len * 0.25, 35);
          const cx = (from.x + to.x) / 2 + nx * curveMag;
          const cy = (from.y + to.y) / 2 + ny * curveMag;

          // Shorten to stop at node edge
          const toD = Math.sqrt((to.x - cx) ** 2 + (to.y - cy) ** 2) || 1;
          const endX = to.x - ((to.x - cx) / toD) * (NODE_RADIUS + 2);
          const endY = to.y - ((to.y - cy) / toD) * (NODE_RADIUS + 2);
          const fromD = Math.sqrt((from.x - cx) ** 2 + (from.y - cy) ** 2) || 1;
          const startX = from.x + ((cx - from.x) / fromD) * (NODE_RADIUS + 2);
          const startY = from.y + ((cy - from.y) / fromD) * (NODE_RADIUS + 2);

          // Arrowhead
          const angle = Math.atan2(endY - cy, endX - cx);
          const aS = 7;
          const a1x = endX - aS * Math.cos(angle - 0.4);
          const a1y = endY - aS * Math.sin(angle - 0.4);
          const a2x = endX - aS * Math.cos(angle + 0.4);
          const a2y = endY - aS * Math.sin(angle + 0.4);

          return (
            <g key={arrow.id} className="neon-arrow" style={{ animationDuration: `${arrow.lifetime}ms` }}>
              <path
                d={`M ${startX} ${startY} Q ${cx} ${cy} ${endX} ${endY}`}
                fill="none"
                stroke={arrow.color}
                strokeWidth="2.5"
                pathLength={1}
                filter="url(#neon-glow)"
              />
              <polygon points={`${endX},${endY} ${a1x},${a1y} ${a2x},${a2y}`} fill={arrow.color} filter="url(#neon-glow)" />
              {arrow.label && (
                <text x={cx} y={cy - 7} textAnchor="middle" fill={arrow.color} fontSize="8" fontFamily="monospace" filter="url(#soft-glow)">
                  {arrow.label}
                </text>
              )}
            </g>
          );
        })}

        {/* Agent nodes */}
        {nodes.map((node) => {
          const isActive = activeAgentIds.has(node.agent.id);
          const rc = ROLE_COLORS[node.agent.role] || "#6a6a7a";

          return (
            <g key={node.agent.id}>
              {/* Pulse ring */}
              {isActive && (
                <circle cx={node.x} cy={node.y} r={NODE_RADIUS + 6} fill="none" stroke={rc} strokeWidth="1.5"
                  style={{ animation: "pulse-ring 2s ease-in-out infinite" }} />
              )}
              {/* Active glow */}
              {isActive && (
                <circle cx={node.x} cy={node.y} r={NODE_RADIUS} fill="none" stroke={rc} strokeWidth="1" opacity="0.25" filter="url(#soft-glow)" />
              )}
              {/* Circle */}
              <circle cx={node.x} cy={node.y} r={NODE_RADIUS} fill="#0d0d1a" stroke={rc}
                strokeWidth={isActive ? "2.5" : "1.5"} opacity={isActive ? 1 : 0.5} />
              {/* Role initial */}
              <text x={node.x} y={node.y + 5} textAnchor="middle" fill={rc} fontSize="14" fontWeight="bold" fontFamily="monospace"
                opacity={isActive ? 1 : 0.6}>
                {node.agent.role[0].toUpperCase()}
              </text>
              {/* Name — placed below node with enough gap */}
              <text x={node.x} y={node.y + NODE_RADIUS + 14} textAnchor="middle"
                fill={isActive ? "#d0d0e0" : "#4a4a5a"} fontSize="10" fontFamily="monospace">
                {node.agent.name.length > 12 ? node.agent.name.slice(0, 11) + "\u2026" : node.agent.name}
              </text>
              {/* Activity status indicator */}
              {activeAgentStatus.get(node.agent.id) && (
                <text x={node.x} y={node.y + NODE_RADIUS + 26} textAnchor="middle"
                  fill={ACTION_COLORS[activeAgentStatus.get(node.agent.id)!] || "#94a3b8"}
                  fontSize="7" fontFamily="monospace"
                  style={{ animation: "status-pulse 1.5s ease-in-out infinite" }}>
                  {activeAgentStatus.get(node.agent.id)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </>
  );
}
