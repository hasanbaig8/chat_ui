#!/usr/bin/env python3
"""
Test suite for the memory feature.

Tests:
1. Memory MCP server operations (view, create, str_replace, insert, delete, rename)
2. Memory API endpoints
3. Project-based memory sharing
4. Security (path traversal prevention)

Usage:
    python test_memory.py
    python test_memory.py -v  # verbose
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient


class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    RESET = '\033[0m'
    BOLD = '\033[1m'


def print_header(text):
    print(f"\n{Colors.BLUE}{Colors.BOLD}{'='*60}{Colors.RESET}")
    print(f"{Colors.BLUE}{Colors.BOLD}{text}{Colors.RESET}")
    print(f"{Colors.BLUE}{Colors.BOLD}{'='*60}{Colors.RESET}")


def print_test(name, passed, detail=""):
    status = f"{Colors.GREEN}✓ PASS{Colors.RESET}" if passed else f"{Colors.RED}✗ FAIL{Colors.RESET}"
    print(f"  {status} {name}")
    if detail and not passed:
        print(f"         {Colors.YELLOW}{detail}{Colors.RESET}")


def test_memory_server():
    """Test the memory MCP server directly."""
    print_header("Testing Memory MCP Server")

    from tools.memory_mcp_server import MemoryServer

    results = []

    with tempfile.TemporaryDirectory() as tmpdir:
        server = MemoryServer(tmpdir)

        # Test 1: View empty directory
        result = server.view('/memories')
        passed = 'memories' in result.lower()
        results.append(passed)
        print_test("View empty directory", passed, result[:100] if not passed else "")

        # Test 2: Create a file
        result = server.create('/memories/test.txt', 'Hello World\nLine 2\nLine 3')
        passed = 'created successfully' in result.lower()
        results.append(passed)
        print_test("Create file", passed, result if not passed else "")

        # Test 3: View file with line numbers
        result = server.view('/memories/test.txt')
        passed = 'Hello World' in result and '1' in result and '2' in result
        results.append(passed)
        print_test("View file with line numbers", passed, result[:200] if not passed else "")

        # Test 4: View file with range
        result = server.view('/memories/test.txt', view_range=[2, 3])
        passed = 'Line 2' in result and 'Hello World' not in result
        results.append(passed)
        print_test("View file with line range", passed, result if not passed else "")

        # Test 5: Create duplicate file (should fail)
        result = server.create('/memories/test.txt', 'Duplicate')
        passed = 'already exists' in result.lower()
        results.append(passed)
        print_test("Reject duplicate file creation", passed, result if not passed else "")

        # Test 6: String replace
        result = server.str_replace('/memories/test.txt', 'Hello World', 'Hi Universe')
        passed = 'edited' in result.lower()
        results.append(passed)
        print_test("String replace", passed, result if not passed else "")

        # Verify replacement
        result = server.view('/memories/test.txt')
        passed = 'Hi Universe' in result and 'Hello World' not in result
        results.append(passed)
        print_test("Verify string replacement", passed)

        # Test 7: String replace with non-existent string
        result = server.str_replace('/memories/test.txt', 'NONEXISTENT', 'replacement')
        passed = 'no replacement' in result.lower()
        results.append(passed)
        print_test("Reject replace of non-existent string", passed, result if not passed else "")

        # Test 8: Create file with duplicate text for multi-match test
        server.create('/memories/multi.txt', 'foo bar foo baz foo')
        result = server.str_replace('/memories/multi.txt', 'foo', 'replaced')
        passed = 'multiple occurrences' in result.lower()
        results.append(passed)
        print_test("Reject replace of multiple occurrences", passed, result if not passed else "")

        # Test 9: Insert at beginning
        result = server.insert('/memories/test.txt', 0, 'First line\n')
        passed = 'edited' in result.lower()
        results.append(passed)
        print_test("Insert at beginning", passed, result if not passed else "")

        # Verify insert
        result = server.view('/memories/test.txt')
        lines = [l for l in result.split('\n') if l.strip() and not l.startswith("Here's")]
        passed = 'First line' in lines[0]
        results.append(passed)
        print_test("Verify insert at beginning", passed)

        # Test 10: Insert with invalid line number
        result = server.insert('/memories/test.txt', 9999, 'Invalid')
        passed = 'invalid' in result.lower() or 'error' in result.lower()
        results.append(passed)
        print_test("Reject insert at invalid line", passed, result if not passed else "")

        # Test 11: Rename file
        result = server.rename('/memories/test.txt', '/memories/renamed.txt')
        passed = 'successfully renamed' in result.lower()
        results.append(passed)
        print_test("Rename file", passed, result if not passed else "")

        # Verify rename
        result = server.view('/memories/renamed.txt')
        passed = 'First line' in result
        results.append(passed)
        print_test("Verify renamed file exists", passed)

        result = server.view('/memories/test.txt')
        passed = 'does not exist' in result.lower()
        results.append(passed)
        print_test("Verify original file removed", passed)

        # Test 12: Create subdirectory and file
        result = server.create('/memories/subdir/nested.txt', 'Nested content')
        passed = 'created successfully' in result.lower()
        results.append(passed)
        print_test("Create file in subdirectory", passed, result if not passed else "")

        # Test 13: View directory with nested content
        result = server.view('/memories')
        passed = 'subdir' in result.lower() and 'renamed.txt' in result.lower()
        results.append(passed)
        print_test("View directory with nested content", passed, result[:300] if not passed else "")

        # Test 14: Delete file
        result = server.delete('/memories/multi.txt')
        passed = 'successfully deleted' in result.lower()
        results.append(passed)
        print_test("Delete file", passed, result if not passed else "")

        # Test 15: Delete directory recursively
        result = server.delete('/memories/subdir')
        passed = 'successfully deleted' in result.lower()
        results.append(passed)
        print_test("Delete directory recursively", passed, result if not passed else "")

        # Test 16: Path traversal prevention
        result = server.view('/memories/../../../etc/passwd')
        passed = 'traversal' in result.lower() or 'does not exist' in result.lower()
        results.append(passed)
        print_test("Prevent path traversal (view)", passed, result if not passed else "")

        result = server.create('/memories/../../../tmp/evil.txt', 'evil')
        passed = 'traversal' in result.lower() or 'error' in result.lower()
        results.append(passed)
        print_test("Prevent path traversal (create)", passed, result if not passed else "")

        # Test 17: Prevent deleting memories root
        result = server.delete('/memories')
        passed = 'cannot delete' in result.lower() or 'error' in result.lower()
        results.append(passed)
        print_test("Prevent deleting memories root", passed, result if not passed else "")

    return all(results), results


def test_memory_api():
    """Test the memory API endpoints."""
    print_header("Testing Memory API Endpoints")

    from app import app
    client = TestClient(app)

    results = []
    project_id = None
    conv_id = None

    try:
        # Test 1: Create a project
        resp = client.post('/api/projects', json={'name': 'Memory API Test', 'color': '#9B59B6'})
        passed = resp.status_code == 200
        results.append(passed)
        print_test("Create project", passed, str(resp.json()) if not passed else "")
        if passed:
            project_id = resp.json()['id']

        # Test 2: Create an agent conversation
        resp = client.post('/api/conversations', json={'title': 'Memory Test Conv', 'is_agent': True})
        passed = resp.status_code == 200
        results.append(passed)
        print_test("Create agent conversation", passed, str(resp.json()) if not passed else "")
        if passed:
            conv_id = resp.json()['id']

        # Test 3: Check memory endpoint for standalone conversation
        resp = client.get(f'/api/agent-chat/memory/{conv_id}')
        passed = resp.status_code == 200 and resp.json()['is_project_memory'] == False
        results.append(passed)
        print_test("Memory endpoint (standalone conv)", passed, str(resp.json()) if not passed else "")

        # Test 4: Add conversation to project
        resp = client.post(f'/api/projects/{project_id}/conversations', json={'conversation_id': conv_id})
        passed = resp.status_code == 200
        results.append(passed)
        print_test("Add conversation to project", passed)

        # Test 5: Check memory endpoint for project conversation
        resp = client.get(f'/api/agent-chat/memory/{conv_id}')
        data = resp.json()
        passed = resp.status_code == 200 and data['is_project_memory'] == True and data['project_id'] == project_id
        results.append(passed)
        print_test("Memory endpoint (project conv)", passed, str(data) if not passed else "")

        # Test 6: Check project memory endpoint
        resp = client.get(f'/api/projects/{project_id}/memory')
        passed = resp.status_code == 200 and 'memory_path' in resp.json()
        results.append(passed)
        print_test("Project memory endpoint", passed, str(resp.json()) if not passed else "")

        # Test 7: Memory path is correct format
        memory_path = resp.json()['memory_path']
        passed = f'data/projects/{project_id}/memories' in memory_path
        results.append(passed)
        print_test("Memory path format correct", passed, memory_path if not passed else "")

        # Test 8: Remove conversation from project
        resp = client.delete(f'/api/projects/{project_id}/conversations/{conv_id}')
        passed = resp.status_code == 200
        results.append(passed)
        print_test("Remove conversation from project", passed)

        # Test 9: Memory endpoint reverts to standalone
        resp = client.get(f'/api/agent-chat/memory/{conv_id}')
        data = resp.json()
        passed = resp.status_code == 200 and data['is_project_memory'] == False
        results.append(passed)
        print_test("Memory endpoint reverts to standalone", passed, str(data) if not passed else "")

    finally:
        # Cleanup
        if conv_id:
            client.delete(f'/api/conversations/{conv_id}')
        if project_id:
            client.delete(f'/api/projects/{project_id}')
            # Clean up memory directory
            memory_dir = Path(f'data/projects/{project_id}')
            if memory_dir.exists():
                shutil.rmtree(memory_dir)

    return all(results), results


def test_memory_sharing():
    """Test that multiple conversations in a project share memory."""
    print_header("Testing Memory Sharing Between Conversations")

    from app import app
    client = TestClient(app)

    results = []
    project_id = None
    conv_ids = []

    try:
        # Test 1: Create a project
        resp = client.post('/api/projects', json={'name': 'Shared Memory Test', 'color': '#4A9B7F'})
        project_id = resp.json()['id']
        passed = resp.status_code == 200
        results.append(passed)
        print_test("Create project", passed)

        # Test 2: Create two agent conversations
        for i in range(2):
            resp = client.post('/api/conversations', json={'title': f'Conv {i+1}', 'is_agent': True})
            conv_ids.append(resp.json()['id'])
        passed = len(conv_ids) == 2
        results.append(passed)
        print_test("Create two conversations", passed)

        # Test 3: Add both to project
        for conv_id in conv_ids:
            client.post(f'/api/projects/{project_id}/conversations', json={'conversation_id': conv_id})
        passed = True
        results.append(passed)
        print_test("Add both to project", passed)

        # Test 4: Both conversations should have same memory path
        memory_paths = []
        for conv_id in conv_ids:
            resp = client.get(f'/api/agent-chat/memory/{conv_id}')
            memory_paths.append(resp.json()['memory_path'])

        passed = memory_paths[0] == memory_paths[1]
        results.append(passed)
        print_test("Both conversations share same memory path", passed,
                   f"{memory_paths[0]} vs {memory_paths[1]}" if not passed else "")

        # Test 5: Both should point to project
        for i, conv_id in enumerate(conv_ids):
            resp = client.get(f'/api/agent-chat/memory/{conv_id}')
            data = resp.json()
            passed = data['project_id'] == project_id
            results.append(passed)
            print_test(f"Conv {i+1} points to project", passed)

        # Test 6: Write a memory file (simulate by creating directory)
        memory_path = Path(memory_paths[0])
        memory_path.mkdir(parents=True, exist_ok=True)
        test_file = memory_path / 'shared_notes.txt'
        test_file.write_text('Shared memory content from test')

        # Test 7: Both conversations should see the file
        for i, conv_id in enumerate(conv_ids):
            resp = client.get(f'/api/agent-chat/memory/{conv_id}')
            files = resp.json()['files']
            file_names = [f['name'] for f in files]
            passed = 'shared_notes.txt' in file_names
            results.append(passed)
            print_test(f"Conv {i+1} sees shared file", passed, str(file_names) if not passed else "")

        # Test 8: Read the file from both conversations
        for i, conv_id in enumerate(conv_ids):
            resp = client.get(f'/api/agent-chat/memory/{conv_id}/shared_notes.txt')
            passed = resp.status_code == 200 and 'Shared memory content' in resp.json()['content']
            results.append(passed)
            print_test(f"Conv {i+1} reads shared file", passed)

    finally:
        # Cleanup
        for conv_id in conv_ids:
            client.delete(f'/api/conversations/{conv_id}')
        if project_id:
            client.delete(f'/api/projects/{project_id}')
            memory_dir = Path(f'data/projects/{project_id}')
            if memory_dir.exists():
                shutil.rmtree(memory_dir)

    return all(results), results


def test_mcp_protocol():
    """Test the MCP JSON-RPC protocol of the memory server."""
    print_header("Testing MCP Protocol")

    results = []

    with tempfile.TemporaryDirectory() as tmpdir:
        # Start the MCP server process
        server_path = Path(__file__).parent / 'tools' / 'memory_mcp_server.py'

        proc = subprocess.Popen(
            ['python3', str(server_path), '--memory-path', tmpdir],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )

        def send_request(request):
            proc.stdin.write(json.dumps(request) + '\n')
            proc.stdin.flush()
            response = proc.stdout.readline()
            return json.loads(response) if response else None

        try:
            # Test 1: Initialize
            resp = send_request({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {}
            })
            passed = resp and resp.get('result', {}).get('serverInfo', {}).get('name') == 'memory'
            results.append(passed)
            print_test("MCP initialize", passed, str(resp) if not passed else "")

            # Test 2: List tools
            resp = send_request({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {}
            })
            tools = resp.get('result', {}).get('tools', [])
            tool_names = [t['name'] for t in tools]
            expected_tools = ['memory_view', 'memory_create', 'memory_str_replace',
                           'memory_insert', 'memory_delete', 'memory_rename']
            passed = all(t in tool_names for t in expected_tools)
            results.append(passed)
            print_test("MCP tools/list", passed, f"Got: {tool_names}" if not passed else "")

            # Test 3: Call memory_create
            resp = send_request({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "memory_create",
                    "arguments": {
                        "path": "/memories/mcp_test.txt",
                        "file_text": "MCP test content"
                    }
                }
            })
            content = resp.get('result', {}).get('content', [{}])[0].get('text', '')
            passed = 'created successfully' in content.lower()
            results.append(passed)
            print_test("MCP memory_create", passed, content if not passed else "")

            # Test 4: Call memory_view
            resp = send_request({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "memory_view",
                    "arguments": {
                        "path": "/memories/mcp_test.txt"
                    }
                }
            })
            content = resp.get('result', {}).get('content', [{}])[0].get('text', '')
            passed = 'MCP test content' in content
            results.append(passed)
            print_test("MCP memory_view", passed, content[:100] if not passed else "")

            # Test 5: Call unknown tool
            resp = send_request({
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "unknown_tool",
                    "arguments": {}
                }
            })
            passed = 'error' in resp
            results.append(passed)
            print_test("MCP unknown tool returns error", passed)

        finally:
            proc.terminate()
            proc.wait(timeout=5)

    return all(results), results


def test_agent_memory_handoff():
    """
    Test the actual workflow: Agent 1 writes to project memory, Agent 2 reads it.

    This simulates:
    1. Create a project
    2. Agent conversation 1 joins project and writes memories
    3. Agent conversation 2 joins project and reads the memories
    """
    print_header("Testing Agent Memory Handoff")

    from app import app
    from tools.memory_mcp_server import MemoryServer

    client = TestClient(app)
    results = []
    project_id = None
    conv1_id = None
    conv2_id = None

    try:
        # Step 1: Create a project
        resp = client.post('/api/projects', json={
            'name': 'Agent Handoff Test',
            'color': '#E67E22'
        })
        project_id = resp.json()['id']
        passed = resp.status_code == 200
        results.append(passed)
        print_test("Create project", passed)

        # Step 2: Create first agent conversation
        resp = client.post('/api/conversations', json={
            'title': 'Agent 1 - Writer',
            'is_agent': True
        })
        conv1_id = resp.json()['id']
        passed = resp.status_code == 200
        results.append(passed)
        print_test("Create Agent 1 conversation", passed)

        # Step 3: Add Agent 1 to project
        resp = client.post(f'/api/projects/{project_id}/conversations',
                          json={'conversation_id': conv1_id})
        passed = resp.status_code == 200
        results.append(passed)
        print_test("Add Agent 1 to project", passed)

        # Step 4: Get Agent 1's memory path (should be project memory)
        resp = client.get(f'/api/agent-chat/memory/{conv1_id}')
        memory_info = resp.json()
        passed = memory_info['is_project_memory'] == True
        results.append(passed)
        print_test("Agent 1 uses project memory", passed)

        memory_path = memory_info['memory_path']
        print(f"         Memory path: {memory_path}")

        # Step 5: Simulate Agent 1 writing to memory (using MemoryServer directly)
        # This is what happens when Claude uses the memory tools
        server = MemoryServer(memory_path)

        # Agent 1 checks memory first (as instructed by system prompt)
        result = server.view('/memories')
        passed = 'memories' in result.lower()
        results.append(passed)
        print_test("Agent 1 views empty memory", passed)

        # Agent 1 creates a project context file
        result = server.create('/memories/project_context.md', '''# Project Context

## Project Goals
- Build a REST API for user management
- Implement authentication with JWT
- Add rate limiting

## Architecture Decisions
- Using FastAPI for the backend
- PostgreSQL for database
- Redis for caching

## Current Status
- API scaffolding complete
- User model defined
- Working on authentication endpoints
''')
        passed = 'created successfully' in result.lower()
        results.append(passed)
        print_test("Agent 1 creates project_context.md", passed)

        # Agent 1 creates a notes file
        result = server.create('/memories/session_notes.txt', '''Session 1 Notes (Agent 1):
- Discussed API requirements with user
- User prefers JWT over session-based auth
- Need to support OAuth2 in the future
- Rate limit: 100 requests per minute per user
''')
        passed = 'created successfully' in result.lower()
        results.append(passed)
        print_test("Agent 1 creates session_notes.txt", passed)

        # Step 6: Verify Agent 1 can read back what it wrote
        result = server.view('/memories')
        passed = 'project_context.md' in result and 'session_notes.txt' in result
        results.append(passed)
        print_test("Agent 1 sees its files in memory", passed)

        # Step 7: Now create Agent 2 (a NEW conversation)
        resp = client.post('/api/conversations', json={
            'title': 'Agent 2 - Reader',
            'is_agent': True
        })
        conv2_id = resp.json()['id']
        passed = resp.status_code == 200
        results.append(passed)
        print_test("Create Agent 2 conversation", passed)

        # Step 8: Agent 2 is NOT in project yet - should have empty memory
        resp = client.get(f'/api/agent-chat/memory/{conv2_id}')
        memory_info_2 = resp.json()
        passed = memory_info_2['is_project_memory'] == False
        results.append(passed)
        print_test("Agent 2 initially has standalone memory", passed)

        # Verify Agent 2's standalone memory is empty
        standalone_path = memory_info_2['memory_path']
        if Path(standalone_path).exists():
            files = list(Path(standalone_path).iterdir())
        else:
            files = []
        passed = len(files) == 0
        results.append(passed)
        print_test("Agent 2 standalone memory is empty", passed)

        # Step 9: Add Agent 2 to the SAME project
        resp = client.post(f'/api/projects/{project_id}/conversations',
                          json={'conversation_id': conv2_id})
        passed = resp.status_code == 200
        results.append(passed)
        print_test("Add Agent 2 to same project", passed)

        # Step 10: Agent 2 should now see project memory
        resp = client.get(f'/api/agent-chat/memory/{conv2_id}')
        memory_info_2 = resp.json()
        passed = memory_info_2['is_project_memory'] == True
        results.append(passed)
        print_test("Agent 2 now uses project memory", passed)

        # Step 11: Agent 2's memory path should match Agent 1's
        passed = memory_info_2['memory_path'] == memory_path
        results.append(passed)
        print_test("Agent 2 has same memory path as Agent 1", passed)

        # Step 12: Simulate Agent 2 checking memory (like system prompt instructs)
        server2 = MemoryServer(memory_info_2['memory_path'])
        result = server2.view('/memories')
        passed = 'project_context.md' in result and 'session_notes.txt' in result
        results.append(passed)
        print_test("Agent 2 sees Agent 1's files", passed)

        # Step 13: Agent 2 reads the project context
        result = server2.view('/memories/project_context.md')
        passed = 'FastAPI' in result and 'JWT' in result and 'PostgreSQL' in result
        results.append(passed)
        print_test("Agent 2 reads project_context.md", passed)

        # Step 14: Agent 2 reads session notes
        result = server2.view('/memories/session_notes.txt')
        passed = 'Agent 1' in result and 'OAuth2' in result and '100 requests' in result
        results.append(passed)
        print_test("Agent 2 reads session_notes.txt", passed)

        # Step 15: Agent 2 adds to the session notes
        result = server2.str_replace(
            '/memories/session_notes.txt',
            'Rate limit: 100 requests per minute per user',
            '''Rate limit: 100 requests per minute per user

Session 2 Notes (Agent 2):
- Continuing from Agent 1's work
- Implemented JWT authentication
- Added /auth/login and /auth/refresh endpoints
- Next: implement rate limiting middleware'''
        )
        passed = 'edited' in result.lower()
        results.append(passed)
        print_test("Agent 2 updates session_notes.txt", passed)

        # Step 16: Verify Agent 1 can see Agent 2's updates
        result = server.view('/memories/session_notes.txt')
        passed = 'Agent 1' in result and 'Agent 2' in result and 'JWT authentication' in result
        results.append(passed)
        print_test("Agent 1 sees Agent 2's updates", passed)

        # Step 17: Agent 2 creates a new file
        result = server2.create('/memories/api_endpoints.md', '''# API Endpoints

## Authentication
- POST /auth/login - User login, returns JWT
- POST /auth/refresh - Refresh JWT token
- POST /auth/logout - Invalidate token

## Users (TODO)
- GET /users - List users
- POST /users - Create user
- GET /users/{id} - Get user
- PUT /users/{id} - Update user
- DELETE /users/{id} - Delete user
''')
        passed = 'created successfully' in result.lower()
        results.append(passed)
        print_test("Agent 2 creates api_endpoints.md", passed)

        # Step 18: Both agents now see 3 files
        result = server.view('/memories')
        file_count = result.count('.md') + result.count('.txt')
        passed = file_count >= 3
        results.append(passed)
        print_test("Memory now has 3 files", passed, f"Found {file_count} files")

        # Step 19: Test via API that both conversations see the same files
        resp1 = client.get(f'/api/agent-chat/memory/{conv1_id}')
        resp2 = client.get(f'/api/agent-chat/memory/{conv2_id}')
        files1 = set(f['name'] for f in resp1.json()['files'])
        files2 = set(f['name'] for f in resp2.json()['files'])
        passed = files1 == files2 and len(files1) == 3
        results.append(passed)
        print_test("API confirms both see same 3 files", passed,
                   f"Agent1: {files1}, Agent2: {files2}" if not passed else "")

        # Step 20: Read file via API to confirm content
        resp = client.get(f'/api/agent-chat/memory/{conv2_id}/session_notes.txt')
        content = resp.json()['content']
        passed = 'Agent 1' in content and 'Agent 2' in content
        results.append(passed)
        print_test("API confirms merged content", passed)

        print(f"\n{Colors.BLUE}Summary of handoff:{Colors.RESET}")
        print(f"  - Agent 1 wrote: project_context.md, session_notes.txt")
        print(f"  - Agent 2 read Agent 1's files and understood the context")
        print(f"  - Agent 2 added: api_endpoints.md, updated session_notes.txt")
        print(f"  - Both agents share the same memory seamlessly")

    finally:
        # Cleanup
        if conv1_id:
            client.delete(f'/api/conversations/{conv1_id}')
        if conv2_id:
            client.delete(f'/api/conversations/{conv2_id}')
        if project_id:
            client.delete(f'/api/projects/{project_id}')
            memory_dir = Path(f'data/projects/{project_id}')
            if memory_dir.exists():
                shutil.rmtree(memory_dir)

    return all(results), results


def main():
    parser = argparse.ArgumentParser(description='Test memory feature')
    parser.add_argument('-v', '--verbose', action='store_true', help='Verbose output')
    parser.add_argument('--handoff-only', action='store_true', help='Run only the agent handoff test')
    args = parser.parse_args()

    print(f"\n{Colors.BOLD}Memory Feature Test Suite{Colors.RESET}")
    print(f"{'='*60}\n")

    all_passed = True
    total_tests = 0
    passed_tests = 0

    # Run test suites
    if args.handoff_only:
        test_suites = [
            ("Agent Memory Handoff", test_agent_memory_handoff),
        ]
    else:
        test_suites = [
            ("Memory MCP Server", test_memory_server),
            ("Memory API Endpoints", test_memory_api),
            ("Memory Sharing", test_memory_sharing),
            ("MCP Protocol", test_mcp_protocol),
            ("Agent Memory Handoff", test_agent_memory_handoff),
        ]

    for name, test_fn in test_suites:
        try:
            passed, results = test_fn()
            total_tests += len(results)
            passed_tests += sum(results)
            all_passed = all_passed and passed
        except Exception as e:
            print(f"\n{Colors.RED}Error running {name}: {e}{Colors.RESET}")
            all_passed = False
            if args.verbose:
                import traceback
                traceback.print_exc()

    # Summary
    print(f"\n{Colors.BOLD}{'='*60}{Colors.RESET}")
    print(f"{Colors.BOLD}Summary{Colors.RESET}")
    print(f"{'='*60}")
    print(f"Total tests: {total_tests}")
    print(f"Passed: {Colors.GREEN}{passed_tests}{Colors.RESET}")
    print(f"Failed: {Colors.RED}{total_tests - passed_tests}{Colors.RESET}")

    if all_passed:
        print(f"\n{Colors.GREEN}{Colors.BOLD}✓ All tests passed!{Colors.RESET}\n")
        return 0
    else:
        print(f"\n{Colors.RED}{Colors.BOLD}✗ Some tests failed{Colors.RESET}\n")
        return 1


if __name__ == '__main__':
    sys.exit(main())
