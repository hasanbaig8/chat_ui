# Testing Guide

This document describes the testing infrastructure for Claude Chat UI.

## Overview

The project uses a multi-layered testing approach:

- **Backend Unit Tests** - pytest tests for Python services
- **E2E Tests** - Playwright tests for user workflows
- **Visual Regression Tests** - Playwright screenshot comparisons
- **Mock Mode** - Deterministic streaming for reliable tests

## Quick Start

```bash
# Install test dependencies
pip install pytest pytest-asyncio
npm install

# Run all backend tests
npm run test:backend

# Run E2E tests (starts server automatically)
npm run test:e2e

# Run with visible browser
npm run test:e2e:headed

# Run visual regression tests
npm run test:visual

# Run everything in mock mode
npm run test:mock
```

## Mock Mode (MOCK_LLM=1)

When `MOCK_LLM=1` is set, the app uses deterministic mock streams instead of calling the Anthropic API. This enables:

- **Deterministic tests** - Same output every time
- **No API costs** - No API calls needed
- **Fast execution** - Minimal delays between events
- **Offline development** - Works without internet

### Starting the server in mock mode

```bash
MOCK_LLM=1 python app.py
# or
npm run dev:mock
```

### Mock stream behavior

**Normal Chat Stream** emits:
1. `message_id` - Message tracking
2. `thinking` events (if enabled)
3. `web_search_*` events (if enabled)
4. `text` events - Response content
5. `done` - Stream complete

**Agent Chat Stream** emits:
1. `message_id` - Message tracking
2. `session_id` - Session tracking
3. `text` events - Initial response
4. `tool_use` / `tool_result` events
5. `surface_content` events
6. `text` events - Final response
7. `done` - Stream complete

### Mock mode detection

The app detects mock mode via:

```python
from services.mock_streams import is_mock_mode

if is_mock_mode():
    # Use mock streams
```

Check mode at runtime:
```bash
curl http://localhost:8079/dev/status
# {"mock_mode": true, "environment": "development", ...}
```

## Dev UI Fixture Harness

Visit `/dev/ui` to see all UI components in various states. This page is used for:

- Visual regression testing
- Manual UI verification
- Stream event debugging

Features:
- Message fixtures (user, assistant, streaming)
- Tool use and result blocks
- Web search results
- Surface content blocks
- Stream testing buttons

## Test Structure

```
tests/
├── backend/                 # Python unit tests
│   ├── __init__.py
│   ├── test_content_normalizer.py
│   ├── test_mock_streams.py
│   ├── test_settings_service.py
│   └── test_streaming_service.py
├── e2e/                     # Playwright E2E tests
│   ├── chat.spec.ts
│   └── streaming.spec.ts
├── visual/                  # Visual regression tests
│   └── fixtures.spec.ts
└── conftest.py             # Pytest fixtures
```

## Backend Tests

Backend tests use pytest with pytest-asyncio for async support.

### Running tests

```bash
# All backend tests
pytest tests/backend/ -v

# Specific test file
pytest tests/backend/test_streaming_service.py -v

# Specific test
pytest tests/backend/test_streaming_service.py::TestStreamingService::test_start_agent_stream -v

# With coverage
pytest tests/backend/ --cov=services --cov-report=html
```

### Test categories

- **test_content_normalizer.py** - Content normalization logic
- **test_mock_streams.py** - Mock stream generators
- **test_settings_service.py** - Settings resolution priority
- **test_streaming_service.py** - Stream registry operations

### Writing backend tests

```python
import pytest
from services.streaming_service import StreamingService, StreamType

class TestStreamingService:
    @pytest.fixture
    def streaming_service(self):
        return StreamingService()

    def test_start_normal_stream(self, streaming_service):
        stop_event = streaming_service.start_stream("conv-1", StreamType.NORMAL)
        assert stop_event is None
        assert streaming_service.is_streaming("conv-1") is True
```

## E2E Tests

E2E tests use Playwright to simulate real user interactions.

### Running tests

```bash
# Run all E2E tests
npm run test:e2e

# With visible browser
npm run test:e2e:headed

# Interactive UI mode
npm run test:e2e:ui

# Specific test file
npx playwright test tests/e2e/chat.spec.ts
```

### Test categories

- **chat.spec.ts** - Core chat functionality
- **streaming.spec.ts** - Stream testing via dev UI

### Writing E2E tests

```typescript
import { test, expect } from '@playwright/test';

test('should send a message', async ({ page }) => {
  await page.goto('/');
  await page.locator('#chat-input').fill('Hello');
  await page.locator('#send-button').click();
  await expect(page.locator('.assistant-message')).toBeVisible({ timeout: 30000 });
});
```

## Visual Regression Tests

Visual tests capture screenshots and compare against baselines.

### Running tests

```bash
# Compare against baselines
npm run test:visual

# Update baseline screenshots
npm run test:visual:update
```

### Test flow

1. Visit `/dev/ui` fixture harness
2. Capture screenshots of each component
3. Compare against baseline images in `tests/visual/*.png-snapshots/`
4. Fail on visual differences beyond threshold

### Writing visual tests

```typescript
import { test, expect } from '@playwright/test';

test('user message - simple', async ({ page }) => {
  await page.goto('/dev/ui');
  const fixture = page.locator('[data-testid="fixture-user-simple"]');
  await expect(fixture).toHaveScreenshot('user-message-simple.png');
});
```

## Configuration

### pytest.ini (if needed)

```ini
[pytest]
asyncio_mode = auto
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
```

### playwright.config.ts

Key settings:
- `baseURL`: `http://localhost:8079`
- `webServer`: Auto-starts the dev server
- `screenshot`: On failure
- `trace`: On first retry

## CI Integration

### GitHub Actions example

```yaml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: |
          pip install -r requirements.txt
          pip install pytest pytest-asyncio
          npm install
          npx playwright install chromium

      - name: Backend tests
        run: pytest tests/backend/ -v

      - name: E2E tests (mock mode)
        env:
          MOCK_LLM: 1
        run: npm run test:e2e

      - name: Visual tests
        env:
          MOCK_LLM: 1
        run: npm run test:visual
```

## Troubleshooting

### Tests timeout waiting for API response

Use mock mode:
```bash
MOCK_LLM=1 npm run test:e2e
```

### Visual tests fail with minor differences

Update baselines if changes are intentional:
```bash
npm run test:visual:update
```

### Circular import errors in tests

Use the mock patterns from `test_settings_service.py` to mock modules before import.

### Playwright can't find browser

Install browsers:
```bash
npx playwright install chromium
```

## npm Scripts Reference

| Script | Description |
|--------|-------------|
| `npm run test` | Run pytest tests |
| `npm run test:e2e` | Run Playwright E2E tests |
| `npm run test:e2e:headed` | Run E2E tests with visible browser |
| `npm run test:e2e:ui` | Run E2E tests in interactive UI mode |
| `npm run test:visual` | Run visual regression tests |
| `npm run test:visual:update` | Update visual test baselines |
| `npm run test:mock` | Run all tests in mock mode |
| `npm run test:backend` | Run backend pytest tests only |
| `npm run test:all` | Run backend + E2E tests |
| `npm run dev:mock` | Start server in mock mode |
