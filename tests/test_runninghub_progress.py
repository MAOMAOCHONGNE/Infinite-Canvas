import unittest
from unittest.mock import patch

import main


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def json(self):
        return self.payload


class FakeClient:
    def __init__(self, response):
        self.response = response
        self.posts = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        return self.response


class RunningHubQuerySafetyTests(unittest.IsolatedAsyncioTestCase):
    async def test_code_zero_wss_payload_stays_running_and_never_returns_raw_url(self):
        secret_url = "wss://www.runninghub.cn/ws?Rh-Comfy-Auth=secret"
        client = FakeClient(FakeResponse({"code": 0, "msg": "success", "data": {"netWssUrl": secret_url}}))
        with patch.object(main, "runninghub_provider", return_value={"base_url": "https://www.runninghub.cn"}), patch.object(
            main, "runninghub_api_key", return_value="hidden-key"
        ), patch.object(main.httpx, "AsyncClient", return_value=client):
            result = await main.runninghub_query("task-wss")

        self.assertEqual(result["data"]["status"], "RUNNING")
        self.assertNotIn("raw", result["data"])
        self.assertNotIn("progress", result["data"])
        self.assertNotIn("secret", str(result))

    def test_runninghub_diagnostics_redact_keys_and_websocket_auth(self):
        secret_url = "wss://example.test/ws?Rh-Comfy-Auth=temporary-secret"
        raw = {
            "apiKey": "coin-secret",
            "data": {"netWssUrl": secret_url, "status": "RUNNING"},
        }
        detail = main.runninghub_error_detail(
            "Bearer bearer-secret",
            raw,
            endpoint="https://example.test/check?apiKey=query-secret",
        )
        serialized = str(detail)
        self.assertNotIn("coin-secret", serialized)
        self.assertNotIn("temporary-secret", serialized)
        self.assertNotIn("bearer-secret", serialized)
        self.assertNotIn("query-secret", serialized)

        with patch("builtins.print") as mocked_print:
            main.log_runninghub_error("query-unknown", raw, endpoint=secret_url)
        logged = str(mocked_print.call_args)
        self.assertNotIn("coin-secret", logged)
        self.assertNotIn("temporary-secret", logged)


class RunningHubAccountStatusTests(unittest.IsolatedAsyncioTestCase):
    async def call_status(self, use_wallet=False, base_url="https://www.runninghub.cn"):
        payload = {
            "code": 0,
            "msg": "success",
            "data": {
                "remainCoins": "99",
                "remainMoney": "12.5",
                "currency": "CNY",
                "currentTaskCounts": "1",
                "apiType": "NORMAL",
            },
        }
        client = FakeClient(FakeResponse(payload))

        def key(_provider=None, use_wallet=False, prefer_wallet=False):
            return "wallet-secret" if use_wallet else "coin-secret"

        with patch.object(main, "runninghub_provider", return_value={"base_url": base_url}), patch.object(
            main, "runninghub_api_key", side_effect=key
        ), patch.object(main.httpx, "AsyncClient", return_value=client):
            result = await main.runninghub_account_status(useWallet=use_wallet)
        return result, client

    async def test_coin_and_wallet_keys_use_current_cn_or_ai_host(self):
        coin, coin_client = await self.call_status(False, "https://www.runninghub.cn")
        wallet, wallet_client = await self.call_status(True, "https://www.runninghub.ai")

        coin_url, coin_request = coin_client.posts[0]
        wallet_url, wallet_request = wallet_client.posts[0]
        self.assertEqual(coin_url, "https://www.runninghub.cn/uc/openapi/accountStatus")
        self.assertEqual(coin_request["headers"]["Authorization"], "Bearer coin-secret")
        self.assertEqual(coin_request["json"], {"apikey": "coin-secret"})
        self.assertEqual(wallet_url, "https://www.runninghub.ai/uc/openapi/accountStatus")
        self.assertEqual(wallet_request["headers"]["Host"], "www.runninghub.ai")
        self.assertEqual(wallet_request["headers"]["Authorization"], "Bearer wallet-secret")
        self.assertEqual(wallet["data"]["source"], "wallet")
        self.assertEqual(coin["data"]["remainCoins"], "99")
        self.assertNotIn("secret", str(coin))
        self.assertNotIn("secret", str(wallet))


if __name__ == "__main__":
    unittest.main()
