import copy
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from PIL import Image
from fastapi.testclient import TestClient

from image_generation_examples import EXAMPLE_MAX_PIXELS, ImageGenerationExampleOptimizer, optimize_image_bytes
from image_generation_media import ImageGenerationMediaStore
from tests.image_generation_test_seed import ensure_seed
import main

_EXPORT_SPEC = importlib.util.spec_from_file_location(
    "export_image_generation_presets", Path(__file__).parents[1] / "tools" / "export-image-generation-presets.py"
)
_EXPORT_MODULE = importlib.util.module_from_spec(_EXPORT_SPEC)
assert _EXPORT_SPEC.loader is not None
_EXPORT_SPEC.loader.exec_module(_EXPORT_MODULE)
export_presets = _EXPORT_MODULE.export_presets


def image_bytes(format_name="PNG", size=(12, 9), color=(10, 50, 90)):
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format_name)
    return buffer.getvalue()


def exif_oriented_jpeg_bytes(size=(2000, 3000)):
    buffer = io.BytesIO()
    image = Image.new("RGB", size, (10, 50, 90))
    exif = image.getexif()
    exif[274] = 6  # camera orientation: rotate 90° clockwise for display
    image.save(buffer, "JPEG", exif=exif)
    return buffer.getvalue()


class FakeModeStore:
    def __init__(self, modes):
        self.modes = {item["id"]: copy.deepcopy(item) for item in modes}

    def list_modes(self, *, include_admin=False):
        return [copy.deepcopy(item) for item in self.modes.values()]

    def get_mode(self, mode_id, *, include_admin=False):
        value = self.modes.get(mode_id)
        return copy.deepcopy(value) if value is not None else None

    def save_example(self, mode_id, example):
        self.modes[mode_id]["example"] = copy.deepcopy(example)
        return copy.deepcopy(example)


def mode_with_example(mode_id, example):
    return {
        "id": mode_id,
        "mode_no": 1,
        "display_name": mode_id,
        "preset_prompt": "",
        "required_reference_count": 0,
        "reference_images": [],
        "max_upload_count": 6,
        "allow_extra_images": False,
        "extra_image_limit": 0,
        "status": "active",
        "example": example,
    }


class ImageGenerationExampleOptimizerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.media = ImageGenerationMediaStore(self.root)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_area_threshold_and_proportional_resize(self):
        exact = optimize_image_bytes(image_bytes(size=(1024, 1024)))
        self.assertFalse(exact["resized"])
        self.assertEqual((exact["width"], exact["height"]), (1024, 1024))

        wide = optimize_image_bytes(image_bytes(size=(3000, 2000)))
        self.assertTrue(wide["resized"])
        self.assertLessEqual(wide["width"] * wide["height"], EXAMPLE_MAX_PIXELS)
        self.assertAlmostEqual(wide["width"] / wide["height"], 1.5, places=2)

    def test_resize_uses_display_orientation_from_exif(self):
        oriented = optimize_image_bytes(exif_oriented_jpeg_bytes())

        self.assertTrue(oriented["resized"])
        self.assertLessEqual(oriented["width"] * oriented["height"], EXAMPLE_MAX_PIXELS)
        # The source is displayed as landscape after EXIF orientation; the
        # optimized copy must keep that direction instead of becoming portrait.
        self.assertGreater(oriented["width"], oriented["height"])

    def test_materialize_keeps_original_cas_and_writes_static_case_copy(self):
        source = self.media.adopt_bytes(image_bytes(size=(2048, 2048)), "source.png", "image/png")
        original_path = Path(source["path"])
        original_bytes = original_path.read_bytes()
        optimizer = ImageGenerationExampleOptimizer(self.root, FakeModeStore([]), self.media)

        record, created = optimizer.materialize_media("official-mode", source)

        self.assertTrue(created)
        case_path = self.root / "static" / "image-generation-examples" / "official-mode" / Path(record["url"]).name
        self.assertTrue(case_path.is_file())
        with Image.open(case_path) as image:
            self.assertLessEqual(image.width * image.height, EXAMPLE_MAX_PIXELS)
        self.assertEqual(original_path.read_bytes(), original_bytes)
        self.assertTrue(record["url"].startswith("/static/image-generation-examples/"))

    def test_migration_updates_cas_example_and_deduplicates_shared_media(self):
        source = self.media.adopt_bytes(image_bytes(size=(1800, 1200)), "source.png", "image/png")
        example = {
            "id": "case-1",
            "input_media": [],
            "output_media": source,
        }
        modes = [mode_with_example("mode-a", example), mode_with_example("mode-b", example)]
        store = FakeModeStore(modes)
        optimizer = ImageGenerationExampleOptimizer(self.root, store, self.media)

        result = optimizer.migrate_all()

        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["resized"], 2)
        first_url = store.modes["mode-a"]["example"]["output_media"]["url"]
        second_url = store.modes["mode-b"]["example"]["output_media"]["url"]
        self.assertEqual(first_url, second_url)
        self.assertNotIn("/assets/image-generation/media/", first_url)
        self.assertEqual(len(list((self.root / "static" / "image-generation-examples").rglob("*.png"))), 1)
        self.assertTrue((self.root / "data" / "image_generation_example_resize.json").is_file())

    def test_invalid_case_fails_closed_without_replacing_reference(self):
        mode = mode_with_example("broken", {
            "id": "case-broken",
            "input_media": [],
            "output_media": {"url": "/assets/image-generation/media/" + "a" * 64 + ".png", "id": "a" * 64},
        })
        store = FakeModeStore([mode])
        optimizer = ImageGenerationExampleOptimizer(self.root, store, self.media)

        result = optimizer.migrate_all()

        self.assertEqual(result["status"], "failed")
        self.assertEqual(store.modes["broken"]["example"], mode["example"])
        self.assertEqual(result["failed"][0]["mode_id"], "broken")


class OfficialPresetExportTests(unittest.TestCase):
    def test_export_includes_non_builtin_official_records_and_optimizes_case(self):
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            mode_dir = root / "data" / "image_generation_modes"
            static_root = root / "static" / "image-generation-examples"
            mode_dir.mkdir(parents=True)
            static_root.mkdir(parents=True)
            content = image_bytes(size=(1800, 1200))
            digest = hashlib.sha256(content).hexdigest()
            source = static_root / "new-official" / f"{digest}.png"
            source.parent.mkdir(parents=True)
            source.write_bytes(content)
            mode = mode_with_example("new-official", {
                "id": "example-new",
                "input_media": [],
                "output_media": {"url": f"/static/image-generation-examples/new-official/{digest}.png"},
            })
            mode.update({"builtin": False, "source_id": "", "description": "", "category": "", "sort_order": 66})
            (mode_dir / "mode.json").write_text(json.dumps(mode, ensure_ascii=False), encoding="utf-8")
            output = root / "static" / "data" / "image-generation-presets.v1.json"

            result = export_presets(root, output, "test-version")
            payload = json.loads(output.read_text(encoding="utf-8"))

            self.assertEqual(result["mode_count"], 1)
            self.assertEqual(payload["modes"][0]["id"], "new-official")
            exported_url = payload["modes"][0]["example"]["output_media"]["url"]
            exported = root / "static" / exported_url.removeprefix("/static/")
            with Image.open(exported) as image:
                self.assertLessEqual(image.width * image.height, EXAMPLE_MAX_PIXELS)


class ImageGenerationExampleApiTests(unittest.TestCase):
    def test_setting_a_successful_candidate_materializes_an_optimized_case(self):
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            from image_generation_store import ImageGenerationStore

            store = ImageGenerationStore(
                root / "data",
                ensure_seed(Path(__file__).parents[1] / "tests" / "fixtures" / "image-generation-presets-test.json"),
            )
            store.initialize()
            media = ImageGenerationMediaStore(root)
            mode_id = store.list_modes()[0]["id"]
            output = media.adopt_bytes(image_bytes(size=(1800, 1200)), "output.png", "image/png")
            store.save_task({
                "id": "task-example",
                "type": "image-generation",
                "mode_id": mode_id,
                "status": "succeeded",
                "inputs": [],
                "candidates": [{"id": "candidate-example", "status": "succeeded", "image": output}],
                "generation_settings": {},
                "user_prompt": "示范",
            })
            old_store = main.IMAGE_GENERATION_STORE
            old_media = main.IMAGE_GENERATION_MEDIA_STORE
            main.IMAGE_GENERATION_STORE = store
            main.IMAGE_GENERATION_MEDIA_STORE = media
            main.IMAGE_GENERATION_ADMIN_TOKENS.clear()
            try:
                with TestClient(main.app) as client:
                    token = client.post("/api/image-generation/admin/unlock", json={"password": "451462"}).json()["token"]
                    response = client.post(
                        f"/api/image-generation/modes/{mode_id}/example",
                        headers={"X-Image-Generation-Admin": token},
                        json={"task_id": "task-example", "candidate_id": "candidate-example"},
                    )
                    self.assertEqual(response.status_code, 200, response.text)
            finally:
                main.IMAGE_GENERATION_STORE = old_store
                main.IMAGE_GENERATION_MEDIA_STORE = old_media
                main.IMAGE_GENERATION_ADMIN_TOKENS.clear()
            saved = store.get_mode(mode_id, include_admin=True)["example"]
            url = saved["output_media"]["url"]
            self.assertTrue(url.startswith("/static/image-generation-examples/"))
            case_path = root / "static" / url.removeprefix("/static/")
            with Image.open(case_path) as image:
                self.assertLessEqual(image.width * image.height, EXAMPLE_MAX_PIXELS)


if __name__ == "__main__":
    unittest.main()
