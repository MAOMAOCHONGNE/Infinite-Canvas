import asyncio
import copy
import json
import os
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

import main


def payload(**overrides):
    values = {
        "page_type": "detail",
        "product_images": ["https://example.test/product.png"],
        "reference_images": ["https://example.test/reference.png"],
        "image_provider_id": "custom-api",
        "image_model": "gpt-image-2",
        "llm_provider_id": "vision-provider",
        "llm_model": "gemini-3-flash",
        "aspect_ratio": "3:4",
        "resolution": "2k",
        "size": "1536x2048",
        "quality": "auto",
        "screen_count": 1,
        "copywriting": "required",
        "richness": "concise",
        "font_style": "auto",
        "output_language": "中文",
        "model_setting": "use",
        "model_pose": "specific",
        "model_usage": 1,
        "reversal_screens": 0,
        "product_name": "测试产品",
        "product_features": "保持产品一致",
        "user_instruction": "",
    }
    values.update(overrides)
    return main.DetailPageTaskRequest(**values)


class FakeResponse:
    def __init__(self, data, status_code=200):
        self._data = data
        self.status_code = status_code
        self.text = json.dumps(data, ensure_ascii=False)

    def json(self):
        return copy.deepcopy(self._data)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise main.httpx.HTTPStatusError("failed", request=None, response=self)


class FakeAsyncClient:
    def __init__(self, submit_payload, query_payloads, events):
        self.submit_payload = submit_payload
        self.query_payloads = list(query_payloads)
        self.events = events
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return FakeResponse(self.submit_payload)

    async def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        self.events.append("query")
        payload = self.query_payloads.pop(0)
        if isinstance(payload, Exception):
            raise payload
        return FakeResponse(payload)


class DetailPagePermanentGroupNumberTests(unittest.TestCase):
    def tearDown(self):
        for task_id in list(main.CANVAS_TASKS):
            if str(task_id).startswith("detail_page_async_test_"):
                main.CANVAS_TASKS.pop(task_id, None)

    def test_legacy_tasks_are_migrated_once_and_deleted_numbers_are_not_reused(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(main, "DETAIL_PAGE_TASK_DIR", folder):
            newer = main.new_detail_page_task_record("detail_page_async_test_newer", payload())
            older = main.new_detail_page_task_record("detail_page_async_test_older", payload())
            older.update({"created_at": 10, "updated_at": 10, "status": "succeeded"})
            newer.update({"created_at": 20, "updated_at": 20, "status": "succeeded"})
            main.detail_page_persist_task(newer)
            main.detail_page_persist_task(older)

            main.load_persisted_detail_page_tasks()
            self.assertEqual(main.CANVAS_TASKS[older["id"]]["group_no"], 1)
            self.assertEqual(main.CANVAS_TASKS[newer["id"]]["group_no"], 2)
            self.assertEqual(main.detail_page_allocate_group_no(), 3)

            main.detail_page_delete_persisted_task(newer["id"])
            main.CANVAS_TASKS.pop(newer["id"], None)
            self.assertEqual(main.detail_page_allocate_group_no(), 4)
            with open(main.detail_page_group_meta_file(), "r", encoding="utf-8") as handle:
                self.assertEqual(json.load(handle)["next_group_no"], 5)


class DetailPageAsyncProviderTests(unittest.TestCase):
    def test_comfly_is_automatic_other_hosts_require_explicit_capability(self):
        self.assertTrue(main.detail_page_async_image_enabled({"base_url": "https://ai.comfly.org"}))
        self.assertTrue(main.detail_page_async_image_enabled({"base_url": "https://ai.comfly.org/v1"}))
        self.assertFalse(main.detail_page_async_image_enabled({"base_url": "https://relay.example/v1"}))
        self.assertTrue(main.detail_page_async_image_enabled({
            "base_url": "https://relay.example/v1",
            "image_async_enabled": True,
        }))

    def test_task_id_string_and_query_template_are_supported_without_secrets(self):
        self.assertEqual(main.extract_task_id({"code": "success", "data": "upstream-123"}), "upstream-123")
        provider = {
            "id": "custom-api",
            "name": "Relay",
            "base_url": "https://relay.example/v1",
            "protocol": "openai",
            "image_async_enabled": True,
            "image_task_endpoint": "/v1/images/tasks/{task_id}",
            "api_key": "must-not-leak",
            "key_preview": "sk-***",
        }
        snapshot = main.detail_page_async_provider_snapshot(provider, "gpt-image-2")
        self.assertEqual(snapshot["image_task_endpoint"], "/v1/images/tasks/{task_id}")
        self.assertNotIn("api_key", snapshot)
        self.assertNotIn("key_preview", snapshot)
        self.assertEqual(
            main.image_task_url_for_provider(snapshot, "abc/123"),
            "https://relay.example/v1/images/tasks/abc%2F123",
        )

    def test_explicit_async_edit_persists_task_id_before_first_query(self):
        async def scenario():
            events = []
            provider = {
                "id": "custom-api",
                "name": "API comfly",
                "base_url": "https://ai.comfly.org",
                "protocol": "openai",
                "image_request_mode": "openai",
                "image_models": ["gpt-image-2"],
                "model_image_strategies": {"gpt-image-2": "gpt-image"},
            }
            client = FakeAsyncClient(
                {"code": "success", "message": "", "data": "task-edit-1"},
                [{
                    "code": "success",
                    "data": {
                        "task_id": "task-edit-1",
                        "status": "SUCCESS",
                        "data": {"data": [{"url": "https://files.example/result.png"}]},
                    },
                }],
                events,
            )

            async def observer(event, details):
                events.append(event)
                if event == "submitted":
                    self.assertEqual(details["task_id"], "task-edit-1")

            with patch.object(main, "get_api_provider", return_value=provider), \
                    patch.object(main, "provider_env_key_value", return_value="unit-test-key"), \
                    patch.object(main.httpx, "AsyncClient", return_value=client), \
                    patch.object(main, "output_file_from_url", return_value=None):
                image, raw = await main.generate_ai_image(
                    "prompt", "1024x1024", "auto", "gpt-image-2",
                    [{"url": "https://example.test/product.png", "role": "product"}],
                    "custom-api", async_task_observer=observer,
                )
            return image, raw, client, events

        image, raw, client, events = asyncio.run(scenario())
        self.assertEqual(image["value"], "https://files.example/result.png")
        self.assertEqual(raw["data"]["task_id"], "task-edit-1")
        self.assertEqual(events[:2], ["submitted", "query"])
        self.assertIn("async=true", client.calls[0][1])
        self.assertIn("/v1/images/edits", client.calls[0][1])
        self.assertEqual([call[0] for call in client.calls].count("POST"), 1)

    def test_explicit_async_generation_uses_generations_endpoint(self):
        async def scenario():
            events = []
            provider = {
                "id": "custom-api", "name": "API comfly", "base_url": "https://ai.comfly.org",
                "protocol": "openai", "image_request_mode": "openai", "image_models": ["gpt-image-2"],
                "model_image_strategies": {"gpt-image-2": "gpt-image"},
            }
            client = FakeAsyncClient(
                {"data": "task-generation-1"},
                [{"data": {"task_id": "task-generation-1", "status": "SUCCESS", "data": {"data": [{"url": "https://files.example/generated.png"}]}}}],
                events,
            )
            with patch.object(main, "get_api_provider", return_value=provider), \
                    patch.object(main, "provider_env_key_value", return_value="unit-test-key"), \
                    patch.object(main.httpx, "AsyncClient", return_value=client):
                await main.generate_ai_image(
                    "prompt", "1024x1024", "auto", "gpt-image-2", [], "custom-api",
                    async_task_observer=AsyncMock(),
                )
            return client.calls

        calls = asyncio.run(scenario())
        self.assertIn("/v1/images/generations", calls[0][1])
        self.assertIn("async=true", calls[0][1])

    def test_query_disconnect_recovers_without_a_second_paid_post(self):
        async def scenario():
            events = []
            provider = {
                "id": "custom-api", "name": "API comfly", "base_url": "https://ai.comfly.org",
                "protocol": "openai", "image_request_mode": "openai", "image_models": ["gpt-image-2"],
                "model_image_strategies": {"gpt-image-2": "gpt-image"},
            }
            disconnects = [main.httpx.RemoteProtocolError("Server disconnected without sending a response") for _ in range(3)]
            success = {"data": {"task_id": "task-network-1", "status": "SUCCESS", "data": {"data": [{"url": "https://files.example/recovered.png"}]}}}
            client = FakeAsyncClient({"data": "task-network-1"}, [*disconnects, success], events)

            async def observer(event, _details):
                events.append(event)

            with patch.object(main, "get_api_provider", return_value=provider), \
                    patch.object(main, "provider_env_key_value", return_value="unit-test-key"), \
                    patch.object(main.httpx, "AsyncClient", return_value=client), \
                    patch.object(main.asyncio, "sleep", new=AsyncMock()):
                image, _raw = await main.generate_ai_image(
                    "prompt", "1024x1024", "auto", "gpt-image-2", [], "custom-api",
                    async_task_observer=observer,
                )
            return image, client.calls, events

        image, calls, events = asyncio.run(scenario())
        self.assertEqual(image["value"], "https://files.example/recovered.png")
        self.assertEqual([call[0] for call in calls].count("POST"), 1)
        self.assertGreaterEqual([call[0] for call in calls].count("GET"), 4)
        self.assertIn("recovering", events)

    def test_thirty_minute_query_deadline_becomes_unknown_with_the_same_task_id(self):
        async def scenario():
            class InProgressClient:
                async def request(self, _method, _url, **_kwargs):
                    return FakeResponse({"data": {"task_id": "task-timeout-1", "status": "IN_PROGRESS"}})

            client = InProgressClient()
            with patch.object(main, "provider_env_key_value", return_value="unit-test-key"):
                with self.assertRaises(main.DetailPageAsyncTaskUnknown) as captured:
                    await main.wait_for_detail_page_image_task(
                        client,
                        "task-timeout-1",
                        {"id": "custom-api", "base_url": "https://ai.comfly.org"},
                        timeout=0.01,
                    )
            return captured.exception

        error = asyncio.run(scenario())
        self.assertEqual(error.upstream_task_id, "task-timeout-1")
        self.assertEqual(error.async_candidate_status, "unknown")


class DetailPageCandidateRecoveryTests(unittest.TestCase):
    def tearDown(self):
        for task_id in list(main.CANVAS_TASKS):
            if str(task_id).startswith("detail_page_async_test_"):
                main.CANVAS_TASKS.pop(task_id, None)
        main.DETAIL_PAGE_CANDIDATE_RECOVERY_TASKS.clear()

    def test_candidate_exists_before_submit_and_task_id_is_persisted_before_polling(self):
        async def scenario(folder):
            task_id = "detail_page_async_test_candidate"
            request_payload = payload()
            record = main.new_detail_page_task_record(task_id, request_payload)
            record["status"] = "generating"
            record["screens"] = main.detail_page_screen_records([{"screen_no": 1, "prompt": "prompt"}])
            main.CANVAS_TASKS[task_id] = record

            async def fake_build(_request, async_task_observer=None, **_kwargs):
                candidate = main.CANVAS_TASKS[task_id]["screens"][0]["candidates"][0]
                self.assertEqual(candidate["status"], "submitting")
                await async_task_observer("submitted", {
                    "task_id": "task-42",
                    "provider": {
                        "id": "custom-api", "base_url": "https://ai.comfly.org",
                        "protocol": "openai", "image_async_enabled": True,
                        "image_task_endpoint": "/v1/images/tasks/{task_id}", "model": "gpt-image-2",
                    },
                })
                with open(main.detail_page_task_file(task_id), "r", encoding="utf-8") as handle:
                    persisted = json.load(handle)
                self.assertEqual(persisted["screens"][0]["candidates"][0]["upstream_task_id"], "task-42")
                await async_task_observer("recovering", {"attempt": 2, "error": "temporary disconnect"})
                return {"images": ["/output/recovered.png"], "task_id": "task-42"}

            with patch.object(main, "DETAIL_PAGE_TASK_DIR", folder), \
                    patch.object(main, "detail_page_async_snapshot_for_request", return_value={
                        "id": "custom-api", "base_url": "https://ai.comfly.org",
                        "protocol": "openai", "image_async_enabled": True,
                        "image_task_endpoint": "/v1/images/tasks/{task_id}", "model": "gpt-image-2",
                    }), \
                    patch.object(main, "build_online_image_result", side_effect=fake_build), \
                    patch.object(main, "annotate_one_click_history_record") as annotate:
                await main.run_detail_page_screen(task_id, request_payload, 1)
            return main.CANVAS_TASKS[task_id], annotate.call_args

        with tempfile.TemporaryDirectory() as folder:
            task, annotation = asyncio.run(scenario(folder))
        candidate = task["screens"][0]["candidates"][0]
        self.assertEqual(candidate["status"], "succeeded")
        self.assertEqual(candidate["upstream_task_id"], "task-42")
        self.assertEqual(candidate["query_attempts"], 2)
        self.assertEqual(task["screens"][0]["status"], "succeeded")
        self.assertEqual(annotation.args[1], "detail-page")
        self.assertEqual(annotation.args[3], {
            "source_type": "detail-page",
            "source_task_id": "detail_page_async_test_candidate",
            "source_screen_no": 1,
        })

    def test_unknown_candidate_with_task_id_can_be_refilled_by_query_only(self):
        async def scenario(folder):
            task_id = "detail_page_async_test_refill"
            request_payload = payload()
            record = main.new_detail_page_task_record(task_id, request_payload)
            record["status"] = "unknown"
            record["screens"] = main.detail_page_screen_records([{"screen_no": 1, "prompt": "prompt"}])
            record["screens"][0].update({
                "status": "unknown",
                "candidates": [{
                    "id": "candidate_unknown", "candidate_no": 1, "status": "unknown",
                    "upstream_task_id": "task-refill-1", "provider_snapshot": {
                        "id": "custom-api", "name": "API comfly", "base_url": "https://ai.comfly.org",
                        "protocol": "openai", "image_async_enabled": True,
                        "image_task_endpoint": "/v1/images/tasks/{task_id}", "model": "gpt-image-2",
                    },
                    "prompt": "prompt", "generation_params": {}, "result": None,
                    "image_url": "", "error": "自动查询超时", "created_at": time.time(),
                }],
            })
            main.CANVAS_TASKS[task_id] = record
            client = FakeAsyncClient({}, [{
                "data": {"task_id": "task-refill-1", "status": "SUCCESS", "data": {
                    "data": [{"url": "https://files.example/refilled.png"}],
                }},
            }], [])
            recovered_media = {
                "id": "a" * 64,
                "url": "/assets/image-generation/media/aa/" + "a" * 64 + ".png",
            }
            with patch.object(main, "DETAIL_PAGE_TASK_DIR", folder), \
                    patch.object(main, "provider_env_key_value", return_value="unit-test-key"), \
                    patch.object(main.httpx, "AsyncClient", return_value=client), \
                    patch.object(main, "save_ai_image_to_media", AsyncMock(return_value=recovered_media)), \
                    patch.object(main, "image_generation_adopt_result", AsyncMock(return_value=recovered_media)):
                await main.run_detail_page_candidate_recovery(task_id, 1, "candidate_unknown")
            return main.CANVAS_TASKS[task_id], client.calls, recovered_media

        with tempfile.TemporaryDirectory() as folder:
            task, calls, recovered_media = asyncio.run(scenario(folder))
        candidate = task["screens"][0]["candidates"][0]
        self.assertEqual(candidate["status"], "succeeded")
        self.assertEqual(candidate["image_url"], recovered_media["url"])
        self.assertTrue(calls)
        self.assertTrue(all(method == "GET" for method, _url, _kwargs in calls))

    def test_restart_marks_saved_task_ids_for_recovery_and_schedules_them(self):
        async def schedule_and_wait():
            runner = AsyncMock(return_value=None)
            with patch.object(main, "run_detail_page_candidate_recovery", runner):
                self.assertEqual(main.schedule_detail_page_candidate_recoveries(), 1)
                await asyncio.gather(*list(main.DETAIL_PAGE_CANDIDATE_RECOVERY_TASKS.values()))
                await asyncio.sleep(0)
            return runner.await_count

        with tempfile.TemporaryDirectory() as folder, patch.object(main, "DETAIL_PAGE_TASK_DIR", folder):
            task_id = "detail_page_async_test_restart"
            record = main.new_detail_page_task_record(task_id, payload())
            record["status"] = "generating"
            record["screens"] = main.detail_page_screen_records([{"screen_no": 1, "prompt": "prompt"}])
            record["screens"][0].update({
                "status": "generating",
                "candidates": [{
                    "id": "candidate_restart", "status": "generating", "upstream_task_id": "task-restart-1",
                    "provider_snapshot": {
                        "id": "custom-api", "base_url": "https://ai.comfly.org", "protocol": "openai",
                        "image_async_enabled": True, "image_task_endpoint": "/v1/images/tasks/{task_id}",
                    },
                }],
            })
            main.detail_page_persist_task(record)
            main.CANVAS_TASKS.pop(task_id, None)
            main.load_persisted_detail_page_tasks()
            restored = main.CANVAS_TASKS[task_id]
            self.assertEqual(restored["status"], "generating")
            self.assertEqual(restored["screens"][0]["candidates"][0]["status"], "recovering")
            self.assertEqual(asyncio.run(schedule_and_wait()), 1)

    def test_refill_endpoint_deduplicates_repeated_clicks(self):
        async def scenario(folder):
            task_id = "detail_page_async_test_dedup"
            record = main.new_detail_page_task_record(task_id, payload())
            record["status"] = "unknown"
            record["screens"] = main.detail_page_screen_records([{"screen_no": 1, "prompt": "prompt"}])
            record["screens"][0].update({
                "status": "unknown",
                "candidates": [{
                    "id": "candidate_dedup", "status": "unknown", "upstream_task_id": "task-dedup-1",
                    "provider_snapshot": {
                        "id": "custom-api", "base_url": "https://ai.comfly.org", "protocol": "openai",
                        "image_task_endpoint": "/v1/images/tasks/{task_id}",
                    },
                }],
            })
            main.CANVAS_TASKS[task_id] = record
            release = asyncio.Event()

            async def fake_recovery(*_args):
                await release.wait()

            with patch.object(main, "DETAIL_PAGE_TASK_DIR", folder), patch.object(main, "run_detail_page_candidate_recovery", side_effect=fake_recovery) as runner:
                first = await main.recover_detail_page_candidate(task_id, 1, "candidate_dedup")
                second = await main.recover_detail_page_candidate(task_id, 1, "candidate_dedup")
                self.assertFalse(first["reused"])
                self.assertTrue(second["reused"])
                self.assertEqual(len(main.DETAIL_PAGE_CANDIDATE_RECOVERY_TASKS), 1)
                release.set()
                await asyncio.gather(*list(main.DETAIL_PAGE_CANDIDATE_RECOVERY_TASKS.values()))
                await asyncio.sleep(0)
                self.assertEqual(runner.await_count, 1)

        with tempfile.TemporaryDirectory() as folder:
            asyncio.run(scenario(folder))


if __name__ == "__main__":
    unittest.main()
