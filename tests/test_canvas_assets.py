import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import main


class CanvasAssetIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.data = self.root / "data"
        self.canvas_dir = self.data / "canvases"
        self.assets = self.root / "assets"
        self.generated = self.assets / "output"
        self.canvas_dir.mkdir(parents=True)
        self.generated.mkdir(parents=True)
        self.history = self.root / "history.json"
        self.history.write_text("[]", encoding="utf-8")
        self.media_store = main.ImageGenerationMediaStore(self.root)
        self.stack = ExitStack()
        for name, value in (
            ("DATA_DIR", str(self.data)),
            ("CANVAS_DIR", str(self.canvas_dir)),
            ("ASSETS_DIR", str(self.assets)),
            ("OUTPUT_INPUT_DIR", str(self.assets / "input")),
            ("OUTPUT_OUTPUT_DIR", str(self.generated)),
            ("OUTPUT_DIR", str(self.root / "output")),
            ("HISTORY_FILE", str(self.history)),
            ("GLOBAL_CONFIG_FILE", str(self.root / "global_config.json")),
            ("MAIN_IMAGE_TASK_DIR", str(self.data / "main-image-tasks")),
            ("DETAIL_PAGE_TASK_DIR", str(self.data / "detail-page-tasks")),
            ("CANVAS_TASKS", {}),
            ("IMAGE_GENERATION_RUNTIME_TASKS", {}),
            ("ONLINE_RUNNINGHUB_OPERATIONS", {}),
            ("QUEUE", []),
            ("ONE_CLICK_CLEANUP_JOB_DIR", str(self.data / "cleanup-jobs")),
            ("ONE_CLICK_CLEANUP_JOBS", {}),
            ("IMAGE_GENERATION_MEDIA_STORE", self.media_store),
        ):
            self.stack.enter_context(patch.object(main, name, value))
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        self.stack.close()
        self.temp_dir.cleanup()

    def write_asset(self, name):
        path = self.generated / name
        path.write_bytes(b"asset")
        return f"/assets/output/{name}"

    def write_canvas(self, payload):
        (self.canvas_dir / f"{payload['id']}.json").write_text(
            json.dumps(payload), encoding="utf-8"
        )

    def test_reports_explicit_canvas_orphans_and_excludes_current_and_shared_assets(self):
        current = self.write_asset("current.png")
        log_only = self.write_asset("log-only.png")
        history_only = self.write_asset("history-only.png")
        task_only = self.write_asset("task-only.png")
        shared = self.write_asset("shared.png")
        missing = "/assets/output/missing.png"
        self.write_canvas(
            {
                "id": "canvas-1",
                "title": "测试画布",
                "kind": "smart",
                "nodes": [{"id": "node-1", "type": "image", "asset": {"url": current}}],
                "logs": [{"url": log_only}, {"url": shared}],
            }
        )
        self.history.write_text(
            json.dumps(
                [
                    {"source_type": "canvas-online-image", "images": [{"url": history_only}]},
                    {"canvas_task_id": "task-1", "images": [{"url": task_only}]},
                    {"source_type": "canvas-online-image", "images": [{"url": missing}]},
                ]
            ),
            encoding="utf-8",
        )
        (self.data / "detail-page-record.json").write_text(
            json.dumps({"source": {"url": shared}}), encoding="utf-8"
        )

        result = main.canvas_assets_index()

        self.assertEqual(result["categories"][-1], {
            "id": "orphan",
            "name": "孤立素材",
            "count": 3,
            "canvas_count": 0,
        })
        orphan_urls = {item["url"] for item in result["orphan_items"]}
        self.assertEqual(orphan_urls, {log_only, history_only, task_only})
        self.assertNotIn(current, orphan_urls)
        self.assertNotIn(shared, orphan_urls)
        self.assertNotIn(missing, orphan_urls)

    def test_deduplicates_canvas_history_and_log_sources(self):
        duplicate = self.write_asset("duplicate.png")
        self.write_canvas(
            {
                "id": "canvas-1",
                "title": "测试画布",
                "nodes": [],
                "logs": [{"url": duplicate}, {"url": duplicate}],
            }
        )
        self.history.write_text(
            json.dumps([
                {"source_type": "canvas-online-image", "url": duplicate},
                {"source_type": "canvas-online-image", "url": duplicate},
            ]),
            encoding="utf-8",
        )

        result = main.canvas_assets_index()

        self.assertEqual(
            [item["url"] for item in result["orphan_items"]],
            [duplicate],
        )

    def test_canvas_log_output_is_not_blocked_by_duplicate_legacy_history(self):
        canvas_output = self.write_asset("canvas-output.png")
        canvas_ref_path = self.assets / "input" / "canvas-reference.png"
        canvas_ref_path.parent.mkdir(parents=True, exist_ok=True)
        canvas_ref_path.write_bytes(b"reference")
        canvas_reference = "/assets/input/canvas-reference.png"
        self.write_canvas(
            {
                "id": "canvas-legacy",
                "title": "旧版画布",
                "kind": "classic",
                "nodes": [],
                "logs": [{"outputs": [canvas_output], "refs": [{"url": canvas_reference}]}],
            }
        )
        self.history.write_text(
            json.dumps(
                [
                    {
                        "type": "online",
                        "images": [canvas_output],
                        "image_items": [{"url": canvas_output}],
                        "params": {"reference_images": [{"url": canvas_reference}]},
                    }
                ]
            ),
            encoding="utf-8",
        )

        result = main.canvas_assets_index()

        orphan_urls = {item["url"] for item in result["orphan_items"]}
        self.assertIn(canvas_output, orphan_urls)
        self.assertNotIn(canvas_reference, orphan_urls)

    def test_canvas_log_output_still_stays_shared_when_another_record_references_it(self):
        canvas_output = self.write_asset("canvas-shared-output.png")
        self.write_canvas(
            {
                "id": "canvas-shared",
                "title": "共享画布",
                "kind": "classic",
                "nodes": [],
                "logs": [{"outputs": [canvas_output]}],
            }
        )
        self.history.write_text(
            json.dumps(
                [
                    {
                        "type": "online",
                        "images": [canvas_output],
                        "image_items": [{"url": canvas_output}],
                    }
                ]
            ),
            encoding="utf-8",
        )
        (self.data / "detail-page-record.json").write_text(
            json.dumps({"output_url": canvas_output}), encoding="utf-8"
        )

        result = main.canvas_assets_index()

        orphan_urls = {item["url"] for item in result["orphan_items"]}
        self.assertNotIn(canvas_output, orphan_urls)

    def test_batch_delete_moves_only_current_orphans_to_windows_recycle_bin(self):
        current = self.write_asset("current.png")
        orphan = self.write_asset("delete-me.png")
        self.write_canvas(
            {
                "id": "canvas-1",
                "title": "测试画布",
                "kind": "classic",
                "nodes": [{"id": "node-1", "type": "image", "url": current}],
                "logs": [{"id": "log-1", "url": orphan}],
            }
        )

        with patch("storage_cleanup.move_paths_to_recycle_bin") as move_to_recycle_bin:
            response = self.client.post(
                "/api/canvas-assets/orphans/delete",
                json={"urls": [orphan, current, "/assets/output/missing.png"]},
            )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["deleted"], [orphan])
        self.assertEqual(
            body["skipped"],
            [current, "/assets/output/missing.png"],
        )
        move_to_recycle_bin.assert_called_once_with([self.generated / "delete-me.png"])
        self.assertIsNone(main._CANVAS_ASSET_INDEX_CACHE["value"])

    def test_batch_delete_rechecks_orphan_ownership_before_moving(self):
        orphan = self.write_asset("delete-me.png")
        self.write_canvas(
            {
                "id": "canvas-1",
                "title": "测试画布",
                "kind": "classic",
                "nodes": [],
                "logs": [{"id": "log-1", "url": orphan}],
            }
        )

        with patch("storage_cleanup.move_paths_to_recycle_bin") as move_to_recycle_bin:
            with patch.object(
                main,
                "canvas_assets_index_cached",
                return_value={"categories": [], "canvases": [], "items": [], "orphan_items": []},
            ):
                response = self.client.post(
                    "/api/canvas-assets/orphans/delete",
                    json={"urls": [orphan]},
                )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["deleted"], [])
        self.assertEqual(response.json()["skipped"], [orphan])
        move_to_recycle_bin.assert_not_called()

    def test_canvas_asset_index_cache_reuses_unchanged_reference_inputs(self):
        cached = {"categories": [], "canvases": [], "items": [], "orphan_items": []}
        main._CANVAS_ASSET_INDEX_CACHE = {"signature": None, "value": None}
        with patch.object(main, "_canvas_assets_index_signature", return_value=("same",)), patch.object(
            main, "canvas_assets_index", return_value=cached
        ) as scan:
            first = main.canvas_assets_index_cached()
            second = main.canvas_assets_index_cached()

        self.assertEqual(first, cached)
        self.assertEqual(second, cached)
        scan.assert_called_once_with()

    def test_terminal_runtime_records_do_not_disable_the_canvas_asset_cache(self):
        with patch.object(main, "CANVAS_TASKS", {"done": {"status": "succeeded"}}):
            self.assertFalse(main._canvas_asset_dynamic_sources_active())
        with patch.object(main, "CANVAS_TASKS", {"active": {"status": "running"}}):
            self.assertTrue(main._canvas_asset_dynamic_sources_active())


if __name__ == "__main__":
    unittest.main()
