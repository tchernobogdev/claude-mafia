"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";

interface Message {
  id: string;
  agentId: string | null;
  role: string;
  content: string;
  agent: { name: string; role: string } | null;
}

interface ConversationData {
  id: string;
  title: string;
  status: string;
  messages: Message[];
}

export default function ReportPage() {
  const params = useParams();
  const conversationId = params.id as string;
  const [data, setData] = useState<ConversationData | null>(null);

  const load = useCallback(() => {
    fetch(`/api/conversations/${conversationId}`)
      .then((r) => r.json())
      .then(setData);
  }, [conversationId]);

  useEffect(() => {
    load();
    // Poll until completed
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [load]);

  if (!data) return <div className="text-text-muted text-sm p-8">Loading...</div>;

  // Find the final assistant message (the underboss report back to boss)
  const assistantMessages = data.messages.filter((m) => m.role === "assistant");
  const finalReport = assistantMessages.length > 0
    ? assistantMessages[assistantMessages.length - 1]
    : null;

  const isActive = data.status === "active";

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <div className="mb-6">
        <a
          href={`/conversation/${conversationId}`}
          className="text-xs text-text-muted hover:text-text mb-2 block"
        >
          &larr; Back to Operation
        </a>
        <h1 className="text-2xl font-bold mb-1">Report</h1>
        <p className="text-sm text-text-muted">{data.title}</p>
      </div>

      {isActive && !finalReport && (
        <div className="bg-bg-card border border-border rounded-lg p-8 text-center">
          <div className="text-accent text-sm mb-2">Operation in progress...</div>
          <p className="text-text-muted text-xs">The report will appear here once your underboss reports back.</p>
        </div>
      )}

      {finalReport && (
        <div className="bg-bg-card border border-border rounded-lg p-6">
          <div className="flex items-center gap-2 mb-4 pb-3 border-b border-border">
            <span className="text-accent text-sm font-medium">
              {finalReport.agent?.name || "Agent"}
            </span>
            {finalReport.agent?.role && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent uppercase">
                {finalReport.agent.role}
              </span>
            )}
          </div>
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown
              components={{
                h1: ({ children }) => <h1 className="text-xl font-bold text-text mt-6 mb-3">{children}</h1>,
                h2: ({ children }) => <h2 className="text-lg font-bold text-text mt-5 mb-2">{children}</h2>,
                h3: ({ children }) => <h3 className="text-base font-semibold text-text mt-4 mb-2">{children}</h3>,
                p: ({ children }) => <p className="text-sm text-text mb-3 leading-relaxed">{children}</p>,
                ul: ({ children }) => <ul className="text-sm text-text mb-3 ml-4 list-disc space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="text-sm text-text mb-3 ml-4 list-decimal space-y-1">{children}</ol>,
                li: ({ children }) => <li className="text-sm leading-relaxed">{children}</li>,
                strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
                em: ({ children }) => <em className="italic text-text-muted">{children}</em>,
                code: ({ children, className }) => {
                  const isBlock = className?.includes("language-");
                  if (isBlock) {
                    return (
                      <code className="block bg-bg rounded p-3 text-xs font-mono text-text overflow-x-auto my-3">
                        {children}
                      </code>
                    );
                  }
                  return (
                    <code className="bg-bg rounded px-1.5 py-0.5 text-xs font-mono text-accent">
                      {children}
                    </code>
                  );
                },
                pre: ({ children }) => <pre className="bg-bg rounded p-4 overflow-x-auto my-3 border border-border">{children}</pre>,
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-accent pl-4 my-3 text-text-muted italic">
                    {children}
                  </blockquote>
                ),
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                    {children}
                  </a>
                ),
                hr: () => <hr className="border-border my-4" />,
                table: ({ children }) => (
                  <div className="overflow-x-auto my-3">
                    <table className="text-sm border border-border w-full">{children}</table>
                  </div>
                ),
                th: ({ children }) => <th className="border border-border px-3 py-1.5 text-left bg-bg-hover text-xs font-medium text-text-muted">{children}</th>,
                td: ({ children }) => <td className="border border-border px-3 py-1.5 text-sm">{children}</td>,
              }}
            >
              {finalReport.content}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {data.status === "completed" && !finalReport && (
        <div className="bg-bg-card border border-border rounded-lg p-8 text-center">
          <p className="text-text-muted text-sm">No report was generated for this operation.</p>
        </div>
      )}
    </div>
  );
}
