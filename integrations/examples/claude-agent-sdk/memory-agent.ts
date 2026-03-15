/**
 * RecallNest + Claude Agent SDK — Minimal Example
 *
 * A Claude agent with persistent memory powered by RecallNest HTTP API.
 *
 * Prerequisites:
 *   1. RecallNest API server running: bun run api  (port 4318)
 *   2. ANTHROPIC_API_KEY set in environment
 *   3. Install deps: bun add @anthropic-ai/sdk
 *
 * Run: bun run integrations/examples/claude-agent-sdk/memory-agent.ts
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const RECALLNEST = "http://localhost:4318";

// --- Tool definitions for Claude ---

const tools: Anthropic.Tool[] = [
  {
    name: "recall_memory",
    description:
      "Recall relevant memories from past conversations. Use at the start of every task.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query — use 2-3 key nouns",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "store_memory",
    description:
      "Store an important fact, decision, or preference for future recall.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "The memory content to store",
        },
        category: {
          type: "string",
          enum: [
            "profile",
            "preferences",
            "entities",
            "events",
            "cases",
            "patterns",
          ],
          description: "Memory category",
        },
      },
      required: ["text"],
    },
  },
];

// --- Tool handler: calls RecallNest HTTP API ---

async function handleTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  if (name === "recall_memory") {
    const res = await fetch(`${RECALLNEST}/v1/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: input.query, limit: 5 }),
    });
    if (!res.ok) return `Error: ${res.status} ${await res.text()}`;
    const data = await res.json();
    return JSON.stringify(data.results, null, 2);
  }

  if (name === "store_memory") {
    const res = await fetch(`${RECALLNEST}/v1/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: input.text,
        category: input.category || "events",
        source: "claude-agent-sdk-example",
      }),
    });
    if (!res.ok) return `Error: ${res.status} ${await res.text()}`;
    return "Memory stored successfully.";
  }

  return `Unknown tool: ${name}`;
}

// --- Agent loop ---

async function runAgent(userMessage: string) {
  console.log(`\nUser: ${userMessage}\n`);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  // Agentic loop: keep going until no more tool calls
  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system:
        "You are a helpful assistant with persistent memory. " +
        "Always use recall_memory at the start of a task to check for relevant context. " +
        "Store important facts with store_memory.",
      tools,
      messages,
    });

    // Collect text output
    for (const block of response.content) {
      if (block.type === "text") {
        console.log(`Assistant: ${block.text}`);
      }
    }

    // If no tool use, we're done
    if (response.stop_reason !== "tool_use") break;

    // Handle tool calls
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ContentBlockParam & { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        b.type === "tool_use"
    );

    // Add assistant response to history
    messages.push({ role: "assistant", content: response.content });

    // Process each tool call and add results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      console.log(`  [Tool] ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
      const result = await handleTool(toolUse.name, toolUse.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// --- Main ---

const query = process.argv[2] || "What do you remember about my Docker setup?";
runAgent(query);
