import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class FakeResponse:
    def __init__(self, payload=None, status_code=200, text=""):
        self.payload = payload
        self.status_code = status_code
        self.text = text

    def json(self):
        if isinstance(self.payload, Exception):
            raise self.payload
        return self.payload


class FakeClient:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.posts = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        if self.error:
            raise self.error
        return self.response


class RunningHubCancelTests(unittest.IsolatedAsyncioTestCase):
    async def call_cancel(self, provider, response=None, error=None, use_wallet=False):
        client = FakeClient(response=response, error=error)

        def fake_key(_provider=None, use_wallet=False, prefer_wallet=False):
            return "wallet-secret" if use_wallet else "free-secret"

        with patch.object(main, "runninghub_provider", return_value=provider), patch.object(
            main, "runninghub_api_key", side_effect=fake_key
        ), patch.object(main.httpx, "AsyncClient", return_value=client):
            result = await main.runninghub_cancel(
                main.RunningHubCancelRequest(taskId="task-123", useWallet=use_wallet)
            )
        return result, client

    async def test_cn_provider_uses_current_host_and_free_key(self):
        provider = {"id": "runninghub", "base_url": "https://www.runninghub.cn"}
        result, client = await self.call_cancel(
            provider,
            response=FakeResponse({"code": 0, "msg": "success", "data": None}),
        )

        self.assertEqual(result["data"]["status"], "cancelled")
        url, kwargs = client.posts[0]
        self.assertEqual(url, "https://www.runninghub.cn/task/openapi/cancel")
        self.assertEqual(kwargs["headers"]["Host"], "www.runninghub.cn")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer free-secret")
        self.assertEqual(kwargs["json"], {"apiKey": "free-secret", "taskId": "task-123"})
        self.assertNotIn("free-secret", str(result))

    async def test_ai_provider_uses_wallet_key_and_treats_not_found_as_success(self):
        provider = {"id": "runninghub", "base_url": "https://www.runninghub.ai"}
        result, client = await self.call_cancel(
            provider,
            response=FakeResponse({"code": 807, "msg": "APIKEY_TASK_NOT_FOUND", "data": None}),
            use_wallet=True,
        )

        self.assertEqual(result["data"]["status"], "not_found")
        url, kwargs = client.posts[0]
        self.assertEqual(url, "https://www.runninghub.ai/task/openapi/cancel")
        self.assertEqual(kwargs["headers"]["Host"], "www.runninghub.ai")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer wallet-secret")
        self.assertEqual(kwargs["json"]["apiKey"], "wallet-secret")
        self.assertNotIn("wallet-secret", str(result))

    async def test_upstream_rejection_is_reported_without_key_material(self):
        provider = {"id": "runninghub", "base_url": "https://www.runninghub.cn"}
        with self.assertRaises(main.HTTPException) as ctx:
            await self.call_cancel(
                provider,
                response=FakeResponse({"code": 999, "msg": "CANCEL_NOT_ALLOWED"}),
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertNotIn("free-secret", str(ctx.exception.detail))

    async def test_http_auth_failure_keeps_upstream_status(self):
        provider = {"id": "runninghub", "base_url": "https://www.runninghub.cn"}
        with self.assertRaises(main.HTTPException) as ctx:
            await self.call_cancel(
                provider,
                response=FakeResponse({"code": 401, "msg": "UNAUTHORIZED"}, status_code=401),
            )
        self.assertEqual(ctx.exception.status_code, 401)

    async def test_network_failure_becomes_gateway_error(self):
        provider = {"id": "runninghub", "base_url": "https://www.runninghub.cn"}
        with self.assertRaises(main.HTTPException) as ctx:
            await self.call_cancel(provider, error=RuntimeError("network down"))
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("取消 RunningHub 任务失败", str(ctx.exception.detail))

    async def test_invalid_json_is_a_readable_rejection(self):
        provider = {"id": "runninghub", "base_url": "https://www.runninghub.cn"}
        with self.assertRaises(main.HTTPException) as ctx:
            await self.call_cancel(
                provider,
                response=FakeResponse(ValueError("invalid json"), text="upstream returned html"),
            )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("upstream returned html", str(ctx.exception.detail))


if __name__ == "__main__":
    unittest.main()
