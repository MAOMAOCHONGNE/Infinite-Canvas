import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from image_generation_store import ImageGenerationStore
from tests.image_generation_test_seed import ensure_seed


SEED_PATH = ensure_seed(Path(ROOT) / "tests" / "fixtures" / "image-generation-presets-test.json")


class ImageGenerationStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.store = ImageGenerationStore(self.root, SEED_PATH)
        self.store.initialize()
        self.mode_id = next(item["id"] for item in self.store.list_modes() if item["mode_no"] == 25)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_seed_initialization_creates_source_identity_and_does_not_overwrite_local_mode(self):
        initial = self.store.get_mode(self.mode_id, include_admin=True)
        self.assertTrue(initial["builtin"])
        self.assertEqual(initial["source_id"], self.mode_id)
        self.assertEqual(initial["original_version_id"], initial["current_version_id"])

        initial["display_name"] = "本机名称"
        mode_path = next(
            path for path in self.store.mode_dir.glob("*.json")
            if json.loads(path.read_text(encoding="utf-8")).get("id") == self.mode_id
        )
        mode_path.write_text(json.dumps(initial, ensure_ascii=False), encoding="utf-8")
        ImageGenerationStore(self.root, SEED_PATH).initialize()
        self.assertEqual(self.store.get_mode(self.mode_id, include_admin=True)["display_name"], "本机名称")

    def test_new_github_distribution_migrates_only_official_configuration(self):
        local = self.store.get_mode(self.mode_id, include_admin=True)
        local.update({
            "display_name": "本机旧名称",
            "description": "本机旧用途",
            "category": "本机分类",
            "tags": ["本机标签"],
            "sort_order": 999,
            "preset_prompt": "本机旧提示词",
            "status": "archived",
            "example": {"id": "local-example", "mode_id": self.mode_id, "caption": "本机案例"},
        })
        self.store._write_json(self.store._mode_path(self.mode_id), local)
        previous_current_id = local["current_version_id"]
        previous_original_id = local["original_version_id"]

        custom = self.store.duplicate_mode(self.mode_id, "用户自定义模式")
        custom_before = self.store.get_mode(custom["id"], include_admin=True)
        draft = self.store.save_workspace_draft(
            self.mode_id,
            {"inputs": [{"slot_key": "ref1", "media": {"id": "user-media"}}], "user_prompt": "用户输入"},
        )
        task = self.store.save_task({
            "id": "preserved-task", "mode_id": self.mode_id, "status": "succeeded",
            "updated_at": "2026-08-27T12:00:00+00:00", "candidates": [{"id": "candidate-1"}],
        })
        api_key_path = self.root / "API" / ".env"
        api_key_path.parent.mkdir(parents=True, exist_ok=True)
        api_key_path.write_bytes(b"IMAGE_API_KEY=keep-me\n")
        media_path = self.root / "assets" / "image-generation" / "media" / "user-image.bin"
        media_path.parent.mkdir(parents=True, exist_ok=True)
        media_path.write_bytes(b"user-image-bytes")

        protected_before = {
            self.store._workspace_draft_path(self.mode_id): self.store._workspace_draft_path(self.mode_id).read_bytes(),
            self.store._task_path(task["id"]): self.store._task_path(task["id"]).read_bytes(),
            api_key_path: api_key_path.read_bytes(),
            media_path: media_path.read_bytes(),
        }

        release = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        release["distribution_version"] = "2026.08.28"
        release["source_version"] = "2026.08.28"
        official = next(item for item in release["modes"] if item["id"] == self.mode_id)
        official.update({
            "display_name": "官方新名称",
            "description": "官方新用途",
            "category": "官方分类",
            "tags": ["官方标签"],
            "synonyms": ["官方别名"],
            "sort_order": 7,
            "preset_prompt": "官方新提示词",
            "required_reference_count": 1,
            "reference_images": [{"key": "ref1", "label": "官方参考图", "required": True}],
            "max_upload_count": 2,
            "allow_extra_images": True,
            "extra_image_limit": 1,
            "special_hint": "官方提醒",
            "remark": "官方备注",
            "example": {
                "id": "official-example", "mode_id": self.mode_id,
                "caption": "官方注意事项", "input_media": [],
                "output_media": {"url": "/static/image-generation-examples/test/output.png"},
            },
        })
        release_path = self.root / "official-release.json"
        release_path.write_text(json.dumps(release, ensure_ascii=False), encoding="utf-8")

        migrated_store = ImageGenerationStore(self.root, release_path)
        migrated_store.initialize()
        migrated = migrated_store.get_mode(self.mode_id, include_admin=True)
        for field in (
            "display_name", "description", "category", "tags", "synonyms", "sort_order",
            "preset_prompt", "required_reference_count", "reference_images", "max_upload_count",
            "allow_extra_images", "extra_image_limit", "special_hint", "remark", "example",
        ):
            self.assertEqual(migrated[field], official[field], field)
        self.assertEqual(migrated["status"], "archived")
        self.assertEqual(migrated["id"], local["id"])
        self.assertEqual(migrated["mode_no"], local["mode_no"])
        self.assertEqual(migrated["original_version_id"], previous_original_id)
        self.assertNotEqual(migrated["current_version_id"], previous_current_id)
        source_version = migrated_store.get_prompt_version(self.mode_id, migrated["current_version_id"])
        self.assertEqual(source_version["kind"], "source_update")
        self.assertEqual(source_version["parent_version_id"], previous_current_id)
        self.assertEqual(source_version["prompt"], "官方新提示词")
        self.assertIsNotNone(migrated_store.get_prompt_version(self.mode_id, previous_current_id))
        self.assertEqual(migrated_store.get_mode(custom["id"], include_admin=True), custom_before)
        self.assertEqual(migrated_store.load_workspace_draft(self.mode_id), draft)
        self.assertEqual(migrated_store.load_task(task["id"], include_admin=True), task)
        for path, payload in protected_before.items():
            self.assertEqual(path.read_bytes(), payload, str(path))

        version_count = len(migrated_store.list_prompt_versions(self.mode_id))
        migrated_store.initialize()
        self.assertEqual(len(migrated_store.list_prompt_versions(self.mode_id)), version_count)

    def test_github_distribution_migration_rolls_back_mode_and_version_batch(self):
        release = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        release["distribution_version"] = "rollback-test-release"
        release["source_version"] = "rollback-test-release"
        release_path = self.root / "rollback-release.json"
        release_path.write_text(json.dumps(release, ensure_ascii=False), encoding="utf-8")
        before = {
            path: path.read_bytes()
            for directory in (self.store.mode_dir, self.store.version_dir)
            for path in directory.glob("*.json")
        }
        migrating = ImageGenerationStore(self.root, release_path)
        original_write = migrating._write_json
        calls = {"count": 0}

        def fail_second_write(target, value):
            calls["count"] += 1
            if calls["count"] == 2:
                raise OSError("injected GitHub preset migration failure")
            return original_write(target, value)

        with patch.object(migrating, "_write_json", side_effect=fail_second_write):
            with self.assertRaises(OSError):
                migrating.initialize()
        after = {
            path: path.read_bytes()
            for directory in (self.store.mode_dir, self.store.version_dir)
            for path in directory.glob("*.json")
        }
        self.assertEqual(after, before)

    def test_prompt_draft_does_not_change_current_until_activated(self):
        before = self.store.get_mode(self.mode_id, include_admin=True)
        draft = self.store.save_prompt_draft(self.mode_id, "新提示词", note="证件照测试")
        self.assertEqual(
            self.store.get_mode(self.mode_id, include_admin=True)["current_version_id"],
            before["current_version_id"],
        )
        self.store.activate_prompt_draft(self.mode_id, draft["id"])
        after = self.store.get_mode(self.mode_id, include_admin=True)
        self.assertEqual(after["current_version_id"], draft["id"])
        self.assertEqual(after["preset_prompt"], "新提示词")

    def test_direct_admin_settings_save_updates_only_changed_fields_and_keeps_version_ancestry(self):
        self.store.save_example(self.mode_id, {
            "id": "admin-case", "caption": "旧注意事项",
            "input_media": [{"slot_key": "ref1", "media": {"url": "/static/input.png"}}],
            "output_media": {"url": "/static/output.png"},
        })
        before = self.store.get_mode(self.mode_id, include_admin=True)
        before_path = self.store._mode_path(self.mode_id)
        before_bytes = before_path.read_bytes()
        before_versions = self.store.list_prompt_versions(self.mode_id)

        unchanged = self.store.update_mode(self.mode_id, {
            "display_name": before["display_name"],
            "preset_prompt": before["preset_prompt"],
            "status": before["status"],
            "example_caption": before["example"]["caption"],
        })
        self.assertEqual(unchanged, before)
        self.assertEqual(before_path.read_bytes(), before_bytes)
        self.assertEqual(self.store.list_prompt_versions(self.mode_id), before_versions)

        updated = self.store.update_mode(self.mode_id, {
            "display_name": "简化设置模式",
            "sort_order": 12,
            "category": "空间设计",
            "description": "新的用途说明",
            "preset_prompt": "直接生效的新提示词",
            "status": "archived",
            "example_caption": "新的注意事项",
        })
        self.assertEqual(updated["display_name"], "简化设置模式")
        self.assertEqual(updated["sort_order"], 12)
        self.assertEqual(updated["category"], "空间设计")
        self.assertEqual(updated["description"], "新的用途说明")
        self.assertEqual(updated["status"], "archived")
        self.assertEqual(updated["tags"], before["tags"])
        self.assertEqual(updated["example"]["caption"], "新的注意事项")
        self.assertEqual(updated["example"]["input_media"], before["example"]["input_media"])
        self.assertEqual(updated["example"]["output_media"], before["example"]["output_media"])
        self.assertEqual(updated["preset_prompt"], "直接生效的新提示词")
        self.assertNotEqual(updated["current_version_id"], before["current_version_id"])
        version = self.store.get_prompt_version(self.mode_id, updated["current_version_id"])
        self.assertEqual(version["kind"], "admin_update")
        self.assertEqual(version["parent_version_id"], before["current_version_id"])
        self.assertEqual(version["prompt"], "直接生效的新提示词")

    def test_direct_admin_prompt_save_rolls_back_mode_and_version_on_write_failure(self):
        before = {
            path: path.read_bytes()
            for directory in (self.store.mode_dir, self.store.version_dir)
            for path in directory.glob("*.json")
        }
        original_write = self.store._write_json
        calls = {"count": 0}

        def fail_mode_write(target, value):
            calls["count"] += 1
            if calls["count"] == 2:
                raise OSError("injected direct-settings failure")
            return original_write(target, value)

        with patch.object(self.store, "_write_json", side_effect=fail_mode_write):
            with self.assertRaises(OSError):
                self.store.update_mode(self.mode_id, {"preset_prompt": "不能留下的提示词"})
        after = {
            path: path.read_bytes()
            for directory in (self.store.mode_dir, self.store.version_dir)
            for path in directory.glob("*.json")
        }
        self.assertEqual(after, before)

    def test_restore_prompt_version_creates_new_current_version_without_mutating_original(self):
        original = self.store.get_mode(self.mode_id, include_admin=True)
        draft = self.store.save_prompt_draft(self.mode_id, "新提示词")
        self.store.activate_prompt_draft(self.mode_id, draft["id"])
        restored = self.store.restore_prompt_version(self.mode_id, original["original_version_id"])
        current = self.store.get_mode(self.mode_id, include_admin=True)
        self.assertNotEqual(restored["id"], original["original_version_id"])
        self.assertEqual(restored["kind"], "restored")
        self.assertEqual(current["current_version_id"], restored["id"])
        self.assertEqual(current["preset_prompt"], original["preset_prompt"])

    def test_public_mode_reads_strip_prompt_bodies(self):
        encoded = json.dumps(self.store.get_mode(self.mode_id), ensure_ascii=False)
        admin = self.store.get_mode(self.mode_id, include_admin=True)
        self.assertNotIn(admin["preset_prompt"], encoded)
        self.assertNotIn("prompt_versions", encoded)

    def test_mode_and_task_numbers_are_never_reused(self):
        first = self.store.duplicate_mode(self.mode_id, "测试模式A")
        self.store.set_mode_status(first["id"], "trashed")
        second = self.store.duplicate_mode(self.mode_id, "测试模式B")
        self.assertGreater(second["mode_no"], first["mode_no"])
        first_group = self.store.allocate_task_group_no()
        self.assertEqual(self.store.allocate_task_group_no(), first_group + 1)

    def test_workspace_draft_example_and_task_survive_restart(self):
        draft = self.store.save_workspace_draft(self.mode_id, {"user_prompt": "蓝色背景", "inputs": ["media-a"]})
        example = self.store.save_example(self.mode_id, {"title": "示范", "input_media": ["media-a"]})
        task = self.store.save_task({
            "id": "task-1", "mode_id": self.mode_id, "status": "succeeded",
            "updated_at": "2026-08-25T12:00:00+00:00", "name": "证件照",
            "preset_prompt": "only-admin",
        })
        restarted = ImageGenerationStore(self.root, SEED_PATH)
        restarted.initialize()
        self.assertEqual(restarted.load_workspace_draft(self.mode_id), draft)
        self.assertEqual(restarted.get_mode(self.mode_id, include_admin=True)["example"], example)
        self.assertEqual(restarted.load_task(task["id"], include_admin=True)["preset_prompt"], "only-admin")
        self.assertNotIn("only-admin", json.dumps(restarted.load_task(task["id"]), ensure_ascii=False))

    def test_backup_includes_bundled_cases_but_keeps_local_cases(self):
        bundled_id = next(
            item["id"] for item in self.store.list_modes(include_admin=True)
            if item["id"] != self.mode_id
        )
        self.store.save_example(bundled_id, {
            "id": "bundled-case", "input_media": [],
            "output_media": {"url": "/static/image-generation-examples/test/output.png"},
        })
        bundled = next(
            item for item in self.store.list_modes(include_admin=True)
            if self.store.is_bundled_official_example(item)
        )
        self.store.save_example(self.mode_id, {
            "id": "local-case", "input_media": [],
            "output_media": {"id": "local-media"}, "caption": "本机案例",
        })
        exported = {
            item["id"]: item for item in self.store.export_backup_bundle()["modes"]
        }
        self.assertIn("example", exported[bundled["id"]])
        self.assertTrue(self.store.export_backup_bundle()["official_complete"])
        self.assertEqual(exported[self.mode_id]["example"]["caption"], "本机案例")

    def test_task_summaries_sort_filter_paginate_and_skip_corrupt_records(self):
        self.store.save_task({"id": "task-old", "mode_id": self.mode_id, "status": "failed", "updated_at": "2026-08-25T10:00:00+00:00"})
        self.store.save_task({"id": "task-new", "mode_id": self.mode_id, "status": "succeeded", "updated_at": "2026-08-25T11:00:00+00:00"})
        (self.store.task_dir / "broken.json").write_text("{not json", encoding="utf-8")
        self.assertEqual([item["id"] for item in self.store.list_task_summaries()], ["task-new", "task-old"])
        self.assertEqual([item["id"] for item in self.store.list_task_summaries(status="failed")], ["task-old"])
        self.assertEqual([item["id"] for item in self.store.list_task_summaries(offset=1, limit=1)], ["task-old"])
        with self.assertRaises(ValueError):
            self.store.list_task_summaries(limit=201)

    def test_task_summaries_sort_numeric_updated_at_descending(self):
        self.store.save_task({"id": "task-older-number", "mode_id": self.mode_id, "status": "succeeded", "updated_at": 9})
        self.store.save_task({"id": "task-newer-number", "mode_id": self.mode_id, "status": "succeeded", "updated_at": 10})
        summaries = self.store.list_task_summaries(status="succeeded")
        self.assertLess(
            [item["id"] for item in summaries].index("task-newer-number"),
            [item["id"] for item in summaries].index("task-older-number"),
        )

    def test_malformed_versions_never_change_mode_on_activation_or_restore(self):
        other_mode_id = next(item["id"] for item in self.store.list_modes() if item["id"] != self.mode_id)
        foreign_parent = self.store.get_mode(other_mode_id, include_admin=True)["current_version_id"]
        mutations = (
            {"prompt": 123},
            {"kind": "unknown"},
            {"mode_id": 123},
            {"note": 123},
            {"created_at": 123},
            {"source_updated_at": 123},
            {"parent_version_id": None},
            {"parent_version_id": 123},
            {"parent_version_id": "missing-parent"},
            {"parent_version_id": foreign_parent},
        )
        for action in (self.store.activate_prompt_draft, self.store.restore_prompt_version):
            for changes in mutations:
                with self.subTest(action=action.__name__, changes=changes):
                    draft = self.store.save_prompt_draft(self.mode_id, "候选提示词")
                    version_path = self.store._version_path(draft["id"])
                    corrupt = json.loads(version_path.read_text(encoding="utf-8"))
                    corrupt.update(changes)
                    version_path.write_text(json.dumps(corrupt, ensure_ascii=False), encoding="utf-8")
                    mode_path = self.store._mode_path(self.mode_id)
                    before = mode_path.read_bytes()
                    before_mode = self.store.get_mode(self.mode_id, include_admin=True)
                    try:
                        with self.assertRaises(ValueError):
                            action(self.mode_id, draft["id"])
                        self.assertEqual(mode_path.read_bytes(), before)
                        self.assertEqual(self.store.get_mode(self.mode_id, include_admin=True), before_mode)
                    finally:
                        mode_path.write_bytes(before)

    def test_prompt_version_listing_skips_versions_with_invalid_parent_chains(self):
        draft = self.store.save_prompt_draft(self.mode_id, "待检查提示词")
        version_path = self.store._version_path(draft["id"])
        corrupt = json.loads(version_path.read_text(encoding="utf-8"))
        corrupt["parent_version_id"] = "missing-parent"
        version_path.write_text(json.dumps(corrupt, ensure_ascii=False), encoding="utf-8")
        listed_ids = {item["id"] for item in self.store.list_prompt_versions(self.mode_id)}
        self.assertNotIn(draft["id"], listed_ids)


class ImageGenerationStartupRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = ImageGenerationStore(Path(self.temp_dir.name), SEED_PATH)
        self.store.initialize()
        self.mode_id = self.store.list_modes()[0]["id"]
        import main
        self.main = main
        self.original_store = main.IMAGE_GENERATION_STORE
        main.IMAGE_GENERATION_STORE = self.store
        main.IMAGE_GENERATION_RUNTIME_TASKS.clear()
        main.IMAGE_GENERATION_RECOVERY_CANDIDATES.clear()

    def tearDown(self):
        self.main.IMAGE_GENERATION_STORE = self.original_store
        self.main.IMAGE_GENERATION_RUNTIME_TASKS.clear()
        self.main.IMAGE_GENERATION_RECOVERY_CANDIDATES.clear()
        self.temp_dir.cleanup()

    def test_startup_scans_past_201_terminal_tasks_and_never_creates_upstream_work(self):
        for index in range(201):
            self.store.save_task({
                "id": f"finished-{index}", "mode_id": self.mode_id, "status": "succeeded",
                "updated_at": 1_000 + index,
            })
        self.store.save_task({
            "id": "recover-me", "mode_id": self.mode_id, "status": "recovering", "updated_at": 1,
            "candidates": [{"id": "candidate-a", "status": "recovering", "upstream_task_id": "upstream-a"}],
        })
        with patch.object(self.main.asyncio, "create_task") as create_task:
            self.assertEqual(self.main.load_persisted_image_generation_tasks(), 1)
            self.assertEqual(self.main.schedule_image_generation_candidate_recoveries(), 1)
        self.assertIn("recover-me", self.main.IMAGE_GENERATION_RUNTIME_TASKS)
        self.assertEqual(
            self.main.IMAGE_GENERATION_RECOVERY_CANDIDATES["recover-me:candidate-a"]["upstream_task_id"],
            "upstream-a",
        )
        create_task.assert_not_called()


if __name__ == "__main__":
    unittest.main()
