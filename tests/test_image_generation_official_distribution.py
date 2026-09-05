import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from image_generation_store import ImageGenerationStore


def mode(mode_id, number, name):
    return {
        "id": mode_id,
        "display_name": name,
        "description": "官方模式",
        "category": "测试",
        "tags": [],
        "synonyms": [],
        "sort_order": number,
        "preset_prompt": f"prompt-{number}",
        "required_reference_count": 0,
        "reference_images": [],
        "max_upload_count": 1,
        "allow_extra_images": False,
        "extra_image_limit": 0,
        "special_hint": "",
        "remark": "",
        "mode_no": number,
    }


class OfficialDistributionTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.seed_v1 = self.root / "seed-v1.json"
        self.seed_v2 = self.root / "seed-v2.json"
        self.seed_v1.write_text(json.dumps({
            "distribution_version": "1",
            "source_version": "1",
            "modes": [mode("official-1", 1, "官方一")],
        }), encoding="utf-8")
        self.seed_v2.write_text(json.dumps({
            "distribution_version": "2",
            "source_version": "2",
            "modes": [
                mode("official-1", 1, "官方一新版"),
                mode("official-2", 2, "官方二"),
            ],
        }), encoding="utf-8")
        self.source = ImageGenerationStore(self.root / "source", self.seed_v2)
        self.target = ImageGenerationStore(self.root / "target", self.seed_v1)
        self.source.initialize()
        self.target.initialize()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_empty_public_seed_is_valid_and_does_not_clear_existing_local_modes(self):
        public_seed = ROOT / "static" / "data" / "image-generation-presets.v1.json"
        empty = ImageGenerationStore(self.root / "empty", public_seed)
        empty.initialize()
        self.assertEqual(empty.list_modes(include_admin=True), [])
        empty.initialize()
        self.assertEqual(empty.list_modes(include_admin=True), [])
        empty.import_backup_bundle(self.source.export_backup_bundle(), [], imported_at=1.0)
        self.assertEqual(
            [item["mode_no"] for item in empty.list_modes(include_admin=True)], [1, 2]
        )

    def test_official_import_updates_in_place_and_reimport_is_idempotent(self):
        bundle = self.source.export_backup_bundle()
        result = self.target.import_backup_bundle(bundle, [], imported_at=1.0)
        self.assertEqual(result["mode_ids"], ["official-1", "official-2"])
        self.assertEqual(len(self.target.list_modes(include_admin=True)), 2)
        first = self.target.get_mode("official-1", include_admin=True)
        self.assertEqual(first["display_name"], "官方一新版")
        self.assertEqual(first["mode_no"], 1)
        self.assertEqual(first["source_id"], "official-1")
        self.assertTrue(first["builtin"])
        second = self.target.get_mode("official-2", include_admin=True)
        self.assertEqual(second["mode_no"], 2)

        again = self.target.import_backup_bundle(bundle, [], imported_at=2.0)
        self.assertEqual(again["mode_ids"], ["official-1", "official-2"])
        self.assertEqual(len(self.target.list_modes(include_admin=True)), 2)

    def test_official_number_conflict_with_custom_mode_fails_without_writes(self):
        custom = self.target.create_mode({"display_name": "本机自定义"})
        self.assertEqual(custom["mode_no"], 2)
        bundle = self.source.export_backup_bundle()
        before = self.target.snapshot_backup_state()
        with self.assertRaisesRegex(ValueError, "编号冲突"):
            self.target.import_backup_bundle(bundle, [], imported_at=1.0)
        self.assertEqual(self.target.snapshot_backup_state(), before)

    def test_legacy_builtin_without_source_id_maps_by_fixed_number_once(self):
        legacy = self.target.get_mode("official-1", include_admin=True)
        legacy.pop("source_id", None)
        legacy["builtin"] = True
        self.target._write_json(self.target._mode_path("official-1"), legacy)
        result = self.target.import_backup_bundle(self.source.export_backup_bundle(), [], imported_at=1.0)
        self.assertEqual(result["mode_id_map"]["official-1"], "official-1")
        self.assertEqual(
            self.target.get_mode("official-1", include_admin=True)["source_id"], "official-1"
        )

    def test_lower_official_version_cannot_downgrade(self):
        self.target.import_backup_bundle(self.source.export_backup_bundle(), [], imported_at=1.0)
        old = ImageGenerationStore(self.root / "old", self.seed_v1)
        old.initialize()
        with self.assertRaisesRegex(ValueError, "版本"):
            self.target.import_backup_bundle(old.export_backup_bundle(), [], imported_at=2.0)

    def test_removed_official_mode_is_archived_and_static_case_is_portable(self):
        case_seed = self.root / "seed-case.json"
        payload = json.loads(self.seed_v1.read_text(encoding="utf-8"))
        payload["modes"][0]["example"] = {
            "id": "case-1",
            "mode_id": "official-1",
            "input_media": [],
            "output_media": {"url": "/static/image-generation-examples/official-1/out.png"},
        }
        case_seed.write_text(json.dumps(payload), encoding="utf-8")
        source = ImageGenerationStore(self.root / "case-source", case_seed)
        source.initialize()
        exported = source.export_backup_bundle()
        self.assertEqual(
            exported["modes"][0]["example"]["output_media"]["url"],
            "/static/image-generation-examples/official-1/out.png",
        )

        removed_seed = self.root / "seed-removed.json"
        removed_seed.write_text(json.dumps({
            "distribution_version": "2",
            "source_version": "2",
            "modes": [],
        }), encoding="utf-8")
        removed_source = ImageGenerationStore(self.root / "removed-source", removed_seed)
        removed_source.initialize()
        removed_bundle = removed_source.export_backup_bundle()
        self.target.import_backup_bundle(removed_bundle, [], imported_at=1.0)
        self.assertEqual(self.target.get_mode("official-1", include_admin=True)["status"], "archived")

    def test_missing_official_case_rolls_back_before_writing(self):
        source_bundle = self.source.export_backup_bundle()
        source_bundle["modes"][0]["example"] = {
            "id": "case-1",
            "mode_id": "official-1",
            "input_media": [],
            "output_media": {"url": "/static/image-generation-examples/official-1/out.png"},
        }
        before = self.target.snapshot_backup_state()
        with self.assertRaisesRegex(ValueError, "案例图缺失"):
            self.target.import_backup_bundle(
                source_bundle,
                [],
                imported_at=1.0,
                unavailable_urls={"/static/image-generation-examples/official-1/out.png"},
            )
        self.assertEqual(self.target.snapshot_backup_state(), before)


if __name__ == "__main__":
    unittest.main()
