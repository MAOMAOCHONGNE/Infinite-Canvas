import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class FakeStreamResponse:
    status_code = 200
    reason = "OK"
    headers = {"Content-Length": "6"}

    def __init__(self):
        self.closed = False

    def iter_content(self, chunk_size=0):
        yield b"abc"
        yield b"def"

    def close(self):
        self.closed = True


class UpdaterProgressTests(unittest.TestCase):
    def tearDown(self):
        main._finish_update_progress("idle")

    def test_streamed_download_reports_chunks_and_closes_response(self):
        response = FakeStreamResponse()
        updates = []
        with patch.object(main.requests, "get", return_value=response):
            data = main.streamed_update_bytes(
                "https://example.invalid/file", "static/index.html",
                lambda rel, received, total: updates.append((rel, received, total)),
            )
        self.assertEqual(data, b"abcdef")
        self.assertTrue(response.closed)
        self.assertIn(("static/index.html", 3, 6), updates)
        self.assertEqual(updates[-1], ("static/index.html", 6, 6))

    def test_progress_counts_only_completed_files_and_preserves_known_total(self):
        main._begin_update_progress("github")
        main._reset_update_download_attempt("github")
        files = ["main.py", "static/index.html"]
        main.UPDATE_FILE_SIZE_HINTS.update({"main.py": 100, "static/index.html": 300})
        main._record_update_download("__list__", 0, 0, 0, len(files), files)
        main._record_update_download("main.py", 50, 100, 1, len(files))
        self.assertEqual(main.UPDATE_PROGRESS["completed_files"], 0)
        self.assertEqual(main.UPDATE_PROGRESS["downloaded_bytes"], 50)
        self.assertEqual(main.UPDATE_PROGRESS["total_bytes"], 400)
        main._record_update_download("main.py", 100, 100, 1, len(files))
        self.assertEqual(main.UPDATE_PROGRESS["completed_files"], 1)
        main._record_update_download("static/index.html", 300, 300, 2, len(files))
        self.assertEqual(main.UPDATE_PROGRESS["completed_files"], 2)
        self.assertEqual(main.UPDATE_PROGRESS["downloaded_bytes"], 400)

    def test_progress_endpoint_is_never_cached(self):
        response = main.update_progress()
        self.assertIn("no-store", response.headers.get("cache-control", ""))
        self.assertEqual(response.headers.get("pragma"), "no-cache")


if __name__ == "__main__":
    unittest.main()
