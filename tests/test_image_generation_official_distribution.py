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

    def test_complete_snapshot_overwrites_custom_mode_by_number_in_place(self):
        custom = self.target.create_mode({
            "display_name": "本机自定义",
            "preset_prompt": "local-prompt",
        })
        self.assertEqual(custom["mode_no"], 2)
        custom_id = custom["id"]
        self.target.save_workspace_draft(custom_id, {
            "inputs": [],
            "user_prompt": "保留本机工作区",
            "generation_settings": {},
        })
        bundle = self.source.export_backup_bundle()
        result = self.target.import_backup_bundle(bundle, [], imported_at=1.0)

        self.assertEqual(result["mode_id_map"]["official-2"], custom_id)
        imported = self.target.get_mode(custom_id, include_admin=True)
        self.assertEqual(imported["mode_no"], 2)
        self.assertEqual(imported["display_name"], "官方二")
        self.assertEqual(imported["preset_prompt"], "prompt-2")
        self.assertEqual(imported["source_id"], "official-2")
        self.assertTrue(imported["builtin"])
        self.assertEqual(imported["status"], "active")
        self.assertEqual(
            self.target.load_workspace_draft(custom_id)["user_prompt"],
            "保留本机工作区",
        )
        self.assertEqual(result["mode_counts"]["updated"], 2)

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

    def test_lower_official_version_replaces_current_snapshot_and_archives_extra_mode(self):
        self.target.import_backup_bundle(self.source.export_backup_bundle(), [], imported_at=1.0)
        second_id = next(
            item["id"] for item in self.target.list_modes(include_admin=True)
            if item["mode_no"] == 2
        )
        old = ImageGenerationStore(self.root / "old", self.seed_v1)
        old.initialize()
        result = self.target.import_backup_bundle(old.export_backup_bundle(), [], imported_at=2.0)

        self.assertEqual(
            self.target.get_mode("official-1", include_admin=True)["display_name"],
            "官方一",
        )
        self.assertEqual(
            self.target.get_mode(second_id, include_admin=True)["status"],
            "archived",
        )
        self.assertEqual(result["mode_counts"]["archived"], 1)
        self.assertEqual(self.target._read_meta()["official_content_version"], "1")

        reactivated = self.target.import_backup_bundle(
            self.source.export_backup_bundle(), [], imported_at=3.0
        )
        self.assertEqual(reactivated["mode_id_map"]["official-2"], second_id)
        self.assertEqual(
            self.target.get_mode(second_id, include_admin=True)["status"],
            "active",
        )
        self.assertEqual(reactivated["mode_counts"]["reactivated"], 1)

    def test_complete_snapshot_archives_repeated_legacy_import_copies_without_deleting_them(self):
        official_two = self.source.get_mode("official-2", include_admin=True)
        create_payload = {
            key: copy.deepcopy(official_two[key])
            for key in (
                "display_name", "description", "category", "sort_order",
                "preset_prompt", "required_reference_count",
                "reference_images", "max_upload_count", "allow_extra_images",
                "extra_image_limit", "special_hint", "remark",
            )
            if key in official_two
        }
        legacy_copies = [self.target.create_mode(create_payload) for _ in range(3)]
        canonical_id = legacy_copies[0]["id"]
        duplicate_ids = [item["id"] for item in legacy_copies[1:]]
        self.target.save_workspace_draft(duplicate_ids[0], {
            "inputs": [], "user_prompt": "旧副本草稿", "generation_settings": {},
        })
        duplicate_versions = {
            mode_id: [item["id"] for item in self.target.list_prompt_versions(mode_id)]
            for mode_id in duplicate_ids
        }

        result = self.target.import_backup_bundle(
            self.source.export_backup_bundle(), [], imported_at=1.0
        )

        self.assertEqual(result["mode_id_map"]["official-2"], canonical_id)
        self.assertEqual(
            [item["mode_no"] for item in self.target.list_modes(include_admin=True)
             if item["status"] == "active"],
            [1, 2],
        )
        self.assertEqual(
            [self.target.get_mode(item, include_admin=True)["status"] for item in duplicate_ids],
            ["archived", "archived"],
        )
        self.assertIsNotNone(self.target.load_workspace_draft(duplicate_ids[0]))
        for mode_id, version_ids in duplicate_versions.items():
            self.assertTrue(version_ids)
            self.assertEqual(
                [item["id"] for item in self.target.list_prompt_versions(mode_id)],
                version_ids,
            )
        self.assertEqual(result["mode_counts"]["archived"], 2)
        self.assertEqual(len(self.target.list_modes(include_admin=True)), 4)

        again = self.target.import_backup_bundle(
            self.source.export_backup_bundle(), [], imported_at=2.0
        )
        self.assertEqual(len(self.target.list_modes(include_admin=True)), 4)
        self.assertEqual(again["mode_counts"]["created"], 0)
        self.assertEqual(again["mode_counts"]["archived"], 0)

    def test_complete_export_excludes_archived_modes(self):
        archived = self.source.get_mode("official-2", include_admin=True)
        archived["status"] = "archived"
        self.source._write_json(self.source._mode_path(archived["id"]), archived)

        bundle = self.source.export_backup_bundle()

        self.assertEqual([item["mode_no"] for item in bundle["modes"]], [1])
        self.assertTrue(all(item["mode_id"] == "official-1" for item in bundle["versions"]))

    def test_complete_snapshot_repairs_the_93_mode_legacy_shape(self):
        source_seed = self.root / "source-65.json"
        target_seed = self.root / "target-51.json"
        source_seed.write_text(json.dumps({
            "distribution_version": "65",
            "source_version": "65",
            "modes": [mode(f"official-{number}", number, f"官方{number}") for number in range(1, 66)],
        }), encoding="utf-8")
        target_seed.write_text(json.dumps({
            "distribution_version": "51",
            "source_version": "51",
            "modes": [mode(f"official-{number}", number, f"官方{number}") for number in range(1, 52)],
        }), encoding="utf-8")
        source = ImageGenerationStore(self.root / "source-65", source_seed)
        target = ImageGenerationStore(self.root / "target-93", target_seed)
        source.initialize()
        target.initialize()
        canonical_ids = {}
        for repeat in range(3):
            for number in range(52, 66):
                official = source.get_mode(f"official-{number}", include_admin=True)
                created = target.create_mode({
                    key: copy.deepcopy(official[key])
                    for key in (
                        "display_name", "description", "category", "sort_order",
                        "preset_prompt", "required_reference_count", "reference_images",
                        "max_upload_count", "allow_extra_images", "extra_image_limit",
                        "special_hint", "remark",
                    )
                    if key in official
                })
                if repeat == 0:
                    canonical_ids[number] = created["id"]
        self.assertEqual(
            sorted(item["mode_no"] for item in target.list_modes(include_admin=True)),
            list(range(1, 94)),
        )

        result = target.import_backup_bundle(source.export_backup_bundle(), [], imported_at=1.0)
        all_modes = target.list_modes(include_admin=True)

        self.assertEqual(len(all_modes), 93)
        self.assertEqual(
            sorted(item["mode_no"] for item in all_modes if item["status"] == "active"),
            list(range(1, 66)),
        )
        self.assertEqual(
            sorted(item["mode_no"] for item in all_modes if item["status"] == "archived"),
            list(range(66, 94)),
        )
        self.assertEqual(result["mode_id_map"]["official-52"], canonical_ids[52])
        self.assertEqual(result["mode_id_map"]["official-65"], canonical_ids[65])
        self.assertEqual(result["mode_counts"]["created"], 0)
        self.assertEqual(result["mode_counts"]["updated"], 65)
        self.assertEqual(result["mode_counts"]["archived"], 28)

        again = target.import_backup_bundle(source.export_backup_bundle(), [], imported_at=2.0)
        self.assertEqual(len(target.list_modes(include_admin=True)), 93)
        self.assertEqual(again["mode_counts"]["created"], 0)
        self.assertEqual(again["mode_counts"]["archived"], 0)

    def test_complete_snapshot_clears_local_example_when_package_has_none(self):
        local = self.target.get_mode("official-1", include_admin=True)
        local["example"] = {"id": "old-example", "mode_id": local["id"]}
        self.target._write_json(self.target._mode_path(local["id"]), local)

        self.target.import_backup_bundle(self.source.export_backup_bundle(), [], imported_at=1.0)

        self.assertIsNone(
            self.target.get_mode("official-1", include_admin=True).get("example")
        )

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
