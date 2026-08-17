import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class FakeRunningHubResponse:
    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


class FakeRunningHubClient:
    def __init__(self):
        self.posts = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        if url.endswith("/task/openapi/ai-app/run"):
            return FakeRunningHubResponse({"code": 0, "data": {"taskId": "task-test"}})
        return FakeRunningHubResponse({"code": 0, "data": {}})


class OnlineRunningHubParameterTests(unittest.IsolatedAsyncioTestCase):
    def image_only_entry(self):
        return {
            "kind": "app",
            "id": "upscale-app",
            "fields": [
                {
                    "id": "193::value",
                    "nodeId": "193",
                    "fieldName": "value",
                    "fieldType": "SELECT",
                    "label": "短边尺寸",
                    "fieldValue": "4096",
                    "options": ["1024", "2048", "4096"],
                    "enabled": True,
                },
                {
                    "id": "187::image",
                    "nodeId": "187",
                    "fieldName": "image",
                    "fieldType": "IMAGE",
                    "fieldValue": "default.png",
                    "enabled": True,
                },
            ],
        }

    def test_request_model_accepts_empty_prompt_for_image_only_entries(self):
        payload = main.OnlineImageRequest(
            prompt="",
            provider_id="runninghub",
            model="app:upscale-app",
            runninghub_params={"193::value": "2048"},
        )
        self.assertEqual(payload.prompt, "")
        self.assertEqual(payload.runninghub_params, {"193::value": "2048"})

    def test_prompt_requirement_follows_the_selected_entry_fields(self):
        image_only = self.image_only_entry()
        prompt_entry = {
            **image_only,
            "fields": [
                *image_only["fields"],
                {
                    "id": "22::prompt",
                    "nodeId": "22",
                    "fieldName": "prompt",
                    "fieldType": "STRING",
                    "fieldValue": "",
                    "enabled": True,
                },
            ],
        }
        provider = {"id": "runninghub", "protocol": "runninghub"}

        with patch.object(main, "runninghub_entry_config_from_model", return_value=image_only):
            self.assertFalse(main.online_image_prompt_required(provider, "app:upscale-app"))
        with patch.object(main, "runninghub_entry_config_from_model", return_value=prompt_entry):
            self.assertTrue(main.online_image_prompt_required(provider, "app:upscale-app"))
        with patch.object(main, "runninghub_entry_config_from_model", return_value=None):
            self.assertTrue(main.online_image_prompt_required(provider, "runninghub-model-api"))
        self.assertTrue(main.online_image_prompt_required({"id": "comfly", "protocol": "openai"}, "gpt-image-2"))

    def test_entry_parameter_override_is_whitelisted_and_option_checked(self):
        field = self.image_only_entry()["fields"][0]
        self.assertEqual(
            main.runninghub_entry_param_override(field, {"193::value": "2048"}),
            (True, "2048"),
        )
        self.assertEqual(
            main.runninghub_entry_param_override(field, {"193::value": "3072"}),
            (False, ""),
        )
        self.assertEqual(
            main.runninghub_entry_param_override(field, {"unknown": "2048"}),
            (False, ""),
        )

    def test_media_and_prompt_fields_cannot_be_overridden_by_entry_params(self):
        image_field = self.image_only_entry()["fields"][1]
        prompt_field = {
            "id": "22::prompt",
            "nodeId": "22",
            "fieldName": "prompt",
            "fieldType": "STRING",
            "enabled": True,
        }
        self.assertEqual(
            main.runninghub_entry_param_override(image_field, {"187::image": "other.png"}),
            (False, ""),
        )
        self.assertEqual(
            main.runninghub_entry_param_override(prompt_field, {"22::prompt": "injected"}),
            (False, ""),
        )

    def test_entry_references_require_exact_enabled_image_inputs_and_trim_extras(self):
        entry = {
            "kind": "app",
            "id": "style-transfer",
            "fields": [
                {"nodeId": "100", "fieldName": "image", "fieldType": "IMAGE", "enabled": True},
                {"nodeId": "112", "fieldName": "image", "fieldType": "IMAGE", "enabled": True},
                {"nodeId": "9", "fieldName": "seed", "fieldType": "NUMBER", "enabled": True},
                {"nodeId": "120", "fieldName": "mask", "fieldType": "IMAGE", "enabled": False},
            ],
        }
        refs = [
            {"url": "https://example.test/a.png", "kind": "image"},
            {"url": "https://example.test/b.png", "kind": "image"},
            {"url": "https://example.test/stale.png", "kind": "image"},
        ]

        self.assertEqual(len(main.runninghub_entry_image_fields(entry)), 2)
        self.assertEqual(
            main.prepare_runninghub_entry_references(entry, refs),
            refs[:2],
        )
        with self.assertRaisesRegex(main.HTTPException, "需要上传 2 张图片"):
            main.prepare_runninghub_entry_references(entry, refs[:1])

    async def test_generate_ai_image_forwards_params_only_to_runninghub(self):
        provider = {
            "id": "runninghub",
            "name": "RunningHub",
            "base_url": "https://runninghub.example.test",
            "protocol": "runninghub",
        }
        params = {"193::value": "2048"}
        with patch.object(main, "get_api_provider", return_value=provider), patch.object(
            main, "generate_runninghub_provider_image", return_value=("image", {})
        ) as runninghub:
            await main.generate_ai_image(
                "",
                "1024x1024",
                "auto",
                "app:upscale-app",
                [],
                "runninghub",
                "",
                "",
                params,
            )
        runninghub.assert_awaited_once_with(
            "", "1024x1024", "app:upscale-app", [], provider, params
        )

    async def test_entry_submission_uses_selected_parameter_in_node_info_list(self):
        provider = {
            "id": "runninghub",
            "name": "RunningHub",
            "base_url": "https://runninghub.example.test",
            "protocol": "runninghub",
        }
        entry = self.image_only_entry()
        image_ref = {"url": "https://example.test/input.png", "kind": "image"}
        client = FakeRunningHubClient()
        with patch.object(main.httpx, "AsyncClient", return_value=client), patch.object(
            main, "runninghub_api_key", return_value="test-key"
        ), patch.object(
            main, "runninghub_upload_local_to_filename", return_value="uploaded.png"
        ), patch.object(
            main, "runninghub_extract_outputs", return_value=["https://example.test/output.png"]
        ), patch.object(main.asyncio, "sleep", new=AsyncMock()):
            await main.generate_runninghub_entry_image(
                "",
                "1024x1024",
                "app:upscale-app",
                [image_ref],
                provider,
                entry,
                {"193::value": "2048"},
            )

        submit_body = client.posts[0][1]["json"]
        self.assertEqual(submit_body["webappId"], "upscale-app")
        self.assertEqual(
            submit_body["nodeInfoList"],
            [
                {"nodeId": "187", "fieldName": "image", "fieldValue": "uploaded.png"},
                {"nodeId": "193", "fieldName": "value", "fieldValue": "2048"},
            ],
        )


if __name__ == "__main__":
    unittest.main()
