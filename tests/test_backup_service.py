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

    def test_same_id_different_provider_url_is_cloned_and_imported_canvas_is_remapped(self):
        source_provider = {
            "id": "custom-api",
            "name": "同名平台",
            "base_url": "https://backup.example.org",
            "protocol": "openai",
            "enabled": True,
            "image_models": ["backup-model"],
            "chat_models": [],
            "video_models": [],
        }
        with open(self.paths["API_PROVIDERS_FILE"], "w", encoding="utf-8") as handle:
            json.dump([source_provider], handle, ensure_ascii=False)
        source_canvas = {
            "id": "source-canvas",
            "title": "来源画布",
            "kind": "classic",
            "project": "project-a",
            "created_at": 1,
            "updated_at": 1,
            "nodes": [{"id": "api-node", "type": "generator", "apiProvider": "custom-api"}],
            "connections": [],
            "viewport": {"x": 0, "y": 0, "scale": 1},
        }
        with open(os.path.join(self.paths["CANVAS_DIR"], "source-canvas.json"), "w", encoding="utf-8") as handle:
            json.dump(source_canvas, handle, ensure_ascii=False)
        archive_path, _filename = main.build_backup_archive(main.BackupExportRequest(
            project_ids=["project-a"],
            canvas_ids=["source-canvas"],
            include_assets=False,
            provider_ids=["custom-api"],
        ))
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))

        target_providers = [
            {**source_provider, "base_url": "https://local.example.org", "image_models": ["local-model"]},
            {**source_provider, "id": "custom-api-2", "name": "另一个平台", "base_url": "https://other.example.org"},
        ]
        with open(self.paths["API_PROVIDERS_FILE"], "w", encoding="utf-8") as handle:
            json.dump(target_providers, handle, ensure_ascii=False)
        result = main.import_backup_path(archive_path, {
            "provider_ids": ["custom-api"],
            "project_ids": ["project-a"],
            "canvas_ids": ["source-canvas"],
            "include_assets": False,
            "provider_conflict": "backup",
        })
        self.assertEqual(result["provider_id_map"], {"custom-api": "custom-api-3"})
        self.assertTrue(result["providers_changed"])
        with open(self.paths["API_PROVIDERS_FILE"], "r", encoding="utf-8") as handle:
            providers = json.load(handle)
        self.assertEqual([item["id"] for item in providers], ["custom-api", "custom-api-2", "custom-api-3"])
        self.assertEqual(providers[0]["base_url"], "https://local.example.org")
        with open(os.path.join(self.paths["CANVAS_DIR"], result["provider_id_map"] and next(
            filename for filename in os.listdir(self.paths["CANVAS_DIR"])
            if filename not in {"source-canvas.json", "canvas-a.json"}
        )), "r", encoding="utf-8") as handle:
            imported = json.load(handle)
        self.assertEqual(imported["nodes"][0]["apiProvider"], "custom-api-3")

    def test_runninghub_endpoint_follows_backup_and_clears_both_local_keys(self):
        runninghub_source = {
            "id": "runninghub",
            "name": "RunningHub",
            "base_url": "https://www.runninghub.cn",
            "protocol": "runninghub",
            "enabled": True,
            "image_models": [],
            "chat_models": [],
            "video_models": [],
            "rh_apps": [{"appId": "app-source", "title": "来源应用", "enabled": True}],
            "rh_workflows": [],
        }
        with open(self.paths["API_PROVIDERS_FILE"], "w", encoding="utf-8") as handle:
            json.dump([runninghub_source], handle, ensure_ascii=False)
        archive_path, _filename = main.build_backup_archive(main.BackupExportRequest(
            runninghub_app_ids=["app-source"],
        ))
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))

        runninghub_target = {**runninghub_source, "base_url": "https://www.runninghub.ai", "rh_apps": []}
        with open(self.paths["API_PROVIDERS_FILE"], "w", encoding="utf-8") as handle:
            json.dump([runninghub_target], handle, ensure_ascii=False)
        env_path = os.path.join(self.temp.name, "API.env")
        self.patchers.append(patch.object(main, "API_ENV_FILE", env_path))
        self.patchers[-1].start()
        self.addCleanup(self.patchers[-1].stop)
        with patch.dict(main.os.environ, {"RUNNINGHUB_API_KEY": "local-key", "RUNNINGHUB_WALLET_API_KEY": "wallet-key"}, clear=False):
            result = main.import_backup_path(archive_path, {
                "runninghub_app_ids": ["app-source"],
                "runninghub_conflict": "keep-local",
            })
        self.assertTrue(result["runninghub_endpoint_changed"])
        self.assertTrue(result["runninghub_keys_cleared"])
        with open(self.paths["API_PROVIDERS_FILE"], "r", encoding="utf-8") as handle:
            providers = json.load(handle)
        self.assertEqual(providers[0]["base_url"], "https://www.runninghub.cn")
        with open(env_path, "r", encoding="utf-8") as handle:
            env_text = handle.read()
        self.assertIn('RUNNINGHUB_API_KEY=""\n', env_text)
        self.assertIn('RUNNINGHUB_WALLET_API_KEY=""\n', env_text)

    def test_runninghub_app_import_is_persisted_and_reported(self):
        runninghub_source = {
            "id": "runninghub",
            "name": "RunningHub",
            "base_url": "https://www.runninghub.cn",
            "protocol": "runninghub",
            "enabled": True,
            "rh_apps": [{
                "appId": "app-imported",
                "title": "来源 AI 应用",
                "fields": [{"name": "image", "type": "image", "required": True}],
            }],
            "rh_workflows": [],
        }
        with open(self.paths["API_PROVIDERS_FILE"], "w", encoding="utf-8") as handle:
            json.dump([runninghub_source], handle, ensure_ascii=False)
        archive_path, _filename = main.build_backup_archive(main.BackupExportRequest(
            runninghub_app_ids=["app-imported"],
        ))
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))

        with open(self.paths["API_PROVIDERS_FILE"], "w", encoding="utf-8") as handle:
            json.dump([{**runninghub_source, "rh_apps": []}], handle, ensure_ascii=False)
        result = main.import_backup_path(archive_path, {
            "runninghub_app_ids": ["app-imported"],
            "runninghub_conflict": "backup",
        })

        self.assertTrue(result["runninghub_changed"])
        self.assertEqual(result["runninghub_apps_imported"], 1)
        self.assertEqual(result["runninghub_workflows_imported"], 0)
        with open(self.paths["API_PROVIDERS_FILE"], "r", encoding="utf-8") as handle:
            providers = json.load(handle)
        runninghub = next(item for item in providers if item.get("id") == "runninghub")
        app = next(item for item in runninghub["rh_apps"] if item.get("appId") == "app-imported")
        self.assertEqual(app["appId"], "app-imported")
        self.assertEqual(app["title"], "来源 AI 应用")

    def test_keep_local_reports_skipped_provider_runninghub_and_prompt_counts(self):
        source_provider = {
            "id": "provider-a",
            "name": "A平台备份版",
            "base_url": "https://example.test/v1",
            "protocol": "openai",
            "enabled": True,
            "image_models": ["backup-image"],
            "chat_models": [],
            "video_models": [],
        }
        source_runninghub = {
            "id": "runninghub",
            "name": "RunningHub",
            "base_url": "https://www.runninghub.cn",
            "protocol": "runninghub",
            "enabled": True,
            "image_models": [],
            "chat_models": [],
            "video_models": [],
            "rh_apps": [{"appId": "app-existing", "title": "本机应用"}],
            "rh_workflows": [],
        }
        with open(self.paths["API_PROVIDERS_FILE"], "w", encoding="utf-8") as handle:
            json.dump([source_provider, source_runninghub], handle, ensure_ascii=False)
        archive_path, _filename = main.build_backup_archive(main.BackupExportRequest(
            provider_ids=["provider-a", "runninghub"],
            runninghub_app_ids=["app-existing"],
            prompt_library_ids=["system"],
        ))
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))

        result = main.import_backup_path(archive_path, {
            "provider_ids": ["provider-a", "runninghub"],
            "runninghub_app_ids": ["app-existing"],
            "prompt_library_ids": ["system"],
            "provider_conflict": "keep-local",
            "runninghub_conflict": "keep-local",
        })

        self.assertEqual(result["providers_imported"], 0)
        self.assertEqual(result["providers_skipped"], 1)
        self.assertEqual(result["runninghub_apps_imported"], 0)
        self.assertEqual(result["runninghub_apps_skipped"], 1)
        self.assertEqual(result["prompt_libraries_imported"], 0)
        self.assertEqual(result["prompt_libraries_skipped"], 1)
        self.assertFalse(result["providers_changed"])
        self.assertFalse(result["runninghub_changed"])

    def test_preference_backup_round_trips_without_server_side_user_state(self):
        archive_path, _filename = main.build_backup_archive(main.BackupExportRequest(
            include_preferences=True,
            preferences={
                "theme": "dark",
                "scale_mode": "125",
                "favorites": {"favoriteTypes": ["image", "generator"], "order": ["generator", "image"]},
            },
        ))
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))
        with zipfile.ZipFile(archive_path, "r") as archive:
            manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
            preferences = json.loads(archive.read("configs/preferences.json").decode("utf-8"))
        self.assertTrue(manifest["preferences"]["available"])
        self.assertEqual(preferences["theme"], "dark")
        self.assertEqual(preferences["scale_mode"], "125")
        result = main.import_backup_path(archive_path, {"include_preferences": True})
        self.assertEqual(result["preferences"]["theme"], "dark")
        self.assertEqual(result["preferences"]["favorites"]["favoriteTypes"], ["image", "generator"])


if __name__ == "__main__":
    unittest.main()
