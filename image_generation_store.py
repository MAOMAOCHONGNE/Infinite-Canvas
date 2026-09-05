"""Local, atomic persistence for image-generation configuration and history.

The repository deliberately owns only durable JSON records.  Runtime task
execution and media adoption stay outside this module so a restart can inspect
history without accidentally resubmitting an upstream generation request.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
from typing import Any, Mapping
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from image_generation_modes import MODE_STATUSES, admin_mode, normalize_mode, public_mode


_TASK_PRIVATE_FIELDS = {
    "preset_prompt", "final_prompt", "prompt", "prompt_snapshot", "current_prompt",
    "draft_prompt", "original_prompt", "version_prompt", "prompt_versions",
    "version_history",
    "provider_snapshot", "upstream_task_id", "last_error",
}
_TASK_SUMMARY_FIELDS = (
    "id", "type", "group_no", "mode_id", "mode_no", "mode_name", "name", "status",
    "created_at", "updated_at", "completed_at", "error", "error_summary",
    "candidate_count", "successful_candidate_count", "results_deleted",
)
_VERSION_KINDS = {"original", "draft", "restored", "source_update", "admin_update"}
# These are the only fields a GitHub release is allowed to migrate. Every
# other field belongs to this installation (task/history ownership, version
# ancestry, timestamps, or local lifecycle state) and must remain untouched.
_OFFICIAL_MODE_FIELDS = (
    "display_name", "description", "category", "tags", "synonyms", "sort_order",
    "preset_prompt", "required_reference_count", "reference_images",
    "max_upload_count", "allow_extra_images", "extra_image_limit", "special_hint",
    "remark", "example",
)
_SOURCE_MODE_FIELDS = (
    "display_name", "preset_prompt", "required_reference_count", "reference_images",
    "max_upload_count", "allow_extra_images", "extra_image_limit", "special_hint", "remark",
)
_ADMIN_MUTABLE_MODE_FIELDS = {
    "display_name", "description", "category", "tags", "synonyms", "sort_order",
    "required_reference_count", "reference_images", "max_upload_count",
    "allow_extra_images", "extra_image_limit", "special_hint", "remark",
    "preset_prompt", "status", "example_caption",
}
_ADMIN_CREATE_MODE_FIELDS = {
    "display_name", "description", "category", "sort_order", "preset_prompt",
    "required_reference_count", "reference_images", "max_upload_count",
    "allow_extra_images", "extra_image_limit", "special_hint", "remark", "status",
}

_SENSITIVE_KEY = re.compile(r"(?:authorization|api[_-]?key|access[_-]?token|token|secret|password|credential)", re.I)
_URL = re.compile(r"https?://[^\s\"'<>]+", re.I)
_BACKUP_MEDIA_URL = re.compile(
    r"^/assets/image-generation/media/([a-f0-9]{2})/([a-f0-9]{64})(\.(?:png|jpg|webp|gif))$"
)
_BACKUP_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}
_STATIC_EXAMPLE_URL = re.compile(r"^/static/image-generation-examples/[A-Za-z0-9._/-]{1,500}$")


def _redacted_url(match: re.Match[str]) -> str:
    raw = match.group(0)
    trailing = ""
    while raw and raw[-1] in ").,;]}":
        trailing = raw[-1] + trailing
        raw = raw[:-1]
    try:
        parsed = urlsplit(raw)
        hostname = parsed.hostname or ""
        if ":" in hostname and not hostname.startswith("["):
            hostname = f"[{hostname}]"
        try:
            port = parsed.port
        except ValueError:
            port = None
        netloc = f"{hostname}:{port}" if hostname and port is not None else hostname
        return urlunsplit((parsed.scheme, netloc, parsed.path, "", "")) + trailing
    except ValueError:
        return "[REDACTED-URL]" + trailing


def image_generation_redact_sensitive_text(value: Any, known_secrets=()) -> str:
    text = str(value or "")
    for secret in sorted({str(item) for item in known_secrets if str(item)}, key=len, reverse=True):
        text = text.replace(secret, "[REDACTED]")
    text = re.sub(r"(?i)(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\bbearer\s+[^\s,;]+", "Bearer [REDACTED]", text)
    text = re.sub(
        r"(?i)(\b(?:api[_-]?key|access[_-]?token|token|secret|password|credential)\b\s*[:=]\s*)[^\s,;&]+",
        r"\1[REDACTED]",
        text,
    )
    return _URL.sub(_redacted_url, text)


def image_generation_redact_sensitive_value(value: Any, known_secrets=(), *, drop_sensitive_keys=False) -> Any:
    if isinstance(value, str):
        return image_generation_redact_sensitive_text(value, known_secrets)
    if isinstance(value, list):
        return [image_generation_redact_sensitive_value(item, known_secrets, drop_sensitive_keys=drop_sensitive_keys) for item in value]
    if isinstance(value, tuple):
        return [image_generation_redact_sensitive_value(item, known_secrets, drop_sensitive_keys=drop_sensitive_keys) for item in value]
    if isinstance(value, Mapping):
        result = {}
        for key, item in value.items():
            if _SENSITIVE_KEY.search(str(key)):
                if not drop_sensitive_keys:
                    result[key] = "[REDACTED]"
                continue
            result[key] = image_generation_redact_sensitive_value(
                item, known_secrets, drop_sensitive_keys=drop_sensitive_keys
            )
        return result
    return deepcopy(value)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _content_version_key(value: Any) -> tuple[Any, ...]:
    """Return a deterministic ordering key for official content revisions.

    Releases normally use date/number strings (for example ``2026.09.05.1``),
    while older local records may contain opaque labels.  Numeric components
    therefore take precedence; opaque versions fall back to a stable casefolded
    string comparison instead of silently allowing a downgrade.
    """
    text = str(value or "").strip()
    numbers = tuple(int(item) for item in re.findall(r"\d+", text))
    return (1, numbers, text.casefold()) if numbers else (0, (), text.casefold())


def _version_is_older(candidate: Any, current: Any) -> bool:
    candidate_text = str(candidate or "").strip()
    current_text = str(current or "").strip()
    if not candidate_text or not current_text:
        return False
    candidate_numbers = re.findall(r"\d+", candidate_text)
    current_numbers = re.findall(r"\d+", current_text)
    # Legacy releases sometimes used opaque labels.  They are accepted for
    # compatibility when compared with a dated/numeric revision; only two
    # numeric revisions (or two opaque labels) participate in ordering.
    if bool(candidate_numbers) != bool(current_numbers):
        return False
    return _content_version_key(candidate_text) < _content_version_key(current_text)


class ImageGenerationStore:
    """Filesystem repository with one process-local lock for every mutation."""

    def __init__(self, data_root: Path, seed_path: Path):
        self.data_root = Path(data_root)
        self.seed_path = Path(seed_path)
        self.mode_dir = self.data_root / "image_generation_modes"
        self.version_dir = self.data_root / "image_generation_prompt_versions"
        self.draft_dir = self.data_root / "image_generation_drafts"
        self.task_dir = self.data_root / "image_generation_tasks"
        self.meta_path = self.mode_dir / "_meta.json"
        self._lock = threading.RLock()

    @staticmethod
    def _file_key(record_id: str) -> str:
        if not isinstance(record_id, str) or not record_id:
            raise ValueError("record id is required")
        return hashlib.sha256(record_id.encode("utf-8")).hexdigest()

    def _mode_path(self, mode_id: str) -> Path:
        return self.mode_dir / f"{self._file_key(mode_id)}.json"

    def _version_path(self, version_id: str) -> Path:
        return self.version_dir / f"{self._file_key(version_id)}.json"

    def _workspace_draft_path(self, mode_id: str) -> Path:
        return self.draft_dir / f"workspace-{self._file_key(mode_id)}.json"

    def _task_path(self, task_id: str) -> Path:
        return self.task_dir / f"{self._file_key(task_id)}.json"

    def _write_json(self, target: Path, value: Any) -> None:
        """Atomically replace one JSON file in its own directory."""
        with self._lock:
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary_name: str | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="w", encoding="utf-8", delete=False, dir=target.parent
                ) as handle:
                    temporary_name = handle.name
                    json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
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

    @staticmethod
    def _read_json(path: Path) -> Any:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)

    def _read_record(self, path: Path, label: str, *, required: bool = False) -> Any:
        if not path.is_file():
            if required:
                raise KeyError(label)
            return None
        try:
            return self._read_json(path)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            print(f"忽略损坏的图片生成{label}记录 {path.name}: {exc}")
            if required:
                raise ValueError(f"corrupt {label} record: {path.name}") from exc
            return None

    def _read_meta(self) -> dict[str, Any]:
        raw = self._read_record(self.meta_path, "元数据")
        if not isinstance(raw, dict):
            return {
                "next_mode_no": 1,
                "next_task_group_no": 1,
                "official_content_version": "",
            }
        result: dict[str, Any] = {}
        for key in ("next_mode_no", "next_task_group_no"):
            value = raw.get(key, 1)
            result[key] = value if isinstance(value, int) and not isinstance(value, bool) and value >= 1 else 1
        version = raw.get("official_content_version", "")
        result["official_content_version"] = version.strip() if isinstance(version, str) else ""
        return result

    def _write_meta(self, meta: Mapping[str, Any]) -> None:
        self._write_json(self.meta_path, {
            "next_mode_no": max(1, int(meta["next_mode_no"])),
            "next_task_group_no": max(1, int(meta["next_task_group_no"])),
            "official_content_version": str(meta.get("official_content_version") or ""),
        })

    def _iter_records(self, directory: Path, label: str) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        if not directory.exists():
            return records
        for path in sorted(directory.glob("*.json")):
            if path == self.meta_path:
                continue
            raw = self._read_record(path, label)
            if isinstance(raw, dict):
                records.append(raw)
            elif raw is not None:
                print(f"忽略无效的图片生成{label}记录 {path.name}")
        return records

    def _load_mode(self, mode_id: str, *, required: bool = False) -> dict[str, Any] | None:
        raw = self._read_record(self._mode_path(mode_id), "模式", required=required)
        if raw is None:
            return None
        if not isinstance(raw, dict) or raw.get("id") != mode_id:
            if required:
                raise ValueError(f"invalid mode record: {mode_id}")
            return None
        try:
            return normalize_mode(raw)
        except ValueError as exc:
            print(f"忽略无效的图片生成模式记录 {mode_id}: {exc}")
            if required:
                raise
            return None

    def _load_version(self, version_id: str, *, required: bool = False) -> dict[str, Any] | None:
        raw = self._read_record(self._version_path(version_id), "提示词版本", required=required)
        if raw is None:
            return None
        required_fields = {
            "id", "mode_id", "kind", "prompt", "parent_version_id", "note", "created_at",
            "source_updated_at",
        }
        schema_valid = (
            isinstance(raw, dict)
            and required_fields.issubset(raw)
            and raw.get("id") == version_id
            and isinstance(raw.get("id"), str) and bool(raw["id"])
            and isinstance(raw.get("mode_id"), str) and bool(raw["mode_id"])
            and isinstance(raw.get("kind"), str) and raw["kind"] in _VERSION_KINDS
            and isinstance(raw.get("prompt"), str)
            and (raw.get("parent_version_id") is None or (
                isinstance(raw.get("parent_version_id"), str) and bool(raw["parent_version_id"])
            ))
            and isinstance(raw.get("note"), str)
            and isinstance(raw.get("created_at"), str)
            and isinstance(raw.get("source_updated_at"), str)
            and (raw["kind"] != "original" or raw["parent_version_id"] is None)
            and (raw["kind"] == "original" or isinstance(raw["parent_version_id"], str))
        )
        if not schema_valid:
            if required:
                raise ValueError(f"invalid prompt version: {version_id}")
            print(f"忽略无效的图片生成提示词版本记录 {version_id}")
            return None
        return deepcopy(raw)

    def _validated_version_for_mode(
        self, mode: Mapping[str, Any], version_id: str, *, allowed_kinds: set[str] | None = None
    ) -> dict[str, Any]:
        """Validate a version and its complete parent chain before mode mutation."""
        try:
            version = self._load_version(version_id, required=True)
        except (KeyError, ValueError) as exc:
            raise ValueError(f"invalid prompt version: {version_id}") from exc
        if version is None or version["mode_id"] != mode["id"]:
            raise ValueError("prompt version does not belong to this mode")
        if allowed_kinds is not None and version["kind"] not in allowed_kinds:
            raise ValueError("prompt version kind is not allowed for this operation")

        candidate = deepcopy(dict(mode))
        candidate["preset_prompt"] = version["prompt"]
        normalize_mode(candidate)

        seen: set[str] = set()
        current = version
        while True:
            current_id = current["id"]
            if current_id in seen:
                raise ValueError("prompt version parent chain contains a cycle")
            seen.add(current_id)
            parent_id = current["parent_version_id"]
            if parent_id is None:
                if current["kind"] != "original":
                    raise ValueError("non-original versions require an original parent chain")
                return version
            try:
                parent = self._load_version(parent_id, required=True)
            except (KeyError, ValueError) as exc:
                raise ValueError(f"invalid prompt version parent: {parent_id}") from exc
            if parent is None or parent["mode_id"] != mode["id"]:
                raise ValueError("prompt version parent does not belong to this mode")
            current = parent

    def _next_mode_no_locked(self) -> int:
        meta = self._read_meta()
        number = meta["next_mode_no"]
        meta["next_mode_no"] = number + 1
        self._write_meta(meta)
        return number

    def next_mode_no(self) -> int:
        """Return the next permanent number without reserving it."""
        with self._lock:
            return self._read_meta()["next_mode_no"]

    def _apply_official_seed_locked(
        self,
        seed_modes: list[dict[str, Any]],
        existing_by_source: Mapping[str, dict[str, Any]],
        seed_version: str,
        meta: dict[str, Any],
    ) -> None:
        for mode in seed_modes:
            local = existing_by_source.get(mode["id"])
            # A user-created mode may deliberately use the same id as a future
            # release. It has no source identity and remains locally owned.
            if local is None and self._mode_path(mode["id"]).exists():
                continue
            if local is not None and str(local.get("source_updated_at") or "") == seed_version:
                continue
            mode_no = local.get("mode_no") if local is not None else mode.get("mode_no")
            if not isinstance(mode_no, int):
                mode_no = meta["next_mode_no"]
            meta["next_mode_no"] = max(meta["next_mode_no"], mode_no + 1)
            now = _utc_now()
            if local is None:
                version_id = str(uuid4())
                local_mode = deepcopy(mode)
                local_mode.update({
                    "id": mode["id"], "mode_no": mode_no, "source_id": mode["id"], "builtin": True,
                    "source_updated_at": seed_version, "original_version_id": version_id,
                    "current_version_id": version_id, "draft_version_ids": [], "created_at": now,
                    "updated_at": now,
                })
                version = {
                    "id": version_id, "mode_id": local_mode["id"], "kind": "original",
                    "prompt": local_mode["preset_prompt"], "parent_version_id": None, "note": "",
                    "created_at": now, "source_updated_at": seed_version,
                }
                self._write_json(self._version_path(version_id), version)
                self._write_json(self._mode_path(local_mode["id"]), normalize_mode(local_mode))
                continue

            current_version_id = str(local.get("current_version_id") or "")
            self._validated_version_for_mode(local, current_version_id)
            updated = deepcopy(local)
            for field in _OFFICIAL_MODE_FIELDS:
                if field in mode:
                    updated[field] = deepcopy(mode[field])
            updated.update({
                "source_id": mode["id"],
                "builtin": True,
                "source_updated_at": seed_version,
                "updated_at": now,
            })
            if updated.get("preset_prompt") != local.get("preset_prompt"):
                version_id = str(uuid4())
                updated["current_version_id"] = version_id
                version = {
                    "id": version_id, "mode_id": updated["id"], "kind": "source_update",
                    "prompt": updated["preset_prompt"], "parent_version_id": current_version_id,
                    "note": f"github:{seed_version}", "created_at": now,
                    "source_updated_at": seed_version,
                }
                self._write_json(self._version_path(version_id), version)
            self._write_json(self._mode_path(updated["id"]), normalize_mode(updated))

    def initialize(self) -> None:
        """Create records and migrate only source-backed official configuration.

        The tracked seed is the GitHub release artifact. A changed
        ``distribution_version`` updates official metadata in place while
        preserving local mode identity, prompt ancestry, tasks, drafts, media,
        and every other installation-owned record.
        """
        with self._lock:
            for directory in (self.mode_dir, self.version_dir, self.draft_dir, self.task_dir):
                directory.mkdir(parents=True, exist_ok=True)
            try:
                seed = self._read_json(self.seed_path)
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValueError(f"cannot load image-generation seed: {exc}") from exc
            if not isinstance(seed, dict) or not isinstance(seed.get("modes"), list):
                raise ValueError("image-generation seed must contain modes")

            seed_version = str(
                seed.get("distribution_version")
                or seed.get("source_version")
                or seed.get("captured_at")
                or ""
            ).strip()
            if not seed_version:
                raise ValueError("image-generation seed must contain distribution_version")

            seed_modes: list[dict[str, Any]] = []
            seen_seed_ids: set[str] = set()
            for raw_seed_mode in seed["modes"]:
                mode = normalize_mode(raw_seed_mode)
                if mode["id"] in seen_seed_ids:
                    raise ValueError(f"duplicate seed mode id: {mode['id']}")
                seen_seed_ids.add(mode["id"])
                seed_modes.append(mode)

            existing_records = [
                normalize_mode(item) for item in self._iter_records(self.mode_dir, "模式")
            ]
            existing_by_source: dict[str, dict[str, Any]] = {}
            for existing in existing_records:
                source_identity = self._source_identity_for_mode(existing)
                if source_identity:
                    if source_identity in existing_by_source:
                        raise ValueError(f"duplicate local source identity: {source_identity}")
                    existing_by_source[source_identity] = existing

            meta = self._read_meta()
            current_content_version = str(meta.get("official_content_version") or "")
            # A stale tracked seed must never roll back already imported local
            # official content.  An empty seed is still valid and intentionally
            # leaves existing local records untouched.
            apply_seed_modes = not _version_is_older(seed_version, current_content_version)
            existing_mode_numbers = [
                int(mode.get("mode_no"))
                for mode in self._iter_records(self.mode_dir, "模式")
                if isinstance(mode.get("mode_no"), int) and not isinstance(mode.get("mode_no"), bool)
            ]
            existing_groups = [
                int(task.get("group_no"))
                for task in self._iter_records(self.task_dir, "任务")
                if isinstance(task.get("group_no"), int) and not isinstance(task.get("group_no"), bool)
            ]
            meta["next_mode_no"] = max(meta["next_mode_no"], (max(existing_mode_numbers) + 1) if existing_mode_numbers else 1)
            meta["next_task_group_no"] = max(meta["next_task_group_no"], (max(existing_groups) + 1) if existing_groups else 1)

            directories = (self.mode_dir, self.version_dir)
            snapshot = {
                path: path.read_bytes()
                for directory in directories
                for path in directory.glob("*.json")
            }
            try:
                self._apply_official_seed_locked(
                    seed_modes if apply_seed_modes else [],
                    existing_by_source,
                    seed_version,
                    meta,
                )
                if apply_seed_modes and (
                    not current_content_version
                    or _version_is_older(current_content_version, seed_version)
                ):
                    meta["official_content_version"] = seed_version
                self._write_meta(meta)
            except Exception:
                self._restore_snapshot(snapshot, directories)
                raise

    def list_modes(self, *, include_admin: bool = False) -> list[dict[str, Any]]:
        modes: list[dict[str, Any]] = []
        for raw in self._iter_records(self.mode_dir, "模式"):
            try:
                mode = normalize_mode(raw)
            except ValueError as exc:
                print(f"忽略无效的图片生成模式记录: {exc}")
                continue
            if not include_admin and mode.get("status") != "active":
                continue
            modes.append(admin_mode(mode) if include_admin else public_mode(mode))
        return sorted(modes, key=lambda item: (
            int(item.get("sort_order")) if isinstance(item.get("sort_order"), int) else int(item.get("mode_no") or 10**9),
            int(item.get("mode_no") or 10**9),
            str(item.get("id") or ""),
        ))

    def get_mode(self, mode_id: str, *, include_admin: bool = False) -> dict[str, Any] | None:
        mode = self._load_mode(mode_id)
        if mode is None or (not include_admin and mode.get("status") != "active"):
            return None
        return admin_mode(mode) if include_admin else public_mode(mode)

    def _require_mode(self, mode_id: str) -> dict[str, Any]:
        mode = self._load_mode(mode_id, required=True)
        if mode is None:
            raise KeyError(mode_id)
        return mode

    def _new_version(self, mode: Mapping[str, Any], prompt: str, *, kind: str, parent_version_id: str | None, note: str = "") -> dict[str, Any]:
        candidate = deepcopy(dict(mode))
        candidate["preset_prompt"] = prompt
        normalize_mode(candidate)
        now = _utc_now()
        return {
            "id": str(uuid4()), "mode_id": mode["id"], "kind": kind, "prompt": prompt,
            "parent_version_id": parent_version_id, "note": str(note), "created_at": now,
            "source_updated_at": str(mode.get("source_updated_at") or ""),
        }

    def save_prompt_draft(self, mode_id: str, prompt: str, *, note: str = "") -> dict[str, Any]:
        with self._lock:
            mode = self._require_mode(mode_id)
            self._validated_version_for_mode(mode, str(mode.get("current_version_id") or ""))
            version = self._new_version(mode, prompt, kind="draft", parent_version_id=mode.get("current_version_id"), note=note)
            self._write_json(self._version_path(version["id"]), version)
            mode["draft_version_ids"] = list(mode.get("draft_version_ids") or []) + [version["id"]]
            mode["updated_at"] = _utc_now()
            self._write_json(self._mode_path(mode_id), mode)
            return deepcopy(version)

    def activate_prompt_draft(self, mode_id: str, version_id: str) -> dict[str, Any]:
        with self._lock:
            mode = self._require_mode(mode_id)
            version = self._validated_version_for_mode(mode, version_id, allowed_kinds={"draft"})
            mode["current_version_id"] = version_id
            mode["preset_prompt"] = version["prompt"]
            mode["updated_at"] = _utc_now()
            self._write_json(self._mode_path(mode_id), mode)
            return deepcopy(version)

    def restore_prompt_version(self, mode_id: str, version_id: str) -> dict[str, Any]:
        with self._lock:
            mode = self._require_mode(mode_id)
            source = self._validated_version_for_mode(mode, version_id)
            self._validated_version_for_mode(mode, str(mode.get("current_version_id") or ""))
            restored = self._new_version(mode, source["prompt"], kind="restored", parent_version_id=mode.get("current_version_id"), note=f"restored:{version_id}")
            self._write_json(self._version_path(restored["id"]), restored)
            mode["current_version_id"] = restored["id"]
            mode["preset_prompt"] = restored["prompt"]
            mode["updated_at"] = _utc_now()
            self._write_json(self._mode_path(mode_id), mode)
            return deepcopy(restored)

    def get_prompt_version(self, mode_id: str, version_id: str) -> dict[str, Any]:
        """Return one fully validated version owned by ``mode_id``."""
        with self._lock:
            mode = self._require_mode(mode_id)
            return deepcopy(self._validated_version_for_mode(mode, version_id))

    def list_prompt_versions(self, mode_id: str) -> list[dict[str, Any]]:
        """Return every valid version owned by one mode, newest first."""
        with self._lock:
            mode = self._require_mode(mode_id)
            versions: list[dict[str, Any]] = []
            for raw in self._iter_records(self.version_dir, "提示词版本"):
                version_id = raw.get("id") if isinstance(raw, dict) else None
                if not isinstance(version_id, str) or not version_id:
                    continue
                version = self._load_version(version_id)
                if version is None or version.get("mode_id") != mode["id"]:
                    continue
                try:
                    self._validated_version_for_mode(mode, version_id)
                except ValueError:
                    continue
                versions.append(version)
            return sorted(
                versions,
                key=lambda item: (str(item.get("created_at") or ""), str(item.get("id") or "")),
                reverse=True,
            )

    @staticmethod
    def _source_identity_for_mode(mode: Mapping[str, Any]) -> str | None:
        source_id = mode.get("source_id")
        if isinstance(source_id, str) and source_id.strip():
            return source_id
        mode_id = mode.get("id")
        return str(mode_id) if mode.get("builtin") is True and isinstance(mode_id, str) else None

    @staticmethod
    def _restore_snapshot(snapshot: Mapping[Path, bytes], directories: tuple[Path, ...]) -> None:
        """Restore JSON files without using the mutation method that may have failed."""
        current = {
            path for directory in directories if directory.exists() for path in directory.glob("*.json")
        }
        for path in current - set(snapshot):
            path.unlink(missing_ok=True)
        for path, payload in snapshot.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary_name: str | None = None
            try:
                with tempfile.NamedTemporaryFile(mode="wb", delete=False, dir=path.parent) as handle:
                    temporary_name = handle.name
                    handle.write(payload)
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

    def apply_source_review(
        self,
        source_modes: list[Mapping[str, Any]],
        decisions: Mapping[str, str],
        *,
        source_updated_at: str = "",
    ) -> dict[str, Any]:
        """Apply an already-reviewed source snapshot as one rollback-capable batch.

        Browser input supplies only decisions. Prompt/config bodies come from the
        server-owned review snapshot passed by the route.
        """
        if not isinstance(source_modes, list) or not isinstance(decisions, Mapping):
            raise ValueError("source review payload is invalid")
        normalized_source: dict[str, dict[str, Any]] = {}
        for raw in source_modes:
            validated = normalize_mode(raw)
            source = {"id": validated["id"]}
            source.update({field: deepcopy(validated[field]) for field in _SOURCE_MODE_FIELDS})
            source = normalize_mode(source)
            source_id = source["id"]
            if source_id in normalized_source:
                raise ValueError(f"duplicate source mode id: {source_id}")
            normalized_source[source_id] = source
        allowed_actions = {"keep_local", "accept_source", "import_new", "duplicate_source"}
        normalized_decisions = {str(key): str(value) for key, value in decisions.items()}
        if any(action not in allowed_actions for action in normalized_decisions.values()):
            raise ValueError("unknown source review decision")

        with self._lock:
            local_modes = [normalize_mode(item) for item in self._iter_records(self.mode_dir, "模式")]
            local_by_source: dict[str, dict[str, Any]] = {}
            local_ids = {mode["id"] for mode in local_modes}
            for local in local_modes:
                identity = self._source_identity_for_mode(local)
                if identity is None:
                    continue
                if identity in local_by_source:
                    raise ValueError(f"duplicate local source identity: {identity}")
                local_by_source[identity] = local
            unknown_decisions = set(normalized_decisions) - set(normalized_source) - set(local_by_source)
            if unknown_decisions:
                raise ValueError("source review contains unknown mode decisions")
            for removed_id in set(local_by_source) - set(normalized_source):
                if normalized_decisions.get(removed_id, "keep_local") != "keep_local":
                    raise ValueError("source removals can only keep the local mode")

            directories = (self.mode_dir, self.version_dir)
            snapshot = {
                path: path.read_bytes()
                for directory in directories if directory.exists()
                for path in directory.glob("*.json")
            }
            meta = self._read_meta()
            now = _utc_now()
            result = {"accepted": [], "imported": [], "duplicated": [], "kept": []}

            def allocate_mode_no() -> int:
                number = int(meta["next_mode_no"])
                meta["next_mode_no"] = number + 1
                return number

            def create_mode(source: Mapping[str, Any], *, source_backed: bool) -> dict[str, Any]:
                source_id = str(source["id"])
                mode_id = source_id if source_backed and source_id not in local_ids else str(uuid4())
                local_ids.add(mode_id)
                version_id = str(uuid4())
                value = deepcopy(dict(source))
                value.update({
                    "id": mode_id,
                    "mode_no": allocate_mode_no(),
                    "source_id": source_id if source_backed else "",
                    "builtin": bool(source_backed),
                    "source_updated_at": str(source_updated_at or source.get("source_updated_at") or ""),
                    "original_version_id": version_id,
                    "current_version_id": version_id,
                    "draft_version_ids": [],
                    "created_at": now,
                    "updated_at": now,
                    "status": "active",
                })
                if not source_backed:
                    value["display_name"] = f"{value.get('display_name') or '来源模式'}（来源副本）"
                normalized = normalize_mode(value)
                version = {
                    "id": version_id,
                    "mode_id": mode_id,
                    "kind": "original",
                    "prompt": normalized["preset_prompt"],
                    "parent_version_id": None,
                    "note": "source-import" if source_backed else "source-duplicate",
                    "created_at": now,
                    "source_updated_at": normalized.get("source_updated_at", ""),
                }
                self._write_json(self._version_path(version_id), version)
                self._write_json(self._mode_path(mode_id), normalized)
                return normalized

            try:
                for source_id, source in normalized_source.items():
                    action = normalized_decisions.get(source_id, "keep_local")
                    local = local_by_source.get(source_id)
                    if action == "keep_local":
                        result["kept"].append(source_id)
                        continue
                    if action == "import_new":
                        if local is not None:
                            raise ValueError("import_new is only valid for a source addition")
                        created = create_mode(source, source_backed=True)
                        result["imported"].append(created["id"])
                        continue
                    if action == "duplicate_source":
                        if local is None:
                            raise ValueError("duplicate_source requires an existing source mode")
                        created = create_mode(source, source_backed=False)
                        result["duplicated"].append(created["id"])
                        continue
                    if action != "accept_source" or local is None:
                        raise ValueError("accept_source requires an existing source mode")
                    current_version_id = str(local.get("current_version_id") or "")
                    self._validated_version_for_mode(local, current_version_id)
                    version_id = str(uuid4())
                    updated = deepcopy(local)
                    for field in _SOURCE_MODE_FIELDS:
                        updated[field] = deepcopy(source[field])
                    updated.update({
                        "source_id": source_id,
                        "builtin": True,
                        "source_updated_at": str(source_updated_at or source.get("source_updated_at") or ""),
                        "current_version_id": version_id,
                        "updated_at": now,
                    })
                    updated = normalize_mode(updated)
                    version = {
                        "id": version_id,
                        "mode_id": updated["id"],
                        "kind": "source_update",
                        "prompt": updated["preset_prompt"],
                        "parent_version_id": current_version_id,
                        "note": "source-update",
                        "created_at": now,
                        "source_updated_at": updated.get("source_updated_at", ""),
                    }
                    self._write_json(self._version_path(version_id), version)
                    self._write_json(self._mode_path(updated["id"]), updated)
                    result["accepted"].append(updated["id"])
                self._write_meta(meta)
            except Exception as exc:
                try:
                    self._restore_snapshot(snapshot, directories)
                except Exception as rollback_exc:
                    raise ValueError("source review rollback failed") from rollback_exc
                if isinstance(exc, ValueError):
                    raise
                raise ValueError("source review apply failed") from exc
            result["items"] = self.list_modes(include_admin=True)
            return result

    def duplicate_mode(self, mode_id: str, display_name: str) -> dict[str, Any]:
        with self._lock:
            source = self._require_mode(mode_id)
            if not isinstance(display_name, str) or not display_name.strip():
                raise ValueError("display_name is required")
            copied = deepcopy(source)
            copied_id = str(uuid4())
            version_id = str(uuid4())
            now = _utc_now()
            copied.update({
                "id": copied_id, "mode_no": self._next_mode_no_locked(), "display_name": display_name,
                "builtin": False, "source_id": "", "original_version_id": version_id,
                "current_version_id": version_id, "draft_version_ids": [], "created_at": now,
                "updated_at": now, "status": "active",
            })
            copied.pop("example", None)
            normalize_mode(copied)
            version = {
                "id": version_id, "mode_id": copied_id, "kind": "original", "prompt": copied["preset_prompt"],
                "parent_version_id": None, "note": "copied", "created_at": now,
                "source_updated_at": str(copied.get("source_updated_at") or ""),
            }
            self._write_json(self._version_path(version_id), version)
            self._write_json(self._mode_path(copied_id), copied)
            return admin_mode(copied)

    def create_mode(self, settings: Mapping[str, Any]) -> dict[str, Any]:
        """Atomically create a blank, locally owned mode from administrator settings."""
        if not isinstance(settings, Mapping):
            raise ValueError("mode settings must be a mapping")
        unexpected = set(settings) - _ADMIN_CREATE_MODE_FIELDS
        if unexpected:
            raise ValueError("mode settings contain protected fields")

        requested = deepcopy(dict(settings))
        display_name = requested.get("display_name")
        if not isinstance(display_name, str) or not display_name.strip() or len(display_name) > 400:
            raise ValueError("display_name is required")
        requested["display_name"] = display_name.strip()
        if "description" in requested and (
            not isinstance(requested["description"], str) or len(requested["description"]) > 20_000
        ):
            raise ValueError("description is invalid")
        if "category" in requested and (
            not isinstance(requested["category"], str) or len(requested["category"]) > 200
        ):
            raise ValueError("category is invalid")
        if "remark" in requested and (
            not isinstance(requested["remark"], str) or len(requested["remark"]) > 20_000
        ):
            raise ValueError("remark is invalid")
        if requested.get("status", "active") not in {"active", "archived"}:
            raise ValueError("administrator status must be active or archived")

        with self._lock:
            meta = self._read_meta()
            mode_no = meta["next_mode_no"]
            mode_id = str(uuid4())
            while self._mode_path(mode_id).exists():
                mode_id = str(uuid4())
            version_id = str(uuid4())
            now = _utc_now()
            candidate = {
                "id": mode_id,
                "mode_no": mode_no,
                "display_name": requested.get("display_name", ""),
                "description": requested.get("description", ""),
                "category": requested.get("category", ""),
                "tags": [],
                "synonyms": [],
                "sort_order": requested.get("sort_order", mode_no),
                "preset_prompt": requested.get("preset_prompt", ""),
                "required_reference_count": requested.get("required_reference_count", 0),
                "reference_images": requested.get("reference_images", []),
                "max_upload_count": requested.get("max_upload_count", 0),
                "allow_extra_images": requested.get("allow_extra_images", False),
                "extra_image_limit": requested.get("extra_image_limit", 0),
                "special_hint": requested.get("special_hint", ""),
                "remark": requested.get("remark", requested.get("description", "")),
                "status": requested.get("status", "active"),
                "builtin": False,
                "source_id": "",
                "source_updated_at": "",
                "original_version_id": version_id,
                "current_version_id": version_id,
                "draft_version_ids": [],
                "created_at": now,
                "updated_at": now,
            }
            normalized = normalize_mode(candidate)
            version = {
                "id": version_id,
                "mode_id": mode_id,
                "kind": "original",
                "prompt": normalized["preset_prompt"],
                "parent_version_id": None,
                "note": "",
                "created_at": now,
                "source_updated_at": "",
            }
            directories = (self.mode_dir, self.version_dir)
            snapshot = {
                path: path.read_bytes()
                for directory in directories
                for path in directory.glob("*.json")
            }
            next_meta = dict(meta)
            next_meta["next_mode_no"] = mode_no + 1
            try:
                self._write_json(self._version_path(version_id), version)
                self._write_json(self._mode_path(mode_id), normalized)
                self._write_meta(next_meta)
            except Exception:
                self._restore_snapshot(snapshot, directories)
                raise
            return admin_mode(normalized)

    def set_mode_status(self, mode_id: str, status: str) -> dict[str, Any]:
        if status not in MODE_STATUSES:
            raise ValueError(f"unknown mode status: {status}")
        with self._lock:
            mode = self._require_mode(mode_id)
            mode["status"] = status
            mode["updated_at"] = _utc_now()
            if status == "trashed":
                mode["trashed_at"] = mode["updated_at"]
            self._write_json(self._mode_path(mode_id), mode)
            return admin_mode(mode)

    def update_mode(self, mode_id: str, changes: Mapping[str, Any]) -> dict[str, Any]:
        """Atomically save only changed administrator settings.

        Direct prompt edits become the current version immediately, while the
        internal ancestry remains available to startup migration and backups.
        """
        if not isinstance(changes, Mapping):
            raise ValueError("mode changes must be a mapping")
        unexpected = set(changes) - _ADMIN_MUTABLE_MODE_FIELDS
        if unexpected:
            raise ValueError("mode changes contain protected fields")
        if not changes:
            raise ValueError("mode changes are required")
        with self._lock:
            mode = self._require_mode(mode_id)
            requested = deepcopy(dict(changes))
            has_example_caption = "example_caption" in requested
            example_caption = requested.pop("example_caption", None)
            if has_example_caption:
                if not isinstance(example_caption, str) or len(example_caption) > 2_000:
                    raise ValueError("example caption is invalid")
                if not isinstance(mode.get("example"), Mapping):
                    raise ValueError("fixed example does not exist")
            if "status" in requested and requested["status"] not in {"active", "archived"}:
                raise ValueError("administrator status must be active or archived")

            candidate = deepcopy(mode)
            candidate.update(requested)
            if has_example_caption:
                candidate["example"] = deepcopy(dict(mode["example"]))
                candidate["example"]["caption"] = example_caption
            normalized = normalize_mode(candidate)

            changed_fields = {
                field for field in requested
                if normalized.get(field) != mode.get(field)
            }
            example_changed = (
                has_example_caption
                and str(mode["example"].get("caption") or "") != example_caption
            )
            if not changed_fields and not example_changed:
                return admin_mode(mode)

            now = _utc_now()
            normalized["updated_at"] = now
            if "status" in changed_fields and normalized["status"] != "trashed":
                normalized.pop("trashed_at", None)
            if example_changed:
                normalized["example"]["updated_at"] = now

            version = None
            if "preset_prompt" in changed_fields:
                current_version_id = str(mode.get("current_version_id") or "")
                self._validated_version_for_mode(mode, current_version_id)
                version = self._new_version(
                    mode,
                    normalized["preset_prompt"],
                    kind="admin_update",
                    parent_version_id=current_version_id,
                )
                normalized["current_version_id"] = version["id"]

            directories = (self.mode_dir, self.version_dir)
            snapshot = {
                path: path.read_bytes()
                for directory in directories
                for path in directory.glob("*.json")
            }
            try:
                if version is not None:
                    self._write_json(self._version_path(version["id"]), version)
                self._write_json(self._mode_path(mode_id), normalized)
            except Exception:
                self._restore_snapshot(snapshot, directories)
                raise
            return admin_mode(normalized)

    @staticmethod
    def _contains_any_value(value: Any, targets: set[str]) -> bool:
        if isinstance(value, dict):
            return any(ImageGenerationStore._contains_any_value(item, targets) for item in value.values())
        if isinstance(value, list):
            return any(ImageGenerationStore._contains_any_value(item, targets) for item in value)
        return isinstance(value, str) and value in targets

    def delete_mode_permanently(self, mode_id: str) -> None:
        """Permanently delete an unreferenced mode through a reversible quarantine.

        Every persisted record is validated and scanned under the repository
        lock before source files move.  Only an untouched original version is
        owned inseparably by the target mode; all other version history blocks
        deletion.  Metadata counters are never changed.
        """
        with self._lock:
            mode = self._require_mode(mode_id)
            if mode.get("example") is not None:
                raise ValueError("mode has an example")

            def read_mapping(path: Path, label: str) -> dict[str, Any]:
                raw = self._read_record(path, label)
                if not isinstance(raw, dict):
                    raise ValueError(f"cannot verify {label} dependencies")
                return raw

            seen_modes: set[str] = set()
            for path in sorted(self.mode_dir.glob("*.json")):
                if path == self.meta_path:
                    continue
                raw = read_mapping(path, "模式")
                record_id = raw.get("id")
                if (
                    not isinstance(record_id, str)
                    or not record_id
                    or record_id in seen_modes
                    or path != self._mode_path(record_id)
                ):
                    raise ValueError("cannot verify mode dependencies")
                seen_modes.add(record_id)
                try:
                    normalize_mode(raw)
                except ValueError as exc:
                    raise ValueError("cannot verify mode dependencies") from exc

            seen_versions: set[str] = set()
            all_versions: list[tuple[Path, dict[str, Any]]] = []
            for path in sorted(self.version_dir.glob("*.json")):
                raw = read_mapping(path, "提示词版本")
                version_id = raw.get("id")
                if not isinstance(version_id, str) or not version_id or path != self._version_path(version_id):
                    raise ValueError("cannot verify prompt version dependencies")
                if version_id in seen_versions:
                    raise ValueError("cannot verify prompt version dependencies")
                seen_versions.add(version_id)
                try:
                    version = self._load_version(version_id, required=True)
                except (KeyError, ValueError) as exc:
                    raise ValueError("cannot verify prompt version dependencies") from exc
                if version is None:
                    raise ValueError("cannot verify prompt version dependencies")
                all_versions.append((path, version))

            owned_versions = {
                version["id"]: path
                for path, version in all_versions
                if version.get("mode_id") == mode_id
            }
            owned_version_ids = set(owned_versions)
            original_version_id = mode.get("original_version_id")
            if (
                not isinstance(original_version_id, str)
                or mode.get("current_version_id") != original_version_id
                or not isinstance(mode.get("draft_version_ids"), list)
                or mode["draft_version_ids"]
                or set(owned_versions) != {original_version_id}
            ):
                raise ValueError("mode has prompt-version dependencies")
            try:
                self._validated_version_for_mode(mode, original_version_id, allowed_kinds={"original"})
            except ValueError as exc:
                raise ValueError("cannot verify prompt version dependencies") from exc

            # Target mode's own mandatory IDs are allowed above; every other
            # persisted record is an external dependency, including nested
            # example/management fields whose schema belongs to later tasks.
            for path in sorted(self.mode_dir.glob("*.json")):
                if path == self.meta_path:
                    continue
                raw = read_mapping(path, "模式")
                if raw.get("id") != mode_id and self._contains_any_value(raw, {mode_id, *owned_version_ids}):
                    raise ValueError("mode has cross-record dependencies")

            seen_drafts: set[str] = set()
            for path in sorted(self.draft_dir.glob("*.json")):
                raw = read_mapping(path, "工作区草稿")
                draft_mode_id = raw.get("mode_id")
                if (
                    not isinstance(draft_mode_id, str)
                    or not draft_mode_id
                    or draft_mode_id in seen_drafts
                    or path != self._workspace_draft_path(draft_mode_id)
                ):
                    raise ValueError("cannot verify workspace draft dependencies")
                seen_drafts.add(draft_mode_id)
                if draft_mode_id == mode_id or self._contains_any_value(raw, {mode_id, *owned_version_ids}):
                    raise ValueError("mode has workspace draft dependencies")

            seen_tasks: set[str] = set()
            for path in sorted(self.task_dir.glob("*.json")):
                raw = read_mapping(path, "任务")
                task_id = raw.get("id")
                if (
                    not isinstance(task_id, str)
                    or not task_id
                    or task_id in seen_tasks
                    or path != self._task_path(task_id)
                ):
                    raise ValueError("cannot verify task dependencies")
                seen_tasks.add(task_id)
                if self._contains_any_value(raw, {mode_id, *owned_version_ids}):
                    raise ValueError("mode has task or prompt-version dependencies")

            for _path, version in all_versions:
                if version.get("mode_id") != mode_id and self._contains_any_value(version, {mode_id, *owned_version_ids}):
                    raise ValueError("mode has prompt-version dependencies")

            mode_path = self._mode_path(mode_id)
            try:
                records_to_delete = [(mode_path, mode_path.read_bytes())] + [
                    (version_path, version_path.read_bytes()) for version_path in owned_versions.values()
                ]
            except OSError as exc:
                raise ValueError("cannot read permanent-delete records") from exc
            quarantine = self.data_root / "image_generation_delete_quarantine" / uuid4().hex
            try:
                quarantine.mkdir(parents=True, exist_ok=False)
            except OSError as exc:
                raise ValueError("cannot prepare permanent-delete quarantine") from exc
            moves = [
                (source, quarantine / f"{index}-{source.name}", payload)
                for index, (source, payload) in enumerate(records_to_delete)
            ]
            moved: list[tuple[Path, Path, bytes]] = []

            def restore_moved() -> None:
                restore_errors: list[OSError] = []
                for source, isolated, payload in reversed(moved):
                    try:
                        if isolated.exists():
                            os.replace(isolated, source)
                        else:
                            temporary_name: str | None = None
                            try:
                                with tempfile.NamedTemporaryFile(
                                    mode="wb", delete=False, dir=source.parent
                                ) as handle:
                                    temporary_name = handle.name
                                    handle.write(payload)
                                    handle.flush()
                                    os.fsync(handle.fileno())
                                os.replace(temporary_name, source)
                                temporary_name = None
                            finally:
                                if temporary_name:
                                    try:
                                        os.unlink(temporary_name)
                                    except OSError:
                                        pass
                    except OSError as exc:
                        restore_errors.append(exc)
                if restore_errors:
                    raise ValueError("permanent-delete rollback failed") from restore_errors[0]

            try:
                for source, isolated, payload in moves:
                    os.replace(source, isolated)
                    moved.append((source, isolated, payload))
            except OSError as exc:
                try:
                    restore_moved()
                finally:
                    try:
                        quarantine.rmdir()
                    except OSError:
                        pass
                raise ValueError("permanent-delete isolation failed") from exc

            try:
                for _source, isolated, _payload in moved:
                    os.unlink(isolated)
            except OSError as exc:
                try:
                    restore_moved()
                finally:
                    try:
                        quarantine.rmdir()
                    except OSError:
                        pass
                raise ValueError("permanent-delete cleanup failed") from exc
            try:
                quarantine.rmdir()
            except OSError:
                # The sources were all deleted; an empty quarantine directory
                # has no live mode/version record and is safe to clean later.
                pass

    def save_workspace_draft(self, mode_id: str, draft: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(draft, Mapping):
            raise ValueError("workspace draft must be a mapping")
        with self._lock:
            self._require_mode(mode_id)
            value = deepcopy(dict(draft))
            value.update({"mode_id": mode_id, "updated_at": _utc_now()})
            self._write_json(self._workspace_draft_path(mode_id), value)
            return deepcopy(value)

    def load_workspace_draft(self, mode_id: str) -> dict[str, Any] | None:
        value = self._read_record(self._workspace_draft_path(mode_id), "工作区草稿")
        if not isinstance(value, dict) or value.get("mode_id") != mode_id:
            return None
        return deepcopy(value)

    def save_example(self, mode_id: str, example: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(example, Mapping):
            raise ValueError("example must be a mapping")
        with self._lock:
            mode = self._require_mode(mode_id)
            value = deepcopy(dict(example))
            value.setdefault("id", str(uuid4()))
            value["mode_id"] = mode_id
            value["updated_at"] = _utc_now()
            mode["example"] = value
            mode["updated_at"] = value["updated_at"]
            self._write_json(self._mode_path(mode_id), mode)
            return deepcopy(value)

    def clear_example(self, mode_id: str) -> None:
        """Remove only the fixed-example field without touching permanent history."""
        with self._lock:
            mode = self._require_mode(mode_id)
            if mode.get("example") is None:
                raise KeyError("example")
            mode["example"] = None
            mode["updated_at"] = _utc_now()
            self._write_json(self._mode_path(mode_id), mode)

    @staticmethod
    def is_bundled_official_example(mode: Mapping[str, Any]) -> bool:
        """Return true when a case uses only the official static asset root.

        ``builtin`` is a legacy source-sync flag, not the product's
        distribution boundary.  All locally managed modes are official in
        this application, so a static-root case is portable regardless of the
        historical flag value.
        """
        example = mode.get("example")
        if not isinstance(example, Mapping):
            return False
        media_values = [
            item.get("media")
            for item in example.get("input_media") or []
            if isinstance(item, Mapping)
        ]
        media_values.append(example.get("output_media"))
        urls = [
            str(item.get("url") or "")
            for item in media_values
            if isinstance(item, Mapping)
        ]
        return bool(urls) and len(urls) == len(media_values) and all(
            url.startswith("/static/image-generation-examples/") for url in urls
        )

    def export_backup_bundle(self) -> dict[str, Any]:
        """Return local configuration records for portable backup.

        Official cases are part of the configuration distribution.  They are
        included verbatim here; the outer backup layer copies their files into
        the content-addressed media store before import.
        """
        with self._lock:
            modes = self.list_modes(include_admin=True)
            versions: list[dict[str, Any]] = []
            drafts: list[dict[str, Any]] = []
            for mode in modes:
                versions.extend(self.list_prompt_versions(mode["id"]))
                draft = self.load_workspace_draft(mode["id"])
                if draft is not None:
                    drafts.append(draft)
            meta = self._read_meta()
            return {
                "modes": deepcopy(modes),
                "versions": deepcopy(versions),
                "drafts": deepcopy(drafts),
                "official_content_version": str(meta.get("official_content_version") or ""),
                "official_complete": True,
            }

    def snapshot_backup_state(self) -> dict[Path, bytes]:
        """Capture every persisted backup-owned record, including both counters."""
        with self._lock:
            directories = (self.mode_dir, self.version_dir, self.draft_dir, self.task_dir)
            return {
                path: path.read_bytes()
                for directory in directories if directory.exists()
                for path in directory.glob("*.json")
            }

    def restore_backup_state(self, snapshot: Mapping[Path, bytes]) -> None:
        """Restore a prior backup snapshot without relying on normal mutation writes."""
        if not isinstance(snapshot, Mapping) or any(
            not isinstance(path, Path) or not isinstance(payload, bytes)
            for path, payload in snapshot.items()
        ):
            raise ValueError("image-generation backup snapshot is invalid")
        directories = (self.mode_dir, self.version_dir, self.draft_dir, self.task_dir)
        allowed = {Path(os.path.abspath(directory)) for directory in directories}
        normalized: dict[Path, bytes] = {}
        for path, payload in snapshot.items():
            absolute = Path(os.path.abspath(path))
            if absolute.parent not in allowed or absolute.suffix.lower() != ".json":
                raise ValueError("image-generation backup snapshot path is invalid")
            normalized[absolute] = payload
        with self._lock:
            self._restore_snapshot(normalized, directories)

    @staticmethod
    def _validate_backup_media_record(raw: Mapping[str, Any], label: str) -> dict[str, Any]:
        if not isinstance(raw, Mapping):
            raise ValueError(f"{label} is invalid")
        value = deepcopy(dict(raw))
        allowed = {"id", "sha256", "url", "media_type", "size", "width", "height"}
        media_id = value.get("id")
        media_sha = value.get("sha256", media_id)
        media_url = value.get("url")
        media_type = value.get("media_type")
        size = value.get("size")
        width = value.get("width")
        height = value.get("height")
        url_match = _BACKUP_MEDIA_URL.fullmatch(media_url) if isinstance(media_url, str) else None
        if (
            set(value) - allowed
            or not isinstance(media_id, str) or not re.fullmatch(r"[a-f0-9]{64}", media_id)
            or media_sha != media_id
            or url_match is None
            or url_match.group(1) != media_id[:2]
            or url_match.group(2) != media_id
            or media_type != _BACKUP_MEDIA_TYPES[url_match.group(3)]
            or isinstance(size, bool) or not isinstance(size, int) or not 0 < size <= 50 * 1024 * 1024
            or isinstance(width, bool) or not isinstance(width, int) or width < 1
            or isinstance(height, bool) or not isinstance(height, int) or height < 1
        ):
            raise ValueError(f"{label} is invalid")
        return value

    @staticmethod
    def _validate_backup_media_reference(raw: Any, label: str, *, allow_static: bool = False) -> dict[str, Any]:
        """Validate a media record, accepting a release-static URL for official cases."""
        if allow_static and isinstance(raw, Mapping):
            value = deepcopy(dict(raw))
            url = value.get("url")
            optional = {"url", "media_type", "size", "width", "height"}
            if set(value).issubset(optional) and isinstance(url, str) and _STATIC_EXAMPLE_URL.fullmatch(url):
                return value
        return ImageGenerationStore._validate_backup_media_record(raw, label)

    @staticmethod
    def _validate_backup_media_url_mapping(mapping: Mapping[str, str] | None) -> None:
        """CAS URLs are content identities and cannot be remapped to another object."""
        if mapping is None:
            return
        if not isinstance(mapping, Mapping):
            raise ValueError("image-generation backup media URL mapping is invalid")
        for source, target in mapping.items():
            if not isinstance(source, str) or not isinstance(target, str):
                raise ValueError("image-generation backup media URL mapping is invalid")
            if _BACKUP_MEDIA_URL.fullmatch(source) and source != target:
                raise ValueError("image-generation backup media identity mapping is invalid")

    @staticmethod
    def _validate_backup_generation_settings(raw: Any, label: str) -> dict[str, Any]:
        value = deepcopy(dict(raw)) if isinstance(raw, Mapping) else None
        limits = {
            "image_provider_id": 160,
            "image_model": 400,
            "ratio_mode": 20,
            "custom_ratio_width": 3,
            "custom_ratio_height": 3,
            "aspect_ratio": 40,
            "resolution": 40,
            "size": 80,
        }
        if value is None or set(value) - {*limits, "image_count"}:
            raise ValueError(f"{label} is invalid")
        for key, limit in limits.items():
            if key in value and (
                not isinstance(value[key], str) or len(value[key]) > limit
            ):
                raise ValueError(f"{label} is invalid")
        if "image_count" in value:
            count = value["image_count"]
            if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 6:
                raise ValueError(f"{label} is invalid")
        if "ratio_mode" in value and value["ratio_mode"] not in {"fixed", "source", "adaptive", "custom"}:
            raise ValueError(f"{label} is invalid")
        for key in ("custom_ratio_width", "custom_ratio_height"):
            if key in value and value[key] != "" and not re.fullmatch(r"[1-9]\d{0,2}", value[key]):
                raise ValueError(f"{label} is invalid")
        return value

    @staticmethod
    def _validate_backup_version_set(
        mode: Mapping[str, Any], versions: list[Mapping[str, Any]]
    ) -> dict[str, dict[str, Any]]:
        indexed: dict[str, dict[str, Any]] = {}
        old_mode_id = str(mode.get("id") or "")
        for raw in versions:
            if not isinstance(raw, Mapping):
                raise ValueError("backup prompt version is invalid")
            value = deepcopy(dict(raw))
            version_id = value.get("id")
            parent_id = value.get("parent_version_id")
            if (
                not isinstance(version_id, str) or not version_id or version_id in indexed
                or value.get("mode_id") != old_mode_id
                or value.get("kind") not in _VERSION_KINDS
                or not isinstance(value.get("prompt"), str)
                or not isinstance(value.get("note"), str)
                or not isinstance(value.get("created_at"), str)
                or not isinstance(value.get("source_updated_at"), str)
                or (parent_id is not None and (not isinstance(parent_id, str) or not parent_id))
            ):
                raise ValueError("backup prompt version is invalid")
            indexed[version_id] = value
        required_ids = {
            str(mode.get("original_version_id") or ""),
            str(mode.get("current_version_id") or ""),
            *[str(item) for item in mode.get("draft_version_ids") or []],
        }
        if "" in required_ids or not required_ids.issubset(indexed):
            raise ValueError("backup mode references a missing prompt version")
        original = indexed[str(mode.get("original_version_id") or "")]
        if original.get("kind") != "original" or original.get("parent_version_id") is not None:
            raise ValueError("backup original prompt version is invalid")
        for draft_id in mode.get("draft_version_ids") or []:
            if indexed[str(draft_id)].get("kind") != "draft":
                raise ValueError("backup draft prompt version is invalid")
        for start in indexed.values():
            seen: set[str] = set()
            current = start
            while True:
                current_id = current["id"]
                if current_id in seen:
                    raise ValueError("backup prompt version chain contains a cycle")
                seen.add(current_id)
                parent_id = current.get("parent_version_id")
                if parent_id is None:
                    if current.get("kind") != "original":
                        raise ValueError("backup prompt version chain lacks an original")
                    break
                parent = indexed.get(parent_id)
                if parent is None:
                    raise ValueError("backup prompt version parent is missing")
                current = parent
        return indexed

    @staticmethod
    def _validate_backup_workspace_draft(
        mode: Mapping[str, Any], raw: Mapping[str, Any]
    ) -> dict[str, Any]:
        value = deepcopy(dict(raw))
        allowed = {
            "mode_id", "updated_at", "inputs", "user_prompt", "generation_settings",
            "import_missing_media", "import_warning",
        }
        if set(value) - allowed or value.get("mode_id") != mode.get("id"):
            raise ValueError("image-generation backup draft is invalid")
        if not isinstance(value.get("updated_at"), str):
            raise ValueError("image-generation backup draft timestamp is invalid")
        user_prompt = value.get("user_prompt", "")
        if not isinstance(user_prompt, str) or len(user_prompt) > 20_000:
            raise ValueError("image-generation backup draft prompt is invalid")
        value["generation_settings"] = ImageGenerationStore._validate_backup_generation_settings(
            value.get("generation_settings", {}), "image-generation backup draft settings"
        )

        inputs = value.get("inputs", [])
        max_upload_count = min(6, int(mode.get("max_upload_count") or 0))
        if not isinstance(inputs, list) or len(inputs) > max_upload_count:
            raise ValueError("image-generation backup draft inputs are invalid")
        slots = {str(item.get("key") or "") for item in mode.get("reference_images") or []}
        seen_slots: set[str] = set()
        extra_count = 0
        for item in inputs:
            if not isinstance(item, Mapping) or set(item) - {"slot_key", "media"}:
                raise ValueError("image-generation backup draft inputs are invalid")
            slot_key = item.get("slot_key")
            media = item.get("media")
            if (
                not isinstance(slot_key, str) or not slot_key or slot_key in seen_slots
                or not isinstance(media, Mapping)
            ):
                raise ValueError("image-generation backup draft inputs are invalid")
            seen_slots.add(slot_key)
            if slot_key not in slots:
                extra_count += 1
                if not mode.get("allow_extra_images") or extra_count > int(mode.get("extra_image_limit") or 0):
                    raise ValueError("image-generation backup draft inputs are invalid")
            item["media"] = ImageGenerationStore._validate_backup_media_record(
                media, "image-generation backup draft media"
            )
        missing_media = value.get("import_missing_media", [])
        if (
            not isinstance(missing_media, list)
            or any(not isinstance(item, str) for item in missing_media)
            or ("import_warning" in value and not isinstance(value["import_warning"], str))
        ):
            raise ValueError("image-generation backup draft warning is invalid")
        return value

    @staticmethod
    def _validate_backup_example(mode: Mapping[str, Any], raw: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(raw, Mapping):
            raise ValueError("image-generation backup example is invalid")
        value = deepcopy(dict(raw))
        allow_static = bool(mode.get("source_id") or mode.get("builtin"))
        allowed = {
            "id", "mode_id", "updated_at", "input_media", "output_media",
            "sample_user_prompt", "title", "caption", "show_user_prompt", "source",
            "generation_settings", "import_missing_media", "import_warning",
        }
        if set(value) - allowed or value.get("mode_id") != mode.get("id"):
            raise ValueError("image-generation backup example is invalid")
        if (
            not isinstance(value.get("id"), str) or not value["id"] or len(value["id"]) > 160
            or (not isinstance(value.get("updated_at", ""), str) and not allow_static)
        ):
            raise ValueError("image-generation backup example identity is invalid")
        value.setdefault("updated_at", "")
        text_limits = {"sample_user_prompt": 20_000, "title": 400, "caption": 2_000}
        for key, limit in text_limits.items():
            item = value.get(key, "")
            if not isinstance(item, str) or len(item) > limit:
                raise ValueError("image-generation backup example text is invalid")
            value[key] = item
        if not isinstance(value.get("show_user_prompt", False), bool):
            raise ValueError("image-generation backup example visibility is invalid")
        value["show_user_prompt"] = value.get("show_user_prompt", False)

        inputs = value.get("input_media")
        if not isinstance(inputs, list) or len(inputs) > min(6, int(mode.get("max_upload_count") or 0)):
            raise ValueError("image-generation backup example inputs are invalid")
        seen_slots: set[str] = set()
        slot_definitions = {
            str(item.get("key") or ""): item
            for item in mode.get("reference_images") or []
            if isinstance(item, Mapping) and str(item.get("key") or "")
        }
        required_slots = {
            key for key, item in slot_definitions.items() if item.get("required") is True
        }
        extra_count = 0
        clean_inputs: list[dict[str, Any]] = []
        for item in inputs:
            if not isinstance(item, Mapping) or set(item) != {"slot_key", "media"}:
                raise ValueError("image-generation backup example inputs are invalid")
            slot_key = item.get("slot_key")
            if not isinstance(slot_key, str) or not slot_key or slot_key in seen_slots:
                raise ValueError("image-generation backup example inputs are invalid")
            seen_slots.add(slot_key)
            if slot_key not in slot_definitions:
                extra_count += 1
                if (
                    not mode.get("allow_extra_images")
                    or extra_count > int(mode.get("extra_image_limit") or 0)
                ):
                    raise ValueError("image-generation backup example inputs are invalid")
            clean_inputs.append({
                "slot_key": slot_key,
                "media": ImageGenerationStore._validate_backup_media_reference(
                    item.get("media"),
                    "image-generation backup example media",
                    allow_static=allow_static,
                ),
            })
        if not required_slots.issubset(seen_slots):
            raise ValueError("image-generation backup example inputs are invalid")
        value["input_media"] = clean_inputs
        value["output_media"] = ImageGenerationStore._validate_backup_media_reference(
            value.get("output_media"),
            "image-generation backup example media",
            allow_static=allow_static,
        )

        source = value.get("source", {})
        source_limits = {
            "task_id": 160, "candidate_id": 160, "prompt_version_id": 160,
            "aspect_ratio": 40, "resolution": 40, "model": 400,
        }
        if not isinstance(source, Mapping) or set(source) - set(source_limits):
            raise ValueError("image-generation backup example source is invalid")
        clean_source = {}
        for key, limit in source_limits.items():
            if key not in source or source[key] is None:
                continue
            if not isinstance(source[key], str) or len(source[key]) > limit:
                raise ValueError("image-generation backup example source is invalid")
            clean_source[key] = source[key]
        value["source"] = clean_source
        if "generation_settings" in value:
            value["generation_settings"] = ImageGenerationStore._validate_backup_generation_settings(
                value["generation_settings"], "image-generation backup example settings"
            )
        missing_media = value.get("import_missing_media", [])
        if (
            not isinstance(missing_media, list)
            or any(not isinstance(item, str) for item in missing_media)
            or ("import_warning" in value and not isinstance(value["import_warning"], str))
        ):
            raise ValueError("image-generation backup example warning is invalid")
        return value

    def import_backup_bundle(
        self,
        bundle: Mapping[str, Any],
        task_sources: list[Mapping[str, Any]],
        *,
        imported_at: float,
        url_mapping: Mapping[str, str] | None = None,
        provider_id_map: Mapping[str, str] | None = None,
        unavailable_urls: set[str] | None = None,
        task_limit: int = 200,
    ) -> dict[str, Any]:
        """Import configuration and tasks as one rollback-capable local transaction."""
        import backup_transfer as backup_io

        if not isinstance(bundle, Mapping) or not isinstance(task_sources, list):
            raise ValueError("image-generation backup bundle is invalid")
        raw_modes = bundle.get("modes") or []
        raw_versions = bundle.get("versions") or []
        raw_drafts = bundle.get("drafts") or []
        if not all(isinstance(items, list) for items in (raw_modes, raw_versions, raw_drafts)):
            raise ValueError("image-generation backup configuration is invalid")
        raw_modes = [backup_io.prepare_exported_image_generation_config(item) for item in raw_modes]
        raw_versions = [backup_io.prepare_exported_image_generation_config(item) for item in raw_versions]
        raw_drafts = [backup_io.prepare_exported_image_generation_config(item) for item in raw_drafts]
        if len(task_sources) > task_limit:
            raise ValueError("image-generation backup contains too many tasks")
        self._validate_backup_media_url_mapping(url_mapping)

        with self._lock:
            existing_tasks = [
                item for item in self._iter_records(self.task_dir, "任务")
                if item.get("type") == "image-generation"
            ]
            if len(existing_tasks) + len(task_sources) > task_limit:
                remaining = max(0, task_limit - len(existing_tasks))
                raise ValueError(
                    f"图片生成历史最多保留 {task_limit} 组；本次最多还能导入 {remaining} 组"
                )
            normalized_modes: list[dict[str, Any]] = []
            source_mode_ids: set[str] = set()
            for raw in raw_modes:
                mode = normalize_mode(raw)
                if mode["id"] in source_mode_ids:
                    raise ValueError("duplicate image-generation backup mode")
                source_mode_ids.add(mode["id"])
                normalized_modes.append(mode)
            versions_by_mode: dict[str, list[Mapping[str, Any]]] = {}
            for version in raw_versions:
                if not isinstance(version, Mapping) or not isinstance(version.get("mode_id"), str):
                    raise ValueError("image-generation backup version is invalid")
                versions_by_mode.setdefault(version["mode_id"], []).append(version)
            if set(versions_by_mode) - source_mode_ids:
                raise ValueError("image-generation backup version references an unknown mode")
            indexed_versions = {
                mode["id"]: self._validate_backup_version_set(
                    mode, versions_by_mode.get(mode["id"], [])
                )
                for mode in normalized_modes
            }
            for mode in normalized_modes:
                if mode.get("example") is not None:
                    mode["example"] = self._validate_backup_example(mode, mode["example"])
            drafts_by_mode: dict[str, dict[str, Any]] = {}
            modes_by_id = {mode["id"]: mode for mode in normalized_modes}
            for raw in raw_drafts:
                if not isinstance(raw, Mapping):
                    raise ValueError("image-generation backup draft is invalid")
                mode_id = raw.get("mode_id")
                if not isinstance(mode_id, str) or mode_id not in source_mode_ids or mode_id in drafts_by_mode:
                    raise ValueError("image-generation backup draft references an unknown mode")
                drafts_by_mode[mode_id] = self._validate_backup_workspace_draft(
                    modes_by_id[mode_id], raw
                )
            clean_tasks = [backup_io.prepare_exported_image_generation_task(task) for task in task_sources]

            incoming_content_version = str(bundle.get("official_content_version") or "").strip()
            incoming_official_complete = bundle.get("official_complete") is True
            meta = self._read_meta()
            current_content_version = str(meta.get("official_content_version") or "").strip()
            if _version_is_older(incoming_content_version, current_content_version):
                raise ValueError("官方图片生成内容版本不能降级")

            local_modes = [normalize_mode(item) for item in self._iter_records(self.mode_dir, "模式")]
            local_by_source: dict[str, dict[str, Any]] = {}
            legacy_official_by_number: dict[int, dict[str, Any]] = {}
            local_custom_numbers: set[int] = set()
            for local in local_modes:
                identity = self._source_identity_for_mode(local)
                has_explicit_source = isinstance(local.get("source_id"), str) and bool(local.get("source_id").strip())
                if local.get("builtin") is True and not has_explicit_source:
                    identity = None
                if identity:
                    if identity in local_by_source:
                        raise ValueError(f"duplicate local source identity: {identity}")
                else:
                    number = local.get("mode_no")
                    if isinstance(number, int) and not isinstance(number, bool):
                        if local.get("builtin") is True:
                            if number in legacy_official_by_number:
                                raise ValueError(f"duplicate legacy official mode number: {number}")
                            legacy_official_by_number[number] = local
                        else:
                            local_custom_numbers.add(number)
                if identity:
                    local_by_source[identity] = local

            incoming_official_by_id: dict[str, str] = {}
            incoming_official_numbers: set[int] = set()
            for source_mode in normalized_modes:
                identity = self._source_identity_for_mode(source_mode)
                if not identity:
                    continue
                if identity in incoming_official_by_id.values():
                    raise ValueError("官方模式 source_id 重复")
                incoming_official_by_id[source_mode["id"]] = identity
                number = source_mode.get("mode_no")
                if isinstance(number, int) and not isinstance(number, bool):
                    if number in incoming_official_numbers:
                        raise ValueError("官方模式编号重复")
                    incoming_official_numbers.add(number)
                local = local_by_source.get(identity)
                if local is None and isinstance(number, int) and number in legacy_official_by_number:
                    local = legacy_official_by_number[number]
                    local_by_source[identity] = local
                if local is None:
                    if isinstance(number, int) and number in local_custom_numbers:
                        raise ValueError("官方模式编号冲突：不能覆盖本机自定义模式")
                    if self._mode_path(source_mode["id"]).exists():
                        raise ValueError("官方模式身份冲突：不能覆盖本机自定义模式")

            version_id_maps = {
                old_mode_id: {
                    old_version_id: str(uuid4())
                    for old_version_id in versions
                }
                for old_mode_id, versions in indexed_versions.items()
            }
            for source_mode in normalized_modes:
                identity = incoming_official_by_id.get(source_mode["id"])
                local = local_by_source.get(identity) if identity else None
                if local is not None:
                    current_version_id = str(local.get("current_version_id") or "")
                    version_id_maps[source_mode["id"]] = {
                        old_version_id: current_version_id
                        for old_version_id in indexed_versions[source_mode["id"]]
                    }
            task_id_map: dict[str, str] = {}
            candidate_id_maps: dict[str, dict[str, str]] = {}
            for task in clean_tasks:
                old_task_id = str(task.get("id") or "")
                if not old_task_id or old_task_id in task_id_map:
                    raise ValueError("duplicate image-generation backup task")
                task_id_map[old_task_id] = f"image_generation_{uuid4().hex}"
                candidate_map: dict[str, str] = {}
                for candidate in task.get("candidates") or []:
                    old_candidate_id = str(candidate.get("id") or "")
                    if not old_candidate_id or old_candidate_id in candidate_map:
                        raise ValueError("duplicate image-generation backup candidate")
                    candidate_map[old_candidate_id] = f"candidate_{uuid4().hex}"
                candidate_id_maps[old_task_id] = candidate_map

            directories = (self.mode_dir, self.version_dir, self.draft_dir, self.task_dir)
            snapshot = {
                path: path.read_bytes()
                for directory in directories if directory.exists()
                for path in directory.glob("*.json")
            }
            mode_id_map: dict[str, str] = {}
            imported_mode_ids: list[str] = []
            imported_tasks: list[dict[str, Any]] = []
            unavailable = {str(item) for item in (unavailable_urls or set()) if str(item)}
            missing_official_cases = []
            for mode in normalized_modes:
                if not self._source_identity_for_mode(mode):
                    continue
                missing_official_cases.extend(
                    url for url in backup_io.collect_image_generation_media_urls(modes=[mode])
                    if url in unavailable
                )
            if missing_official_cases:
                raise ValueError("官方案例图缺失，图片生成内容包未完整恢复")
            try:
                for source_mode in normalized_modes:
                    old_mode_id = source_mode["id"]
                    identity = incoming_official_by_id.get(old_mode_id)
                    local = local_by_source.get(identity) if identity else None
                    is_official = bool(identity)
                    should_apply = True
                    version_id_map = version_id_maps[old_mode_id]
                    rewritten_mode = backup_io.rewrite_nested_values(source_mode, url_mapping or {})
                    rewritten_mode = backup_io.rewrite_provider_references(
                        rewritten_mode, provider_id_map or {}
                    )
                    source_revision = incoming_content_version or str(
                        source_mode.get("source_updated_at") or ""
                    )

                    if is_official and local is not None:
                        new_mode_id = local["id"]
                        mode_id_map[old_mode_id] = new_mode_id
                        local_revision = str(local.get("source_updated_at") or "")
                        revision_newer = bool(
                            source_revision
                            and (not local_revision or _version_is_older(local_revision, source_revision))
                        )
                        content_changed = any(
                            deepcopy(rewritten_mode.get(field)) != deepcopy(local.get(field))
                            for field in _OFFICIAL_MODE_FIELDS
                            if field in rewritten_mode
                            and (
                                field != "example"
                                or "example" in source_mode
                                or incoming_content_version
                                or incoming_official_complete
                            )
                        )
                        should_apply = revision_newer or content_changed
                        if should_apply:
                            updated = deepcopy(local)
                            for field in _OFFICIAL_MODE_FIELDS:
                                if field == "example":
                                    if (
                                        "example" in rewritten_mode
                                        or incoming_content_version
                                        or incoming_official_complete
                                    ):
                                        updated[field] = deepcopy(rewritten_mode.get(field))
                                elif field in rewritten_mode:
                                    updated[field] = deepcopy(rewritten_mode[field])
                            updated.update({
                                "source_id": identity,
                                "builtin": True,
                                "source_updated_at": source_revision,
                                "updated_at": _utc_now(),
                            })
                            if updated.get("preset_prompt") != local.get("preset_prompt"):
                                current_version_id = str(local.get("current_version_id") or "")
                                version_id = str(uuid4())
                                updated["current_version_id"] = version_id
                                version = {
                                    "id": version_id, "mode_id": new_mode_id, "kind": "source_update",
                                    "prompt": updated["preset_prompt"],
                                    "parent_version_id": current_version_id,
                                    "note": f"backup:{source_revision}", "created_at": _utc_now(),
                                    "source_updated_at": source_revision,
                                }
                                self._write_json(self._version_path(version_id), version)
                            rewritten_mode = updated
                        else:
                            rewritten_mode = deepcopy(local)
                        version_id_map = {
                            old_version_id: str(rewritten_mode.get("current_version_id") or "")
                            for old_version_id in indexed_versions[old_mode_id]
                        }
                    elif is_official:
                        # A new official mode keeps its stable source ID and
                        # package number, but gets fresh local prompt records.
                        new_mode_id = old_mode_id
                        mode_id_map[old_mode_id] = new_mode_id
                        mode_no = source_mode.get("mode_no")
                        if not isinstance(mode_no, int):
                            mode_no = int(meta["next_mode_no"])
                        meta["next_mode_no"] = max(int(meta["next_mode_no"]), mode_no + 1)
                        rewritten_mode.update({
                            "id": new_mode_id,
                            "mode_no": mode_no,
                            "builtin": True,
                            "source_id": identity,
                            "source_updated_at": source_revision,
                            "original_version_id": version_id_map[source_mode["original_version_id"]],
                            "current_version_id": version_id_map[source_mode["current_version_id"]],
                            "draft_version_ids": [
                                version_id_map[item] for item in source_mode.get("draft_version_ids") or []
                            ],
                            "updated_at": _utc_now(),
                        })
                    else:
                        new_mode_id = str(uuid4())
                        mode_id_map[old_mode_id] = new_mode_id
                        rewritten_mode.update({
                            "id": new_mode_id,
                            "mode_no": int(meta["next_mode_no"]),
                            "builtin": False,
                            "source_id": "",
                            "original_version_id": version_id_map[source_mode["original_version_id"]],
                            "current_version_id": version_id_map[source_mode["current_version_id"]],
                            "draft_version_ids": [
                                version_id_map[item] for item in source_mode.get("draft_version_ids") or []
                            ],
                            "updated_at": _utc_now(),
                        })
                        meta["next_mode_no"] += 1
                    if isinstance(rewritten_mode.get("example"), dict):
                        rewritten_mode["example"]["mode_id"] = new_mode_id
                        example_source = rewritten_mode["example"].get("source")
                        if isinstance(example_source, dict):
                            old_task_id = str(example_source.get("task_id") or "")
                            mapped_task_id = task_id_map.get(old_task_id)
                            if mapped_task_id:
                                example_source["task_id"] = mapped_task_id
                                old_candidate_id = str(example_source.get("candidate_id") or "")
                                mapped_candidate_id = candidate_id_maps.get(old_task_id, {}).get(
                                    old_candidate_id
                                )
                                if mapped_candidate_id:
                                    example_source["candidate_id"] = mapped_candidate_id
                                else:
                                    example_source.pop("candidate_id", None)
                            else:
                                example_source.pop("task_id", None)
                                example_source.pop("candidate_id", None)
                            old_prompt_version_id = str(
                                example_source.get("prompt_version_id") or ""
                            )
                            mapped_prompt_version_id = version_id_map.get(
                                old_prompt_version_id
                            )
                            if mapped_prompt_version_id:
                                example_source["prompt_version_id"] = mapped_prompt_version_id
                            else:
                                example_source.pop("prompt_version_id", None)
                        missing = [
                            url for url in backup_io.collect_image_generation_media_urls(
                                modes=[source_mode]
                            ) if url in unavailable
                        ]
                        if missing:
                            rewritten_mode["example"]["import_missing_media"] = list(dict.fromkeys(missing))
                            rewritten_mode["example"]["import_warning"] = (
                                f"导入示范中有 {len(rewritten_mode['example']['import_missing_media'])} 个媒体文件未包含在备份中"
                            )
                    rewritten_mode = normalize_mode(rewritten_mode)
                    if not (is_official and local is not None and not should_apply):
                        if not (is_official and local is not None):
                            for old_version_id, source_version in indexed_versions[old_mode_id].items():
                                version = deepcopy(source_version)
                                version.update({
                                    "id": version_id_map[old_version_id],
                                    "mode_id": new_mode_id,
                                    "parent_version_id": (
                                        version_id_map[version["parent_version_id"]]
                                        if version.get("parent_version_id") else None
                                    ),
                                })
                                self._write_json(self._version_path(version["id"]), version)
                        self._write_json(self._mode_path(new_mode_id), rewritten_mode)
                    draft = drafts_by_mode.get(old_mode_id)
                    if draft is not None and (
                        not (is_official and local is not None)
                        or self.load_workspace_draft(new_mode_id) is None
                    ):
                        rewritten_draft = backup_io.rewrite_nested_values(draft, url_mapping or {})
                        rewritten_draft = backup_io.rewrite_provider_references(
                            rewritten_draft, provider_id_map or {}
                        )
                        rewritten_draft["mode_id"] = new_mode_id
                        rewritten_draft["updated_at"] = _utc_now()
                        missing = [
                            url for url in backup_io.collect_image_generation_media_urls(
                                drafts=[draft]
                            ) if url in unavailable
                        ]
                        if missing:
                            rewritten_draft["import_missing_media"] = list(dict.fromkeys(missing))
                            rewritten_draft["import_warning"] = (
                                f"导入草稿中有 {len(rewritten_draft['import_missing_media'])} 个媒体文件未包含在备份中"
                            )
                        self._write_json(self._workspace_draft_path(new_mode_id), rewritten_draft)
                    imported_mode_ids.append(new_mode_id)

                if incoming_official_complete:
                    for local in local_modes:
                        identity = self._source_identity_for_mode(local)
                        if identity and identity not in set(incoming_official_by_id.values()):
                            archived = deepcopy(local)
                            archived["status"] = "archived"
                            archived["updated_at"] = _utc_now()
                            self._write_json(self._mode_path(archived["id"]), normalize_mode(archived))

                for source_task in clean_tasks:
                    old_task_id = str(source_task.get("id") or "")
                    new_task_id = task_id_map[old_task_id]
                    old_mode_id = str(source_task.get("mode_id") or "")
                    task = backup_io.prepare_imported_image_generation_task(
                        source_task,
                        new_task_id=new_task_id,
                        new_submission_id=str(uuid4()),
                        new_group_no=int(meta["next_task_group_no"]),
                        imported_at=imported_at,
                        url_mapping=url_mapping or {},
                        provider_id_map=provider_id_map or {},
                        mode_id_map=mode_id_map,
                        version_id_map=version_id_maps.get(old_mode_id, {}),
                        candidate_id_map=candidate_id_maps[old_task_id],
                    )
                    meta["next_task_group_no"] += 1
                    missing = [
                        url for url in backup_io.collect_image_generation_media_urls(task=source_task)
                        if url in unavailable
                    ]
                    if missing:
                        task["import_missing_media"] = list(dict.fromkeys(missing))
                        task["import_warning"] = (
                            f"导入记录中有 {len(task['import_missing_media'])} 个媒体文件未包含在备份中"
                        )
                    self._write_json(self._task_path(new_task_id), task)
                    imported_tasks.append(task)
                if incoming_content_version and (
                    not current_content_version
                    or _version_is_older(current_content_version, incoming_content_version)
                ):
                    meta["official_content_version"] = incoming_content_version
                self._write_meta(meta)
            except Exception as exc:
                try:
                    self._restore_snapshot(snapshot, directories)
                except Exception as rollback_exc:
                    raise ValueError("image-generation backup rollback failed") from rollback_exc
                if isinstance(exc, ValueError):
                    raise
                raise ValueError("image-generation backup import failed") from exc
            return {
                "mode_id_map": mode_id_map,
                "mode_ids": imported_mode_ids,
                "tasks": deepcopy(imported_tasks),
            }

    @staticmethod
    def _public_task(value: Any) -> Any:
        if isinstance(value, list):
            return [ImageGenerationStore._public_task(item) for item in value]
        if isinstance(value, str):
            return image_generation_redact_sensitive_text(value)
        if not isinstance(value, dict):
            return deepcopy(value)
        result: dict[str, Any] = {}
        if "upstream_task_id" in value and "status" in value:
            result["recoverable"] = bool(value.get("upstream_task_id")) and value.get("status") in {"unknown", "recovering", "generating"}
        for key, item in value.items():
            lowered = str(key).lower()
            if key in _TASK_PRIVATE_FIELDS or ("prompt" in lowered and key not in {"user_prompt", "prompt_version_id"}):
                continue
            result[key] = ImageGenerationStore._public_task(item)
        return result

    def save_task(self, task: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(task, Mapping) or not isinstance(task.get("id"), str) or not task["id"]:
            raise ValueError("task id is required")
        with self._lock:
            value = deepcopy(dict(task))
            value.setdefault("type", "image-generation")
            value.setdefault("created_at", _utc_now())
            value.setdefault("updated_at", value["created_at"])
            self._write_json(self._task_path(value["id"]), value)
            return deepcopy(value)

    def load_task(self, task_id: str, *, include_admin: bool = False) -> dict[str, Any] | None:
        value = self._read_record(self._task_path(task_id), "任务")
        if not isinstance(value, dict) or value.get("id") != task_id:
            return None
        return deepcopy(value) if include_admin else self._public_task(value)

    def delete_task(self, task_id: str) -> None:
        """Delete exactly one hash-addressed task record under the store lock."""
        with self._lock:
            path = self._task_path(task_id)
            absolute = Path(os.path.abspath(path))
            current = Path(absolute.anchor)
            for component in absolute.parts[1:]:
                current = current / component
                if not os.path.lexists(current):
                    continue
                details = current.lstat()
                attributes = int(getattr(details, "st_file_attributes", 0) or 0)
                if stat.S_ISLNK(details.st_mode) or attributes & 0x0400:
                    raise ValueError("task path cannot contain links or reparse points")
            value = self._read_record(path, "任务", required=True)
            if not isinstance(value, dict) or value.get("id") != task_id:
                raise ValueError("task identity mismatch")
            data_root = self.data_root.resolve(strict=True)
            task_root = self.task_dir.resolve(strict=True)
            resolved = path.resolve(strict=True)
            try:
                task_root.relative_to(data_root)
                resolved.relative_to(task_root)
            except ValueError as exc:
                raise ValueError("task path escapes data root") from exc
            path.unlink()

    def cleanup_paths(self, task_ids: list[str]) -> list[Path]:
        """Resolve canonical task files for one guarded cleanup transaction."""
        paths: list[Path] = []
        with self._lock:
            data_root = self.data_root.resolve(strict=True)
            task_root = self.task_dir.resolve(strict=True)
            task_root.relative_to(data_root)
            for task_id in task_ids:
                path = self._task_path(task_id)
                absolute = Path(os.path.abspath(path))
                current = Path(absolute.anchor)
                for component in absolute.parts[1:]:
                    current = current / component
                    if not os.path.lexists(current):
                        continue
                    details = current.lstat()
                    attributes = int(getattr(details, "st_file_attributes", 0) or 0)
                    if stat.S_ISLNK(details.st_mode) or attributes & 0x0400:
                        raise ValueError("task path cannot contain links or reparse points")
                value = self._read_record(path, "任务", required=True)
                if not isinstance(value, dict) or value.get("id") != task_id:
                    raise ValueError("task identity mismatch")
                resolved = path.resolve(strict=True)
                resolved.relative_to(task_root)
                paths.append(path)
        return paths

    @staticmethod
    def _updated_at_sort_value(value: Any) -> float:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
            except ValueError:
                return 0.0
        return 0.0

    def list_task_summaries(self, mode_id: str = "", status: str = "", offset: int = 0, limit: int = 100) -> list[dict[str, Any]]:
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            raise ValueError("offset must be a non-negative integer")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200:
            raise ValueError("limit must be between 1 and 200")
        summaries: list[dict[str, Any]] = []
        for task in self._iter_records(self.task_dir, "任务"):
            if not isinstance(task.get("id"), str):
                continue
            if mode_id and task.get("mode_id") != mode_id:
                continue
            if status and task.get("status") != status:
                continue
            summary = {field: deepcopy(task[field]) for field in _TASK_SUMMARY_FIELDS if field in task}
            summaries.append(self._public_task(summary))
        summaries.sort(
            key=lambda item: (self._updated_at_sort_value(item.get("updated_at")), str(item.get("id") or "")),
            reverse=True,
        )
        return summaries[offset:offset + limit]

    def allocate_task_group_no(self) -> int:
        with self._lock:
            meta = self._read_meta()
            number = meta["next_task_group_no"]
            meta["next_task_group_no"] = number + 1
            self._write_meta(meta)
            return number
