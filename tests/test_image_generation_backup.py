import copy
from io import BytesIO
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import backup_transfer as backup
from image_generation_media import ImageGenerationMediaStore
from image_generation_store import ImageGenerationStore
import main
from PIL import Image
from tests.image_generation_test_seed import ensure_seed


ROOT = Path(__file__).resolve().parents[1]
SEED_PATH = ensure_seed(ROOT / "tests" / "fixtures" / "image-generation-presets-test.json")


class ImageGenerationBackupPureTests(unittest.TestCase):
    def sample_task(self):
        return {
            "id": "task-a",
            "type": "image-generation",
            "mode_id": "mode-a",
            "mode_name": "证件照",
            "group_no": 7,
            "status": "recovering",
            "user_prompt": "蓝色背景",
            "preset_prompt_snapshot": "private preset",
            "final_prompt": "private final",
            "submission_id": "submission-secret",
            "provider_snapshot": {"api_key": "secret", "base_url": "https://provider.test"},
            "inputs": [{
                "slot_key": "person",
                "media": {"id": "a" * 64, "url": "/assets/image-generation/media/aa/input.png", "path": "C:/private/input.png"},
            }],
            "generation_settings": {"image_provider_id": "provider-a", "image_count": 1},
            "candidates": [{
                "id": "candidate-a", "status": "recovering",
                "upstream_task_id": "upstream-a", "query_attempts": 3,
                "provider_snapshot": {"authorization": "Bearer secret"},
                "image": {"id": "b" * 64, "url": "/assets/image-generation/media/bb/output.webp"},
                "result": {"task_id": "upstream-result-secret", "images": ["/assets/image-generation/media/bb/output.webp"]},
                "b64_json": "binary",
            }],
        }

    def test_backup_generation_settings_preserve_new_ratio_contract_and_legacy_records(self):
        custom = {
            "ratio_mode": "custom",
            "custom_ratio_width": "7",
            "custom_ratio_height": "3",
            "aspect_ratio": "7:3",
            "resolution": "2k",
            "size": "2016x864",
            "image_count": 2,
        }
        self.assertEqual(
            ImageGenerationStore._validate_backup_generation_settings(custom, "settings"),
            custom,
        )
        legacy = {"aspect_ratio": "4:5", "resolution": "2k", "size": "1632x2048"}
        self.assertEqual(
            ImageGenerationStore._validate_backup_generation_settings(legacy, "settings"),
            legacy,
        )
        for invalid in (
            {**custom, "ratio_mode": "unknown"},
            {**custom, "custom_ratio_width": "0"},
            {**custom, "custom_ratio_height": "1000"},
        ):
            with self.assertRaises(ValueError):
                ImageGenerationStore._validate_backup_generation_settings(invalid, "settings")

    def test_exported_task_preserves_prompts_but_strips_runtime_and_credentials(self):
        source = self.sample_task()
        source["candidates"][0]["image"]["url"] = (
            "https://bucket.example/output.webp?X-Amz-Algorithm=AWS4-HMAC-SHA256"
            "&X-Amz-Credential=temporary%2Fcredential&X-Amz-Signature=secret-signature"
            "&keep=public"
        )
        source["providerSnapshot"] = {"apiKey": "camel-secret"}
        source["candidates"][0].update({
            "upstreamTaskId": "camel-upstream",
            "lastQueryAt": 123,
            "queryAttempts": 4,
            "runtimeId": "camel-runtime",
            "b64Json": "camel-base64",
        })
        exported = backup.prepare_exported_image_generation_task(source)
        encoded = json.dumps(exported, ensure_ascii=False)
        self.assertIn("private preset", encoded)
        self.assertIn("private final", encoded)
        for forbidden in (
            "secret", "upstream-a", "upstream-result-secret", "submission-secret", "provider_snapshot",
            "upstream_task_id", "query_attempts", "b64_json",
            "providerSnapshot", "upstreamTaskId", "lastQueryAt", "queryAttempts",
            "runtimeId", "b64Json", "camel-upstream", "camel-runtime", "camel-base64",
        ):
            self.assertNotIn(forbidden, encoded)
        self.assertNotIn("C:/private", encoded)
        self.assertNotIn("X-Amz-", encoded)
        self.assertNotIn("temporary%2Fcredential", encoded)
        self.assertIn("keep=public", encoded)

    def test_private_runtime_fields_are_stripped_across_naming_styles_and_config_layers(self):
        source = self.sample_task()
        source.update({
            "providerSnapshot": {"base_url": "https://private.example"},
            "runtime-id": "runtime-root",
            "last Query At": "root-time",
        })
        source["candidates"][0].update({
            "upstreamTaskId": "upstream-camel",
            "queryAttempts": 9,
            "runtimeId": "candidate-runtime",
        })
        source["candidates"][0]["result"].update({
            "b64Json": "inline-camel",
            "Last-Query-At": "result-time",
            "nested": {"taskId": "nested-upstream-task"},
        })
        exported_task = backup.prepare_exported_image_generation_task(source)
        exported_config = backup.prepare_exported_image_generation_config({
            "mode": {"providerSnapshot": {"token": "mode-secret"}},
            "draft": {"upstreamTaskId": "draft-upstream"},
            "example": {
                "source": {"queryAttempts": 4, "runtime Id": "example-runtime"},
                "result": {"b64Json": "example-inline"},
            },
        })
        encoded = json.dumps(
            {"task": exported_task, "config": exported_config}, ensure_ascii=False
        )
        for forbidden in (
            "providerSnapshot", "runtime-id", "last Query At", "upstreamTaskId",
            "queryAttempts", "runtimeId", "b64Json", "Last-Query-At",
            "mode-secret", "draft-upstream", "example-runtime", "example-inline",
            "nested-upstream-task",
        ):
            self.assertNotIn(forbidden, encoded)

    def test_azure_sas_query_credentials_are_removed_without_dropping_public_parameters(self):
        clean = backup.sanitize_portable_config(
            "https://blob.example/container/file.png?sv=2025-01-05&sp=r&se=2030-01-01"
            "&sr=b&sig=azure-secret&keep=public"
        )
        self.assertEqual(clean, "https://blob.example/container/file.png?keep=public")

    def test_signed_urls_embedded_in_errors_and_warnings_are_sanitized(self):
        source = self.sample_task()
        source["error_summary"] = (
            "download failed: https://blob.example/c/f.png?sv=1&sp=r&se=x&sr=b"
            "&sig=AZURESECRET&keep=azure，请稍后重试"
        )
        source["candidates"][0]["error"] = (
            "upstream: https://bucket.example/f.png?X-Amz-Credential=temp%2Fscope"
            "&X-Amz-Signature=AWSSECRET&keep=aws"
        )
        source["warnings"] = [{
            "message": "retry https://storage.example/f.png?X-Goog-Credential=temp"
            "&X-Goog-Signature=GOOGLESECRET&keep=google"
        }]
        encoded = json.dumps(
            backup.prepare_exported_image_generation_task(source), ensure_ascii=False
        )
        for forbidden in (
            "AZURESECRET", "AWSSECRET", "GOOGLESECRET", "X-Amz-", "X-Goog-",
            "sv=1", "sp=r", "se=x", "sr=b", "sig=",
        ):
            self.assertNotIn(forbidden, encoded)
        for public in ("keep=azure", "keep=aws", "keep=google"):
            self.assertIn(public, encoded)
        self.assertIn("，请稍后重试", encoded)

    def test_media_collection_uses_known_task_mode_and_draft_fields(self):
        task = self.sample_task()
        task["final_prompt"] = "/assets/must-not-be-collected.png"
        mode = {
            "example": {
                "input_media": [{"media": {"url": "/assets/example-input.png"}}],
                "output_media": {"url": "/static/image-generation-examples/test/example-output.png"},
            },
            "preset_prompt": "/assets/prompt-must-not-be-collected.png",
        }
        draft = {"inputs": [{"media": {"url": "/assets/draft.png"}}]}
        urls = backup.collect_image_generation_media_urls(task=task, modes=[mode], drafts=[draft])
        self.assertEqual(urls, [
            "/assets/image-generation/media/aa/input.png",
            "/assets/image-generation/media/bb/output.webp",
            "/assets/example-input.png",
            "/static/image-generation-examples/test/example-output.png",
            "/assets/draft.png",
        ])

    def test_imported_task_is_independent_interrupted_and_rewritten(self):
        source = self.sample_task()
        imported = backup.prepare_imported_image_generation_task(
            source,
            new_task_id="task-new",
            new_submission_id="submission-new",
            new_group_no=99,
            imported_at=123.0,
            url_mapping={
                "/assets/image-generation/media/aa/input.png": "/assets/restored/input.png",
                "/assets/image-generation/media/bb/output.webp": "/assets/restored/output.webp",
            },
            provider_id_map={"provider-a": "provider-b"},
            mode_id_map={"mode-a": "mode-copy"},
        )
        self.assertEqual(imported["id"], "task-new")
        self.assertEqual(imported["mode_id"], "mode-copy")
        self.assertEqual(imported["group_no"], 99)
        self.assertEqual(imported["submission_id"], "submission-new")
        self.assertEqual(imported["status"], "interrupted")
        self.assertEqual(imported["candidates"][0]["status"], "interrupted")
        self.assertEqual(imported["generation_settings"]["image_provider_id"], "provider-b")
        encoded = json.dumps(imported, ensure_ascii=False)
        self.assertIn("/assets/restored/input.png", encoded)
        self.assertIn("/assets/restored/output.webp", encoded)
        self.assertNotIn("upstream-a", encoded)

    def test_imported_task_clears_unresolved_live_version_and_candidate_links(self):
        source = self.sample_task()
        source["prompt_version_id"] = "version-from-another-install"
        source["candidates"][0]["regenerated_from"] = "missing-candidate"
        imported = backup.prepare_imported_image_generation_task(
            source,
            new_task_id="task-new",
            new_submission_id="submission-new",
            new_group_no=9,
            imported_at=123.0,
            version_id_map={},
            candidate_id_map={"candidate-a": "candidate-new"},
        )
        self.assertNotIn("prompt_version_id", imported)
        self.assertNotIn("regenerated_from", imported["candidates"][0])

    def test_rejects_malformed_or_oversized_task_shapes(self):
        with self.assertRaises(ValueError):
            backup.prepare_exported_image_generation_task({"type": "detail-page"})
        invalid = self.sample_task()
        invalid["inputs"] = [{}] * 7
        with self.assertRaises(ValueError):
            backup.prepare_exported_image_generation_task(invalid)
        invalid = self.sample_task()
        invalid["candidates"] = [
            {"id": f"candidate-{index}", "status": "succeeded"}
            for index in range(7)
        ]
        self.assertEqual(
            len(backup.prepare_exported_image_generation_task(invalid)["candidates"]),
            7,
        )
        invalid["candidates"] = [{}] * 1001
        with self.assertRaises(ValueError):
            backup.prepare_exported_image_generation_task(invalid)

    def test_v4_support_keeps_v1_v2_v3_compatibility(self):
        self.assertEqual(backup.BACKUP_VERSION, 4)
        self.assertEqual(backup.BACKUP_SUPPORTED_VERSIONS, {1, 2, 3, 4})


class ImageGenerationBackupStoreTests(unittest.TestCase):
    def setUp(self):
        self.source_temp = tempfile.TemporaryDirectory()
        self.target_temp = tempfile.TemporaryDirectory()
        self.source = ImageGenerationStore(Path(self.source_temp.name), SEED_PATH)
        self.target = ImageGenerationStore(Path(self.target_temp.name), SEED_PATH)
        self.source.initialize()
        self.target.initialize()
        self.mode_id = self.source.list_modes()[24]["id"]

    def tearDown(self):
        self.source_temp.cleanup()
        self.target_temp.cleanup()

    def _bundle_for_one_mode(self):
        all_bundle = self.source.export_backup_bundle()
        return {
            "modes": [item for item in all_bundle["modes"] if item["id"] == self.mode_id],
            "versions": [item for item in all_bundle["versions"] if item["mode_id"] == self.mode_id],
            "drafts": [item for item in all_bundle["drafts"] if item["mode_id"] == self.mode_id],
        }

    def _task(self, status="succeeded"):
        return {
            "id": "source-task", "type": "image-generation", "mode_id": self.mode_id,
            "group_no": 8, "status": status, "preset_prompt_snapshot": "private",
            "final_prompt": "private final", "inputs": [],
            "generation_settings": {"image_provider_id": "provider-a", "image_count": 1},
            "candidates": [{"id": "candidate-a", "status": status, "image": None}],
        }

    def test_bundle_import_updates_official_mode_and_task_without_duplicate_mode(self):
        draft = self.source.save_prompt_draft(self.mode_id, "本机草稿")
        output_id = "d" * 64
        input_id = "c" * 64
        required_slot = next(
            item["key"]
            for item in self.source.get_mode(self.mode_id, include_admin=True)["reference_images"]
            if item.get("required")
        )
        self.source.save_example(self.mode_id, {
            "title": "平台映射示范",
            "caption": "示范说明",
            "input_media": [{
                "slot_key": required_slot,
                "media": {
                    "id": input_id, "sha256": input_id,
                    "url": f"/assets/image-generation/media/{input_id[:2]}/{input_id}.png",
                    "media_type": "image/png", "size": 10, "width": 2, "height": 2,
                },
            }],
            "output_media": {
                "id": output_id, "sha256": output_id,
                "url": f"/assets/image-generation/media/{output_id[:2]}/{output_id}.png",
                "media_type": "image/png", "size": 10, "width": 2, "height": 2,
            },
            "sample_user_prompt": "蓝色背景",
            "show_user_prompt": True,
            "generation_settings": {"image_provider_id": "provider-a"},
            "source": {
                "task_id": "source-task",
                "candidate_id": "candidate-a",
                "prompt_version_id": draft["id"],
            },
        })
        self.source.save_workspace_draft(self.mode_id, {
            "inputs": [], "user_prompt": "示范描述",
            "generation_settings": {"image_provider_id": "provider-a"},
        })
        bundle = self._bundle_for_one_mode()
        bundle["modes"][0]["admin_token"] = "mode-secret"
        bundle["versions"][0]["api_key"] = "version-secret"
        bundle["drafts"][0]["authorization"] = "draft-secret"
        source_task = self._task("recovering")
        source_task["prompt_version_id"] = draft["id"]
        result = self.target.import_backup_bundle(
            bundle, [source_task], imported_at=123.0,
            provider_id_map={"provider-a": "provider-b"},
        )
        self.assertEqual(len(result["mode_ids"]), 1)
        self.assertEqual(len(result["tasks"]), 1)
        new_mode_id = result["mode_id_map"][self.mode_id]
        self.assertEqual(new_mode_id, self.mode_id)
        imported_mode = self.target.get_mode(new_mode_id, include_admin=True)
        self.assertTrue(imported_mode["builtin"])
        self.assertEqual(imported_mode["source_id"], self.mode_id)
        self.assertEqual(imported_mode["mode_no"], self.source.get_mode(self.mode_id, include_admin=True)["mode_no"])
        self.assertEqual(imported_mode["example"]["generation_settings"]["image_provider_id"], "provider-b")
        self.assertTrue(self.target.list_prompt_versions(new_mode_id))
        imported_draft = self.target.load_workspace_draft(new_mode_id)
        self.assertEqual(imported_draft["generation_settings"]["image_provider_id"], "provider-b")
        imported_versions = self.target.list_prompt_versions(new_mode_id)
        self.assertNotIn("secret", json.dumps({
            "mode": imported_mode,
            "versions": imported_versions,
            "draft": imported_draft,
        }, ensure_ascii=False))
        task = result["tasks"][0]
        self.assertEqual(task["mode_id"], new_mode_id)
        self.assertEqual(task["status"], "interrupted")
        self.assertGreater(task["group_no"], 0)
        self.assertNotEqual(task["id"], "source-task")
        self.assertNotEqual(imported_mode["current_version_id"], draft["id"])
        self.assertNotEqual(task["prompt_version_id"], draft["id"])
        self.assertTrue(any(
            item["id"] == task["prompt_version_id"]
            for item in imported_versions
        ))
        example_source = imported_mode["example"]["source"]
        self.assertEqual(example_source["task_id"], task["id"])
        self.assertEqual(example_source["candidate_id"], task["candidates"][0]["id"])
        self.assertEqual(example_source["prompt_version_id"], task["prompt_version_id"])
        self.assertNotEqual(task["candidates"][0]["id"], "candidate-a")

    def test_bundle_import_capacity_and_failure_restore_every_file_and_counter(self):
        bundle = self._bundle_for_one_mode()
        with self.assertRaisesRegex(ValueError, "too many tasks"):
            self.target.import_backup_bundle(
                bundle, [self._task()], imported_at=1.0, task_limit=0,
            )
        before = {
            path: path.read_bytes()
            for directory in (
                self.target.mode_dir, self.target.version_dir,
                self.target.draft_dir, self.target.task_dir,
            )
            for path in directory.glob("*.json")
        }
        original_write = self.target._write_json
        calls = {"count": 0}

        def fail_after_first(target, value):
            calls["count"] += 1
            if calls["count"] == 2:
                raise OSError("injected backup failure")
            return original_write(target, value)

        with patch.object(self.target, "_write_json", side_effect=fail_after_first):
            with self.assertRaises(ValueError):
                self.target.import_backup_bundle(bundle, [self._task()], imported_at=1.0)
        after = {
            path: path.read_bytes()
            for directory in (
                self.target.mode_dir, self.target.version_dir,
                self.target.draft_dir, self.target.task_dir,
            )
            for path in directory.glob("*.json")
        }
        self.assertEqual(after, before)

    def test_bundle_rejects_invalid_original_and_draft_version_roles_without_writes(self):
        draft = self.source.save_prompt_draft(self.mode_id, "待审核草稿")
        clean_bundle = self._bundle_for_one_mode()
        before = self.target.snapshot_backup_state()
        for problem in ("original-is-draft", "draft-list-has-original"):
            with self.subTest(problem=problem):
                bundle = copy.deepcopy(clean_bundle)
                mode = bundle["modes"][0]
                if problem == "original-is-draft":
                    mode["original_version_id"] = draft["id"]
                else:
                    mode["draft_version_ids"] = [mode["original_version_id"]]
                with self.assertRaisesRegex(ValueError, "version"):
                    self.target.import_backup_bundle(bundle, [], imported_at=1.0)
                self.assertEqual(self.target.snapshot_backup_state(), before)

    def test_bundle_import_rejects_invalid_original_and_draft_roles_before_write(self):
        draft = self.source.save_prompt_draft(self.mode_id, "用于角色校验的草稿")
        base_bundle = self._bundle_for_one_mode()
        original_id = base_bundle["modes"][0]["original_version_id"]
        cases = []

        invalid_original = copy.deepcopy(base_bundle)
        invalid_original["modes"][0]["original_version_id"] = draft["id"]
        cases.append(invalid_original)

        invalid_draft = copy.deepcopy(base_bundle)
        invalid_draft["modes"][0]["draft_version_ids"] = [original_id]
        cases.append(invalid_draft)

        for invalid_bundle in cases:
            with self.subTest(mode=invalid_bundle["modes"][0]):
                before = self.target.snapshot_backup_state()
                with patch.object(self.target, "_write_json", wraps=self.target._write_json) as writer:
                    with self.assertRaisesRegex(ValueError, "prompt version"):
                        self.target.import_backup_bundle(
                            invalid_bundle, [], imported_at=1.0,
                        )
                writer.assert_not_called()
                self.assertEqual(self.target.snapshot_backup_state(), before)

    def test_bundle_import_rejects_malformed_workspace_drafts_before_write(self):
        bundle = self._bundle_for_one_mode()
        mode = bundle["modes"][0]
        bundle["drafts"] = [{
            "mode_id": mode["id"],
            "updated_at": "2026-08-25T00:00:00+00:00",
            "inputs": [{"slot_key": mode["reference_images"][0]["key"], "media": {
                "id": "a" * 64, "sha256": "a" * 64,
                "url": "/assets/image-generation/media/bb/" + "b" * 64 + ".png",
                "media_type": "image/png", "size": 10, "width": 2, "height": 2,
            }}],
            "user_prompt": "示范",
            "generation_settings": {"image_count": 1},
        }]
        before = self.target.snapshot_backup_state()
        with patch.object(self.target, "_write_json", wraps=self.target._write_json) as writer:
            with self.assertRaisesRegex(ValueError, "draft media"):
                self.target.import_backup_bundle(bundle, [], imported_at=1.0)
        writer.assert_not_called()
        self.assertEqual(self.target.snapshot_backup_state(), before)

    def test_bundle_import_rejects_malformed_fixed_examples_before_write(self):
        media_id = "c" * 64
        media = {
            "id": media_id, "sha256": media_id,
            "url": f"/assets/image-generation/media/{media_id[:2]}/{media_id}.png",
            "media_type": "image/png", "size": 10, "width": 2, "height": 2,
        }
        base_bundle = self._bundle_for_one_mode()
        mode = base_bundle["modes"][0]
        valid_example = {
            "id": "example-a", "mode_id": mode["id"],
            "updated_at": "2026-08-25T00:00:00+00:00",
            "title": "示范", "caption": "说明", "sample_user_prompt": "蓝色背景",
            "show_user_prompt": True, "input_media": [],
            "output_media": media, "source": {},
        }
        malformed_examples = []
        wrong_inputs = copy.deepcopy(valid_example)
        wrong_inputs["input_media"] = "not-a-list"
        malformed_examples.append(wrong_inputs)
        file_url = copy.deepcopy(valid_example)
        file_url["output_media"]["url"] = "file:///C:/secret.png"
        malformed_examples.append(file_url)
        wrong_prompt = copy.deepcopy(valid_example)
        wrong_prompt["sample_user_prompt"] = 123
        malformed_examples.append(wrong_prompt)
        unexpected = copy.deepcopy(valid_example)
        unexpected["private_path"] = "C:/secret.png"
        malformed_examples.append(unexpected)

        for malformed in malformed_examples:
            with self.subTest(example=malformed):
                bundle = copy.deepcopy(base_bundle)
                bundle["modes"][0]["example"] = malformed
                before = self.target.snapshot_backup_state()
                with patch.object(self.target, "_write_json", wraps=self.target._write_json) as writer:
                    with self.assertRaisesRegex(ValueError, "example"):
                        self.target.import_backup_bundle(bundle, [], imported_at=1.0)
                writer.assert_not_called()
                self.assertEqual(self.target.snapshot_backup_state(), before)

    def test_complete_bundle_accepts_full_static_example_media_and_promotes_legacy_mode(self):
        bundle = self._bundle_for_one_mode()
        mode = bundle["modes"][0]
        mode["source_id"] = ""
        mode["builtin"] = False
        media_id = "c" * 64
        static_media = {
            "id": media_id,
            "sha256": media_id,
            "url": f"/static/image-generation-examples/{mode['id']}/{media_id}.png",
            "media_type": "image/png",
            "size": 10,
            "width": 2,
            "height": 2,
        }
        required_slots = [
            item["key"] for item in mode.get("reference_images") or []
            if item.get("required")
        ]
        mode["example"] = {
            "id": "legacy-static-example",
            "mode_id": mode["id"],
            "updated_at": "2026-09-05T00:00:00+08:00",
            "title": "旧版静态案例",
            "caption": "",
            "sample_user_prompt": "",
            "show_user_prompt": True,
            "input_media": [
                {"slot_key": slot_key, "media": copy.deepcopy(static_media)}
                for slot_key in required_slots
            ],
            "output_media": copy.deepcopy(static_media),
            "source": {},
        }
        bundle.update({
            "official_content_version": "2026.09.05-content.1",
            "official_complete": True,
        })
        legacy_local = self.target.get_mode(mode["id"], include_admin=True)
        legacy_local["source_id"] = ""
        legacy_local["builtin"] = False
        legacy_local["example"] = copy.deepcopy(mode["example"])
        self.target._write_json(self.target._mode_path(mode["id"]), legacy_local)
        restored_url = f"/assets/image-generation/media/{media_id[:2]}/{media_id}.png"
        result = self.target.import_backup_bundle(
            bundle,
            [],
            imported_at=1.0,
            url_mapping={static_media["url"]: restored_url},
        )
        imported = self.target.get_mode(result["mode_id_map"][mode["id"]], include_admin=True)
        self.assertEqual(imported["source_id"], mode["id"])
        self.assertTrue(imported["builtin"])
        self.assertEqual(imported["example"]["output_media"]["url"], restored_url)

    def test_complete_export_stamps_stable_identity_without_mutating_legacy_mode(self):
        legacy = self.source.get_mode(self.mode_id, include_admin=True)
        legacy["source_id"] = ""
        legacy["builtin"] = False
        self.source._write_json(self.source._mode_path(self.mode_id), legacy)

        exported = next(
            item for item in self.source.export_backup_bundle()["modes"]
            if item["id"] == self.mode_id
        )
        live = self.source.get_mode(self.mode_id, include_admin=True)

        self.assertEqual(exported["source_id"], self.mode_id)
        self.assertTrue(exported["builtin"])
        self.assertEqual(live.get("source_id", ""), "")
        self.assertFalse(live.get("builtin", False))

    def test_full_static_example_media_still_rejects_unsafe_path_and_identity(self):
        media_id = "d" * 64
        valid = {
            "id": media_id,
            "sha256": media_id,
            "url": f"/static/image-generation-examples/mode/{media_id}.png",
            "media_type": "image/png",
            "size": 10,
            "width": 2,
            "height": 2,
        }
        self.assertEqual(
            ImageGenerationStore._validate_backup_media_reference(
                valid, "example media", allow_static=True
            ),
            valid,
        )
        for invalid in (
            {**valid, "url": f"/static/image-generation-examples/../{media_id}.png"},
            {**valid, "url": f"/static/image-generation-examples/mode/{'e' * 64}.png"},
            {**valid, "sha256": "e" * 64},
            {**valid, "media_type": "image/jpeg"},
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(ValueError, "example media"):
                    ImageGenerationStore._validate_backup_media_reference(
                        invalid, "example media", allow_static=True
                    )

    def test_bundle_import_rejects_media_identity_change_from_url_mapping_before_write(self):
        source_id = "a" * 64
        target_id = "b" * 64
        source_url = f"/assets/image-generation/media/{source_id[:2]}/{source_id}.png"
        target_url = f"/assets/image-generation/media/{target_id[:2]}/{target_id}.png"
        media = {
            "id": source_id, "sha256": source_id, "url": source_url,
            "media_type": "image/png", "size": 10, "width": 2, "height": 2,
        }
        mode = self.source.get_mode(self.mode_id, include_admin=True)
        required_slot = next(
            item["key"] for item in mode["reference_images"] if item.get("required")
        )
        self.source.save_workspace_draft(self.mode_id, {
            "inputs": [{"slot_key": required_slot, "media": media}],
            "user_prompt": "测试",
            "generation_settings": {"image_count": 1},
        })
        self.source.save_example(self.mode_id, {
            "title": "映射测试", "caption": "", "sample_user_prompt": "测试",
            "show_user_prompt": True,
            "input_media": [{"slot_key": required_slot, "media": media}],
            "output_media": media,
            "source": {},
        })
        bundle = self._bundle_for_one_mode()
        before = self.target.snapshot_backup_state()
        with patch.object(self.target, "_write_json", wraps=self.target._write_json) as writer:
            with self.assertRaisesRegex(ValueError, "media.*mapping|media.*identity"):
                self.target.import_backup_bundle(
                    bundle, [], imported_at=1.0,
                    url_mapping={source_url: target_url},
                )
        writer.assert_not_called()
        self.assertEqual(self.target.snapshot_backup_state(), before)

    def test_bundle_import_allows_same_media_identity_with_normalized_extension(self):
        media_id = "a" * 64
        source_url = f"/assets/image-generation/media/{media_id[:2]}/{media_id}.png"
        normalized_url = f"/assets/image-generation/media/{media_id[:2]}/{media_id}.webp"
        ImageGenerationStore._validate_backup_media_url_mapping({source_url: normalized_url})

    def test_bundle_import_rejects_cas_mapping_with_invalid_target_shard(self):
        media_id = "a" * 64
        source_url = f"/assets/image-generation/media/{media_id[:2]}/{media_id}.png"
        target_url = f"/assets/image-generation/media/bb/{media_id}.webp"
        with self.assertRaisesRegex(ValueError, "media.*identity"):
            ImageGenerationStore._validate_backup_media_url_mapping({source_url: target_url})

    def test_bundle_import_enforces_fixed_example_slot_contract_before_write(self):
        media_id = "e" * 64
        media = {
            "id": media_id, "sha256": media_id,
            "url": f"/assets/image-generation/media/{media_id[:2]}/{media_id}.png",
            "media_type": "image/png", "size": 10, "width": 2, "height": 2,
        }
        base_bundle = self._bundle_for_one_mode()
        base_mode = base_bundle["modes"][0]
        required_slot = next(
            item["key"] for item in base_mode["reference_images"] if item.get("required")
        )

        cases = []
        no_extras = copy.deepcopy(base_bundle)
        no_extras["modes"][0]["allow_extra_images"] = False
        no_extras["modes"][0]["extra_image_limit"] = 0
        cases.append((no_extras, [
            {"slot_key": required_slot, "media": media},
            {"slot_key": "unknown-slot", "media": media},
        ]))

        excess_extras = copy.deepcopy(base_bundle)
        excess_extras["modes"][0]["allow_extra_images"] = True
        excess_extras["modes"][0]["extra_image_limit"] = 1
        cases.append((excess_extras, [
            {"slot_key": required_slot, "media": media},
            {"slot_key": "extra-1", "media": media},
            {"slot_key": "extra-2", "media": media},
        ]))

        missing_required = copy.deepcopy(base_bundle)
        cases.append((missing_required, []))

        for bundle, inputs in cases:
            mode = bundle["modes"][0]
            mode["example"] = {
                "id": "example-slot-contract", "mode_id": mode["id"],
                "updated_at": "2026-08-25T00:00:00+00:00",
                "title": "示范", "caption": "", "sample_user_prompt": "测试",
                "show_user_prompt": True, "input_media": inputs,
                "output_media": media, "source": {},
            }
            before = self.target.snapshot_backup_state()
            with self.subTest(inputs=[item["slot_key"] for item in inputs]):
                with patch.object(self.target, "_write_json", wraps=self.target._write_json) as writer:
                    with self.assertRaisesRegex(ValueError, "example inputs"):
                        self.target.import_backup_bundle(bundle, [], imported_at=1.0)
                writer.assert_not_called()
                self.assertEqual(self.target.snapshot_backup_state(), before)


def _png_bytes(color=(20, 40, 60, 255)):
    buffer = BytesIO()
    Image.new("RGBA", (2, 2), color).save(buffer, format="PNG")
    return buffer.getvalue()


class ImageGenerationBackupServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        data_root = root / "data"
        self.store = ImageGenerationStore(data_root, SEED_PATH)
        self.store.initialize()
        for mode in self.store.list_modes(include_admin=True):
            if mode.get("example") is not None:
                mode["example"] = None
                self.store._write_json(self.store._mode_path(mode["id"]), mode)
        self.media = ImageGenerationMediaStore(root)
        self.paths = {
            "DATA_DIR": str(data_root),
            "CANVAS_DIR": str(data_root / "canvases"),
            "PROJECTS_PATH": str(data_root / "projects.json"),
            "API_PROVIDERS_FILE": str(data_root / "api_providers.json"),
            "PROMPT_LIBRARY_PATH": str(data_root / "prompt_libraries.json"),
            "RUNNINGHUB_WORKFLOW_STORE_FILE": str(data_root / "runninghub_workflows.json"),
            "BACKUP_HISTORY_PATH": str(data_root / "backup_import_history.json"),
            "ASSETS_DIR": str(root / "assets"),
            "OUTPUT_INPUT_DIR": str(root / "assets" / "input"),
            "OUTPUT_OUTPUT_DIR": str(root / "assets" / "output"),
            "OUTPUT_DIR": str(root / "output"),
            "DETAIL_PAGE_TASK_DIR": str(data_root / "detail_page_tasks"),
            "MAIN_IMAGE_TASK_DIR": str(data_root / "main_image_tasks"),
            "STATIC_RUNNINGHUB_API_PROVIDERS_FILE": str(root / "static" / "runninghub" / "api_providers.json"),
            "CANVAS_TASKS": {},
            "IMAGE_GENERATION_STORE": self.store,
            "IMAGE_GENERATION_MEDIA_STORE": self.media,
        }
        self.patchers = [patch.object(main, key, value) for key, value in self.paths.items()]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        for directory in (
            self.paths["CANVAS_DIR"], self.paths["OUTPUT_INPUT_DIR"],
            self.paths["OUTPUT_OUTPUT_DIR"], self.paths["OUTPUT_DIR"],
            self.paths["DETAIL_PAGE_TASK_DIR"], self.paths["MAIN_IMAGE_TASK_DIR"],
            os.path.dirname(self.paths["STATIC_RUNNINGHUB_API_PROVIDERS_FILE"]),
        ):
            os.makedirs(directory, exist_ok=True)
        Path(self.paths["PROJECTS_PATH"]).write_text(
            json.dumps({"projects": [{"id": "project-a", "name": "A项目", "order": 1}]}),
            encoding="utf-8",
        )
        Path(self.paths["API_PROVIDERS_FILE"]).write_text(json.dumps([{
            "id": "provider-a", "name": "A平台", "base_url": "https://example.test/v1",
            "protocol": "openai", "enabled": True, "image_models": ["image-a"],
            "chat_models": [], "video_models": [],
        }]), encoding="utf-8")
        Path(self.paths["PROMPT_LIBRARY_PATH"]).write_text(
            json.dumps({"active_library_id": "", "libraries": []}), encoding="utf-8",
        )
        Path(self.paths["RUNNINGHUB_WORKFLOW_STORE_FILE"]).write_text("{}", encoding="utf-8")

        self.mode_id = self.store.list_modes(include_admin=True)[24]["id"]
        self.required_slot = next(
            item["key"]
            for item in self.store.get_mode(self.mode_id, include_admin=True)["reference_images"]
            if item.get("required")
        )
        self.input_media = self.media.adopt_bytes(_png_bytes((10, 30, 70, 255)), "input.png")
        self.output_media = self.media.adopt_bytes(_png_bytes((190, 80, 40, 255)), "output.png")
        self.store.save_prompt_draft(self.mode_id, "备份中的管理员提示词草稿", note="backup")
        self.store.save_workspace_draft(self.mode_id, {
            "inputs": [{"slot_key": self.required_slot, "media": self.input_media}],
            "user_prompt": "蓝色背景",
            "generation_settings": {"image_provider_id": "provider-a", "image_model": "image-a"},
        })
        self.store.save_example(self.mode_id, {
            "title": "固定证件照示范",
            "input_media": [{"slot_key": self.required_slot, "media": self.input_media}],
            "output_media": self.output_media,
            "sample_user_prompt": "蓝色背景",
            "show_user_prompt": True,
        })
        self.task = {
            "id": "image_generation_source", "type": "image-generation",
            "mode_id": self.mode_id, "mode_name": "一键证件照", "group_no": 8,
            "status": "recovering", "created_at": "2026-08-25T01:00:00+00:00",
            "updated_at": "2026-08-25T01:01:00+00:00", "user_prompt": "蓝色背景",
            "preset_prompt_snapshot": "private preset", "final_prompt": "private final",
            "submission_id": "source-submission", "provider_snapshot": {"api_key": "secret"},
            "inputs": [{"slot_key": self.required_slot, "media": self.input_media}],
            "generation_settings": {"image_provider_id": "provider-a", "image_model": "image-a", "image_count": 1},
            "candidates": [{
                "id": "candidate-a", "status": "recovering", "upstream_task_id": "upstream-secret",
                "image": self.output_media,
            }],
        }
        self.store.save_task(self.task)

    def export_image_generation(self, *, include_assets=True, include_modes=True):
        archive_path, _ = main.build_backup_archive(main.BackupExportRequest(
            image_generation_task_ids=[self.task["id"]],
            include_image_generation_modes=include_modes,
            include_assets=include_assets,
        ))
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))
        return archive_path

    def test_options_and_v4_archive_include_history_config_and_summary(self):
        options = main.backup_options_payload()
        self.assertEqual(options["image_generations"][0]["id"], self.task["id"])
        self.assertTrue(options["image_generation_modes"]["available"])
        self.assertGreaterEqual(options["image_generation_modes"]["mode_count"], 51)
        self.assertGreaterEqual(options["image_generation_modes"]["example_count"], 1)

        archive_path = self.export_image_generation()
        with zipfile.ZipFile(archive_path, "r") as archive:
            manifest = json.loads(archive.read("manifest.json"))
            names = set(archive.namelist())
            exported = json.loads(archive.read(f"image-generations/{self.task['id']}.json"))
            exported_modes = archive.read("image-generation-config/modes.json").decode("utf-8")
        self.assertEqual(manifest["version"], 4)
        self.assertIn("image-generation-config/modes.json", names)
        self.assertIn("image-generation-config/versions.json", names)
        self.assertIn("image-generation-config/drafts.json", names)
        self.assertTrue(any(name.startswith("image-generation-resources/") for name in names))
        encoded = json.dumps(exported)
        self.assertIn("private final", encoded)
        self.assertNotIn("upstream-secret", encoded)
        self.assertNotIn("secret", encoded)
        self.assertNotIn(str(Path(self.temp.name)), exported_modes)
        self.assertNotIn('"path"', exported_modes)
        inspected = main.inspect_backup_path(archive_path)["backup"]
        self.assertEqual(inspected["image_generation_count"], 1)
        self.assertTrue(inspected["image_generation_modes"]["available"])

    def test_main_image_only_archive_stays_v3(self):
        source = {"id": "main-image-only", "type": "main-image", "group_no": 1,
                  "status": "succeeded", "settings": {}, "screens": []}
        main.CANVAS_TASKS[source["id"]] = source
        archive_path, _ = main.build_backup_archive(main.BackupExportRequest(
            main_image_task_ids=[source["id"]], include_assets=False,
        ))
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))
        with zipfile.ZipFile(archive_path, "r") as archive:
            manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["version"], 3)

    def test_history_only_and_mode_config_only_each_require_v4(self):
        requests = [
            main.BackupExportRequest(
                image_generation_task_ids=[self.task["id"]],
                include_image_generation_modes=False,
                include_assets=False,
            ),
            main.BackupExportRequest(
                include_image_generation_modes=True,
                include_assets=False,
            ),
        ]
        for request in requests:
            archive_path, _ = main.build_backup_archive(request)
            self.addCleanup(lambda path=archive_path: os.path.exists(path) and os.remove(path))
            with zipfile.ZipFile(archive_path, "r") as archive:
                manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["version"], 4)

    def test_official_cases_are_archived_even_when_normal_assets_are_disabled(self):
        static_root = Path(self.temp.name) / "static"
        mode = self.store.list_modes(include_admin=True)[0]
        payload = _png_bytes((31, 63, 95, 255))
        digest = __import__("hashlib").sha256(payload).hexdigest()
        example_path = static_root / "image-generation-examples" / mode["id"] / f"{digest}.png"
        example_path.parent.mkdir(parents=True, exist_ok=True)
        example_path.write_bytes(payload)
        self.store.save_example(mode["id"], {
            "title": "独立静态案例",
            "input_media": [],
            "output_media": {
                "id": digest,
                "sha256": digest,
                "url": f"/static/image-generation-examples/{mode['id']}/{digest}.png",
                "media_type": "image/png",
                "size": len(payload),
                "width": 2,
                "height": 2,
            },
            "sample_user_prompt": "",
            "show_user_prompt": True,
        })
        with patch.object(main, "STATIC_DIR", str(static_root)):
            archive_path, _ = main.build_backup_archive(main.BackupExportRequest(
                include_image_generation_modes=True,
                include_assets=False,
            ))
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))
        with zipfile.ZipFile(archive_path, "r") as archive:
            manifest = json.loads(archive.read("manifest.json"))
            static_resources = [
                item for item in manifest["resources"]
                if str(item.get("url") or "").startswith("/static/image-generation-examples/")
            ]
            self.assertTrue(static_resources)
            self.assertTrue(all(
                str(item.get("file") or "").startswith("image-generation-resources/")
                for item in static_resources
            ))

    def test_static_example_round_trip_rewrites_missing_release_path_to_cas(self):
        static_root = Path(self.temp.name) / "static"
        example_root = static_root / "image-generation-examples" / self.mode_id
        example_root.mkdir(parents=True, exist_ok=True)

        def static_media(content):
            digest = __import__("hashlib").sha256(content).hexdigest()
            path = example_root / f"{digest}.png"
            path.write_bytes(content)
            with Image.open(BytesIO(content)) as image:
                width, height = image.size
            return {
                "id": digest,
                "sha256": digest,
                "url": f"/static/image-generation-examples/{self.mode_id}/{digest}.png",
                "media_type": "image/png",
                "size": len(content),
                "width": width,
                "height": height,
            }, path

        input_record, input_path = static_media(_png_bytes((11, 22, 33, 255)))
        output_record, output_path = static_media(_png_bytes((44, 55, 66, 255)))
        for mode in self.store.list_modes(include_admin=True):
            if mode["id"] != self.mode_id and mode.get("example") is not None:
                mode["example"] = None
                self.store._write_json(self.store._mode_path(mode["id"]), mode)
        exported_mode_count = len(self.store.list_modes(include_admin=True))
        self.store.save_example(self.mode_id, {
            "title": "静态案例迁移",
            "input_media": [{"slot_key": self.required_slot, "media": input_record}],
            "output_media": output_record,
            "sample_user_prompt": "",
            "show_user_prompt": True,
        })
        with patch.object(main, "STATIC_DIR", str(static_root)):
            archive_path, _ = main.build_backup_archive(main.BackupExportRequest(
                include_image_generation_modes=True,
                include_assets=False,
            ))
            self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))
            input_path.unlink()
            output_path.unlink()
            result = main.import_backup_path(archive_path, {
                "include_image_generation_modes": True,
                "include_assets": False,
            })
            imported = self.store.get_mode(self.mode_id, include_admin=True)
            public = main._image_generation_public_mode_with_example(self.mode_id)

        self.assertEqual(result["image_generation_modes_imported"], exported_mode_count)
        for field in (
            "image_generation_modes_created",
            "image_generation_modes_updated",
            "image_generation_modes_reactivated",
            "image_generation_modes_archived",
        ):
            self.assertIn(field, result)
        self.assertTrue(imported["example"]["output_media"]["url"].startswith(
            "/assets/image-generation/media/"
        ))
        self.assertIsNotNone(self.media.media_record(output_record["id"]))
        self.assertIsNotNone(public.get("example"))

    def test_import_restores_media_to_cas_and_repeat_import_is_independent(self):
        archive_path = self.export_image_generation()
        Path(self.input_media["path"]).unlink()
        Path(self.output_media["path"]).unlink()
        first = main.import_backup_path(archive_path, {
            "image_generation_task_ids": [self.task["id"]],
            "include_image_generation_modes": True,
            "include_assets": True,
        })
        second = main.import_backup_path(archive_path, {
            "image_generation_task_ids": [self.task["id"]],
            "include_image_generation_modes": True,
            "include_assets": True,
        })
        self.assertEqual(first["image_generations"], 1)
        self.assertEqual(first["image_generation_modes_imported"], 65)
        self.assertGreaterEqual(first["image_generation_examples_imported"], 1)
        first_task = self.store.load_task(first["image_generation_task_ids"][0], include_admin=True)
        second_task = self.store.load_task(second["image_generation_task_ids"][0], include_admin=True)
        first_url = first_task["inputs"][0]["media"]["url"]
        self.assertTrue(first_url.startswith("/assets/image-generation/media/"))
        self.assertNotIn("backup_resources", first_url)
        self.assertIsNotNone(self.media.media_record(self.input_media["id"]))
        self.assertNotEqual(first_task["id"], second_task["id"])
        self.assertNotEqual(first_task["group_no"], second_task["group_no"])
        self.assertEqual(first_task["mode_id"], second_task["mode_id"])

    def test_main_image_only_cas_media_round_trip_with_modes_and_legacy_shared_scope(self):
        main_only_media = self.media.adopt_bytes(
            _png_bytes((72, 126, 214, 255)), "main-only.png",
        )
        source = {
            "id": "main-image-cas-only",
            "type": "main-image",
            "group_no": 32,
            "status": "succeeded",
            "settings": {},
            "screens": [{
                "screen_no": 1,
                "status": "succeeded",
                "result": {
                    "image_url": main_only_media["url"],
                    "images": [main_only_media["url"]],
                    "image_items": [{"url": main_only_media["url"]}],
                },
                "candidates": [],
            }],
        }
        main.CANVAS_TASKS[source["id"]] = source
        archive_path, _ = main.build_backup_archive(main.BackupExportRequest(
            main_image_task_ids=[source["id"]],
            include_image_generation_modes=True,
            include_assets=True,
        ))
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))

        # Reproduce backups exported before the cross-module CAS fix: the URL is
        # canonical CAS, but the archive member and scope were labelled shared.
        legacy_archive = Path(self.temp.name) / "legacy-shared-main-image-cas.zip"
        with zipfile.ZipFile(archive_path, "r") as source_archive:
            members = {info.filename: source_archive.read(info) for info in source_archive.infolist()}
        manifest = json.loads(members["manifest.json"])
        resource = next(
            item for item in manifest["resources"]
            if item.get("url") == main_only_media["url"]
        )
        original_member = resource["file"]
        self.assertEqual(resource["scope"], "image-generation")
        self.assertTrue(original_member.startswith("image-generation-resources/"))
        extension = Path(original_member).suffix
        legacy_member = (
            f"resources/{main_only_media['id'][:2]}/{main_only_media['id']}{extension}"
        )
        members[legacy_member] = members[original_member]
        resource["file"] = legacy_member
        resource["scope"] = "shared"
        members["manifest.json"] = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
        with zipfile.ZipFile(legacy_archive, "w", zipfile.ZIP_DEFLATED) as target:
            for name, content in members.items():
                target.writestr(name, content)

        invalid_archive = Path(self.temp.name) / "invalid-main-image-cas-identity.zip"
        invalid_members = dict(members)
        invalid_manifest = json.loads(invalid_members["manifest.json"])
        invalid_resource = next(
            item for item in invalid_manifest["resources"]
            if item.get("url") == main_only_media["url"]
        )
        replacement = _png_bytes((214, 72, 126, 255))
        invalid_resource["sha256"] = __import__("hashlib").sha256(replacement).hexdigest()
        invalid_resource["size"] = len(replacement)
        invalid_members[legacy_member] = replacement
        invalid_members["manifest.json"] = json.dumps(
            invalid_manifest, ensure_ascii=False,
        ).encode("utf-8")
        with zipfile.ZipFile(invalid_archive, "w", zipfile.ZIP_DEFLATED) as target:
            for name, content in invalid_members.items():
                target.writestr(name, content)
        before_invalid = self.store.snapshot_backup_state()
        with self.assertRaisesRegex(ValueError, "媒体标识"):
            main.import_backup_path(str(invalid_archive), {
                "main_image_task_ids": [source["id"]],
                "include_image_generation_modes": True,
                "include_assets": True,
            })
        self.assertEqual(self.store.snapshot_backup_state(), before_invalid)
        self.assertEqual(set(main.CANVAS_TASKS), {source["id"]})

        Path(main_only_media["path"]).unlink()
        result = main.import_backup_path(str(legacy_archive), {
            "main_image_task_ids": [source["id"]],
            "include_image_generation_modes": True,
            "include_assets": True,
        })

        self.assertEqual(result["main_images"], 1)
        imported = next(
            task for task in main.CANVAS_TASKS.values()
            if task.get("type") == "main-image" and task.get("id") != source["id"]
        )
        restored_url = imported["screens"][0]["result"]["image_url"]
        self.assertEqual(restored_url, main_only_media["url"])
        self.assertNotIn("backup_resources", restored_url)
        self.assertIsNotNone(self.media.media_record(main_only_media["id"]))

    def test_import_without_media_marks_task_example_and_draft_missing(self):
        archive_path = self.export_image_generation(include_assets=False)
        result = main.import_backup_path(archive_path, {
            "image_generation_task_ids": [self.task["id"]],
            "include_image_generation_modes": True,
            "include_assets": False,
        })
        task = self.store.load_task(result["image_generation_task_ids"][0], include_admin=True)
        mode = next(item for item in self.store.list_modes(include_admin=True)
                    if item["id"] == task["mode_id"])
        draft = self.store.load_workspace_draft(mode["id"])
        self.assertEqual(result["image_generation_missing_media"], 0)
        self.assertFalse(task.get("import_missing_media"))
        self.assertNotIn("import_warning", task)
        self.assertFalse(mode["example"].get("import_missing_media"))
        self.assertFalse(draft.get("import_missing_media"))

    def test_later_history_failure_restores_store_counters_and_new_cas_files(self):
        source = {"id": "main-image-failure", "type": "main-image", "group_no": 1,
                  "status": "succeeded", "settings": {}, "screens": []}
        main.CANVAS_TASKS[source["id"]] = source
        archive_path, _ = main.build_backup_archive(main.BackupExportRequest(
            main_image_task_ids=[source["id"]],
            image_generation_task_ids=[self.task["id"]],
            include_image_generation_modes=True,
            include_assets=True,
        ))
        self.addCleanup(lambda: os.path.exists(archive_path) and os.remove(archive_path))
        Path(self.input_media["path"]).unlink()
        Path(self.output_media["path"]).unlink()
        before = self.store.snapshot_backup_state()
        with patch.object(main, "backup_import_main_images", side_effect=OSError("later failure")):
            with self.assertRaisesRegex(OSError, "later failure"):
                main.import_backup_path(archive_path, {
                    "main_image_task_ids": [source["id"]],
                    "image_generation_task_ids": [self.task["id"]],
                    "include_image_generation_modes": True,
                    "include_assets": True,
                })
        self.assertEqual(self.store.snapshot_backup_state(), before)
        self.assertIsNone(self.media.media_record(self.input_media["id"]))
        self.assertIsNone(self.media.media_record(self.output_media["id"]))

    def test_capacity_is_rejected_before_any_store_or_media_write(self):
        archive_path = self.export_image_generation()
        for index in range(199):
            task = copy.deepcopy(self.task)
            task["id"] = f"existing-{index:03d}"
            task["group_no"] = index + 20
            task["status"] = "succeeded"
            self.store.save_task(task)
        before = self.store.snapshot_backup_state()
        with self.assertRaisesRegex(ValueError, "200"):
            main.import_backup_path(archive_path, {
                "image_generation_task_ids": [self.task["id"]],
                "include_image_generation_modes": True,
                "include_assets": True,
            })
        self.assertEqual(self.store.snapshot_backup_state(), before)

    def test_hash_valid_non_image_resource_is_rejected_before_store_write(self):
        archive_path = self.export_image_generation()
        replacement = b"this-is-not-an-image"
        rewritten = Path(self.temp.name) / "invalid-image.zip"
        with zipfile.ZipFile(archive_path, "r") as source:
            members = {info.filename: source.read(info) for info in source.infolist()}
        manifest = json.loads(members["manifest.json"])
        resource = next(item for item in manifest["resources"] if item.get("scope") == "image-generation")
        members[resource["file"]] = replacement
        resource["sha256"] = __import__("hashlib").sha256(replacement).hexdigest()
        resource["size"] = len(replacement)
        members["manifest.json"] = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
        with zipfile.ZipFile(rewritten, "w", zipfile.ZIP_DEFLATED) as target:
            for name, content in members.items():
                target.writestr(name, content)
        before = self.store.snapshot_backup_state()
        with self.assertRaisesRegex(ValueError, "图片生成资源(?:格式无效|媒体标识不一致)"):
            main.import_backup_path(str(rewritten), {
                "image_generation_task_ids": [self.task["id"]],
                "include_image_generation_modes": True,
                "include_assets": True,
            })
        self.assertEqual(self.store.snapshot_backup_state(), before)

    def test_manifest_media_url_hash_must_match_declared_and_actual_hash_before_writes(self):
        archive_path = self.export_image_generation()
        rewritten = Path(self.temp.name) / "mismatched-media-identity.zip"
        replacement = _png_bytes((33, 144, 222, 255))
        replacement_hash = __import__("hashlib").sha256(replacement).hexdigest()
        with zipfile.ZipFile(archive_path, "r") as source:
            members = {info.filename: source.read(info) for info in source.infolist()}
        manifest = json.loads(members["manifest.json"])
        resource = next(
            item for item in manifest["resources"]
            if item.get("url") == self.input_media["url"]
        )
        self.assertNotEqual(replacement_hash, self.input_media["id"])
        members[resource["file"]] = replacement
        resource["sha256"] = replacement_hash
        resource["size"] = len(replacement)
        members["manifest.json"] = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
        with zipfile.ZipFile(rewritten, "w", zipfile.ZIP_DEFLATED) as target:
            for name, content in members.items():
                target.writestr(name, content)

        before_store = self.store.snapshot_backup_state()
        before_cas = {
            path.relative_to(self.media.media_root): path.read_bytes()
            for path in self.media.media_root.rglob("*") if path.is_file()
        }
        with (
            patch.object(main, "backup_adopt_image_generation_resource") as media_write,
            patch.object(self.store, "import_backup_bundle") as store_import,
        ):
            with self.assertRaisesRegex(ValueError, "媒体标识|资源校验失败"):
                main.import_backup_path(str(rewritten), {
                    "image_generation_task_ids": [self.task["id"]],
                    "include_image_generation_modes": True,
                    "include_assets": True,
                })
        media_write.assert_not_called()
        store_import.assert_not_called()
        self.assertEqual(self.store.snapshot_backup_state(), before_store)
        self.assertEqual({
            path.relative_to(self.media.media_root): path.read_bytes()
            for path in self.media.media_root.rglob("*") if path.is_file()
        }, before_cas)

    def test_export_revalidates_cas_media_and_marks_corrupt_files_missing(self):
        Path(self.input_media["path"]).write_bytes(b"corrupt-image-bytes")
        archive_path = self.export_image_generation()
        with zipfile.ZipFile(archive_path, "r") as archive:
            manifest = json.loads(archive.read("manifest.json"))
        self.assertIn(self.input_media["url"], manifest["missing_resources"])
        self.assertFalse(any(
            item.get("url") == self.input_media["url"]
            for item in manifest["resources"]
        ))

    def test_rollback_never_deletes_existing_cas_media_when_manifest_hash_is_absent(self):
        archive_path = self.export_image_generation()
        rewritten = Path(self.temp.name) / "resource-without-hash.zip"
        with zipfile.ZipFile(archive_path, "r") as source:
            members = {info.filename: source.read(info) for info in source.infolist()}
        manifest = json.loads(members["manifest.json"])
        resource = next(item for item in manifest["resources"] if item.get("scope") == "image-generation")
        media_id = __import__("hashlib").sha256(members[resource["file"]]).hexdigest()
        resource.pop("sha256", None)
        members["manifest.json"] = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
        with zipfile.ZipFile(rewritten, "w", zipfile.ZIP_DEFLATED) as target:
            for name, content in members.items():
                target.writestr(name, content)
        before = self.media.media_record(media_id)
        self.assertIsNotNone(before)
        with patch.object(self.store, "import_backup_bundle") as store_import:
            with self.assertRaisesRegex(ValueError, "缺少哈希"):
                main.import_backup_path(str(rewritten), {
                    "image_generation_task_ids": [self.task["id"]],
                    "include_image_generation_modes": True,
                    "include_assets": True,
                })
        store_import.assert_not_called()
        self.assertIsNotNone(self.media.media_record(media_id))

    def test_manifest_rejects_duplicate_or_mismatched_image_generation_task_ids_before_write(self):
        archive_path = self.export_image_generation()
        with zipfile.ZipFile(archive_path, "r") as source:
            original_members = {info.filename: source.read(info) for info in source.infolist()}
        for problem in ("duplicate", "mismatch"):
            with self.subTest(problem=problem):
                members = dict(original_members)
                manifest = json.loads(members["manifest.json"])
                if problem == "duplicate":
                    manifest["image_generations"].append(copy.deepcopy(manifest["image_generations"][0]))
                    expected = "重复任务"
                else:
                    member = f"image-generations/{self.task['id']}.json"
                    task = json.loads(members[member])
                    task["id"] = "different-task-id"
                    members[member] = json.dumps(task, ensure_ascii=False).encode("utf-8")
                    expected = "任务编号不匹配"
                members["manifest.json"] = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
                rewritten = Path(self.temp.name) / f"invalid-{problem}.zip"
                with zipfile.ZipFile(rewritten, "w", zipfile.ZIP_DEFLATED) as target:
                    for name, content in members.items():
                        target.writestr(name, content)
                before = self.store.snapshot_backup_state()
                with self.assertRaisesRegex(ValueError, expected):
                    main.import_backup_path(str(rewritten), {
                        "image_generation_task_ids": [self.task["id"]],
                        "include_image_generation_modes": True,
                        "include_assets": True,
                    })
                self.assertEqual(self.store.snapshot_backup_state(), before)

    def test_archive_rejects_duplicate_members_and_conflicting_shared_resource_hash_before_write(self):
        archive_path = self.export_image_generation()
        with zipfile.ZipFile(archive_path, "r") as source:
            original_infos = source.infolist()
            original_members = [(info.filename, source.read(info)) for info in original_infos]

        duplicate_zip = Path(self.temp.name) / "duplicate-member.zip"
        with zipfile.ZipFile(duplicate_zip, "w", zipfile.ZIP_DEFLATED) as target:
            for name, content in original_members:
                target.writestr(name, content)
            target.writestr(original_members[-1][0], original_members[-1][1])
        with patch.object(self.store, "import_backup_bundle") as store_import:
            with self.assertRaisesRegex(ValueError, "重复"):
                main.import_backup_path(str(duplicate_zip), {
                    "image_generation_task_ids": [self.task["id"]],
                    "include_image_generation_modes": True,
                    "include_assets": True,
                })
        store_import.assert_not_called()

        members = dict(original_members)
        manifest = json.loads(members["manifest.json"])
        resource = next(item for item in manifest["resources"] if item.get("scope") == "image-generation")
        conflicting = copy.deepcopy(resource)
        conflicting["sha256"] = "0" * 64
        manifest["resources"].append(conflicting)
        members["manifest.json"] = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
        conflicting_zip = Path(self.temp.name) / "conflicting-resource.zip"
        with zipfile.ZipFile(conflicting_zip, "w", zipfile.ZIP_DEFLATED) as target:
            for name, content in members.items():
                target.writestr(name, content)
        before = self.store.snapshot_backup_state()
        with (
            patch.object(main, "backup_adopt_image_generation_resource") as media_write,
            patch.object(self.store, "import_backup_bundle") as store_import,
        ):
            with self.assertRaisesRegex(ValueError, "资源校验失败"):
                main.import_backup_path(str(conflicting_zip), {
                    "image_generation_task_ids": [self.task["id"]],
                    "include_image_generation_modes": True,
                    "include_assets": True,
                })
        media_write.assert_not_called()
        store_import.assert_not_called()
        self.assertEqual(self.store.snapshot_backup_state(), before)


if __name__ == "__main__":
    unittest.main()
