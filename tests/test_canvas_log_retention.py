import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class CanvasLogRetentionTests(unittest.IsolatedAsyncioTestCase):
    async def test_backend_keeps_newest_500_logs_in_newest_first_order(self):
        logs = [
            {
                "id": f"log-{index}",
                "status": "failed" if index % 2 == 0 else "success",
            }
            for index in range(501, 0, -1)
        ]
        payload = main.CanvasSaveRequest(
            title="Retention",
            nodes=[],
            connections=[],
            viewport={"x": 0, "y": 0, "scale": 1},
            logs=logs,
        )

        def fake_mutate(canvas_id, mutator):
            canvas = {
                "id": canvas_id,
                "title": "Retention",
                "kind": "classic",
                "updated_at": 10,
                "viewport": {"x": 0, "y": 0, "scale": 1},
            }
            mutator(canvas)
            canvas["updated_at"] = 11
            return canvas

        broadcast = AsyncMock()
        with patch.object(main, "mutate_canvas_latest", side_effect=fake_mutate), patch.object(
            main.manager, "broadcast_canvas_updated", new=broadcast
        ):
            result = await main.update_canvas("retention-canvas", payload)

        kept = result["canvas"]["logs"]
        self.assertEqual(len(kept), 500)
        self.assertEqual(kept[0]["id"], "log-501")
        self.assertEqual(kept[-1]["id"], "log-2")
        self.assertNotIn("log-1", {entry["id"] for entry in kept})
        self.assertEqual({entry["status"] for entry in kept}, {"success", "failed"})
        broadcast.assert_awaited_once_with("retention-canvas", 11, "")


if __name__ == "__main__":
    unittest.main()
