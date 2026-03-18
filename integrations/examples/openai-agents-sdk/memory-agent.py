"""
RecallNest + OpenAI Agents SDK — Minimal Example

A Python agent with persistent memory powered by RecallNest HTTP API.

Prerequisites:
    1. RecallNest API server running: bun run api  (port 4318)
    2. OPENAI_API_KEY set in environment
    3. Install deps: pip install openai-agents httpx

Run: python integrations/examples/openai-agents-sdk/memory-agent.py
"""

import asyncio
import json
import os
import httpx
from agents import Agent, Runner, function_tool

RECALLNEST = "http://localhost:4318"


def build_recall_context() -> dict:
    session_id = os.getenv("RECALLNEST_SESSION_ID")
    scope = os.getenv("RECALLNEST_SCOPE")
    resolved_scope = scope or (f"session:{session_id}" if session_id else None)
    payload = {}
    if session_id:
        payload["sessionId"] = session_id
    if resolved_scope:
        payload["scope"] = resolved_scope
    return payload


@function_tool
async def recall_memory(query: str) -> str:
    """Recall relevant memories from past conversations.
    Use at the start of every task with 2-3 key nouns."""
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{RECALLNEST}/v1/auto-recall",
            json={"message": query, "limit": 5, **build_recall_context()},
        )
        r.raise_for_status()
        payload = r.json()
        return json.dumps(
            {
                "mode": payload.get("mode"),
                "resolvedScope": payload.get("resolvedScope"),
                "summary": payload.get("resume", {}).get("summary"),
                "stableContext": payload.get("resume", {}).get("stableContext", []),
                "results": payload.get("results", []),
                "searchSkippedReason": payload.get("searchSkippedReason"),
            },
            indent=2,
            ensure_ascii=False,
        )


@function_tool
async def store_memory(text: str, category: str = "events") -> str:
    """Store an important fact, decision, or preference for future recall.

    Args:
        text: The memory content to store.
        category: One of: profile, preferences, entities, events, cases, patterns.
    """
    scope_context = build_recall_context()
    if "scope" not in scope_context:
        return "Set RECALLNEST_SCOPE or RECALLNEST_SESSION_ID before storing durable memory."
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{RECALLNEST}/v1/store",
            json={
                "text": text,
                "category": category,
                "scope": scope_context["scope"],
                "source": "openai-agents-sdk-example",
            },
        )
        r.raise_for_status()
        return "Memory stored successfully."


# --- Agent definition ---

agent = Agent(
    name="Memory Agent",
    instructions=(
        "You are a helpful assistant with persistent memory. "
        "Always use recall_memory at the start of a task or project pivot to recover relevant context. "
        "Store important facts with store_memory."
    ),
    tools=[recall_memory, store_memory],
)


# --- Main ---

async def main():
    import sys
    query = sys.argv[1] if len(sys.argv) > 1 else "What do you remember about my project?"
    print(f"\nUser: {query}\n")
    result = await Runner.run(agent, query)
    print(f"Assistant: {result.final_output}")


if __name__ == "__main__":
    asyncio.run(main())
