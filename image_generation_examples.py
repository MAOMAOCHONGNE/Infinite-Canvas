"""Safe, content-addressed fixed-example media handling.

Fixed examples are release assets, not the user's original generation media.
This module keeps the original CAS object untouched and materialises an
optimised copy below ``static/image-generation-examples``.  The same code is
used by the administrator's "set as example" action and by the resumable
startup migration.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from io import BytesIO
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
import warnings
from typing import Any, Mapping
from urllib.parse import urlsplit

from PIL import Image, ImageOps, UnidentifiedImageError

from image_generation_media import ImageGenerationMediaStore


EXAMPLE_MAX_PIXELS = 1_048_576
EXAMPLE_STATIC_PREFIX = "/static/image-generation-examples/"
_HASH = re.compile(r"^[0-9a-f]{64}$")
_FORMAT_INFO = {
    "PNG": (".png", "image/png"),
    "JPEG": (".jpg", "image/jpeg"),
    "WEBP": (".webp", "image/webp"),
    "GIF": (".gif", "image/gif"),
}
_IMAGE_EXTENSIONS = {value[0] for value in _FORMAT_INFO.values()}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_link_or_reparse(path: Path) -> bool:
    try:
        details = path.lstat()
    except OSError:
        return True
    attributes = int(getattr(details, "st_file_attributes", 0) or 0)
    return stat.S_ISLNK(details.st_mode) or bool(attributes & 0x0400)


def _safe_under(path: Path, root: Path, *, require_exists: bool = False) -> Path:
    root = Path(os.path.abspath(root))
    candidate = Path(os.path.abspath(path))
    try:
        relative = candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("案例媒体路径越界") from exc
    current = root
    for part in relative.parts:
        current = current / part
        if os.path.lexists(current) and _is_link_or_reparse(current):
            raise ValueError("案例媒体路径不能包含链接或重解析点")
    if require_exists and not os.path.lexists(candidate):
        raise ValueError("案例媒体不存在")
    if os.path.lexists(root):
        try:
            candidate.resolve(strict=os.path.lexists(candidate)).relative_to(root.resolve(strict=True))
        except (OSError, ValueError) as exc:
            raise ValueError("案例媒体路径越界") from exc
    return candidate


def _atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", delete=False, dir=path.parent) as handle:
            temporary_name = handle.name
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
        temporary_name = None
    finally:
        if temporary_name:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass


def _image_details(content: bytes) -> tuple[str, str, int, int]:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(content)) as image:
                actual_format = str(image.format or "").upper()
                image.verify()
            with Image.open(BytesIO(content)) as image:
                # Measure the displayed dimensions, not the raw sensor
                # dimensions.  JPEGs from phones commonly carry an EXIF
                # orientation tag that swaps width and height at display
                # time; resizing from the raw size would flip the case
                # direction after the optimized copy is written.
                oriented = ImageOps.exif_transpose(image)
                width, height = oriented.size
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("示范媒体不是可安全读取的图片") from exc
    if actual_format not in _FORMAT_INFO or width < 1 or height < 1:
        raise ValueError("示范媒体格式或尺寸不受支持")
    extension, media_type = _FORMAT_INFO[actual_format]
    return actual_format, extension, int(width), int(height)


def optimize_image_bytes(content: bytes, *, max_pixels: int = EXAMPLE_MAX_PIXELS) -> dict[str, Any]:
    """Return image bytes with an area cap, preserving format and proportions."""
    if not isinstance(content, bytes) or not content:
        raise ValueError("示范媒体为空")
    actual_format, extension, width, height = _image_details(content)
    area = width * height
    if area <= max_pixels:
        return {
            "content": content,
            "format": actual_format,
            "extension": extension,
            "media_type": _FORMAT_INFO[actual_format][1],
            "width": width,
            "height": height,
            "original_width": width,
            "original_height": height,
            "resized": False,
        }
    if actual_format == "GIF":
        # Resizing an animated GIF would silently discard frames or timing.
        with Image.open(BytesIO(content)) as image:
            if getattr(image, "is_animated", False):
                raise ValueError("暂不缩放动画 GIF 示范图")

    scale = math.sqrt(float(max_pixels) / float(area))
    target_width = max(1, int(math.floor(width * scale)))
    target_height = max(1, int(math.floor(height * scale)))
    while target_width * target_height > max_pixels:
        if target_width >= target_height:
            target_width -= 1
        else:
            target_height -= 1

    try:
        with Image.open(BytesIO(content)) as source:
            oriented = ImageOps.exif_transpose(source)
            resized = oriented.resize(
                (target_width, target_height),
                Image.Resampling.LANCZOS,
            )
            buffer = BytesIO()
            if actual_format == "PNG":
                resized.save(buffer, format="PNG", optimize=True, compress_level=9)
            elif actual_format == "JPEG":
                if resized.mode not in {"RGB", "L"}:
                    resized = resized.convert("RGB")
                resized.save(buffer, format="JPEG", quality=95, optimize=True, progressive=True)
            elif actual_format == "WEBP":
                resized.save(buffer, format="WEBP", lossless=True, quality=100, method=6)
            else:  # non-animated GIF
                resized.save(buffer, format="GIF", optimize=True)
            optimized = buffer.getvalue()
    except (OSError, ValueError) as exc:
        raise ValueError("示范图缩放失败") from exc

    # Validate the encoded result before it can become a new case reference.
    _format, _extension, checked_width, checked_height = _image_details(optimized)
    if checked_width * checked_height > max_pixels:
        raise ValueError("示范图缩放后仍超过像素上限")
    return {
        "content": optimized,
        "format": _format,
        "extension": _extension,
        "media_type": _FORMAT_INFO[_format][1],
        "width": checked_width,
        "height": checked_height,
        "original_width": width,
        "original_height": height,
        "resized": True,
    }


class ImageGenerationExampleOptimizer:
    """Materialise and migrate official fixed examples safely."""

    def __init__(
        self,
        root: Path,
        mode_store: Any,
        media_store: ImageGenerationMediaStore,
        state_path: Path | None = None,
    ):
        self.root = Path(os.path.abspath(root))
        self.static_root = self.root / "static" / "image-generation-examples"
        self.mode_store = mode_store
        self.media_store = media_store
        self.state_path = state_path or (self.root / "data" / "image_generation_example_resize.json")
        self._lock = threading.RLock()

    def _static_path_from_url(self, url: str) -> Path:
        if not isinstance(url, str):
            raise ValueError("案例媒体地址无效")
        parsed = urlsplit(url)
        if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
            raise ValueError("案例媒体地址必须是本机静态地址")
        if not parsed.path.startswith(EXAMPLE_STATIC_PREFIX):
            raise ValueError("案例媒体地址不是官方案例地址")
        relative = parsed.path[len(EXAMPLE_STATIC_PREFIX):]
        if not relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
            raise ValueError("案例媒体地址无效")
        path = _safe_under(self.static_root / relative, self.static_root, require_exists=True)
        if path.suffix.lower() not in _IMAGE_EXTENSIONS or not path.is_file():
            raise ValueError("案例媒体文件无效")
        return path

    def _source_bytes(self, media: Mapping[str, Any]) -> tuple[bytes, Path | None]:
        url = media.get("url")
        if isinstance(url, str) and url.startswith(EXAMPLE_STATIC_PREFIX):
            path = self._static_path_from_url(url)
            try:
                return path.read_bytes(), path
            except OSError as exc:
                raise ValueError("案例媒体不可读") from exc
        media_id = media.get("id") or media.get("media_id")
        if isinstance(media_id, str) and _HASH.fullmatch(media_id):
            try:
                content, _extension, _media_type = self.media_store.read_bytes(media_id)
            except ValueError as exc:
                raise ValueError("案例素材不存在或不可读") from exc
            return content, None
        raise ValueError("案例媒体必须是受控 CAS 或静态地址")

    def _iter_static_images(self):
        if not self.static_root.exists():
            return
        try:
            root = _safe_under(self.static_root, self.static_root)
        except ValueError:
            return
        stack = [root]
        while stack:
            current = stack.pop()
            try:
                entries = list(os.scandir(current))
            except OSError:
                continue
            for entry in entries:
                path = Path(entry.path)
                if _is_link_or_reparse(path):
                    continue
                if entry.is_dir(follow_symlinks=False):
                    stack.append(path)
                elif entry.is_file(follow_symlinks=False) and path.suffix.lower() in _IMAGE_EXTENSIONS:
                    yield path

    def _find_existing(self, media_id: str, extension: str) -> Path | None:
        filename = f"{media_id}{extension}"
        for path in self._iter_static_images() or ():
            if path.name != filename:
                continue
            try:
                if hashlib.sha256(path.read_bytes()).hexdigest() == media_id:
                    return path
            except OSError:
                continue
        return None

    @staticmethod
    def _safe_mode_directory_name(mode_id: str) -> str:
        text = re.sub(r"[^A-Za-z0-9._-]+", "-", str(mode_id or "")).strip("-")
        if text and len(text) <= 100:
            return text
        return "mode-" + hashlib.sha256(str(mode_id).encode("utf-8")).hexdigest()[:16]

    def materialize_media(self, mode_id: str, media: Mapping[str, Any]) -> tuple[dict[str, Any], list[Path]]:
        if not isinstance(media, Mapping):
            raise ValueError("案例媒体结构无效")
        content, original_static_path = self._source_bytes(media)
        optimized = optimize_image_bytes(content)
        content_hash = hashlib.sha256(optimized["content"]).hexdigest()
        existing = self._find_existing(content_hash, optimized["extension"])
        created: list[Path] = []
        if existing is None:
            preferred = original_static_path.parent if original_static_path is not None else (
                self.static_root / self._safe_mode_directory_name(mode_id)
            )
            target_dir = _safe_under(preferred, self.static_root)
            target_dir.mkdir(parents=True, exist_ok=True)
            target = _safe_under(
                target_dir / f"{content_hash}{optimized['extension']}", self.static_root
            )
            if target.exists():
                try:
                    if hashlib.sha256(target.read_bytes()).hexdigest() != content_hash:
                        raise ValueError("案例目标文件哈希冲突")
                except OSError as exc:
                    raise ValueError("案例目标文件不可读") from exc
            else:
                _atomic_write(target, optimized["content"])
                created.append(target)
            existing = target
        relative = existing.relative_to(self.static_root).as_posix()
        return ({
            "id": content_hash,
            "sha256": content_hash,
            "url": EXAMPLE_STATIC_PREFIX + relative,
            "media_type": optimized["media_type"],
            "size": len(optimized["content"]),
            "width": optimized["width"],
            "height": optimized["height"],
        }, created)

    def _example_media_items(self, example: Mapping[str, Any]):
        for item in example.get("input_media") or []:
            if isinstance(item, Mapping):
                media = item.get("media") if isinstance(item.get("media"), Mapping) else item
                yield item, media
        output = example.get("output_media")
        if isinstance(output, Mapping):
            media = output.get("media") if isinstance(output.get("media"), Mapping) else output
            yield example, media

    def optimise_example(self, mode_id: str, example: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[Path]]:
        if not isinstance(example, Mapping):
            raise ValueError("固定案例结构无效")
        updated = deepcopy(dict(example))
        created: list[Path] = []
        changed = False
        resized = 0
        input_items = updated.get("input_media") or []
        if not isinstance(input_items, list):
            raise ValueError("固定案例输入结构无效")
        for index, item in enumerate(input_items):
            if not isinstance(item, Mapping):
                raise ValueError("固定案例输入结构无效")
            media = item.get("media") if isinstance(item.get("media"), Mapping) else item
            source_content, _ = self._source_bytes(media)
            source_details = _image_details(source_content)
            record, new_paths = self.materialize_media(mode_id, media)
            created.extend(new_paths)
            if isinstance(media, Mapping) and str(media.get("url") or "") != record["url"]:
                changed = True
            if new_paths or str(media.get("url") or "").startswith("/assets/"):
                changed = True
            if isinstance(item.get("media"), Mapping):
                updated["input_media"][index]["media"] = record
            else:
                updated["input_media"][index] = record
            if source_details[2] * source_details[3] > EXAMPLE_MAX_PIXELS:
                resized += 1
        output = updated.get("output_media")
        if not isinstance(output, Mapping):
            raise ValueError("固定案例输出结构无效")
        output_media = output.get("media") if isinstance(output.get("media"), Mapping) else output
        source_content, _ = self._source_bytes(output_media)
        source_details = _image_details(source_content)
        record, new_paths = self.materialize_media(mode_id, output_media)
        created.extend(new_paths)
        if str(output_media.get("url") or "") != record["url"] or new_paths:
            changed = True
        if isinstance(output.get("media"), Mapping):
            updated["output_media"]["media"] = record
        else:
            updated["output_media"] = record
        if source_details[2] * source_details[3] > EXAMPLE_MAX_PIXELS:
            resized += 1
        return updated, {"changed": changed, "resized": resized}, created

    def _write_state(self, state: Mapping[str, Any]) -> None:
        payload = json.dumps(dict(state), ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")
        _atomic_write(self.state_path, payload)

    def status(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return {"status": "idle", "total": 0, "processed": 0, "resized": 0, "failed": []}
        return raw if isinstance(raw, dict) else {"status": "idle", "total": 0, "processed": 0, "resized": 0, "failed": []}

    def migrate_all(self) -> dict[str, Any]:
        with self._lock:
            modes = self.mode_store.list_modes(include_admin=True)
            candidates = [
                mode for mode in modes
                if isinstance(mode, Mapping) and isinstance(mode.get("example"), Mapping)
            ]
            state: dict[str, Any] = {
                "version": 1,
                "status": "running",
                "total": len(candidates),
                "processed": 0,
                "resized": 0,
                "failed": [],
                "updated_at": _utc_now(),
            }
            self._write_state(state)
            for mode in candidates:
                mode_id = str(mode.get("id") or "")
                created: list[Path] = []
                try:
                    current = self.mode_store.get_mode(mode_id, include_admin=True)
                    if not isinstance(current, Mapping) or not isinstance(current.get("example"), Mapping):
                        state["processed"] += 1
                        continue
                    updated, result, created = self.optimise_example(mode_id, current["example"])
                    if result["changed"]:
                        latest = self.mode_store.get_mode(mode_id, include_admin=True)
                        if not isinstance(latest, Mapping) or not isinstance(latest.get("example"), Mapping):
                            raise ValueError("案例在迁移期间已被修改")
                        if str(latest["example"].get("id") or "") != str(current["example"].get("id") or ""):
                            raise ValueError("案例在迁移期间已被替换")
                        self.mode_store.save_example(mode_id, updated)
                    state["resized"] += int(result["resized"])
                except Exception as exc:
                    for path in created:
                        try:
                            if path.is_file():
                                path.unlink()
                        except OSError:
                            pass
                    state["failed"].append({"mode_id": mode_id, "error": str(exc)})
                state["processed"] += 1
                state["updated_at"] = _utc_now()
                self._write_state(state)
            state["status"] = "succeeded" if not state["failed"] else "failed"
            state["updated_at"] = _utc_now()
            self._write_state(state)
            return deepcopy(state)


__all__ = ["EXAMPLE_MAX_PIXELS", "ImageGenerationExampleOptimizer", "optimize_image_bytes"]
