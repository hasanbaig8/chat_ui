#!/usr/bin/env python3
"""Quick test to see what messages the Claude Code SDK sends."""

import asyncio
import sys
sys.path.insert(0, '/home/hasanbaig/chat_ui')

from services.agent_client import AgentClient, is_sdk_available

async def test():
    if not is_sdk_available():
        print("SDK not available!")
        return

    client = AgentClient()
    workspace = "/home/hasanbaig/chat_ui"

    messages = [{"role": "user", "content": "Use the Read tool to read the contents of requirements.txt and tell me what's in it."}]

    print("Starting agent query...")
    async for event in client.stream_agent_response(messages, workspace):
        print(f"Event: {event}")

    print("\nDone!")

if __name__ == "__main__":
    asyncio.run(test())
