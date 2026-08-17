import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class FakeStreamResponse:
    status_code = 200
    reason = "OK"
    headers = {"Content-Length": "9"}

    def __init__(self):
        self.closed = False

    def iter_content(self, chunk_size=0):
        yield b"abc"
        yield b"def"
        yield b"ghi"

    def close(self):
        self.closed = True


class UpdaterCancellationTests(unittest.TestCase):
    def tearDown(self):
        main._finish_update_progress("idle")

    def cancel(self, operation_id):
        return main.cancel_update(main.UpdateCancelRequest(operation_id=operation_id))

    def test_safe_phase_cancel_is_operation_scoped(self):
        main._begin_update_progress("github")
        operation_id = main.UPDATE_PROGRESS["operation_id"]

        result = self.cancel(operation_id)

        self.assertEqual(result["status"], "cancelling")
        self.assertTrue(main.UPDATE_PROGRESS["cancel_requested"])
        self.assertEqual(main.UPDATE_PROGRESS["phase"], "cancelling")
        with self.assertRaises(main.UpdateCancelled):
            main._raise_if_update_cancelled()

        main._begin_update_progress("modelscope")
        with self.assertRaises(main.HTTPException) as caught:
            self.cancel(operation_id)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertFalse(main.UPDATE_PROGRESS["cancel_requested"])

    def test_replacing_phase_rejects_cancel(self):
        main._begin_update_progress("github")
        operation_id = main.UPDATE_PROGRESS["operation_id"]
        main._set_update_progress(phase="replacing", cancellable=False)

        with self.assertRaises(main.HTTPException) as caught:
            self.cancel(operation_id)

        self.assertEqual(caught.exception.status_code, 409)
        self.assertFalse(main.UPDATE_PROGRESS["cancel_requested"])

    def test_streamed_download_stops_after_cancel_and_closes_response(self):
        main._begin_update_progress("github")
        operation_id = main.UPDATE_PROGRESS["operation_id"]
        response = FakeStreamResponse()
        updates = []

        def progress(rel, received, total):
            updates.append((rel, received, total))
            if received == 3:
                self.cancel(operation_id)

        with patch.object(main.requests, "get", return_value=response):
            with self.assertRaises(main.UpdateCancelled):
                main.streamed_update_bytes(
                    "https://example.invalid/file",
                    "static/index.html",
                    progress,
                )

        self.assertTrue(response.closed)
        self.assertEqual(updates, [("static/index.html", 3, 9)])

    def test_cancelled_source_does_not_fallback(self):
        calls = []

        def cancel_during_stage(source, staging_root, progress=None):
            calls.append(source)
            Path(staging_root).mkdir(parents=True, exist_ok=True)
            operation_id = main.UPDATE_PROGRESS["operation_id"]
            self.cancel(operation_id)
            main._raise_if_update_cancelled()

        with tempfile.TemporaryDirectory() as root, patch.object(
            main, "DATA_DIR", root
        ), patch.object(
            main, "stage_update_from_source", side_effect=cancel_during_stage
        ), patch.object(
            main, "create_update_backup"
        ) as create_backup:
            response = main.update_from_github(
                main.UpdateRequest(source="github", fallback=True, auto_restart=False)
            )

        self.assertEqual(response.status_code, 409)
        payload = json.loads(response.body.decode("utf-8"))
        self.assertTrue(payload["cancelled"])
        self.assertEqual(calls, ["github"])
        create_backup.assert_not_called()
        self.assertEqual(main.UPDATE_PROGRESS["phase"], "cancelled")

    def test_cancel_after_backup_removes_unused_restore_point(self):
        with tempfile.TemporaryDirectory() as root:
            data_dir = Path(root) / "data"

            def fake_stage(source, staging_root, progress=None):
                staging = Path(staging_root)
                (staging / "static").mkdir(parents=True, exist_ok=True)
                (staging / "main.py").write_text("value = 1\n", encoding="utf-8")
                (staging / "VERSION").write_text("2099.01.01-custom.1\n", encoding="utf-8")
                (staging / "static" / "index.html").write_text("ok", encoding="utf-8")
                return ["VERSION", "main.py"], ["static/index.html"], ["VERSION", "main.py", "static/index.html"]

            def fake_backup(path, *args, **kwargs):
                Path(path).mkdir(parents=True, exist_ok=True)
                (Path(path) / "manifest.json").write_text("{}", encoding="utf-8")
                self.cancel(main.UPDATE_PROGRESS["operation_id"])
                return {"state": "ready"}

            with patch.object(main, "DATA_DIR", str(data_dir)), patch.object(
                main, "stage_update_from_source", side_effect=fake_stage
            ), patch.object(
                main, "validate_staged_update"
            ), patch.object(
                main, "create_update_backup", side_effect=fake_backup
            ), patch.object(
                main, "safe_static_dir"
            ) as safe_static:
                response = main.update_from_github(
                    main.UpdateRequest(source="github", fallback=False, auto_restart=False)
                )

            self.assertEqual(response.status_code, 409)
            self.assertFalse(any((data_dir / "update_backups").glob("*")))
            safe_static.assert_not_called()


if __name__ == "__main__":
    unittest.main()
