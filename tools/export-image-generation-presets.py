"""Export source-backed image-generation modes for a GitHub release.

The exporter intentionally reads only official mode records. It never copies
tasks, drafts, credentials, or arbitrary files from ``data``/``assets``.
Fixed-case media is copied into a tracked static directory and rewritten to a
local static URL so a clean GitHub install does not depend on this machine's
content-addressed media store.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from image_generation_modes import normalize_mode
from image_generation_examples import optimize_image_bytes


OFFICIAL_FIELDS = (
    "id", "display_name", "description", "category", "tags", "synonyms", "sort_order",
    "preset_prompt", "required_reference_count", "reference_images", "max_upload_count",
    "allow_extra_images", "extra_image_limit", "special_hint", "remark", "mode_no",
)
MEDIA_PREFIX = "/assets/image-generation/media/"
STATIC_EXAMPLE_PREFIX = "/static/image-generation-examples/"


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _media_source(root: Path, media: dict) -> tuple[Path, str]:
    url = str(media.get("url") or "")
    parsed = urlsplit(url)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError("固定案例媒体必须是本机受控素材地址")
    if not parsed.path.startswith(MEDIA_PREFIX):
        if parsed.path.startswith(STATIC_EXAMPLE_PREFIX):
            path = root / "static" / "image-generation-examples" / parsed.path[len(STATIC_EXAMPLE_PREFIX):]
            return path, parsed.path
        raise ValueError(f"不支持的固定案例媒体地址: {url}")
    relative = parsed.path[len(MEDIA_PREFIX):].split("/")
    if len(relative) != 2 or not relative[0] or not relative[1]:
        raise ValueError(f"固定案例媒体地址无效: {url}")
    path = root / "assets" / "image-generation" / "media" / relative[0] / relative[1]
    return path, ""


def _atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_name = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", delete=False, dir=path.parent) as handle:
            temporary_name = handle.name
            handle.write(content)
            handle.flush()
            import os
            os.fsync(handle.fileno())
        import os
        os.replace(temporary_name, path)
        temporary_name = None
    finally:
        if temporary_name:
            try:
                import os
                os.unlink(temporary_name)
            except OSError:
                pass


def _export_media(root: Path, example_root: Path, source_id: str, media: dict) -> dict:
    if not isinstance(media, dict):
        raise ValueError("固定案例媒体结构无效")
    source, _existing_static_url = _media_source(root, media)
    if not source.is_file():
        raise ValueError(f"固定案例媒体不存在: {source}")
    try:
        optimized = optimize_image_bytes(source.read_bytes())
    except OSError as exc:
        raise ValueError(f"固定案例媒体不可读: {source}") from exc
    content = optimized["content"]
    digest = hashlib.sha256(content).hexdigest()
    target_dir = example_root / source_id
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{digest}{optimized['extension']}"
    if target.exists():
        try:
            if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                raise ValueError(f"固定案例导出目标哈希冲突: {target}")
        except OSError as exc:
            raise ValueError(f"固定案例导出目标不可读: {target}") from exc
    else:
        _atomic_write(target, content)
    relative = target.relative_to(root / "static").as_posix()
    return {"url": f"/static/{relative}"}


def _export_example(root: Path, example_root: Path, source_id: str, raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise ValueError(f"模式 {source_id} 的固定案例结构无效")
    result = {
        "id": str(raw.get("id") or f"official-example-{source_id}"),
        "mode_id": source_id,
        "title": str(raw.get("title") or ""),
        "caption": str(raw.get("caption") or ""),
        "sample_user_prompt": str(raw.get("sample_user_prompt") or ""),
        "show_user_prompt": bool(raw.get("show_user_prompt", True)),
        "input_media": [],
    }
    for item in raw.get("input_media") or []:
        if not isinstance(item, dict) or not isinstance(item.get("media"), dict):
            raise ValueError(f"模式 {source_id} 的固定案例输入图片无效")
        result["input_media"].append({
            "slot_key": str(item.get("slot_key") or ""),
            "media": _export_media(root, example_root, source_id, item["media"]),
        })
    output = raw.get("output_media")
    if not isinstance(output, dict):
        raise ValueError(f"模式 {source_id} 的固定案例输出图片无效")
    result["output_media"] = _export_media(root, example_root, source_id, output)
    return result


def export_presets(root: Path, output: Path, version: str) -> dict:
    mode_dir = root / "data" / "image_generation_modes"
    example_root = root / "static" / "image-generation-examples"
    modes = []
    for path in sorted(mode_dir.glob("*.json")):
        raw = _read_json(path)
        if not isinstance(raw, dict) or str(raw.get("status") or "active") == "trashed":
            continue
        # All records in the administrator's official mode directory are
        # product modes.  ``builtin`` remains only a legacy compatibility
        # marker and must not hide newer official modes from a release.
        source_id = str(raw.get("id") or raw.get("source_id") or "").strip()
        if not source_id:
            continue
        normalized = normalize_mode(raw)
        mode = {field: deepcopy(normalized.get(field)) for field in OFFICIAL_FIELDS if field in normalized}
        mode.update({
            "id": source_id,
            "description": str(normalized.get("description") or normalized.get("remark") or ""),
            "category": str(normalized.get("category") or ""),
            "tags": list(normalized.get("tags") or []),
            "synonyms": list(normalized.get("synonyms") or []),
            "sort_order": int(normalized.get("sort_order") if normalized.get("sort_order") is not None else normalized.get("mode_no") or 0),
            "example": None,
        })
        # The admin UI historically used remark as the use-case description.
        if isinstance(raw.get("example"), dict):
            mode["example"] = _export_example(root, example_root, source_id, raw["example"])
        modes.append(mode)
    modes.sort(key=lambda item: (int(item.get("mode_no") or 10**9), item["id"]))
    payload = {
        "source_url": "https://raw.githubusercontent.com/MAOMAOCHONGNE/Infinite-Canvas/my-custom/static/data/image-generation-presets.v1.json",
        "source_version": version,
        "distribution_version": version,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "modes": modes,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"version": version, "mode_count": len(modes), "output": str(output), "example_dir": str(example_root)}


def main() -> int:
    parser = argparse.ArgumentParser(description="导出 GitHub 官方图片生成预设")
    parser.add_argument("--version", default="", help="发布版本；默认读取 VERSION")
    parser.add_argument("--output", default="static/data/image-generation-presets.v1.json")
    args = parser.parse_args()
    root = ROOT
    version = str(args.version or (root / "VERSION").read_text(encoding="utf-8").strip()).strip()
    if not version:
        raise SystemExit("VERSION 不能为空")
    print(json.dumps(export_presets(root, root / args.output, version), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
