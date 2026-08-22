import datetime
import json
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from starlette.requests import Request

import main

try:
    from canvas_creative_agent import (
        deterministic_creative_reply,
        normalize_creative_plan,
        sanitize_creative_references_for_storage,
        should_include_canvas_context,
        CanvasCreativeAgentStreamRequest,
    )
except ImportError:
    deterministic_creative_reply = None
    normalize_creative_plan = None
    sanitize_creative_references_for_storage = None
    should_include_canvas_context = None
    CanvasCreativeAgentStreamRequest = None


class CanvasCreativeAgentContractTests(unittest.TestCase):
    def test_manual_image_mode_locks_action_and_candidate_pool(self):
        self.assertTrue(callable(normalize_creative_plan))
        plan = normalize_creative_plan(
            {
                "action": "generate_video",
                "optimized_prompt": "夏日饮品海报",
                "provider": "evil",
                "model": "outside-pool",
                "image_count": 99,
                "aspect_ratio": "3:4",
                "resolution": "2k",
            },
            mode="image",
            image_candidates=[{"provider": "api-a", "model": "image-a"}],
            video_candidates=[{"provider": "api-v", "model": "video-v"}],
            has_references=False,
        )
        self.assertEqual(plan["action"], "generate_image")
        self.assertEqual((plan["provider"], plan["model"]), ("api-a", "image-a"))
        self.assertEqual(plan["image_count"], 10)
        self.assertEqual(plan["aspect_ratio"], "3:4")
        self.assertEqual(plan["resolution"], "2k")

    def test_manual_modes_use_edit_and_video_actions_when_inputs_require_them(self):
        image = normalize_creative_plan(
            {"optimized_prompt": "替换背景"},
            mode="image",
            image_candidates=[{"provider": "api-a", "model": "image-a"}],
            video_candidates=[],
            has_references=True,
        )
        video = normalize_creative_plan(
            {"optimized_prompt": "让主体缓慢转身"},
            mode="video",
            image_candidates=[],
            video_candidates=[{"provider": "api-v", "model": "video-v"}],
            has_references=True,
        )
        self.assertEqual(image["action"], "edit_image")
        self.assertEqual(video["action"], "generate_video")

    def test_canvas_context_is_needed_only_for_canvas_analysis_requests(self):
        self.assertTrue(callable(should_include_canvas_context))
        self.assertTrue(should_include_canvas_context("分析当前画布的节点关系"))
        self.assertTrue(should_include_canvas_context("这个工作流哪里有问题"))
        self.assertFalse(should_include_canvas_context("生成一张电影海报"))
        self.assertFalse(should_include_canvas_context("今天星期几"))

    def test_date_question_uses_local_clock_without_a_model_call(self):
        self.assertTrue(callable(deterministic_creative_reply))
        result = deterministic_creative_reply(
            "今天星期几",
            now=datetime.datetime(2026, 8, 21, 9, 30, 0),
        )
        self.assertEqual(result["action"], "local_reply")
        self.assertIn("星期五", result["reply"])
        self.assertIsNone(deterministic_creative_reply("生成一张海报", now=datetime.datetime(2026, 8, 21)))

    def test_history_references_never_store_image_base64(self):
        self.assertTrue(callable(sanitize_creative_references_for_storage))
        stored = sanitize_creative_references_for_storage([
            {"url": "data:image/png;base64,AAAA", "name": "粘贴图片", "marker": "图片1"},
            {"url": "/assets/a.png", "name": "素材", "marker": "图片2"},
        ])
        serialized = json.dumps(stored, ensure_ascii=False)
        self.assertNotIn("AAAA", serialized)
        self.assertEqual(stored[0]["url"], "")
        self.assertTrue(stored[0]["embedded"])
        self.assertEqual(stored[1]["url"], "/assets/a.png")


class CanvasCreativeAgentRouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.conversation_patch = patch.object(main, "CONVERSATION_DIR", self.tempdir.name)
        self.conversation_patch.start()
        self.request = Request({
            "type": "http",
            "method": "POST",
            "path": "/api/chat/canvas-creative-agent/stream",
            "headers": [],
            "client": ("127.0.0.1", 12345),
        })

    def tearDown(self):
        self.conversation_patch.stop()
        self.tempdir.cleanup()

    def payload(self, **overrides):
        self.assertIsNotNone(CanvasCreativeAgentStreamRequest)
        data = {
            "canvas_id": "canvas-a",
            "mode": "agent",
            "message": "生成一张夏日饮品海报",
            "brain_provider": "api-brain",
            "brain_model": "brain-model",
            "image_candidates": [{"provider": "api-image", "model": "image-model"}],
            "video_candidates": [{"provider": "api-video", "model": "video-model"}],
            "preferences": {"image": {"aspect_ratio": "3:4", "resolution": "2k", "quality": "high", "count": 1}},
        }
        data.update(overrides)
        return CanvasCreativeAgentStreamRequest(**data)

    async def collect_events(self, response):
        chunks = []
        async for chunk in response.body_iterator:
            chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
        text = "".join(chunks)
        return [json.loads(line[6:]) for line in text.splitlines() if line.startswith("data: ")]

    async def test_creative_history_is_isolated_per_canvas_and_legacy_is_copied(self):
        self.assertTrue(callable(getattr(main, "new_canvas_creative_conversation", None)))
        created_a = main.new_canvas_creative_conversation("tester", "canvas-a", "A")
        main.new_canvas_creative_conversation("tester", "canvas-b", "B")
        legacy = main.new_canvas_agent_conversation("tester", "canvas-a", "旧分析")
        listed = main.list_canvas_creative_conversations("tester", "canvas-a")
        self.assertEqual({item["id"] for item in listed}, {created_a["id"], legacy["id"]})
        copied = main.copy_legacy_canvas_agent_conversation("tester", legacy, "canvas-a")
        self.assertEqual(copied["kind"], "canvas_creative_agent")
        self.assertNotEqual(copied["id"], legacy["id"])
        self.assertEqual(main.load_conversation("tester", legacy["id"])["kind"], "canvas_agent")

    async def test_local_date_reply_never_calls_brain_or_paid_tools(self):
        planner = AsyncMock()
        image = AsyncMock()
        video = AsyncMock()
        with patch.object(main, "plan_canvas_creative_agent", planner, create=True), \
             patch.object(main, "generate_ai_image", image), \
             patch.object(main, "canvas_video", video):
            response = await main.chat_canvas_creative_agent_stream(
                self.payload(message="今天星期几", image_candidates=[], video_candidates=[]),
                self.request,
                "tester",
            )
            events = await self.collect_events(response)
        self.assertEqual([item["type"] for item in events], ["meta", "stage", "delta", "done"])
        self.assertIn("星期", events[2]["delta"])
        planner.assert_not_awaited()
        image.assert_not_awaited()
        video.assert_not_awaited()

    async def test_canvas_analysis_never_auto_attaches_selected_images(self):
        context = {
            "schema_version": 1,
            "canvas": {"id": "canvas-a", "name": "A", "updated_at": 1},
            "selection": {"node_ids": ["img-1"], "selected_image_count": 1},
            "summary": {"node_count": 1, "connection_count": 0, "node_types": {"image": 1}, "node_names": []},
            "details": [{"id": "img-1", "type": "image", "name": "参考图"}],
            "connections": [],
            "selected_images": [{"node_id": "img-1", "url": "/assets/selected.png", "name": "selected", "width": 100, "height": 100}],
        }
        planner = AsyncMock(return_value={"action": "chat", "reply": "画布分析结果"})
        with patch.object(main, "plan_canvas_creative_agent", planner, create=True), \
             patch.object(main, "validate_creative_model_candidates", side_effect=lambda items, _kind: [item.model_dump() for item in items], create=True):
            response = await main.chat_canvas_creative_agent_stream(
                self.payload(message="分析当前画布节点", canvas_context=context), self.request, "tester"
            )
            await self.collect_events(response)
        sent_context = planner.await_args.args[3]
        self.assertNotIn("selected_images", sent_context)
        self.assertEqual(sent_context["selection"]["sent_image_count"], 0)

    async def test_image_plan_emits_one_result_without_automatic_retry(self):
        planner_result = {
            "action": "generate_image",
            "optimized_prompt": "高端夏日饮品商业海报",
            "provider": "api-image",
            "model": "image-model",
            "aspect_ratio": "3:4",
            "resolution": "2k",
            "quality": "high",
            "image_count": 1,
        }
        with patch.object(main, "plan_canvas_creative_agent", AsyncMock(return_value=planner_result), create=True), \
             patch.object(main, "validate_creative_model_candidates", side_effect=lambda items, _kind: [item.model_dump() for item in items], create=True), \
             patch.object(main, "generate_ai_image", AsyncMock(return_value=("data:image/png;base64,AAAA", {}))) as generate, \
             patch.object(main, "save_ai_image_to_output", AsyncMock(return_value="/output/poster.png")):
            response = await main.chat_canvas_creative_agent_stream(self.payload(), self.request, "tester")
            events = await self.collect_events(response)
        self.assertEqual(generate.await_count, 1)
        self.assertIn("tool_plan", [item["type"] for item in events])
        result = next(item for item in events if item["type"] == "tool_result")
        self.assertEqual(result["media"][0]["url"], "/output/poster.png")
        self.assertEqual(result["media"][0]["kind"], "image")

    async def test_image_count_preference_never_creates_more_than_one_paid_task(self):
        planner_result = {
            "action": "generate_image",
            "optimized_prompt": "四张海报方案",
            "provider": "api-image",
            "model": "image-model",
            "image_count": 4,
        }
        with patch.object(main, "plan_canvas_creative_agent", AsyncMock(return_value=planner_result), create=True), \
             patch.object(main, "validate_creative_model_candidates", side_effect=lambda items, _kind: [item.model_dump() for item in items], create=True), \
             patch.object(main, "generate_ai_image", AsyncMock(return_value=("data:image/png;base64,AAAA", {}))) as generate, \
             patch.object(main, "save_ai_image_to_output", AsyncMock(return_value="/output/poster.png")):
            response = await main.chat_canvas_creative_agent_stream(
                self.payload(preferences={"image": {"count": 4}}), self.request, "tester"
            )
            events = await self.collect_events(response)
        self.assertEqual(generate.await_count, 1)
        result = next(item for item in events if item["type"] == "tool_result")
        self.assertEqual(len(result["media"]), 1)
        self.assertEqual(result["requested_count"], 4)
        self.assertEqual(result["actual_count"], 1)

    async def test_video_plan_uses_existing_canvas_video_service_once(self):
        planner_result = {
            "action": "generate_video",
            "optimized_prompt": "商品缓慢旋转，柔和棚拍光线",
            "provider": "api-video",
            "model": "video-model",
            "aspect_ratio": "16:9",
            "resolution": "1080p",
            "duration": 5,
        }
        with patch.object(main, "plan_canvas_creative_agent", AsyncMock(return_value=planner_result), create=True), \
             patch.object(main, "validate_creative_model_candidates", side_effect=lambda items, _kind: [item.model_dump() for item in items], create=True), \
             patch.object(main, "canvas_video", AsyncMock(return_value={"videos": ["/output/demo.mp4"]})) as video:
            response = await main.chat_canvas_creative_agent_stream(
                self.payload(mode="video", message="生成商品旋转视频"),
                self.request,
                "tester",
            )
            events = await self.collect_events(response)
        self.assertEqual(video.await_count, 1)
        result = next(item for item in events if item["type"] == "tool_result")
        self.assertEqual(result["media"], [{"url": "/output/demo.mp4", "kind": "video", "name": "生成视频"}])


if __name__ == "__main__":
    unittest.main()
