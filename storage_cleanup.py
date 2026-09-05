"""Crash-safe staging for safe cleanup of unreferenced workflow media.

The storage-manager cleanup path stages files first and then sends them to the
Windows Recycle Bin. It deliberately does not fall back to ``unlink`` when
the Recycle Bin API is unavailable.
"""

from __future__ import annotations

import json
import ctypes
import os
from pathlib import Path
import stat
import tempfile
from typing import Iterable
from uuid import uuid4


def move_paths_to_recycle_bin(paths: Iterable[Path]) -> None:
    """Move files to the Windows Recycle Bin without a permanent-delete fallback."""

    normalized: list[str] = []
    for raw in paths:
        path = Path(os.path.abspath(raw))
        if not os.path.lexists(path) or not path.is_file():
            raise OSError(f"回收站目标文件不存在：{path}")
        details = path.lstat()
        attributes = int(getattr(details, "st_file_attributes", 0) or 0)
        if stat.S_ISLNK(details.st_mode) or bool(attributes & 0x0400):
            raise OSError(f"回收站目标不能是链接或重解析点：{path}")
        normalized.append(str(path))

    if not normalized:
        return
    if os.name != "nt":
        raise OSError("Windows 回收站仅支持 Windows")

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", ctypes.c_void_p),
            ("wFunc", ctypes.c_uint),
            ("pFrom", ctypes.c_wchar_p),
            ("pTo", ctypes.c_wchar_p),
            ("fFlags", ctypes.c_ushort),
            ("fAnyOperationsAborted", ctypes.c_int),
            ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", ctypes.c_wchar_p),
        ]

    source_buffer = "\0".join(normalized) + "\0\0"
    operation = SHFILEOPSTRUCTW(
        hwnd=None,
        wFunc=3,  # FO_DELETE
        pFrom=source_buffer,
        pTo=None,
        fFlags=0x0004 | 0x0010 | 0x0040 | 0x0400,
        fAnyOperationsAborted=0,
        hNameMappings=None,
        lpszProgressTitle=None,
    )
    try:
        shell32 = ctypes.windll.shell32
        shell32.SHFileOperationW.argtypes = [ctypes.POINTER(SHFILEOPSTRUCTW)]
        shell32.SHFileOperationW.restype = ctypes.c_int
    except (AttributeError, OSError) as exc:
        raise OSError("Windows 回收站 API 不可用") from exc

    result = int(shell32.SHFileOperationW(ctypes.byref(operation)))
    if result != 0:
        raise OSError(result, "移入 Windows 回收站失败")
    if bool(operation.fAnyOperationsAborted):
        raise OSError("移入 Windows 回收站被中止")


class StorageCleanupTransaction:
    """Stage files on their own volumes before a recycle-bin hand-off."""

    VERSION = 1
    STAGING_DIR_NAME = ".infinite-canvas-cleanup"

    def __init__(
        self,
        manifest_root: Path,
        allowed_roots: Iterable[Path],
        operation_id: str | None = None,
    ):
        self.manifest_root = Path(os.path.abspath(manifest_root))
        unique_roots: list[Path] = []
        seen: set[str] = set()
        for raw in allowed_roots:
            root = Path(os.path.abspath(raw))
            key = os.path.normcase(str(root))
            if key in seen:
                continue
            seen.add(key)
            unique_roots.append(root)
        if not unique_roots:
            raise ValueError("清理目录不能为空")
        self.allowed_roots = tuple(unique_roots)
        self.operation_id = operation_id or uuid4().hex
        if not self.operation_id.isalnum():
            raise ValueError("清理事务编号无效")
        self.operation_root = self.manifest_root / self.operation_id
        self.manifest_path = self.operation_root / "manifest.json"
        self.manifest = {
            "version": self.VERSION,
            "phase": "preparing",
            "roots": [str(root) for root in self.allowed_roots],
            "moves": [],
        }

    @staticmethod
    def _is_relative_to(path: Path, root: Path) -> bool:
        try:
            path.relative_to(root)
            return True
        except ValueError:
            return False

    @staticmethod
    def _is_link_or_reparse(path: Path) -> bool:
        details = path.lstat()
        attributes = int(getattr(details, "st_file_attributes", 0) or 0)
        return stat.S_ISLNK(details.st_mode) or bool(attributes & 0x0400)

    @staticmethod
    def _atomic_write(target: Path, payload: dict) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                delete=False,
                dir=target.parent,
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

    def _root_for(self, path: Path) -> tuple[int, Path]:
        candidate = Path(os.path.abspath(path))
        matches = [
            (index, root)
            for index, root in enumerate(self.allowed_roots)
            if self._is_relative_to(candidate, root)
        ]
        if not matches:
            raise ValueError("清理文件路径越界")
        return max(matches, key=lambda item: len(item[1].parts))

    def _validate_root(self, root: Path) -> None:
        if not os.path.lexists(root) or not root.is_dir():
            raise ValueError("清理目录不存在")
        if self._is_link_or_reparse(root):
            raise ValueError("清理目录不能是链接或重解析点")

    def _validate_source(self, path: Path, *, require_exists: bool = True) -> tuple[int, Path, Path]:
        candidate = Path(os.path.abspath(path))
        root_index, root = self._root_for(candidate)
        self._validate_root(root)
        current = root
        for component in candidate.relative_to(root).parts:
            current = current / component
            if os.path.lexists(current) and self._is_link_or_reparse(current):
                raise ValueError("清理路径不能包含链接或重解析点")
        if require_exists and (not candidate.is_file() or not os.path.lexists(candidate)):
            raise ValueError("清理文件不存在")
        return root_index, root, candidate

    def _path_from_move(self, move: dict, field: str) -> Path:
        root_index = move.get("root")
        value = move.get(field)
        if isinstance(root_index, bool) or not isinstance(root_index, int):
            raise ValueError("清理事务目录无效")
        if root_index < 0 or root_index >= len(self.allowed_roots):
            raise ValueError("清理事务目录无效")
        if not isinstance(value, str) or not value or "\\" in value:
            raise ValueError("清理事务路径无效")
        relative = Path(value)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("清理事务路径无效")
        root = self.allowed_roots[root_index]
        candidate = Path(os.path.abspath(root / relative))
        if not self._is_relative_to(candidate, root):
            raise ValueError("清理事务路径越界")
        return candidate

    def begin(self) -> None:
        if os.path.lexists(self.manifest_root) and self._is_link_or_reparse(self.manifest_root):
            raise ValueError("清理事务目录不能是链接或重解析点")
        self.manifest_root.mkdir(parents=True, exist_ok=True)
        self.operation_root.mkdir(exist_ok=False)
        self._atomic_write(self.manifest_path, self.manifest)

    def stage(self, sources: Iterable[Path]) -> None:
        seen = {
            (int(item.get("root", -1)), str(item.get("source") or ""))
            for item in self.manifest.get("moves") or []
        }
        for source in sources:
            root_index, root, safe_source = self._validate_source(Path(source))
            source_relative = safe_source.relative_to(root).as_posix()
            identity = (root_index, source_relative)
            if identity in seen:
                continue
            staging_root = root / self.STAGING_DIR_NAME / self.operation_id
            if os.path.lexists(root / self.STAGING_DIR_NAME) and self._is_link_or_reparse(root / self.STAGING_DIR_NAME):
                raise ValueError("清理暂存目录不能是链接或重解析点")
            staging_root.mkdir(parents=True, exist_ok=True)
            staged = staging_root / f"{len(self.manifest['moves']):06d}-{safe_source.name}"
            move = {
                "root": root_index,
                "source": source_relative,
                "staged": staged.relative_to(root).as_posix(),
            }
            self.manifest["moves"].append(move)
            self._atomic_write(self.manifest_path, self.manifest)
            os.replace(safe_source, staged)
            seen.add(identity)

    def rollback(self) -> None:
        for move in reversed(self.manifest.get("moves") or []):
            source = self._path_from_move(move, "source")
            staged = self._path_from_move(move, "staged")
            if not os.path.lexists(staged):
                continue
            if os.path.lexists(source):
                raise ValueError("清理回滚发现目标文件冲突")
            source.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staged, source)
        self._remove_transaction_artifacts()

    def commit(self) -> None:
        """Compatibility alias that always uses the Windows Recycle Bin."""
        self.commit_to_recycle_bin()

    def commit_to_recycle_bin(self) -> None:
        """Move every staged file to the Windows Recycle Bin.

        The manifest is marked ``recycling`` before the hand-off. If the shell
        call fails, the exception is propagated and the caller can run
        ``rollback()``; this method never calls ``unlink`` as a fallback.
        """

        staged_paths: list[Path] = []
        for move in self.manifest.get("moves") or []:
            root_index = move.get("root")
            staged = self._path_from_move(move, "staged")
            if isinstance(root_index, bool) or not isinstance(root_index, int):
                raise ValueError("清理事务目录无效")
            if root_index < 0 or root_index >= len(self.allowed_roots):
                raise ValueError("清理事务目录无效")
            staging_root = self.allowed_roots[root_index] / self.STAGING_DIR_NAME / self.operation_id
            if not self._is_relative_to(staged, staging_root):
                raise ValueError("清理暂存路径无效")
            if not os.path.lexists(staged) or not staged.is_file():
                raise OSError(f"清理暂存文件不存在：{staged}")
            if self._is_link_or_reparse(staged):
                raise OSError(f"清理暂存文件不能是链接或重解析点：{staged}")
            staged_paths.append(staged)

        self.manifest["phase"] = "recycling"
        self._atomic_write(self.manifest_path, self.manifest)
        move_paths_to_recycle_bin(staged_paths)
        self.manifest["phase"] = "recycled"
        self._atomic_write(self.manifest_path, self.manifest)
        try:
            self._remove_transaction_artifacts()
        except OSError:
            # Files are already in the Recycle Bin. Leave only metadata for
            # startup recovery; never delete a user file to tidy up.
            pass

    def _remove_transaction_artifacts(self) -> None:
        for root in self.allowed_roots:
            operation = root / self.STAGING_DIR_NAME / self.operation_id
            try:
                operation.rmdir()
            except (FileNotFoundError, OSError):
                pass
            try:
                (root / self.STAGING_DIR_NAME).rmdir()
            except (FileNotFoundError, OSError):
                pass
        if os.path.lexists(self.manifest_path):
            self.manifest_path.unlink()
        try:
            self.operation_root.rmdir()
        except FileNotFoundError:
            pass
        try:
            self.manifest_root.rmdir()
        except (FileNotFoundError, OSError):
            pass

    @classmethod
    def recover_pending(cls, manifest_root: Path, allowed_roots: Iterable[Path]) -> None:
        manifest_root = Path(os.path.abspath(manifest_root))
        if not os.path.lexists(manifest_root):
            return
        probe_roots = tuple(Path(os.path.abspath(item)) for item in allowed_roots)
        allowed = {os.path.normcase(str(item)) for item in probe_roots}
        for operation_root in sorted(item for item in manifest_root.iterdir() if item.is_dir()):
            operation_id = operation_root.name
            if not operation_id.isalnum():
                raise ValueError("存在无法识别的存储清理事务")
            manifest_path = operation_root / "manifest.json"
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValueError("存储清理事务记录损坏") from exc
            roots = manifest.get("roots") if isinstance(manifest, dict) else None
            if (
                not isinstance(roots, list)
                or not roots
                or any(os.path.normcase(os.path.abspath(str(item))) not in allowed for item in roots)
            ):
                raise ValueError("存储清理事务目录已变化，无法自动恢复")
            transaction = cls(manifest_root, [Path(item) for item in roots], operation_id=operation_id)
            if manifest.get("version") != cls.VERSION:
                raise ValueError("存储清理事务版本无效")
            transaction.manifest = manifest
            if manifest.get("phase") == "committed":
                # A manifest from the pre-Recycle-Bin build must not silently
                # permanently delete files during startup recovery. Treat it
                # as a pending hand-off and use the same safe path as new
                # cleanup requests.
                transaction.commit_to_recycle_bin()
            elif manifest.get("phase") in {"preparing", "recycling"}:
                transaction.rollback()
            elif manifest.get("phase") == "recycled":
                transaction._remove_transaction_artifacts()
            else:
                raise ValueError("存储清理事务状态无效")
