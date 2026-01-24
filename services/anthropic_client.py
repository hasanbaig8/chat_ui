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
        web_search_enabled: bool = False,
        web_search_max_uses: int = 5,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Stream a message from the Anthropic API.

        Yields events with types: 'thinking', 'text', 'error', 'done', 'web_search_start', 'web_search_result'
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

        # Add web search tool if enabled
        if web_search_enabled:
            params["tools"] = [{
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": web_search_max_uses
            }]

        try:
            async with self.client.messages.stream(**params) as stream:
                current_tool_use_id = None
                async for event in stream:
                    # Handle different event types from the streaming API
                    if hasattr(event, 'type'):
                        if event.type == 'content_block_start':
                            if hasattr(event, 'content_block'):
                                block = event.content_block
                                block_type = getattr(block, 'type', None)

                                # Check if this is a server tool use (web search starting)
                                if block_type == 'server_tool_use':
                                    current_tool_use_id = getattr(block, 'id', None)
                                    tool_name = getattr(block, 'name', 'web_search')
                                    yield {
                                        "type": "web_search_start",
                                        "id": current_tool_use_id,
                                        "name": tool_name
                                    }

                                # Check if this is web search results
                                elif block_type == 'web_search_tool_result':
                                    search_results = getattr(block, 'content', [])
                                    # Convert results to serializable format
                                    results_list = []
                                    for result in search_results:
                                        if hasattr(result, 'type'):
                                            results_list.append({
                                                "type": result.type,
                                                "url": getattr(result, 'url', ''),
                                                "title": getattr(result, 'title', ''),
                                                "snippet": getattr(result, 'encrypted_content', '')[:200] if hasattr(result, 'encrypted_content') else '',
                                                "page_age": getattr(result, 'page_age', '')
                                            })
                                    yield {
                                        "type": "web_search_result",
                                        "tool_use_id": getattr(block, 'tool_use_id', current_tool_use_id),
                                        "results": results_list
                                    }

                        elif event.type == 'content_block_delta':
                            if hasattr(event, 'delta'):
                                delta = event.delta
                                delta_type = getattr(delta, 'type', None)

                                if delta_type == 'thinking_delta' and hasattr(delta, 'thinking'):
                                    yield {"type": "thinking", "content": delta.thinking}
                                elif delta_type == 'text_delta' and hasattr(delta, 'text'):
                                    yield {"type": "text", "content": delta.text}
                                elif delta_type == 'input_json_delta':
                                    # This is the search query being streamed
                                    partial_json = getattr(delta, 'partial_json', '')
                                    if partial_json and current_tool_use_id:
                                        yield {
                                            "type": "web_search_query",
                                            "id": current_tool_use_id,
                                            "partial_query": partial_json
                                        }

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
