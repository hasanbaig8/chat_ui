"""Anthropic API client wrapper with streaming support."""

import os
from typing import AsyncGenerator, Optional, List, Dict, Any
import anthropic
from dotenv import load_dotenv

from config import MODELS, DEFAULT_MODEL, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS

load_dotenv()


class AnthropicClient:
    """Wrapper for Anthropic API with streaming support."""

    def __init__(self):
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY environment variable is required")
        # Use AsyncAnthropic for true async streaming
        self.client = anthropic.AsyncAnthropic(api_key=api_key)
        self._warmed_up = False

    async def warmup(self):
        """Warm up the API connection to avoid cold start latency."""
        if self._warmed_up:
            return
        try:
            # Use count_tokens as a lightweight warmup call
            await self.client.messages.count_tokens(
                model=DEFAULT_MODEL,
                messages=[{"role": "user", "content": "hi"}]
            )
            self._warmed_up = True
        except Exception as e:
            # Warmup failure is not critical
            print(f"API warmup failed (non-critical): {e}")

    async def stream_message(
        self,
        messages: List[Dict[str, Any]],
        model: str = DEFAULT_MODEL,
        system_prompt: Optional[str] = None,
        temperature: float = DEFAULT_TEMPERATURE,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        top_p: Optional[float] = None,
        top_k: Optional[int] = None,
        thinking_enabled: bool = False,
        thinking_budget: int = 10000,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Stream a message from the Anthropic API.

        Yields events with types: 'thinking', 'text', 'error', 'done'
        """
        model_config = MODELS.get(model)
        if not model_config:
            yield {"type": "error", "content": f"Unknown model: {model}"}
            return

        # Build request parameters
        params: Dict[str, Any] = {
            "model": model,
            "max_tokens": min(max_tokens, model_config.max_tokens),
            "messages": messages,
        }

        # Add optional parameters
        if system_prompt:
            params["system"] = system_prompt

        # Temperature is not allowed when thinking is enabled
        if not thinking_enabled:
            params["temperature"] = temperature
            if top_p is not None and top_p < 1.0:
                params["top_p"] = top_p
            if top_k is not None and top_k > 0:
                params["top_k"] = top_k

        # Add thinking configuration for supported models
        if thinking_enabled and model_config.supports_thinking:
            params["thinking"] = {
                "type": "enabled",
                "budget_tokens": thinking_budget
            }

        try:
            async with self.client.messages.stream(**params) as stream:
                async for event in stream:
                    # Handle different event types from the streaming API
                    if hasattr(event, 'type'):
                        if event.type == 'content_block_delta':
                            if hasattr(event, 'delta'):
                                delta = event.delta
                                if hasattr(delta, 'type'):
                                    if delta.type == 'thinking_delta' and hasattr(delta, 'thinking'):
                                        yield {"type": "thinking", "content": delta.thinking}
                                    elif delta.type == 'text_delta' and hasattr(delta, 'text'):
                                        yield {"type": "text", "content": delta.text}

                        elif event.type == 'message_stop':
                            yield {"type": "done", "content": ""}

        except anthropic.APIError as e:
            yield {"type": "error", "content": f"API Error: {str(e)}"}
        except Exception as e:
            yield {"type": "error", "content": f"Error: {str(e)}"}

    def get_available_models(self) -> List[Dict[str, Any]]:
        """Return list of available models with their configurations."""
        return [
            {
                "id": model.id,
                "name": model.name,
                "supports_thinking": model.supports_thinking,
                "max_tokens": model.max_tokens,
                "description": model.description
            }
            for model in MODELS.values()
        ]
