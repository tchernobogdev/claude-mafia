import { anthropic } from "./anthropic";

const SOPRANOS_CHARACTERS = [
  "Tony Soprano",
  "Silvio Dante",
  "Paulie Gualtieri",
  "Christopher Moltisanti",
  "Bobby Baccalieri",
  "Furio Giunta",
  "Vito Spatafore",
  "Johnny Sack",
  "Junior Soprano",
  "Carmela Soprano",
  "Adriana La Cerva",
  "Big Pussy Bonpensiero",
  "Richie Aprile",
  "Ralph Cifaretto",
  "Eugene Pontecorpo",
  "Patsy Parisi",
  "Benny Fazio",
  "Carlo Gervasi",
  "Raymond Curto",
  "Mikey Palmice",
];

interface DynamicAgent {
  name: string;
  role: string;
  specialty: string;
  systemPrompt: string;
  model: string;
}

interface DynamicRelationship {
  fromName: string;
  toName: string;
  action: string;
}

interface DynamicOrgResult {
  agents: DynamicAgent[];
  relationships: DynamicRelationship[];
}

export async function buildDynamicOrg(task: string): Promise<DynamicOrgResult> {
  const prompt = `You are designing a custom mafia organization to handle this task:

<task>
${task}
</task>

Design a hierarchical organization with:
- Exactly 1 underboss (the top delegator)
- Between 1 and 4 capos (middle managers, each with a specialty relevant to the task)
- Between 1 and 3 soldiers per capo (specialists who do hands-on work)

CRITICAL RULES:
1. ALL agent names MUST be characters from The Sopranos TV show. Choose from: ${SOPRANOS_CHARACTERS.join(", ")}
2. Each agent's specialty and system prompt must be RELEVANT to completing the task
3. Use the default model "claude-sonnet-4-5-20250929" for all agents
4. Design the hierarchy so work flows: underboss → capos → soldiers
5. Add "delegate" relationships from underboss to each capo, and from each capo to their soldiers
6. You may add "collaborate" relationships between capos if their work overlaps

For each agent, provide:
- name: A Sopranos character name (MUST be from the list above)
- role: "underboss", "capo", or "soldier"
- specialty: A brief specialty relevant to this task (e.g., "frontend expert", "API development", "testing")
- systemPrompt: A 1-2 sentence description of what this agent should focus on
- model: Use "claude-sonnet-4-5-20250929"

For each relationship, provide:
- fromName: The agent delegating or collaborating
- toName: The agent receiving the delegation or collaboration
- action: Either "delegate" (for hierarchy) or "collaborate" (for peer cooperation)

Call the design_organization tool with your complete organizational design.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 4096,
    tools: [
      {
        name: "design_organization",
        description: "Submit the complete organizational design for the mafia task force",
        input_schema: {
          type: "object",
          properties: {
            agents: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description: "Sopranos character name",
                  },
                  role: {
                    type: "string",
                    enum: ["underboss", "capo", "soldier"],
                  },
                  specialty: {
                    type: "string",
                    description: "Specialty relevant to the task",
                  },
                  systemPrompt: {
                    type: "string",
                    description: "Brief system prompt for this agent",
                  },
                  model: {
                    type: "string",
                    description: "Model to use",
                  },
                },
                required: ["name", "role", "specialty", "systemPrompt", "model"],
              },
            },
            relationships: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  fromName: {
                    type: "string",
                    description: "Name of the agent delegating or collaborating",
                  },
                  toName: {
                    type: "string",
                    description: "Name of the agent receiving",
                  },
                  action: {
                    type: "string",
                    enum: ["delegate", "collaborate"],
                  },
                },
                required: ["fromName", "toName", "action"],
              },
            },
          },
          required: ["agents", "relationships"],
        },
      },
    ],
    messages: [{ role: "user", content: prompt }],
  });

  // Extract tool use result
  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return a tool use response");
  }

  const orgDesign = toolUse.input as DynamicOrgResult;

  // Validate that all names are from Sopranos
  for (const agent of orgDesign.agents) {
    if (!SOPRANOS_CHARACTERS.includes(agent.name)) {
      throw new Error(`Invalid character name: ${agent.name}. Must be from The Sopranos.`);
    }
  }

  return orgDesign;
}
