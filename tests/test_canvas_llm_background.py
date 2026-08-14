import asyncio
import json
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import main


class CanvasLLMBackgroundPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.canvas_dir_patch = patch.object(main, "CANVAS_DIR", self.temp_dir.name)
        self.canvas_dir_patch.start()
        self.addCleanup(self.canvas_dir_patch.stop)

    def write_canvas(self, nodes):
        canvas = {
            "id": "canvas_test",
            "title": "test",
            "kind": "classic",
            "nodes": nodes,
            "connections": [],
            "viewport": {"x": 0, "y": 0, "scale": 1},
            "updated_at": 1,
        }
        with open(os.path.join(self.temp_dir.name, "canvas_test.json"), "w", encoding="utf-8") as handle:
            json.dump(canvas, handle, ensure_ascii=False)

    def read_node(self, node_id):
        with open(os.path.join(self.temp_dir.name, "canvas_test.json"), "r", encoding="utf-8") as handle:
            canvas = json.load(handle)
        return next(node for node in canvas["nodes"] if node["id"] == node_id), canvas

    def attach(self, node_id, task_id, mode, message="hello"):
        return main.update_canvas_llm_task_node(
            "canvas_test",
            node_id,
            task_id,
            mode,
            "queued",
            message=message,
            provider="custom-api",
            model="gemini-test",
            runtime_id="runtime-test",
        )

    def finish(self, node_id, task_id, mode, text="RESULT"):
        return main.update_canvas_llm_task_node(
            "canvas_test",
            node_id,
            task_id,
            mode,
            "succeeded",
            result_text=text,
        )

    def test_classic_node_result_is_written_without_replacing_other_nodes(self):
        self.write_canvas([
            {"id": "llm_1", "type": "llm", "outputText": "old"},
            {"id": "keep", "type": "image", "name": "unchanged"},
        ])
        self.assertTrue(self.attach("llm_1", "task_1", "node"))
        pending, _ = self.read_node("llm_1")
        self.assertEqual(pending["llmTask"]["id"], "task_1")
        self.assertNotIn("running", pending)

        self.assertTrue(self.finish("llm_1", "task_1", "node", "NODE_RESULT"))
        completed, canvas = self.read_node("llm_1")
        self.assertEqual(completed["outputText"], "NODE_RESULT")
        self.assertNotIn("llmTask", completed)
        self.assertEqual(next(node for node in canvas["nodes"] if node["id"] == "keep")["name"], "unchanged")

    def test_chat_user_and_assistant_messages_survive_navigation_without_replacing_llm_output(self):
        self.write_canvas([{
            "id": "llm_chat",
            "type": "llm",
            "messages": [],
            "outputText": "KEPT_LLM_RESULT",
            "llmResultKey": "kept-key",
            "llmResultMemory": [{"key": "kept-key", "text": "KEPT_LLM_RESULT", "updatedAt": 1}],
        }])
        self.assertTrue(self.attach("llm_chat", "task_chat", "chat", "question"))
        pending, _ = self.read_node("llm_chat")
        self.assertEqual(pending["messages"], [{"role": "user", "content": "question"}])

        self.assertTrue(self.finish("llm_chat", "task_chat", "chat", "answer"))
        completed, _ = self.read_node("llm_chat")
        self.assertEqual(completed["messages"][-1], {"role": "assistant", "content": "answer"})
        self.assertEqual(completed["outputText"], "KEPT_LLM_RESULT")
        self.assertEqual(completed["llmResultKey"], "kept-key")
        self.assertEqual(completed["llmResultMemory"][-1]["text"], "KEPT_LLM_RESULT")

    def test_chat_user_message_saves_display_text_request_text_and_its_own_images(self):
        self.write_canvas([{
            "id": "llm_chat_images",
            "type": "llm",
            "messages": [{"role": "user", "content": "old", "images": ["/assets/old.png"]}],
        }])
        self.assertTrue(main.update_canvas_llm_task_node(
            "canvas_test",
            "llm_chat_images",
            "task_chat_images",
            "chat",
            "queued",
            message="下面是参考图编号：\n图1：正面图\n\n用户需求：\n分析 图1",
            display_message="分析 @正面图",
            message_images=["/assets/front.png"],
            runtime_id="runtime-test",
        ))
        pending, _ = self.read_node("llm_chat_images")
        current = pending["messages"][-1]
        self.assertEqual(current["content"], "分析 @正面图")
        self.assertIn("分析 图1", current["requestContent"])
        self.assertEqual(current["images"], ["/assets/front.png"])
        self.assertEqual(pending["messages"][0]["images"], ["/assets/old.png"])
        self.assertEqual(pending["chatInputMentions"], [])

    def test_history_message_builds_multimodal_content_without_breaking_legacy_text(self):
        legacy = main.canvas_llm_history_message({"role": "user", "content": "legacy"})
        self.assertEqual(legacy, {"role": "user", "content": "legacy"})

        with patch.object(main, "media_reference_to_url", side_effect=lambda value, **_kwargs: f"data:{value}"):
            multimodal = main.canvas_llm_history_message({
                "role": "user",
                "content": "显示文字",
                "requestContent": "请求文字 图1",
                "images": ["/assets/front.png"],
            })
        self.assertEqual(multimodal["role"], "user")
        self.assertEqual(multimodal["content"][0], {"type": "text", "text": "请求文字 图1"})
        self.assertEqual(multimodal["content"][1]["image_url"]["url"], "data:/assets/front.png")

    def test_smart_prompt_result_is_written_to_text(self):
        self.write_canvas([{"id": "prompt_1", "type": "smart-prompt", "text": "old"}])
        self.assertTrue(self.attach("prompt_1", "task_smart", "smart-prompt"))
        self.assertTrue(self.finish("prompt_1", "task_smart", "smart-prompt", "SMART_RESULT"))
        completed, _ = self.read_node("prompt_1")
        self.assertEqual(completed["text"], "SMART_RESULT")
        self.assertNotIn("llmTask", completed)

    def test_old_task_cannot_overwrite_a_newer_task(self):
        self.write_canvas([{"id": "llm_1", "type": "llm", "outputText": "old"}])
        self.assertTrue(self.attach("llm_1", "task_old", "node"))
        self.assertTrue(self.attach("llm_1", "task_new", "node"))
        self.assertFalse(self.finish("llm_1", "task_old", "node", "STALE"))
        current, _ = self.read_node("llm_1")
        self.assertEqual(current["outputText"], "old")
        self.assertEqual(current["llmTask"]["id"], "task_new")

    def test_failure_is_persisted_and_retryable(self):
        self.write_canvas([{"id": "prompt_1", "type": "smart-prompt", "text": "old"}])
        self.assertTrue(self.attach("prompt_1", "task_fail", "smart-prompt"))
        self.assertTrue(main.update_canvas_llm_task_node(
            "canvas_test",
            "prompt_1",
            "task_fail",
            "smart-prompt",
            "failed",
            error="upstream failed",
        ))
        failed, _ = self.read_node("prompt_1")
        self.assertEqual(failed["llmTask"]["status"], "failed")
        self.assertEqual(failed["runError"], "upstream failed")

    def test_touch_and_meta_updates_preserve_background_result(self):
        self.write_canvas([{"id": "llm_1", "type": "llm", "outputText": "old"}])
        self.assertTrue(self.attach("llm_1", "task_1", "node"))
        self.assertTrue(self.finish("llm_1", "task_1", "node", "KEPT_RESULT"))

        asyncio.run(main.touch_canvas("canvas_test"))
        asyncio.run(main.update_canvas_meta(
            "canvas_test",
            main.CanvasMetaUpdate(title="renamed"),
        ))

        completed, canvas = self.read_node("llm_1")
        self.assertEqual(completed["outputText"], "KEPT_RESULT")
        self.assertEqual(canvas["title"], "renamed")

    def test_stale_full_save_cannot_overwrite_background_completion(self):
        self.write_canvas([{"id": "llm_1", "type": "llm", "outputText": "old"}])
        pending_updated_at = self.attach("llm_1", "task_1", "node")
        pending_node, _ = self.read_node("llm_1")
        self.assertTrue(self.finish("llm_1", "task_1", "node", "NEW_RESULT"))

        payload = main.CanvasSaveRequest(
            title="test",
            nodes=[pending_node],
            connections=[],
            viewport={"x": 0, "y": 0, "scale": 1},
            base_updated_at=pending_updated_at,
        )
        with self.assertRaises(main.HTTPException) as raised:
            asyncio.run(main.update_canvas("canvas_test", payload))
        self.assertEqual(raised.exception.status_code, 409)
        completed, _ = self.read_node("llm_1")
        self.assertEqual(completed["outputText"], "NEW_RESULT")

    def test_background_runner_writes_result_and_broadcasts(self):
        self.write_canvas([{"id": "llm_1", "type": "llm", "outputText": "old"}])
        self.assertTrue(self.attach("llm_1", "task_runner", "node"))
        payload = main.CanvasLLMTaskRequest(
            canvas_id="canvas_test",
            node_id="llm_1",
            mode="node",
            message="hello",
            provider="custom-api",
            model="gemini-test",
        )
        main.CANVAS_TASKS["task_runner"] = {
            "id": "task_runner",
            "type": "canvas-llm",
            "status": "queued",
        }
        self.addCleanup(main.CANVAS_TASKS.pop, "task_runner", None)
        broadcast = AsyncMock()
        with patch.object(main, "execute_canvas_llm", AsyncMock(return_value={"text": "RUNNER_RESULT", "model": "gemini-test"})), \
             patch.object(main.manager, "broadcast_canvas_updated", broadcast):
            asyncio.run(main.run_canvas_llm_task("task_runner", payload))

        completed, _ = self.read_node("llm_1")
        self.assertEqual(completed["outputText"], "RUNNER_RESULT")
        self.assertEqual(main.CANVAS_TASKS["task_runner"]["status"], "succeeded")
        broadcast.assert_awaited_once()

    def test_keyed_results_are_remembered_and_bounded_without_affecting_chat(self):
        self.write_canvas([{"id": "llm_1", "type": "llm", "outputText": "legacy"}])
        for index in range(25):
            task_id = f"task_{index}"
            input_key = f"input_{index}"
            self.assertTrue(main.update_canvas_llm_task_node(
                "canvas_test",
                "llm_1",
                task_id,
                "node",
                "queued",
                message=f"message {index}",
                input_key=input_key,
                runtime_id="runtime-test",
            ))
            self.assertTrue(main.update_canvas_llm_task_node(
                "canvas_test",
                "llm_1",
                task_id,
                "node",
                "succeeded",
                result_text=f"RESULT_{index}",
                input_key=input_key,
            ))

        completed, _ = self.read_node("llm_1")
        memory = completed["llmResultMemory"]
        self.assertEqual(completed["llmResultKey"], "input_24")
        self.assertEqual(completed["outputText"], "RESULT_24")
        self.assertLessEqual(len(memory), main.LLM_RESULT_MEMORY_MAX_ENTRIES)
        self.assertLessEqual(sum(len(entry["text"]) for entry in memory), main.LLM_RESULT_MEMORY_MAX_CHARS)
        self.assertEqual(memory[-1]["key"], "input_24")
        self.assertNotIn("input_0", [entry["key"] for entry in memory])


if __name__ == "__main__":
    unittest.main()
