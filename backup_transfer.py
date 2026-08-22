"""Pure helpers for portable Infinite Canvas backups.

This module deliberately has no dependency on ``main.py`` so archive validation,
credential stripping, duplicate handling, and canvas migration can be tested in
isolation. Filesystem and FastAPI integration remain in ``main.py``.
"""

from __future__ import annotations

import copy
import hashlib
import json
import posixpath
import re
import urllib.parse
import uuid
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Sequence, Tuple


BACKUP_FORMAT = "infinite-canvas-backup"
BACKUP_VERSION = 2
BACKUP_LEGACY_VERSION = 1
BACKUP_SUPPORTED_VERSIONS = {BACKUP_LEGACY_VERSION, BACKUP_VERSION}
MAX_ARCHIVE_MEMBERS = 20_000
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 16 * 1024 * 1024 * 1024

_SENSITIVE_EXACT = {
    "api_key",
    "apikey",
    "wallet_api_key",
    "access_key",
    "access_key_id",
    "secret_access_key",
    "access_token",
    "refresh_token",
    "token",
    "authorization",
    "rh_comfy_auth",
    "rh_identify",
    "secret",
    "password",
    "key_preview",
    "key_env",
    "has_key",
    "has_wallet_key",
    "wallet_key_preview",
    "wallet_key_env",
    "has_volcengine_access_key",
    "has_volcengine_secret_key",
    "volcengine_access_key_preview",
    "volcengine_secret_key_preview",
    "volcengine_access_key_env",
    "volcengine_secret_key_env",
}
_SENSITIVE_QUERY_RE = re.compile(
    r"([?&])(?:Rh-Comfy-Auth|Rh-Identify|apiKey|api_key|access_token|refresh_token|token|authorization|secret|password)=[^&#\s\"']*",
    re.I,
)
_DRIVE_PATH_RE = re.compile(r"^[A-Za-z]:[/\\]")
_RUNTIME_KEYS = {
    "llmTask",
    "backgroundTask",
    "pendingTask",
    "activeTaskId",
    "taskRuntimeId",
    "task_runtime_id",
    "runStartedAt",
    "runFinishedAt",
    "runElapsedMs",
    "runError",
    "runStatus",
    "runProgress",
    "runTimerStartedAt",
    "raw",
    "provider_snapshot",
    "upstream_task_id",
    "query_attempts",
    "last_query_at",
    "query_error",
    "netWssUrl",
    "net_wss_url",
    "b64_json",
    "base64",
    "image_base64",
    "data_url",
}


def _normalized_key(key: Any) -> str:
    return re.sub(r"[-\s]+", "_", str(key or "").strip().lower())


def is_sensitive_config_key(key: Any) -> bool:
    normalized = _normalized_key(key)
    if normalized in _SENSITIVE_EXACT:
        return True
    if normalized.startswith("clear_") and (normalized.endswith("key") or normalized.endswith("token")):
        return True
    return (
        normalized.endswith("_api_key")
        or normalized.endswith("_access_token")
        or normalized.endswith("_token")
        or normalized.endswith("_authorization")
        or normalized.endswith("_secret")
        or normalized.endswith("_password")
        or normalized.endswith("_key_preview")
        or normalized.endswith("_key_env")
    )


def _sanitize_string(value: str) -> str:
    text = str(value)
    if text.lower().startswith("data:"):
        return ""
    text = _SENSITIVE_QUERY_RE.sub(r"\1", text)
    text = text.replace("?&", "?")
    return text.rstrip("?&")


def sanitize_portable_config(value: Any, depth: int = 0) -> Any:
    """Return a JSON-safe deep copy with secrets and inline binaries removed."""
    if depth > 60:
        return None
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _sanitize_string(value)
    if isinstance(value, (list, tuple)):
        return [sanitize_portable_config(item, depth + 1) for item in value]
    if isinstance(value, Mapping):
        clean: Dict[str, Any] = {}
        for raw_key, item in value.items():
            key = str(raw_key)
            if is_sensitive_config_key(key):
                continue
            clean[key] = sanitize_portable_config(item, depth + 1)
        return clean
    return None


def collect_local_resource_urls(value: Any) -> List[str]:
    """Collect only local persisted media URLs, preserving first-seen order."""
    result: List[str] = []
    seen = set()

    def walk(item: Any) -> None:
        if isinstance(item, str):
            text = item.strip()
            if (
                text.startswith("/assets/")
                or text.startswith("/output/")
                or text.startswith("/api/storage-files/")
            ) and text not in seen:
                seen.add(text)
                result.append(text)
            return
        if isinstance(item, Mapping):
            for child in item.values():
                walk(child)
            return
        if isinstance(item, (list, tuple)):
            for child in item:
                walk(child)

    walk(value)
    return result


def collect_detail_page_media_urls(task: Mapping[str, Any]) -> List[str]:
    """Collect media only from known detail-page fields, never from prompts or provider URLs."""
    result: List[str] = []
    seen = set()

    def add(value: Any) -> None:
        if isinstance(value, Mapping):
            add(value.get("url") or value.get("value"))
            return
        if not isinstance(value, str):
            return
        text = value.strip()
        if not text or text in seen:
            return
        if not (
            text.startswith("/assets/")
            or text.startswith("/output/")
            or text.startswith("/api/storage-files/")
            or text.startswith("http://")
            or text.startswith("https://")
        ):
            return
        seen.add(text)
        result.append(text)

    def add_result(value: Any) -> None:
        if not isinstance(value, Mapping):
            return
        add(value.get("image_url"))
        for item in value.get("images") or []:
            add(item)
        for item in value.get("image_items") or []:
            add(item)

    if not isinstance(task, Mapping):
        return result
    settings = task.get("settings") if isinstance(task.get("settings"), Mapping) else {}
    for key in ("product_images", "reference_images", "product_image_meta", "reference_image_meta"):
        for item in settings.get(key) or []:
            add(item)
    for screen in task.get("screens") or []:
        if not isinstance(screen, Mapping):
            continue
        add_result(screen.get("result"))
        for candidate in screen.get("candidates") or []:
            if not isinstance(candidate, Mapping):
                continue
            add(candidate.get("image_url"))
            add_result(candidate.get("result"))
    return result


def rewrite_nested_values(value: Any, mapping: Mapping[str, str]) -> Any:
    """Recursively rewrite exact string values without mutating ``value``."""
    if isinstance(value, str):
        return mapping.get(value, value)
    if isinstance(value, list):
        return [rewrite_nested_values(item, mapping) for item in value]
    if isinstance(value, tuple):
        return [rewrite_nested_values(item, mapping) for item in value]
    if isinstance(value, Mapping):
        return {str(key): rewrite_nested_values(item, mapping) for key, item in value.items()}
    return copy.deepcopy(value)


_PROVIDER_REFERENCE_KEYS = {
    "apiProvider",
    "provider_id",
    "providerId",
    "videoProvider",
    "video_provider",
    "llmProvider",
    "llm_provider",
    "imageProvider",
    "image_provider",
    "image_provider_id",
    "llm_provider_id",
}


def rewrite_provider_references(value: Any, mapping: Mapping[str, str]) -> Any:
    """Rewrite known provider-ID fields without touching prompt text or arbitrary strings."""
    if isinstance(value, list):
        return [rewrite_provider_references(item, mapping) for item in value]
    if isinstance(value, tuple):
        return [rewrite_provider_references(item, mapping) for item in value]
    if not isinstance(value, Mapping):
        return copy.deepcopy(value)
    rewritten: Dict[str, Any] = {}
    for raw_key, item in value.items():
        key = str(raw_key)
        if key in _PROVIDER_REFERENCE_KEYS and isinstance(item, str):
            rewritten[key] = mapping.get(item, item)
        else:
            rewritten[key] = rewrite_provider_references(item, mapping)
    return rewritten


def normalize_portable_preferences(value: Any) -> Dict[str, Any]:
    """Keep the small, non-secret browser preferences that can be portable."""
    source = value if isinstance(value, Mapping) else {}
    theme = str(source.get("theme") or "light").strip().lower()
    if theme not in {"light", "dark"}:
        theme = "light"
    scale_mode = str(source.get("scale_mode") or "auto").strip().lower()
    allowed_scale_modes = {"auto", "60", "65", "70", "75", "80", "85", "90", "95", "100", "115", "125", "140"}
    if scale_mode not in allowed_scale_modes:
        scale_mode = "auto"

    def clean_types(items: Any) -> List[str]:
        result: List[str] = []
        for raw in items if isinstance(items, (list, tuple)) else []:
            item = str(raw or "").strip()
            if item and len(item) <= 80 and item not in result:
                result.append(item)
            if len(result) >= 64:
                break
        return result

    favorites = source.get("favorites") if isinstance(source.get("favorites"), Mapping) else {}
    return {
        "theme": theme,
        "scale_mode": scale_mode,
        "favorites": {
            "favoriteTypes": clean_types(favorites.get("favoriteTypes")),
            "order": clean_types(favorites.get("order")),
        },
    }


def _clear_runtime_state(value: Any) -> Any:
    if isinstance(value, list):
        return [_clear_runtime_state(item) for item in value]
    if not isinstance(value, Mapping):
        return copy.deepcopy(value)
    clean: Dict[str, Any] = {}
    for key, item in value.items():
        if key in _RUNTIME_KEYS:
            continue
        if key == "running":
            clean[key] = False
            continue
        clean[str(key)] = _clear_runtime_state(item)
    return clean


def prepare_exported_canvas(canvas: Mapping[str, Any], include_logs: bool = False) -> Dict[str, Any]:
    clean = copy.deepcopy(dict(canvas))
    clean.pop("deleted_at", None)
    clean.pop("task_runtime_id", None)
    clean.pop("client_id", None)
    clean["logs"] = copy.deepcopy(clean.get("logs") or []) if include_logs else []
    return _clear_runtime_state(clean)


def prepare_imported_canvas(
    canvas: Mapping[str, Any],
    *,
    new_canvas_id: str,
    new_project_id: str,
    timestamp: int,
    url_mapping: Mapping[str, str] | None = None,
) -> Dict[str, Any]:
    clean = prepare_exported_canvas(canvas, include_logs=False)
    clean = rewrite_nested_values(clean, url_mapping or {})
    clean["id"] = str(new_canvas_id)
    clean["project"] = str(new_project_id)
    clean["created_at"] = int(timestamp)
    clean["updated_at"] = int(timestamp)
    clean["logs"] = []
    clean.pop("deleted_at", None)
    return clean


_DETAIL_ACTIVE_STATUSES = {
    "uploading", "planning", "repairing", "generating", "analyzing", "compiling",
    "queued", "submitting", "recovering",
}


def prepare_exported_detail_task(task: Mapping[str, Any]) -> Dict[str, Any]:
    """Create a portable, credential-free detail-page history snapshot."""
    if not isinstance(task, Mapping) or str(task.get("type") or "") != "detail-page":
        raise ValueError("详情页任务数据无效")
    settings = task.get("settings")
    if settings is not None and not isinstance(settings, Mapping):
        raise ValueError("详情页任务设置无效")
    screens = task.get("screens")
    if screens is not None and not isinstance(screens, list):
        raise ValueError("详情页分屏数据无效")
    if len(screens or []) > 1000:
        raise ValueError("详情页分屏数量异常")
    for screen in screens or []:
        if not isinstance(screen, Mapping):
            raise ValueError("详情页分屏数据无效")
        candidates = screen.get("candidates")
        if candidates is not None and not isinstance(candidates, list):
            raise ValueError("详情页候选数据无效")
        if len(candidates or []) > 1000 or any(not isinstance(item, Mapping) for item in candidates or []):
            raise ValueError("详情页候选数据无效")
    clean = sanitize_portable_config(copy.deepcopy(dict(task)))
    if not isinstance(clean, dict):
        raise ValueError("详情页任务数据无效")
    for key in (
        "runtime_id", "submission_id", "submission_ids", "config_fingerprint",
        "background_task", "screen_tasks", "client_id",
    ):
        clean.pop(key, None)
    return _clear_runtime_state(clean)


def prepare_imported_detail_task(
    task: Mapping[str, Any],
    *,
    new_task_id: str,
    new_submission_id: str,
    new_group_no: int,
    runtime_id: str,
    imported_at: float,
    url_mapping: Mapping[str, str] | None = None,
    provider_id_map: Mapping[str, str] | None = None,
) -> Dict[str, Any]:
    """Import a history as an independent task that cannot resume source runtime work."""
    source = prepare_exported_detail_task(task)
    source_task_id = str(source.get("id") or "")
    try:
        source_group_no = int(source.get("group_no") or 0)
    except (TypeError, ValueError):
        source_group_no = 0
    clean = rewrite_nested_values(source, url_mapping or {})
    clean = rewrite_provider_references(clean, provider_id_map or {})
    source_status = str(clean.get("status") or "")
    was_active = source_status in _DETAIL_ACTIVE_STATUSES
    if was_active:
        clean["status"] = "interrupted"
        clean["error"] = "任务在导出时仍在运行，导入后已安全中断；不会自动恢复或回补上游任务"
    for screen in clean.get("screens") or []:
        if not isinstance(screen, MutableMapping):
            continue
        if str(screen.get("status") or "") in _DETAIL_ACTIVE_STATUSES:
            screen["status"] = "interrupted"
            screen["error"] = "导入时已中断"
        for candidate in screen.get("candidates") or []:
            if not isinstance(candidate, MutableMapping):
                continue
            if str(candidate.get("status") or "") in _DETAIL_ACTIVE_STATUSES:
                candidate["status"] = "interrupted"
                candidate["error"] = "导入时已中断，不能回补源设备的上游任务"
                candidate.pop("upstream_task_id", None)
                candidate.pop("provider_snapshot", None)
                candidate.pop("query_attempts", None)
                candidate.pop("last_query_at", None)
    clean.update({
        "id": str(new_task_id),
        "type": "detail-page",
        "group_no": int(new_group_no),
        "runtime_id": str(runtime_id or ""),
        "submission_id": str(new_submission_id),
        "submission_ids": [str(new_submission_id)],
        "config_fingerprint": "",
        "cancel_requested": False,
        "imported_at": float(imported_at),
        "imported_from": {
            "task_id": source_task_id,
            "group_no": source_group_no,
        },
    })
    return clean


def is_safe_archive_member(name: Any) -> bool:
    text = str(name or "")
    if not text or "\x00" in text or len(text) > 500:
        return False
    if text.startswith(("/", "\\")) or _DRIVE_PATH_RE.match(text):
        return False
    normalized = text.replace("\\", "/")
    parts = normalized.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return False
    return posixpath.normpath(normalized) == normalized


def validate_archive_infos(infos: Iterable[Any]) -> Dict[str, int]:
    count = 0
    total = 0
    for info in infos:
        count += 1
        if count > MAX_ARCHIVE_MEMBERS:
            raise ValueError("备份文件条目过多")
        name = getattr(info, "filename", "")
        if not is_safe_archive_member(name):
            raise ValueError(f"备份包含不安全路径：{name}")
        size = max(0, int(getattr(info, "file_size", 0) or 0))
        total += size
        if total > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
            raise ValueError("备份解压后体积过大")
    return {"member_count": count, "uncompressed_bytes": total}


def next_import_name(name: str, existing_names: Sequence[str] | set[str]) -> str:
    base = str(name or "未命名项目").strip() or "未命名项目"
    existing = {str(item) for item in existing_names}
    if base not in existing:
        return base
    first = f"{base}（导入）"
    if first not in existing:
        return first
    number = 2
    while f"{base}（导入 {number}）" in existing:
        number += 1
    return f"{base}（导入 {number}）"


def canonical_content_hash(value: Any, ignored_keys: Sequence[str] = ("id", "updated_at", "created_at")) -> str:
    ignored = set(ignored_keys)

    def without_ignored(item: Any) -> Any:
        if isinstance(item, Mapping):
            return {str(key): without_ignored(child) for key, child in item.items() if key not in ignored}
        if isinstance(item, list):
            return [without_ignored(child) for child in item]
        return item

    encoded = json.dumps(without_ignored(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _unique_imported_label(label: str, used: set[str]) -> str:
    base = str(label or "导入项目").strip() or "导入项目"
    candidate = f"{base}（导入）"
    if candidate not in used:
        used.add(candidate)
        return candidate
    number = 2
    while f"{base}（导入 {number}）" in used:
        number += 1
    candidate = f"{base}（导入 {number}）"
    used.add(candidate)
    return candidate


_PROVIDER_ID_SUFFIX_RE = re.compile(r"^(.*?)-(\d+)$")


def normalize_provider_url(value: Any) -> str:
    """Normalize a provider endpoint for identity comparison only."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    raw = raw.rstrip("/")
    try:
        parsed = urllib.parse.urlsplit(raw)
        if not parsed.scheme or not parsed.netloc:
            return raw.lower()
        scheme = parsed.scheme.lower()
        hostname = (parsed.hostname or "").lower()
        try:
            port = parsed.port
        except ValueError:
            return raw.lower()
        default_port = (scheme == "https" and port == 443) or (scheme == "http" and port == 80)
        if ":" in hostname and not hostname.startswith("["):
            hostname = f"[{hostname}]"
        netloc = hostname if not port or default_port else f"{hostname}:{port}"
        path = parsed.path.rstrip("/")
        safe_query = []
        for key, query_value in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True):
            if is_sensitive_config_key(key) or _SENSITIVE_QUERY_RE.search(f"?{key}={query_value}"):
                continue
            safe_query.append((key, query_value))
        return urllib.parse.urlunsplit((scheme, netloc, path, urllib.parse.urlencode(safe_query), ""))
    except Exception:
        return raw.lower()


def next_provider_id(provider_id: Any, existing_ids: Iterable[Any]) -> str:
    """Return the next available suffix while preserving custom-api-2 style IDs."""
    source = str(provider_id or "").strip() or "custom-api"
    used = {str(item or "").strip() for item in existing_ids if str(item or "").strip()}
    match = _PROVIDER_ID_SUFFIX_RE.fullmatch(source)
    if match:
        stem = match.group(1) or source
        number = max(2, int(match.group(2)) + 1)
    else:
        stem = source
        number = 2
    candidate = f"{stem}-{number}"
    while candidate in used:
        number += 1
        candidate = f"{stem}-{number}"
    return candidate


def merge_provider_entries_by_identity(
    existing: Sequence[Mapping[str, Any]],
    incoming: Sequence[Mapping[str, Any]],
    *,
    overwrite: bool = False,
) -> Tuple[List[Dict[str, Any]], Dict[str, int], Dict[str, str]]:
    """Merge portable providers without overwriting an ID collision at another URL.

    The returned ID map is source-provider-ID to imported target ID and is used to
    repair references inside canvases imported from the same archive.
    """
    result = [copy.deepcopy(dict(item)) for item in existing if isinstance(item, Mapping)]
    stats = {"imported": 0, "skipped": 0, "overwritten": 0, "cloned": 0}
    id_map: Dict[str, str] = {}
    used_names = {str(item.get("name") or "") for item in result if isinstance(item, Mapping)}

    for raw in incoming:
        if not isinstance(raw, Mapping):
            continue
        item = sanitize_portable_config(raw)
        source_id = str(item.get("id") or "").strip()
        if not source_id:
            continue
        source_url = normalize_provider_url(item.get("base_url"))
        same_url_index = next(
            (
                index
                for index, current in enumerate(result)
                if str(current.get("id") or "").strip() == source_id
                and normalize_provider_url(current.get("base_url")) == source_url
            ),
            None,
        )
        same_id_exists = any(str(current.get("id") or "").strip() == source_id for current in result)
        if same_url_index is not None:
            target = result[same_url_index]
            id_map[source_id] = source_id
            if not overwrite:
                stats["skipped"] += 1
                continue
            primary = target.get("primary", False)
            result[same_url_index] = {**target, **item, "primary": primary}
            stats["overwritten"] += 1
            continue

        if same_id_exists:
            target_id = next_provider_id(source_id, (current.get("id") for current in result))
            item["id"] = target_id
            label = str(item.get("name") or target_id)
            if label in used_names:
                item["name"] = _unique_imported_label(label, used_names)
            else:
                used_names.add(label)
            result.append(item)
            id_map[source_id] = target_id
            stats["cloned"] += 1
            continue

        result.append(item)
        id_map[source_id] = source_id
        used_names.add(str(item.get("name") or ""))
        stats["imported"] += 1

    return result, stats, id_map


def merge_prompt_libraries(
    existing: Mapping[str, Any], incoming: Mapping[str, Any]
) -> Tuple[Dict[str, Any], Dict[str, int]]:
    """Merge template items without overwriting local content."""
    merged = copy.deepcopy(dict(existing or {}))
    merged.setdefault("libraries", [])
    stats = {
        "imported": 0,
        "skipped_identical": 0,
        "libraries_added": 0,
        "libraries_changed": 0,
        "libraries_skipped": 0,
    }
    by_id = {str(lib.get("id")): lib for lib in merged["libraries"] if isinstance(lib, dict) and lib.get("id")}

    for incoming_library in (incoming or {}).get("libraries", []) or []:
        if not isinstance(incoming_library, Mapping):
            continue
        source = sanitize_portable_config(incoming_library)
        library_id = str(source.get("id") or "")
        target = by_id.get(library_id)
        if target is None:
            target = copy.deepcopy(source)
            if not library_id or library_id in by_id:
                target["id"] = f"prompt_{uuid.uuid4().hex[:12]}"
            merged["libraries"].append(target)
            by_id[str(target.get("id"))] = target
            stats["libraries_added"] += 1
            stats["libraries_changed"] += 1
            stats["imported"] += len(target.get("items") or [])
            continue

        target.setdefault("categories", [])
        target.setdefault("items", [])
        library_changed = False
        existing_category_ids = {str(cat.get("id")) for cat in target["categories"] if isinstance(cat, dict)}
        for category in source.get("categories") or []:
            if isinstance(category, dict) and str(category.get("id")) not in existing_category_ids:
                target["categories"].append(copy.deepcopy(category))
                existing_category_ids.add(str(category.get("id")))
                library_changed = True

        hashes = {canonical_content_hash(item, ignored_keys=("id", "updated_at", "created_at", "thumbnail")) for item in target["items"] if isinstance(item, dict)}
        used_names = {str(item.get("name") or "") for item in target["items"] if isinstance(item, dict)}
        used_ids = {str(item.get("id") or "") for item in target["items"] if isinstance(item, dict)}
        for incoming_item in source.get("items") or []:
            if not isinstance(incoming_item, dict):
                continue
            digest = canonical_content_hash(incoming_item, ignored_keys=("id", "updated_at", "created_at", "thumbnail"))
            if digest in hashes:
                stats["skipped_identical"] += 1
                continue
            item = copy.deepcopy(incoming_item)
            item["id"] = f"prompt_{uuid.uuid4().hex[:12]}"
            while item["id"] in used_ids:
                item["id"] = f"prompt_{uuid.uuid4().hex[:12]}"
            label = str(item.get("name") or "提示词")
            if label in used_names:
                label = _unique_imported_label(label, used_names)
            else:
                used_names.add(label)
            item["name"] = label
            target["items"].append(item)
            used_ids.add(item["id"])
            hashes.add(digest)
            stats["imported"] += 1
            library_changed = True

        if library_changed:
            stats["libraries_changed"] += 1
        else:
            stats["libraries_skipped"] += 1

    return merged, stats


def merge_entries_by_id(
    existing: Sequence[Mapping[str, Any]],
    incoming: Sequence[Mapping[str, Any]],
    *,
    id_keys: Sequence[str] = ("id",),
    overwrite: bool = False,
    clear_keys: Sequence[str] = (),
) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    result = [copy.deepcopy(dict(item)) for item in existing if isinstance(item, Mapping)]

    def entry_id(item: Mapping[str, Any]) -> str:
        return next((str(item.get(key) or "").strip() for key in id_keys if item.get(key)), "")

    index = {entry_id(item): pos for pos, item in enumerate(result) if entry_id(item)}
    stats = {"imported": 0, "skipped": 0, "overwritten": 0}
    for raw in incoming:
        if not isinstance(raw, Mapping):
            continue
        item = sanitize_portable_config(raw)
        key = entry_id(item)
        if not key:
            continue
        if key in index:
            if not overwrite:
                stats["skipped"] += 1
                continue
            merged = {**result[index[key]], **item}
            for clear_key in clear_keys:
                merged.pop(str(clear_key), None)
            result[index[key]] = merged
            stats["overwritten"] += 1
            continue
        index[key] = len(result)
        result.append(item)
        stats["imported"] += 1
    return result, stats
