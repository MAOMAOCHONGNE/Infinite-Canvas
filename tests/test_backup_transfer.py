import copy
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import backup_transfer


class BackupTransferTests(unittest.TestCase):
    def test_recursive_sanitizer_never_exports_credentials_or_inline_images(self):
        raw = {
            "id": "provider-a",
            "base_url": "https://example.test/v1?token=secret&mode=ok",
            "api_key": "DO_NOT_EXPORT",
            "nested": {
                "Authorization": "Bearer DO_NOT_EXPORT",
                "rh_comfy_auth": "DO_NOT_EXPORT",
                "session_token": "DO_NOT_EXPORT",
                "proxy_authorization": "DO_NOT_EXPORT",
                "password": "DO_NOT_EXPORT",
                "safe": "kept",
                "preview": "data:image/png;base64,DO_NOT_EXPORT",
            },
        }

        clean = backup_transfer.sanitize_portable_config(raw)
        encoded = str(clean)

        self.assertEqual(clean["id"], "provider-a")
        self.assertEqual(clean["nested"]["safe"], "kept")
        self.assertNotIn("DO_NOT_EXPORT", encoded)
        self.assertNotIn("api_key", clean)
        self.assertNotIn("Authorization", clean["nested"])
        self.assertNotIn("rh_comfy_auth", clean["nested"])
        self.assertNotIn("session_token", clean["nested"])
        self.assertNotIn("proxy_authorization", clean["nested"])
        self.assertEqual(clean["nested"]["preview"], "")
        self.assertEqual(clean["base_url"], "https://example.test/v1?mode=ok")

    def test_resource_collection_is_local_only_and_deduplicated(self):
        value = {
            "url": "/assets/input/a.png",
            "items": [
                "/assets/input/a.png",
                "/output/b.mp4?download=1",
                "https://remote.example/image.png",
                "data:image/png;base64,abc",
            ],
        }

        self.assertEqual(
            backup_transfer.collect_local_resource_urls(value),
            ["/assets/input/a.png", "/output/b.mp4?download=1"],
        )

    def test_nested_url_rewrite_does_not_mutate_source(self):
        source = {"url": "/assets/a.png", "items": ["/output/b.mp4", "remote"]}
        original = copy.deepcopy(source)
        rewritten = backup_transfer.rewrite_nested_values(
            source,
            {"/assets/a.png": "/assets/input/backup/aa.png", "/output/b.mp4": "/assets/input/backup/bb.mp4"},
        )

        self.assertEqual(source, original)
        self.assertEqual(rewritten["url"], "/assets/input/backup/aa.png")
        self.assertEqual(rewritten["items"][0], "/assets/input/backup/bb.mp4")
        self.assertEqual(rewritten["items"][1], "remote")

    def test_imported_canvas_gets_fresh_identity_and_no_runtime_state(self):
        canvas = {
            "id": "old-canvas",
            "project": "old-project",
            "deleted_at": 123,
            "logs": [{"message": "private history"}],
            "nodes": [{
                "id": "node-1",
                "type": "generator",
                "running": True,
                "llmTask": {"id": "task-1"},
                "runStartedAt": 10,
                "runFinishedAt": 20,
                "runElapsedMs": 10,
                "url": "/assets/a.png",
            }],
        }

        imported = backup_transfer.prepare_imported_canvas(
            canvas,
            new_canvas_id="new-canvas",
            new_project_id="new-project",
            timestamp=999,
            url_mapping={"/assets/a.png": "/assets/input/backup/a.png"},
        )

        self.assertEqual(imported["id"], "new-canvas")
        self.assertEqual(imported["project"], "new-project")
        self.assertEqual(imported["created_at"], 999)
        self.assertEqual(imported["updated_at"], 999)
        self.assertEqual(imported["logs"], [])
        self.assertNotIn("deleted_at", imported)
        self.assertFalse(imported["nodes"][0]["running"])
        self.assertNotIn("llmTask", imported["nodes"][0])
        self.assertNotIn("runStartedAt", imported["nodes"][0])
        self.assertEqual(imported["nodes"][0]["url"], "/assets/input/backup/a.png")

    def test_archive_member_validation_blocks_traversal_and_absolute_paths(self):
        for unsafe in ("../evil.json", "folder/../../evil", "/absolute/file", "C:/windows/file"):
            with self.subTest(unsafe=unsafe):
                self.assertFalse(backup_transfer.is_safe_archive_member(unsafe))
        self.assertTrue(backup_transfer.is_safe_archive_member("resources/ab/file.png"))

    def test_import_name_is_predictable_without_overwriting(self):
        names = {"A项目", "A项目（导入）", "A项目（导入 2）"}
        self.assertEqual(backup_transfer.next_import_name("A项目", names), "A项目（导入 3）")
        self.assertEqual(backup_transfer.next_import_name("B项目", names), "B项目")

    def test_prompt_library_merge_skips_identical_and_keeps_different_same_name(self):
        existing = {
            "active_library_id": "system",
            "libraries": [{
                "id": "system",
                "name": "系统提示词库",
                "categories": [{"id": "custom", "name": "我的"}],
                "items": [
                    {"id": "same", "name": "海报", "category": "custom", "positive": "文字A"},
                    {"id": "local", "name": "商品", "category": "custom", "positive": "本机文字"},
                ],
            }],
        }
        incoming = {
            "active_library_id": "system",
            "libraries": [{
                "id": "system",
                "name": "系统提示词库",
                "categories": [{"id": "custom", "name": "我的"}],
                "items": [
                    {"id": "same", "name": "海报", "category": "custom", "positive": "文字A"},
                    {"id": "other", "name": "商品", "category": "custom", "positive": "备份文字"},
                ],
            }],
        }

        merged, stats = backup_transfer.merge_prompt_libraries(existing, incoming)
        items = merged["libraries"][0]["items"]

        self.assertEqual(stats["skipped_identical"], 1)
        self.assertEqual(stats["imported"], 1)
        self.assertEqual(len(items), 3)
        imported = next(item for item in items if item["positive"] == "备份文字")
        self.assertEqual(imported["name"], "商品（导入）")
        self.assertNotEqual(imported["id"], "other")


if __name__ == "__main__":
    unittest.main()
