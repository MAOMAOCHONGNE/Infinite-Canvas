import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class FakeResponse:
    def __init__(self, payload):
        self.content = json.dumps(payload).encode("utf-8")


class ModelScopeUpdaterTests(unittest.TestCase):
    def test_tree_parser_keeps_only_allowed_blobs(self):
        payload = {
            "Data": {
                "Files": [
                    {"Type": "blob", "Path": "main.py"},
                    {"Type": "blob", "Path": "VERSION"},
                    {"Type": "blob", "Path": "static/index.html"},
                    {"Type": "blob", "Path": "static\\js\\canvas.js"},
                    {"Type": "blob", "Path": "API/.env"},
                    {"Type": "blob", "Path": "data/canvas.json"},
                    {"Type": "blob", "Path": "assets/private.png"},
                    {"Type": "blob", "Path": "output/generated.png"},
                    {"Type": "blob", "Path": "static/../../API/.env"},
                    {"Type": "tree", "Path": "static"},
                    "not-a-file-entry",
                ]
            }
        }
        with patch.object(main, "github_get", return_value=FakeResponse(payload)):
            files = main.modelscope_update_file_list()
        self.assertEqual(files, ["VERSION", "main.py", "static/index.html", "static/js/canvas.js"])

    def test_download_stages_required_allowed_files(self):
        files = ["VERSION", "main.py", "static/index.html"]
        content = {path: f"content:{path}".encode("utf-8") for path in files}
        with tempfile.TemporaryDirectory() as staging, patch.object(
            main, "modelscope_update_file_list", return_value=files
        ), patch.object(main, "modelscope_file_bytes", side_effect=lambda path: content[path]):
            result = main.download_modelscope_update_files(staging)
            self.assertEqual(result, files)
            for rel in files:
                self.assertEqual((Path(staging) / Path(rel)).read_bytes(), content[rel])

    def test_download_rechecks_each_path_before_requesting_bytes(self):
        requested = []

        def fake_bytes(path):
            requested.append(path)
            return b"ok"

        files = ["VERSION", "main.py", "static/index.html", "API/.env"]
        with tempfile.TemporaryDirectory() as staging, patch.object(
            main, "modelscope_update_file_list", return_value=files
        ), patch.object(main, "modelscope_file_bytes", side_effect=fake_bytes):
            with self.assertRaisesRegex(ValueError, "允许范围"):
                main.download_modelscope_update_files(staging)
            self.assertNotIn("API/.env", requested)
            self.assertFalse((Path(staging) / "API" / ".env").exists())


if __name__ == "__main__":
    unittest.main()
