import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from image_generation_modes import (
    ONLINE_IMAGE_PROMPT_MAX_LENGTH,
    admin_mode,
    build_mode_search_text,
    compose_final_prompt,
    diff_source_modes,
    normalize_mode,
    public_mode,
)


class ImageGenerationModeTests(unittest.TestCase):
    def git_ignore_returncode(self, relative_path):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".gitignore").write_text(
                (Path(ROOT) / ".gitignore").read_text("utf-8"),
                encoding="utf-8",
            )
            target = root / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("test-only", encoding="utf-8")
            subprocess.run(
                ["git", "init", "--quiet"],
                cwd=root,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            result = subprocess.run(
                ["git", "check-ignore", "--quiet", relative_path],
                cwd=root,
                check=False,
            )
            return result.returncode

    def test_final_prompt_preserves_raw_preset_and_appends_structured_context(self):
        mode = normalize_mode({
            "id": "id-photo-test",
            "display_name": "25一键证件照",
            "preset_prompt": "原始提示词\n第二行",
            "required_reference_count": 1,
            "reference_images": [{"key": "ref1", "label": "人物原图", "required": True}],
            "max_upload_count": 1,
            "allow_extra_images": False,
            "extra_image_limit": 0,
        })
        final = compose_final_prompt(mode, ["图1=人物原图"], "蓝色背景", "1:1", "2k")
        self.assertTrue(final.startswith("原始提示词\n第二行"))
        self.assertIn("图1=人物原图", final)
        self.assertIn("蓝色背景", final)
        self.assertIn("1:1", final)
        self.assertIn("2k", final)

    def test_final_prompt_preserves_trailing_preset_characters_and_appends_each_context_once(self):
        mode = normalize_mode({"id": "raw-tail", "display_name": "01尾随字符", "preset_prompt": "原文 \n"})
        final = compose_final_prompt(
            mode,
            ["图1=主体", "图2=环境"],
            "保留原构图",
            "16:9",
            "4k",
        )
        self.assertEqual(
            final,
            "原文 \n\n\n"
            "【参考图顺序与职责】\n图1=主体\n图2=环境\n\n"
            "【用户补充要求】\n保留原构图\n\n"
            "【输出参数】图片比例：16:9；分辨率：4k。",
        )
        self.assertEqual(final.count("【参考图顺序与职责】"), 1)
        self.assertEqual(final.count("【用户补充要求】"), 1)
        self.assertEqual(final.count("图1=主体"), 1)
        self.assertEqual(final.count("保留原构图"), 1)

    def test_public_mode_never_contains_prompt_bodies_or_version_history(self):
        mode = normalize_mode({
            "id": "builtin-free", "display_name": "01无预设 (自由生图)",
            "preset_prompt": "hidden-original", "required_reference_count": 0,
            "reference_images": [], "max_upload_count": 6,
            "allow_extra_images": True, "extra_image_limit": 6,
            "current_prompt": "hidden-current",
            "draft_prompt": "hidden-draft",
            "prompt_versions": [{"body": "hidden-history"}],
            "synonyms": ["文本生图", "创作"],
        })
        encoded = json.dumps(public_mode(mode), ensure_ascii=False)
        for secret in ("hidden-original", "hidden-current", "hidden-draft", "hidden-history"):
            self.assertNotIn(secret, encoded)
        for field in ("preset_prompt", "current_prompt", "draft_prompt", "prompt_versions"):
            self.assertNotIn(field, encoded)
        self.assertEqual(public_mode(mode)["synonyms"], ["文本生图", "创作"])

    def test_admin_mode_retains_prompt_bodies_and_version_history(self):
        mode = normalize_mode({
            "id": "admin-mode", "display_name": "02管理员模式",
            "preset_prompt": "original", "current_prompt": "current", "draft_prompt": "draft",
            "prompt_versions": [{"body": "history"}],
        })
        projected = admin_mode(mode)
        self.assertEqual(projected["preset_prompt"], "original")
        self.assertEqual(projected["current_prompt"], "current")
        self.assertEqual(projected["draft_prompt"], "draft")
        self.assertEqual(projected["prompt_versions"], [{"body": "history"}])

    def test_normalize_rejects_invalid_mode_contracts(self):
        valid = {
            "id": "mode", "display_name": "03有效模式", "preset_prompt": "ok",
            "required_reference_count": 1,
            "reference_images": [{"key": "source", "label": "源图", "required": True}],
            "max_upload_count": 1, "allow_extra_images": False, "extra_image_limit": 0,
        }
        invalid_variants = [
            {"id": ""},
            {"reference_images": [{"key": "same"}, {"key": "same"}]},
            {"max_upload_count": -1},
            {"extra_image_limit": -1},
            {"required_reference_count": 2, "max_upload_count": 1},
            {"preset_prompt": "x" * (ONLINE_IMAGE_PROMPT_MAX_LENGTH + 1)},
            {"status": "unknown"},
            {"synonyms": "文本生图"},
            {"synonyms": ["文本生图", 1]},
        ]
        for overrides in invalid_variants:
            candidate = dict(valid)
            candidate.update(overrides)
            with self.subTest(overrides=overrides):
                with self.assertRaises(ValueError):
                    normalize_mode(candidate)

    def test_normalize_requires_required_slot_count_to_match_declared_count(self):
        valid = {
            "id": "slot-contract", "display_name": "04槽位", "required_reference_count": 1,
            "reference_images": [
                {"key": "required", "label": "必填", "required": True},
                {"key": "optional", "label": "可选", "required": False},
            ],
            "max_upload_count": 2, "allow_extra_images": False, "extra_image_limit": 0,
        }
        self.assertEqual(normalize_mode(valid)["required_reference_count"], 1)
        invalid = dict(valid)
        invalid["required_reference_count"] = 2
        with self.assertRaises(ValueError):
            normalize_mode(invalid)

    def test_normalize_assigns_mode_number_from_valid_display_prefix(self):
        self.assertEqual(normalize_mode({"id": "prefixed", "display_name": "25一键证件照"})["mode_no"], 25)
        self.assertEqual(normalize_mode({"id": "unprefixed", "display_name": "自定义模式"})["mode_no"], None)

    def test_search_text_indexes_number_name_tags_and_use_keywords(self):
        mode = normalize_mode({
            "id": "sign", "display_name": "08门头招牌设计", "mode_no": 8,
            "tags": ["广告", "店铺"], "synonyms": ["门店招牌", "店招"],
            "category": "招牌与广告", "special_hint": "商铺门头",
        })
        search_text = build_mode_search_text(mode)
        for term in ("8", "08", "门头招牌设计", "广告", "店铺", "门店招牌", "店招", "招牌与广告", "商铺门头"):
            self.assertIn(term, search_text)

    def test_diff_source_modes_reports_additions_changes_and_source_removals(self):
        local = [
            normalize_mode({"id": "local-same", "source_id": "same", "display_name": "01相同", "preset_prompt": "same"}),
            normalize_mode({"id": "local-changed", "source_id": "changed", "display_name": "02本机", "preset_prompt": "local"}),
            normalize_mode({"id": "local-removed", "source_id": "removed-source", "display_name": "03已删除来源", "preset_prompt": "local"}),
            normalize_mode({"id": "local-only", "display_name": "自定义模式", "preset_prompt": "local"}),
        ]
        source = [
            normalize_mode({"id": "same", "display_name": "01相同", "preset_prompt": "same"}),
            normalize_mode({"id": "changed", "display_name": "02来源", "preset_prompt": "source"}),
            normalize_mode({"id": "new", "display_name": "04新增", "preset_prompt": "new"}),
        ]
        diff = diff_source_modes(local, source)
        self.assertEqual([item["id"] for item in diff["additions"]], ["new"])
        self.assertEqual([item["id"] for item in diff["changes"]], ["changed"])
        self.assertEqual([item["id"] for item in diff["source_removals"]], ["local-removed"])

    def test_diff_source_modes_accepts_legacy_builtin_identity_but_not_custom_identity(self):
        local = [
            normalize_mode({"id": "legacy-source", "builtin": True, "display_name": "01旧内置", "preset_prompt": "old"}),
            normalize_mode({"id": "custom", "builtin": False, "display_name": "自定义", "preset_prompt": "custom"}),
        ]
        diff = diff_source_modes(local, [])
        self.assertEqual([item["id"] for item in diff["source_removals"]], ["legacy-source"])

    def test_diff_source_modes_rejects_duplicate_ids_on_either_side(self):
        duplicate = normalize_mode({"id": "duplicate", "display_name": "01重复", "preset_prompt": "same"})
        with self.assertRaises(ValueError):
            diff_source_modes([duplicate, duplicate], [])
        with self.assertRaises(ValueError):
            diff_source_modes([], [duplicate, duplicate])

    def test_public_seed_is_empty_and_valid_for_github_distribution(self):
        seed_path = Path(ROOT) / "static" / "data" / "image-generation-presets.v1.json"
        seed = json.loads(seed_path.read_text("utf-8"))
        self.assertEqual(seed["source_url"], "")
        self.assertEqual(seed["distribution_version"], seed["source_version"])
        self.assertEqual(seed["modes"], [])

    def test_seed_file_is_not_ignored_by_git(self):
        self.assertEqual(
            self.git_ignore_returncode("static/data/image-generation-presets.v1.json"),
            1,
        )

    def test_seed_exception_does_not_unignore_other_static_data(self):
        self.assertEqual(
            self.git_ignore_returncode("static/data/unrelated-local-data.json"),
            0,
        )


if __name__ == "__main__":
    unittest.main()
