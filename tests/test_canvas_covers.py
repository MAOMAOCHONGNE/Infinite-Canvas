import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class CanvasCoverTests(unittest.TestCase):
    def test_auto_cover_prefers_newer_output_over_input(self):
        canvas = {
            "id": "cover-test",
            "nodes": [
                {"id": "input", "type": "image", "url": "/assets/input/source.png"},
                {"id": "old-output", "type": "output", "images": [{"url": "/assets/output/old.png"}]},
                {"id": "new-output", "type": "output", "images": [{"url": "/assets/output/new.png"}]},
            ],
        }
        self.assertEqual(main.resolve_canvas_cover(canvas), "/assets/output/new.png")

    def test_custom_cover_wins_and_auto_mode_restores_generated_cover(self):
        canvas = {
            "id": "cover-test",
            "cover_mode": "custom",
            "cover_url": "/assets/canvas-covers/custom.png",
            "nodes": [{"id": "result", "type": "output", "images": ["/assets/output/result.png"]}],
        }
        self.assertEqual(main.resolve_canvas_cover(canvas), "/assets/canvas-covers/custom.png")
        canvas["cover_mode"] = "auto"
        self.assertEqual(main.resolve_canvas_cover(canvas), "/assets/output/result.png")

    def test_uploaded_cover_path_rejects_escape(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(main, "CANVAS_COVER_DIR", temp_dir):
            self.assertEqual(
                main.canvas_uploaded_cover_path("/assets/canvas-covers/cover.png"),
                str(Path(temp_dir, "cover.png").resolve()),
            )
            self.assertEqual(main.canvas_uploaded_cover_path("/assets/canvas-covers/../input/private.png"), "")


if __name__ == "__main__":
    unittest.main()
