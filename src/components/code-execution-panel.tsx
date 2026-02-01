"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";

export interface CompilationError {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  severity?: "error" | "warning";
}

export interface CodeExecutionResult {
  status: "success" | "error" | "running";
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  errors?: CompilationError[];
  browserUrl?: string;
  browserStatus?: string;
  timestamp: number;
}

interface Props {
  result: CodeExecutionResult;
  title?: string;
}

export function CodeExecutionPanel({ result, title = "Execution Result" }: Props) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["stdout"]));

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const statusColor = result.status === "success" ? "#22c55e" : result.status === "error" ? "#ef4444" : "#f59e0b";
  const statusIcon = result.status === "success" ? "✓" : result.status === "error" ? "✗" : "⟳";

  return (
    <div className="bg-bg-card border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-text">{title}</span>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded" style={{ backgroundColor: `${statusColor}20` }}>
            <span style={{ color: statusColor }} className="text-sm font-bold">{statusIcon}</span>
            <span style={{ color: statusColor }} className="text-xs font-medium uppercase">{result.status}</span>
          </div>
        </div>
        {result.exitCode !== undefined && (
          <span className="text-xs text-text-muted font-mono">Exit code: {result.exitCode}</span>
        )}
      </div>

      <div className="divide-y divide-border">
        {/* Compilation Errors Section */}
        {result.errors && result.errors.length > 0 && (
          <CollapsibleSection
            title="Compilation Errors"
            count={result.errors.length}
            isExpanded={expandedSections.has("errors")}
            onToggle={() => toggleSection("errors")}
            badge={{ text: String(result.errors.length), color: "#ef4444" }}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-text-muted border-b border-border">
                    <th className="text-left py-2 px-3 font-medium">Type</th>
                    <th className="text-left py-2 px-3 font-medium">File</th>
                    <th className="text-left py-2 px-3 font-medium">Location</th>
                    <th className="text-left py-2 px-3 font-medium">Message</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {result.errors.map((err, i) => (
                    <tr key={i} className="border-b border-border/50 hover:bg-bg-hover transition-colors">
                      <td className="py-2 px-3">
                        <span
                          className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase"
                          style={{
                            backgroundColor: err.severity === "warning" ? "#f59e0b20" : "#ef444420",
                            color: err.severity === "warning" ? "#f59e0b" : "#ef4444",
                          }}
                        >
                          {err.severity || "error"}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-accent truncate max-w-[200px]" title={err.file}>
                        {err.file || "-"}
                      </td>
                      <td className="py-2 px-3 text-text-muted">
                        {err.line ? `${err.line}${err.column ? `:${err.column}` : ""}` : "-"}
                      </td>
                      <td className="py-2 px-3 text-text">{err.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CollapsibleSection>
        )}

        {/* Standard Output Section */}
        {result.stdout && (
          <CollapsibleSection
            title="Standard Output"
            isExpanded={expandedSections.has("stdout")}
            onToggle={() => toggleSection("stdout")}
            icon="📄"
          >
            <CodeBlock code={result.stdout} language="text" />
          </CollapsibleSection>
        )}

        {/* Standard Error Section */}
        {result.stderr && (
          <CollapsibleSection
            title="Standard Error"
            isExpanded={expandedSections.has("stderr")}
            onToggle={() => toggleSection("stderr")}
            badge={{ text: "!", color: "#ef4444" }}
          >
            <CodeBlock code={result.stderr} language="text" />
          </CollapsibleSection>
        )}

        {/* Browser Debug Section */}
        {result.browserUrl && (
          <CollapsibleSection
            title="Browser Debug"
            isExpanded={expandedSections.has("browser")}
            onToggle={() => toggleSection("browser")}
            icon="🌐"
          >
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-muted font-medium">URL:</span>
                <a
                  href={result.browserUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent hover:underline font-mono"
                >
                  {result.browserUrl}
                </a>
              </div>
              {result.browserStatus && (
                <div className="flex items-start gap-2">
                  <span className="text-xs text-text-muted font-medium">Status:</span>
                  <p className="text-xs text-text flex-1">{result.browserStatus}</p>
                </div>
              )}
            </div>
          </CollapsibleSection>
        )}
      </div>
    </div>
  );
}

interface CollapsibleSectionProps {
  title: string;
  count?: number;
  isExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  icon?: string;
  badge?: { text: string; color: string };
}

function CollapsibleSection({ title, count, isExpanded, onToggle, children, icon, badge }: CollapsibleSectionProps) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-bg-hover transition-colors group"
      >
        <div className="flex items-center gap-2">
          <span className="text-text-muted group-hover:text-text transition-colors text-sm">
            {isExpanded ? "▼" : "▶"}
          </span>
          {icon && <span className="text-sm">{icon}</span>}
          <span className="text-sm font-medium text-text">{title}</span>
          {count !== undefined && <span className="text-xs text-text-muted">({count})</span>}
        </div>
        {badge && (
          <span
            className="px-2 py-0.5 rounded text-xs font-bold"
            style={{ backgroundColor: `${badge.color}20`, color: badge.color }}
          >
            {badge.text}
          </span>
        )}
      </button>
      {isExpanded && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

interface CodeBlockProps {
  code: string;
  language?: string;
}

function CodeBlock({ code, language = "text" }: CodeBlockProps) {
  return (
    <div className="relative bg-bg rounded border border-border overflow-hidden">
      <div className="absolute top-2 right-2 z-10">
        <button
          onClick={() => navigator.clipboard.writeText(code)}
          className="px-2 py-1 bg-bg-card border border-border rounded text-[10px] text-text-muted hover:text-text hover:border-accent transition-colors"
          title="Copy to clipboard"
        >
          Copy
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-xs font-mono text-text whitespace-pre-wrap max-h-[400px] overflow-y-auto">
        <code className={`language-${language}`}>{code}</code>
      </pre>
    </div>
  );
}

// Helper function to parse common error formats
export function parseCompilationErrors(stderr: string): CompilationError[] {
  const errors: CompilationError[] = [];
  const lines = stderr.split("\n");

  for (const line of lines) {
    // TypeScript/JavaScript error pattern: file.ts(line,col): error TS1234: message
    const tsMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+\w+:\s*(.+)$/);
    if (tsMatch) {
      errors.push({
        file: tsMatch[1],
        line: parseInt(tsMatch[2]),
        column: parseInt(tsMatch[3]),
        severity: tsMatch[4] as "error" | "warning",
        message: tsMatch[5],
      });
      continue;
    }

    // Generic error pattern: file:line:col: message
    const genericMatch = line.match(/^(.+?):(\d+):(\d+):\s*(.+)$/);
    if (genericMatch) {
      errors.push({
        file: genericMatch[1],
        line: parseInt(genericMatch[2]),
        column: parseInt(genericMatch[3]),
        message: genericMatch[4],
        severity: "error",
      });
      continue;
    }

    // Simple error pattern: file:line: message
    const simpleMatch = line.match(/^(.+?):(\d+):\s*(.+)$/);
    if (simpleMatch) {
      errors.push({
        file: simpleMatch[1],
        line: parseInt(simpleMatch[2]),
        message: simpleMatch[3],
        severity: "error",
      });
    }
  }

  return errors;
}
