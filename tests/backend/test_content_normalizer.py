"""Tests for the content normalizer."""

import pytest
from services.content_normalizer import (
    normalize_content,
    normalize_block,
    extract_text_content,
    has_special_blocks,
)


class TestNormalizeContent:
    """Test suite for normalize_content function."""

    def test_normalize_string(self):
        """Simple strings should pass through unchanged."""
        content = "Hello, world!"
        result = normalize_content(content)
        assert result == "Hello, world!"

    def test_normalize_none(self):
        """None should become empty string."""
        result = normalize_content(None)
        assert result == ""

    def test_normalize_empty_string(self):
        """Empty string should pass through."""
        result = normalize_content("")
        assert result == ""

    def test_normalize_dict_with_text(self):
        """Dict with text key should be preserved."""
        content = {"text": "Hello", "web_searches": []}
        result = normalize_content(content)
        assert isinstance(result, dict)
        assert result["text"] == "Hello"

    def test_normalize_dict_with_web_searches(self):
        """Dict with web_searches should preserve them."""
        content = {
            "text": "Search results:",
            "web_searches": [
                {"query": "test", "results": [{"title": "Result", "url": "http://example.com"}]}
            ]
        }
        result = normalize_content(content)
        assert "web_searches" in result
        assert len(result["web_searches"]) == 1

    def test_normalize_list_of_text_blocks(self):
        """List of text blocks should be normalized."""
        content = [
            {"type": "text", "text": "Hello "},
            {"type": "text", "text": "world!"}
        ]
        result = normalize_content(content)
        assert isinstance(result, list)
        assert len(result) == 2

    def test_normalize_mixed_content_blocks(self):
        """Mixed content blocks (text + tool_use) should be normalized."""
        content = [
            {"type": "text", "text": "Let me help."},
            {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {"path": "/file"}},
            {"type": "text", "text": "Done!"}
        ]
        result = normalize_content(content)
        assert isinstance(result, list)
        assert len(result) == 3
        assert result[0]["type"] == "text"
        assert result[1]["type"] == "tool_use"

    def test_normalize_tool_use_block(self):
        """Tool use blocks should be normalized with required fields."""
        content = [{"type": "tool_use", "id": "t1", "name": "Read", "input": {}}]
        result = normalize_content(content)
        block = result[0]
        assert block["type"] == "tool_use"
        assert "id" in block
        assert "name" in block
        assert "input" in block

    def test_normalize_surface_content_block(self):
        """Surface content blocks should be normalized."""
        content = [
            {
                "type": "surface_content",
                "content_id": "sc-1",
                "content_type": "html",
                "title": "Dashboard",
                "content": "<div>Hello</div>"
            }
        ]
        result = normalize_content(content)
        block = result[0]
        assert block["type"] == "surface_content"
        assert "content_id" in block


class TestNormalizeBlock:
    """Test suite for normalize_block function."""

    def test_normalize_none(self):
        """None should return None."""
        result = normalize_block(None)
        assert result is None

    def test_normalize_string_to_text_block(self):
        """String should become text block."""
        result = normalize_block("Hello")
        assert result == {"type": "text", "text": "Hello"}

    def test_normalize_text_block(self):
        """Text block should be normalized."""
        result = normalize_block({"type": "text", "text": "Hello"})
        assert result == {"type": "text", "text": "Hello"}

    def test_normalize_tool_use_block(self):
        """Tool use block should include all required fields."""
        result = normalize_block({
            "type": "tool_use",
            "id": "t1",
            "name": "Read"
        })
        assert result["type"] == "tool_use"
        assert result["id"] == "t1"
        assert result["name"] == "Read"
        assert result["input"] == {}


class TestExtractTextContent:
    """Test suite for extract_text_content function."""

    def test_extract_from_string(self):
        """Extract from plain string."""
        result = extract_text_content("Hello, world!")
        assert result == "Hello, world!"

    def test_extract_from_dict(self):
        """Extract from dict with text key."""
        content = {"text": "Hello", "web_searches": []}
        result = extract_text_content(content)
        assert result == "Hello"

    def test_extract_from_list(self):
        """Extract from list of text blocks."""
        content = [
            {"type": "text", "text": "Hello"},
            {"type": "tool_use", "id": "t1", "name": "Read", "input": {}},
            {"type": "text", "text": "world!"}
        ]
        result = extract_text_content(content)
        assert result == "Hello\nworld!"

    def test_extract_from_none(self):
        """Extract from None returns empty string."""
        result = extract_text_content(None)
        assert result == ""


class TestHasSpecialBlocks:
    """Test suite for has_special_blocks function."""

    def test_string_has_no_special_blocks(self):
        """String content has no special blocks."""
        assert has_special_blocks("Hello") is False

    def test_dict_has_no_special_blocks(self):
        """Dict content has no special blocks."""
        assert has_special_blocks({"text": "Hello"}) is False

    def test_text_only_list(self):
        """List with only text blocks has no special blocks."""
        content = [{"type": "text", "text": "Hello"}]
        assert has_special_blocks(content) is False

    def test_list_with_tool_use(self):
        """List with tool_use has special blocks."""
        content = [
            {"type": "text", "text": "Hello"},
            {"type": "tool_use", "id": "t1", "name": "Read", "input": {}}
        ]
        assert has_special_blocks(content) is True

    def test_list_with_surface_content(self):
        """List with surface_content has special blocks."""
        content = [
            {"type": "text", "text": "Hello"},
            {"type": "surface_content", "content_id": "sc-1", "content_type": "html"}
        ]
        assert has_special_blocks(content) is True
