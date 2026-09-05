"""Pure contracts for local image-generation modes.

This module deliberately has no web or storage dependencies.  Keeping the
normalization and serializer boundaries here prevents regular mode consumers
from receiving preset-prompt material.
"""

from __future__ import annotations

from copy import deepcopy
import re
from collections.abc import Mapping, Sequence
from typing import Any, Dict, List


ONLINE_IMAGE_PROMPT_MAX_LENGTH = 20_000
MODE_STATUSES = {"active", "archived", "trashed"}

_SEED_PREFIX = re.compile(r"^(0?[1-9]|[1-9][0-9]{1,2})(?=\D|$)")
_PUBLIC_FIELDS = (
    "id",
    "mode_no",
    "source_id",
    "builtin",
    "source_updated_at",
    "display_name",
    "description",
    "category",
    "tags",
    "synonyms",
    "sort_order",
    "status",
    "required_reference_count",
    "reference_images",
    "max_upload_count",
    "allow_extra_images",
    "extra_image_limit",
    "special_hint",
    "remark",
)
_SOURCE_COMPARISON_FIELDS = (
    "display_name",
    "preset_prompt",
    "required_reference_count",
    "reference_images",
    "max_upload_count",
    "allow_extra_images",
    "extra_image_limit",
    "special_hint",
    "remark",
)


def _require_non_negative_int(value: Any, field_name: str, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field_name} must be a non-negative integer")
    return value


def _optional_text(value: Any, field_name: str, default: str = "") -> str:
    if value is None:
        return default
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string")
    return value


def _normalized_reference_images(value: Any) -> List[Dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("reference_images must be a list")

    keys = set()
    normalized: List[Dict[str, Any]] = []
    for item in value:
        if not isinstance(item, Mapping):
            raise ValueError("reference_images entries must be mappings")
        key = item.get("key")
        if not isinstance(key, str) or not key.strip():
            raise ValueError("reference image key is required")
        if key in keys:
            raise ValueError(f"duplicate reference image key: {key}")
        keys.add(key)
        label = item.get("label", key)
        if not isinstance(label, str):
            raise ValueError("reference image label must be a string")
        required = item.get("required", False)
        if not isinstance(required, bool):
            raise ValueError("reference image required must be a boolean")
        normalized.append({"key": key, "label": label, "required": required})
    return normalized


def _parsed_seed_number(display_name: str) -> int | None:
    match = _SEED_PREFIX.match(display_name)
    return int(match.group(1)) if match else None


def normalize_mode(raw: Mapping[str, Any]) -> Dict[str, Any]:
    """Validate a mode and return a detached, normalized record.

    ``preset_prompt`` is intentionally copied without trimming or rewriting;
    it represents the decoded source string that later prompt composition must
    start with exactly.
    """
    if not isinstance(raw, Mapping):
        raise ValueError("mode must be a mapping")

    mode_id = raw.get("id")
    if not isinstance(mode_id, str) or not mode_id.strip():
        raise ValueError("mode id is required")
    display_name = _optional_text(raw.get("display_name"), "display_name")
    preset_prompt = _optional_text(raw.get("preset_prompt"), "preset_prompt")
    if len(preset_prompt) > ONLINE_IMAGE_PROMPT_MAX_LENGTH:
        raise ValueError(
            f"preset_prompt exceeds online image prompt limit "
            f"{ONLINE_IMAGE_PROMPT_MAX_LENGTH}"
        )

    reference_images = _normalized_reference_images(raw.get("reference_images"))
    required_reference_count = _require_non_negative_int(
        raw.get("required_reference_count"), "required_reference_count", 0
    )
    max_upload_count = _require_non_negative_int(
        raw.get("max_upload_count"), "max_upload_count", 6
    )
    extra_image_limit = _require_non_negative_int(
        raw.get("extra_image_limit"), "extra_image_limit", 0
    )
    if required_reference_count > max_upload_count:
        raise ValueError("required_reference_count cannot exceed max_upload_count")
    if required_reference_count > len(reference_images):
        raise ValueError("required_reference_count cannot exceed reference image slots")
    if required_reference_count != sum(item["required"] for item in reference_images):
        raise ValueError("required_reference_count must equal required reference image slots")
    if extra_image_limit > max_upload_count:
        raise ValueError("extra_image_limit cannot exceed max_upload_count")

    allow_extra_images = raw.get("allow_extra_images", False)
    if not isinstance(allow_extra_images, bool):
        raise ValueError("allow_extra_images must be a boolean")
    if not allow_extra_images and extra_image_limit:
        raise ValueError("extra_image_limit must be zero when extra images are disabled")

    status = raw.get("status", "active")
    if status not in MODE_STATUSES:
        raise ValueError(f"unknown mode status: {status}")

    mode_no = raw.get("mode_no")
    if mode_no is None:
        mode_no = _parsed_seed_number(display_name)
    elif isinstance(mode_no, bool) or not isinstance(mode_no, int) or mode_no < 1:
        raise ValueError("mode_no must be a positive integer")

    tags = raw.get("tags", [])
    if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
        raise ValueError("tags must be a list of strings")
    synonyms = raw.get("synonyms", [])
    if not isinstance(synonyms, list) or any(not isinstance(synonym, str) for synonym in synonyms):
        raise ValueError("synonyms must be a list of strings")

    normalized = deepcopy(dict(raw))
    normalized.update({
        "id": mode_id,
        "mode_no": mode_no,
        "display_name": display_name,
        "preset_prompt": preset_prompt,
        "required_reference_count": required_reference_count,
        "reference_images": reference_images,
        "max_upload_count": max_upload_count,
        "allow_extra_images": allow_extra_images,
        "extra_image_limit": extra_image_limit,
        "special_hint": _optional_text(raw.get("special_hint"), "special_hint"),
        "remark": _optional_text(raw.get("remark"), "remark"),
        "status": status,
        "tags": list(tags),
        "synonyms": list(synonyms),
    })
    for field in ("category", "description", "source_id", "source_updated_at"):
        if field in raw:
            normalized[field] = _optional_text(raw[field], field)
    if "builtin" in raw and not isinstance(raw["builtin"], bool):
        raise ValueError("builtin must be a boolean")
    if "sort_order" in raw:
        normalized["sort_order"] = _require_non_negative_int(raw["sort_order"], "sort_order", 0)
    return normalized


def public_mode(mode: Mapping[str, Any]) -> Dict[str, Any]:
    """Return the ordinary-user mode payload without prompt material."""
    normalized = normalize_mode(mode)
    return {field: deepcopy(normalized[field]) for field in _PUBLIC_FIELDS if field in normalized}


def admin_mode(mode: Mapping[str, Any]) -> Dict[str, Any]:
    """Return the complete mode record for the local administrator surface."""
    return normalize_mode(mode)


def compose_final_prompt(
    mode: Mapping[str, Any],
    image_roles: Sequence[str],
    user_prompt: str,
    aspect_ratio: str,
    resolution: str,
) -> str:
    """Build the stored submission prompt without rewriting the preset body."""
    preset_prompt = mode.get("preset_prompt") or ""
    sections = [preset_prompt]
    if image_roles:
        sections.append("【参考图顺序与职责】\n" + "\n".join(str(role) for role in image_roles))
    if str(user_prompt or "").strip():
        sections.append("【用户补充要求】\n" + str(user_prompt).strip())
    sections.append(f"【输出参数】图片比例：{aspect_ratio}；分辨率：{resolution}。")
    return "\n\n".join(section for section in sections if section)


def build_mode_search_text(mode: Mapping[str, Any]) -> str:
    """Build the normalized text used for number, name, tag, and use searches."""
    normalized = normalize_mode(mode)
    mode_no = normalized.get("mode_no")
    numbers = []
    if mode_no is not None:
        numbers.extend((str(mode_no), f"{mode_no:02d}"))
    fields = numbers + [
        normalized.get("display_name", ""),
        normalized.get("category", ""),
        normalized.get("description", ""),
        normalized.get("special_hint", ""),
        normalized.get("remark", ""),
        *normalized.get("tags", []),
        *normalized.get("synonyms", []),
    ]
    return " ".join(part for part in fields if part).casefold()


def _index_modes_by_id(
    modes: Sequence[Mapping[str, Any]], side: str
) -> Dict[str, Dict[str, Any]]:
    indexed: Dict[str, Dict[str, Any]] = {}
    for raw_mode in modes:
        mode = normalize_mode(raw_mode)
        mode_id = mode["id"]
        if mode_id in indexed:
            raise ValueError(f"duplicate {side} mode id: {mode_id}")
        indexed[mode_id] = mode
    return indexed


def _source_identity(mode: Mapping[str, Any]) -> str | None:
    """Return the immutable source identity of a local source-backed mode.

    New local records carry ``source_id``.  Legacy imported records which only
    set ``builtin=True`` remain source-backed under their own stable ``id``.
    Any other record is user-created and must not be treated as a source
    removal merely because the source never contained its local ID.
    """
    source_id = mode.get("source_id")
    if isinstance(source_id, str) and source_id.strip():
        return source_id
    return mode["id"] if mode.get("builtin") is True else None


def diff_source_modes(
    local_modes: Sequence[Mapping[str, Any]], source_modes: Sequence[Mapping[str, Any]]
) -> Dict[str, List[Dict[str, Any]]]:
    """Compare local modes with a checked source snapshot without mutating either."""
    local_by_id = _index_modes_by_id(local_modes, "local")
    source_by_id = _index_modes_by_id(source_modes, "source")
    local_by_source_id: Dict[str, Dict[str, Any]] = {}
    for local in local_by_id.values():
        source_id = _source_identity(local)
        if source_id is None:
            continue
        if source_id in local_by_source_id:
            raise ValueError(f"duplicate local source identity: {source_id}")
        local_by_source_id[source_id] = local

    additions = [
        deepcopy(source_by_id[mode_id])
        for mode_id in source_by_id
        if mode_id not in local_by_source_id
    ]
    source_removals = [
        deepcopy(local)
        for source_id, local in local_by_source_id.items()
        if source_id not in source_by_id
    ]
    changes: List[Dict[str, Any]] = []
    for mode_id in source_by_id:
        if mode_id not in local_by_source_id:
            continue
        local = local_by_source_id[mode_id]
        source = source_by_id[mode_id]
        changed_fields = [
            field for field in _SOURCE_COMPARISON_FIELDS if local.get(field) != source.get(field)
        ]
        if changed_fields:
            changes.append({
                "id": mode_id,
                "changed_fields": changed_fields,
                "local": deepcopy(local),
                "source": deepcopy(source),
            })
    return {"additions": additions, "changes": changes, "source_removals": source_removals}
