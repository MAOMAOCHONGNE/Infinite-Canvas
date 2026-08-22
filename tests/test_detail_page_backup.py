import copy
import json
import os
import sys
import tempfile
import unittest
import zipfile
import socket
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import backup_transfer
import main


def detail_task(task_id="detail_page_source", group_no=7, status="succeeded", media_url="/assets/input/shared.png"):
    return {
        "id": task_id,
        "type": "detail-page",
        "title": "圣诞香水详情页",
        "group_no": group_no,
        "status": status,
        "created_at": 100.0,
        "updated_at": 200.0,
        "runtime_id": "old-runtime",
        "submission_id": "2da0d10d-22a1-45c1-ac47-f352564585c4",
        "submission_ids": ["2da0d10d-22a1-45c1-ac47-f352564585c4"],
        "config_fingerprint": "old-fingerprint",
        "settings": {
            "product_images": [media_url],
            "reference_images": [],
            "product_image_meta": [{"url": media_url, "name": "产品.png", "width": 100, "height": 120}],
            "reference_image_meta": [],
            "image_provider_id": "provider-a",
            "llm_provider_id": "provider-a",
            "image_model": "image-a",
            "product_name": "圣诞香水",
            "product_features": "透明瓶身",
            "user_instruction": "节日氛围",
        },
        "request_preview": {"analysis": "保留规划摘要"},
        "screens": [{
            "screen_no": 1,
            "status": status,
            "prompt": "圣诞香水海报",
            "result": {"images": [media_url], "provider_id": "provider-a"},
            "selected_candidate": 0,
            "candidates": [{
                "id": "candidate-a",
                "status": status,
                "image_url": media_url,
                "result": {"images": [media_url]},
                "generation_params": {"provider_id": "provider-a", "prompt": "完整提示词"},
                "provider_snapshot": {"base_url": "https://example.test/v1?token=secret", "api_key": "never-export"},
                "upstream_task_id": "upstream-old",
            }],
        }],
        "error": "",
        "cancel_requested": False,
        "api_key": "never-export",
    }


class DetailPageBackupPureTests(unittest.TestCase):
    def test_detail_media_collection_is_field_scoped_and_deduplicated(self):
        task = detail_task(media_url="/assets/input/shared.png")
        task["screens"][0]["candidates"][0]["image_url"] = "https://files.example/result.png"
        task["screens"][0]["prompt"] = "不要抓取 https://prompt.example/not-media.png"
        task["settings"]["provider_url"] = "https://api.example/v1"

        self.assertEqual(
            backup_transfer.collect_detail_page_media_urls(task),
            ["/assets/input/shared.png", "https://files.example/result.png"],
        )

    def test_exported_detail_task_keeps_history_but_strips_credentials_and_runtime(self):
        task = detail_task()
        task["screens"][0]["candidates"][0]["result"]["b64_json"] = "base64-secret-image"
        task["screens"][0]["candidates"][0]["raw"] = {"secret": "raw-platform-response"}
        task["screens"][0]["candidates"][0]["netWssUrl"] = "wss://temp.example/ws?token=secret"
        clean = backup_transfer.prepare_exported_detail_task(task)
        encoded = json.dumps(clean, ensure_ascii=False)

        self.assertEqual(clean["title"], "圣诞香水详情页")
        self.assertEqual(clean["screens"][0]["prompt"], "圣诞香水海报")
        self.assertNotIn("api_key", encoded.lower())
        self.assertNotIn("never-export", encoded)
        self.assertNotIn("token=secret", encoded)
        self.assertNotIn("runtime_id", clean)
        self.assertNotIn("submission_id", clean)
        self.assertNotIn("config_fingerprint", clean)
        self.assertNotIn("base64-secret-image", encoded)
        self.assertNotIn("raw-platform-response", encoded)
        self.assertNotIn("temp.example", encoded)

    def test_imported_active_detail_task_gets_fresh_identity_and_cannot_resume(self):
        source = detail_task(status="generating")
        source["screens"][0]["status"] = "generating"
        source["screens"][0]["candidates"][0]["status"] = "recovering"
        imported = backup_transfer.prepare_imported_detail_task(
            source,
            new_task_id="detail_page_new",
            new_submission_id="7f4da6f6-c6cb-429a-b4fd-340c1e7ba66a",
            new_group_no=31,
            runtime_id="new-runtime",
            imported_at=999.0,
            url_mapping={"/assets/input/shared.png": "/assets/input/backup_resources/shared.png"},
            provider_id_map={"provider-a": "provider-a-2"},
        )

        self.assertEqual(imported["id"], "detail_page_new")
        self.assertEqual(imported["submission_id"], "7f4da6f6-c6cb-429a-b4fd-340c1e7ba66a")
        self.assertEqual(imported["group_no"], 31)
        self.assertEqual(imported["status"], "interrupted")
        self.assertEqual(imported["screens"][0]["status"], "interrupted")
        self.assertEqual(imported["screens"][0]["candidates"][0]["status"], "interrupted")
        self.assertEqual(imported["settings"]["product_images"], ["/assets/input/backup_resources/shared.png"])
        self.assertEqual(imported["settings"]["image_provider_id"], "provider-a-2")
        self.assertEqual(imported["settings"]["llm_provider_id"], "provider-a-2")
        self.assertEqual(imported["imported_from"]["task_id"], "detail_page_source")
        self.assertEqual(imported["imported_from"]["group_no"], 7)
        self.assertFalse(imported["cancel_requested"])


class DetailPageBackupServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = self.temp.name
        self.paths = {
            "DATA_DIR": os.path.join(root, "data"),
            "CANVAS_DIR": os.path.join(root, "data", "canvases"),
            "PROJECTS_PATH": os.path.join(root, "data", "projects.json"),
            "API_PROVIDERS_FILE": os.path.join(root, "data", "api_providers.json"),
            "PROMPT_LIBRARY_PATH": os.path.join(root, "data", "prompt_libraries.json"),
            "RUNNINGHUB_WORKFLOW_STORE_FILE": os.path.join(root, "data", "runninghub_workflows.json"),
            "BACKUP_HISTORY_PATH": os.path.join(root, "data", "backup_import_history.json"),
            "ASSETS_DIR": os.path.join(root, "assets"),
            "OUTPUT_INPUT_DIR": os.path.join(root, "assets", "input"),
            "OUTPUT_OUTPUT_DIR": os.path.join(root, "assets", "output"),
            "OUTPUT_DIR": os.path.join(root, "output"),
            "DETAIL_PAGE_TASK_DIR": os.path.join(root, "data", "detail_page_tasks"),
            "STATIC_RUNNINGHUB_API_PROVIDERS_FILE": os.path.join(root, "static", "runninghub", "api_providers.json"),
            "CANVAS_TASKS": {},
        }
        self.patchers = [patch.object(main, key, value) for key, value in self.paths.items()]
        for item in self.patchers:
            item.start()
            self.addCleanup(item.stop)
        for path in (
            self.paths["CANVAS_DIR"], self.paths["OUTPUT_INPUT_DIR"], self.paths["OUTPUT_OUTPUT_DIR"],
            self.paths["OUTPUT_DIR"], self.paths["DETAIL_PAGE_TASK_DIR"],
            os.path.dirname(self.paths["STATIC_RUNNINGHUB_API_PROVIDERS_FILE"]),
        ):
            os.makedirs(path, exist_ok=True)
        with open(self.paths["PROJECTS_PATH"], "w", encoding="utf-8") as handle:
            json.dump({"projects": [{"id": "project-a", "name": "A项目", "order": 1}]}, handle)
        with open(self.paths["API_PROVIDERS_FILE"], "w", encoding="utf-8") as handle:
            json.dump([{"id": "provider-a", "name": "A平台", "base_url": "https://example.test/v1", "protocol": "openai", "enabled": True, "image_models": ["image-a"], "chat_models": [], "video_models": []}], handle)
        with open(self.paths["PROMPT_LIBRARY_PATH"], "w", encoding="utf-8") as handle:
            json.dump({"active_library_id": "", "libraries": []}, handle)
        with open(self.paths["RUNNINGHUB_WORKFLOW_STORE_FILE"], "w", encoding="utf-8") as handle:
            json.dump({}, handle)
        media_path = os.path.join(self.paths["OUTPUT_INPUT_DIR"], "shared.png")
        with open(media_path, "wb") as handle:
            handle.write(b"shared-detail-image")
        self.source = detail_task(media_url="/assets/input/shared.png")
        main.CANVAS_TASKS[self.source["id"]] = copy.deepcopy(self.source)
        main.detail_page_persist_task(self.source)
        main.detail_page_write_next_group_no(8)

    def export_detail(self, include_assets=True):
        archive_path, _ = main.build_backup_archive(main.BackupExportRequest(
            detail_page_task_ids=[self.source["id"]],
            include_assets=include_assets,
        ))
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))
        return archive_path

    def test_options_and_v2_archive_include_detail_history_and_deduplicated_media(self):
        options = main.backup_options_payload()
        self.assertEqual(options["detail_pages"][0]["id"], self.source["id"])
        self.assertEqual(options["detail_pages"][0]["group_no"], 7)

        archive_path = self.export_detail()
        with zipfile.ZipFile(archive_path, "r") as archive:
            manifest = json.loads(archive.read("manifest.json"))
            exported = json.loads(archive.read(f"detail-pages/{self.source['id']}.json"))
        self.assertEqual(manifest["version"], 2)
        self.assertEqual(len(manifest["detail_pages"]), 1)
        self.assertEqual(len(manifest["resources"]), 1)
        self.assertEqual(exported["title"], "圣诞香水详情页")
        self.assertNotIn("never-export", json.dumps(exported))
        inspected = main.inspect_backup_path(archive_path)
        self.assertEqual(inspected["backup"]["detail_page_count"], 1)

    def test_archive_without_details_remains_v1(self):
        archive_path, _ = main.build_backup_archive(main.BackupExportRequest(include_preferences=True, preferences={"theme": "light"}))
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))
        with zipfile.ZipFile(archive_path, "r") as archive:
            manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["version"], 1)

    def test_import_creates_independent_detail_copy_and_rewrites_media(self):
        archive_path = self.export_detail()
        result = main.import_backup_path(archive_path, {
            "detail_page_task_ids": [self.source["id"]],
            "include_assets": True,
        })
        self.assertEqual(result["detail_pages"], 1)
        imported_ids = [task_id for task_id in main.CANVAS_TASKS if task_id != self.source["id"]]
        self.assertEqual(len(imported_ids), 1)
        imported = main.CANVAS_TASKS[imported_ids[0]]
        self.assertNotEqual(imported["id"], self.source["id"])
        self.assertNotEqual(imported["submission_id"], self.source["submission_id"])
        self.assertEqual(imported["group_no"], 8)
        self.assertEqual(imported["title"], self.source["title"])
        self.assertTrue(imported["settings"]["product_images"][0].startswith("/assets/input/backup_resources/"))
        self.assertTrue(os.path.isfile(main.detail_page_task_file(imported["id"])))

    def test_import_refuses_to_exceed_200_records_without_writes(self):
        archive_path = self.export_detail()
        main.CANVAS_TASKS.clear()
        for index in range(200):
            task = detail_task(task_id=f"detail_page_existing_{index:04d}", group_no=index + 1)
            main.CANVAS_TASKS[task["id"]] = task
        before = set(os.listdir(self.paths["DETAIL_PAGE_TASK_DIR"]))
        with self.assertRaisesRegex(ValueError, "200"):
            main.import_backup_path(archive_path, {"detail_page_task_ids": [self.source["id"]]})
        self.assertEqual(set(os.listdir(self.paths["DETAIL_PAGE_TASK_DIR"])), before)
        self.assertEqual(len(main.CANVAS_TASKS), 200)

    def test_repeat_import_creates_independent_copies_and_never_reuses_group_number(self):
        archive_path = self.export_detail()
        first = main.import_backup_path(archive_path, {"detail_page_task_ids": [self.source["id"]]})
        second = main.import_backup_path(archive_path, {"detail_page_task_ids": [self.source["id"]]})

        self.assertEqual(first["detail_pages"], 1)
        self.assertEqual(second["detail_pages"], 1)
        imported = [task for task_id, task in main.CANVAS_TASKS.items() if task_id != self.source["id"]]
        self.assertEqual(sorted(task["group_no"] for task in imported), [8, 9])
        self.assertEqual(len({task["id"] for task in imported}), 2)
        self.assertEqual(len({task["submission_id"] for task in imported}), 2)

    def test_import_without_media_keeps_record_and_marks_missing_images(self):
        archive_path = self.export_detail(include_assets=False)
        result = main.import_backup_path(archive_path, {
            "detail_page_task_ids": [self.source["id"]],
            "include_assets": False,
        })
        imported = main.CANVAS_TASKS[result["detail_page_task_ids"][0]]
        self.assertEqual(result["detail_page_missing_media"], 1)
        self.assertEqual(imported["import_missing_media"], ["/assets/input/shared.png"])
        self.assertIn("媒体文件未包含", imported["import_warning"])

    def test_active_export_import_is_interrupted_and_cannot_resume_upstream(self):
        active = copy.deepcopy(self.source)
        active["status"] = "generating"
        active["screens"][0]["status"] = "generating"
        active["screens"][0]["candidates"][0]["status"] = "recovering"
        main.CANVAS_TASKS[active["id"]] = active
        archive_path = self.export_detail()

        result = main.import_backup_path(archive_path, {"detail_page_task_ids": [active["id"]]})
        imported = main.CANVAS_TASKS[result["detail_page_task_ids"][0]]
        self.assertEqual(imported["status"], "interrupted")
        self.assertEqual(imported["screens"][0]["status"], "interrupted")
        self.assertEqual(imported["screens"][0]["candidates"][0]["status"], "interrupted")
        self.assertNotIn("upstream_task_id", imported["screens"][0]["candidates"][0])
        self.assertNotIn("provider_snapshot", imported["screens"][0]["candidates"][0])

    def test_remote_download_failure_is_reported_without_blocking_archive(self):
        remote = "https://images.example.test/result.png"
        task = detail_task(media_url=remote)
        main.CANVAS_TASKS[task["id"]] = task
        with patch.object(main, "backup_download_public_image", side_effect=ValueError("offline")):
            archive_path, _ = main.build_backup_archive(main.BackupExportRequest(
                detail_page_task_ids=[task["id"]], include_assets=True,
            ))
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))
        with zipfile.ZipFile(archive_path, "r") as archive:
            manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["missing_resources"], [remote])
        self.assertEqual(manifest["detail_pages"][0]["id"], task["id"])

    def test_public_media_validation_rejects_private_addresses(self):
        answer = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
        with patch.object(main.socket, "getaddrinfo", return_value=answer):
            with self.assertRaisesRegex(ValueError, "局域网"):
                main.backup_validate_public_media_url("https://example.test/image.png")

    def test_detail_import_rolls_back_records_and_group_counter_on_second_write_failure(self):
        second = detail_task(task_id="detail_page_source_two", group_no=9)
        real_persist = main.detail_page_persist_task
        calls = {"count": 0}

        def fail_second(task):
            calls["count"] += 1
            if calls["count"] == 2:
                raise OSError("simulated disk failure")
            return real_persist(task)

        with open(main.detail_page_group_meta_file(), "rb") as handle:
            before_meta = handle.read()
        before_ids = set(main.CANVAS_TASKS)
        before_task_files = sorted(
            name for name in os.listdir(self.paths["DETAIL_PAGE_TASK_DIR"])
            if name.startswith("detail_page_")
        )
        with patch.object(main, "detail_page_persist_task", side_effect=fail_second):
            with self.assertRaisesRegex(OSError, "simulated"):
                main.backup_import_detail_pages(
                    [self.source, second],
                    url_mapping={}, provider_id_map={}, unavailable_urls=set(),
                )
        self.assertEqual(set(main.CANVAS_TASKS), before_ids)
        with open(main.detail_page_group_meta_file(), "rb") as handle:
            self.assertEqual(handle.read(), before_meta)
        self.assertEqual(main.detail_page_read_next_group_no(), 8)
        self.assertEqual(
            sorted(name for name in os.listdir(self.paths["DETAIL_PAGE_TASK_DIR"]) if name.startswith("detail_page_")),
            before_task_files,
        )


if __name__ == "__main__":
    unittest.main()
