"""Content-addressed, local-only media for the image-generation workspace."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import stat
import tempfile
from typing import Any, Iterable, Mapping
from urllib.parse import urlsplit
import warnings

from PIL import Image, UnidentifiedImageError


MAX_MEDIA_BYTES = 50 * 1024 * 1024
MAX_IMAGE_PIXELS = 64_000_000
_HASH = re.compile(r"^[0-9a-f]{64}$")
_FORMAT_INFO = {
    "PNG": (".png", "image/png"),
    "JPEG": (".jpg", "image/jpeg"),
    "WEBP": (".webp", "image/webp"),
    "GIF": (".gif", "image/gif"),
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


class ImageGenerationMediaStore:
    """Own the workspace's image files without reading arbitrary local URLs."""

    def __init__(self, root: Path, trash_days: int = 30):
        if isinstance(trash_days, bool) or not isinstance(trash_days, int) or trash_days < 1:
            raise ValueError("trash_days must be a positive integer")
        # Keep the lexical root too: resolving here would silently erase a
        # caller-supplied link before the no-link guard can reject it.
        self.root = Path(os.path.abspath(root))
        self.assets_root = self.root / "assets" / "image-generation"
        self.media_root = self.assets_root / "media"
        self.trash_root = self.assets_root / "trash"
        self.data_root = self.root / "data"
        self.metadata_root = self.data_root / "image_generation_media_metadata"
        self.trash_days = trash_days

    @staticmethod
    def _is_link_or_reparse(path: Path) -> bool:
        """Return true for POSIX links and Windows junction/reparse points."""
        try:
            details = path.lstat()
        except OSError:
            return True
        attributes = int(getattr(details, "st_file_attributes", 0) or 0)
        return stat.S_ISLNK(details.st_mode) or bool(attributes & 0x0400)

    @staticmethod
    def _lexists(path: Path) -> bool:
        return os.path.lexists(path)

    def _safe_under(self, path: Path, root: Path, *, require_exists: bool = False) -> Path:
        """Check lexical + resolved containment without ever accepting a linked component."""
        candidate = Path(os.path.abspath(path))
        base = Path(os.path.abspath(self.root))
        boundary = Path(os.path.abspath(root))
        try:
            boundary.relative_to(base)
            relative = candidate.relative_to(boundary)
        except ValueError as exc:
            raise ValueError("素材路径越界") from exc
        ancestors: list[Path] = []
        ancestor = base
        while True:
            ancestors.append(ancestor)
            if ancestor.parent == ancestor:
                break
            ancestor = ancestor.parent
        for ancestor in reversed(ancestors):
            if self._lexists(ancestor) and self._is_link_or_reparse(ancestor):
                raise ValueError("素材路径不能包含链接或重解析点")
        current = base
        for component in boundary.relative_to(base).parts + relative.parts:
            current = current / component
            if self._lexists(current) and self._is_link_or_reparse(current):
                raise ValueError("素材路径不能包含链接或重解析点")
        if require_exists and not self._lexists(candidate):
            raise ValueError("素材不存在")
        # Once every existing lexical component is known not to be a link, this
        # resolve is only a belt-and-suspenders containment proof.
        if self._lexists(boundary):
            try:
                candidate.resolve(strict=self._lexists(candidate)).relative_to(
                    boundary.resolve(strict=True)
                )
            except (OSError, ValueError) as exc:
                raise ValueError("素材路径越界") from exc
        return candidate

    def _safe_directory(self, directory: Path, root: Path, *, create: bool = False) -> Path:
        directory = self._safe_under(directory, root)
        if create:
            directory.mkdir(parents=True, exist_ok=True)
        directory = self._safe_under(directory, root, require_exists=True)
        if not directory.is_dir():
            raise ValueError("素材目录无效")
        return directory

    def _safe_file(self, path: Path, root: Path) -> Path:
        path = self._safe_under(path, root, require_exists=True)
        if not path.is_file():
            raise ValueError("素材文件无效")
        return path

    def _safe_children(self, directory: Path, root: Path) -> list[Path]:
        try:
            safe_directory = self._safe_directory(directory, root)
            with os.scandir(safe_directory) as entries:
                children = [Path(entry.path) for entry in entries]
        except (OSError, ValueError):
            return []
        return [
            child for child in children
            if not self._lexists(child) or not self._is_link_or_reparse(child)
        ]

    @staticmethod
    def _is_media_id(value: Any) -> bool:
        return isinstance(value, str) and bool(_HASH.fullmatch(value))

    @staticmethod
    def _image_details(content: bytes) -> tuple[str, str, int, int]:
        """Decode enough of an image to establish its real accepted format safely."""
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(BytesIO(content)) as image:
                    actual_format = str(image.format or "").upper()
                    image.verify()
                with Image.open(BytesIO(content)) as image:
                    width, height = image.size
        except (OSError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
            raise ValueError("媒体不是可安全读取的图片") from exc
        if actual_format not in _FORMAT_INFO or width < 1 or height < 1 or width * height > MAX_IMAGE_PIXELS:
            raise ValueError("不支持的图片格式或尺寸")
        extension, media_type = _FORMAT_INFO[actual_format]
        return extension, media_type, int(width), int(height)

    def _media_path(self, media_id: str, extension: str) -> Path:
        if not self._is_media_id(media_id) or extension not in {item[0] for item in _FORMAT_INFO.values()}:
            raise ValueError("invalid media identifier")
        return self.media_root / media_id[:2] / f"{media_id}{extension}"

    def _metadata_path(self, media_id: str) -> Path:
        if not self._is_media_id(media_id):
            raise ValueError("invalid media identifier")
        return self.metadata_root / media_id[:2] / f"{media_id}.json"

    @staticmethod
    def _atomic_write(target: Path, content: bytes) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(mode="wb", delete=False, dir=target.parent) as handle:
                temporary_name = handle.name
                handle.write(content)
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

    def _record_for_path(self, media_id: str, path: Path, *, include_path: bool) -> dict[str, Any]:
        try:
            path = self._safe_file(path, self.media_root)
            content = path.read_bytes()
        except (OSError, ValueError) as exc:
            raise ValueError("媒体文件不可读") from exc
        if hashlib.sha256(content).hexdigest() != media_id:
            raise ValueError("媒体内容哈希不匹配")
        extension, media_type, width, height = self._image_details(content)
        if path.suffix.lower() != extension:
            raise ValueError("媒体扩展名与实际格式不匹配")
        record = {
            "id": media_id,
            "sha256": media_id,
            "url": f"/assets/image-generation/media/{media_id[:2]}/{media_id}{extension}",
            "media_type": media_type,
            "size": len(content),
            "width": width,
            "height": height,
        }
        if include_path:
            record["path"] = str(path)
        return record

    def _read_media_metadata(self, media_id: str) -> dict[str, Any] | None:
        try:
            path = self._safe_file(self._metadata_path(media_id), self.metadata_root)
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
            return None
        if not isinstance(value, dict) or value.get("media_id") != media_id:
            return None
        return value

    def _touch_media_metadata(self, media_id: str, media_path: Path) -> None:
        now = _utc_now()
        existing = self._read_media_metadata(media_id) or {}
        created_at = _parse_timestamp(existing.get("created_at"))
        if created_at is None:
            try:
                created_at = datetime.fromtimestamp(
                    self._safe_file(media_path, self.media_root).stat().st_mtime,
                    timezone.utc,
                )
            except (OSError, ValueError):
                created_at = now
        payload = {
            "media_id": media_id,
            "created_at": created_at.isoformat(),
            "last_adopted_at": now.isoformat(),
        }
        target = self._metadata_path(media_id)
        self._safe_directory(target.parent, self.metadata_root, create=True)
        self._atomic_write(
            self._safe_under(target, self.metadata_root),
            json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8"),
        )

    def media_activity_time(self, media_id: str) -> datetime | None:
        """Return the newest durable adoption time, with legacy mtime fallback."""
        record = self.media_record(media_id)
        if record is None:
            return None
        metadata = self._read_media_metadata(media_id) or {}
        activity = _parse_timestamp(metadata.get("last_adopted_at"))
        if activity is None:
            activity = _parse_timestamp(metadata.get("created_at"))
        if activity is not None:
            return activity
        try:
            filename = Path(urlsplit(record["url"]).path).name
            path = self._safe_file(self.media_root / media_id[:2] / filename, self.media_root)
            return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
        except (OSError, ValueError):
            return None

    def list_media_ids(self) -> list[str]:
        """List valid live CAS media without following linked directories."""
        result: list[str] = []
        try:
            self._safe_directory(self.media_root, self.media_root)
        except ValueError:
            return result
        for shard in self._safe_children(self.media_root, self.media_root):
            if not shard.is_dir():
                continue
            try:
                shard = self._safe_directory(shard, self.media_root)
            except ValueError:
                continue
            for path in self._safe_children(shard, self.media_root):
                media_id = path.stem
                if media_id in result or not self._is_media_id(media_id):
                    continue
                if self.media_record(media_id) is not None:
                    result.append(media_id)
        return result

    def cleanup_paths(self, media_ids: Iterable[str]) -> list[Path]:
        """Resolve live media and optional metadata files for transactional deletion."""
        paths: list[Path] = []
        for media_id in sorted({item for item in media_ids if self._is_media_id(item)}):
            record = self.media_record(media_id)
            if record is None:
                continue
            filename = Path(urlsplit(record["url"]).path).name
            paths.append(self._safe_file(self.media_root / media_id[:2] / filename, self.media_root))
            metadata_path = self._metadata_path(media_id)
            if self._lexists(metadata_path):
                paths.append(self._safe_file(metadata_path, self.metadata_root))
        return paths

    def adopt_bytes(self, content: bytes, filename_or_extension: str = "", content_type: str = "") -> dict[str, Any]:
        if not isinstance(content, bytes) or not content:
            raise ValueError("图片文件为空")
        if len(content) > MAX_MEDIA_BYTES:
            raise ValueError("单个图片不能超过 50 MB")
        extension, _media_type, _width, _height = self._image_details(content)
        media_id = hashlib.sha256(content).hexdigest()
        target = self._media_path(media_id, extension)
        try:
            self._safe_directory(target.parent, self.media_root, create=True)
        except ValueError:
            raise ValueError("素材目录不安全")
        if not self._lexists(target):
            self._atomic_write(target, content)
        self._touch_media_metadata(media_id, target)
        return self._record_for_path(media_id, target, include_path=True)

    def media_record(self, media_id: str) -> dict[str, Any] | None:
        if not self._is_media_id(media_id):
            return None
        directory = self.media_root / media_id[:2]
        try:
            directory = self._safe_directory(directory, self.media_root)
        except ValueError:
            return None
        paths = [
            path for path in self._safe_children(directory, self.media_root)
            if path.name.startswith(f"{media_id}.")
            and path.suffix.lower() in {item[0] for item in _FORMAT_INFO.values()}
        ]
        if len(paths) != 1:
            return None
        try:
            return self._record_for_path(media_id, paths[0], include_path=False)
        except ValueError:
            return None

    def read_bytes(self, media_id: str) -> tuple[bytes, str, str]:
        """Read one canonical media object after path, hash and image validation."""
        record = self.media_record(media_id)
        if record is None:
            raise ValueError("素材不存在、损坏或不安全")
        parsed = urlsplit(record["url"])
        filename = Path(parsed.path).name
        path = self._safe_file(self.media_root / media_id[:2] / filename, self.media_root)
        content = path.read_bytes()
        # Revalidate after the second open so a replacement cannot bypass the
        # record check between lookup and archive assembly.
        if hashlib.sha256(content).hexdigest() != media_id:
            raise ValueError("素材内容哈希不匹配")
        extension, media_type, _width, _height = self._image_details(content)
        if path.suffix.lower() != extension:
            raise ValueError("素材扩展名与实际格式不匹配")
        return content, extension, media_type

    def adopt_local_url(self, url: str) -> dict[str, Any]:
        """Re-adopt only this application's own canonical media URL; never fetch URLs."""
        if not isinstance(url, str):
            raise ValueError("媒体地址无效")
        parsed = urlsplit(url)
        if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
            raise ValueError("只能采用本机受控素材地址")
        expected_prefix = "/assets/image-generation/media/"
        if not parsed.path.startswith(expected_prefix):
            raise ValueError("只能采用本机受控素材地址")
        pieces = parsed.path[len(expected_prefix):].split("/")
        if len(pieces) != 2 or pieces[0] == "" or not _HASH.fullmatch(Path(pieces[1]).stem):
            raise ValueError("素材地址格式无效")
        media_id = Path(pieces[1]).stem
        if pieces[0] != media_id[:2] or Path(pieces[1]).suffix.lower() not in {item[0] for item in _FORMAT_INFO.values()}:
            raise ValueError("素材地址格式无效")
        try:
            path = self._safe_file(self.media_root / pieces[0] / pieces[1], self.media_root)
            content = path.read_bytes()
        except (OSError, ValueError) as exc:
            raise ValueError("素材不存在或不安全") from exc
        if hashlib.sha256(content).hexdigest() != media_id:
            raise ValueError("素材地址哈希与内容不匹配")
        extension, _media_type, _width, _height = self._image_details(content)
        if path.suffix.lower() != extension:
            raise ValueError("素材地址扩展名与内容不匹配")
        return self._record_for_path(media_id, path, include_path=True)

    def _validated_media_id(self, media_id: Any, url: Any = None) -> str | None:
        if not self._is_media_id(media_id):
            return None
        record = self.media_record(media_id)
        if record is None:
            return None
        if url is not None and url != record["url"]:
            return None
        return media_id

    def _claimed_local_media_id(self, media_id: Any, url: Any) -> str | None:
        """Validate a canonical media claim without requiring the live file.

        Cleanup transactions temporarily stage the media file before their
        second reference scan.  During that window ``media_record`` cannot
        validate an otherwise durable reference, so candidate IDs are checked
        against their canonical URL shape instead.
        """
        if not self._is_media_id(media_id) or not isinstance(url, str):
            return None
        parsed = urlsplit(url)
        if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
            return None
        prefix = "/assets/image-generation/media/"
        if not parsed.path.startswith(prefix):
            return None
        pieces = parsed.path[len(prefix):].split("/")
        filename = Path(pieces[1]) if len(pieces) == 2 else Path()
        if (
            len(pieces) != 2
            or pieces[0] != media_id[:2]
            or filename.stem != media_id
            or filename.suffix.lower() not in {item[0] for item in _FORMAT_INFO.values()}
        ):
            return None
        return media_id

    def _collect_media_ids(
        self,
        value: Any,
        result: set[str],
        *,
        context: str = "",
        include_missing_media_ids: set[str] | None = None,
    ) -> None:
        """Recursively scan records without promoting arbitrary metadata hashes."""
        if isinstance(value, Mapping):
            media_id = value.get("id")
            url = value.get("url")
            canonical = self._validated_media_id(media_id, url)
            if (
                canonical is None
                and include_missing_media_ids
                and media_id in include_missing_media_ids
            ):
                canonical = self._claimed_local_media_id(media_id, url)
            if canonical is not None:
                result.add(canonical)
            direct_id = value.get("media_id")
            if context in {"inputs", "input_media", "media", "image", "output_media", "candidates"}:
                canonical = self._validated_media_id(direct_id)
                if (
                    canonical is None
                    and include_missing_media_ids
                    and direct_id in include_missing_media_ids
                    and self._is_media_id(direct_id)
                ):
                    canonical = direct_id
                if canonical is not None:
                    result.add(canonical)
            for key, child in value.items():
                child_context = str(key)
                self._collect_media_ids(
                    child,
                    result,
                    context=child_context,
                    include_missing_media_ids=include_missing_media_ids,
                )
        elif isinstance(value, list):
            for child in value:
                self._collect_media_ids(
                    child,
                    result,
                    context=context,
                    include_missing_media_ids=include_missing_media_ids,
                )

    def referenced_media_ids(
        self,
        *,
        records: Iterable[Mapping[str, Any]] | None = None,
        include_missing_media_ids: Iterable[str] | None = None,
    ) -> set[str]:
        """Find durable media references in supplied records and persisted modes/drafts/tasks."""
        result: set[str] = set()
        missing = {
            item for item in (include_missing_media_ids or ()) if self._is_media_id(item)
        }
        for record in records or ():
            self._collect_media_ids(record, result, include_missing_media_ids=missing)
        if self._lexists(self.data_root):
            try:
                # Validate the reference-root ancestor chain before asking
                # whether any individual child directory exists. Otherwise an
                # empty linked data root would be mistaken for a fresh store.
                self._safe_directory(self.data_root, self.data_root)
            except ValueError as exc:
                raise ValueError("图片生成引用根目录不安全") from exc
        for folder in (
            self.data_root / "image_generation_modes",
            self.data_root / "image_generation_drafts",
            self.data_root / "image_generation_tasks",
        ):
            if not self._lexists(folder):
                # A normal fresh workspace has no records yet.
                continue
            try:
                folder = self._safe_directory(folder, self.data_root)
            except ValueError as exc:
                # A present but unsafe/unreadable reference root means the
                # reference set is incomplete. Callers must fail closed.
                raise ValueError("图片生成引用目录不安全") from exc
            for path in self._safe_children(folder, self.data_root):
                if path.suffix.lower() != ".json":
                    continue
                try:
                    self._collect_media_ids(
                        json.loads(self._safe_file(path, self.data_root).read_text(encoding="utf-8")),
                        result,
                        include_missing_media_ids=missing,
                    )
                except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
                    raise ValueError("图片生成引用记录损坏或不安全") from exc
        return result

    def move_unreferenced_to_trash(
        self,
        protected_media_ids: Iterable[str] | None = None,
        only_media_ids: Iterable[str] | None = None,
    ) -> list[str]:
        """Move unreferenced media to quarantine, optionally within an allowlist.

        ``only_media_ids`` is used by task cleanup so an orphaned user upload
        can never be swept merely because a generation task was removed.
        """
        try:
            protected = self.referenced_media_ids()
        except ValueError:
            return []
        protected.update(item for item in (protected_media_ids or ()) if self._is_media_id(item))
        allowed = {
            item for item in (only_media_ids or ()) if self._is_media_id(item)
        } if only_media_ids is not None else None
        moved: list[str] = []
        try:
            self._safe_directory(self.media_root, self.media_root)
        except ValueError:
            return moved
        deleted_at = _utc_now()
        trash_dir = self.trash_root / deleted_at.date().isoformat()
        for shard in self._safe_children(self.media_root, self.media_root):
            if not shard.is_dir():
                continue
            try:
                shard = self._safe_directory(shard, self.media_root)
            except ValueError:
                continue
            for path in self._safe_children(shard, self.media_root):
                media_id = path.stem
                try:
                    path = self._safe_file(path, self.media_root)
                except ValueError:
                    continue
                if not self._is_media_id(media_id) or media_id in protected:
                    continue
                if allowed is not None and media_id not in allowed:
                    continue
                if path.suffix.lower() not in {item[0] for item in _FORMAT_INFO.values()}:
                    continue
                destination = trash_dir / path.name
                sidecar = destination.with_suffix(".json")
                moved_file = False
                try:
                    self._safe_directory(destination.parent, self.trash_root, create=True)
                    destination = self._safe_under(destination, self.trash_root)
                    sidecar = self._safe_under(sidecar, self.trash_root)
                    os.replace(path, destination)
                    moved_file = True
                    self._atomic_write(sidecar, json.dumps({
                        "media_id": media_id,
                        "deleted_at": deleted_at.isoformat(),
                        "filename": destination.name,
                    }, ensure_ascii=False).encode("utf-8"))
                    self._safe_file(sidecar, self.trash_root)
                except (OSError, ValueError):
                    if moved_file:
                        try:
                            self._safe_file(destination, self.trash_root)
                            self._safe_directory(path.parent, self.media_root, create=True)
                            os.replace(destination, path)
                        except (OSError, ValueError):
                            # A failed rollback is deliberately not reported as a
                            # completed move; it needs local operator recovery.
                            pass
                    continue
                moved.append(media_id)
        return moved

    def purge_expired_trash(self, *, now: datetime | None = None) -> list[str]:
        current = now or _utc_now()
        if current.tzinfo is None:
            current = current.replace(tzinfo=timezone.utc)
        purged: list[str] = []
        try:
            self._safe_directory(self.trash_root, self.trash_root)
        except ValueError:
            return purged
        for date_dir in self._safe_children(self.trash_root, self.trash_root):
            if not date_dir.is_dir():
                continue
            try:
                date_dir = self._safe_directory(date_dir, self.trash_root)
            except ValueError:
                continue
            for sidecar in self._safe_children(date_dir, self.trash_root):
                if sidecar.suffix.lower() != ".json":
                    continue
                try:
                    sidecar = self._safe_file(sidecar, self.trash_root)
                    metadata = json.loads(sidecar.read_text(encoding="utf-8"))
                    media_id = metadata.get("media_id")
                    deleted_at = _parse_timestamp(metadata.get("deleted_at"))
                    filename = metadata.get("filename")
                    if not self._is_media_id(media_id) or deleted_at is None or not isinstance(filename, str):
                        continue
                    candidate_name = Path(filename)
                    if (
                        candidate_name.name != filename
                        or candidate_name.stem != media_id
                        or candidate_name.suffix.lower() not in {item[0] for item in _FORMAT_INFO.values()}
                    ):
                        continue
                    if not current > deleted_at + timedelta(days=self.trash_days):
                        continue
                    media_path = self._safe_under(sidecar.parent / filename, self.trash_root)
                    if self._lexists(media_path):
                        media_path = self._safe_file(media_path, self.trash_root)
                        media_path.unlink()
                    sidecar.unlink()
                except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
                    continue
                purged.append(media_id)
        return purged

    def prune_empty_shard_directories(self) -> list[Path]:
        """Remove only empty hash-shard directories left after media moves."""
        removed: list[Path] = []
        for root in (self.media_root, self.metadata_root):
            try:
                root = self._safe_directory(root, root)
            except ValueError:
                continue
            children = sorted(
                (item for item in self._safe_children(root, root) if item.is_dir()),
                key=lambda item: len(item.parts),
                reverse=True,
            )
            for child in children:
                try:
                    child = self._safe_directory(child, root)
                    if any(self._safe_children(child, root)):
                        continue
                    child.rmdir()
                    removed.append(child)
                except (OSError, ValueError):
                    continue
        return removed
