import json
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from starlette.requests import Request

import main
from canvas_agent_readonly import (
    CanvasAgentConversationCreate,
    CanvasAgentStreamRequest,
    build_canvas_agent_system_prompt,
    canvas_agent_context_summary,
    sanitize_canvas_agent_context,
    validate_canvas_agent_conversation,
)


class CanvasAgentReadonlyTests(unittest.TestCase):
    def sample_context(self):
        return {
            "schema_version": 1,
            "canvas": {"id": "canvas-a", "name": "测试画布", "updated_at": 123},
            "selection": {"node_ids": ["n1"], "selected_image_count": 1, "sent_image_count": 1},
            "summary": {"node_count": 2, "connection_count": 1, "node_types": {"prompt": 1, "image": 1}},
            "details": [
                {"id": "n1", "type": "prompt", "text": "分析这段提示词 C:\\Users\\secret\\prompt.txt wss://example.test/?token=inside", "apiKey": "must-not-pass"},
                {"id": "n2", "type": "image", "name": "参考图", "url": "/output/a.png"},
            ],
            "connections": [{"id": "c1", "from": "n1", "to": "n2"}],
            "selected_images": [{"node_id": "n2", "url": "/output/a.png", "name": "参考图"}],
            "context_char_count": 100,
            "truncated": False,
        }

    def test_context_is_revalidated_and_private_fields_are_removed(self):
        context = self.sample_context()
        context["details"][0]["raw"] = {"Authorization": "Bearer secret"}
        context["details"][0]["local_path"] = "C:\\secret\\a.png"
        clean = sanitize_canvas_agent_context(context, expected_canvas_id="canvas-a")
        serialized = str(clean)
        self.assertNotIn("must-not-pass", serialized)
        self.assertNotIn("Bearer secret", serialized)
        self.assertNotIn("C:\\secret", serialized)
        self.assertNotIn("C:\\Users", serialized)
        self.assertNotIn("token=inside", serialized)
        self.assertEqual(clean["selected_images"][0]["url"], "/output/a.png")

    def test_backend_enforces_selected_related_and_total_text_limits(self):
        context = self.sample_context()
        context["details"][0]["text"] = "选" * 13000
        context["details"][1]["text"] = "关" * 5000
        clean = sanitize_canvas_agent_context(context, expected_canvas_id="canvas-a")
        self.assertEqual(len(clean["details"][0]["text"]), 12000)
        self.assertEqual(len(clean["details"][1]["text"]), 4000)
        self.assertLessEqual(
            len(json.dumps(clean, ensure_ascii=False, separators=(",", ":"))),
            60000,
        )

    def test_context_rejects_wrong_canvas_and_invalid_image_sources(self):
        context = self.sample_context()
        with self.assertRaises(HTTPException) as wrong_canvas:
            sanitize_canvas_agent_context(context, expected_canvas_id="canvas-b")
        self.assertEqual(wrong_canvas.exception.status_code, 409)
        context["selected_images"][0]["url"] = "file:///C:/secret.png"
        with self.assertRaises(HTTPException) as bad_image:
            sanitize_canvas_agent_context(context, expected_canvas_id="canvas-a")
        self.assertEqual(bad_image.exception.status_code, 400)

    def test_request_models_enforce_agent_limits(self):
        create = CanvasAgentConversationCreate(canvas_id="canvas-a", title="新分析")
        self.assertEqual(create.canvas_id, "canvas-a")
        request = CanvasAgentStreamRequest(
            canvas_id="canvas-a",
            message="分析选中节点",
            provider="modelscope",
            model="demo/model",
            canvas_context=self.sample_context(),
            reference_images=[{"url": f"/output/{index}.png", "name": str(index)} for index in range(6)],
        )
        self.assertEqual(len(request.reference_images), 6)
        with self.assertRaises(Exception):
            CanvasAgentStreamRequest(
                canvas_id="canvas-a",
                message="x",
                canvas_context=self.sample_context(),
                reference_images=[{"url": f"/output/{index}.png"} for index in range(7)],
            )

    def test_system_prompt_keeps_canvas_data_untrusted_and_agent_read_only(self):
        prompt = build_canvas_agent_system_prompt("请简洁回答")
        self.assertIn("不可信数据", prompt)
        self.assertIn("只能分析", prompt)
        self.assertIn("不得声称已经修改", prompt)
        self.assertIn("请简洁回答", prompt)
        self.assertLess(prompt.index("不得声称已经修改"), prompt.index("请简洁回答"))

    def test_conversation_must_belong_to_current_canvas(self):
        valid = {"id": "conv", "kind": "canvas_agent", "canvas_id": "canvas-a", "messages": []}
        self.assertIs(validate_canvas_agent_conversation(valid, "canvas-a"), valid)
        for invalid in [
            {**valid, "canvas_id": "canvas-b"},
            {**valid, "kind": "normal"},
        ]:
            with self.assertRaises(HTTPException) as caught:
                validate_canvas_agent_conversation(invalid, "canvas-a")
            self.assertEqual(caught.exception.status_code, 409)

    def test_history_summary_does_not_store_the_full_snapshot(self):
        summary = canvas_agent_context_summary(self.sample_context())
        self.assertEqual(summary, {
            "schema_version": 1,
            "node_count": 2,
            "connection_count": 1,
            "selected_node_count": 1,
            "selected_image_count": 1,
            "detail_count": 2,
            "truncated": False,
        })
        self.assertNotIn("details", summary)

    def test_static_versioning_preserves_embed_query_before_cache_version(self):
        rendered = main.versioned_static_html(
            '<iframe src="/static/gpt-chat.html?embed=canvas&amp;v=old"></iframe>'
        )
        self.assertIn('/static/gpt-chat.html?embed=canvas&amp;v=', rendered)
        self.assertNotRegex(rendered, r'gpt-chat\.html\?v=[^"?]+\?embed=canvas')


class CanvasAgentRouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.conversation_patch = patch.object(main, "CONVERSATION_DIR", self.tempdir.name)
        self.conversation_patch.start()
        self.request = Request({
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": [],
            "client": ("127.0.0.1", 12345),
        })

    def tearDown(self):
        self.conversation_patch.stop()
        self.tempdir.cleanup()

    def payload(self, **overrides):
        data = {
            "canvas_id": "canvas-a",
            "message": "分析选中节点",
            "provider": "modelscope",
            "model": "demo/vision-model",
            "canvas_context": CanvasAgentReadonlyTests.sample_context(self),
            "reference_images": [{"url": "/output/a.png", "name": "参考图", "node_id": "n2"}],
        }
        data.update(overrides)
        return CanvasAgentStreamRequest(**data)

    async def test_agent_history_is_per_canvas_and_hidden_from_normal_chat(self):
        normal = main.new_conversation("tester", "普通对话")
        agent_a = await main.create_canvas_agent_conversation(
            CanvasAgentConversationCreate(canvas_id="canvas-a", title="画布 A"), self.request, "tester"
        )
        await main.create_canvas_agent_conversation(
            CanvasAgentConversationCreate(canvas_id="canvas-b", title="画布 B"), self.request, "tester"
        )
        listed = await main.canvas_agent_conversations(self.request, "canvas-a", "tester")
        self.assertEqual([item["id"] for item in listed["conversations"]], [agent_a["conversation"]["id"]])
        self.assertEqual([item["id"] for item in main.list_conversations("tester")], [normal["id"]])
        with self.assertRaises(HTTPException) as normal_route:
            await main.get_conversation(agent_a["conversation"]["id"], self.request, "tester")
        self.assertEqual(normal_route.exception.status_code, 409)
        with self.assertRaises(HTTPException) as caught:
            await main.get_canvas_agent_conversation(
                agent_a["conversation"]["id"], self.request, "canvas-b", "tester"
            )
        self.assertEqual(caught.exception.status_code, 409)

    async def test_cli_provider_is_rejected_before_any_conversation_or_model_call(self):
        with patch.object(main, "get_api_provider", return_value={"id": "codex", "protocol": "codex"}), \
             patch.object(main, "resolve_chat_provider") as resolve:
            with self.assertRaises(HTTPException) as caught:
                await main.chat_canvas_agent_stream(self.payload(provider="codex"), self.request, "tester")
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("只读画布 Agent", caught.exception.detail)
        resolve.assert_not_called()
        self.assertEqual(main.list_canvas_agent_conversations("tester", "canvas-a"), [])

    async def test_stream_uses_read_only_sse_and_never_calls_generation_or_canvas_writes(self):
        async def fake_deltas(*_args, **_kwargs):
            yield "这是"
            yield "分析结果"

        generate = AsyncMock()
        save_canvas = Mock()
        mutate_canvas = Mock()
        with patch.object(main, "get_api_provider", return_value={"id": "api", "protocol": "openai", "chat_models": ["demo-vision"]}), \
             patch.object(main, "resolve_chat_provider", return_value=("https://api.example/v1", {"Authorization": "Bearer hidden"}, "demo-vision")), \
             patch.object(main, "canvas_agent_upstream_deltas", fake_deltas), \
             patch.object(main, "generate_ai_image", generate), \
             patch.object(main, "save_canvas", save_canvas), \
             patch.object(main, "mutate_canvas_latest", mutate_canvas):
            response = await main.chat_canvas_agent_stream(
                self.payload(provider="api", model="demo-vision"), self.request, "tester"
            )
            chunks = []
            async for chunk in response.body_iterator:
                chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
        text = "".join(chunks)
        events = [json.loads(line[6:]) for line in text.splitlines() if line.startswith("data: ")]
        self.assertEqual([event["type"] for event in events], ["meta", "delta", "delta", "done"])
        self.assertEqual("".join(event.get("delta", "") for event in events), "这是分析结果")
        conversation = events[-1]["conversation"]
        self.assertEqual(conversation["kind"], "canvas_agent")
        self.assertEqual(conversation["canvas_id"], "canvas-a")
        saved = main.load_conversation("tester", conversation["id"])
        serialized = json.dumps(saved, ensure_ascii=False)
        self.assertNotIn("canvas_context", serialized)
        self.assertNotIn("分析这段提示词", serialized)
        self.assertIn("context_summary", serialized)
        generate.assert_not_awaited()
        save_canvas.assert_not_called()
        mutate_canvas.assert_not_called()


if __name__ == "__main__":
    unittest.main()
