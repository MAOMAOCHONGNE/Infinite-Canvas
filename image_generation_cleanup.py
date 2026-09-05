"""Crash-safe file transaction for permanent image-generation cleanup."""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import tempfile
from typing import Iterable
from uuid import uuid4


class ImageGenerationCleanupTransaction:
    """Stage owned files, then cross one explicit irreversible commit point."""

    VERSION = 1

    def __init__(self, root: Path, allowed_roots: Iterable[Path], operation_id: str | None = None):
        self.root = Path(os.path.abspath(root))
        self.allowed_roots = tuple(Path(os.path.abspath(item)) for item in allowed_roots)
        self.staging_root = self.root / "data" / "image_generation_cleanup_staging"
        self.operation_id = operation_id or uuid4().hex
        self.operation_root = self.staging_root / self.operation_id
        self.manifest_path = self.operation_root / "manifest.json"
        self.manifest = {"version": self.VERSION, "phase": "preparing", "moves": []}

    @staticmethod
    def _is_link_or_reparse(path: Path) -> bool:
        details = path.lstat()
        attributes = int(getattr(details, "st_file_attributes", 0) or 0)
        return stat.S_ISLNK(details.st_mode) or bool(attributes & 0x0400)

    def _safe_path(self, path: Path, *, roots: Iterable[Path], require_exists: bool = False) -> Path:
        candidate = Path(os.path.abspath(path))
        boundaries = tuple(Path(os.path.abspath(item)) for item in roots)
        if not any(self._is_relative_to(candidate, boundary) for boundary in boundaries):
            raise ValueError("清理文件路径越界")
        current = self.root
        try:
            relative = candidate.relative_to(self.root)
        except ValueError as exc:
            raise ValueError("清理文件不属于当前工作区") from exc
        if os.path.lexists(current) and self._is_link_or_reparse(current):
            raise ValueError("清理路径不能包含链接或重解析点")
        for component in relative.parts:
            current = current / component
            if os.path.lexists(current) and self._is_link_or_reparse(current):
                raise ValueError("清理路径不能包含链接或重解析点")
        if require_exists and not os.path.lexists(candidate):
            raise ValueError("清理文件不存在")
        return candidate

    @staticmethod
    def _is_relative_to(path: Path, root: Path) -> bool:
        try:
            path.relative_to(root)
            return True
        except ValueError:
            return False

    def _relative(self, path: Path) -> str:
        return self._safe_path(path, roots=(self.root,)).relative_to(self.root).as_posix()

    def _from_relative(self, value: object, *, roots: Iterable[Path]) -> Path:
        if not isinstance(value, str) or not value or "\\" in value:
            raise ValueError("清理事务路径无效")
        relative = Path(value)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("清理事务路径无效")
        return self._safe_path(self.root / relative, roots=roots)

    @staticmethod
    def _atomic_write(target: Path, payload: dict) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", delete=False, dir=target.parent
            ) as handle:
                temporary_name = handle.name
                json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, target)
            temporary_name = None
        finally:
            if temporary_name:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass

    def begin(self) -> None:
        self._safe_path(self.staging_root, roots=(self.root,))
        self.staging_root.mkdir(parents=True, exist_ok=True)
        self.operation_root.mkdir(exist_ok=False)
        self._atomic_write(self.manifest_path, self.manifest)

    def stage(self, sources: Iterable[Path]) -> None:
        seen = {str(item["source"]) for item in self.manifest["moves"]}
        for source in sources:
            safe_source = self._safe_path(source, roots=self.allowed_roots, require_exists=True)
            source_relative = self._relative(safe_source)
            if source_relative in seen:
                continue
            index = len(self.manifest["moves"])
            staged = self.operation_root / f"{index:06d}-{safe_source.name}"
            move = {"source": source_relative, "staged": self._relative(staged)}
            self.manifest["moves"].append(move)
            self._atomic_write(self.manifest_path, self.manifest)
            os.replace(safe_source, staged)
            seen.add(source_relative)

    def rollback(self) -> None:
        for move in reversed(self.manifest.get("moves") or []):
            source = self._from_relative(move.get("source"), roots=self.allowed_roots)
            staged = self._from_relative(move.get("staged"), roots=(self.operation_root,))
            if not os.path.lexists(staged):
                continue
            if os.path.lexists(source):
                raise ValueError("清理回滚发现目标文件冲突")
            source.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staged, source)
        self._remove_empty_operation()

    def commit(self) -> None:
        self.manifest["phase"] = "committed"
        self._atomic_write(self.manifest_path, self.manifest)
        try:
            self._finish_committed()
        except OSError:
            # The commit marker is the irreversible boundary. Startup recovery
            # will finish removing any staged files that remain inaccessible.
            pass

    def _finish_committed(self) -> None:
        for move in self.manifest.get("moves") or []:
            staged = self._from_relative(move.get("staged"), roots=(self.operation_root,))
            if os.path.lexists(staged):
                staged.unlink()
        self._remove_empty_operation()

    def _remove_empty_operation(self) -> None:
        if os.path.lexists(self.manifest_path):
            self.manifest_path.unlink()
        try:
            self.operation_root.rmdir()
        except FileNotFoundError:
            pass
        try:
            self.staging_root.rmdir()
        except (FileNotFoundError, OSError):
            pass

    @classmethod
    def recover_pending(cls, root: Path, allowed_roots: Iterable[Path]) -> None:
        probe = cls(root, allowed_roots, operation_id="recovery-probe")
        staging_root = probe.staging_root
        if not os.path.lexists(staging_root):
            return
        probe._safe_path(staging_root, roots=(probe.root,), require_exists=True)
        for operation_root in sorted(item for item in staging_root.iterdir() if item.is_dir()):
            operation_id = operation_root.name
            if not operation_id or not operation_id.isalnum():
                raise ValueError("存在无法识别的图片生成清理事务")
            transaction = cls(root, allowed_roots, operation_id=operation_id)
            manifest_path = transaction._safe_path(
                transaction.manifest_path, roots=(operation_root,), require_exists=True
            )
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValueError("图片生成清理事务记录损坏") from exc
            if not isinstance(manifest, dict) or manifest.get("version") != cls.VERSION:
                raise ValueError("图片生成清理事务版本无效")
            transaction.manifest = manifest
            if manifest.get("phase") == "committed":
                transaction._finish_committed()
            elif manifest.get("phase") == "preparing":
                transaction.rollback()
            else:
                raise ValueError("图片生成清理事务状态无效")
