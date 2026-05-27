"""Project Context Store - L0 Memory Layer (P1 priority).

Stores and retrieves project-level metadata that should always be
available at session start. This includes tool listings, module
structure, and architecture summaries.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class ProjectContext:
    """Immutable project context loaded at session start.

    This is the L0 layer - always recalled, no embedding needed.
    Retrieved by project_id directly.
    """

    project_id: str
    name: str
    description: str = ""
    tools: list[str] = field(default_factory=list)
    modules: list[str] = field(default_factory=list)
    architecture_summary: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_context_string(self) -> str:
        """Render project context as a string for injection into prompt."""
        parts = [f"Project: {self.name}"]
        if self.description:
            parts.append(f"Description: {self.description}")
        if self.tools:
            parts.append(f"Available tools: {', '.join(self.tools)}")
        if self.modules:
            parts.append(f"Modules: {', '.join(self.modules)}")
        if self.architecture_summary:
            parts.append(f"Architecture: {self.architecture_summary}")
        return "\n".join(parts)


class ProjectContextStore:
    """Storage backend for L0 project context.

    Supports loading from a JSON file or in-memory registration.
    """

    def __init__(self, storage_path: Path | None = None) -> None:
        self._store: dict[str, ProjectContext] = {}
        self._storage_path = storage_path
        if storage_path and storage_path.exists():
            self._load_from_file(storage_path)

    def _load_from_file(self, path: Path) -> None:
        """Load project contexts from a JSON file."""
        data = json.loads(path.read_text(encoding="utf-8"))
        for project_id, info in data.items():
            self._store[project_id] = ProjectContext(
                project_id=project_id,
                name=info.get("name", project_id),
                description=info.get("description", ""),
                tools=info.get("tools", []),
                modules=info.get("modules", []),
                architecture_summary=info.get("architecture_summary", ""),
                metadata=info.get("metadata", {}),
            )

    def register(self, context: ProjectContext) -> None:
        """Register or update a project context."""
        self._store[context.project_id] = context
        self._persist()

    def get(self, project_id: str) -> ProjectContext | None:
        """Retrieve project context by ID."""
        return self._store.get(project_id)

    def remove(self, project_id: str) -> bool:
        """Remove a project context. Returns True if it existed."""
        if project_id in self._store:
            del self._store[project_id]
            self._persist()
            return True
        return False

    def list_projects(self) -> list[str]:
        """List all registered project IDs."""
        return list(self._store.keys())

    def _persist(self) -> None:
        """Persist store to file if storage_path is configured."""
        if self._storage_path is None:
            return
        data = {}
        for pid, ctx in self._store.items():
            data[pid] = {
                "name": ctx.name,
                "description": ctx.description,
                "tools": ctx.tools,
                "modules": ctx.modules,
                "architecture_summary": ctx.architecture_summary,
                "metadata": ctx.metadata,
            }
        self._storage_path.parent.mkdir(parents=True, exist_ok=True)
        self._storage_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
