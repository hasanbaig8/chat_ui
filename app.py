"""FastAPI application entry point for Claude Chat UI."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.requests import Request
from dotenv import load_dotenv

from api import chat_router, conversations_router, files_router
from services.conversation_store import ConversationStore

# Load environment variables
load_dotenv()

# Initialize store for startup
store = ConversationStore()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Startup: Initialize database
    await store.initialize()
    yield
    # Shutdown: Nothing to clean up


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
    uvicorn.run(app, host="0.0.0.0", port=8080, reload=True)
