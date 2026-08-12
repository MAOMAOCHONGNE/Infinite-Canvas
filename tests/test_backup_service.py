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

import main


class BackupServiceIntegrationTests(unittest.TestCase):
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
            "STATIC_RUNNINGHUB_API_PROVIDERS_FILE": os.path.join(root, "static", "runninghub", "api_providers.json"),
        }
        self.patchers = [patch.object(main, key, value) for key, value in self.paths.items()]
        for item in self.patchers:
            item.start()
            self.addCleanup(item.stop)
        os.makedirs(self.paths["CANVAS_DIR"], exist_ok=True)
        os.makedirs(self.paths["OUTPUT_INPUT_DIR"], exist_ok=True)
        os.makedirs(self.paths["OUTPUT_OUTPUT_DIR"], exist_ok=True)
        os.makedirs(self.paths["OUTPUT_DIR"], exist_ok=True)
        os.makedirs(os.path.dirname(self.paths["STATIC_RUNNINGHUB_API_PROVIDERS_FILE"]), exist_ok=True)

        with open(self.paths["PROJECTS_PATH"], "w", encoding="utf-8") as handle:
            json.dump({"projects": [{"id": "project-a", "name": "A项目", "order": 1, "created_at": 1, "updated_at": 1}]}, handle, ensure_ascii=False)
        with open(self.paths["API_PROVIDERS_FILE"], "w", encoding="utf-8") as handle:
            json.dump([{
                "id": "provider-a",
                "name": "A平台",
                "base_url": "https://example.test/v1",
                "protocol": "openai",
                "enabled": True,
                "image_models": ["image-a"],
                "chat_models": [],
                "video_models": [],
            }], handle, ensure_ascii=False)
        with open(self.paths["PROMPT_LIBRARY_PATH"], "w", encoding="utf-8") as handle:
            json.dump({
                "active_library_id": "system",
                "libraries": [{
                    "id": "system",
                    "name": "系统提示词库",
                    "type": "prompt",
                    "system": True,
                    "readonly": False,
                    "categories": [{"id": "custom", "name": "我的"}],
                    "items": [{"id": "prompt-a", "name": "模板A", "category": "custom", "positive": "文字A"}],
                }],
            }, handle, ensure_ascii=False)
        asset = os.path.join(self.paths["OUTPUT_INPUT_DIR"], "a.png")
        with open(asset, "wb") as handle:
            handle.write(b"portable-image-bytes")
        canvas = {
            "id": "canvas-a",
            "title": "画布A",
            "kind": "classic",
            "project": "project-a",
            "created_at": 1,
            "updated_at": 1,
            "nodes": [{"id": "image-a", "type": "image", "url": "/assets/input/a.png"}],
            "connections": [],
            "viewport": {"x": 0, "y": 0, "scale": 1},
            "logs": [{"message": "must not migrate"}],
        }
        with open(os.path.join(self.paths["CANVAS_DIR"], "canvas-a.json"), "w", encoding="utf-8") as handle:
            json.dump(canvas, handle, ensure_ascii=False)

    def test_export_inspect_import_creates_safe_copies_and_deduplicates_resources(self):
        payload = main.BackupExportRequest(
            project_ids=["project-a"],
            canvas_ids=["canvas-a"],
            include_assets=True,
            provider_ids=["provider-a"],
            prompt_library_ids=["system"],
        )
        archive_path, _filename = main.build_backup_archive(payload)
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))

        with zipfile.ZipFile(archive_path, "r") as archive:
            manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
            self.assertEqual(manifest["format"], "infinite-canvas-backup")
            self.assertEqual(len(manifest["resources"]), 1)
            self.assertNotIn("must not migrate", archive.read("canvases/canvas-a.json").decode("utf-8"))

        inspected = main.inspect_backup_path(archive_path)
        self.assertEqual(inspected["backup"]["resource_count"], 1)
        self.assertIn("project-a", inspected["conflicts"]["projects"])

        first = main.import_backup_path(archive_path, {})
        second = main.import_backup_path(archive_path, {})
        self.assertEqual(first["canvases"], 1)
        self.assertEqual(second["canvases"], 1)
        self.assertFalse(first["providers_changed"])
        self.assertFalse(second["providers_changed"])

        with open(self.paths["PROJECTS_PATH"], "r", encoding="utf-8") as handle:
            projects = json.load(handle)["projects"]
        self.assertEqual([item["name"] for item in projects], ["A项目", "A项目（导入）", "A项目（导入 2）"])

        canvas_files = sorted(os.listdir(self.paths["CANVAS_DIR"]))
        self.assertEqual(len(canvas_files), 3)
        imported = []
        for filename in canvas_files:
            if filename == "canvas-a.json":
                continue
            with open(os.path.join(self.paths["CANVAS_DIR"], filename), "r", encoding="utf-8") as handle:
                imported.append(json.load(handle))
        self.assertTrue(all(item["logs"] == [] for item in imported))
        imported_urls = {item["nodes"][0]["url"] for item in imported}
        self.assertEqual(len(imported_urls), 1)
        imported_url = next(iter(imported_urls))
        self.assertTrue(imported_url.startswith("/assets/input/backup_resources/"))
        resource_files = []
        resource_root = os.path.join(self.paths["OUTPUT_INPUT_DIR"], "backup_resources")
        for current, _dirs, files in os.walk(resource_root):
            resource_files.extend(os.path.join(current, filename) for filename in files)
        self.assertEqual(len(resource_files), 1)


if __name__ == "__main__":
    unittest.main()
