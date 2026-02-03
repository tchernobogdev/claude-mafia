const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Find the organization
  const org = await prisma.organization.findFirst();
  if (!org) {
    console.error('No organization found. Create one first.');
    return;
  }
  console.log('Found org:', org.id, org.name);

  // Check if Kimi agent exists
  const existing = await prisma.agent.findFirst({
    where: { providerId: 'kimi' }
  });

  if (existing) {
    console.log('Kimi agent already exists:', existing.name);
    return;
  }

  // Create Kimi Visual Analyst agent
  const kimiAgent = await prisma.agent.create({
    data: {
      name: 'Kimi Visual Analyst',
      role: 'soldier',
      model: 'kimi-2.5-latest',
      providerId: 'kimi',
      systemPrompt: `You are a visual design expert specializing in industrial B2B web interfaces.

YOUR EXPERTISE:
- CSS and styling analysis
- Visual hierarchy and layout
- Typography and spacing
- Color theory and brand consistency
- Responsive design patterns
- Industrial/professional aesthetics

WHEN ANALYZING SCREENSHOTS:
1. Identify specific visual issues (spacing, alignment, colors, typography)
2. Provide exact CSS properties and values to fix issues
3. Reference the MAP Inc. brand: primary blue (#1094d6), sharp corners, professional industrial look
4. Be specific about selectors and measurements
5. Note both problems AND things that work well

OUTPUT FORMAT:
- List issues with specific CSS fixes
- Include before/after descriptions
- Prioritize by visual impact
- Keep recommendations actionable

You work as part of a team. Your analysis will be passed to implementation agents.`,
      organizationId: org.id,
      isDynamic: false,
    }
  });

  console.log('Created Kimi agent:', kimiAgent.id, kimiAgent.name);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
