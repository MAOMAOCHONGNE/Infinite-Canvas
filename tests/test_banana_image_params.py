import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class FakeImageResponse:
    status_code = 200

    def raise_for_status(self):
        return None

    def json(self):
        return {"data": [{"url": "https://example.test/generated.png"}]}


class FakeImageClient:
    def __init__(self):
        self.posts = []
        self.response = FakeImageResponse()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        return self.response


class BananaImageParameterTests(unittest.IsolatedAsyncioTestCase):
    async def call_image(self, provider, model, size="2048x2048", aspect_ratio="1:1", resolution="2k"):
        client = FakeImageClient()
        with patch.object(main, "get_api_provider", return_value=provider), patch.object(
            main, "provider_env_key_value", return_value="test-key"
        ), patch.object(main.httpx, "AsyncClient", return_value=client):
            await main.generate_ai_image(
                "test prompt", size, "auto", model, [], provider["id"], aspect_ratio, resolution
            )
        self.assertEqual(len(client.posts), 1)
        return client.posts[0][1]["json"]

    async def test_banana_uses_image_size_and_aspect_ratio(self):
        body = await self.call_image(
            {"id": "comfly", "name": "Comfly", "base_url": "https://ai.example.test", "protocol": "openai"},
            "nano-banana-2",
        )
        self.assertEqual(body["image_size"], "2K")
        self.assertEqual(body["aspect_ratio"], "1:1")
        self.assertNotIn("size", body)

    async def test_banana_forwards_extreme_explicit_aspect_ratios(self):
        provider = {"id": "comfly", "name": "Comfly", "base_url": "https://ai.example.test", "protocol": "openai"}
        for ratio in ("1:8", "4:1", "8:1", "21:9", "9:21"):
            with self.subTest(ratio=ratio):
                body = await self.call_image(provider, "nano-banana-2", aspect_ratio=ratio)
                self.assertEqual(body["aspect_ratio"], ratio)

    async def test_banana_true_adaptive_mode_omits_aspect_ratio(self):
        body = await self.call_image(
            {"id": "comfly", "name": "Comfly", "base_url": "https://ai.example.test", "protocol": "openai"},
            "nano-banana-2",
            aspect_ratio="",
        )
        self.assertEqual(body["image_size"], "2K")
        self.assertNotIn("aspect_ratio", body)

    async def test_banana_keeps_an_explicit_custom_ratio_instead_of_silently_replacing_it(self):
        body = await self.call_image(
            {"id": "comfly", "name": "Comfly", "base_url": "https://ai.example.test", "protocol": "openai"},
            "nano-banana-2",
            aspect_ratio="7:3",
        )
        self.assertEqual(body["aspect_ratio"], "7:3")

    async def test_gpt_image_2_keeps_legacy_size(self):
        body = await self.call_image(
            {"id": "comfly", "name": "Comfly", "base_url": "https://ai.example.test", "protocol": "openai"},
            "gpt-image-2",
        )
        self.assertEqual(body["size"], "2048x2048")
        self.assertNotIn("image_size", body)
        self.assertNotIn("aspect_ratio", body)

    def test_gpt_image_strategy_normalization_and_auto_detection(self):
        self.assertEqual(
            main.normalize_model_image_strategies({
                "custom-gpt": "gpt-image",
                "banana": "banana",
                "auto": "auto",
                "bad": "unsupported",
            }),
            {"custom-gpt": "gpt-image", "banana": "banana"},
        )
        self.assertEqual(main.effective_image_parameter_strategy({}, "gpt-image-2"), "gpt-image")
        self.assertEqual(main.effective_image_parameter_strategy({}, "nano-banana-pro"), "banana")
        self.assertEqual(main.effective_image_parameter_strategy({}, "unknown-image-model"), "legacy")

    async def test_explicit_logical_gpt_image_strategy_supports_provider_specific_model_ids(self):
        provider = {
            "id": "comfly",
            "name": "Comfly",
            "base_url": "https://ai.example.test",
            "protocol": "openai",
            "model_image_strategies": {"custom-gpt": "gpt-image"},
            "image_model_resolution_maps": {
                "custom-gpt": {
                    "enabled": True,
                    "models": {"2k": "provider-specific-image-v6"},
                }
            },
        }
        body = await self.call_image(
            provider,
            "custom-gpt",
            size="auto",
            aspect_ratio="",
            resolution="2k",
        )
        self.assertEqual(body, {
            "model": "provider-specific-image-v6",
            "prompt": "test prompt",
            "size": "auto",
        })

    async def test_unknown_model_keeps_legacy_size(self):
        body = await self.call_image(
            {"id": "comfly", "name": "Comfly", "base_url": "https://ai.example.test", "protocol": "openai"},
            "some-image-model",
        )
        self.assertEqual(body["size"], "2048x2048")
        self.assertNotIn("image_size", body)

    async def test_non_banana_suffix_model_keeps_legacy_size(self):
        body = await self.call_image(
            {"id": "comfly", "name": "Comfly", "base_url": "https://ai.example.test", "protocol": "openai"},
            "some-image-model-4k",
            resolution="1k",
        )
        self.assertEqual(body["size"], "2048x2048")
        self.assertNotIn("image_size", body)

    async def test_explicit_legacy_override_disables_auto_banana(self):
        body = await self.call_image(
            {
                "id": "comfly",
                "name": "Comfly",
                "base_url": "https://ai.example.test",
                "protocol": "openai",
                "model_image_strategies": {"nano-banana-2": "legacy"},
            },
            "nano-banana-2",
        )
        self.assertEqual(body["size"], "2048x2048")
        self.assertNotIn("image_size", body)

    async def test_fixed_4k_model_overrides_canvas_1k_choice(self):
        body = await self.call_image(
            {"id": "comfly", "name": "Comfly", "base_url": "https://ai.example.test", "protocol": "openai"},
            "gemini-3.1-flash-image-preview-4k",
            resolution="1k",
        )
        self.assertEqual(body["image_size"], "4K")

    async def test_fixed_2k_model_overrides_canvas_4k_choice(self):
        body = await self.call_image(
            {"id": "comfly", "name": "Comfly", "base_url": "https://ai.example.test", "protocol": "openai"},
            "nano-banana-pro-2k",
            resolution="4k",
        )
        self.assertEqual(body["image_size"], "2K")

    async def test_unsuffixed_banana_model_keeps_dynamic_canvas_choice(self):
        body = await self.call_image(
            {"id": "comfly", "name": "Comfly", "base_url": "https://ai.example.test", "protocol": "openai"},
            "nano-banana-pro",
            resolution="4k",
        )
        self.assertEqual(body["image_size"], "4K")

    async def test_native_gemini_route_is_not_replaced_by_banana_body(self):
        provider = {
            "id": "comfly",
            "name": "Comfly",
            "base_url": "https://ai.example.test",
            "protocol": "gemini",
        }
        with patch.object(main, "get_api_provider", return_value=provider), patch.object(
            main, "generate_gemini_provider_image", return_value=("image", {})
        ) as gemini:
            await main.generate_ai_image("test prompt", "2048x2048", "auto", "nano-banana-2", [], "comfly", "1:1", "2k")
        gemini.assert_awaited_once()

    async def test_runninghub_route_is_not_replaced_by_banana_body(self):
        provider = {
            "id": "runninghub",
            "name": "RunningHub",
            "base_url": "https://runninghub.example.test",
            "protocol": "runninghub",
        }
        with patch.object(main, "get_api_provider", return_value=provider), patch.object(
            main, "generate_runninghub_provider_image", return_value=("image", {})
        ) as runninghub:
            await main.generate_ai_image("test prompt", "2048x2048", "auto", "nano-banana-2", [], "runninghub", "1:1", "2k")
        runninghub.assert_awaited_once()


class ImageModelResolutionRoutingTests(unittest.IsolatedAsyncioTestCase):
    def provider(self, routing=None):
        return {
            "id": "comfly",
            "name": "Comfly",
            "base_url": "https://ai.example.test",
            "protocol": "openai",
            "image_model_resolution_maps": routing or {},
        }

    def test_disabled_mapping_keeps_the_logical_model(self):
        provider = self.provider({
            "banana-logical": {
                "enabled": False,
                "models": {"1k": "banana-real-1k", "2k": "banana-real-2k"},
            }
        })
        self.assertEqual(
            main.resolve_image_model_for_resolution(provider, "banana-logical", "2k"),
            "banana-logical",
        )

    def test_enabled_mapping_routes_each_configured_resolution(self):
        provider = self.provider({
            "banana-logical": {
                "enabled": True,
                "models": {
                    "1k": "gemini-3.1-flash-image-preview",
                    "2k": "gemini-3.1-flash-image-preview-2k",
                    "4k": "gemini-3.1-flash-image-preview-4k",
                },
            }
        })
        self.assertEqual(
            main.resolve_image_model_for_resolution(provider, "banana-logical", "1k"),
            "gemini-3.1-flash-image-preview",
        )
        self.assertEqual(
            main.resolve_image_model_for_resolution(provider, "banana-logical", "4k"),
            "gemini-3.1-flash-image-preview-4k",
        )

    def test_enabled_mapping_rejects_an_unconfigured_resolution(self):
        provider = self.provider({
            "banana-logical": {
                "enabled": True,
                "models": {"1k": "gemini-3.1-flash-image-preview"},
            }
        })
        with self.assertRaises(main.HTTPException) as ctx:
            main.resolve_image_model_for_resolution(provider, "banana-logical", "2k")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("2K", str(ctx.exception.detail))

    def test_resolution_mapping_normalization_drops_unknown_fields(self):
        normalized = main.normalize_image_model_resolution_maps({
            " banana-logical ": {
                "enabled": True,
                "models": {"1K": " real-1k ", "2k": "", "8k": "ignored"},
                "ignored": "value",
            },
            "": {"enabled": True, "models": {"1k": "ignored"}},
        })
        self.assertEqual(normalized, {
            "banana-logical": {
                "enabled": True,
                "models": {"1k": "real-1k"},
            }
        })

    async def test_request_uses_mapped_model_and_logical_banana_strategy(self):
        provider = self.provider({
            "banana-logical": {
                "enabled": True,
                "models": {"4k": "gemini-3.1-flash-image-preview-4k"},
            }
        })
        provider["model_image_strategies"] = {"banana-logical": "banana"}
        client = FakeImageClient()
        with patch.object(main, "get_api_provider", return_value=provider), patch.object(
            main, "provider_env_key_value", return_value="test-key"
        ), patch.object(main.httpx, "AsyncClient", return_value=client):
            await main.generate_ai_image(
                "test prompt", "4096x4096", "auto", "banana-logical", [], "comfly", "1:1", "4k"
            )
        body = client.posts[0][1]["json"]
        self.assertEqual(body["model"], "gemini-3.1-flash-image-preview-4k")
        self.assertEqual(body["image_size"], "4K")
        self.assertNotIn("size", body)


if __name__ == "__main__":
    unittest.main()
