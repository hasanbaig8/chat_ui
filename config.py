"""Configuration constants and model definitions for Claude Chat UI."""

from dataclasses import dataclass
from typing import Optional


@dataclass
class ModelConfig:
    """Configuration for a Claude model."""
    id: str
    name: str
    supports_thinking: bool
    max_tokens: int
    description: str


# Available Claude models
MODELS = {
    "claude-opus-4-5-20251101": ModelConfig(
        id="claude-opus-4-5-20251101",
        name="Claude Opus 4.5",
        supports_thinking=True,
        max_tokens=64000,  # API limit for output tokens
        description="Most capable model, best for complex tasks"
    ),
    "claude-sonnet-4-5-20250929": ModelConfig(
        id="claude-sonnet-4-5-20250929",
        name="Claude Sonnet 4.5",
        supports_thinking=True,
        max_tokens=64000,  # API limit for output tokens
        description="Balanced performance and speed with extended thinking"
    ),
    "claude-sonnet-4-20250514": ModelConfig(
        id="claude-sonnet-4-20250514",
        name="Claude Sonnet 4",
        supports_thinking=True,
        max_tokens=64000,  # API limit for output tokens
        description="Fast and capable"
    ),
    "claude-3-5-sonnet-20241022": ModelConfig(
        id="claude-3-5-sonnet-20241022",
        name="Claude 3.5 Sonnet",
        supports_thinking=False,
        max_tokens=8192,
        description="Previous generation, fast responses"
    ),
    "claude-3-5-haiku-20241022": ModelConfig(
        id="claude-3-5-haiku-20241022",
        name="Claude 3.5 Haiku",
        supports_thinking=False,
        max_tokens=8192,
        description="Fastest model, best for simple tasks"
    ),
}

# Default model
DEFAULT_MODEL = "claude-opus-4-5-20251101"

# Default parameters
DEFAULT_TEMPERATURE = 1.0
DEFAULT_MAX_TOKENS = 4096
DEFAULT_TOP_P = 1.0
DEFAULT_TOP_K = 0  # 0 means disabled

# Extended thinking limits
# thinking_budget should be less than max_tokens to leave room for response
MIN_THINKING_BUDGET = 1024
MAX_THINKING_BUDGET = 50000  # Keep under max output tokens (64K)
DEFAULT_THINKING_BUDGET = 10000
MAX_OUTPUT_TOKENS = 64000  # Standard API max output limit

# File upload limits
MAX_IMAGE_SIZE = 5 * 1024 * 1024  # 5MB
MAX_PDF_SIZE = 32 * 1024 * 1024  # 32MB
MAX_TEXT_SIZE = 1 * 1024 * 1024  # 1MB
MAX_PDF_PAGES = 100

# Allowed file types
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
ALLOWED_DOCUMENT_TYPES = {"application/pdf"}
ALLOWED_TEXT_EXTENSIONS = {".txt", ".md", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".html", ".css", ".xml", ".csv"}

# Storage paths
DATABASE_PATH = "data/conversations.db"  # Legacy SQLite path (for reference)
CONVERSATIONS_PATH = "data/conversations"  # File-based conversation storage
