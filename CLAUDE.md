# AgentMafia

Multi-agent orchestration platform built with Next.js. Claude AI agents are organized in a mafia-style hierarchy (Underboss > Capo > Soldier) and communicate via delegation, questioning, review, and summarization patterns.

## Tech Stack

- **Next.js 16** + React 19 + TypeScript
- **SQLite** via Prisma ORM
- **Anthropic SDK** (Claude API) with OAuth support for Claude Code CLI tokens
- **Brave Search API** for web queries
- **Zustand** for client state
- **Tailwind CSS** dark theme UI
- **SSE** for real-time streaming

## Project Structure

```
src/
  app/
    page.tsx                    # Dashboard - submit tasks, view conversations
    configure/
      page.tsx                  # Visual canvas editor for agent hierarchy
      [agentId]/page.tsx        # Individual agent config
    conversation/
      [id]/page.tsx             # Live message viewer + step-through replay
      [id]/report/page.tsx      # Final markdown report
    api/
      agents/                   # CRUD for agents
      relationships/            # Agent-to-agent connection management
      conversations/            # Task execution (POST triggers orchestration)
      stream/[conversationId]/  # SSE endpoint for real-time events
      escalations/[id]/answer/  # Human-in-the-loop responses
  lib/
    orchestrator.ts             # Core agentic loop - delegation, tool execution, result compilation
    anthropic.ts                # Claude client setup (API key or OAuth token)
    tools.ts                    # Dynamic tool generation per agent based on relationships
    db.ts                       # Prisma singleton
    escalation.ts               # Promise-based queue for human decisions
    sse.ts                      # Pub/sub event system
    sandbox.ts                  # Python code execution (30s timeout)
    search.ts                   # Brave Search integration
prisma/
  schema.prisma                 # Agent, Relationship, Conversation, Message, Escalation models
```

## Database Models

- **Agent** - name, role (underboss/capo/soldier), model, system prompt, hierarchy via parentId
- **Relationship** - directed edges between agents with action type (delegate/ask/review/summarize)
- **Conversation** - task execution session with status tracking
- **Message** - chronological log of agent/user/system messages
- **Escalation** - human decision points that block execution until answered

## Agent Orchestration Flow

1. User submits task from dashboard
2. `executeAgent()` runs the underboss with up to 5 agentic loop iterations
3. Agents use tools based on their outgoing relationships:
   - `delegate_task` - assign to subordinates (parallel via Promise.all)
   - `ask_agent` - synchronous query to another agent
   - `review_work` - peer review
   - `summarize_for` - report to superior
   - `execute_python` - sandboxed code execution
   - `web_search` - Brave Search
   - `escalate_to_boss` - block and wait for human input
4. Results bubble up the hierarchy; each agent compiles subordinate results
5. Max delegation depth: 10 levels

## Claude Code OAuth Integration

The project supports Claude Code OAuth tokens (`sk-ant-oat` prefix) as an alternative to standard API keys. When OAuth is detected:
- Sets `anthropic-beta: claude-code-20250219,oauth-2025-04-20` header
- Enables `anthropic-dangerous-direct-browser-access`
- Adds Claude Code system prefix to messages

Set `ANTHROPIC_API_KEY` in `.env` to either a standard API key or an OAuth token from `claude setup-token`.

## Running

```bash
npm install
npx prisma db push
npm run dev
```

## Key Design Decisions

- Agents MUST delegate on first task reception, not answer directly
- Breadth-first parallel delegation to subordinates
- Mafia personality injected into all system prompts by default
- Custom system prompts override defaults per agent
- Cascade deletion: removing an agent deletes all subordinates
- One relationship action type enforced per agent pair
