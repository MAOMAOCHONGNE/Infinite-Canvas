import copy
import json
import os
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import backup_transfer
import main


def main_image_task(task_id="main_image_source", group_no=4, status="succeeded", media_url="/assets/input/main.png"):
    return {
        "id": task_id,
        "type": "main-image",
        "title": "电饭锅主图",
        "group_no": group_no,
        "status": status,
        "created_at": 100.0,
        "updated_at": 200.0,
        "runtime_id": "old-runtime",
        "submission_id": "3da0d10d-22a1-45c1-ac47-f352564585c4",
        "submission_ids": ["3da0d10d-22a1-45c1-ac47-f352564585c4"],
        "config_fingerprint": "old-fingerprint",
        "settings": {
            "main_image_mode": "continuous",
            "product_images": [media_url],
            "reference_images": [],
            "product_image_meta": [{"url": media_url, "name": "产品.png", "width": 1024, "height": 1024}],
            "reference_image_meta": [],
            "image_provider_id": "provider-a",
            "llm_provider_id": "provider-a",
            "image_model": "image-a",
            "llm_model": "vision-a",
            "aspect_ratio": "1:1",
            "resolution": "2k",
            "image_count": 1,
            "product_name": "电饭锅",
            "product_facts": "玫瑰金机身",
            "selling_points": "微压精煮",
        },
        "screens": [{
            "screen_no": 1,
            "status": status,
            "prompt": "1:1方形电商连续主图第1屏",
            "result": {"images": [media_url]},
            "selected_candidate": 0,
            "candidates": [{
                "id": "candidate-a",
                "status": status,
                "image_url": media_url,
                "result": {"images": [media_url]},
                "provider_snapshot": {"base_url": "https://example.test/v1?token=secret", "api_key": "never-export"},
                "upstream_task_id": "upstream-old",
            }],
        }],
        "error": "",
        "cancel_requested": False,
        "api_key": "never-export",
    }


class MainImageBackupPureTests(unittest.TestCase):
    def test_export_strips_secrets_and_keeps_prompts_and_media(self):
        task = main_image_task()
        task["screens"][0]["prompt"] += " https://prompt.example/not-media.png"
        task["screens"][0]["candidates"][0]["result"]["b64_json"] = "secret-b64"
        clean = backup_transfer.prepare_exported_main_image_task(task)
        encoded = json.dumps(clean, ensure_ascii=False)
        self.assertEqual(backup_transfer.collect_main_image_media_urls(task), ["/assets/input/main.png"])
        self.assertIn("电商连续主图", clean["screens"][0]["prompt"])
        self.assertNotIn("never-export", encoded)
        self.assertNotIn("secret-b64", encoded)
        self.assertNotIn("upstream-old", encoded)
        self.assertNotIn("runtime_id", clean)

    def test_active_import_becomes_independent_interrupted_copy(self):
        source = main_image_task(status="generating")
        source["screens"][0]["status"] = "generating"
        source["screens"][0]["candidates"][0]["status"] = "recovering"
        imported = backup_transfer.prepare_imported_main_image_task(
            source,
            new_task_id="main_image_new",
            new_submission_id="7f4da6f6-c6cb-429a-b4fd-340c1e7ba66a",
            new_group_no=9,
            runtime_id="new-runtime",
            imported_at=999.0,
            url_mapping={"/assets/input/main.png": "/assets/input/backup_resources/main.png"},
            provider_id_map={"provider-a": "provider-a-2"},
        )
        self.assertEqual(imported["type"], "main-image")
        self.assertEqual(imported["group_no"], 9)
        self.assertEqual(imported["status"], "interrupted")
        self.assertEqual(imported["screens"][0]["candidates"][0]["status"], "interrupted")
        self.assertNotIn("upstream_task_id", imported["screens"][0]["candidates"][0])
        self.assertEqual(imported["settings"]["image_provider_id"], "provider-a-2")


class MainImageBackupServiceTests(unittest.TestCase):
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
            "MAIN_IMAGE_TASK_DIR": os.path.join(root, "data", "main_image_tasks"),
            "STATIC_RUNNINGHUB_API_PROVIDERS_FILE": os.path.join(root, "static", "runninghub", "api_providers.json"),
            "CANVAS_TASKS": {},
        }
        self.patchers = [patch.object(main, key, value) for key, value in self.paths.items()]
        for item in self.patchers:
            item.start()
            self.addCleanup(item.stop)
        for path in (
            self.paths["CANVAS_DIR"], self.paths["OUTPUT_INPUT_DIR"], self.paths["OUTPUT_OUTPUT_DIR"],
            self.paths["OUTPUT_DIR"], self.paths["DETAIL_PAGE_TASK_DIR"], self.paths["MAIN_IMAGE_TASK_DIR"],
            os.path.dirname(self.paths["STATIC_RUNNINGHUB_API_PROVIDERS_FILE"]),
        ):
            os.makedirs(path, exist_ok=True)
        with open(self.paths["PROJECTS_PATH"], "w", encoding="utf-8") as handle:
            json.dump({"projects": []}, handle)
        with open(self.paths["API_PROVIDERS_FILE"], "w", encoding="utf-8") as handle:
            json.dump([{"id": "provider-a", "name": "A平台", "base_url": "https://example.test/v1", "protocol": "openai", "enabled": True, "image_models": ["image-a"], "chat_models": ["vision-a"], "video_models": []}], handle)
        with open(self.paths["PROMPT_LIBRARY_PATH"], "w", encoding="utf-8") as handle:
            json.dump({"active_library_id": "", "libraries": []}, handle)
        with open(self.paths["RUNNINGHUB_WORKFLOW_STORE_FILE"], "w", encoding="utf-8") as handle:
            json.dump({}, handle)
        with open(os.path.join(self.paths["OUTPUT_INPUT_DIR"], "main.png"), "wb") as handle:
            handle.write(b"main-image-data")
        self.source = main_image_task()
        main.CANVAS_TASKS[self.source["id"]] = copy.deepcopy(self.source)
        main.main_image_persist_task(self.source)
        main.main_image_write_next_group_no(5)

    def export_main(self, include_assets=True):
        archive_path, _ = main.build_backup_archive(main.BackupExportRequest(
            main_image_task_ids=[self.source["id"]], include_assets=include_assets,
        ))
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))
        return archive_path

    def test_options_v3_export_and_import_create_independent_copy(self):
        options = main.backup_options_payload()
        self.assertEqual(options["main_images"][0]["group_no"], 4)
        archive_path = self.export_main()
        with zipfile.ZipFile(archive_path, "r") as archive:
            manifest = json.loads(archive.read("manifest.json"))
            exported = json.loads(archive.read(f"main-images/{self.source['id']}.json"))
        self.assertEqual(manifest["version"], 3)
        self.assertEqual(len(manifest["main_images"]), 1)
        self.assertEqual(len(manifest["resources"]), 1)
        self.assertNotIn("never-export", json.dumps(exported))

        result = main.import_backup_path(archive_path, {
            "main_image_task_ids": [self.source["id"]], "include_assets": True,
        })
        self.assertEqual(result["main_images"], 1)
        imported = main.CANVAS_TASKS[result["main_image_task_ids"][0]]
        self.assertEqual(imported["group_no"], 5)
        self.assertNotEqual(imported["id"], self.source["id"])
        self.assertNotEqual(imported["submission_id"], self.source["submission_id"])
        self.assertTrue(imported["settings"]["product_images"][0].startswith("/assets/input/backup_resources/"))

    def test_import_without_media_marks_missing_and_repeat_import_uses_new_numbers(self):
        archive_path = self.export_main(include_assets=False)
        first = main.import_backup_path(archive_path, {"main_image_task_ids": [self.source["id"]], "include_assets": False})
        second = main.import_backup_path(archive_path, {"main_image_task_ids": [self.source["id"]], "include_assets": False})
        first_task = main.CANVAS_TASKS[first["main_image_task_ids"][0]]
        second_task = main.CANVAS_TASKS[second["main_image_task_ids"][0]]
        self.assertEqual(first["main_image_missing_media"], 1)
        self.assertEqual(first_task["group_no"], 5)
        self.assertEqual(second_task["group_no"], 6)
        self.assertNotEqual(first_task["id"], second_task["id"])

    def test_main_image_import_rolls_back_records_and_counter_on_write_failure(self):
        second = main_image_task(task_id="main_image_source_two", group_no=8)
        real_persist = main.main_image_persist_task
        calls = {"count": 0}

        def fail_second(task):
            calls["count"] += 1
            if calls["count"] == 2:
                raise OSError("simulated disk failure")
            return real_persist(task)

        with open(main.main_image_group_meta_file(), "rb") as handle:
            before_meta = handle.read()
        before_ids = set(main.CANVAS_TASKS)
        with patch.object(main, "main_image_persist_task", side_effect=fail_second):
            with self.assertRaisesRegex(OSError, "simulated"):
                main.backup_import_main_images(
                    [self.source, second], url_mapping={}, provider_id_map={}, unavailable_urls=set(),
                )
        self.assertEqual(set(main.CANVAS_TASKS), before_ids)
        with open(main.main_image_group_meta_file(), "rb") as handle:
            self.assertEqual(handle.read(), before_meta)
        self.assertEqual(main.main_image_read_next_group_no(), 5)


if __name__ == "__main__":
    unittest.main()
