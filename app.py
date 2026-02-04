"""FastAPI application entry point for Claude Chat UI."""

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.requests import Request
from dotenv import load_dotenv

from api import chat_router, conversations_router, files_router, agent_chat_router, settings_router, projects_router, docs_router, dev_router
from api.deps import initialize_all, get_agent_pool

# Load environment variables
load_dotenv()


async def periodic_pool_cleanup():
    """Background task to clean up stale agent pool sessions."""
    while True:
        try:
            await asyncio.sleep(60)  # Run every minute
            agent_pool = get_agent_pool()
            await agent_pool.cleanup_stale()
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"[CLEANUP] Error during pool cleanup: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Startup: Initialize all services via DI
    await initialize_all()

    # Start background cleanup task
    cleanup_task = asyncio.create_task(periodic_pool_cleanup())

    yield

    # Shutdown: Cancel cleanup task
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass


# Create FastAPI app
app = FastAPI(
    title="Claude Chat UI",
    description="A full-featured chat interface for Claude models",
    version="1.0.0",
    lifespan=lifespan
)

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Setup templates
templates = Jinja2Templates(directory="templates")

# Include routers
app.include_router(chat_router)
app.include_router(conversations_router)
app.include_router(files_router)
app.include_router(agent_chat_router)
app.include_router(settings_router)
app.include_router(projects_router)
app.include_router(docs_router)
app.include_router(dev_router)


@app.get("/")
async def index(request: Request):
    """Serve the main application page."""
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8079, reload=True)
