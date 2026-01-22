"""File upload handling endpoints."""

import os
from pathlib import Path
from typing import List, Optional
from fastapi import APIRouter, UploadFile, File, HTTPException, Query
from pydantic import BaseModel

from services.file_processor import FileProcessor

router = APIRouter(prefix="/api/files", tags=["files"])

processor = FileProcessor()

# Base directory for server file browser (user's home)
BASE_DIR = Path.home()


class ServerFileRequest(BaseModel):
    """Request to read a file from the server."""
    path: str


@router.get("/browse")
async def browse_directory(path: Optional[str] = Query(default=None)):
    """
    Browse files on the server filesystem.
    Returns list of files and directories.
    """
    try:
        if path:
            dir_path = Path(path).resolve()
        else:
            dir_path = BASE_DIR

        # Security: ensure we're not going outside allowed areas
        # Allow access to home directory and subdirectories
        if not str(dir_path).startswith(str(BASE_DIR)):
            dir_path = BASE_DIR

        if not dir_path.exists():
            raise HTTPException(status_code=404, detail="Directory not found")

        if not dir_path.is_dir():
            raise HTTPException(status_code=400, detail="Path is not a directory")

        items = []
        try:
            for item in sorted(dir_path.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
                # Skip hidden files and common unneeded directories
                if item.name.startswith('.'):
                    continue

                try:
                    stat = item.stat()
                    items.append({
                        "name": item.name,
                        "path": str(item),
                        "is_dir": item.is_dir(),
                        "size": stat.st_size if item.is_file() else None,
                        "extension": item.suffix.lower() if item.is_file() else None
                    })
                except (PermissionError, OSError):
                    continue
        except PermissionError:
            raise HTTPException(status_code=403, detail="Permission denied")

        return {
            "current_path": str(dir_path),
            "parent_path": str(dir_path.parent) if dir_path != BASE_DIR else None,
            "items": items
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/read-server-file")
async def read_server_file(request: ServerFileRequest):
    """
    Read a file from the server filesystem and return it processed for the API.
    """
    try:
        file_path = Path(request.path).resolve()

        # Security check
        if not str(file_path).startswith(str(BASE_DIR)):
            raise HTTPException(status_code=403, detail="Access denied")

        if not file_path.exists():
            raise HTTPException(status_code=404, detail="File not found")

        if not file_path.is_file():
            raise HTTPException(status_code=400, detail="Path is not a file")

        # Read file content
        content = file_path.read_bytes()

        # Process file
        content_block = processor.process_file(
            filename=file_path.name,
            content=content,
            content_type=None
        )

        preview = processor.create_preview(
            filename=file_path.name,
            content=content,
            content_type=None
        )

        return {
            "content_block": content_block,
            "preview": preview
        }

    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """
    Upload a file and get its processed content block for the API.

    Returns the content block in Anthropic API format.
    """
    content = await file.read()

    try:
        content_block = processor.process_file(
            filename=file.filename or "unknown",
            content=content,
            content_type=file.content_type
        )

        preview = processor.create_preview(
            filename=file.filename or "unknown",
            content=content,
            content_type=file.content_type
        )

        return {
            "content_block": content_block,
            "preview": preview
        }

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/upload-multiple")
async def upload_multiple_files(files: List[UploadFile] = File(...)):
    """
    Upload multiple files at once.

    Returns a list of content blocks.
    """
    results = []
    errors = []

    for file in files:
        content = await file.read()

        try:
            content_block = processor.process_file(
                filename=file.filename or "unknown",
                content=content,
                content_type=file.content_type
            )

            preview = processor.create_preview(
                filename=file.filename or "unknown",
                content=content,
                content_type=file.content_type
            )

            results.append({
                "filename": file.filename,
                "content_block": content_block,
                "preview": preview
            })

        except ValueError as e:
            errors.append({
                "filename": file.filename,
                "error": str(e)
            })

    return {
        "results": results,
        "errors": errors
    }
