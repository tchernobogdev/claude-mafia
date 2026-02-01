"use client";

import { useEffect, useState } from "react";

export default function SettingsPage() {
  const [maxAgentTurns, setMaxAgentTurns] = useState<string>("200");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error(`Failed to load settings (${res.status})`);
      const data = await res.json();
      if (data.maxAgentTurns) {
        setMaxAgentTurns(data.maxAgentTurns);
      }
    } catch (err) {
      console.error("loadSettings:", err);
      setError("Failed to load settings. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const saveSettings = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(false);

      const num = parseInt(maxAgentTurns, 10);
      if (isNaN(num) || num <= 0) {
        setError("Max Agent Turns must be a positive integer");
        return;
      }

      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "maxAgentTurns", value: maxAgentTurns }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || `Request failed (${res.status})`);
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      console.error("saveSettings:", err);
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-text-muted text-sm mt-1">Configure system-wide settings for Agent Mafia</p>
      </div>

      {error && (
        <div className="bg-danger/10 border border-danger text-danger px-4 py-3 rounded flex items-center justify-between">
          <span className="text-sm">{error}</span>
          <button onClick={() => setError(null)} className="text-danger hover:text-danger/80 text-lg">×</button>
        </div>
      )}

      {success && (
        <div className="bg-accent/10 border border-accent text-accent px-4 py-3 rounded text-sm">
          Settings saved successfully!
        </div>
      )}

      <div className="bg-bg-card border border-border rounded-lg p-6 space-y-4">
        <div>
          <label htmlFor="maxAgentTurns" className="block text-sm font-medium mb-2">
            Max Agent Turns
          </label>
          <p className="text-text-muted text-xs mb-3">
            Maximum number of turns (API round-trips) an agent can take before stopping. Higher values allow for more complex tasks but increase costs.
          </p>
          <input
            id="maxAgentTurns"
            type="number"
            min="1"
            value={maxAgentTurns}
            onChange={(e) => setMaxAgentTurns(e.target.value)}
            disabled={loading || saving}
            className="w-full max-w-xs bg-bg border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-accent disabled:opacity-50"
            placeholder="200"
          />
        </div>

        <div className="flex justify-end pt-2">
          <button
            onClick={saveSettings}
            disabled={loading || saving}
            className="bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-6 py-2 rounded transition-colors"
          >
            {saving ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}
