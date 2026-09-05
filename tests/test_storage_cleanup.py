import asyncio
import copy
import hashlib
import json
import os
import tempfile
import time
import unittest
from contextlib import ExitStack
from io import BytesIO
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from PIL import Image

import main
import storage_cleanup


class StorageCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.data = self.root / "data"
        self.assets = self.root / "assets"
        self.upload = self.assets / "input"
        self.generated = self.root / "custom-generated"
        self.legacy = self.root / "output"
        self.role_library = self.assets / "library"
        self.local_assets = self.assets / "uploads"
        self.canvas_covers = self.assets / "canvas-covers"
        self.prompt_thumbnails = self.assets / "prompt-thumbnails"
        self.static = self.root / "static"
        self.fixed_examples = self.static / "image-generation-examples"
        self.preset_file = self.static / "data" / "image-generation-presets.v1.json"
        for folder in (
            self.data,
            self.data / "canvases",
            self.upload,
            self.generated,
            self.legacy,
            self.role_library,
            self.local_assets,
            self.canvas_covers,
            self.prompt_thumbnails,
            self.fixed_examples,
            self.preset_file.parent,
        ):
            folder.mkdir(parents=True, exist_ok=True)
        self.preset_file.write_text(json.dumps({"modes": []}), encoding="utf-8")
        self.history = self.root / "history.json"
        self.global_config = self.root / "global_config.json"
        self.history.write_text("[]", encoding="utf-8")
        self.global_config.write_text("{}", encoding="utf-8")
        self.media_store = main.ImageGenerationMediaStore(self.root)
        self.stack = ExitStack()
        for name, value in (
            ("DATA_DIR", str(self.data)),
            ("CANVAS_DIR", str(self.data / "canvases")),
            ("ASSETS_DIR", str(self.assets)),
            ("OUTPUT_INPUT_DIR", str(self.upload)),
            ("OUTPUT_OUTPUT_DIR", str(self.generated)),
            ("OUTPUT_DIR", str(self.legacy)),
            ("ASSET_LIBRARY_DIR", str(self.role_library)),
            ("LOCAL_UPLOAD_DIR", str(self.local_assets)),
            ("CANVAS_COVER_DIR", str(self.canvas_covers)),
            ("PROMPT_THUMBNAIL_DIR", str(self.prompt_thumbnails)),
            ("STATIC_DIR", str(self.static)),
            ("HISTORY_FILE", str(self.history)),
            ("GLOBAL_CONFIG_FILE", str(self.global_config)),
            ("MAIN_IMAGE_TASK_DIR", str(self.data / "main-image-tasks")),
            ("DETAIL_PAGE_TASK_DIR", str(self.data / "detail-page-tasks")),
            ("CANVAS_TASKS", {}),
            ("IMAGE_GENERATION_RUNTIME_TASKS", {}),
            ("ONLINE_RUNNINGHUB_OPERATIONS", {}),
            ("QUEUE", []),
            ("ONE_CLICK_CLEANUP_JOB_DIR", str(self.data / "one-click-cleanup-jobs")),
            ("ONE_CLICK_CLEANUP_JOBS", {}),
            ("ONE_CLICK_CLEANUP_COMPLETED_RECEIPTS", {}),
            ("IMAGE_GENERATION_MEDIA_STORE", self.media_store),
        ):
            self.stack.enter_context(patch.object(main, name, value))
        # Unit tests must not place files in the developer's real Windows
        # Recycle Bin. Emulate the shell hand-off inside the temp workspace.
        def move_to_test_recycle_bin(paths):
            for raw in paths:
                Path(raw).unlink()
        self.stack.enter_context(
            patch.object(
                storage_cleanup,
                "move_paths_to_recycle_bin",
                side_effect=move_to_test_recycle_bin,
            )
        )
        main.STORAGE_CLEANUP_CONFIRMATIONS.clear()
        main.ONE_CLICK_CLEANUP_REVIEW_CONFIRMATIONS.clear()
        main.ONE_CLICK_CLEANUP_JOBS.clear()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        main.STORAGE_CLEANUP_CONFIRMATIONS.clear()
        main.ONE_CLICK_CLEANUP_REVIEW_CONFIRMATIONS.clear()
        main.ONE_CLICK_CLEANUP_JOBS.clear()
        self.stack.close()
        self.temp_dir.cleanup()

    @staticmethod
    def write_image(path: Path, *, old=True):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"not-a-real-image-but-a-supported-file")
        if old:
            stamp = time.time() - 3 * 24 * 60 * 60
            os.utime(path, (stamp, stamp))
        return path

    def preview(self, kind):
        response = self.client.post("/api/storage-cleanup/preview", json={"kind": kind})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    @staticmethod
    def write_fixed_example(folder: Path, content: bytes):
        media_id = hashlib.sha256(content).hexdigest()
        path = folder / f"{media_id}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    @staticmethod
    def png_bytes(color=(32, 128, 224, 255)):
        buffer = BytesIO()
        Image.new("RGBA", (8, 8), color).save(buffer, format="PNG")
        return buffer.getvalue()

    def confirm(self, confirmation_id):
        return self.client.post(
            "/api/storage-cleanup/confirm",
            json={"confirmation_id": confirmation_id},
        )

    def test_generated_cleanup_protects_references_examples_and_other_libraries_without_age_filter(self):
        referenced = self.write_image(self.generated / "task-owned.png")
        example = self.write_image(self.generated / "example-owned.png")
        orphan = self.write_image(self.generated / "old-orphan.png")
        legacy_orphan = self.write_image(self.legacy / "legacy-orphan.png")
        recent = self.write_image(self.generated / "recent.png", old=False)
        role_library = self.write_image(self.assets / "library" / "role.png")
        local_asset = self.write_image(self.assets / "uploads" / "saved.png")
        (self.data / "records.json").write_text(
            json.dumps(
                {
                    "task": {"output": "/api/storage-files/generated/task-owned.png"},
                    "mode": {"example": {"output_media": {"url": "/api/storage-files/generated/example-owned.png"}}},
                }
            ),
            encoding="utf-8",
        )

        preview = self.preview("generated")
        self.assertTrue(preview["has_targets"])
        self.assertIn("cutoff_at", preview)
        response = self.confirm(preview["confirmation_id"])
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["destination"], "windows-recycle-bin")
        self.assertFalse(response.json()["moved_to_recycle_bin"])
        self.assertEqual(response.json()["queued"], 3)

        completed = main.run_one_click_cleanup_job_once(response.json()["cleanup_job_id"])
        self.assertEqual(completed["status"], "succeeded")

        self.assertTrue(referenced.exists())
        self.assertTrue(example.exists())
        self.assertFalse(recent.exists())
        self.assertTrue(role_library.exists())
        self.assertTrue(local_asset.exists())
        self.assertFalse(orphan.exists())
        self.assertFalse(legacy_orphan.exists())

    def test_temporary_upload_cleanup_protects_history_and_runtime_references(self):
        history_owned = self.write_image(self.upload / "history.png")
        runtime_owned = self.write_image(self.upload / "runtime.png")
        queued_owned = self.write_image(self.upload / "queued.png")
        runninghub_owned = self.write_image(self.upload / "runninghub.png")
        orphan = self.write_image(self.upload / "unused.png")
        self.history.write_text(
            json.dumps([{"input": "/assets/input/history.png"}]),
            encoding="utf-8",
        )
        main.CANVAS_TASKS["running"] = {
            "status": "generating",
            "source": "/api/storage-files/upload/runtime.png",
        }
        main.QUEUE.append({"source": "/api/storage-files/upload/queued.png"})
        main.ONLINE_RUNNINGHUB_OPERATIONS["active"] = {
            "source": "/api/storage-files/upload/runninghub.png",
        }

        preview = self.preview("temporary-upload")
        response = self.confirm(preview["confirmation_id"])
        self.assertEqual(response.status_code, 202, response.text)
        completed = main.run_one_click_cleanup_job_once(response.json()["cleanup_job_id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertTrue(history_owned.exists())
        self.assertTrue(runtime_owned.exists())
        self.assertTrue(queued_owned.exists())
        self.assertTrue(runninghub_owned.exists())
        self.assertFalse(orphan.exists())

    def test_unified_cleanup_previews_both_roots_with_size_and_reference_summary(self):
        protected = self.write_image(self.generated / "online-protected.png")
        generated_orphan = self.write_image(self.generated / "generated-orphan.png")
        legacy_orphan = self.write_image(self.legacy / "legacy-orphan.png")
        upload_orphan = self.write_image(self.upload / "upload-orphan.png")
        self.history.write_text(
            json.dumps([{
                "type": "online",
                "source_type": "online-image",
                "timestamp": 123.0,
                "images": ["/api/storage-files/generated/online-protected.png"],
            }]),
            encoding="utf-8",
        )

        preview = self.preview("all")

        self.assertTrue(preview["has_targets"])
        summary = preview["summary"]
        self.assertEqual(summary["total_files"], 4)
        self.assertEqual(summary["total_bytes"], sum(
            path.stat().st_size
            for path in (protected, generated_orphan, legacy_orphan, upload_orphan)
        ))
        self.assertEqual(summary["candidate_files"], 3)
        self.assertEqual(summary["candidate_bytes"], sum(
            path.stat().st_size
            for path in (generated_orphan, legacy_orphan, upload_orphan)
        ))
        self.assertEqual(summary["protected_files"], 1)
        self.assertEqual(summary["protected_by"]["online_history"], 1)
        self.assertEqual(summary["breakdown"]["generated"]["total_files"], 3)
        self.assertEqual(summary["breakdown"]["temporary-upload"]["total_files"], 1)

        response = self.confirm(preview["confirmation_id"])
        self.assertEqual(response.status_code, 202, response.text)
        body = response.json()
        self.assertEqual(body["queued"], 3)
        self.assertEqual(body["queued_bytes"], summary["candidate_bytes"])
        self.assertTrue(protected.exists())
        self.assertTrue(generated_orphan.exists())
        completed = main.run_one_click_cleanup_job_once(body["cleanup_job_id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertFalse(generated_orphan.exists())
        self.assertFalse(legacy_orphan.exists())
        self.assertFalse(upload_orphan.exists())

    def test_unified_cleanup_empty_result_still_reports_protected_storage(self):
        protected = self.write_image(self.generated / "online-protected.png")
        self.history.write_text(
            json.dumps([{
                "type": "online",
                "source_type": "online-image",
                "timestamp": 456.0,
                "images": ["/api/storage-files/generated/online-protected.png"],
            }]),
            encoding="utf-8",
        )

        preview = self.preview("all")

        self.assertFalse(preview["has_targets"])
        self.assertEqual(preview["summary"]["total_files"], 1)
        self.assertEqual(preview["summary"]["total_bytes"], protected.stat().st_size)
        self.assertEqual(preview["summary"]["candidate_files"], 0)
        self.assertEqual(preview["summary"]["candidate_bytes"], 0)
        self.assertEqual(preview["summary"]["protected_files"], 1)
        self.assertEqual(preview["summary"]["protected_by"]["online_history"], 1)

    def test_unified_cleanup_includes_only_unreferenced_fixed_example_files(self):
        mode_folder = self.fixed_examples / "builtin-split-layout"
        current_input = self.write_fixed_example(mode_folder, b"current-input")
        current_output = self.write_fixed_example(mode_folder, b"current-output")
        old_example = self.write_fixed_example(mode_folder, b"old-example")
        mode_dir = self.data / "image_generation_modes"
        mode_dir.mkdir(parents=True, exist_ok=True)
        (mode_dir / "mode.json").write_text(json.dumps({
            "id": "builtin-split-layout",
            "status": "active",
            "example": {
                "input_media": [{
                    "media": {
                        "url": f"/static/image-generation-examples/builtin-split-layout/{current_input.name}",
                    },
                }],
            },
        }), encoding="utf-8")
        self.preset_file.write_text(json.dumps({
            "modes": [{
                "id": "builtin-split-layout",
                "example": {
                    "output_media": {
                        "url": f"/static/image-generation-examples/builtin-split-layout/{current_output.name}",
                    },
                },
            }],
        }), encoding="utf-8")

        preview = self.preview("all")

        summary = preview["summary"]
        self.assertTrue(preview["has_targets"])
        self.assertEqual(summary["breakdown"]["fixed-example"]["total_files"], 3)
        self.assertEqual(summary["breakdown"]["fixed-example"]["candidate_files"], 1)
        self.assertEqual(summary["candidate_by"]["fixed_example_orphan"], 1)
        self.assertEqual(summary["candidate_files"], 1)
        self.assertEqual(preview["samples"], [{
            "name": old_example.name,
            "kind": "fixed-example",
            "size": old_example.stat().st_size,
            "candidate_source": "fixed_example_orphan",
        }])

        response = self.confirm(preview["confirmation_id"])
        self.assertEqual(response.status_code, 202, response.text)
        body = response.json()
        self.assertEqual(body["queued"], 1)
        job = main.one_click_cleanup_job_snapshot(body["cleanup_job_id"])
        self.assertEqual(job["task_type"], "storage-cleanup")
        self.assertEqual(job["fixed_example_paths"], [str(old_example.absolute())])
        completed = main.run_one_click_cleanup_job_once(body["cleanup_job_id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertTrue(current_input.exists())
        self.assertTrue(current_output.exists())
        self.assertFalse(old_example.exists())
        self.assertTrue(self.fixed_examples.exists())

    def test_fixed_example_scan_fails_closed_for_hash_mismatch_or_broken_sources(self):
        mode_folder = self.fixed_examples / "mode"
        mode_folder.mkdir(parents=True, exist_ok=True)
        (mode_folder / ("0" * 64 + ".png")).write_bytes(b"different-content")

        response = self.client.post("/api/storage-cleanup/preview", json={"kind": "all"})

        self.assertEqual(response.status_code, 409, response.text)

        for path in mode_folder.iterdir():
            path.unlink()
        self.preset_file.write_text("{broken", encoding="utf-8")
        response = self.client.post("/api/storage-cleanup/preview", json={"kind": "all"})
        self.assertEqual(response.status_code, 409, response.text)

    def test_fixed_example_new_reference_after_preview_is_preserved(self):
        mode_folder = self.fixed_examples / "mode"
        orphan = self.write_fixed_example(mode_folder, b"becomes-referenced")
        preview = self.preview("all")
        self.preset_file.write_text(json.dumps({
            "modes": [{
                "example": {
                    "output_media": {
                        "url": f"/static/image-generation-examples/mode/{orphan.name}",
                    },
                },
            }],
        }), encoding="utf-8")

        response = self.confirm(preview["confirmation_id"])

        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["queued"], 0)
        self.assertEqual(response.json()["cleanup_status"], "skipped")
        self.assertTrue(orphan.exists())

    def test_fixed_example_recycle_failure_rolls_back_and_job_retries(self):
        orphan = self.write_fixed_example(self.fixed_examples / "mode", b"retry-example")
        preview = self.preview("all")
        response = self.confirm(preview["confirmation_id"])
        self.assertEqual(response.status_code, 202, response.text)
        job_id = response.json()["cleanup_job_id"]

        with patch.object(
            storage_cleanup,
            "move_paths_to_recycle_bin",
            side_effect=OSError("recycle bin unavailable"),
        ):
            failed = main.run_one_click_cleanup_job_once(job_id)
        self.assertEqual(failed["status"], "failed")
        self.assertTrue(orphan.exists())

        succeeded = main.run_one_click_cleanup_job_once(job_id)
        self.assertEqual(succeeded["status"], "succeeded")
        self.assertFalse(orphan.exists())

    def test_fixed_example_new_reference_after_staging_rolls_back(self):
        orphan = self.write_fixed_example(self.fixed_examples / "mode", b"stage-race")
        preview = self.preview("all")
        response = self.confirm(preview["confirmation_id"])
        self.assertEqual(response.status_code, 202, response.text)
        job_id = response.json()["cleanup_job_id"]
        original_stage = storage_cleanup.StorageCleanupTransaction.stage

        def stage_then_reference(transaction, paths):
            original_stage(transaction, paths)
            self.preset_file.write_text(json.dumps({
                "modes": [{
                    "example": {
                        "output_media": {
                            "url": f"/static/image-generation-examples/mode/{orphan.name}",
                        },
                    },
                }],
            }), encoding="utf-8")

        with patch.object(
            storage_cleanup.StorageCleanupTransaction,
            "stage",
            new=stage_then_reference,
        ):
            failed = main.run_one_click_cleanup_job_once(job_id)

        self.assertEqual(failed["status"], "failed")
        self.assertIn("新的固定案例引用", failed["error"])
        self.assertTrue(orphan.exists())

    def test_running_fixed_example_cleanup_job_recovers_after_restart(self):
        orphan = self.write_fixed_example(self.fixed_examples / "mode", b"restart-example")
        job = main.storage_cleanup_create_job([], [orphan])
        job_id = job["job_id"]
        main.one_click_cleanup_update_job(job_id, status="running")
        main.ONE_CLICK_CLEANUP_JOBS.clear()

        main.load_one_click_cleanup_jobs()

        restored = main.one_click_cleanup_job_snapshot(job_id)
        self.assertEqual(restored["status"], "queued")
        self.assertEqual(restored["fixed_example_paths"], [str(orphan.absolute())])
        completed = main.run_one_click_cleanup_job_once(job_id)
        self.assertEqual(completed["status"], "succeeded")
        self.assertFalse(orphan.exists())

    def test_unmarked_online_history_outputs_and_uploads_are_migration_candidates(self):
        output = self.write_image(self.generated / "legacy-result.png")
        upload = self.write_image(self.upload / "legacy-upload.png")
        record = {
            "type": "online",
            "timestamp": 500.0,
            "images": ["/api/storage-files/generated/legacy-result.png"],
            "params": {
                "reference_images": [
                    {"url": "/api/storage-files/upload/legacy-upload.png", "role": "reference"},
                ],
            },
        }
        self.history.write_text(json.dumps([record]), encoding="utf-8")

        preview = self.preview("all")

        self.assertTrue(preview["has_targets"])
        summary = preview["summary"]
        self.assertEqual(summary["candidate_files"], 2)
        self.assertEqual(summary["candidate_by"]["legacy_unmarked_history"], 2)
        self.assertEqual(summary["legacy_unmarked_history_records"], 1)
        self.assertEqual(summary["breakdown"]["generated"]["legacy_history_candidate_files"], 1)
        self.assertEqual(summary["breakdown"]["temporary-upload"]["legacy_history_candidate_files"], 1)
        self.assertEqual({item["name"] for item in preview["samples"]}, {output.name, upload.name})

        response = self.confirm(preview["confirmation_id"])
        self.assertEqual(response.status_code, 202, response.text)
        body = response.json()
        self.assertEqual(body["queued"], 2)
        self.assertEqual(body["history_deleted"], 1)
        self.assertEqual(json.loads(self.history.read_text(encoding="utf-8")), [])
        self.assertTrue(output.exists())
        self.assertTrue(upload.exists())

        completed = main.run_one_click_cleanup_job_once(body["cleanup_job_id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertEqual(completed["media_deleted"], 2)
        self.assertFalse(output.exists())
        self.assertFalse(upload.exists())

    def test_migration_cleanup_trims_unused_upload_but_keeps_strong_output_row(self):
        output = self.write_image(self.generated / "canvas-owned.png")
        upload = self.write_image(self.upload / "old-reference.png")
        (self.data / "canvas.json").write_text(
            json.dumps({"image": "/api/storage-files/generated/canvas-owned.png"}),
            encoding="utf-8",
        )
        self.history.write_text(
            json.dumps([{
                "type": "online",
                "timestamp": 501.0,
                "images": ["/api/storage-files/generated/canvas-owned.png"],
                "params": {
                    "reference_images": [
                        {"url": "/api/storage-files/upload/old-reference.png", "role": "reference"},
                    ],
                },
            }]),
            encoding="utf-8",
        )

        preview = self.preview("all")
        self.assertEqual(preview["summary"]["candidate_files"], 1)
        self.assertEqual(preview["summary"]["candidate_by"]["legacy_unmarked_history"], 1)

        response = self.confirm(preview["confirmation_id"])
        self.assertEqual(response.status_code, 202, response.text)
        body = response.json()
        self.assertEqual(body["history_deleted"], 0)
        self.assertEqual(body["history_updated"], 1)
        remaining = json.loads(self.history.read_text(encoding="utf-8"))
        self.assertEqual(remaining[0]["images"], ["/api/storage-files/generated/canvas-owned.png"])
        self.assertEqual(remaining[0]["params"]["reference_images"], [])

        completed = main.run_one_click_cleanup_job_once(body["cleanup_job_id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertTrue(output.exists())
        self.assertFalse(upload.exists())

    def test_changed_legacy_history_row_is_skipped_after_preview(self):
        output = self.write_image(self.generated / "changed-history.png")
        record = {
            "type": "online",
            "timestamp": 502.0,
            "images": ["/api/storage-files/generated/changed-history.png"],
        }
        self.history.write_text(json.dumps([record]), encoding="utf-8")
        preview = self.preview("generated")

        record["prompt"] = "预览后发生变化"
        self.history.write_text(json.dumps([record]), encoding="utf-8")
        response = self.confirm(preview["confirmation_id"])

        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["queued"], 0)
        self.assertEqual(response.json()["cleanup_status"], "skipped")
        self.assertTrue(output.exists())
        self.assertEqual(json.loads(self.history.read_text(encoding="utf-8")), [record])

    def test_new_online_image_history_is_written_with_an_explicit_source(self):
        payload = object()
        mocked = AsyncMock(return_value={"images": []})
        with patch.object(main, "build_online_image_result", mocked):
            result = asyncio.run(main.online_image(payload))
        self.assertEqual(result, {"images": []})
        mocked.assert_awaited_once_with(
            payload,
            history_metadata={"source_type": "online-image"},
        )

    def test_legacy_history_delete_queues_recycle_bin_cleanup_instead_of_unlinking(self):
        output = self.write_image(self.generated / "legacy-online.png", old=False)
        record = {
            "type": "online",
            "timestamp": 789.123,
            "images": ["/api/storage-files/generated/legacy-online.png"],
            "params": {"reference_images": []},
        }
        self.history.write_text(json.dumps([record]), encoding="utf-8")

        response = self.client.post("/api/history/delete", json={"timestamp": record["timestamp"]})

        self.assertEqual(response.status_code, 202, response.text)
        body = response.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["history_deleted"], 1)
        self.assertEqual(body["cleanup_status"], "queued")
        self.assertTrue(body["cleanup_job_id"])
        self.assertEqual(json.loads(self.history.read_text(encoding="utf-8")), [])
        self.assertTrue(output.exists())

        completed = main.run_one_click_cleanup_job_once(body["cleanup_job_id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertFalse(output.exists())

    def test_legacy_history_delete_preserves_output_still_referenced_by_another_row(self):
        shared = self.write_image(self.generated / "shared-online.png", old=False)
        first = {"type": "online", "timestamp": 1001.0, "images": ["/api/storage-files/generated/shared-online.png"]}
        second = {"type": "online", "timestamp": 1002.0, "images": ["/api/storage-files/generated/shared-online.png"]}
        self.history.write_text(json.dumps([first, second]), encoding="utf-8")

        response = self.client.post("/api/history/delete", json={"timestamp": first["timestamp"]})
        self.assertEqual(response.status_code, 202, response.text)
        completed = main.run_one_click_cleanup_job_once(response.json()["cleanup_job_id"])

        self.assertEqual(completed["status"], "succeeded")
        self.assertEqual(completed["media_deleted"], 0)
        self.assertEqual(completed["media_preserved"], 1)
        self.assertTrue(shared.exists())
        remaining = json.loads(self.history.read_text(encoding="utf-8"))
        self.assertEqual([item["timestamp"] for item in remaining], [second["timestamp"]])

    def test_deleted_main_image_legacy_history_releases_its_upload_references(self):
        active_upload = self.write_image(self.upload / "active-main.png")
        deleted_upload = self.write_image(self.upload / "deleted-main.png")
        self.history.write_text(
            json.dumps([
                {
                    "prompt": "1:1方形电商连续主图第1屏，使用图1产品图",
                    "images": ["/assets/output/online-deleted.png"],
                    "type": "online",
                    "params": {"reference_images": [{"url": "/assets/input/deleted-main.png", "role": "product"}]},
                },
                {
                    "prompt": "普通日常生图",
                    "images": ["/assets/output/online-ordinary.png"],
                    "type": "online",
                    "params": {"reference_images": [{"url": "/assets/input/active-main.png"}]},
                },
            ], ensure_ascii=False),
            encoding="utf-8",
        )
        task_dir = self.root / "main-image-tasks"
        task_dir.mkdir()
        (task_dir / "main_image_active.json").write_text(
            json.dumps({
                "id": "main_image_active",
                "type": "main-image",
                "settings": {"product_images": ["/assets/input/active-main.png"], "reference_images": []},
            }),
            encoding="utf-8",
        )
        with patch.object(main, "MAIN_IMAGE_TASK_DIR", str(task_dir)):
            preview = self.preview("temporary-upload")
            keys = {item["key"] for item in main.storage_cleanup_candidate_snapshot("temporary-upload", time.time())}
        self.assertIn(main.storage_cleanup_path_key(deleted_upload), keys)
        self.assertNotIn(main.storage_cleanup_path_key(active_upload), keys)
        self.assertTrue(preview["has_targets"])

    def test_deleting_main_image_group_unlinks_history_inputs_but_keeps_result_row(self):
        upload = "/assets/input/main-owned.png"
        output = "/assets/output/main-owned.png"
        self.history.write_text(
            json.dumps([{
                "source_type": "main-image",
                "source_task_id": "main_image_deleted",
                "source_screen_no": 1,
                "images": [output],
                "params": {"reference_images": [{"url": upload}]},
            }]),
            encoding="utf-8",
        )
        task = {
            "id": "main_image_deleted",
            "type": "main-image",
            "settings": {"product_images": [upload], "reference_images": []},
            "screens": [{"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": output}]}],
        }
        with patch.object(main, "HISTORY_FILE", str(self.history)):
            changed = main.unlink_main_image_history(task)
        self.assertEqual(changed, 1)
        record = json.loads(self.history.read_text(encoding="utf-8"))[0]
        self.assertEqual(record["images"], [output])
        self.assertEqual(record["params"]["reference_images"], [])

    def test_deleting_main_image_group_removes_owned_media_and_preserves_shared_upload(self):
        shared = self.write_image(self.upload / "shared.png", old=False)
        a1_only = self.write_image(self.upload / "a1-only.png", old=False)
        a1_output = self.write_image(self.generated / "a1-output.png", old=False)
        a2_output = self.write_image(self.generated / "a2-output.png", old=False)
        shared_url = "/api/storage-files/upload/shared.png"
        a1_only_url = "/api/storage-files/upload/a1-only.png"
        a1_output_url = "/api/storage-files/generated/a1-output.png"
        a2_output_url = "/api/storage-files/generated/a2-output.png"
        a1 = {
            "id": "main_image_delete_a1",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [shared_url, a1_only_url], "reference_images": []},
            "screens": [{"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": a1_output_url, "result": {"images": [a1_output_url]}}]}],
        }
        a2 = {
            "id": "main_image_delete_a2",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [shared_url], "reference_images": []},
            "screens": [{"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": a2_output_url, "result": {"images": [a2_output_url]}}]}],
        }
        main.CANVAS_TASKS[a1["id"]] = copy.deepcopy(a1)
        main.CANVAS_TASKS[a2["id"]] = copy.deepcopy(a2)
        main.main_image_persist_task(a1)
        main.main_image_persist_task(a2)
        self.history.write_text(json.dumps([
            {"source_type": "main-image", "source_task_id": a1["id"], "images": [a1_output_url], "params": {"reference_images": [{"url": shared_url}, {"url": a1_only_url}]}},
            {"source_type": "main-image", "source_task_id": a2["id"], "images": [a2_output_url], "params": {"reference_images": [{"url": shared_url}]}},
        ], ensure_ascii=False), encoding="utf-8")

        response = self.client.delete(f"/api/main-image-tasks/{a1['id']}")

        self.assertEqual(response.status_code, 202, response.text)
        body = response.json()
        self.assertTrue(body["deleted"])
        self.assertEqual(body["cleanup_status"], "queued")
        self.assertTrue(body["cleanup_job_id"])
        cleanup_status = self.client.get(f"/api/storage-cleanup/jobs/{body['cleanup_job_id']}")
        self.assertEqual(cleanup_status.status_code, 200, cleanup_status.text)
        self.assertEqual(cleanup_status.json()["status"], "queued")
        self.assertFalse((self.data / "main-image-tasks" / f"{a1['id']}.json").exists())
        self.assertTrue((self.data / "main-image-tasks" / f"{a2['id']}.json").exists())
        self.assertNotIn(a1["id"], main.CANVAS_TASKS)
        self.assertIn(a2["id"], main.CANVAS_TASKS)
        self.assertTrue(a1_output.exists())
        self.assertTrue(a1_only.exists())
        self.assertTrue(a2_output.exists())
        self.assertTrue(shared.exists())
        history = json.loads(self.history.read_text(encoding="utf-8"))
        self.assertEqual([item.get("source_task_id") for item in history], [a2["id"]])

        processed = main.run_one_click_cleanup_job_once(body["cleanup_job_id"])
        self.assertEqual(processed["status"], "succeeded")
        completion_receipt = self.client.get(
            f"/api/storage-cleanup/jobs/{body['cleanup_job_id']}"
        )
        self.assertEqual(completion_receipt.status_code, 200, completion_receipt.text)
        self.assertEqual(completion_receipt.json()["status"], "succeeded")
        self.assertFalse(
            (self.data / "one-click-cleanup-jobs" / f"{body['cleanup_job_id']}.json").exists()
        )
        self.assertFalse(a1_output.exists())
        self.assertFalse(a1_only.exists())
        self.assertTrue(a2_output.exists())
        self.assertTrue(shared.exists())

    def test_deleting_detail_page_group_removes_owned_media_and_preserves_shared_upload(self):
        shared = self.write_image(self.upload / "detail-shared.png", old=False)
        detail_only = self.write_image(self.upload / "detail-only.png", old=False)
        detail_output = self.write_image(self.generated / "detail-output.png", old=False)
        other_output = self.write_image(self.generated / "detail-other-output.png", old=False)
        shared_url = "/api/storage-files/upload/detail-shared.png"
        detail_only_url = "/api/storage-files/upload/detail-only.png"
        detail_output_url = "/api/storage-files/generated/detail-output.png"
        other_output_url = "/api/storage-files/generated/detail-other-output.png"
        deleted = {
            "id": "detail_page_delete_a1",
            "type": "detail-page",
            "status": "succeeded",
            "settings": {"product_images": [shared_url, detail_only_url], "reference_images": []},
            "screens": [{"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": detail_output_url, "result": {"images": [detail_output_url]}}]}],
        }
        retained = {
            "id": "detail_page_delete_a2",
            "type": "detail-page",
            "status": "succeeded",
            "settings": {"product_images": [shared_url], "reference_images": []},
            "screens": [{"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": other_output_url, "result": {"images": [other_output_url]}}]}],
        }
        main.CANVAS_TASKS[deleted["id"]] = copy.deepcopy(deleted)
        main.CANVAS_TASKS[retained["id"]] = copy.deepcopy(retained)
        main.detail_page_persist_task(deleted)
        main.detail_page_persist_task(retained)
        self.history.write_text(json.dumps([
            {"source_type": "detail-page", "source_task_id": deleted["id"], "images": [detail_output_url], "params": {"reference_images": [{"url": shared_url}, {"url": detail_only_url}]}},
            {"source_type": "detail-page", "source_task_id": retained["id"], "images": [other_output_url], "params": {"reference_images": [{"url": shared_url}]}},
        ], ensure_ascii=False), encoding="utf-8")

        response = self.client.delete(f"/api/detail-page-tasks/{deleted['id']}")

        self.assertEqual(response.status_code, 202, response.text)
        body = response.json()
        self.assertTrue(body["deleted"])
        self.assertEqual(body["cleanup_status"], "queued")
        self.assertFalse((self.data / "detail-page-tasks" / f"{deleted['id']}.json").exists())
        self.assertTrue((self.data / "detail-page-tasks" / f"{retained['id']}.json").exists())
        self.assertNotIn(deleted["id"], main.CANVAS_TASKS)
        self.assertIn(retained["id"], main.CANVAS_TASKS)
        self.assertTrue(detail_output.exists())
        self.assertTrue(detail_only.exists())
        self.assertTrue(other_output.exists())
        self.assertTrue(shared.exists())
        history = json.loads(self.history.read_text(encoding="utf-8"))
        self.assertEqual([item.get("source_task_id") for item in history], [retained["id"]])

        processed = main.run_one_click_cleanup_job_once(body["cleanup_job_id"])
        self.assertEqual(processed["status"], "succeeded")
        self.assertFalse(detail_output.exists())
        self.assertFalse(detail_only.exists())
        self.assertTrue(other_output.exists())
        self.assertTrue(shared.exists())

    def test_group_upload_cleanup_checks_only_other_groups_of_the_same_module(self):
        main_owned = self.write_image(self.upload / "main-owned-cross-module.png", old=False)
        detail_owned = self.write_image(self.upload / "detail-owned-cross-module.png", old=False)
        main_output = self.write_image(self.generated / "main-cross-module-output.png", old=False)
        detail_output = self.write_image(self.generated / "detail-cross-module-output.png", old=False)
        main_owned_url = "/api/storage-files/upload/main-owned-cross-module.png"
        detail_owned_url = "/api/storage-files/upload/detail-owned-cross-module.png"
        main_output_url = "/api/storage-files/generated/main-cross-module-output.png"
        detail_output_url = "/api/storage-files/generated/detail-cross-module-output.png"
        deleted_main = {
            "id": "main_image_cross_module_delete",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [main_owned_url], "reference_images": []},
            "screens": [{"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": main_output_url}]}],
        }
        retained_main = {
            "id": "main_image_cross_module_keep",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [detail_owned_url], "reference_images": []},
            "screens": [],
        }
        deleted_detail = {
            "id": "detail_page_cross_module_delete",
            "type": "detail-page",
            "status": "succeeded",
            "settings": {"product_images": [detail_owned_url], "reference_images": []},
            "screens": [{"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": detail_output_url}]}],
        }
        retained_detail = {
            "id": "detail_page_cross_module_keep",
            "type": "detail-page",
            "status": "succeeded",
            "settings": {"product_images": [main_owned_url], "reference_images": []},
            "screens": [],
        }
        for task, persist in (
            (deleted_main, main.main_image_persist_task),
            (retained_main, main.main_image_persist_task),
            (deleted_detail, main.detail_page_persist_task),
            (retained_detail, main.detail_page_persist_task),
        ):
            main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
            persist(task)

        main_response = self.client.delete(f"/api/main-image-tasks/{deleted_main['id']}")
        detail_response = self.client.delete(f"/api/detail-page-tasks/{deleted_detail['id']}")

        self.assertEqual(main_response.status_code, 202, main_response.text)
        self.assertEqual(detail_response.status_code, 202, detail_response.text)
        main_job = main.ONE_CLICK_CLEANUP_JOBS[main_response.json()["cleanup_job_id"]]
        detail_job = main.ONE_CLICK_CLEANUP_JOBS[detail_response.json()["cleanup_job_id"]]
        self.assertEqual(main_job["cleanup_policy"], "same-module-inputs-v1")
        self.assertEqual(detail_job["cleanup_policy"], "same-module-inputs-v1")
        self.assertIn(str(main_owned), main_job["input_media_paths"])
        self.assertNotIn(str(main_owned), main_job["direct_media_paths"])
        self.assertIn(str(detail_owned), detail_job["input_media_paths"])
        self.assertNotIn(str(detail_owned), detail_job["direct_media_paths"])

        with patch.object(main, "storage_cleanup_stable_reference_snapshot") as full_scan, patch.object(
            main, "one_click_cleanup_file_snapshot"
        ) as full_hash:
            main_result = main.run_one_click_cleanup_job_once(main_job["job_id"])
            detail_result = main.run_one_click_cleanup_job_once(detail_job["job_id"])

        self.assertEqual(main_result["status"], "succeeded")
        self.assertEqual(detail_result["status"], "succeeded")
        full_scan.assert_not_called()
        full_hash.assert_not_called()
        self.assertFalse(main_owned.exists())
        self.assertFalse(detail_owned.exists())
        self.assertFalse(main_output.exists())
        self.assertFalse(detail_output.exists())
        self.assertIn(retained_main["id"], main.CANVAS_TASKS)
        self.assertIn(retained_detail["id"], main.CANVAS_TASKS)

    def test_deleting_main_image_screen_removes_only_that_screen_and_recycles_all_candidates(self):
        upload = self.write_image(self.upload / "main-screen-upload.png", old=False)
        first_output = self.write_image(self.generated / "main-screen-first.png", old=False)
        second_output = self.write_image(self.generated / "main-screen-second.png", old=False)
        retained_output = self.write_image(self.generated / "main-screen-retained.png", old=False)
        upload_url = "/api/storage-files/upload/main-screen-upload.png"
        first_url = "/api/storage-files/generated/main-screen-first.png"
        second_url = "/api/storage-files/generated/main-screen-second.png"
        retained_url = "/api/storage-files/generated/main-screen-retained.png"
        task = {
            "id": "main_image_delete_one_screen",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [upload_url], "reference_images": []},
            "screens": [
                {
                    "screen_no": 1,
                    "candidates": [
                        {"id": "a", "status": "succeeded", "image_url": first_url, "result": {"images": [first_url]}},
                        {"id": "b", "status": "succeeded", "image_url": second_url, "result": {"images": [second_url]}},
                    ],
                },
                {
                    "screen_no": 2,
                    "candidates": [
                        {"id": "c", "status": "succeeded", "image_url": retained_url, "result": {"images": [retained_url]}},
                    ],
                },
            ],
        }
        main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
        main.main_image_persist_task(task)
        self.history.write_text(json.dumps([
            {"source_type": "main-image", "source_task_id": task["id"], "source_screen_no": 1, "images": [first_url]},
            {"source_type": "main-image", "source_task_id": task["id"], "source_screen_no": 1, "images": [second_url]},
            {"source_type": "main-image", "source_task_id": task["id"], "source_screen_no": 2, "images": [retained_url]},
        ]), encoding="utf-8")

        with patch.object(main, "storage_cleanup_stable_reference_snapshot") as full_scan:
            response = self.client.delete(f"/api/main-image-tasks/{task['id']}/screens/1")

        self.assertEqual(response.status_code, 202, response.text)
        full_scan.assert_not_called()
        body = response.json()
        self.assertTrue(body["deleted"])
        self.assertFalse(body["task_deleted"])
        self.assertEqual(body["screen_no"], 1)
        self.assertEqual(body["history_deleted"], 2)
        self.assertEqual(body["media_candidates"], 2)
        self.assertEqual(body["cleanup_status"], "queued")
        self.assertEqual([item["screen_no"] for item in body["task"]["screens"]], [2])
        job = main.ONE_CLICK_CLEANUP_JOBS[body["cleanup_job_id"]]
        self.assertEqual(set(job["media_paths"]), {str(first_output), str(second_output)})
        self.assertNotIn(str(upload), job["media_paths"])
        self.assertEqual([item.get("source_screen_no") for item in json.loads(self.history.read_text(encoding="utf-8"))], [2])

        completed = main.run_one_click_cleanup_job_once(body["cleanup_job_id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertFalse(first_output.exists())
        self.assertFalse(second_output.exists())
        self.assertTrue(retained_output.exists())
        self.assertTrue(upload.exists())

    def test_deleting_detail_page_screen_prunes_legacy_mixed_history_without_touching_other_images(self):
        removed_output = self.write_image(self.generated / "detail-screen-removed.png", old=False)
        retained_output = self.write_image(self.generated / "detail-screen-retained.png", old=False)
        removed_url = "/api/storage-files/generated/detail-screen-removed.png"
        retained_url = "/api/storage-files/generated/detail-screen-retained.png"
        task = {
            "id": "detail_page_delete_one_screen",
            "type": "detail-page",
            "status": "succeeded",
            "settings": {"product_images": [], "reference_images": []},
            "screens": [
                {"screen_no": 1, "candidates": [{"upstream_task_id": "upstream-1", "status": "succeeded", "image_url": removed_url, "result": {"images": [removed_url]}}]},
                {"screen_no": 2, "candidates": [{"upstream_task_id": "upstream-2", "status": "succeeded", "image_url": retained_url, "result": {"images": [retained_url]}}]},
            ],
        }
        main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
        main.detail_page_persist_task(task)
        self.history.write_text(json.dumps([{
            "source_type": "detail-page",
            "source_task_id": task["id"],
            "images": [removed_url, retained_url],
            "image_items": [{"url": removed_url}, {"url": retained_url}],
            "params": {"reference_images": []},
        }]), encoding="utf-8")

        response = self.client.delete(f"/api/detail-page-tasks/{task['id']}/screens/1")

        self.assertEqual(response.status_code, 202, response.text)
        body = response.json()
        self.assertFalse(body["task_deleted"])
        self.assertEqual(body["history_deleted"], 0)
        self.assertEqual(body["history_updated"], 1)
        history = json.loads(self.history.read_text(encoding="utf-8"))
        self.assertEqual(history[0]["images"], [retained_url])
        self.assertEqual([item["url"] for item in history[0]["image_items"]], [retained_url])
        self.assertNotIn("source_screen_no", history[0])

        completed = main.run_one_click_cleanup_job_once(body["cleanup_job_id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertFalse(removed_output.exists())
        self.assertTrue(retained_output.exists())

    def test_deleting_last_screen_deletes_the_group_and_preserves_shared_input(self):
        for task_type, endpoint_prefix, persist in (
            ("main-image", "main-image-tasks", main.main_image_persist_task),
            ("detail-page", "detail-page-tasks", main.detail_page_persist_task),
        ):
            with self.subTest(task_type=task_type):
                suffix = task_type.replace("-", "_")
                shared = self.write_image(self.upload / f"{suffix}-last-shared.png", old=False)
                output = self.write_image(self.generated / f"{suffix}-last-output.png", old=False)
                other = self.write_image(self.generated / f"{suffix}-other-output.png", old=False)
                shared_url = f"/api/storage-files/upload/{suffix}-last-shared.png"
                output_url = f"/api/storage-files/generated/{suffix}-last-output.png"
                other_url = f"/api/storage-files/generated/{suffix}-other-output.png"
                task = {
                    "id": f"{suffix}_delete_last",
                    "type": task_type,
                    "status": "succeeded",
                    "settings": {"product_images": [shared_url], "reference_images": []},
                    "screens": [{"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": output_url, "result": {"images": [output_url]}}]}],
                }
                retained = {
                    "id": f"{suffix}_keep_shared",
                    "type": task_type,
                    "status": "succeeded",
                    "settings": {"product_images": [shared_url], "reference_images": []},
                    "screens": [{"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": other_url, "result": {"images": [other_url]}}]}],
                }
                main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
                main.CANVAS_TASKS[retained["id"]] = copy.deepcopy(retained)
                persist(task)
                persist(retained)
                self.history.write_text(json.dumps([
                    {"source_type": task_type, "source_task_id": task["id"], "source_screen_no": 1, "images": [output_url]},
                    {"source_type": task_type, "source_task_id": retained["id"], "source_screen_no": 1, "images": [other_url]},
                ]), encoding="utf-8")

                response = self.client.delete(f"/api/{endpoint_prefix}/{task['id']}/screens/1")

                self.assertEqual(response.status_code, 202, response.text)
                body = response.json()
                self.assertTrue(body["task_deleted"])
                self.assertIsNone(body["task"])
                self.assertNotIn(task["id"], main.CANVAS_TASKS)
                job = main.ONE_CLICK_CLEANUP_JOBS[body["cleanup_job_id"]]
                self.assertEqual(set(job["media_paths"]), {str(shared), str(output)})
                completed = main.run_one_click_cleanup_job_once(body["cleanup_job_id"])
                self.assertEqual(completed["status"], "succeeded")
                self.assertFalse(output.exists())
                self.assertTrue(shared.exists())
                self.assertTrue(other.exists())

                main.CANVAS_TASKS.pop(retained["id"], None)
                task_file = Path(main.MAIN_IMAGE_TASK_DIR if task_type == "main-image" else main.DETAIL_PAGE_TASK_DIR) / f"{retained['id']}.json"
                task_file.unlink(missing_ok=True)
                main.ONE_CLICK_CLEANUP_JOBS.clear()

    def test_single_screen_delete_without_media_skips_cleanup_job(self):
        task = {
            "id": "detail_page_delete_failed_screen",
            "type": "detail-page",
            "status": "failed",
            "settings": {"product_images": [], "reference_images": []},
            "screens": [
                {"screen_no": 1, "status": "failed", "candidates": []},
                {"screen_no": 2, "status": "failed", "candidates": []},
            ],
        }
        main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
        main.detail_page_persist_task(task)

        response = self.client.delete(f"/api/detail-page-tasks/{task['id']}/screens/1")

        self.assertEqual(response.status_code, 202, response.text)
        body = response.json()
        self.assertEqual(body["cleanup_status"], "skipped")
        self.assertIsNone(body["cleanup_job_id"])
        self.assertEqual(body["media_candidates"], 0)
        self.assertEqual(main.ONE_CLICK_CLEANUP_JOBS, {})

    def test_single_screen_delete_rolls_back_when_cleanup_job_cannot_be_persisted(self):
        output = self.write_image(self.generated / "screen-rollback.png", old=False)
        output_url = "/api/storage-files/generated/screen-rollback.png"
        task = {
            "id": "main_image_screen_rollback",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [], "reference_images": []},
            "screens": [
                {"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": output_url}]},
                {"screen_no": 2, "candidates": []},
            ],
        }
        main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
        main.main_image_persist_task(task)
        original_history = [{"source_type": "main-image", "source_task_id": task["id"], "source_screen_no": 1, "images": [output_url]}]
        self.history.write_text(json.dumps(original_history), encoding="utf-8")

        with patch.object(main, "one_click_cleanup_create_job", side_effect=OSError("job write failed")):
            response = self.client.delete(f"/api/main-image-tasks/{task['id']}/screens/1")

        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual([item["screen_no"] for item in main.CANVAS_TASKS[task["id"]]["screens"]], [1, 2])
        self.assertEqual(json.loads(self.history.read_text(encoding="utf-8")), original_history)
        persisted = json.loads((Path(main.MAIN_IMAGE_TASK_DIR) / f"{task['id']}.json").read_text(encoding="utf-8"))
        self.assertEqual([item["screen_no"] for item in persisted["screens"]], [1, 2])
        self.assertTrue(output.exists())

    def test_single_screen_delete_rolls_back_when_prepared_job_cannot_be_activated(self):
        output = self.write_image(self.generated / "screen-activation-rollback.png", old=False)
        output_url = "/api/storage-files/generated/screen-activation-rollback.png"
        task = {
            "id": "detail_page_screen_activation_rollback",
            "type": "detail-page",
            "status": "succeeded",
            "settings": {"product_images": [], "reference_images": []},
            "screens": [
                {"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": output_url}]},
                {"screen_no": 2, "candidates": []},
            ],
        }
        main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
        main.detail_page_persist_task(task)
        original_history = [{
            "source_type": "detail-page",
            "source_task_id": task["id"],
            "source_screen_no": 1,
            "images": [output_url],
        }]
        self.history.write_text(json.dumps(original_history), encoding="utf-8")

        with patch.object(main, "one_click_cleanup_activate_job", side_effect=OSError("activation write failed")):
            response = self.client.delete(f"/api/detail-page-tasks/{task['id']}/screens/1")

        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual([item["screen_no"] for item in main.CANVAS_TASKS[task["id"]]["screens"]], [1, 2])
        self.assertEqual(json.loads(self.history.read_text(encoding="utf-8")), original_history)
        persisted = json.loads((Path(main.DETAIL_PAGE_TASK_DIR) / f"{task['id']}.json").read_text(encoding="utf-8"))
        self.assertEqual([item["screen_no"] for item in persisted["screens"]], [1, 2])
        self.assertEqual(main.ONE_CLICK_CLEANUP_JOBS, {})
        self.assertTrue(output.exists())

    def test_single_screen_cleanup_job_activates_only_after_record_commit(self):
        removed = self.write_image(self.generated / "screen-activation-removed.png", old=False)
        retained = self.write_image(self.generated / "screen-activation-retained.png", old=False)
        removed_url = "/api/storage-files/generated/screen-activation-removed.png"
        retained_url = "/api/storage-files/generated/screen-activation-retained.png"
        task = {
            "id": "main_image_screen_activation_order",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [], "reference_images": []},
            "screens": [
                {"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": removed_url}]},
                {"screen_no": 2, "candidates": [{"status": "succeeded", "image_url": retained_url}]},
            ],
        }
        main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
        main.main_image_persist_task(task)
        self.history.write_text(json.dumps([
            {"source_type": "main-image", "source_task_id": task["id"], "source_screen_no": 1, "images": [removed_url]},
            {"source_type": "main-image", "source_task_id": task["id"], "source_screen_no": 2, "images": [retained_url]},
        ]), encoding="utf-8")
        original_activate = main.one_click_cleanup_activate_job
        observed = {"committed": False}

        def activate_after_asserting_commit(job_id):
            self.assertEqual(main.ONE_CLICK_CLEANUP_JOBS[job_id]["status"], "preparing")
            persisted = json.loads((Path(main.MAIN_IMAGE_TASK_DIR) / f"{task['id']}.json").read_text(encoding="utf-8"))
            self.assertEqual([item["screen_no"] for item in persisted["screens"]], [2])
            self.assertEqual([item["screen_no"] for item in main.CANVAS_TASKS[task["id"]]["screens"]], [2])
            self.assertEqual(
                [item.get("source_screen_no") for item in json.loads(self.history.read_text(encoding="utf-8"))],
                [2],
            )
            observed["committed"] = True
            return original_activate(job_id)

        with patch.object(main, "one_click_cleanup_activate_job", side_effect=activate_after_asserting_commit):
            response = self.client.delete(f"/api/main-image-tasks/{task['id']}/screens/1")

        self.assertEqual(response.status_code, 202, response.text)
        self.assertTrue(observed["committed"])
        self.assertEqual(main.ONE_CLICK_CLEANUP_JOBS[response.json()["cleanup_job_id"]]["status"], "queued")
        self.assertTrue(removed.exists())
        self.assertTrue(retained.exists())

    def test_single_screen_cas_cleanup_directly_recycles_all_screen_outputs(self):
        removed = self.media_store.adopt_bytes(self.png_bytes((210, 40, 50, 255)), ".png")
        shared = self.media_store.adopt_bytes(self.png_bytes((40, 150, 210, 255)), ".png")
        removed_image = Path(removed["path"])
        removed_metadata = self.media_store._metadata_path(removed["id"])
        shared_image = Path(shared["path"])
        shared_metadata = self.media_store._metadata_path(shared["id"])
        task = {
            "id": "detail_page_single_screen_cas",
            "type": "detail-page",
            "status": "succeeded",
            "settings": {"product_images": [], "reference_images": []},
            "screens": [
                {
                    "screen_no": 1,
                    "candidates": [
                        {"status": "succeeded", "image_url": removed["url"]},
                        {"status": "succeeded", "image_url": shared["url"]},
                    ],
                },
                {
                    "screen_no": 2,
                    "candidates": [{"status": "succeeded", "image_url": shared["url"]}],
                },
            ],
        }
        main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
        main.detail_page_persist_task(task)

        response = self.client.delete(f"/api/detail-page-tasks/{task['id']}/screens/1")

        self.assertEqual(response.status_code, 202, response.text)
        job = main.ONE_CLICK_CLEANUP_JOBS[response.json()["cleanup_job_id"]]
        self.assertEqual(set(job["media_ids"]), {removed["id"], shared["id"]})
        with patch.object(main, "storage_cleanup_stable_reference_snapshot") as full_scan, patch.object(
            main, "one_click_cleanup_file_snapshot"
        ) as full_hash, patch.object(
            self.media_store, "media_record", side_effect=AssertionError("direct output must not hash-read")
        ):
            completed = main.run_one_click_cleanup_job_once(job["job_id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertEqual(completed["media_deleted"], 2)
        self.assertEqual(completed["media_preserved"], 0)
        full_scan.assert_not_called()
        full_hash.assert_not_called()
        self.assertFalse(removed_image.exists())
        self.assertFalse(removed_metadata.exists())
        self.assertFalse(shared_image.exists())
        self.assertFalse(shared_metadata.exists())

    def test_single_screen_delete_rechecks_active_status_inside_record_lock(self):
        terminal = {
            "id": "main_image_became_active",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [], "reference_images": []},
            "screens": [{"screen_no": 1, "candidates": []}, {"screen_no": 2, "candidates": []}],
        }
        active = {**copy.deepcopy(terminal), "status": "generating"}
        with patch.object(main, "main_image_task_snapshot", side_effect=[terminal, active]):
            response = self.client.delete(f"/api/main-image-tasks/{terminal['id']}/screens/1")

        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(main.ONE_CLICK_CLEANUP_JOBS, {})

    def test_repeated_single_screen_delete_does_not_create_a_second_cleanup_job(self):
        output = self.write_image(self.generated / "screen-repeat-delete.png", old=False)
        output_url = "/api/storage-files/generated/screen-repeat-delete.png"
        task = {
            "id": "main_image_screen_repeat_delete",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [], "reference_images": []},
            "screens": [
                {"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": output_url}]},
                {"screen_no": 2, "candidates": []},
            ],
        }
        main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
        main.main_image_persist_task(task)

        first = self.client.delete(f"/api/main-image-tasks/{task['id']}/screens/1")
        job_ids = set(main.ONE_CLICK_CLEANUP_JOBS)
        second = self.client.delete(f"/api/main-image-tasks/{task['id']}/screens/1")

        self.assertEqual(first.status_code, 202, first.text)
        self.assertEqual(second.status_code, 404, second.text)
        self.assertEqual(set(main.ONE_CLICK_CLEANUP_JOBS), job_ids)
        self.assertEqual(len(job_ids), 1)

    def test_one_click_cas_cleanup_recycles_image_and_metadata_but_preserves_shared_cas(self):
        shared = self.media_store.adopt_bytes(self.png_bytes((20, 180, 80, 255)), ".png")
        output = self.media_store.adopt_bytes(self.png_bytes((220, 60, 80, 255)), ".png")
        shared_image = Path(shared["path"])
        shared_metadata = self.media_store._metadata_path(shared["id"])
        output_image = Path(output["path"])
        output_metadata = self.media_store._metadata_path(output["id"])
        deleted = {
            "id": "main_image_cas_delete_a1",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [shared["url"]], "reference_images": []},
            "screens": [{
                "screen_no": 1,
                "candidates": [{"status": "succeeded", "image_url": output["url"]}],
            }],
        }
        retained = {
            "id": "main_image_cas_delete_a2",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [shared["url"]], "reference_images": []},
            "screens": [],
        }
        main.CANVAS_TASKS[deleted["id"]] = copy.deepcopy(deleted)
        main.CANVAS_TASKS[retained["id"]] = copy.deepcopy(retained)
        main.main_image_persist_task(deleted)
        main.main_image_persist_task(retained)
        self.history.write_text(json.dumps([{
            "source_type": "main-image",
            "source_task_id": deleted["id"],
            "images": [output["url"]],
            "params": {"reference_images": [{"url": shared["url"]}]},
        }]), encoding="utf-8")

        response = self.client.delete(f"/api/main-image-tasks/{deleted['id']}")
        self.assertEqual(response.status_code, 202, response.text)
        job = main.ONE_CLICK_CLEANUP_JOBS[response.json()["cleanup_job_id"]]
        self.assertEqual(set(job["media_ids"]), {shared["id"], output["id"]})
        self.assertEqual(job["media_paths"], [])

        completed = main.run_one_click_cleanup_job_once(job["job_id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertEqual(completed["media_deleted"], 1)
        self.assertEqual(completed["media_preserved"], 1)
        self.assertFalse(output_image.exists())
        self.assertFalse(output_metadata.exists())
        self.assertTrue(shared_image.exists())
        self.assertTrue(shared_metadata.exists())

    def test_detail_page_cas_cleanup_uses_same_unified_worker(self):
        output = self.media_store.adopt_bytes(self.png_bytes((80, 60, 220, 255)), ".png")
        output_image = Path(output["path"])
        output_metadata = self.media_store._metadata_path(output["id"])
        task = {
            "id": "detail_page_cas_delete",
            "type": "detail-page",
            "status": "succeeded",
            "settings": {"product_images": [], "reference_images": []},
            "screens": [{
                "screen_no": 1,
                "candidates": [{"status": "succeeded", "image_url": output["url"]}],
            }],
        }
        main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
        main.detail_page_persist_task(task)
        response = self.client.delete(f"/api/detail-page-tasks/{task['id']}")
        self.assertEqual(response.status_code, 202, response.text)

        completed = main.run_one_click_cleanup_job_once(response.json()["cleanup_job_id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertEqual(completed["media_deleted"], 1)
        self.assertFalse(output_image.exists())
        self.assertFalse(output_metadata.exists())

    def test_one_click_cas_cleanup_directly_recycles_image_when_metadata_is_missing(self):
        output = self.media_store.adopt_bytes(self.png_bytes((180, 120, 20, 255)), ".png")
        output_image = Path(output["path"])
        self.media_store._metadata_path(output["id"]).unlink()
        task = {
            "id": "main_image_cas_missing_metadata",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [], "reference_images": []},
            "screens": [{
                "screen_no": 1,
                "candidates": [{"status": "succeeded", "image_url": output["url"]}],
            }],
        }
        main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
        main.main_image_persist_task(task)
        response = self.client.delete(f"/api/main-image-tasks/{task['id']}")
        completed = main.run_one_click_cleanup_job_once(response.json()["cleanup_job_id"])

        self.assertEqual(completed["status"], "succeeded")
        self.assertEqual(completed["media_deleted"], 1)
        self.assertEqual(completed["media_preserved"], 0)
        self.assertFalse(output_image.exists())

    def test_direct_one_click_cleanup_recycles_malformed_metadata_with_its_image(self):
        output = self.media_store.adopt_bytes(self.png_bytes((150, 30, 150, 255)), ".png")
        metadata = self.media_store._metadata_path(output["id"])
        metadata.write_text("{broken metadata", encoding="utf-8")

        reference_files = {
            main.storage_cleanup_path_key(path)
            for path in main.storage_cleanup_reference_files()
        }
        self.assertNotIn(main.storage_cleanup_path_key(metadata), reference_files)
        self.assertIsInstance(main.storage_cleanup_referenced_paths(), set)

        job = main.one_click_cleanup_create_job(
            {"id": "main_image_bad_metadata", "type": "main-image"},
            {Path(output["path"])},
        )
        completed = main.run_one_click_cleanup_job_once(job["job_id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertEqual(completed["media_deleted"], 1)
        self.assertFalse(Path(output["path"]).exists())
        self.assertFalse(metadata.exists())

    def test_one_click_generated_outputs_ignore_cross_module_references(self):
        canvas_media = self.media_store.adopt_bytes(self.png_bytes((10, 90, 180, 255)), ".png")
        case_media = self.media_store.adopt_bytes(self.png_bytes((180, 90, 10, 255)), ".png")
        canvas_dir = self.data / "canvases"
        canvas_dir.mkdir(parents=True, exist_ok=True)
        (canvas_dir / "canvas-cas-reference.json").write_text(json.dumps({
            "id": "canvas-cas-reference",
            "nodes": [{"id": "image", "type": "image", "url": canvas_media["url"]}],
            "logs": [],
        }), encoding="utf-8")
        modes = self.data / "image_generation_modes"
        modes.mkdir(parents=True, exist_ok=True)
        (modes / "mode-cas-reference.json").write_text(json.dumps({
            "id": "mode-cas-reference",
            "example": {"output_media": {"url": case_media["url"]}},
        }), encoding="utf-8")
        task = {"id": "main_image_cas_other_references", "type": "main-image"}
        job = main.one_click_cleanup_create_job(
            task,
            {Path(canvas_media["path"]), Path(case_media["path"])},
        )

        with patch.object(main, "storage_cleanup_stable_reference_snapshot") as full_scan, patch.object(
            main, "one_click_cleanup_file_snapshot"
        ) as full_hash:
            completed = main.run_one_click_cleanup_job_once(job["job_id"])

        self.assertEqual(completed["status"], "succeeded")
        self.assertEqual(completed["media_deleted"], 2)
        self.assertEqual(completed["media_preserved"], 0)
        full_scan.assert_not_called()
        full_hash.assert_not_called()
        self.assertFalse(Path(canvas_media["path"]).exists())
        self.assertFalse(Path(case_media["path"]).exists())

    def test_one_click_cleanup_rolls_back_when_reference_appears_after_staging(self):
        output = self.write_image(self.generated / "late-reference-after-stage.png", old=False)
        output_url = "/api/storage-files/generated/late-reference-after-stage.png"
        job = main.one_click_cleanup_create_job(
            {"id": "legacy-history-late-reference", "type": "legacy-history"},
            {output},
        )
        signatures = iter(["first", "first", "changed", "changed", "changed"])
        scans = iter([set(), {main.storage_cleanup_path_key(output)}])

        with patch.object(
            main,
            "storage_cleanup_reference_signature",
            side_effect=lambda: next(signatures),
        ), patch.object(
            main,
            "storage_cleanup_referenced_paths",
            side_effect=lambda: next(scans),
        ):
            completed = main.run_one_click_cleanup_job_once(job["job_id"])

        self.assertEqual(completed["status"], "failed")
        self.assertIn("新的媒体引用", completed["error"])
        self.assertTrue(output.exists())
        self.history.write_text(json.dumps([{"images": [output_url]}]), encoding="utf-8")

    def test_one_click_cleanup_reuses_reference_snapshot_when_signature_is_unchanged(self):
        output = self.write_image(self.generated / "single-scan.png", old=False)
        task = {"id": "legacy-single-scan", "type": "legacy-history"}
        job = main.one_click_cleanup_create_job(task, {output})
        original_scan = main.storage_cleanup_referenced_paths
        calls = {"scan": 0}

        def counted_scan():
            calls["scan"] += 1
            return original_scan()

        with patch.object(main, "storage_cleanup_reference_signature", return_value="stable"), patch.object(
            main, "storage_cleanup_referenced_paths", side_effect=counted_scan
        ):
            completed = main.run_one_click_cleanup_job_once(job["job_id"])

        self.assertEqual(completed["status"], "succeeded")
        self.assertEqual(calls["scan"], 1)
        self.assertFalse(output.exists())

    def test_old_cas_cleanup_job_requires_review_before_it_can_run(self):
        output = self.media_store.adopt_bytes(self.png_bytes((100, 100, 100, 255)), ".png")
        job_id = "a" * 32
        root = Path(main.ONE_CLICK_CLEANUP_JOB_DIR)
        root.mkdir(parents=True, exist_ok=True)
        (root / f"{job_id}.json").write_text(json.dumps({
            "version": 2,
            "job_id": job_id,
            "task_id": "main_image_old_cas",
            "task_type": "main-image",
            "media_paths": [output["path"]],
            "media_candidates": 1,
            "media_deleted": 0,
            "media_preserved": 0,
            "status": "failed",
            "attempts": 9,
            "created_at": time.time() - 60,
            "updated_at": time.time(),
            "next_attempt_at": 0,
            "error": "一键清理文件路径越界",
        }), encoding="utf-8")

        main.load_one_click_cleanup_jobs()
        migrated = main.ONE_CLICK_CLEANUP_JOBS[job_id]
        self.assertEqual(migrated["status"], "review_required")
        self.assertFalse(migrated["authorized"])
        self.assertIsNone(main.one_click_cleanup_next_due_job())
        untouched = main.run_one_click_cleanup_job_once(job_id)
        self.assertEqual(untouched["status"], "review_required")
        self.assertTrue(Path(output["path"]).exists())

        preview = self.client.post(f"/api/storage-cleanup/jobs/{job_id}/review")
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(len(preview.json()["candidates"]), 1)
        confirmed = self.client.post(
            f"/api/storage-cleanup/jobs/{job_id}/confirm-review",
            json={"confirmation_id": preview.json()["confirmation_id"]},
        )
        self.assertEqual(confirmed.status_code, 202, confirmed.text)
        self.assertEqual(confirmed.json()["status"], "queued")
        completed = main.run_one_click_cleanup_job_once(job_id)
        self.assertEqual(completed["status"], "succeeded")
        self.assertFalse(Path(output["path"]).exists())
        self.assertFalse(self.media_store._metadata_path(output["id"]).exists())

    def test_group_delete_recycle_bin_failure_keeps_record_deleted_and_retries_media_cleanup(self):
        upload = self.write_image(self.upload / "rollback-upload.png", old=False)
        output = self.write_image(self.generated / "rollback-output.png", old=False)
        upload_url = "/api/storage-files/upload/rollback-upload.png"
        output_url = "/api/storage-files/generated/rollback-output.png"
        task = {
            "id": "main_image_rollback_group",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [upload_url], "reference_images": []},
            "screens": [{"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": output_url, "result": {"images": [output_url]}}]}],
        }
        history = [{
            "source_type": "main-image",
            "source_task_id": task["id"],
            "images": [output_url],
            "params": {"reference_images": [{"url": upload_url}]},
        }]
        main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
        main.main_image_persist_task(task)
        self.history.write_text(json.dumps(history, ensure_ascii=False), encoding="utf-8")

        response = self.client.delete(f"/api/main-image-tasks/{task['id']}")
        self.assertEqual(response.status_code, 202, response.text)
        body = response.json()
        self.assertNotIn(task["id"], main.CANVAS_TASKS)
        self.assertFalse((self.data / "main-image-tasks" / f"{task['id']}.json").exists())
        self.assertEqual(json.loads(self.history.read_text(encoding="utf-8")), [])

        with patch.object(
            storage_cleanup,
            "move_paths_to_recycle_bin",
            side_effect=OSError("recycle bin unavailable"),
        ):
            failed = main.run_one_click_cleanup_job_once(body["cleanup_job_id"])

        self.assertEqual(failed["status"], "failed")
        self.assertIn("recycle bin unavailable", failed["error"])
        self.assertTrue(upload.exists())
        self.assertTrue(output.exists())

        succeeded = main.run_one_click_cleanup_job_once(body["cleanup_job_id"])
        self.assertEqual(succeeded["status"], "succeeded")
        self.assertFalse(upload.exists())
        self.assertFalse(output.exists())

    def test_group_delete_returns_before_slow_media_cleanup(self):
        task = {
            "id": "main_image_slow_cleanup",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [], "reference_images": []},
            "screens": [],
        }
        main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
        main.main_image_persist_task(task)

        with patch.object(main, "run_one_click_media_cleanup_job", side_effect=lambda _job: time.sleep(0.2)):
            started = time.perf_counter()
            response = self.client.delete(f"/api/main-image-tasks/{task['id']}")
            elapsed = time.perf_counter() - started

        self.assertEqual(response.status_code, 202, response.text)
        self.assertLess(elapsed, 0.15)

    def test_deleted_detail_page_rejects_late_generated_history_and_queues_media_cleanup(self):
        async def scenario():
            task_id = "detail_page_late_delete"
            payload = main.DetailPageTaskRequest(
                product_images=["https://example.test/product.png"],
                image_provider_id="image-provider",
                image_model="gpt-image-2",
                llm_provider_id="vision-provider",
                llm_model="gemini-3-flash",
                screen_count=1,
            )
            task = main.new_detail_page_task_record(task_id, payload)
            task["status"] = "succeeded"
            task["screens"] = main.detail_page_screen_records([{"screen_no": 1, "prompt": "late detail"}])
            main.CANVAS_TASKS[task_id] = task
            main.detail_page_persist_task(task)
            started = asyncio.Event()
            release = asyncio.Event()
            output = self.generated / "late-detail.png"

            async def late_build(_request, history_metadata=None, **_kwargs):
                started.set()
                await release.wait()
                output.write_bytes(b"late detail result")
                result = {"images": ["/api/storage-files/generated/late-detail.png"], "task_id": "late-detail-upstream"}
                main.save_history_record_with_metadata(result, history_metadata)
                return result

            with patch.object(main, "detail_page_async_snapshot_for_request", return_value=None), patch.object(
                main, "build_online_image_result", side_effect=late_build
            ):
                runner = asyncio.create_task(main.run_detail_page_screen(task_id, payload, 1))
                await started.wait()
                response = await main.delete_detail_page_task(task_id)
                release.set()
                await asyncio.gather(runner, return_exceptions=True)
            return response, output

        response, output = asyncio.run(scenario())
        self.assertEqual(response.status_code, 202)
        self.assertNotIn("detail_page_late_delete", main.CANVAS_TASKS)
        self.assertFalse((self.data / "detail-page-tasks" / "detail_page_late_delete.json").exists())
        self.assertEqual(json.loads(self.history.read_text(encoding="utf-8")), [])
        self.assertTrue(output.exists())
        self.assertTrue(any(str(output) in job.get("media_paths", []) for job in main.ONE_CLICK_CLEANUP_JOBS.values()))

        for job_id in list(main.ONE_CLICK_CLEANUP_JOBS):
            main.run_one_click_cleanup_job_once(job_id)
        self.assertFalse(output.exists())
        self.assertEqual(main.ONE_CLICK_CLEANUP_JOBS, {})

    def test_deleted_main_image_rejects_late_generated_history_and_queues_media_cleanup(self):
        async def scenario():
            task_id = "main_image_late_delete"
            payload = main.MainImageTaskRequest(
                product_images=["https://example.test/product.png"],
                image_provider_id="image-provider",
                image_model="gpt-image-2",
                llm_provider_id="vision-provider",
                llm_model="gemini-3-flash",
                image_count=1,
            )
            task = main.new_main_image_task_record(task_id, payload, "submission", "fingerprint", 1)
            task["status"] = "succeeded"
            task["screens"] = [{
                "screen_no": 1,
                "status": "succeeded",
                "prompt": "late main image",
                "candidates": [],
                "attempt": 0,
                "result": None,
            }]
            main.CANVAS_TASKS[task_id] = task
            main.main_image_persist_task(task)
            started = asyncio.Event()
            release = asyncio.Event()
            output = self.generated / "late-main.png"

            async def late_build(_request, history_metadata=None, **_kwargs):
                started.set()
                await release.wait()
                output.write_bytes(b"late main image result")
                result = {"images": ["/api/storage-files/generated/late-main.png"], "task_id": "late-main-upstream"}
                main.save_history_record_with_metadata(result, history_metadata)
                return result

            with patch.object(main, "detail_page_async_snapshot_for_request", return_value=None), patch.object(
                main, "build_online_image_result", side_effect=late_build
            ):
                runner = asyncio.create_task(main.run_main_image_screen(task_id, payload, 1))
                await started.wait()
                response = await main.delete_main_image_task(task_id)
                release.set()
                await asyncio.gather(runner, return_exceptions=True)
            return response, output

        response, output = asyncio.run(scenario())
        self.assertEqual(response.status_code, 202)
        self.assertNotIn("main_image_late_delete", main.CANVAS_TASKS)
        self.assertFalse((self.data / "main-image-tasks" / "main_image_late_delete.json").exists())
        self.assertEqual(json.loads(self.history.read_text(encoding="utf-8")), [])
        self.assertTrue(output.exists())
        self.assertTrue(any(str(output) in job.get("media_paths", []) for job in main.ONE_CLICK_CLEANUP_JOBS.values()))

        for job_id in list(main.ONE_CLICK_CLEANUP_JOBS):
            main.run_one_click_cleanup_job_once(job_id)
        self.assertFalse(output.exists())
        self.assertEqual(main.ONE_CLICK_CLEANUP_JOBS, {})

    def test_pending_cleanup_jobs_recover_running_state_as_queued(self):
        output = self.write_image(self.generated / "recover-running-cleanup.png", old=False)
        output_url = "/api/storage-files/generated/recover-running-cleanup.png"
        task = {
            "id": "main_image_recover_cleanup",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [], "reference_images": []},
            "screens": [{"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": output_url}]}],
        }
        main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
        main.main_image_persist_task(task)
        response = self.client.delete(f"/api/main-image-tasks/{task['id']}")
        self.assertEqual(response.status_code, 202, response.text)
        job_id = response.json()["cleanup_job_id"]
        job_path = Path(main.ONE_CLICK_CLEANUP_JOB_DIR) / f"{job_id}.json"
        job = json.loads(job_path.read_text(encoding="utf-8"))
        job["status"] = "running"
        job_path.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
        main.ONE_CLICK_CLEANUP_JOBS.clear()

        main.load_one_click_cleanup_jobs()

        self.assertEqual(main.ONE_CLICK_CLEANUP_JOBS[job_id]["status"], "queued")

    def test_preparing_cleanup_job_is_not_runnable_until_restart_recovery(self):
        output = self.write_image(self.generated / "recover-preparing-cleanup.png", old=False)
        task = {
            "id": "main_image_recover_preparing_cleanup",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": [], "reference_images": []},
            "screens": [],
        }
        job = main.one_click_cleanup_create_job(task, {output}, status="preparing")
        self.assertIsNone(main.one_click_cleanup_next_due_job())
        main.ONE_CLICK_CLEANUP_JOBS.clear()

        main.load_one_click_cleanup_jobs()

        recovered = main.ONE_CLICK_CLEANUP_JOBS[job["job_id"]]
        self.assertEqual(recovered["status"], "queued")
        self.assertEqual(recovered["next_attempt_at"], 0)
        self.assertIn("恢复待提交", recovered["error"])

    def test_group_delete_matches_legacy_unmarked_history_by_owned_output(self):
        output_url = "/api/storage-files/generated/legacy-detail-output.png"
        task = {
            "id": "detail_page_legacy_delete",
            "type": "detail-page",
            "settings": {"product_images": [], "reference_images": []},
            "screens": [{"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": output_url}]}],
        }
        self.history.write_text(json.dumps([
            {"images": [output_url], "params": {"reference_images": []}},
            {"images": ["/api/storage-files/generated/other.png"], "params": {"reference_images": []}},
        ], ensure_ascii=False), encoding="utf-8")

        with main.HISTORY_LOCK:
            removed = main.delete_one_click_history_rows_locked(task)

        self.assertEqual(removed, 1)
        rows = json.loads(self.history.read_text(encoding="utf-8"))
        self.assertEqual(rows[0]["images"], ["/api/storage-files/generated/other.png"])

    def test_group_delete_queues_immediately_when_cleanup_lock_is_busy(self):
        output = self.write_image(self.generated / "locked-delete-output.png", old=False)
        output_url = "/api/storage-files/generated/locked-delete-output.png"
        task = {
            "id": "main_image_locked_delete",
            "type": "main-image",
            "status": "succeeded",
            "settings": {"product_images": ["https://example.test/product.png"], "reference_images": []},
            "screens": [{"screen_no": 1, "candidates": [{"status": "succeeded", "image_url": output_url}]}],
        }
        main.CANVAS_TASKS[task["id"]] = copy.deepcopy(task)
        main.main_image_persist_task(task)
        self.assertTrue(main.STORAGE_CLEANUP_EXECUTION_LOCK.acquire(blocking=False))
        try:
            response = self.client.delete(f"/api/main-image-tasks/{task['id']}")
        finally:
            main.STORAGE_CLEANUP_EXECUTION_LOCK.release()

        self.assertEqual(response.status_code, 202, response.text)
        self.assertNotIn(task["id"], main.CANVAS_TASKS)
        self.assertFalse((self.data / "main-image-tasks" / f"{task['id']}.json").exists())
        self.assertEqual(response.json()["cleanup_status"], "queued")
        self.assertTrue(output.exists())

    def test_group_delete_rejects_running_main_image_and_detail_page_tasks(self):
        cases = (
            (
                "main-image",
                "main_image_running_delete",
                "generating",
                main.main_image_persist_task,
                "/api/main-image-tasks/{}",
                self.data / "main-image-tasks",
            ),
            (
                "detail-page",
                "detail_page_running_delete",
                "planning",
                main.detail_page_persist_task,
                "/api/detail-page-tasks/{}",
                self.data / "detail-page-tasks",
            ),
        )
        for task_type, task_id, status, persist, route, task_dir in cases:
            task = {
                "id": task_id,
                "type": task_type,
                "status": status,
                "settings": {"product_images": [], "reference_images": []},
                "screens": [],
            }
            main.CANVAS_TASKS[task_id] = copy.deepcopy(task)
            persist(task)
            response = self.client.delete(route.format(task_id))
            self.assertEqual(response.status_code, 409, response.text)
            self.assertIn("生成期间不能删除", response.json()["detail"])
            self.assertIn(task_id, main.CANVAS_TASKS)
            self.assertTrue((task_dir / f"{task_id}.json").exists())
            main.CANVAS_TASKS.pop(task_id, None)
            (task_dir / f"{task_id}.json").unlink(missing_ok=True)

    def test_reference_parse_failure_aborts_preview_without_issuing_confirmation(self):
        orphan = self.write_image(self.generated / "must-survive.png")
        (self.data / "broken.json").write_text("{not valid json", encoding="utf-8")
        response = self.client.post("/api/storage-cleanup/preview", json={"kind": "generated"})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("无法安全核对", response.json()["detail"])
        self.assertEqual(main.STORAGE_CLEANUP_CONFIRMATIONS, {})
        self.assertTrue(orphan.exists())

    def test_update_restore_point_json_is_not_treated_as_a_live_media_reference(self):
        orphan = self.write_image(self.generated / "old-orphan.png")
        backup_notes = self.data / "update_backups" / "20260805-010701" / "static" / "update-notes.json"
        backup_notes.parent.mkdir(parents=True, exist_ok=True)
        backup_notes.write_text('{"text":"old\nrelease notes"}', encoding="utf-8")

        preview = self.preview("generated")

        self.assertTrue(preview["has_targets"])
        self.assertTrue(orphan.exists())

    def test_cleanup_aborts_when_a_configured_target_overlaps_a_protected_library(self):
        role_image = self.write_image(self.role_library / "must-survive.png")
        with patch.object(main, "OUTPUT_OUTPUT_DIR", str(self.role_library)):
            response = self.client.post(
                "/api/storage-cleanup/preview",
                json={"kind": "generated"},
            )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertTrue(role_image.exists())

    def test_new_reference_after_confirm_is_preserved_by_background_rescan(self):
        orphan = self.write_image(self.generated / "late-reference.png")
        preview = self.preview("generated")
        key = main.storage_cleanup_path_key(orphan)
        original = main.storage_cleanup_referenced_paths
        def references_with_late_adoption():
            return original() | {key}

        response = self.confirm(preview["confirmation_id"])
        self.assertEqual(response.status_code, 202, response.text)
        with patch.object(main, "storage_cleanup_referenced_paths", side_effect=references_with_late_adoption):
            completed = main.run_one_click_cleanup_job_once(response.json()["cleanup_job_id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertEqual(completed["media_preserved"], 1)
        self.assertTrue(orphan.exists())

    def test_confirmation_is_single_use_and_expired_tokens_are_rejected(self):
        orphan = self.write_image(self.generated / "one-time.png")
        preview = self.preview("generated")
        first = self.confirm(preview["confirmation_id"])
        self.assertEqual(first.status_code, 202, first.text)
        self.assertTrue(orphan.exists())
        completed = main.run_one_click_cleanup_job_once(first.json()["cleanup_job_id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertFalse(orphan.exists())
        replay = self.confirm(preview["confirmation_id"])
        self.assertEqual(replay.status_code, 409, replay.text)

        second = self.preview("generated")
        main.STORAGE_CLEANUP_CONFIRMATIONS[second["confirmation_id"]]["expires_at"] = 0
        expired = self.confirm(second["confirmation_id"])
        self.assertEqual(expired.status_code, 409, expired.text)

    def test_recycle_bin_failure_rolls_staged_file_back_and_never_unlinks_it(self):
        orphan = self.write_image(self.generated / "recycle-failure.png")
        preview = self.preview("generated")
        with patch.object(
            storage_cleanup,
            "move_paths_to_recycle_bin",
            side_effect=OSError("recycle bin unavailable"),
        ):
            response = self.confirm(preview["confirmation_id"])
            self.assertEqual(response.status_code, 202, response.text)
            completed = main.run_one_click_cleanup_job_once(response.json()["cleanup_job_id"])
        self.assertEqual(completed["status"], "failed")
        self.assertIn("recycle bin unavailable", completed["error"])
        self.assertTrue(orphan.exists())

    def test_orphan_list_route_stays_deprecated_and_batch_delete_skips_unknown_files(self):
        orphan = self.write_image(self.generated / "legacy-route.png")
        listed = self.client.get("/api/canvas-assets/orphans")
        deleted = self.client.post(
            "/api/canvas-assets/orphans/delete",
            json={"urls": ["/api/storage-files/generated/legacy-route.png"]},
        )
        self.assertEqual(listed.status_code, 410, listed.text)
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(deleted.json()["deleted"], [])
        self.assertEqual(deleted.json()["skipped"], ["/api/storage-files/generated/legacy-route.png"])
        self.assertTrue(orphan.exists())

    def test_canvas_logs_are_not_storage_ownership_and_history_is_preserved(self):
        canvas_dir = self.data / "canvases"
        canvas_dir.mkdir(parents=True, exist_ok=True)
        active = self.write_image(self.generated / "active.png")
        deleted = self.write_image(self.generated / "deleted.png")
        canvas_id = "canvas-log-preserved"
        canvas_record = {
            "id": canvas_id,
            "nodes": [{"id": "keep", "type": "image", "url": "/api/storage-files/generated/active.png"}],
            "logs": [{
                "id": "log-1",
                "outputs": [{"url": "/api/storage-files/generated/deleted.png"}],
                "refs": [{"url": "/assets/input/deleted-reference.png"}],
                "prompt": "保留日志文本",
            }],
        }
        (canvas_dir / f"{canvas_id}.json").write_text(
            json.dumps(canvas_record),
            encoding="utf-8",
        )
        history_record = {
            "images": ["/api/storage-files/generated/deleted.png"],
            "source_type": "canvas-online-image",
            "source_task_id": "canvas_img_deleted1234",
            "prompt": "保留全局生成记录",
        }
        self.history.write_text(json.dumps([history_record]), encoding="utf-8")

        preview = self.preview("all")

        self.assertTrue(preview["has_targets"])
        self.assertNotIn(active.name, {item["name"] for item in preview["samples"]})
        self.assertIn(deleted.name, {item["name"] for item in preview["samples"]})
        self.assertEqual(preview["summary"]["candidate_by"]["canvas_log_only"], 1)

        response = self.confirm(preview["confirmation_id"])
        self.assertEqual(response.status_code, 202, response.text)
        completed = main.run_one_click_cleanup_job_once(response.json()["cleanup_job_id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertFalse(deleted.exists())
        self.assertTrue(active.exists())
        self.assertEqual(json.loads(self.history.read_text(encoding="utf-8")), [history_record])
        self.assertEqual(json.loads((canvas_dir / f"{canvas_id}.json").read_text(encoding="utf-8")), canvas_record)

    def test_canvas_auto_reconcile_endpoint_is_disabled_without_side_effects(self):
        image = self.write_image(self.generated / "no-auto-delete.png")
        record = {
            "images": ["/api/storage-files/generated/no-auto-delete.png"],
            "source_type": "canvas-online-image",
            "source_task_id": "canvas_img_noauto1234",
        }
        self.history.write_text(json.dumps([record]), encoding="utf-8")
        response = self.client.post(
            "/api/canvas-assets/reconcile-delete",
            json={
                "canvas_id": "canvas-any",
                "task_ids": ["canvas_img_noauto1234"],
                "urls": ["/api/storage-files/generated/no-auto-delete.png"],
            },
        )

        self.assertEqual(response.status_code, 410, response.text)
        self.assertEqual(json.loads(self.history.read_text(encoding="utf-8")), [record])
        self.assertTrue(image.exists())

    def test_running_canvas_task_protects_media_but_completed_task_does_not(self):
        running = self.write_image(self.generated / "running-canvas-task.png")
        completed = self.write_image(self.generated / "completed-canvas-task.png")
        main.CANVAS_TASKS.update({
            "canvas_img_running1234": {
                "type": "online-image",
                "status": "running",
                "results": [{"url": "/api/storage-files/generated/running-canvas-task.png"}],
            },
            "canvas_img_completed1234": {
                "type": "online-image",
                "status": "succeeded",
                "results": [{"url": "/api/storage-files/generated/completed-canvas-task.png"}],
            },
        })

        preview = self.preview("all")
        sample_names = {item["name"] for item in preview["samples"]}
        self.assertNotIn(running.name, sample_names)
        self.assertIn(completed.name, sample_names)

        response = self.confirm(preview["confirmation_id"])
        self.assertEqual(response.status_code, 202, response.text)
        result = main.run_one_click_cleanup_job_once(response.json()["cleanup_job_id"])
        self.assertEqual(result["status"], "succeeded")
        self.assertTrue(running.exists())
        self.assertFalse(completed.exists())


if __name__ == "__main__":
    unittest.main()
