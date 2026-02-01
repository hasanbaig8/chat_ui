"""Development endpoints for testing and debugging.

These endpoints are only available when the server is running in development mode.
"""

import os
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from services.mock_streams import is_mock_mode

router = APIRouter(prefix="/dev", tags=["dev"])
templates = Jinja2Templates(directory="templates")


@router.get("/ui", response_class=HTMLResponse)
async def dev_ui(request: Request):
    """Serve the development UI fixture harness.

    This page displays various message states for visual regression testing.
    Works best with MOCK_LLM=1 for deterministic streaming.
    """
    return templates.TemplateResponse(
        "dev_ui.html",
        {
            "request": request,
            "mock_mode": is_mock_mode(),
            "env": os.getenv("ENVIRONMENT", "development")
        }
    )


@router.get("/status")
async def dev_status():
    """Get development environment status."""
    return {
        "mock_mode": is_mock_mode(),
        "environment": os.getenv("ENVIRONMENT", "development"),
        "mock_llm_env": os.getenv("MOCK_LLM", "not set")
    }
