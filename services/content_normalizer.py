"""Content normalization for message content shapes.

This module provides utilities to normalize message content into canonical
shapes, handling various legacy formats and ensuring consistent structure
for storage and retrieval.

Content can be:
- A simple string
- A dict with {text, web_searches} for web search results
- A list of content blocks (text, tool_use, surface_content, etc.)
"""

from typing import Any, Dict, List, Optional, Union


# Canonical block types
BLOCK_TYPE_TEXT = "text"
BLOCK_TYPE_TOOL_USE = "tool_use"
BLOCK_TYPE_TOOL_RESULT = "tool_result"
BLOCK_TYPE_SURFACE_CONTENT = "surface_content"
BLOCK_TYPE_IMAGE = "image"
BLOCK_TYPE_DOCUMENT = "document"
BLOCK_TYPE_THINKING = "thinking"


def normalize_content(content: Any) -> Any:
    """Normalize message content to a canonical form.

    This function handles various content shapes and normalizes them to
    ensure consistent handling in storage and rendering.

    Args:
        content: Content in any supported format

    Returns:
        Normalized content (string, dict with text/web_searches, or list of blocks)
    """
    if content is None:
        return ""

    # Simple string - return as-is
    if isinstance(content, str):
        return content

    # Dict with text + web_searches (web search result format)
    if isinstance(content, dict):
        return _normalize_content_dict(content)

    # List of content blocks
    if isinstance(content, list):
        return _normalize_content_blocks(content)

    # Unknown format - try to convert to string
    return str(content)


def _normalize_content_dict(content: Dict) -> Union[str, Dict]:
    """Normalize a dict content format.

    Handles:
    - {text: str, web_searches: [...]} - web search results
    - {type: "text", text: str} - single text block
    """
    # Web search format
    if "text" in content and "web_searches" in content:
        return {
            "text": content.get("text", ""),
            "web_searches": _normalize_web_searches(content.get("web_searches", []))
        }

    # Single text block format - convert to string
    if content.get("type") == BLOCK_TYPE_TEXT:
        return content.get("text", "")

    # Return as-is for other dict formats
    return content


def _normalize_content_blocks(blocks: List) -> List[Dict]:
    """Normalize a list of content blocks."""
    normalized = []
    for block in blocks:
        normalized_block = normalize_block(block)
        if normalized_block:
            normalized.append(normalized_block)
    return normalized


def normalize_block(block: Any) -> Optional[Dict]:
    """Normalize a single content block.

    Args:
        block: A content block (dict or other format)

    Returns:
        Normalized block dict or None if invalid
    """
    if block is None:
        return None

    if isinstance(block, str):
        return {"type": BLOCK_TYPE_TEXT, "text": block}

    if not isinstance(block, dict):
        return {"type": BLOCK_TYPE_TEXT, "text": str(block)}

    block_type = block.get("type", BLOCK_TYPE_TEXT)

    if block_type == BLOCK_TYPE_TEXT:
        return _normalize_text_block(block)
    elif block_type == BLOCK_TYPE_TOOL_USE:
        return _normalize_tool_use_block(block)
    elif block_type == BLOCK_TYPE_TOOL_RESULT:
        return _normalize_tool_result_block(block)
    elif block_type == BLOCK_TYPE_THINKING:
        return _normalize_thinking_block(block)
    elif block_type == BLOCK_TYPE_SURFACE_CONTENT:
        return _normalize_surface_content_block(block)
    elif block_type == BLOCK_TYPE_IMAGE:
        return _normalize_image_block(block)
    elif block_type == BLOCK_TYPE_DOCUMENT:
        return _normalize_document_block(block)
    else:
        # Unknown type - pass through with type preserved
        return block


def _normalize_text_block(block: Dict) -> Dict:
    """Normalize a text content block."""
    return {
        "type": BLOCK_TYPE_TEXT,
        "text": block.get("text", "")
    }


def _normalize_tool_use_block(block: Dict) -> Dict:
    """Normalize a tool_use content block."""
    return {
        "type": BLOCK_TYPE_TOOL_USE,
        "id": block.get("id", ""),
        "name": block.get("name", ""),
        "input": block.get("input", {})
    }


def _normalize_tool_result_block(block: Dict) -> Dict:
    """Normalize a tool_result content block."""
    return {
        "type": BLOCK_TYPE_TOOL_RESULT,
        "tool_use_id": block.get("tool_use_id", ""),
        "content": block.get("content", ""),
        "is_error": block.get("is_error", False)
    }


def _normalize_thinking_block(block: Dict) -> Dict:
    """Normalize a thinking content block."""
    return {
        "type": BLOCK_TYPE_THINKING,
        "content": block.get("content", "")
    }


def _normalize_surface_content_block(block: Dict) -> Dict:
    """Normalize a surface_content block."""
    normalized = {
        "type": BLOCK_TYPE_SURFACE_CONTENT,
        "content_id": block.get("content_id", ""),
        "content_type": block.get("content_type", "html"),
    }

    # Include title if present
    if "title" in block:
        normalized["title"] = block["title"]

    # Include either filename (reference) or content (inline)
    if "filename" in block:
        normalized["filename"] = block["filename"]
    elif "content" in block:
        normalized["content"] = block["content"]

    return normalized


def _normalize_image_block(block: Dict) -> Dict:
    """Normalize an image content block."""
    normalized = {
        "type": BLOCK_TYPE_IMAGE,
    }

    if "source" in block:
        normalized["source"] = block["source"]

    return normalized


def _normalize_document_block(block: Dict) -> Dict:
    """Normalize a document content block."""
    normalized = {
        "type": BLOCK_TYPE_DOCUMENT,
    }

    if "source" in block:
        normalized["source"] = block["source"]

    return normalized


def _normalize_web_searches(searches: List) -> List[Dict]:
    """Normalize web search results."""
    normalized = []
    for search in searches:
        if isinstance(search, dict):
            normalized.append({
                "id": search.get("id", ""),
                "query": search.get("query", ""),
                "results": search.get("results", [])
            })
    return normalized


def extract_text_content(content: Any) -> str:
    """Extract plain text from any content format.

    Useful for search indexing and preview generation.

    Args:
        content: Content in any supported format

    Returns:
        Plain text extracted from content
    """
    if content is None:
        return ""

    if isinstance(content, str):
        return content

    if isinstance(content, dict):
        # Web search format
        if "text" in content:
            return content["text"]
        # Single text block
        if content.get("type") == BLOCK_TYPE_TEXT:
            return content.get("text", "")
        return ""

    if isinstance(content, list):
        texts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == BLOCK_TYPE_TEXT:
                texts.append(block.get("text", ""))
            elif isinstance(block, str):
                texts.append(block)
        return "\n".join(texts)

    return str(content)


def has_special_blocks(content: Any) -> bool:
    """Check if content has special blocks (tool_use, surface_content, etc.).

    Args:
        content: Content in any supported format

    Returns:
        True if content contains non-text blocks
    """
    if not isinstance(content, list):
        return False

    for block in content:
        if isinstance(block, dict):
            block_type = block.get("type", BLOCK_TYPE_TEXT)
            if block_type != BLOCK_TYPE_TEXT:
                return True

    return False
