import asyncio
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import main


class PromptLibraryOrderTests(unittest.TestCase):
    def test_exact_order_is_applied_without_changing_records(self):
        records = [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}, {"id": "c", "name": "C"}]
        reordered = main.reorder_prompt_library_records(records, ["c", "a", "b"])
        self.assertEqual([item["id"] for item in reordered], ["c", "a", "b"])
        self.assertEqual(reordered[1]["name"], "A")

    def test_stale_or_partial_order_is_rejected(self):
        records = [{"id": "a"}, {"id": "b"}]
        with self.assertRaises(ValueError):
            main.reorder_prompt_library_records(records, ["a"])
        with self.assertRaises(ValueError):
            main.reorder_prompt_library_records(records, ["a", "a"])

    def test_reorder_routes_are_declared(self):
        with open(os.path.join(ROOT, "main.py"), "r", encoding="utf-8") as source_file:
            source = source_file.read()
        self.assertIn('@app.post("/api/prompt-libraries/categories/reorder")', source)
        self.assertIn('@app.post("/api/prompt-libraries/items/reorder")', source)

    def test_reorder_routes_persist_only_the_requested_library(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store_path = os.path.join(temp_dir, "prompt_libraries.json")
            seed = {
                "active_library_id": "custom_lib",
                "libraries": [{
                    "id": "custom_lib",
                    "name": "Custom",
                    "categories": [{"id": "cat_a", "name": "A"}, {"id": "cat_b", "name": "B"}],
                    "items": [
                        {"id": "item_a", "name": "A", "category": "cat_a", "positive": "A"},
                        {"id": "item_b", "name": "B", "category": "cat_b", "positive": "B"},
                    ],
                }],
            }
            with patch.object(main, "DATA_DIR", temp_dir), patch.object(main, "PROMPT_LIBRARY_PATH", store_path):
                main.save_prompt_libraries(seed)
                asyncio.run(main.reorder_prompt_library_categories(main.PromptLibraryReorderRequest(
                    library_id="custom_lib", ordered_ids=["cat_b", "cat_a"]
                )))
                asyncio.run(main.reorder_prompt_library_items(main.PromptLibraryReorderRequest(
                    library_id="custom_lib", ordered_ids=["item_b", "item_a"]
                )))
                with open(store_path, "r", encoding="utf-8") as store_file:
                    stored = json.load(store_file)
            library = next(item for item in stored["libraries"] if item["id"] == "custom_lib")
            self.assertEqual([item["id"] for item in library["categories"]], ["cat_b", "cat_a"])
            self.assertEqual([item["id"] for item in library["items"]], ["item_b", "item_a"])


if __name__ == "__main__":
    unittest.main()
