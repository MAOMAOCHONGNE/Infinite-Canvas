import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from image_generation_media import ImageGenerationMediaStore
from image_generation_cleanup import ImageGenerationCleanupTransaction
from image_generation_store import ImageGenerationStore
from tests.image_generation_test_seed import ensure_seed
import main


SEED_PATH = ensure_seed(ROOT / "tests" / "fixtures" / "image-generation-presets-test.json")


def image_bytes(format_name="PNG", size=(12, 9)):
    buffer = io.BytesIO()
    Image.new("RGB", size, (10, 50, 90)).save(buffer, format_name)
    return buffer.getvalue()


class ImageGenerationMediaStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.store = ImageGenerationMediaStore(self.root)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_identical_decoded_media_is_stored_once_with_safe_metadata(self):
        content = image_bytes("PNG", (31, 17))
        first = self.store.adopt_bytes(content, ".jpg", "image/jpeg")
        second = self.store.adopt_bytes(content, ".png", "image/png")

        self.assertEqual(first["id"], second["id"])
        self.assertTrue(Path(first["path"]).samefile(second["path"]))
        self.assertEqual(first["media_type"], "image/png")
        self.assertEqual(first["width"], 31)
        self.assertEqual(first["height"], 17)
        self.assertEqual(first["url"], second["url"])
        self.assertNotIn("path", self.store.media_record(first["id"]))
        metadata = json.loads(self.store._metadata_path(first["id"]).read_text(encoding="utf-8"))
        self.assertEqual(metadata["media_id"], first["id"])
        self.assertIn("created_at", metadata)
        self.assertIn("last_adopted_at", metadata)

    def test_media_activity_uses_metadata_and_legacy_file_mtime_fallback(self):
        record = self.store.adopt_bytes(image_bytes(), ".png", "image/png")
        metadata_activity = self.store.media_activity_time(record["id"])
        self.assertIsNotNone(metadata_activity)
        self.store._metadata_path(record["id"]).unlink()
        legacy_time = datetime.now(timezone.utc) - timedelta(days=12)
        os.utime(Path(record["path"]), (legacy_time.timestamp(), legacy_time.timestamp()))
        fallback = self.store.media_activity_time(record["id"])
        self.assertAlmostEqual(fallback.timestamp(), legacy_time.timestamp(), delta=2)

    def test_cleanup_transaction_restores_preparing_and_finishes_committed_operations(self):
        task_root = self.root / "data" / "image_generation_tasks"
        media_root = self.root / "assets" / "image-generation" / "media"
        metadata_root = self.root / "data" / "image_generation_media_metadata"
        allowed = (task_root, media_root, metadata_root)
        task_root.mkdir(parents=True)

        preparing_file = task_root / "preparing.json"
        preparing_file.write_text("{}", encoding="utf-8")
        preparing = ImageGenerationCleanupTransaction(self.root, allowed)
        preparing.begin()
        preparing.stage([preparing_file])
        self.assertFalse(preparing_file.exists())
        ImageGenerationCleanupTransaction.recover_pending(self.root, allowed)
        self.assertTrue(preparing_file.exists())

        committed_file = task_root / "committed.json"
        committed_file.write_text("{}", encoding="utf-8")
        committed = ImageGenerationCleanupTransaction(self.root, allowed)
        committed.begin()
        committed.stage([committed_file])
        committed.manifest["phase"] = "committed"
        committed._atomic_write(committed.manifest_path, committed.manifest)
        ImageGenerationCleanupTransaction.recover_pending(self.root, allowed)
        self.assertFalse(committed_file.exists())
        self.assertFalse(committed.operation_root.exists())

    def test_uses_decoded_format_and_rejects_undecodable_or_oversize_images(self):
        normalized = self.store.adopt_bytes(image_bytes("PNG"), ".jpg", "image/jpeg")
        self.assertEqual(normalized["media_type"], "image/png")
        self.assertTrue(normalized["url"].endswith(".png"))
        with self.assertRaises(ValueError):
            self.store.adopt_bytes(b"not an image", ".png", "image/png")
        with self.assertRaises(ValueError):
            self.store.adopt_bytes(b"x" * (50 * 1024 * 1024 + 1), ".png", "image/png")

    def test_adopt_local_url_only_reads_controlled_content_addressed_files(self):
        record = self.store.adopt_bytes(image_bytes(), ".png", "image/png")
        adopted = self.store.adopt_local_url(record["url"])
        self.assertEqual(adopted["id"], record["id"])
        for unsafe in ("https://example.test/a.png", "/assets/../data/secret", record["url"] + "?token=x"):
            with self.subTest(unsafe=unsafe):
                with self.assertRaises(ValueError):
                    self.store.adopt_local_url(unsafe)

    def test_reference_scan_pins_example_draft_and_task_media(self):
        first = self.store.adopt_bytes(image_bytes(), ".png", "image/png")
        second = self.store.adopt_bytes(image_bytes("JPEG"), ".jpg", "image/jpeg")
        records = [
            {"example": {"input_media": [self.store.media_record(first["id"])]}},
            {"inputs": [{"media": self.store.media_record(second["id"])}]},
            {"candidates": [{"image": self.store.media_record(first["id"])}]},
        ]
        self.assertEqual(
            self.store.referenced_media_ids(records=records), {first["id"], second["id"]}
        )
        self.assertEqual(self.store.move_unreferenced_to_trash({first["id"], second["id"]}), [])

    def test_trash_purge_requires_strictly_more_than_thirty_days(self):
        record = self.store.adopt_bytes(image_bytes(), ".png", "image/png")
        moved = self.store.move_unreferenced_to_trash(set())
        self.assertEqual(moved, [record["id"]])
        sidecar = next(self.store.trash_root.rglob("*.json"))
        payload = json.loads(sidecar.read_text(encoding="utf-8"))
        boundary = datetime.now(timezone.utc)
        payload["deleted_at"] = (boundary - timedelta(days=30)).isoformat()
        sidecar.write_text(json.dumps(payload), encoding="utf-8")
        self.assertEqual(self.store.purge_expired_trash(now=boundary), [])
        self.assertEqual(self.store.purge_expired_trash(now=boundary + timedelta(microseconds=1)), [record["id"]])

    def test_prune_empty_shard_directories_only_removes_empty_children(self):
        record = self.store.adopt_bytes(image_bytes(), ".png", "image/png")
        shard = self.store.media_root / record["id"][:2]
        Path(record["path"]).unlink()
        self.assertTrue(shard.is_dir())
        kept = self.store.media_root / "keep"
        kept.mkdir(parents=True)
        (kept / "not-empty.txt").write_text("keep", encoding="utf-8")

        removed = self.store.prune_empty_shard_directories()

        self.assertIn(shard, removed)
        self.assertFalse(shard.exists())
        self.assertTrue(kept.exists())

    def test_corrupt_trash_sidecar_cannot_escape_its_own_directory(self):
        protected = self.root / "must-not-delete.png"
        protected.write_bytes(image_bytes())
        sidecar = self.store.trash_root / "2026-01-01" / "malformed.json"
        sidecar.parent.mkdir(parents=True)
        sidecar.write_text(json.dumps({
            "media_id": "a" * 64,
            "deleted_at": "2020-01-01T00:00:00+00:00",
            "filename": "../must-not-delete.png",
        }), encoding="utf-8")
        self.assertEqual(self.store.purge_expired_trash(), [])
        self.assertTrue(protected.exists())

    def _directory_link(self, link: Path, target: Path):
        link.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.symlink(target, link, target_is_directory=True)
        except (NotImplementedError, OSError) as exc:
            self.skipTest(f"directory links unavailable in this test environment: {exc}")

    def _directory_junction(self, link: Path, target: Path):
        link.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["cmd.exe", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True, text=True, check=False,
        )
        if result.returncode != 0:
            self.skipTest(f"directory junctions unavailable in this test environment: {result.stderr}")

    def test_media_record_and_trash_never_follow_a_linked_media_shard(self):
        content = image_bytes()
        media_id = __import__("hashlib").sha256(content).hexdigest()
        external = self.root / "external-media"
        external.mkdir()
        external_file = external / f"{media_id}.png"
        external_file.write_bytes(content)
        self._directory_link(self.store.media_root / media_id[:2], external)

        self.assertIsNone(self.store.media_record(media_id))
        self.assertEqual(self.store.move_unreferenced_to_trash(set()), [])
        self.assertTrue(external_file.exists())

    def test_purge_never_follows_linked_trash_root_or_date_directory(self):
        content = image_bytes()
        media_id = __import__("hashlib").sha256(content).hexdigest()
        for label in ("root", "date"):
            with self.subTest(label=label):
                isolated = ImageGenerationMediaStore(self.root / label)
                external = self.root / f"external-trash-{label}"
                external.mkdir()
                image_path = external / f"{media_id}.png"
                image_path.write_bytes(content)
                (external / f"{media_id}.json").write_text(json.dumps({
                    "media_id": media_id,
                    "deleted_at": "2020-01-01T00:00:00+00:00",
                    "filename": image_path.name,
                }), encoding="utf-8")
                link = isolated.trash_root if label == "root" else isolated.trash_root / "2020-01-01"
                self._directory_link(link, external)
                self.assertEqual(isolated.purge_expired_trash(), [])
                self.assertTrue(image_path.exists())

    def test_adopt_local_url_rejects_claimed_hash_that_does_not_match_bytes(self):
        fake_id = "a" * 64
        fake_path = self.store.media_root / fake_id[:2] / f"{fake_id}.png"
        fake_path.parent.mkdir(parents=True)
        fake_path.write_bytes(image_bytes())
        with self.assertRaises(ValueError):
            self.store.adopt_local_url(f"/assets/image-generation/media/{fake_id[:2]}/{fake_path.name}")

    def test_reference_scan_ignores_arbitrary_nested_hash_but_pins_valid_record(self):
        record = self.store.adopt_bytes(image_bytes(), ".png", "image/png")
        self.assertEqual(self.store.referenced_media_ids(records=[{
            "metadata": {"media_id": record["id"]},
        }]), set())
        self.assertEqual(self.store.referenced_media_ids(records=[{
            "inputs": [{"media": self.store.media_record(record["id"])}],
        }]), {record["id"]})

    def test_failed_trash_sidecar_write_rolls_media_back_to_live_storage(self):
        record = self.store.adopt_bytes(image_bytes(), ".png", "image/png")
        original_write = self.store._atomic_write

        def fail_sidecar(target, content):
            if target.suffix == ".json":
                raise OSError("sidecar disk failure")
            return original_write(target, content)

        with patch.object(self.store, "_atomic_write", side_effect=fail_sidecar):
            self.assertEqual(self.store.move_unreferenced_to_trash(set()), [])
        self.assertTrue(Path(record["path"]).exists())

    def test_corrupt_persisted_reference_stops_trash_reconciliation_conservatively(self):
        record = self.store.adopt_bytes(image_bytes(), ".png", "image/png")
        task_path = self.store.data_root / "image_generation_tasks" / "corrupt.json"
        task_path.parent.mkdir(parents=True)
        task_path.write_text("{not json", encoding="utf-8")
        self.assertEqual(self.store.move_unreferenced_to_trash(set()), [])
        self.assertTrue(Path(record["path"]).exists())

    def test_reference_scan_can_protect_candidate_ids_after_media_is_staged(self):
        record = self.store.adopt_bytes(image_bytes(), ".png", "image/png")
        task_path = self.store.data_root / "image_generation_tasks" / "kept.json"
        task_path.parent.mkdir(parents=True, exist_ok=True)
        task_path.write_text(json.dumps({
            "id": "kept",
            "type": "image-generation",
            "candidates": [{"image": self.store.media_record(record["id"])}],
        }), encoding="utf-8")
        Path(record["path"]).unlink()

        self.assertIn(
            record["id"],
            self.store.referenced_media_ids(include_missing_media_ids={record["id"]}),
        )

    def test_unsafe_reference_roots_fail_closed_for_modes_drafts_and_tasks(self):
        for directory_name in (
            "image_generation_modes",
            "image_generation_drafts",
            "image_generation_tasks",
        ):
            with self.subTest(directory_name=directory_name):
                isolated = ImageGenerationMediaStore(self.root / directory_name)
                record = isolated.adopt_bytes(image_bytes(), ".png", "image/png")
                external = self.root / f"external-reference-{directory_name}"
                external.mkdir()
                self._directory_link(isolated.data_root / directory_name, external)
                with self.assertRaises(ValueError):
                    isolated.referenced_media_ids()
                self.assertEqual(isolated.move_unreferenced_to_trash(set()), [])
                self.assertTrue(Path(record["path"]).exists())

    def test_unsafe_data_root_fails_closed_before_child_existence_checks(self):
        for link_kind, make_link in (("symlink", self._directory_link), ("junction", self._directory_junction)):
            for state in ("empty", "with-child"):
                with self.subTest(link_kind=link_kind, state=state):
                    isolated = ImageGenerationMediaStore(self.root / f"{link_kind}-{state}")
                    record = isolated.adopt_bytes(image_bytes(), ".png", "image/png")
                    external = self.root / f"external-data-{link_kind}-{state}"
                    external.mkdir()
                    if state == "with-child":
                        (external / "image_generation_tasks").mkdir()
                    make_link(isolated.data_root, external)
                    with self.assertRaises(ValueError):
                        isolated.referenced_media_ids()
                    self.assertEqual(isolated.move_unreferenced_to_trash(set()), [])
                    self.assertTrue(Path(record["path"]).exists())


class ImageGenerationMediaApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.store = ImageGenerationStore(self.root / "data", SEED_PATH)
        self.store.initialize()
        self.media = ImageGenerationMediaStore(self.root)
        self.mode_id = next(item["id"] for item in self.store.list_modes() if item["mode_no"] == 25)
        self.original_store = main.IMAGE_GENERATION_STORE
        self.original_media = getattr(main, "IMAGE_GENERATION_MEDIA_STORE", None)
        self.original_static_dir = main.STATIC_DIR
        main.IMAGE_GENERATION_STORE = self.store
        main.IMAGE_GENERATION_MEDIA_STORE = self.media
        main.STATIC_DIR = str(self.root / "static")
        main.IMAGE_GENERATION_ADMIN_TOKENS.clear()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        main.IMAGE_GENERATION_STORE = self.original_store
        main.IMAGE_GENERATION_MEDIA_STORE = self.original_media
        main.STATIC_DIR = self.original_static_dir
        main.IMAGE_GENERATION_ADMIN_TOKENS.clear()
        self.temp_dir.cleanup()

    def _unlock(self):
        response = self.client.post("/api/image-generation/admin/unlock", json={"password": "451462"})
        self.assertEqual(response.status_code, 200)
        return {"X-Image-Generation-Admin": response.json()["token"]}

    def _upload(self):
        response = self.client.post(
            "/api/image-generation/media",
            files=[("files", ("input.png", image_bytes(), "image/png"))],
        )
        self.assertEqual(response.status_code, 200)
        return response.json()["items"][0]

    def test_upload_validates_content_and_draft_only_keeps_persistent_mode_slots(self):
        media = self._upload()
        draft = {
            "inputs": [{"slot_key": "ref1", "media_id": media["id"]}],
            "user_prompt": "蓝色背景",
            "generation_settings": {"aspect_ratio": "1:1", "resolution": "2k"},
        }
        saved = self.client.patch(f"/api/image-generation/modes/{self.mode_id}/draft", json=draft)
        self.assertEqual(saved.status_code, 200)
        stored = saved.json()["item"]
        self.assertEqual(stored["inputs"][0]["media"]["id"], media["id"])
        self.assertNotIn("path", json.dumps(stored, ensure_ascii=False))
        self.assertEqual(self.client.get(f"/api/image-generation/modes/{self.mode_id}/draft").json()["item"], stored)

        duplicate_slot = dict(draft, inputs=draft["inputs"] * 2)
        self.assertEqual(self.client.patch(f"/api/image-generation/modes/{self.mode_id}/draft", json=duplicate_slot).status_code, 422)
        invalid_media = dict(draft, inputs=[{"slot_key": "ref1", "media_id": "missing"}])
        self.assertEqual(self.client.patch(f"/api/image-generation/modes/{self.mode_id}/draft", json=invalid_media).status_code, 422)
        self.assertEqual(
            self.client.patch(
                f"/api/image-generation/modes/{self.mode_id}/draft",
                json={**draft, "user_prompt": "data:image/png;base64,AAAA"},
            ).status_code,
            422,
        )
        forbidden_settings = {
            **draft,
            "generation_settings": {
                "final_prompt": "LEAKED_INTERNAL",
                "preset_prompt": "SECRET",
                "arbitrary": {"runtime_token": "x"},
            },
        }
        self.assertEqual(
            self.client.patch(f"/api/image-generation/modes/{self.mode_id}/draft", json=forbidden_settings).status_code,
            422,
        )

    def test_draft_keeps_ratio_mode_and_custom_ratio_fields(self):
        media = self._upload()
        draft = {
            "inputs": [{"slot_key": "ref1", "media_id": media["id"]}],
            "user_prompt": "竖版构图",
            "generation_settings": {
                "ratio_mode": "custom",
                "custom_ratio_width": "7",
                "custom_ratio_height": "3",
                "aspect_ratio": "7:3",
                "resolution": "2k",
                "size": "2016x864",
            },
        }
        saved = self.client.patch(
            f"/api/image-generation/modes/{self.mode_id}/draft", json=draft
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        restored = self.client.get(
            f"/api/image-generation/modes/{self.mode_id}/draft"
        ).json()["item"]
        self.assertEqual(restored["generation_settings"], draft["generation_settings"])

    def test_upload_rejects_more_than_six_files_before_adoption(self):
        response = self.client.post(
            "/api/image-generation/media",
            files=[("files", (f"input-{index}.png", image_bytes(), "image/png")) for index in range(7)],
        )
        self.assertEqual(response.status_code, 422)
        self.assertFalse(self.media.media_root.exists())

    def test_public_draft_get_redacts_unsafe_legacy_generation_settings(self):
        self.store.save_workspace_draft(self.mode_id, {
            "inputs": [],
            "user_prompt": "safe text",
            "generation_settings": {"final_prompt": "must-not-leak", "runtime_token": "x"},
        })
        response = self.client.get(f"/api/image-generation/modes/{self.mode_id}/draft")
        self.assertEqual(response.status_code, 200)
        encoded = json.dumps(response.json(), ensure_ascii=False)
        self.assertNotIn("must-not-leak", encoded)
        self.assertNotIn("runtime_token", encoded)
        self.assertEqual(response.json()["item"]["generation_settings"], {})

    def test_example_is_admin_only_atomic_and_publicly_visible(self):
        input_media = self._upload()
        output_media = self.media.adopt_bytes(image_bytes("WEBP"), ".webp", "image/webp")
        self.store.save_task({
            "id": "successful-task", "mode_id": self.mode_id, "status": "failed",
            "inputs": [{"slot_key": "ref1", "media": input_media}],
            "candidates": [{"id": "winner", "status": "succeeded", "image": self.media.media_record(output_media["id"])}],
            "prompt_snapshot": "must not leak",
            "prompt_version_id": "version-1",
            "generation_settings": {
                "image_model": "mock-image-model", "aspect_ratio": "4:5", "resolution": "2k",
            },
        })
        request = {"task_id": "successful-task", "candidate_id": "winner", "sample_user_prompt": "蓝色背景", "caption": "示范", "show_user_prompt": False}
        self.assertEqual(self.client.post(f"/api/image-generation/modes/{self.mode_id}/example", json=request).status_code, 403)
        response = self.client.post(f"/api/image-generation/modes/{self.mode_id}/example", json=request, headers=self._unlock())
        self.assertEqual(response.status_code, 200)
        public = self.client.get(f"/api/image-generation/modes/{self.mode_id}").json()
        encoded = json.dumps(public, ensure_ascii=False)
        self.assertIn("示范", encoded)
        self.assertIn("蓝色背景", encoded)
        self.assertNotIn("must not leak", encoded)
        source = self.store.get_mode(self.mode_id, include_admin=True)["example"]["source"]
        self.assertEqual(source["model"], "mock-image-model")
        self.assertEqual(source["aspect_ratio"], "4:5")
        self.assertEqual(source["resolution"], "2k")
        self.assertEqual(source["prompt_version_id"], "version-1")

        before = self.store.get_mode(self.mode_id, include_admin=True)["example"]
        bad = dict(request, candidate_id="not-a-candidate")
        self.assertEqual(self.client.post(f"/api/image-generation/modes/{self.mode_id}/example", json=bad, headers=self._unlock()).status_code, 422)
        self.assertEqual(self.store.get_mode(self.mode_id, include_admin=True)["example"], before)


if __name__ == "__main__":
    unittest.main()
