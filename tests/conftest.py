"""Pytest configuration and fixtures."""

import asyncio
import os
import sys
import tempfile
import pytest
from typing import Generator, AsyncGenerator

# Add project root to Python path
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if project_root not in sys.path:
    sys.path.insert(0, project_root)


@pytest.fixture(scope="session")
def event_loop():
    """Create an event loop for the test session."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def temp_data_dir() -> Generator[str, None, None]:
    """Create a temporary data directory for tests."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


@pytest.fixture
def mock_env(monkeypatch):
    """Set up mock environment variables."""
    monkeypatch.setenv("MOCK_LLM", "1")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    return monkeypatch


@pytest.fixture
async def file_store(temp_data_dir):
    """Create a file conversation store with temporary directory."""
    from services.file_conversation_store import FileConversationStore

    store = FileConversationStore(data_dir=temp_data_dir)
    await store.initialize()
    return store


@pytest.fixture
def streaming_service():
    """Create a streaming service instance."""
    from services.streaming_service import StreamingService

    return StreamingService()


@pytest.fixture
def settings_service(temp_data_dir):
    """Create a settings service with temporary directory."""
    from services.settings_service import SettingsService

    return SettingsService(data_dir=temp_data_dir)
