"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import type { RelationshipAction } from "@/types";

interface Relationship {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  action: string;
  cardinality: string;
  fromAgent?: { name: string; role: string };
  toAgent?: { name: string; role: string };
}

interface Agent {
  id: string;
  name: string;
  role: string;
  specialty: string | null;
  systemPrompt: string;
  model: string;
  parentId: string | null;
  parent: { name: string; role: string } | null;
  children: { id: string; name: string; role: string }[];
  outgoingRels: Relationship[];
  incomingRels: Relationship[];
}

interface AgentListItem {
  id: string;
  name: string;
  role: string;
}

const ACTIONS: RelationshipAction[] = ["delegate", "ask", "review", "summarize"];
const CARDINALITY_LABELS: Record<string, string> = {
  "1:1": "1:1",
  "1:many": "1:many",
  "many:1": "many:1",
};

export default function AgentConfigPage() {
  const params = useParams();
  const router = useRouter();
  const agentId = params.agentId as string;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [allAgents, setAllAgents] = useState<AgentListItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    systemPrompt: "",
    model: "",
    specialty: "",
    role: "",
    parentId: "",
  });

  const [relForm, setRelForm] = useState({ action: "delegate" as string, toAgentId: "" });

  const loadAgent = useCallback(() => {
    fetch(`/api/agents/${agentId}`)
      .then((r) => r.json())
      .then((data: Agent) => {
        setAgent(data);
        setForm({
          name: data.name,
          systemPrompt: data.systemPrompt,
          model: data.model,
          specialty: data.specialty || "",
          role: data.role,
          parentId: data.parentId || "",
        });
      });
  }, [agentId]);

  useEffect(() => {
    loadAgent();
    fetch("/api/agents")
      .then((r) => r.json())
      .then(setAllAgents);
  }, [loadAgent]);

  const save = async () => {
    setSaving(true);
    await fetch(`/api/agents/${agentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        parentId: form.parentId || null,
      }),
    });
    setSaving(false);
    loadAgent();
  };

  const deleteAgent = async () => {
    if (!confirm(`Delete ${agent?.name}? This will also delete all subordinates.`)) return;
    await fetch(`/api/agents/${agentId}`, { method: "DELETE" });
    router.push("/configure");
  };

  const addRelationship = async () => {
    if (!relForm.toAgentId) return;
    await fetch("/api/relationships", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromAgentId: agentId,
        toAgentId: relForm.toAgentId,
        action: relForm.action,
      }),
    });
    setRelForm({ action: "delegate", toAgentId: "" });
    loadAgent();
  };

  const removeRelationship = async (relId: string) => {
    await fetch(`/api/relationships/${relId}`, { method: "DELETE" });
    loadAgent();
  };

  if (!agent) return <div className="text-text-muted text-sm">Loading...</div>;

  const otherAgents = allAgents.filter((a) => a.id !== agentId);

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <button onClick={() => router.push("/configure")} className="text-xs text-text-muted hover:text-text mb-2 block">
            &larr; Back to Organization
          </button>
          <h1 className="text-2xl font-bold">{agent.name}</h1>
          <span className="text-xs text-text-muted uppercase">{agent.role}</span>
        </div>
        <button
          onClick={deleteAgent}
          className="text-danger text-sm hover:bg-danger/10 px-3 py-1.5 rounded transition-colors"
        >
          Delete
        </button>
      </div>

      {/* Basic Info */}
      <div className="bg-bg-card border border-border rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-medium text-text-muted">Agent Settings</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-text-muted block mb-1">Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
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
              {otherAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.role})
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="text-xs text-text-muted block mb-1">System Prompt</label>
          <textarea
            value={form.systemPrompt}
            onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            className="w-full bg-bg border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-accent resize-none h-40 font-mono"
            placeholder="Instructions for this agent..."
          />
        </div>
        <div className="flex justify-end">
          <button
            onClick={save}
            disabled={saving}
            className="bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-sm px-4 py-1.5 rounded transition-colors"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {/* Relationships */}
      <div className="bg-bg-card border border-border rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-medium text-text-muted">Relationships (Outgoing)</h2>

        {agent.outgoingRels.length > 0 && (
          <div className="space-y-2">
            {agent.outgoingRels.map((rel) => (
              <div key={rel.id} className="flex items-center justify-between bg-bg rounded px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-accent font-mono text-xs">{rel.action}</span>
                  <span className="text-text-muted">&rarr;</span>
                  <span>{rel.toAgent?.name}</span>
                  <span className="text-xs text-text-muted">({CARDINALITY_LABELS[rel.cardinality] || rel.cardinality})</span>
                </div>
                <button
                  onClick={() => removeRelationship(rel.id)}
                  className="text-danger text-xs hover:bg-danger/10 px-2 py-1 rounded"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="text-xs text-text-muted block mb-1">Action</label>
            <select
              value={relForm.action}
              onChange={(e) => setRelForm({ ...relForm, action: e.target.value })}
              className="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
            >
              {ACTIONS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="text-xs text-text-muted block mb-1">Target Agent</label>
            <select
              value={relForm.toAgentId}
              onChange={(e) => setRelForm({ ...relForm, toAgentId: e.target.value })}
              className="w-full bg-bg border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
            >
              <option value="">Select agent...</option>
              {otherAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.role})</option>
              ))}
            </select>
          </div>
          <button
            onClick={addRelationship}
            disabled={!relForm.toAgentId}
            className="bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-sm px-4 py-1.5 rounded transition-colors"
          >
            Add
          </button>
        </div>
      </div>

      {/* Incoming Relationships */}
      {agent.incomingRels.length > 0 && (
        <div className="bg-bg-card border border-border rounded-lg p-4 space-y-3">
          <h2 className="text-sm font-medium text-text-muted">Relationships (Incoming)</h2>
          <div className="space-y-2">
            {agent.incomingRels.map((rel) => (
              <div key={rel.id} className="flex items-center gap-2 bg-bg rounded px-3 py-2 text-sm">
                <span>{rel.fromAgent?.name}</span>
                <span className="text-text-muted">&rarr;</span>
                <span className="text-accent font-mono text-xs">{rel.action}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
