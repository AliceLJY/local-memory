"""
RecallNest + LangChain — Minimal Example

A LangChain agent with persistent memory powered by RecallNest HTTP API.

Prerequisites:
    1. RecallNest API server running: bun run api  (port 4318)
    2. OPENAI_API_KEY set in environment (or use any LangChain-supported LLM)
    3. Install deps: pip install langchain langchain-openai httpx

Run: python integrations/examples/langchain/memory-chain.py
"""

import json
import httpx
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

RECALLNEST = "http://localhost:4318"


@tool
def recall_memory(query: str) -> str:
    """Recall relevant memories from past conversations.
    Use at the start of every task with 2-3 key nouns."""
    r = httpx.post(
        f"{RECALLNEST}/v1/recall",
        json={"query": query, "limit": 5},
    )
    r.raise_for_status()
    results = r.json().get("results", [])
    if not results:
        return "No relevant memories found."
    return json.dumps(results, indent=2, ensure_ascii=False)


@tool
def store_memory(text: str, category: str = "events") -> str:
    """Store an important fact, decision, or preference for future recall.

    Args:
        text: The memory content to store.
        category: One of: profile, preferences, entities, events, cases, patterns.
    """
    r = httpx.post(
        f"{RECALLNEST}/v1/store",
        json={
            "text": text,
            "category": category,
            "source": "langchain-example",
        },
    )
    r.raise_for_status()
    return "Memory stored successfully."


# --- Build the agent ---

llm = ChatOpenAI(model="gpt-4o")
tools = [recall_memory, store_memory]

agent = create_react_agent(llm, tools)


# --- Main ---

def main():
    import sys
    query = sys.argv[1] if len(sys.argv) > 1 else "What do you remember about my project?"
    print(f"\nUser: {query}\n")

    result = agent.invoke(
        {"messages": [{"role": "user", "content": query}]}
    )

    # Print the last assistant message
    for msg in reversed(result["messages"]):
        if msg.type == "ai" and msg.content:
            print(f"Assistant: {msg.content}")
            break


if __name__ == "__main__":
    main()
