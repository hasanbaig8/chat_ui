"""File processing utilities for uploads."""

import base64
import mimetypes
from pathlib import Path
from typing import Dict, Any, Optional, Tuple

from config import (
    MAX_IMAGE_SIZE, MAX_PDF_SIZE, MAX_TEXT_SIZE,
    ALLOWED_IMAGE_TYPES, ALLOWED_DOCUMENT_TYPES, ALLOWED_TEXT_EXTENSIONS
)


class FileProcessor:
    """Process uploaded files for the Anthropic API."""

    @staticmethod
    def get_mime_type(filename: str, content_type: Optional[str] = None) -> str:
        """Determine the MIME type of a file."""
        if content_type and content_type != "application/octet-stream":
            return content_type

        mime_type, _ = mimetypes.guess_type(filename)
        return mime_type or "application/octet-stream"

    @staticmethod
    def validate_file(
        filename: str,
        content: bytes,
        content_type: Optional[str] = None
    ) -> Tuple[bool, str, str]:
        """
        Validate an uploaded file.

        Returns: (is_valid, error_message, file_type)
        file_type is one of: 'image', 'document', 'text'
        """
        mime_type = FileProcessor.get_mime_type(filename, content_type)
        file_size = len(content)
        ext = Path(filename).suffix.lower()

        # Check for images
        if mime_type in ALLOWED_IMAGE_TYPES:
            if file_size > MAX_IMAGE_SIZE:
                return False, f"Image too large. Maximum size is {MAX_IMAGE_SIZE // (1024*1024)}MB", ""
            return True, "", "image"

        # Check for PDFs
        if mime_type in ALLOWED_DOCUMENT_TYPES or ext == ".pdf":
            if file_size > MAX_PDF_SIZE:
                return False, f"PDF too large. Maximum size is {MAX_PDF_SIZE // (1024*1024)}MB", ""
            return True, "", "document"

        # Check for text files
        if ext in ALLOWED_TEXT_EXTENSIONS:
            if file_size > MAX_TEXT_SIZE:
                return False, f"Text file too large. Maximum size is {MAX_TEXT_SIZE // (1024*1024)}MB", ""
            return True, "", "text"

        # Check if it might be a text file by content type
        if mime_type and mime_type.startswith("text/"):
            if file_size > MAX_TEXT_SIZE:
                return False, f"Text file too large. Maximum size is {MAX_TEXT_SIZE // (1024*1024)}MB", ""
            return True, "", "text"

        return False, f"Unsupported file type: {mime_type or ext}", ""

    @staticmethod
    def process_file(
        filename: str,
        content: bytes,
        content_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Process a file for the Anthropic API.

        Returns the appropriate content block format for the API.
        """
        is_valid, error, file_type = FileProcessor.validate_file(filename, content, content_type)

        if not is_valid:
            raise ValueError(error)

        mime_type = FileProcessor.get_mime_type(filename, content_type)

        if file_type == "image":
            return {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": mime_type,
                    "data": base64.b64encode(content).decode("utf-8")
                }
            }

        elif file_type == "document":
            return {
                "type": "document",
                "source": {
                    "type": "base64",
                    "media_type": "application/pdf",
                    "data": base64.b64encode(content).decode("utf-8")
                }
            }

        elif file_type == "text":
            # For text files, we include them as text content
            try:
                text_content = content.decode("utf-8")
            except UnicodeDecodeError:
                text_content = content.decode("latin-1")

            return {
                "type": "text",
                "text": f"File: {filename}\n\n```\n{text_content}\n```"
            }

        raise ValueError(f"Unknown file type: {file_type}")

    @staticmethod
    def create_preview(
        filename: str,
        content: bytes,
        content_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Create a preview representation of a file.

        Returns metadata for UI display.
        """
        mime_type = FileProcessor.get_mime_type(filename, content_type)
        file_size = len(content)
        ext = Path(filename).suffix.lower()

        preview = {
            "filename": filename,
            "size": file_size,
            "size_display": FileProcessor._format_size(file_size),
            "mime_type": mime_type,
            "extension": ext
        }

        # For images, include base64 for thumbnail
        if mime_type in ALLOWED_IMAGE_TYPES:
            preview["type"] = "image"
            preview["thumbnail"] = f"data:{mime_type};base64,{base64.b64encode(content).decode('utf-8')}"

        elif mime_type in ALLOWED_DOCUMENT_TYPES or ext == ".pdf":
            preview["type"] = "document"

        else:
            preview["type"] = "text"
            # Include first few lines for text preview
            try:
                text = content.decode("utf-8")[:500]
                preview["preview_text"] = text
            except UnicodeDecodeError:
                preview["preview_text"] = "[Binary content]"

        return preview

    @staticmethod
    def _format_size(size: int) -> str:
        """Format file size for display."""
        for unit in ["B", "KB", "MB", "GB"]:
            if size < 1024:
                return f"{size:.1f} {unit}"
            size /= 1024
        return f"{size:.1f} TB"
