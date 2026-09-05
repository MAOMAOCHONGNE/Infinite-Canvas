import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import main
from image_generation_store import ImageGenerationStore
from tests.image_generation_test_seed import ensure_seed


SEED_PATH = ensure_seed(Path(ROOT) / "tests" / "fixtures" / "image-generation-presets-test.json")


class ImageGenerationAdminTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = ImageGenerationStore(Path(self.temp_dir.name), SEED_PATH)
        self.store.initialize()
        self.mode_id = next(item["id"] for item in self.store.list_modes() if item["mode_no"] == 25)
        self.original_store = main.IMAGE_GENERATION_STORE
        main.IMAGE_GENERATION_STORE = self.store
        tokens = getattr(main, "IMAGE_GENERATION_ADMIN_TOKENS", None)
        if tokens is not None:
            tokens.clear()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        main.IMAGE_GENERATION_STORE = self.original_store
        tokens = getattr(main, "IMAGE_GENERATION_ADMIN_TOKENS", None)
        if tokens is not None:
            tokens.clear()
        self.temp_dir.cleanup()

    def _unlock(self):
        response = self.client.post("/api/image-generation/admin/unlock", json={"password": "451462"})
        self.assertEqual(response.status_code, 200)
        return {"X-Image-Generation-Admin": response.json()["token"]}

    def test_admin_unlock_has_no_timeout_and_manual_lock_revokes_only_that_token(self):
        headers = self._unlock()
        self.assertTrue(self.client.get("/api/image-generation/admin/session", headers=headers).json()["active"])
        self.assertFalse(self.client.get("/api/image-generation/admin/session").json()["active"])
        self.assertEqual(self.client.post("/api/image-generation/admin/lock", headers=headers).status_code, 200)
        self.assertFalse(self.client.get("/api/image-generation/admin/session", headers=headers).json()["active"])
        self.assertEqual(self.client.post("/api/image-generation/admin/unlock", json={"password": "wrong"}).status_code, 403)

    def test_public_mode_routes_never_leak_prompt_or_version_material_even_with_admin_header(self):
        headers = self._unlock()
        public_list = self.client.get("/api/image-generation/modes", headers=headers)
        self.assertEqual(public_list.status_code, 200)
        public_detail = self.client.get(f"/api/image-generation/modes/{self.mode_id}", headers=headers)
        self.assertEqual(public_detail.status_code, 200)
        encoded = json.dumps({"list": public_list.json(), "detail": public_detail.json()}, ensure_ascii=False)
        for forbidden in (
            "preset_prompt", "current_prompt", "draft_prompt", "original_prompt", "final_prompt",
            "prompt_versions", "version_history", "current_version_id", "original_version_id",
        ):
            self.assertNotIn(forbidden, encoded)
        protected_detail = self.client.get(f"/api/image-generation/admin/modes/{self.mode_id}")
        self.assertEqual(protected_detail.status_code, 403)
        protected_detail = self.client.get(
            f"/api/image-generation/admin/modes/{self.mode_id}", headers=headers
        )
        self.assertEqual(protected_detail.status_code, 200)
        self.assertIn("preset_prompt", protected_detail.json()["item"])

    def test_bundled_official_examples_are_public_without_local_media_adoption(self):
        example_mode = next(
            item for item in self.store.list_modes(include_admin=True)
            if isinstance(item.get("example"), dict)
        )
        response = self.client.get(f"/api/image-generation/modes/{example_mode['id']}")
        self.assertEqual(response.status_code, 200, response.text)
        example = response.json()["example"]
        urls = [item["media"]["url"] for item in example["input_media"]]
        urls.append(example["output_media"]["url"])
        self.assertTrue(urls)
        self.assertTrue(all(url.startswith("/static/image-generation-examples/") for url in urls))

    def test_mode_mutations_require_token_and_patch_only_allows_normalized_management_fields(self):
        forbidden = self.client.post(
            f"/api/image-generation/modes/{self.mode_id}/prompt-draft", json={"prompt": "private"}
        )
        self.assertEqual(forbidden.status_code, 403)
        headers = self._unlock()
        draft_response = self.client.post(
            f"/api/image-generation/modes/{self.mode_id}/prompt-draft",
            headers=headers,
            json={"prompt": "private replacement", "note": "review"},
        )
        self.assertEqual(draft_response.status_code, 200)
        draft_id = draft_response.json()["version"]["id"]
        activate_response = self.client.post(
            f"/api/image-generation/modes/{self.mode_id}/activate-prompt",
            headers=headers,
            json={"version_id": draft_id},
        )
        self.assertEqual(activate_response.status_code, 200)
        self.assertEqual(activate_response.json()["item"]["preset_prompt"], "private replacement")
        patch_response = self.client.patch(
            f"/api/image-generation/modes/{self.mode_id}",
            headers=headers,
            json={"description": "本机描述", "tags": ["证件照", "本机"]},
        )
        self.assertEqual(patch_response.status_code, 200)
        self.assertEqual(patch_response.json()["item"]["description"], "本机描述")
        blocked_patch = self.client.patch(
            f"/api/image-generation/modes/{self.mode_id}",
            headers=headers,
            json={"id": "replaced", "mode_no": 999, "preset_prompt": "overwrite"},
        )
        self.assertEqual(blocked_patch.status_code, 422)
        current = self.store.get_mode(self.mode_id, include_admin=True)
        self.assertEqual(current["id"], self.mode_id)
        self.assertNotEqual(current["mode_no"], 999)
        self.assertEqual(current["preset_prompt"], "private replacement")

    def test_simplified_settings_patch_saves_prompt_status_and_case_caution_together(self):
        headers = self._unlock()
        self.store.save_example(self.mode_id, {
            "id": "settings-case", "caption": "旧注意事项", "input_media": [],
            "output_media": {"url": "/static/image-generation-examples/test/output.png"},
        })
        before = self.store.get_mode(self.mode_id, include_admin=True)
        response = self.client.patch(
            f"/api/image-generation/modes/{self.mode_id}",
            headers=headers,
            json={
                "display_name": "一键保存模式",
                "sort_order": 8,
                "category": "展会",
                "description": "一键保存的用途说明",
                "preset_prompt": "一键保存后立即生效",
                "status": "archived",
                "example_caption": "一键保存的注意事项",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        item = response.json()["item"]
        self.assertEqual(item["display_name"], "一键保存模式")
        self.assertEqual(item["sort_order"], 8)
        self.assertEqual(item["category"], "展会")
        self.assertEqual(item["description"], "一键保存的用途说明")
        self.assertEqual(item["preset_prompt"], "一键保存后立即生效")
        self.assertEqual(item["status"], "archived")
        self.assertEqual(item["example"]["caption"], "一键保存的注意事项")
        self.assertEqual(item["tags"], before["tags"])
        version = self.store.get_prompt_version(self.mode_id, item["current_version_id"])
        self.assertEqual(version["kind"], "admin_update")
        self.assertEqual(version["parent_version_id"], before["current_version_id"])
        self.assertEqual(
            self.client.patch(
                f"/api/image-generation/modes/{self.mode_id}",
                json={"display_name": "无权限修改"},
            ).status_code,
            403,
        )

    def test_create_blank_mode_is_protected_numbered_and_does_not_copy_existing_configuration(self):
        payload = {
            "display_name": "52新模式",
            "sort_order": 52,
            "category": "新品",
            "description": "新模式用途",
            "remark": "新模式用途",
            "preset_prompt": "只属于新模式的预设提示词",
            "required_reference_count": 1,
            "reference_images": [
                {"key": "ref1", "label": "主体图", "required": True},
            ],
            "max_upload_count": 3,
            "allow_extra_images": True,
            "extra_image_limit": 2,
            "status": "active",
        }
        self.assertEqual(
            self.client.post("/api/image-generation/admin/modes", json=payload).status_code,
            403,
        )
        headers = self._unlock()
        listing = self.client.get("/api/image-generation/admin/modes", headers=headers)
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.json()["next_mode_no"], 66)

        response = self.client.post(
            "/api/image-generation/admin/modes", headers=headers, json=payload
        )
        self.assertEqual(response.status_code, 200, response.text)
        item = response.json()["item"]
        self.assertEqual(item["mode_no"], 66)
        self.assertEqual(item["display_name"], "52新模式")
        self.assertEqual(item["source_id"], "")
        self.assertFalse(item["builtin"])
        self.assertNotIn("example", item)
        self.assertEqual(item["required_reference_count"], 1)
        self.assertEqual(item["reference_images"][0]["label"], "主体图")
        version = self.store.get_prompt_version(item["id"], item["current_version_id"])
        self.assertEqual(version["kind"], "original")
        self.assertEqual(version["prompt"], payload["preset_prompt"])
        self.assertEqual(
            self.client.get("/api/image-generation/admin/modes", headers=headers).json()["next_mode_no"],
            67,
        )

    def test_invalid_or_failed_mode_create_is_atomic_and_does_not_consume_number(self):
        headers = self._unlock()
        before_meta = self.store.meta_path.read_bytes()
        before_modes = {path: path.read_bytes() for path in self.store.mode_dir.glob("*.json")}
        before_versions = {path: path.read_bytes() for path in self.store.version_dir.glob("*.json")}
        invalid = {
            "display_name": "无效模式",
            "required_reference_count": 2,
            "reference_images": [{"key": "ref1", "label": "图1", "required": True}],
            "max_upload_count": 2,
            "allow_extra_images": False,
            "extra_image_limit": 0,
        }
        response = self.client.post(
            "/api/image-generation/admin/modes", headers=headers, json=invalid
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.store.meta_path.read_bytes(), before_meta)
        self.assertEqual({path: path.read_bytes() for path in self.store.mode_dir.glob("*.json")}, before_modes)
        self.assertEqual({path: path.read_bytes() for path in self.store.version_dir.glob("*.json")}, before_versions)

        valid = {
            "display_name": "写入失败模式",
            "sort_order": 52,
            "category": "",
            "description": "",
            "remark": "",
            "preset_prompt": "",
            "required_reference_count": 0,
            "reference_images": [],
            "max_upload_count": 0,
            "allow_extra_images": False,
            "extra_image_limit": 0,
            "status": "active",
        }
        real_write = self.store._write_json
        calls = {"count": 0}

        def fail_second_write(path, value):
            calls["count"] += 1
            if calls["count"] == 2:
                raise OSError("simulated create failure")
            return real_write(path, value)

        with patch.object(self.store, "_write_json", side_effect=fail_second_write):
            with self.assertRaises(OSError):
                self.store.create_mode(valid)
        self.assertEqual(self.store.meta_path.read_bytes(), before_meta)
        self.assertEqual({path: path.read_bytes() for path in self.store.mode_dir.glob("*.json")}, before_modes)
        self.assertEqual({path: path.read_bytes() for path in self.store.version_dir.glob("*.json")}, before_versions)

    def test_duplicate_archive_restore_and_permanent_delete_respect_references_without_recycling_numbers(self):
        headers = self._unlock()
        duplicate = self.client.post(
            f"/api/image-generation/modes/{self.mode_id}/duplicate",
            headers=headers,
            json={"display_name": "临时模式"},
        ).json()["item"]
        archive = self.client.post(
            f"/api/image-generation/modes/{duplicate['id']}/archive", headers=headers
        )
        self.assertEqual(archive.status_code, 200)
        self.assertEqual(archive.json()["item"]["status"], "archived")
        restore = self.client.post(
            f"/api/image-generation/modes/{duplicate['id']}/restore", headers=headers
        )
        self.assertEqual(restore.status_code, 200)
        self.assertEqual(restore.json()["item"]["status"], "active")
        self.assertEqual(
            self.client.delete(f"/api/image-generation/modes/{duplicate['id']}", headers=headers).status_code,
            400,
        )
        self.store.save_workspace_draft(duplicate["id"], {"user_prompt": "保留"})
        self.assertEqual(
            self.client.delete(
                f"/api/image-generation/modes/{duplicate['id']}?permanent=true", headers=headers
            ).status_code,
            409,
        )
        versioned = self.client.post(
            f"/api/image-generation/modes/{self.mode_id}/duplicate",
            headers=headers,
            json={"display_name": "保留版本历史"},
        ).json()["item"]
        self.assertEqual(
            self.client.post(
                f"/api/image-generation/modes/{versioned['id']}/prompt-draft",
                headers=headers,
                json={"prompt": "需要保留的草稿"},
            ).status_code,
            200,
        )
        self.assertEqual(
            self.client.delete(
                f"/api/image-generation/modes/{versioned['id']}?permanent=true", headers=headers
            ).status_code,
            409,
        )
        removable = self.client.post(
            f"/api/image-generation/modes/{self.mode_id}/duplicate",
            headers=headers,
            json={"display_name": "可永久删除"},
        ).json()["item"]
        self.assertEqual(
            self.client.delete(
                f"/api/image-generation/modes/{removable['id']}?permanent=true", headers=headers
            ).status_code,
            200,
        )
        after_delete = self.client.post(
            f"/api/image-generation/modes/{self.mode_id}/duplicate",
            headers=headers,
            json={"display_name": "编号不可回收"},
        ).json()["item"]
        self.assertGreater(after_delete["mode_no"], removable["mode_no"])

    def test_permanent_delete_rejects_malformed_or_duplicate_version_records(self):
        headers = self._unlock()
        candidate = self.client.post(
            f"/api/image-generation/modes/{self.mode_id}/duplicate",
            headers=headers,
            json={"display_name": "损坏版本保护"},
        ).json()["item"]
        original_version_id = candidate["original_version_id"]
        (self.store.version_dir / "zz-duplicate-version.json").write_text(
            json.dumps({"id": original_version_id, "mode_id": candidate["id"]}, ensure_ascii=False),
            encoding="utf-8",
        )
        response = self.client.delete(
            f"/api/image-generation/modes/{candidate['id']}?permanent=true", headers=headers
        )
        self.assertEqual(response.status_code, 409)
        self.assertIsNotNone(self.store.get_mode(candidate["id"], include_admin=True))
        self.assertTrue(self.store._version_path(original_version_id).is_file())

    def test_permanent_delete_rejects_target_mode_example_without_moving_any_record(self):
        headers = self._unlock()
        candidate = self.client.post(
            f"/api/image-generation/modes/{self.mode_id}/duplicate",
            headers=headers,
            json={"display_name": "固定示范保护"},
        ).json()["item"]
        example = self.store.save_example(candidate["id"], {"title": "固定示范"})
        mode_path = self.store._mode_path(candidate["id"])
        version_path = self.store._version_path(candidate["original_version_id"])
        before_mode = mode_path.read_bytes()
        before_version = version_path.read_bytes()
        before_meta = self.store.meta_path.read_bytes()
        import image_generation_store
        with patch.object(image_generation_store.os, "replace", side_effect=AssertionError("must not move records")):
            response = self.client.delete(
                f"/api/image-generation/modes/{candidate['id']}?permanent=true", headers=headers
            )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(mode_path.read_bytes(), before_mode)
        self.assertEqual(version_path.read_bytes(), before_version)
        self.assertEqual(self.store.meta_path.read_bytes(), before_meta)
        self.assertEqual(self.store.get_mode(candidate["id"], include_admin=True)["example"], example)

    def test_permanent_delete_rejects_cross_mode_nested_version_reference(self):
        headers = self._unlock()
        candidate = self.client.post(
            f"/api/image-generation/modes/{self.mode_id}/duplicate",
            headers=headers,
            json={"display_name": "被其他模式引用"},
        ).json()["item"]
        other = self.client.post(
            f"/api/image-generation/modes/{self.mode_id}/duplicate",
            headers=headers,
            json={"display_name": "交叉引用模式"},
        ).json()["item"]
        other_path = self.store._mode_path(other["id"])
        other_record = json.loads(other_path.read_text(encoding="utf-8"))
        other_record["current_version_id"] = candidate["original_version_id"]
        other_record["management"] = {"nested": {"version": candidate["original_version_id"]}}
        other_path.write_text(json.dumps(other_record, ensure_ascii=False), encoding="utf-8")
        response = self.client.delete(
            f"/api/image-generation/modes/{candidate['id']}?permanent=true", headers=headers
        )
        self.assertEqual(response.status_code, 409)
        self.assertIsNotNone(self.store.get_mode(candidate["id"], include_admin=True))
        self.assertTrue(self.store._version_path(candidate["original_version_id"]).is_file())

    def test_permanent_delete_rolls_back_all_records_when_second_replace_or_unlink_fails(self):
        headers = self._unlock()

        def duplicate(name):
            return self.client.post(
                f"/api/image-generation/modes/{self.mode_id}/duplicate",
                headers=headers,
                json={"display_name": name},
            ).json()["item"]

        def fail_second(real_operation):
            calls = {"count": 0}

            def wrapped(*args, **kwargs):
                calls["count"] += 1
                if calls["count"] == 2:
                    raise OSError("injected second-operation failure")
                return real_operation(*args, **kwargs)

            return wrapped

        for operation_name in ("replace", "unlink"):
            with self.subTest(operation=operation_name):
                candidate = duplicate(f"回滚-{operation_name}")
                mode_path = self.store._mode_path(candidate["id"])
                version_path = self.store._version_path(candidate["original_version_id"])
                import image_generation_store
                real_operation = getattr(image_generation_store.os, operation_name)
                with patch.object(image_generation_store.os, operation_name, side_effect=fail_second(real_operation)):
                    response = self.client.delete(
                        f"/api/image-generation/modes/{candidate['id']}?permanent=true", headers=headers
                    )
                self.assertEqual(response.status_code, 409)
                self.assertTrue(mode_path.is_file())
                self.assertTrue(version_path.is_file())
                self.assertIsNotNone(self.store.get_mode(candidate["id"], include_admin=True))

    def test_admin_list_includes_archived_trashed_modes_and_validated_versions(self):
        headers = self._unlock()
        self.assertEqual(
            self.client.post(f"/api/image-generation/modes/{self.mode_id}/archive", headers=headers).status_code,
            200,
        )
        public_ids = {item["id"] for item in self.client.get("/api/image-generation/modes").json()["items"]}
        self.assertNotIn(self.mode_id, public_ids)
        admin_list = self.client.get("/api/image-generation/admin/modes", headers=headers)
        self.assertEqual(admin_list.status_code, 200)
        self.assertIn(self.mode_id, {item["id"] for item in admin_list.json()["items"]})
        detail = self.client.get(
            f"/api/image-generation/admin/modes/{self.mode_id}", headers=headers
        ).json()["item"]
        self.assertTrue(detail["prompt_versions"])
        self.assertEqual(detail["prompt_versions"][0]["mode_id"], self.mode_id)
        self.assertEqual(
            self.client.post(f"/api/image-generation/modes/{self.mode_id}/trash", headers=headers).status_code,
            200,
        )
        trashed = self.client.get("/api/image-generation/admin/modes", headers=headers).json()["items"]
        self.assertEqual(next(item for item in trashed if item["id"] == self.mode_id)["status"], "trashed")

    def test_obsolete_manual_source_review_routes_are_removed(self):
        headers = self._unlock()
        self.assertEqual(
            self.client.post("/api/image-generation/source/check", headers=headers).status_code,
            404,
        )
        self.assertEqual(
            self.client.post(
                "/api/image-generation/source/apply",
                headers=headers,
                json={"review_id": "removed", "decisions": {}},
            ).status_code,
            404,
        )


if __name__ == "__main__":
    unittest.main()
