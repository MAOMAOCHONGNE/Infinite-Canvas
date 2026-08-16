import base64
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class AdaptiveImageStretchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name) / "output"
        self.output.mkdir(parents=True)
        self.source = self.output / "source.png"
        Image.new("RGB", (310, 400), (20, 80, 140)).save(self.source, "PNG")
        self.patches = [
            patch.object(main, "OUTPUT_OUTPUT_DIR", str(self.output)),
            patch.object(main, "OUTPUT_DIR", str(self.output)),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def test_requested_example_dimensions(self):
        self.assertEqual(main.stretch_dimensions_to_aspect(310, 400, "3:4"), (300, 400))

    def test_requested_ratio_allowlist_is_exact(self):
        self.assertEqual(main.ADAPTIVE_STRETCH_RATIOS, {
            "1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1",
            "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9",
        })

    def test_extreme_landscape_ratio_is_temporarily_stretched(self):
        result = main.stretched_reference_image({
            "url": "/output/source.png",
            "stretch_aspect_ratio": "4:1",
        })
        self.assertIsNotNone(result)
        with Image.open(BytesIO(result["bytes"])) as adapted:
            self.assertEqual(adapted.size, (1600, 400))

    def test_in_memory_stretch_does_not_modify_source_file(self):
        result = main.stretched_reference_image({
            "url": "/output/source.png",
            "stretch_aspect_ratio": "3:4",
        })
        self.assertIsNotNone(result)
        with Image.open(BytesIO(result["bytes"])) as adapted:
            self.assertEqual(adapted.size, (300, 400))
        with Image.open(self.source) as original:
            self.assertEqual(original.size, (310, 400))

    def test_data_url_path_uses_same_temporary_stretch(self):
        value = main.reference_to_data_url({
            "url": "/output/source.png",
            "stretch_aspect_ratio": "3:4",
        }, max_size=1536)
        header, encoded = value.split(",", 1)
        self.assertTrue(header.startswith("data:image/"))
        with Image.open(BytesIO(base64.b64decode(encoded))) as adapted:
            self.assertEqual(adapted.size, (300, 400))

    def test_unapproved_ratio_is_not_applied(self):
        self.assertIsNone(main.stretched_reference_image({
            "url": "/output/source.png",
            "stretch_aspect_ratio": "31:40",
        }))
        self.assertIsNone(main.stretched_reference_image({
            "url": "/output/source.png",
            "stretch_aspect_ratio": "9:21",
        }))


if __name__ == "__main__":
    unittest.main()
