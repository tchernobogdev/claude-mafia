import type { Metadata } from "next";
import "./globals.css";
import { ToastProvider } from "./components/Toast";

export const metadata: Metadata = {
  title: "Agent Mafia",
  description: "Agent orchestration suite",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-bg text-text min-h-screen antialiased">
        <nav className="border-b border-border px-6 py-3 flex items-center justify-between" aria-label="Main navigation">
          <a href="/" className="text-lg font-semibold tracking-tight text-accent">
            Agent Mafia
          </a>
          <div className="flex gap-4 text-sm">
            <a href="/" className="text-text-muted hover:text-text transition-colors">
              Dashboard
            </a>
            <a href="/configure" className="text-text-muted hover:text-text transition-colors">
              Configure
            </a>
            <a href="/settings" className="text-text-muted hover:text-text transition-colors">
              Settings
            </a>
          </div>
        </nav>
        <main className="max-w-6xl mx-auto px-6 py-6">
          <ToastProvider>{children}</ToastProvider>
        </main>
      </body>
    </html>
  );
}
