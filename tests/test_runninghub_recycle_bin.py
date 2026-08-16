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


class RunningHubRecycleBinTests(unittest.TestCase):
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
        for key in ("DATA_DIR", "CANVAS_DIR", "OUTPUT_INPUT_DIR", "OUTPUT_OUTPUT_DIR", "OUTPUT_DIR"):
            os.makedirs(self.paths[key], exist_ok=True)
        os.makedirs(os.path.dirname(self.paths["STATIC_RUNNINGHUB_API_PROVIDERS_FILE"]), exist_ok=True)
        self._write_json(self.paths["PROJECTS_PATH"], {"projects": []})
        self._write_json(self.paths["PROMPT_LIBRARY_PATH"], {"active_library_id": "", "libraries": []})
        self._write_json(self.paths["RUNNINGHUB_WORKFLOW_STORE_FILE"], {})
        self._write_json(self.paths["STATIC_RUNNINGHUB_API_PROVIDERS_FILE"], [{
            "id": "runninghub",
            "name": "RunningHub",
            "base_url": "https://www.runninghub.ai",
            "protocol": "runninghub",
            "rh_apps": [],
            "rh_workflows": [],
        }])
        self._write_provider([], [])

    @staticmethod
    def _write_json(path, payload):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)

    def _write_provider(self, apps, workflows):
        self._write_json(self.paths["API_PROVIDERS_FILE"], [{
            "id": "runninghub",
            "name": "RunningHub",
            "base_url": "https://www.runninghub.ai",
            "protocol": "runninghub",
            "enabled": True,
            "image_models": [],
            "chat_models": [],
            "video_models": [],
            "rh_apps": apps,
            "rh_workflows": workflows,
        }])

    def test_recycle_metadata_survives_normalization(self):
        entry = main.normalize_runninghub_entry({
            "id": "workflow-recycled",
            "title": "可恢复工作流",
            "hidden": True,
            "enabled": False,
            "recycled": True,
            "deletedAt": 1786800000000,
            "purged": True,
        }, "workflow")
        self.assertTrue(entry["hidden"])
        self.assertTrue(entry["recycled"])
        self.assertEqual(entry["deletedAt"], 1786800000000)
        self.assertTrue(entry["purged"])

    def test_static_merge_marks_legacy_entries_as_builtin(self):
        merged = main.merge_runninghub_system_entries(
            [{"id": "1997622492837646338", "appId": "1997622492837646338", "title": "内置应用"}],
            [{"id": "1997622492837646338", "appId": "1997622492837646338", "title": "旧版删除记录", "hidden": True}],
            "app",
        )
        self.assertEqual(len(merged), 1)
        self.assertTrue(merged[0]["builtin"])
        self.assertTrue(merged[0]["hidden"])

    def test_retired_legacy_app_stub_is_removed_but_user_defined_same_id_survives(self):
        default_runninghub = next(item for item in main.default_api_providers() if item["id"] == "runninghub")
        self.assertNotIn("1997622492837646338", {item["id"] for item in default_runninghub["rh_apps"]})

        provider = main.normalize_provider({
            "id": "runninghub",
            "base_url": "https://www.runninghub.ai",
            "rh_apps": [{
                "id": "1997622492837646338",
                "appId": "1997622492837646338",
                "title": "2511-光线迁移",
                "enabled": True,
            }],
            "rh_workflows": [],
        })
        self.assertNotIn("1997622492837646338", {item["id"] for item in provider["rh_apps"]})

        provider = main.normalize_provider({
            "id": "runninghub",
            "base_url": "https://www.runninghub.ai",
            "rh_apps": [{
                "id": "1997622492837646338",
                "appId": "1997622492837646338",
                "title": "我重新添加的应用",
                "enabled": True,
                "userDefined": True,
            }],
            "rh_workflows": [],
        })
        self.assertIn("1997622492837646338", {item["id"] for item in provider["rh_apps"]})

    def test_recycled_workflow_store_is_kept_but_purged_store_is_removed(self):
        self._write_json(self.paths["RUNNINGHUB_WORKFLOW_STORE_FILE"], {
            "workflow-live": {"workflowId": "workflow-live", "workflowJson": {"1": {}}},
            "workflow-recycled": {"workflowId": "workflow-recycled", "workflowJson": {"2": {}}},
            "workflow-purged": {"workflowId": "workflow-purged", "workflowJson": {"3": {}}},
        })
        provider = {
            "id": "runninghub",
            "rh_workflows": [
                {"id": "workflow-live", "workflowId": "workflow-live"},
                {"id": "workflow-recycled", "workflowId": "workflow-recycled", "hidden": True, "recycled": True},
                {"id": "workflow-purged", "workflowId": "workflow-purged", "hidden": True, "purged": True},
            ],
        }
        main.prune_runninghub_workflow_store_for_provider(provider)
        with open(self.paths["RUNNINGHUB_WORKFLOW_STORE_FILE"], "r", encoding="utf-8") as handle:
            store = json.load(handle)
        self.assertEqual(set(store), {"workflow-live", "workflow-recycled"})

    def test_normal_backup_options_and_archive_exclude_recycled_entries(self):
        self._write_provider(
            [
                {"id": "app-live", "appId": "app-live", "title": "正常应用"},
                {"id": "app-recycled", "appId": "app-recycled", "title": "已删除应用", "hidden": True, "recycled": True},
            ],
            [
                {"id": "workflow-live", "workflowId": "workflow-live", "title": "正常工作流"},
                {"id": "workflow-recycled", "workflowId": "workflow-recycled", "title": "已删除工作流", "hidden": True, "recycled": True},
            ],
        )
        options = main.backup_options_payload()["runninghub"]
        self.assertEqual([item["id"] for item in options["apps"]], ["app-live"])
        self.assertEqual([item["id"] for item in options["workflows"]], ["workflow-live"])

        payload = main.BackupExportRequest(
            runninghub_app_ids=["app-live", "app-recycled"],
            runninghub_workflow_ids=["workflow-live", "workflow-recycled"],
        )
        archive_path, _filename = main.build_backup_archive(payload)
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))
        with zipfile.ZipFile(archive_path, "r") as archive:
            exported = json.loads(archive.read("configs/runninghub.json").decode("utf-8"))
        self.assertEqual([item["id"] for item in exported["apps"]], ["app-live"])
        self.assertEqual([item["id"] for item in exported["workflows"]], ["workflow-live"])

    def test_old_backup_preview_and_import_ignore_hidden_entries(self):
        manifest = {
            "format": main.backup_io.BACKUP_FORMAT,
            "version": main.backup_io.BACKUP_VERSION,
            "backup_id": "legacy-hidden-backup",
            "created_at": 1,
            "projects": [],
            "providers": [],
            "runninghub": {
                "apps": [{"id": "app-live", "title": "正常应用"}, {"id": "app-hidden", "title": "旧隐藏应用"}],
                "workflows": [{"id": "workflow-live", "title": "正常工作流"}, {"id": "workflow-hidden", "title": "旧隐藏工作流"}],
            },
            "prompt_libraries": [],
            "resources": [],
            "missing_resources": [],
            "configs": {"runninghub": "configs/runninghub.json"},
        }
        runninghub_payload = {
            "apps": [
                {"id": "app-live", "appId": "app-live", "title": "正常应用"},
                {"id": "app-hidden", "appId": "app-hidden", "title": "旧隐藏应用", "hidden": True},
            ],
            "workflows": [
                {"id": "workflow-live", "workflowId": "workflow-live", "title": "正常工作流", "workflowJson": {"1": {}}},
                {"id": "workflow-hidden", "workflowId": "workflow-hidden", "title": "旧隐藏工作流", "hidden": True, "workflowJson": {"2": {}}},
            ],
        }
        archive_path = os.path.join(self.temp.name, "legacy.zip")
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
            archive.writestr("configs/runninghub.json", json.dumps(runninghub_payload, ensure_ascii=False))

        inspected = main.inspect_backup_path(archive_path)["backup"]["runninghub"]
        self.assertEqual([item["id"] for item in inspected["apps"]], ["app-live"])
        self.assertEqual([item["id"] for item in inspected["workflows"]], ["workflow-live"])

        result = main.import_backup_path(archive_path, {
            "project_ids": [],
            "canvas_ids": [],
            "provider_ids": [],
            "runninghub_app_ids": ["app-live", "app-hidden"],
            "runninghub_workflow_ids": ["workflow-live", "workflow-hidden"],
            "prompt_library_ids": [],
            "include_assets": False,
            "runninghub_conflict": "backup",
        })
        self.assertTrue(result["providers_changed"])
        with open(self.paths["API_PROVIDERS_FILE"], "r", encoding="utf-8") as handle:
            provider = next(item for item in json.load(handle) if item["id"] == "runninghub")
        self.assertIn("app-live", {item["id"] for item in provider["rh_apps"]})
        self.assertNotIn("app-hidden", {item["id"] for item in provider["rh_apps"]})
        self.assertIn("workflow-live", {item["id"] for item in provider["rh_workflows"]})
        self.assertNotIn("workflow-hidden", {item["id"] for item in provider["rh_workflows"]})

    def test_backup_restore_clears_static_purged_workflow_marker(self):
        workflow_id = "workflow-restored"
        self._write_json(self.paths["STATIC_RUNNINGHUB_API_PROVIDERS_FILE"], [{
            "id": "runninghub",
            "name": "RunningHub",
            "base_url": "https://www.runninghub.ai",
            "protocol": "runninghub",
            "rh_apps": [],
            "rh_workflows": [{
                "id": workflow_id,
                "workflowId": workflow_id,
                "title": "旧删除工作流",
                "purged": True,
                "enabled": False,
            }],
        }])
        manifest = {
            "format": main.backup_io.BACKUP_FORMAT,
            "version": main.backup_io.BACKUP_VERSION,
            "backup_id": "restore-purged-workflow",
            "created_at": 1,
            "projects": [],
            "providers": [],
            "runninghub": {"apps": [], "workflows": [{"id": workflow_id, "title": "恢复工作流"}]},
            "prompt_libraries": [],
            "resources": [],
            "missing_resources": [],
            "configs": {"runninghub": "configs/runninghub.json"},
        }
        runninghub_payload = {
            "base_url": "https://www.runninghub.ai",
            "apps": [],
            "workflows": [{
                "id": workflow_id,
                "workflowId": workflow_id,
                "title": "恢复工作流",
                "fields": [{"id": "node::text", "nodeId": "node", "fieldName": "text", "fieldValue": "hello"}],
                "workflowJson": {"node": {"class_type": "Text", "inputs": {"text": "hello"}}},
            }],
        }
        archive_path = os.path.join(self.temp.name, "restore-purged.zip")
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
            archive.writestr("configs/runninghub.json", json.dumps(runninghub_payload, ensure_ascii=False))

        result = main.import_backup_path(archive_path, {
            "project_ids": [],
            "canvas_ids": [],
            "provider_ids": [],
            "runninghub_app_ids": [],
            "runninghub_workflow_ids": [workflow_id],
            "prompt_library_ids": [],
            "include_assets": False,
            "runninghub_conflict": "backup",
        })
        self.assertEqual(result["runninghub_workflows_imported"], 1)

        with open(self.paths["STATIC_RUNNINGHUB_API_PROVIDERS_FILE"], "r", encoding="utf-8") as handle:
            static_provider = json.load(handle)[0]
        static_entry = next((item for item in static_provider["rh_workflows"] if item.get("id") == workflow_id), None)
        self.assertTrue(static_entry is None or static_entry.get("purged") is not True)
        visible = main.backup_options_payload()["runninghub"]["workflows"]
        self.assertIn(workflow_id, {item["id"] for item in visible})


if __name__ == "__main__":
    unittest.main()
