"""API routes for documentation and help resources."""

from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse

router = APIRouter(prefix="/api/docs", tags=["docs"])

# Base directory
BASE_DIR = Path(__file__).parent.parent


@router.get("/capabilities", response_class=PlainTextResponse)
async def get_capabilities():
    """Get the capabilities documentation."""
    capabilities_path = BASE_DIR / "CAPABILITIES.md"
    if not capabilities_path.exists():
        raise HTTPException(status_code=404, detail="Capabilities documentation not found")

    return capabilities_path.read_text(encoding='utf-8')


@router.get("/code", response_class=PlainTextResponse)
async def get_backend_code():
    """Get key backend code files for understanding the implementation."""
    code_files = [
        "api/chat.py",
        "api/conversations.py",
        "api/projects.py",
        "api/agent_chat.py",
        "api/settings.py",
        "services/anthropic_client.py",
        "services/conversation_store.py",
        "services/file_conversation_store.py",
        "services/project_store.py",
        "services/agent_client.py",
        "config.py",
        "CLAUDE.md"
    ]

    combined_code = []
    combined_code.append("# BACKEND CODE REFERENCE\n")
    combined_code.append("# This document contains key backend code files for understanding how the application works.\n\n")

    for file_path in code_files:
        full_path = BASE_DIR / file_path
        if full_path.exists():
            combined_code.append(f"\n{'='*80}\n")
            combined_code.append(f"# FILE: {file_path}\n")
            combined_code.append(f"{'='*80}\n\n")
            try:
                content = full_path.read_text(encoding='utf-8')
                combined_code.append(content)
                combined_code.append("\n\n")
            except Exception as e:
                combined_code.append(f"# Error reading file: {e}\n\n")

    return "".join(combined_code)


@router.get("/frontend", response_class=PlainTextResponse)
async def get_frontend_code():
    """Get key frontend code files."""
    code_files = [
        "static/js/chat.js",
        "static/js/conversations.js",
        "static/js/projects.js",
        "static/js/settings.js",
        "static/js/workspace.js",
        "static/js/files.js"
    ]

    combined_code = []
    combined_code.append("# FRONTEND CODE REFERENCE\n")
    combined_code.append("# This document contains key frontend code files.\n\n")

    for file_path in code_files:
        full_path = BASE_DIR / file_path
        if full_path.exists():
            combined_code.append(f"\n{'='*80}\n")
            combined_code.append(f"# FILE: {file_path}\n")
            combined_code.append(f"{'='*80}\n\n")
            try:
                content = full_path.read_text(encoding='utf-8')
                # Limit frontend files to first 500 lines each to avoid huge context
                lines = content.split('\n')
                if len(lines) > 500:
                    content = '\n'.join(lines[:500]) + f"\n\n# ... (truncated, {len(lines) - 500} more lines) ..."
                combined_code.append(content)
                combined_code.append("\n\n")
            except Exception as e:
                combined_code.append(f"# Error reading file: {e}\n\n")

    return "".join(combined_code)
