import asyncio
import base64
import io
import json
import os
import tempfile
import threading
import time
import unittest
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from PIL import Image

import main
import storage_cleanup
from image_generation_media import ImageGenerationMediaStore
from image_generation_store import ImageGenerationStore
from tests.image_generation_test_seed import ensure_seed


ROOT = Path(__file__).resolve().parents[1]
SEED_PATH = ensure_seed(ROOT / "tests" / "fixtures" / "image-generation-presets-test.json")


def png_bytes(colour=(30, 90, 150)):
    buffer = io.BytesIO()
    Image.new("RGB", (18, 12), colour).save(buffer, "PNG")
    return buffer.getvalue()


class ImageGenerationTaskTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.store = ImageGenerationStore(self.root / "data", SEED_PATH)
        self.store.initialize()
        self.media = ImageGenerationMediaStore(self.root)
        self.free_mode_id = next(item["id"] for item in self.store.list_modes() if item["mode_no"] == 1)
        self.required_mode_id = next(item["id"] for item in self.store.list_modes() if item["mode_no"] == 25)
        self.original_store = main.IMAGE_GENERATION_STORE
        self.original_media = main.IMAGE_GENERATION_MEDIA_STORE
        self.original_data_dir = main.DATA_DIR
        self.original_cleanup_job_dir = main.ONE_CLICK_CLEANUP_JOB_DIR
        self.original_cleanup_jobs = main.ONE_CLICK_CLEANUP_JOBS
        self.original_cleanup_wake_event = main.ONE_CLICK_CLEANUP_WAKE_EVENT
        main.IMAGE_GENERATION_STORE = self.store
        main.IMAGE_GENERATION_MEDIA_STORE = self.media
        main.DATA_DIR = str(self.root / "data")
        main.ONE_CLICK_CLEANUP_JOB_DIR = str(self.root / "data" / "cleanup-jobs")
        main.ONE_CLICK_CLEANUP_JOBS = {}
        main.ONE_CLICK_CLEANUP_WAKE_EVENT = None
        self.recycle_patch = patch.object(
            storage_cleanup,
            "move_paths_to_recycle_bin",
            side_effect=lambda paths: [Path(path).unlink() for path in paths],
        )
        self.recycle_patch.start()
        main.IMAGE_GENERATION_RUNTIME_TASKS.clear()
        main.IMAGE_GENERATION_RECOVERY_CANDIDATES.clear()
        main.IMAGE_GENERATION_CLEANUP_CONFIRMATIONS.clear()
        main.IMAGE_GENERATION_HISTORY_CLEARING = False
        for name in (
            "IMAGE_GENERATION_CANDIDATE_TASKS",
            "IMAGE_GENERATION_CANDIDATE_RECOVERY_TASKS",
        ):
            registry = getattr(main, name, None)
            if isinstance(registry, dict):
                registry.clear()
        if hasattr(main, "IMAGE_GENERATION_SEMAPHORE"):
            main.IMAGE_GENERATION_SEMAPHORE = None
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        for name in (
            "IMAGE_GENERATION_CANDIDATE_TASKS",
            "IMAGE_GENERATION_CANDIDATE_RECOVERY_TASKS",
        ):
            registry = getattr(main, name, None)
            if isinstance(registry, dict):
                for job in list(registry.values()):
                    if hasattr(job, "done") and not job.done():
                        job.cancel()
                registry.clear()
        main.IMAGE_GENERATION_RUNTIME_TASKS.clear()
        main.IMAGE_GENERATION_RECOVERY_CANDIDATES.clear()
        main.IMAGE_GENERATION_CLEANUP_CONFIRMATIONS.clear()
        main.IMAGE_GENERATION_HISTORY_CLEARING = False
        main.IMAGE_GENERATION_STORE = self.original_store
        main.IMAGE_GENERATION_MEDIA_STORE = self.original_media
        main.DATA_DIR = self.original_data_dir
        main.ONE_CLICK_CLEANUP_JOB_DIR = self.original_cleanup_job_dir
        main.ONE_CLICK_CLEANUP_JOBS = self.original_cleanup_jobs
        main.ONE_CLICK_CLEANUP_WAKE_EVENT = self.original_cleanup_wake_event
        self.recycle_patch.stop()
        self.temp_dir.cleanup()

    def finish_cleanup(self, response):
        body = response.json()
        self.assertEqual(body["cleanup_status"], "queued")
        job_id = body["cleanup_job_id"]
        self.assertEqual(self.client.get(f"/api/storage-cleanup/jobs/{job_id}").status_code, 200)
        result = main.run_one_click_cleanup_job_once(job_id)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(self.client.get(f"/api/storage-cleanup/jobs/{job_id}").status_code, 404)
        return result

    def payload(self, submission_id=None, **overrides):
        value = {
            "mode_id": self.free_mode_id,
            "images": [],
            "user_prompt": "一只在窗边的小猫",
            "image_provider_id": "mock-image-provider",
            "image_model": "mock-image-model",
            "aspect_ratio": "1:1",
            "resolution": "2k",
            "size": "2048x2048",
            "image_count": 1,
            "submission_id": submission_id or str(uuid.uuid4()),
        }
        value.update(overrides)
        return value

    def media_result(self, colour=(30, 90, 150)):
        adopted = self.media.adopt_bytes(png_bytes(colour), ".png", "image/png")
        return {"images": [adopted["url"]], "task_id": None}

    def wait_for_status(self, task_id, statuses, timeout=3):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            response = self.client.get(f"/api/image-generation-tasks/{task_id}")
            if response.status_code == 200:
                last = response.json()
                if last.get("status") in set(statuses):
                    return last
            time.sleep(0.02)
        self.fail(f"task did not reach {statuses}: {last}")

    def provider(self, *, async_enabled=False, provider_id="mock-image-provider", base_url="https://saved.example/v1"):
        return {
            "id": provider_id,
            "name": "Mock image provider",
            "base_url": base_url,
            "protocol": "openai",
            "image_request_mode": "openai",
            "image_async_enabled": async_enabled,
            "image_task_endpoint": "/v1/images/tasks/{task_id}",
            "image_models": ["mock-image-model"],
            "api_key": "must-never-be-persisted",
        }

    def test_concurrent_same_submission_reuses_one_persisted_task_and_one_paid_call(self):
        calls = 0
        call_lock = threading.Lock()

        async def fake_build(_request, **_kwargs):
            nonlocal calls
            with call_lock:
                calls += 1
            await asyncio.sleep(0.05)
            return self.media_result()

        submission_id = str(uuid.uuid4())
        payload = self.payload(submission_id, image_count=1)
        barrier = threading.Barrier(2)

        def submit():
            async def scenario():
                barrier.wait()
                request = main.Request({"type": "http", "headers": [], "method": "POST", "path": "/api/image-generation-tasks"})
                body = await main.create_image_generation_task(main.ImageGenerationTaskRequest(**payload), request)
                loop = asyncio.get_running_loop()
                owned = [
                    job for job in list(main.IMAGE_GENERATION_CANDIDATE_TASKS.values())
                    if hasattr(job, "get_loop") and job.get_loop() is loop
                ]
                if owned:
                    await asyncio.gather(*owned)
                return body

            return asyncio.run(scenario())

        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "build_online_image_result", side_effect=fake_build
        ):
            with ThreadPoolExecutor(max_workers=2) as pool:
                bodies = list(pool.map(lambda _index: submit(), range(2)))
            self.wait_for_status(bodies[0]["task_id"], {"succeeded"})
            self.assertEqual(len({body["task_id"] for body in bodies}), 1)
            self.assertEqual(sum(bool(body["reused"]) for body in bodies), 1)
            self.assertEqual(next(body for body in bodies if body["reused"])["reuse_reason"], "submission_id")
            self.assertEqual(self.store.load_task(bodies[0]["task_id"])["status"], "succeeded")
        self.assertEqual(calls, 1)

    def test_core_generation_media_mode_writes_only_canonical_media(self):
        payload = main.OnlineImageRequest(
            prompt="一只在窗边的小猫",
            provider_id="mock-image-provider",
            model="mock-image-model",
            aspect_ratio="1:1",
            resolution="2k",
            size="2048x2048",
            quality="auto",
            n=1,
            reference_images=[],
        )
        encoded = base64.b64encode(png_bytes((61, 71, 81))).decode("ascii")

        async def fake_generate(*_args, **_kwargs):
            return {"type": "b64", "value": encoded, "mime_type": "image/png"}, None

        output_root = self.root / "assets" / "output"
        with patch.object(main, "generate_ai_image", side_effect=fake_generate), patch.object(
            main, "save_history_record_with_metadata"
        ), patch.object(main, "ASSETS_DIR", str(self.root / "assets")), patch.object(
            main, "OUTPUT_OUTPUT_DIR", str(output_root)
        ), patch.object(main, "OUTPUT_INPUT_DIR", str(self.root / "assets" / "input")), patch.object(
            main, "OUTPUT_DIR", str(self.root / "output")
        ):
            result = asyncio.run(
                main.build_online_image_result(
                    payload,
                    provider_override=self.provider(),
                    persist_mode="image_generation_media",
                )
            )

        self.assertTrue(result["images"][0].startswith("/assets/image-generation/media/"))
        self.assertEqual(len(list(output_root.glob("online_*.png"))), 0)
        self.assertEqual(len(self.media.list_media_ids()), 1)

    def test_runninghub_core_persistence_mode_uses_cas_without_legacy_output(self):
        class Response:
            is_success = True
            headers = {"content-type": "image/png"}
            content = png_bytes((62, 72, 82))

        class Client:
            async def get(self, *_args, **_kwargs):
                return Response()

        token = main.IMAGE_GENERATION_PERSIST_MODE.set("image_generation_media")
        try:
            url = asyncio.run(
                main.runninghub_store_remote_output(
                    Client(), "https://saved.example/generated.png"
                )
            )
        finally:
            main.IMAGE_GENERATION_PERSIST_MODE.reset(token)

        self.assertTrue(url.startswith("/assets/image-generation/media/"))
        self.assertEqual(list((self.root / "assets" / "output").glob("rh_*.png")), [])

    def test_cleanup_migrates_unreferenced_quarantine_pair_to_recycle_bin(self):
        quarantine = self.media.trash_root / "2026-09-03"
        quarantine.mkdir(parents=True)
        media_id = __import__("hashlib").sha256(png_bytes((91, 101, 111))).hexdigest()
        image_path = quarantine / f"{media_id}.png"
        sidecar = quarantine / f"{media_id}.json"
        image_path.write_bytes(png_bytes((91, 101, 111)))
        sidecar.write_text(
            json.dumps({
                "media_id": media_id,
                "deleted_at": "2026-09-03T09:16:01+00:00",
                "filename": image_path.name,
            }),
            encoding="utf-8",
        )

        preview = self.client.post(
            "/api/image-generation-tasks/cleanup-preview", json={"retention": "all"}
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        confirmation = main.IMAGE_GENERATION_CLEANUP_CONFIRMATIONS[preview.json()["confirmation_id"]]
        self.assertIn(str(image_path), confirmation["quarantine_paths"])
        self.assertIn(str(sidecar), confirmation["quarantine_paths"])

        response = self.client.post(
            "/api/image-generation-tasks/cleanup",
            json={"confirmation_id": preview.json()["confirmation_id"]},
        )
        self.assertEqual(response.status_code, 202, response.text)
        self.finish_cleanup(response)
        self.assertFalse(image_path.exists())
        self.assertFalse(sidecar.exists())

    def test_cleanup_restores_referenced_quarantine_pair_before_recycling(self):
        content = png_bytes((92, 102, 112))
        original = self.media.adopt_bytes(content, ".png", "image/png")
        self.store.save_task({
            "id": "quarantine-keeper", "type": "image-generation",
            "mode_id": self.free_mode_id, "status": "succeeded", "inputs": [],
            "candidates": [{"id": "keeper-result", "status": "succeeded", "image": original}],
        })
        Path(original["path"]).unlink()
        self.media._metadata_path(original["id"]).unlink()
        quarantine = self.media.trash_root / "2026-09-03"
        quarantine.mkdir(parents=True)
        image_path = quarantine / f"{original['id']}.png"
        sidecar = quarantine / f"{original['id']}.json"
        image_path.write_bytes(content)
        sidecar.write_text(json.dumps({
            "media_id": original["id"],
            "deleted_at": "2026-09-03T09:16:01+00:00",
            "filename": image_path.name,
        }), encoding="utf-8")

        job = main.image_generation_cleanup_create_job(
            task_ids=[], media_ids=[], quarantine_media_ids=[original["id"]],
            quarantine_paths=[image_path, sidecar],
        )
        result = main.run_image_generation_media_cleanup_job(job)

        self.assertEqual(result["media_restored"], 1)
        self.assertIsNotNone(self.media.media_record(original["id"]))
        self.assertFalse(image_path.exists())
        self.assertFalse(sidecar.exists())
        self.assertIsNotNone(self.store.load_task("quarantine-keeper", include_admin=True))

    def test_persistence_failure_happens_before_scheduling_or_provider_call(self):
        build = AsyncMock(return_value=self.media_result())
        client = TestClient(main.app, raise_server_exceptions=False)
        try:
            with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
                self.store, "save_task", side_effect=OSError("disk full")
            ), patch.object(main, "build_online_image_result", build):
                response = client.post("/api/image-generation-tasks", json=self.payload())
            self.assertEqual(response.status_code, 500)
            self.assertEqual(build.await_count, 0)
            self.assertEqual(main.IMAGE_GENERATION_RUNTIME_TASKS, {})
        finally:
            client.close()

    def test_active_fingerprint_reuse_force_new_and_terminal_new_task(self):
        first_id = str(uuid.uuid4())
        second_id = str(uuid.uuid4())
        third_id = str(uuid.uuid4())
        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "image_generation_schedule_candidate", return_value=(None, False)
        ):
            first = self.client.post("/api/image-generation-tasks", json=self.payload(first_id)).json()
            active_reuse = self.client.post("/api/image-generation-tasks", json=self.payload(second_id)).json()
            forced = self.client.post("/api/image-generation-tasks", json=self.payload(third_id, force_new=True)).json()
            repeated_forced = self.client.post("/api/image-generation-tasks", json=self.payload(third_id, force_new=True)).json()
            self.assertEqual(active_reuse["task_id"], first["task_id"])
            self.assertEqual(active_reuse["reuse_reason"], "active_config")
            self.assertNotEqual(forced["task_id"], first["task_id"])
            self.assertEqual(repeated_forced["task_id"], forced["task_id"])
            self.assertEqual(repeated_forced["reuse_reason"], "submission_id")
        # A persisted terminal task with the same fingerprint does not block a new group.
        task = self.store.load_task(first["task_id"], include_admin=True)
        task["status"] = "succeeded"
        for candidate in task["candidates"]:
            candidate["status"] = "succeeded"
        self.store.save_task(task)
        main.IMAGE_GENERATION_RUNTIME_TASKS[first["task_id"]] = task
        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "image_generation_schedule_candidate", return_value=(None, False)
        ):
            after_terminal = self.client.post("/api/image-generation-tasks", json=self.payload()).json()
        self.assertNotEqual(after_terminal["task_id"], first["task_id"])

    def test_six_slot_semaphore_caps_generation_across_groups(self):
        active = 0
        maximum = 0
        calls = 0
        state_lock = threading.Lock()

        async def measured(_request, **_kwargs):
            nonlocal active, maximum, calls
            with state_lock:
                active += 1
                calls += 1
                maximum = max(maximum, active)
            await asyncio.sleep(0.06)
            with state_lock:
                active -= 1
            return self.media_result()

        async def scenario():
            request = main.Request({"type": "http", "headers": [], "method": "POST", "path": "/api/image-generation-tasks"})
            first = await main.create_image_generation_task(
                main.ImageGenerationTaskRequest(**self.payload(image_count=6)), request
            )
            second = await main.create_image_generation_task(
                main.ImageGenerationTaskRequest(**self.payload(image_count=6, force_new=True)), request
            )
            jobs = list(main.IMAGE_GENERATION_CANDIDATE_TASKS.values())
            self.assertEqual(len(jobs), 12)
            await asyncio.gather(*jobs)
            return (
                self.store.load_task(first["task_id"]),
                self.store.load_task(second["task_id"]),
            )

        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "build_online_image_result", side_effect=measured
        ):
            first_task, second_task = asyncio.run(scenario())
        self.assertLessEqual(maximum, 6)
        self.assertEqual(maximum, 6)
        self.assertEqual(calls, 12)
        self.assertTrue(all(item["status"] == "succeeded" for item in first_task["candidates"] + second_task["candidates"]))

    def test_validates_mode_version_roles_media_hash_and_preserves_order(self):
        first = self.media.adopt_bytes(png_bytes((1, 2, 3)), ".png", "image/png")
        second = self.media.adopt_bytes(png_bytes((4, 5, 6)), ".png", "image/png")
        images = [
            {"slot_key": "ref1", "role": "ref1", "media_id": first["id"], "url": first["url"], "name": "first"},
            {"slot_key": "extra-1", "role": "extra-1", "media_id": second["id"], "url": second["url"], "name": "second"},
        ]
        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "build_online_image_result", return_value=self.media_result()
        ):
            response = self.client.post(
                "/api/image-generation-tasks",
                json=self.payload(mode_id=self.required_mode_id, images=images),
            )
        self.assertEqual(response.status_code, 200)
        stored = self.store.load_task(response.json()["task_id"], include_admin=True)
        self.assertEqual([item["media"]["id"] for item in stored["inputs"]], [first["id"], second["id"]])
        self.assertEqual([item["order"] for item in stored["inputs"]], [0, 1])
        self.assertEqual(stored["inputs"][0]["role"], "参考图1")
        self.assertEqual(stored["inputs"][1]["role"], "附加参考图1")
        bad_hash = [dict(images[0], media_id="a" * 64)]
        self.assertEqual(
            self.client.post("/api/image-generation-tasks", json=self.payload(mode_id=self.required_mode_id, images=bad_hash)).status_code,
            422,
        )
        self.assertEqual(
            self.client.post("/api/image-generation-tasks", json=self.payload(mode_id=self.required_mode_id, images=[])).status_code,
            422,
        )

    def test_public_routes_recursively_redact_prompts_and_admin_detail_is_protected(self):
        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "build_online_image_result", return_value=self.media_result()
        ):
            created = self.client.post("/api/image-generation-tasks", json=self.payload()).json()
            self.wait_for_status(created["task_id"], {"succeeded"})
        public = self.client.get(f"/api/image-generation-tasks/{created['task_id']}").json()
        listed = self.client.get("/api/image-generation-tasks").json()
        encoded = json.dumps({"public": public, "listed": listed}, ensure_ascii=False)
        for secret_key in ("preset_prompt_snapshot", "final_prompt", "version_prompt", "prompt_snapshot"):
            self.assertNotIn(secret_key, encoded)
        self.assertEqual(self.client.get(f"/api/image-generation/admin/tasks/{created['task_id']}").status_code, 403)
        token = self.client.post("/api/image-generation/admin/unlock", json={"password": "451462"}).json()["token"]
        admin = self.client.get(
            f"/api/image-generation/admin/tasks/{created['task_id']}",
            headers={"X-Image-Generation-Admin": token},
        )
        self.assertEqual(admin.status_code, 200)
        self.assertIn("final_prompt", admin.json())

    def test_async_provider_snapshot_strips_embedded_credentials(self):
        provider = self.provider(
            async_enabled=True,
            base_url="https://user:base-secret@saved.example:8443/v1?api_key=query-secret#fragment",
        )
        provider["image_task_endpoint"] = (
            "https://token:endpoint-secret@query.example/v1/tasks/{task_id}?key=endpoint-query#fragment"
        )
        snapshot = main.detail_page_async_provider_snapshot(provider, "mock-image-model")
        encoded = json.dumps(snapshot)
        for secret in ("user", "base-secret", "query-secret", "token", "endpoint-secret", "endpoint-query"):
            self.assertNotIn(secret, encoded)
        self.assertEqual(snapshot["base_url"], "https://saved.example:8443/v1")
        self.assertEqual(snapshot["image_task_endpoint"], "https://query.example/v1/tasks/{task_id}")

    def test_async_disconnect_states_persist_upstream_before_query_and_never_resubmit(self):
        events = []
        provider_overrides = []

        async def query_disconnect(_request, async_task_observer=None, provider_override=None, **_kwargs):
            provider_overrides.append(provider_override)
            await async_task_observer("submitted", {
                "task_id": "upstream-saved",
                "provider": main.detail_page_async_provider_snapshot(self.provider(async_enabled=True), "mock-image-model"),
                "submitted_at": time.time(),
            })
            persisted = next(iter(main.IMAGE_GENERATION_RUNTIME_TASKS.values()))
            events.append(persisted["candidates"][0]["upstream_task_id"])
            await async_task_observer("recovering", {"attempt": 1, "error": "disconnect", "last_query_at": time.time()})
            raise main.DetailPageAsyncTaskUnknown("timed out", "upstream-saved")

        with patch.object(main, "get_api_provider_exact", return_value=self.provider(async_enabled=True)), patch.object(
            main, "build_online_image_result", side_effect=query_disconnect
        ) as build:
            created = self.client.post("/api/image-generation-tasks", json=self.payload()).json()
            task = self.wait_for_status(created["task_id"], {"unknown"})
        self.assertEqual(events, ["upstream-saved"])
        self.assertEqual(provider_overrides[0]["base_url"], "https://saved.example/v1")
        self.assertTrue(task["candidates"][0]["recoverable"])
        self.assertEqual(
            self.store.load_task(created["task_id"], include_admin=True)["candidates"][0]["upstream_task_id"],
            "upstream-saved",
        )
        self.assertEqual(build.await_count, 1)

        async def submit_disconnect(_request, **_kwargs):
            raise main.httpx.RemoteProtocolError("server disconnected without sending a response")

        with patch.object(main, "get_api_provider_exact", return_value=self.provider(async_enabled=True)), patch.object(
            main, "build_online_image_result", side_effect=submit_disconnect
        ):
            created = self.client.post("/api/image-generation-tasks", json=self.payload(force_new=True)).json()
            task = self.wait_for_status(created["task_id"], {"unknown"})
        self.assertFalse(task["candidates"][0]["recoverable"])
        self.assertFalse(
            self.store.load_task(created["task_id"], include_admin=True)["candidates"][0]["upstream_task_id"]
        )

    def test_explicit_async_failure_and_upstream_id_persistence_failure_do_not_retry(self):
        async def upstream_failure(_request, **_kwargs):
            raise main.DetailPageAsyncTaskFailed("explicit failure", "upstream-failed")

        with patch.object(main, "get_api_provider_exact", return_value=self.provider(async_enabled=True)), patch.object(
            main, "build_online_image_result", side_effect=upstream_failure
        ) as build:
            created = self.client.post("/api/image-generation-tasks", json=self.payload()).json()
            task = self.wait_for_status(created["task_id"], {"failed"})
        self.assertEqual(task["candidates"][0]["status"], "failed")
        self.assertEqual(build.await_count, 1)

        queried = []
        original_save = self.store.save_task

        def fail_upstream_id_save(task):
            if any(item.get("upstream_task_id") == "must-persist-first" for item in task.get("candidates") or []):
                raise OSError("cannot persist upstream id")
            return original_save(task)

        async def observer_contract(_request, async_task_observer=None, **_kwargs):
            await async_task_observer("submitted", {"task_id": "must-persist-first"})
            queried.append(True)
            return self.media_result()

        with patch.object(main, "get_api_provider_exact", return_value=self.provider(async_enabled=True)), patch.object(
            self.store, "save_task", side_effect=fail_upstream_id_save
        ), patch.object(main, "build_online_image_result", side_effect=observer_contract) as build:
            created = self.client.post("/api/image-generation-tasks", json=self.payload(force_new=True)).json()
            self.wait_for_status(created["task_id"], {"failed"})
        self.assertEqual(queried, [])
        self.assertEqual(build.await_count, 1)

    def test_admin_draft_version_is_owned_protected_and_prompt_is_composed_once(self):
        draft = self.store.save_prompt_draft(self.free_mode_id, "管理员草稿提示词")
        submission_id = str(uuid.uuid4())
        payload = self.payload(submission_id, prompt_version_id=draft["id"])
        self.assertEqual(self.client.post("/api/image-generation-tasks", json=payload).status_code, 403)
        token = self.client.post("/api/image-generation/admin/unlock", json={"password": "451462"}).json()["token"]
        headers = {"X-Image-Generation-Admin": token}
        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "image_generation_schedule_candidate", return_value=(None, False)
        ), patch.object(main, "compose_final_prompt", wraps=main.compose_final_prompt) as compose:
            first = self.client.post("/api/image-generation-tasks", json=payload, headers=headers)
            repeated = self.client.post("/api/image-generation-tasks", json={**payload, "mode_id": "does-not-exist"})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(repeated.status_code, 200)
        self.assertEqual(repeated.json()["task_id"], first.json()["task_id"])
        self.assertEqual(repeated.json()["reuse_reason"], "submission_id")
        self.assertEqual(compose.call_count, 1)
        stored = self.store.load_task(first.json()["task_id"], include_admin=True)
        self.assertEqual(stored["preset_prompt_snapshot"], "管理员草稿提示词")
        self.assertTrue(stored["final_prompt"].startswith("管理员草稿提示词"))

    def test_restart_and_recover_only_query_saved_provider_snapshot(self):
        provider_snapshot = main.detail_page_async_provider_snapshot(
            self.provider(async_enabled=True, base_url="https://original.example/v1"), "mock-image-model"
        )
        task_id = "image_generation_restart_test"
        candidate_id = "candidate_restart"
        task = {
            "id": task_id,
            "type": "image-generation",
            "mode_id": self.free_mode_id,
            "mode_no": 1,
            "mode_name": "free",
            "status": "recovering",
            "inputs": [],
            "final_prompt": "hidden",
            "candidates": [{
                "id": candidate_id,
                "status": "recovering",
                "upstream_task_id": "upstream-restart",
                "provider_snapshot": provider_snapshot,
                "generation_params": {"image_provider_id": "mock-image-provider", "image_model": "mock-image-model"},
            }],
        }
        self.store.save_task(task)
        seen = []

        async def fake_wait(_client, upstream_id, provider, _observer=None, **_kwargs):
            seen.append((upstream_id, provider["base_url"]))
            return {"data": {"status": "SUCCESS", "data": [{"url": "https://result.example/a.png"}]}}

        async def scenario():
            main.load_persisted_image_generation_tasks()
            with patch.object(main, "wait_for_detail_page_image_task", side_effect=fake_wait), patch.object(
                main, "detail_page_result_from_async_payload", AsyncMock(return_value=self.media_result())
            ):
                self.assertEqual(main.schedule_image_generation_candidate_recoveries(), 1)
                jobs = list(main.IMAGE_GENERATION_CANDIDATE_RECOVERY_TASKS.values())
                await asyncio.gather(*jobs)

        asyncio.run(scenario())
        self.assertEqual(seen, [("upstream-restart", "https://original.example/v1")])
        self.assertEqual(self.store.load_task(task_id)["status"], "succeeded")

    def test_restart_normalizes_only_saved_ids_to_recovering_and_never_resubmits(self):
        provider_snapshot = main.detail_page_async_provider_snapshot(
            self.provider(async_enabled=True), "mock-image-model"
        )
        task_id = "image_generation_restart_normalize"
        self.store.save_task({
            "id": task_id, "type": "image-generation", "mode_id": self.free_mode_id,
            "status": "generating", "candidates": [
                {"id": "with-id", "status": "generating", "upstream_task_id": "saved-id", "provider_snapshot": provider_snapshot},
                {"id": "without-id", "status": "submitting", "upstream_task_id": "", "provider_snapshot": provider_snapshot},
                {"id": "never-submitted", "status": "queued", "upstream_task_id": "", "provider_snapshot": {}},
            ],
        })
        main.load_persisted_image_generation_tasks()
        restored = self.store.load_task(task_id, include_admin=True)
        by_id = {item["id"]: item for item in restored["candidates"]}
        self.assertEqual(by_id["with-id"]["status"], "recovering")
        self.assertEqual(by_id["without-id"]["status"], "unknown")
        self.assertEqual(by_id["never-submitted"]["status"], "cancelled")
        self.assertEqual(main.schedule_image_generation_candidate_recoveries(), 1)
        self.assertEqual(set(main.IMAGE_GENERATION_RECOVERY_CANDIDATES), {f"{task_id}:with-id"})

    def test_recover_endpoint_deduplicates_query_work(self):
        provider_snapshot = main.detail_page_async_provider_snapshot(
            self.provider(async_enabled=True), "mock-image-model"
        )
        task_id = "image_generation_recover_dedup"
        candidate_id = "candidate-recover"
        task = {
            "id": task_id, "type": "image-generation", "mode_id": self.free_mode_id,
            "status": "unknown", "cancel_requested": False,
            "candidates": [{
                "id": candidate_id, "status": "unknown", "upstream_task_id": "saved-upstream",
                "provider_snapshot": provider_snapshot, "error": "unknown",
            }],
        }
        self.store.save_task(task)
        main.IMAGE_GENERATION_RUNTIME_TASKS[task_id] = task

        async def delayed_query(*_args, **_kwargs):
            await asyncio.sleep(0.15)
            return {"data": {"status": "SUCCESS", "data": [{"url": "https://result.example/a.png"}]}}

        async def scenario():
            first = await main.recover_image_generation_candidate(task_id, candidate_id)
            second = await main.recover_image_generation_candidate(task_id, candidate_id)
            self.assertFalse(first["reused"])
            self.assertTrue(second["reused"])
            await asyncio.gather(*list(main.IMAGE_GENERATION_CANDIDATE_RECOVERY_TASKS.values()))

        with patch.object(main, "wait_for_detail_page_image_task", side_effect=delayed_query) as query, patch.object(
            main, "detail_page_result_from_async_payload", AsyncMock(return_value=self.media_result())
        ):
            asyncio.run(scenario())
            self.assertEqual(self.store.load_task(task_id)["status"], "succeeded")
        self.assertEqual(query.await_count, 1)

    def test_cancel_recover_dedup_and_regenerate_cost_confirmation(self):
        release = asyncio.Event()

        async def long_running(_request, async_task_observer=None, **_kwargs):
            if async_task_observer:
                await async_task_observer("submitted", {
                    "task_id": "upstream-cancel",
                    "provider": main.detail_page_async_provider_snapshot(self.provider(async_enabled=True), "mock-image-model"),
                })
            await release.wait()
            return self.media_result()

        with patch.object(main, "get_api_provider_exact", return_value=self.provider(async_enabled=True)), patch.object(
            main, "build_online_image_result", side_effect=long_running
        ):
            created = self.client.post("/api/image-generation-tasks", json=self.payload()).json()
            deadline = time.time() + 2
            while time.time() < deadline:
                task = self.client.get(f"/api/image-generation-tasks/{created['task_id']}").json()
                if task["candidates"][0].get("upstream_task_id"):
                    break
                time.sleep(0.02)
            cancelled = self.client.post(f"/api/image-generation-tasks/{created['task_id']}/cancel").json()
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertIn("上游", cancelled["error_summary"])

        # Regeneration is a new candidate and cannot overwrite the cancelled one.
        self.assertEqual(
            self.client.post(
                f"/api/image-generation-tasks/{created['task_id']}/candidates/{cancelled['candidates'][0]['id']}/regenerate",
                json={"confirm_cost": False, "submission_id": str(uuid.uuid4())},
            ).status_code,
            409,
        )
        with patch.object(main, "build_online_image_result", AsyncMock(return_value=self.media_result((9, 9, 9)))):
            regenerated = self.client.post(
                f"/api/image-generation-tasks/{created['task_id']}/candidates/{cancelled['candidates'][0]['id']}/regenerate",
                json={"confirm_cost": True, "submission_id": str(uuid.uuid4())},
            )
            self.assertEqual(regenerated.status_code, 200)
            self.assertEqual(len(regenerated.json()["task"]["candidates"]), 2)

    def test_rename_download_and_delete_use_safe_paths_and_conservative_reconciliation(self):
        result = self.media_result()
        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "build_online_image_result", return_value=result
        ):
            created = self.client.post("/api/image-generation-tasks", json=self.payload()).json()
            self.wait_for_status(created["task_id"], {"succeeded"})
        internal = self.store.load_task(created["task_id"], include_admin=True)
        pinned_media = internal["candidates"][0]["image"]
        self.store.save_example(self.free_mode_id, {
            "input_media": [], "output_media": pinned_media, "source_task_id": created["task_id"],
        })
        renamed = self.client.patch(
            f"/api/image-generation-tasks/{created['task_id']}", json={"name": "../unsafe\nname"}
        )
        self.assertEqual(renamed.status_code, 200)
        self.assertNotIn("..", renamed.json()["name"])
        with patch.object(main, "detail_page_download_bytes", side_effect=AssertionError("ZIP must not fetch URLs")) as download:
            archive = self.client.get(f"/api/image-generation-tasks/{created['task_id']}/download.zip")
        self.assertEqual(archive.status_code, 200)
        with zipfile.ZipFile(io.BytesIO(archive.content)) as zipped:
            self.assertTrue(zipped.namelist())
            self.assertTrue(all(".." not in name and not name.startswith(("/", "\\")) for name in zipped.namelist()))
        download.assert_not_called()
        deleted = self.client.delete(f"/api/image-generation-tasks/{created['task_id']}")
        self.assertEqual(deleted.status_code, 202)
        self.assertIsNone(self.store.load_task(created["task_id"], include_admin=True))
        self.finish_cleanup(deleted)
        self.assertIsNotNone(self.media.media_record(pinned_media["id"]))

    def test_delete_group_returns_before_cleanup_and_recycles_unreferenced_input_and_output(self):
        input_media = self.media.adopt_bytes(png_bytes((12, 22, 32)), ".png", "image/png")
        output_media = self.media.adopt_bytes(png_bytes((42, 52, 62)), ".png", "image/png")
        self.store.save_task({
            "id": "delete-group-background-cleanup", "type": "image-generation",
            "mode_id": self.free_mode_id, "status": "succeeded",
            "inputs": [{"slot_key": "extra-1", "media": input_media}],
            "candidates": [{"id": "result", "status": "succeeded", "image": output_media}],
        })

        with patch.object(
            main,
            "run_image_generation_media_cleanup_job",
            side_effect=AssertionError("删除接口不得同步执行图片清理"),
        ):
            response = self.client.delete(
                "/api/image-generation-tasks/delete-group-background-cleanup"
            )

        self.assertEqual(response.status_code, 202, response.text)
        self.assertIsNone(self.store.load_task("delete-group-background-cleanup", include_admin=True))
        self.assertIsNotNone(self.media.media_record(input_media["id"]))
        self.assertIsNotNone(self.media.media_record(output_media["id"]))
        self.finish_cleanup(response)
        self.assertIsNone(self.media.media_record(input_media["id"]))
        self.assertIsNone(self.media.media_record(output_media["id"]))

    def test_delete_group_preserves_input_and_output_shared_by_another_group(self):
        shared_input = self.media.adopt_bytes(png_bytes((13, 23, 33)), ".png", "image/png")
        shared_output = self.media.adopt_bytes(png_bytes((43, 53, 63)), ".png", "image/png")
        for task_id in ("shared-group-a1", "shared-group-a2"):
            self.store.save_task({
                "id": task_id, "type": "image-generation", "mode_id": self.free_mode_id,
                "status": "succeeded",
                "inputs": [{"slot_key": "extra-1", "media": shared_input}],
                "candidates": [{"id": f"{task_id}-result", "status": "succeeded", "image": shared_output}],
            })

        first = self.client.delete("/api/image-generation-tasks/shared-group-a1")
        self.assertEqual(first.status_code, 202, first.text)
        self.finish_cleanup(first)
        self.assertIsNotNone(self.media.media_record(shared_input["id"]))
        self.assertIsNotNone(self.media.media_record(shared_output["id"]))

        second = self.client.delete("/api/image-generation-tasks/shared-group-a2")
        self.assertEqual(second.status_code, 202, second.text)
        self.finish_cleanup(second)
        self.assertIsNone(self.media.media_record(shared_input["id"]))
        self.assertIsNone(self.media.media_record(shared_output["id"]))

    def test_delete_candidate_preserves_the_task_and_other_results(self):
        colours = iter(((30, 90, 150), (31, 91, 151)))
        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "build_online_image_result", side_effect=lambda *_args, **_kwargs: self.media_result(next(colours))
        ):
            created = self.client.post(
                "/api/image-generation-tasks", json=self.payload(image_count=2)
            ).json()
            completed = self.wait_for_status(created["task_id"], {"succeeded"})
        first_id = completed["candidates"][0]["id"]
        second_id = completed["candidates"][1]["id"]
        first_media_id = completed["candidates"][0]["image"]["id"]
        deleted = self.client.delete(
            f"/api/image-generation-tasks/{created['task_id']}/candidates/{first_id}"
        )
        self.assertEqual(deleted.status_code, 202)
        self.assertTrue(deleted.json()["deleted"])
        task = self.store.load_task(created["task_id"], include_admin=True)
        self.assertIsNotNone(task)
        self.assertEqual(task["candidate_count"], 1)
        self.assertEqual(task["successful_candidate_count"], 1)
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual([item["id"] for item in task["candidates"]], [second_id])
        self.assertIsNotNone(self.media.media_record(first_media_id))
        self.finish_cleanup(deleted)
        self.assertIsNone(self.media.media_record(first_media_id))
        self.assertEqual(
            self.client.delete(
                f"/api/image-generation-tasks/{created['task_id']}/candidates/{first_id}"
            ).status_code,
            404,
        )

    def test_delete_legacy_output_candidate_moves_only_unreferenced_file(self):
        assets = self.root / "assets"
        output_root = assets / "output"
        input_root = assets / "input"
        output_root.mkdir(parents=True)
        input_root.mkdir(parents=True)
        first_path = output_root / "online_legacy_first.png"
        second_path = output_root / "online_legacy_second.png"
        input_path = input_root / "legacy-upload.png"
        first_path.write_bytes(png_bytes((17, 27, 37)))
        second_path.write_bytes(png_bytes((47, 57, 67)))
        input_path.write_bytes(png_bytes((77, 87, 97)))
        with patch.object(main, "ASSETS_DIR", str(assets)), patch.object(
            main, "OUTPUT_OUTPUT_DIR", str(output_root)
        ), patch.object(main, "OUTPUT_INPUT_DIR", str(input_root)), patch.object(
            main, "OUTPUT_DIR", str(self.root / "output")
        ), patch.object(main, "HISTORY_FILE", str(self.root / "history.json")), patch.object(
            main, "GLOBAL_CONFIG_FILE", str(self.root / "global_config.json")
        ):
            task_id = "legacy-candidate-delete"
            self.store.save_task({
                "id": task_id, "type": "image-generation", "mode_id": self.free_mode_id,
                "status": "succeeded",
                "inputs": [{"slot_key": "extra-1", "media": {"url": "/assets/input/legacy-upload.png"}}],
                "candidates": [
                    {"id": "legacy-first", "status": "succeeded", "upstream_task_id": "upstream-legacy-first", "image": {"url": "/assets/output/online_legacy_first.png"}},
                    {"id": "legacy-second", "status": "succeeded", "image": {"url": "/assets/output/online_legacy_second.png"}},
                ],
            })
            (self.root / "history.json").write_text(json.dumps([
                {
                    "task_id": "upstream-legacy-first",
                    "images": ["/assets/output/online_legacy_first.png"],
                },
                {"type": "online", "images": ["/assets/output/online_legacy_second.png"]},
            ]), encoding="utf-8")
            response = self.client.delete(
                f"/api/image-generation-tasks/{task_id}/candidates/legacy-first"
            )
            self.assertEqual(response.status_code, 202, response.text)
            self.assertEqual(response.json()["history_deleted"], 1)
            remaining_history = json.loads((self.root / "history.json").read_text(encoding="utf-8"))
            self.assertEqual(len(remaining_history), 1)
            self.assertEqual(remaining_history[0]["images"], ["/assets/output/online_legacy_second.png"])
            self.assertTrue(first_path.is_file())
            self.assertTrue(second_path.is_file())
            self.finish_cleanup(response)
        self.assertFalse(first_path.exists())
        self.assertTrue(second_path.is_file())
        self.assertTrue(input_path.is_file())

    def test_image_generation_history_metadata_is_owned_by_candidate(self):
        task_id = "history-owned-task"
        candidate_id = "history-owned-candidate"
        task = {
            "id": task_id, "type": "image-generation", "mode_id": self.free_mode_id,
            "status": "generating", "candidates": [{"id": candidate_id, "status": "generating"}],
        }
        self.store.save_task(task)
        with patch.object(main, "HISTORY_FILE", str(self.root / "history.json")):
            record = {"type": "online", "images": []}
            main.save_history_record_with_metadata(record, {
                "source_type": "image-generation",
                "source_task_id": task_id,
                "source_candidate_id": candidate_id,
            })
            saved = json.loads((self.root / "history.json").read_text(encoding="utf-8"))
            self.assertEqual(saved[0]["source_type"], "image-generation")
            self.assertEqual(saved[0]["source_candidate_id"], candidate_id)
            self.assertEqual(
                main.delete_image_generation_history_rows_locked(
                    [task_id], {task_id: {candidate_id}}, {task_id: task}
                ),
                1,
            )
            self.assertEqual(json.loads((self.root / "history.json").read_text(encoding="utf-8")), [])

    def test_delete_legacy_group_preserves_shared_paths_until_last_group(self):
        assets = self.root / "assets"
        output_root = assets / "output"
        input_root = assets / "input"
        output_root.mkdir(parents=True)
        input_root.mkdir(parents=True)
        shared_output = output_root / "online_shared_legacy.png"
        shared_input = input_root / "shared-legacy-upload.png"
        shared_output.write_bytes(png_bytes((21, 31, 41)))
        shared_input.write_bytes(png_bytes((51, 61, 71)))
        with patch.object(main, "ASSETS_DIR", str(assets)), patch.object(
            main, "OUTPUT_OUTPUT_DIR", str(output_root)
        ), patch.object(main, "OUTPUT_INPUT_DIR", str(input_root)), patch.object(
            main, "OUTPUT_DIR", str(self.root / "output")
        ), patch.object(main, "HISTORY_FILE", str(self.root / "history.json")), patch.object(
            main, "GLOBAL_CONFIG_FILE", str(self.root / "global_config.json")
        ):
            for task_id in ("legacy-group-a1", "legacy-group-a2"):
                self.store.save_task({
                    "id": task_id, "type": "image-generation", "mode_id": self.free_mode_id,
                    "status": "succeeded",
                    "inputs": [{"slot_key": "extra-1", "media": {"url": "/assets/input/shared-legacy-upload.png"}}],
                    "candidates": [{"id": f"{task_id}-result", "status": "succeeded", "image": {"url": "/assets/output/online_shared_legacy.png"}}],
                })
            first = self.client.delete("/api/image-generation-tasks/legacy-group-a1")
            self.assertEqual(first.status_code, 202, first.text)
            self.finish_cleanup(first)
            self.assertTrue(shared_output.is_file())
            self.assertTrue(shared_input.is_file())
            second = self.client.delete("/api/image-generation-tasks/legacy-group-a2")
            self.assertEqual(second.status_code, 202, second.text)
            self.finish_cleanup(second)
        self.assertFalse(shared_output.exists())
        self.assertFalse(shared_input.exists())

    def test_data_cleanup_discovers_orphan_legacy_online_output(self):
        assets = self.root / "assets"
        output_root = assets / "output"
        output_root.mkdir(parents=True)
        orphan = output_root / "online_orphan_legacy.png"
        orphan.write_bytes(png_bytes((81, 91, 101)))
        with patch.object(main, "ASSETS_DIR", str(assets)), patch.object(
            main, "OUTPUT_OUTPUT_DIR", str(output_root)
        ), patch.object(main, "OUTPUT_INPUT_DIR", str(assets / "input")), patch.object(
            main, "OUTPUT_DIR", str(self.root / "output")
        ), patch.object(main, "HISTORY_FILE", str(self.root / "history.json")), patch.object(
            main, "GLOBAL_CONFIG_FILE", str(self.root / "global_config.json")
        ):
            preview = self.client.post(
                "/api/image-generation-tasks/cleanup-preview", json={"retention": "all"}
            )
            self.assertEqual(preview.status_code, 200, preview.text)
            confirmation_id = preview.json()["confirmation_id"]
            self.assertTrue(preview.json()["has_targets"])
            cleanup_record = main.IMAGE_GENERATION_CLEANUP_CONFIRMATIONS[confirmation_id]
            self.assertIn(str(orphan), cleanup_record["orphan_media_paths"])
            response = self.client.post(
                "/api/image-generation-tasks/cleanup",
                json={"confirmation_id": confirmation_id},
            )
            self.assertEqual(response.status_code, 202, response.text)
            self.finish_cleanup(response)
        self.assertFalse(orphan.exists())

    def test_delete_last_failed_candidate_removes_empty_task_and_preserves_inputs(self):
        input_media = self.media.adopt_bytes(png_bytes((23, 33, 43)), ".png", "image/png")
        self.store.save_task({
            "id": "failed-candidate-delete", "type": "image-generation",
            "mode_id": self.free_mode_id, "status": "failed",
            "inputs": [{"slot_key": "extra-1", "media": input_media}],
            "candidates": [{
                "id": "failed-candidate", "status": "failed",
                "error": "上游额度不足",
            }],
            "candidate_count": 1, "successful_candidate_count": 0,
            "error_summary": "上游额度不足",
        })

        response = self.client.post(
            "/api/image-generation-tasks/candidates/delete",
            json={"items": [{
                "task_id": "failed-candidate-delete", "candidate_id": "failed-candidate",
            }]},
        )

        self.assertEqual(response.status_code, 202, response.text)
        self.assertIsNone(self.store.load_task("failed-candidate-delete", include_admin=True))
        self.assertEqual(response.json()["deleted_task_ids"], ["failed-candidate-delete"])
        self.finish_cleanup(response)
        self.assertIsNotNone(self.media.media_record(input_media["id"]))

    def test_batch_delete_candidates_saves_each_task_once_and_reconciles_media_once(self):
        input_media = self.media.adopt_bytes(png_bytes((11, 21, 31)), ".png", "image/png")
        output_a = self.media.adopt_bytes(png_bytes((41, 51, 61)), ".png", "image/png")
        output_b = self.media.adopt_bytes(png_bytes((71, 81, 91)), ".png", "image/png")
        pinned_output = self.media.adopt_bytes(png_bytes((101, 111, 121)), ".png", "image/png")
        unrelated_upload = self.media.adopt_bytes(png_bytes((131, 141, 151)), ".png", "image/png")
        self.store.save_example(self.free_mode_id, {
            "input_media": [], "output_media": pinned_output,
        })
        self.store.save_task({
            "id": "batch-task-a", "type": "image-generation", "mode_id": self.free_mode_id,
            "status": "succeeded", "inputs": [{"slot_key": "extra-1", "media": input_media}],
            "candidates": [
                {"id": "candidate-a", "status": "succeeded", "image": output_a},
                {"id": "candidate-pinned", "status": "succeeded", "image": pinned_output},
            ],
            "candidate_count": 2, "successful_candidate_count": 2,
        })
        self.store.save_task({
            "id": "batch-task-b", "type": "image-generation", "mode_id": self.free_mode_id,
            "status": "succeeded", "inputs": [],
            "candidates": [{"id": "candidate-b", "status": "succeeded", "image": output_b}],
            "candidate_count": 1, "successful_candidate_count": 1,
        })
        payload = {"items": [
            {"task_id": "batch-task-a", "candidate_id": "candidate-a"},
            {"task_id": "batch-task-a", "candidate_id": "candidate-pinned"},
            {"task_id": "batch-task-b", "candidate_id": "candidate-b"},
        ]}
        with patch.object(self.store, "delete_task", wraps=self.store.delete_task) as delete_task:
            response = self.client.post("/api/image-generation-tasks/candidates/delete", json=payload)
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["deleted"], 3)
        self.assertEqual(response.json()["tasks"], [])
        self.assertEqual(set(response.json()["deleted_task_ids"]), {"batch-task-a", "batch-task-b"})
        self.assertEqual(delete_task.call_count, 2)
        for task_id in ("batch-task-a", "batch-task-b"):
            self.assertIsNone(self.store.load_task(task_id, include_admin=True))
        self.assertIsNotNone(self.media.media_record(input_media["id"]))
        self.assertIsNotNone(self.media.media_record(pinned_output["id"]))
        self.assertIsNotNone(self.media.media_record(unrelated_upload["id"]))
        self.assertIsNotNone(self.media.media_record(output_a["id"]))
        self.assertIsNotNone(self.media.media_record(output_b["id"]))
        self.finish_cleanup(response)
        self.assertIsNotNone(self.media.media_record(input_media["id"]))
        self.assertIsNotNone(self.media.media_record(pinned_output["id"]))
        self.assertIsNotNone(self.media.media_record(unrelated_upload["id"]))
        self.assertIsNone(self.media.media_record(output_a["id"]))
        self.assertIsNone(self.media.media_record(output_b["id"]))

    def test_batch_delete_validates_every_candidate_before_mutating(self):
        output_media = self.media.adopt_bytes(png_bytes((17, 27, 37)), ".png", "image/png")
        self.store.save_task({
            "id": "batch-validate", "type": "image-generation", "mode_id": self.free_mode_id,
            "status": "succeeded", "inputs": [],
            "candidates": [{"id": "candidate-valid", "status": "succeeded", "image": output_media}],
            "candidate_count": 1, "successful_candidate_count": 1,
        })
        response = self.client.post("/api/image-generation-tasks/candidates/delete", json={"items": [
            {"task_id": "batch-validate", "candidate_id": "candidate-valid"},
            {"task_id": "batch-validate", "candidate_id": "candidate-missing"},
        ]})
        self.assertEqual(response.status_code, 404)
        task = self.store.load_task("batch-validate", include_admin=True)
        self.assertEqual([item["id"] for item in task["candidates"]], ["candidate-valid"])
        self.assertIsNotNone(self.media.media_record(output_media["id"]))
        self.assertEqual(main.ONE_CLICK_CLEANUP_JOBS, {})

    def test_batch_delete_rolls_back_earlier_task_when_a_later_save_fails(self):
        outputs = [
            self.media.adopt_bytes(png_bytes(colour), ".png", "image/png")
            for colour in ((19, 29, 39), (49, 59, 69))
        ]
        survivors = [
            self.media.adopt_bytes(png_bytes(colour), ".png", "image/png")
            for colour in ((20, 30, 40), (50, 60, 70))
        ]
        for suffix, output, survivor in zip(("a", "b"), outputs, survivors):
            self.store.save_task({
                "id": f"batch-rollback-{suffix}", "type": "image-generation",
                "mode_id": self.free_mode_id, "status": "succeeded", "inputs": [],
                "candidates": [
                    {"id": f"candidate-{suffix}", "status": "succeeded", "image": output},
                    {"id": f"survivor-{suffix}", "status": "succeeded", "image": survivor},
                ],
                "candidate_count": 2, "successful_candidate_count": 2,
            })
        original_save = self.store.save_task
        failed_once = {"value": False}

        def fail_later_task_once(task):
            if task["id"] == "batch-rollback-b" and not failed_once["value"]:
                failed_once["value"] = True
                raise OSError("simulated batch save failure")
            return original_save(task)

        client = TestClient(main.app, raise_server_exceptions=False)
        try:
            with patch.object(self.store, "save_task", side_effect=fail_later_task_once):
                response = client.post("/api/image-generation-tasks/candidates/delete", json={"items": [
                    {"task_id": "batch-rollback-a", "candidate_id": "candidate-a"},
                    {"task_id": "batch-rollback-b", "candidate_id": "candidate-b"},
                ]})
            self.assertEqual(response.status_code, 500)
            self.assertEqual(main.ONE_CLICK_CLEANUP_JOBS, {})
        finally:
            client.close()
        for suffix, output in zip(("a", "b"), outputs):
            task = self.store.load_task(f"batch-rollback-{suffix}", include_admin=True)
            self.assertEqual(
                [item["id"] for item in task["candidates"]],
                [f"candidate-{suffix}", f"survivor-{suffix}"],
            )
            self.assertIsNotNone(self.media.media_record(output["id"]))

    def test_deleting_last_candidate_removes_task_and_disables_archive(self):
        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "build_online_image_result", return_value=self.media_result()
        ):
            created = self.client.post("/api/image-generation-tasks", json=self.payload()).json()
            completed = self.wait_for_status(created["task_id"], {"succeeded"})
        candidate_id = completed["candidates"][0]["id"]
        deleted = self.client.delete(
            f"/api/image-generation-tasks/{created['task_id']}/candidates/{candidate_id}"
        )
        self.assertEqual(deleted.status_code, 202, deleted.text)
        self.assertIsNone(self.store.load_task(created["task_id"], include_admin=True))
        self.assertNotIn(
            created["task_id"],
            {item["id"] for item in self.client.get("/api/image-generation-tasks").json()["items"]},
        )
        archive = self.client.get(f"/api/image-generation-tasks/{created['task_id']}/download.zip")
        self.assertEqual(archive.status_code, 404)
        self.finish_cleanup(deleted)

    def cleanup_confirmation(self, retention="all"):
        preview = self.client.post(
            "/api/image-generation-tasks/cleanup-preview", json={"retention": retention}
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertTrue(preview.json()["has_targets"])
        return preview.json()

    def test_legacy_clear_history_endpoint_is_disabled_without_deleting(self):
        self.store.save_task({
            "id": "legacy-clear-protected", "type": "image-generation",
            "mode_id": self.free_mode_id, "status": "failed", "candidates": [],
        })
        response = self.client.delete("/api/image-generation-tasks")
        self.assertEqual(response.status_code, 410)
        self.assertIsNotNone(self.store.load_task("legacy-clear-protected", include_admin=True))

    def test_cleanup_all_deletes_records_then_recycles_unreferenced_media(self):
        input_media = self.media.adopt_bytes(png_bytes((1, 2, 3)), ".png", "image/png")
        output_media = self.media.adopt_bytes(png_bytes((4, 5, 6)), ".png", "image/png")
        pinned_output = self.media.adopt_bytes(png_bytes((7, 8, 9)), ".png", "image/png")
        orphan_upload = self.media.adopt_bytes(png_bytes((10, 11, 12)), ".png", "image/png")
        self.store.save_workspace_draft(self.free_mode_id, {
            "inputs": [{"slot_key": "extra-1", "media": input_media}],
            "user_prompt": "保留草稿",
            "generation_settings": {
                "image_provider_id": "saved-provider", "image_model": "saved-model",
                "aspect_ratio": "3:4", "resolution": "2k", "image_count": 2,
            },
        })
        self.store.save_example(self.free_mode_id, {
            "input_media": [], "output_media": pinned_output,
        })
        for index, output in enumerate((output_media, pinned_output), 1):
            self.store.save_task({
                "id": f"clear-task-{index}", "type": "image-generation",
                "mode_id": self.free_mode_id, "status": "succeeded",
                "inputs": [{"slot_key": "extra-1", "media": input_media}],
                "candidates": [{"id": f"candidate-{index}", "status": "succeeded", "image": output}],
                "candidate_count": 1, "successful_candidate_count": 1,
            })

        preview = self.cleanup_confirmation("all")
        response = self.client.post(
            "/api/image-generation-tasks/cleanup",
            json={"confirmation_id": preview["confirmation_id"]},
        )
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["deleted_task_count"], 2)
        self.assertEqual(self.store.list_task_summaries(), [])
        draft = self.store.load_workspace_draft(self.free_mode_id)
        self.assertEqual(draft["user_prompt"], "保留草稿")
        self.assertEqual(draft["generation_settings"]["image_provider_id"], "saved-provider")
        self.assertEqual(draft["generation_settings"]["aspect_ratio"], "3:4")
        self.assertIsNotNone(self.media.media_record(input_media["id"]))
        self.assertIsNotNone(self.media.media_record(pinned_output["id"]))
        self.assertIsNotNone(self.media.media_record(output_media["id"]))
        self.assertIsNotNone(self.media.media_record(orphan_upload["id"]))
        self.finish_cleanup(response)
        self.assertIsNone(self.media.media_record(output_media["id"]))
        self.assertIsNone(self.media.media_record(orphan_upload["id"]))
        self.assertFalse(any(self.media.trash_root.rglob("*")) if self.media.trash_root.exists() else False)

    def test_cleanup_seven_days_uses_frozen_cutoff_and_confirmation_is_one_time(self):
        now = time.time()
        for task_id, updated_at in (("old-task", now - 8 * 86400), ("recent-task", now - 6 * 86400)):
            self.store.save_task({
                "id": task_id, "type": "image-generation", "mode_id": self.free_mode_id,
                "status": "failed", "candidates": [], "created_at": updated_at,
                "updated_at": updated_at,
            })
        preview = self.cleanup_confirmation("7d")
        self.assertIsNotNone(preview["cutoff_at"])
        first = self.client.post(
            "/api/image-generation-tasks/cleanup",
            json={"confirmation_id": preview["confirmation_id"]},
        )
        self.assertEqual(first.status_code, 202, first.text)
        self.assertIsNone(self.store.load_task("old-task", include_admin=True))
        self.assertIsNotNone(self.store.load_task("recent-task", include_admin=True))
        replay = self.client.post(
            "/api/image-generation-tasks/cleanup",
            json={"confirmation_id": preview["confirmation_id"]},
        )
        self.assertEqual(replay.status_code, 409)

    def test_cleanup_all_scans_beyond_the_two_hundred_summary_page(self):
        for index in range(205):
            self.store.save_task({
                "id": f"bulk-cleanup-{index}", "type": "image-generation",
                "mode_id": self.free_mode_id, "status": "failed", "candidates": [],
                "group_no": index + 1,
            })
        self.assertEqual(len(self.store.list_task_summaries(limit=200)), 200)
        preview = self.cleanup_confirmation("all")
        response = self.client.post(
            "/api/image-generation-tasks/cleanup",
            json={"confirmation_id": preview["confirmation_id"]},
        )
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["deleted_task_count"], 205)
        self.assertEqual(self.store.list_task_summaries(), [])

    def test_terminal_cleanup_deletes_only_failed_and_deleted_records(self):
        failed_media = self.media.adopt_bytes(png_bytes((91, 92, 93)), ".png", "image/png")
        deleted_media = self.media.adopt_bytes(png_bytes((94, 95, 96)), ".png", "image/png")
        succeeded_media = self.media.adopt_bytes(png_bytes((97, 98, 99)), ".png", "image/png")
        for task in (
            {
                "id": "terminal-failed", "type": "image-generation",
                "mode_id": self.free_mode_id, "status": "failed",
                "candidate_count": 1, "successful_candidate_count": 0,
                "candidates": [{"id": "failed", "status": "failed", "image": failed_media}],
            },
            {
                "id": "terminal-deleted", "type": "image-generation",
                "mode_id": self.free_mode_id, "status": "succeeded", "results_deleted": True,
                "candidate_count": 1, "successful_candidate_count": 1,
                "candidates": [{"id": "deleted", "status": "succeeded", "image": deleted_media}],
            },
            {
                "id": "terminal-succeeded", "type": "image-generation",
                "mode_id": self.free_mode_id, "status": "succeeded",
                "candidate_count": 1, "successful_candidate_count": 1,
                "candidates": [{"id": "succeeded", "status": "succeeded", "image": succeeded_media}],
            },
            {
                "id": "terminal-cancelled", "type": "image-generation",
                "mode_id": self.free_mode_id, "status": "cancelled",
                "candidate_count": 1, "successful_candidate_count": 0,
                "candidates": [{"id": "cancelled", "status": "cancelled"}],
            },
        ):
            self.store.save_task(task)

        response = self.client.post("/api/image-generation-tasks/cleanup-terminal", json={})
        self.assertEqual(response.status_code, 202, response.text)
        body = response.json()
        self.assertEqual(body["deleted_task_count"], 2)
        self.assertEqual(body["failed_count"], 1)
        self.assertEqual(body["deleted_count"], 1)
        self.assertEqual(set(body["deleted_task_ids"]), {"terminal-failed", "terminal-deleted"})
        self.assertIsNone(self.store.load_task("terminal-failed", include_admin=True))
        self.assertIsNone(self.store.load_task("terminal-deleted", include_admin=True))
        self.assertIsNotNone(self.store.load_task("terminal-succeeded", include_admin=True))
        self.assertIsNotNone(self.store.load_task("terminal-cancelled", include_admin=True))
        self.finish_cleanup(response)
        self.assertIsNone(self.media.media_record(failed_media["id"]))
        self.assertIsNone(self.media.media_record(deleted_media["id"]))
        self.assertIsNotNone(self.media.media_record(succeeded_media["id"]))

    def test_terminal_cleanup_preserves_media_shared_by_retained_task(self):
        shared = self.media.adopt_bytes(png_bytes((101, 102, 103)), ".png", "image/png")
        self.store.save_task({
            "id": "terminal-shared-failed", "type": "image-generation",
            "mode_id": self.free_mode_id, "status": "failed", "candidate_count": 1,
            "candidates": [{"id": "failed", "status": "failed", "image": shared}],
        })
        self.store.save_task({
            "id": "terminal-shared-success", "type": "image-generation",
            "mode_id": self.free_mode_id, "status": "succeeded", "candidate_count": 1,
            "successful_candidate_count": 1,
            "candidates": [{"id": "success", "status": "succeeded", "image": shared}],
        })

        response = self.client.post(
            "/api/image-generation-tasks/cleanup-terminal",
            json={"task_ids": ["terminal-shared-failed"]},
        )
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["deleted_task_ids"], ["terminal-shared-failed"])
        self.assertIsNotNone(self.store.load_task("terminal-shared-success", include_admin=True))
        self.finish_cleanup(response)
        self.assertIsNotNone(self.media.media_record(shared["id"]))

    def test_terminal_cleanup_rechecks_stale_snapshot_and_does_not_delete_success(self):
        self.store.save_task({
            "id": "terminal-stale-success", "type": "image-generation",
            "mode_id": self.free_mode_id, "status": "succeeded", "candidate_count": 1,
            "successful_candidate_count": 1,
            "candidates": [{"id": "success", "status": "succeeded"}],
        })
        response = self.client.post(
            "/api/image-generation-tasks/cleanup-terminal",
            json={"task_ids": ["terminal-stale-success"]},
        )
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["deleted_task_count"], 0)
        self.assertIsNotNone(self.store.load_task("terminal-stale-success", include_admin=True))

    def test_terminal_cleanup_excludes_task_with_active_candidate_even_if_summary_is_failed(self):
        self.store.save_task({
            "id": "terminal-active-candidate", "type": "image-generation",
            "mode_id": self.free_mode_id, "status": "failed", "candidate_count": 1,
            "candidates": [{"id": "active", "status": "generating"}],
        })
        response = self.client.post(
            "/api/image-generation-tasks/cleanup-terminal",
            json={"task_ids": ["terminal-active-candidate"]},
        )
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["deleted_task_count"], 0)
        self.assertIsNotNone(self.store.load_task("terminal-active-candidate", include_admin=True))

    def test_expired_cleanup_confirmation_cannot_delete_data(self):
        self.store.save_task({
            "id": "expired-confirmation", "type": "image-generation",
            "mode_id": self.free_mode_id, "status": "failed", "candidates": [],
        })
        preview = self.cleanup_confirmation("all")
        main.IMAGE_GENERATION_CLEANUP_CONFIRMATIONS[preview["confirmation_id"]]["expires_at"] = 0
        response = self.client.post(
            "/api/image-generation-tasks/cleanup",
            json={"confirmation_id": preview["confirmation_id"]},
        )
        self.assertEqual(response.status_code, 409)
        self.assertIsNotNone(self.store.load_task("expired-confirmation", include_admin=True))

    def test_cleanup_keeps_media_shared_by_a_retained_task(self):
        shared = self.media.adopt_bytes(png_bytes((22, 33, 44)), ".png", "image/png")
        now = time.time()
        for task_id, updated_at in (("shared-old", now - 8 * 86400), ("shared-new", now - 2 * 86400)):
            self.store.save_task({
                "id": task_id, "type": "image-generation", "mode_id": self.free_mode_id,
                "status": "succeeded", "inputs": [], "updated_at": updated_at,
                "created_at": updated_at,
                "candidates": [{"id": task_id, "status": "succeeded", "image": shared}],
            })
        preview = self.cleanup_confirmation("7d")
        response = self.client.post(
            "/api/image-generation-tasks/cleanup",
            json={"confirmation_id": preview["confirmation_id"]},
        )
        self.assertEqual(response.status_code, 202, response.text)
        self.assertIsNone(self.store.load_task("shared-old", include_admin=True))
        self.assertIsNotNone(self.store.load_task("shared-new", include_admin=True))
        self.finish_cleanup(response)
        self.assertIsNotNone(self.media.media_record(shared["id"]))

    def test_cleanup_uses_file_mtime_for_legacy_orphan_media(self):
        old = self.media.adopt_bytes(png_bytes((55, 66, 77)), ".png", "image/png")
        recent = self.media.adopt_bytes(png_bytes((66, 77, 88)), ".png", "image/png")
        metadata = self.media._metadata_path(old["id"])
        metadata.unlink()
        old_time = time.time() - 8 * 86400
        os.utime(Path(old["path"]), (old_time, old_time))
        preview = self.cleanup_confirmation("7d")
        response = self.client.post(
            "/api/image-generation-tasks/cleanup",
            json={"confirmation_id": preview["confirmation_id"]},
        )
        self.assertEqual(response.status_code, 202, response.text)
        self.assertIsNotNone(self.media.media_record(old["id"]))
        self.finish_cleanup(response)
        self.assertIsNone(self.media.media_record(old["id"]))
        self.assertIsNotNone(self.media.media_record(recent["id"]))

    def test_cleanup_failure_keeps_deleted_records_and_retries_media(self):
        output = self.media.adopt_bytes(png_bytes((81, 82, 83)), ".png", "image/png")
        self.store.save_task({
            "id": "cleanup-stage-failure", "type": "image-generation",
            "mode_id": self.free_mode_id, "status": "succeeded", "inputs": [],
            "candidates": [{"id": "result", "status": "succeeded", "image": output}],
        })
        preview = self.cleanup_confirmation("all")
        response = self.client.post(
            "/api/image-generation-tasks/cleanup",
            json={"confirmation_id": preview["confirmation_id"]},
        )
        self.assertEqual(response.status_code, 202, response.text)
        self.assertIsNone(self.store.load_task("cleanup-stage-failure", include_admin=True))
        with patch.object(storage_cleanup, "move_paths_to_recycle_bin", side_effect=OSError("shell unavailable")):
            failed = main.run_one_click_cleanup_job_once(response.json()["cleanup_job_id"])
        self.assertEqual(failed["status"], "failed")
        self.assertIsNotNone(self.media.media_record(output["id"]))
        succeeded = main.run_one_click_cleanup_job_once(response.json()["cleanup_job_id"])
        self.assertEqual(succeeded["status"], "succeeded")
        self.assertIsNone(self.media.media_record(output["id"]))

    def test_data_cleanup_restores_tasks_once_when_cleanup_job_persistence_fails(self):
        output = self.media.adopt_bytes(png_bytes((82, 83, 84)), ".png", "image/png")
        self.store.save_task({
            "id": "cleanup-job-persistence-failure", "type": "image-generation",
            "mode_id": self.free_mode_id, "status": "succeeded", "inputs": [],
            "candidates": [{"id": "result", "status": "succeeded", "image": output}],
        })
        preview = self.cleanup_confirmation("all")

        with patch.object(
            main,
            "image_generation_cleanup_create_job",
            side_effect=OSError("simulated cleanup job persistence failure"),
        ), patch.object(
            main,
            "image_generation_cleanup_restore_tasks",
            wraps=main.image_generation_cleanup_restore_tasks,
        ) as restore:
            response = self.client.post(
                "/api/image-generation-tasks/cleanup",
                json={"confirmation_id": preview["confirmation_id"]},
            )

        self.assertEqual(response.status_code, 500, response.text)
        self.assertEqual(restore.call_count, 1)
        self.assertIsNotNone(
            self.store.load_task("cleanup-job-persistence-failure", include_admin=True)
        )
        self.assertIsNotNone(self.media.media_record(output["id"]))

    def test_image_generation_cleanup_jobs_recover_running_state_and_ignore_invalid_media_ids(self):
        media = self.media.adopt_bytes(png_bytes((84, 85, 86)), ".png", "image/png")
        valid = main.image_generation_cleanup_create_job(
            task_ids=["restart-cleanup"], media_ids=[media["id"]]
        )
        valid_path = Path(main.ONE_CLICK_CLEANUP_JOB_DIR) / f"{valid['job_id']}.json"
        valid_record = json.loads(valid_path.read_text(encoding="utf-8"))
        valid_record["status"] = "running"
        valid_path.write_text(json.dumps(valid_record, ensure_ascii=False), encoding="utf-8")

        invalid_job_id = uuid.uuid4().hex
        invalid_path = Path(main.ONE_CLICK_CLEANUP_JOB_DIR) / f"{invalid_job_id}.json"
        invalid_record = {
            **valid_record,
            "job_id": invalid_job_id,
            "status": "queued",
            "media_ids": ["../not-a-media-id"],
        }
        invalid_path.write_text(json.dumps(invalid_record, ensure_ascii=False), encoding="utf-8")
        invalid_path_job_id = uuid.uuid4().hex
        invalid_path_record = {
            **valid_record,
            "job_id": invalid_path_job_id,
            "status": "queued",
            "media_paths": [str(self.root.parent / "outside-online.png")],
        }
        (Path(main.ONE_CLICK_CLEANUP_JOB_DIR) / f"{invalid_path_job_id}.json").write_text(
            json.dumps(invalid_path_record, ensure_ascii=False), encoding="utf-8"
        )
        main.ONE_CLICK_CLEANUP_JOBS.clear()

        main.load_one_click_cleanup_jobs()

        self.assertEqual(main.ONE_CLICK_CLEANUP_JOBS[valid["job_id"]]["status"], "queued")
        self.assertNotIn(invalid_job_id, main.ONE_CLICK_CLEANUP_JOBS)
        self.assertNotIn(invalid_path_job_id, main.ONE_CLICK_CLEANUP_JOBS)

    def test_cleanup_preview_fails_closed_for_corrupt_reference_records(self):
        orphan = self.media.adopt_bytes(png_bytes((91, 92, 93)), ".png", "image/png")
        task_path = self.store.task_dir / "corrupt.json"
        task_path.write_text("{not json", encoding="utf-8")
        response = self.client.post(
            "/api/image-generation-tasks/cleanup-preview", json={"retention": "all"}
        )
        self.assertEqual(response.status_code, 409)
        self.assertIsNotNone(self.media.media_record(orphan["id"]))

    def test_task5_proxy_submit_is_single_shot_and_tudou_persists_id_before_query(self):
        class DisconnectingClient:
            calls = 0

            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def request(self, *_args, **_kwargs):
                type(self).calls += 1
                raise main.httpx.RemoteProtocolError("server disconnected after upstream may have accepted")

        proxy = self.provider(base_url="https://proxy.example/v1")
        proxy["image_request_mode"] = "openai-video-proxy"
        proxy["image_task_endpoint"] = ""
        snapshot = main.image_generation_provider_snapshot(proxy, "proxy-model")
        self.assertEqual(snapshot["image_task_endpoint"], "")
        self.assertEqual(
            main.image_task_url_for_provider(snapshot, "saved-proxy-id"),
            "https://proxy.example/v1/videos/saved-proxy-id",
        )
        with patch.object(main.httpx, "AsyncClient", DisconnectingClient), patch.object(
            main, "api_headers", return_value={}
        ):
            with self.assertRaises(main.httpx.RemoteProtocolError):
                asyncio.run(main.generate_ai_image(
                    "prompt", "1024x1024", "auto", "proxy-model", [], proxy["id"],
                    provider_override=snapshot,
                ))
        self.assertEqual(DisconnectingClient.calls, 1)

        events = []
        tudou = self.provider(base_url="https://tudou.example/v1")
        tudou["id"] = "tudou"
        tudou["image_request_mode"] = "tudou-async"

        class TudouResponse:
            status_code = 200

            def raise_for_status(self):
                return None

            def json(self):
                return {"task_id": "tudou-saved"}

        class TudouClient(DisconnectingClient):
            async def post(self, *_args, **_kwargs):
                return TudouResponse()

        async def observer(event, details):
            events.append((event, details.get("task_id")))

        async def query_after_persist(*_args, **_kwargs):
            self.assertEqual(events, [("submitted", "tudou-saved")])
            return {"data": {"status": "SUCCESS", "url": "https://example.invalid/result.png"}}

        with patch.object(main.httpx, "AsyncClient", TudouClient), patch.object(
            main, "api_headers", return_value={}
        ), patch.object(main, "wait_for_image_task", side_effect=query_after_persist):
            asyncio.run(main.generate_tudou_async_image(
                "prompt", "1024x1024", "auto", "model", [], tudou,
                async_task_observer=observer,
            ))

    def test_task5_responses_disconnect_is_one_post_with_no_protocol_fallback(self):
        class DisconnectingResponsesClient:
            post_calls = 0

            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def post(self, *_args, **_kwargs):
                type(self).post_calls += 1
                raise main.httpx.RemoteProtocolError(
                    "server disconnected after upstream may have accepted"
                )

        provider = self.provider(base_url="https://responses.example/v1")
        provider["image_request_mode"] = "openai-responses"
        provider["image_generation_endpoint"] = "/v1/responses"
        snapshot = main.image_generation_provider_snapshot(provider, "responses-model")
        fallback = AsyncMock(side_effect=AssertionError("Task 5 must not send a second POST"))
        with patch.object(main.httpx, "AsyncClient", DisconnectingResponsesClient), patch.object(
            main, "api_headers", return_value={}
        ), patch.object(main, "post_openai_responses_stream", fallback):
            with self.assertRaises(main.httpx.RemoteProtocolError):
                asyncio.run(main.generate_ai_image(
                    "prompt", "1024x1024", "auto", "responses-model", [], provider["id"],
                    provider_override=snapshot,
                ))
        self.assertEqual(DisconnectingResponsesClient.post_calls, 1)
        fallback.assert_not_awaited()

    def test_task5_responses_persists_id_before_first_query_and_saves_query_strategy(self):
        provider = self.provider(base_url="https://responses.example/v1")
        provider["image_request_mode"] = "openai-responses"
        provider["image_generation_endpoint"] = "/v1/responses"
        snapshot = main.image_generation_provider_snapshot(provider, "responses-model")
        self.assertEqual(snapshot["_task5_query_strategy"], "openai-responses")
        self.assertEqual(
            snapshot["image_task_endpoint"],
            "https://responses.example/v1/responses/{task_id}",
        )
        durable_id = "response-durability-probe"
        self.store.save_task({"id": durable_id, "type": "probe", "upstream_task_id": ""})

        class ResponsesClient:
            post_calls = 0
            get_calls = 0

            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def post(self, url, **_kwargs):
                type(self).post_calls += 1
                return main.httpx.Response(
                    200,
                    json={"id": "resp-saved-before-get", "status": "queued"},
                    request=main.httpx.Request("POST", url),
                )

            async def request(self, method, url, **_kwargs):
                type(self).get_calls += 1
                saved = self_outer.store.load_task(durable_id, include_admin=True)
                self_outer.assertEqual(saved["upstream_task_id"], "resp-saved-before-get")
                self_outer.assertEqual(
                    url,
                    "https://responses.example/v1/responses/resp-saved-before-get",
                )
                return main.httpx.Response(
                    200,
                    json={
                        "id": "resp-saved-before-get",
                        "status": "completed",
                        "output": [{"type": "image_generation_call", "result": "YWJj"}],
                    },
                    request=main.httpx.Request(method, url),
                )

        self_outer = self

        async def persist_observer(event, details):
            if event != "submitted":
                return
            record = self.store.load_task(durable_id, include_admin=True)
            record["upstream_task_id"] = details["task_id"]
            record["provider_snapshot"] = snapshot
            self.store.save_task(record)

        with patch.object(main.httpx, "AsyncClient", ResponsesClient), patch.object(
            main, "api_headers", return_value={}
        ):
            image, raw = asyncio.run(main.generate_ai_image(
                "prompt", "1024x1024", "auto", "responses-model", [], provider["id"],
                async_task_observer=persist_observer,
                provider_override=snapshot,
            ))
        self.assertEqual(image["type"], "b64")
        self.assertEqual(raw["status"], "completed")
        self.assertEqual(ResponsesClient.post_calls, 1)
        self.assertEqual(ResponsesClient.get_calls, 1)

    def test_legacy_responses_query_keeps_responses_route_without_task5_snapshot(self):
        provider = self.provider(base_url="https://legacy-responses.example/v1")
        provider["image_request_mode"] = "openai-responses"
        provider.pop("image_task_endpoint", None)
        queried = []

        class LegacyResponsesClient:
            async def post(self, url, **_kwargs):
                return main.httpx.Response(
                    200,
                    json={"id": "resp-legacy", "status": "queued"},
                    request=main.httpx.Request("POST", url),
                )

            async def request(self, method, url, **_kwargs):
                queried.append(url)
                return main.httpx.Response(
                    200,
                    json={
                        "id": "resp-legacy",
                        "status": "completed",
                        "output": [{"type": "image_generation_call", "result": "YWJj"}],
                    },
                    request=main.httpx.Request(method, url),
                )

        with patch.object(main, "api_headers", return_value={}):
            response = asyncio.run(main.post_openai_responses(
                LegacyResponsesClient(),
                "https://legacy-responses.example/v1/responses",
                {},
                {"model": "legacy"},
                provider=provider,
            ))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(queried, ["https://legacy-responses.example/v1/responses/resp-legacy"])

    def test_task5_responses_restart_recovery_queries_saved_id_without_submit(self):
        provider = self.provider(base_url="https://saved-responses.example/v1")
        provider["image_request_mode"] = "openai-responses"
        provider["image_generation_endpoint"] = "/v1/responses"
        snapshot = main.image_generation_provider_snapshot(provider, "responses-model")
        task_id = "image_generation_responses_restart"
        candidate_id = "responses-candidate"
        task = {
            "id": task_id,
            "type": "image-generation",
            "mode_id": self.free_mode_id,
            "status": "recovering",
            "candidates": [{
                "id": candidate_id,
                "status": "recovering",
                "upstream_task_id": "resp-restart-saved",
                "provider_snapshot": snapshot,
            }],
        }
        self.store.save_task(task)
        main.IMAGE_GENERATION_RUNTIME_TASKS[task_id] = task
        seen = []

        async def query_only(_client, upstream_id, saved_provider, _observer=None, **_kwargs):
            seen.append((upstream_id, saved_provider["image_task_endpoint"]))
            return {
                "id": upstream_id,
                "status": "completed",
                "output": [{"type": "image_generation_call", "result": "YWJj"}],
            }

        submit = AsyncMock(side_effect=AssertionError("restart recovery must never submit"))
        with patch.object(main, "wait_for_detail_page_image_task", side_effect=query_only), patch.object(
            main, "post_openai_responses", submit
        ), patch.object(
            main, "detail_page_result_from_async_payload", AsyncMock(return_value=self.media_result())
        ):
            asyncio.run(main.run_image_generation_candidate_recovery(task_id, candidate_id))
        submit.assert_not_awaited()
        self.assertEqual(seen, [(
            "resp-restart-saved",
            "https://saved-responses.example/v1/responses/{task_id}",
        )])
        self.assertEqual(
            self.store.load_task(task_id, include_admin=True)["candidates"][0]["status"],
            "succeeded",
        )

    def test_task5_runninghub_uses_saved_routes_persists_id_and_restart_is_query_only(self):
        saved = self.provider(provider_id="runninghub", base_url="https://saved-rh.example")
        saved["protocol"] = "runninghub"
        entry = {"kind": "workflow", "id": "wf-saved", "fields": []}
        with patch.object(main, "runninghub_entry_config_from_model", return_value=entry):
            snapshot = main.image_generation_provider_snapshot(saved, "workflow:wf-saved")
        self.assertEqual(snapshot["_task5_query_strategy"], "runninghub-entry")
        self.assertEqual(snapshot["runninghub_submit_endpoint"], "https://saved-rh.example/task/openapi/create")
        self.assertEqual(snapshot["runninghub_query_endpoint"], "https://saved-rh.example/task/openapi/outputs")

        live = dict(saved, base_url="https://changed-live-rh.example")
        posted_urls = []
        observer_events = []
        credential_ids = []

        class RunningHubClient:
            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def post(self, url, **_kwargs):
                posted_urls.append(url)
                if url.endswith("/task/openapi/create"):
                    return FakeResponse({"code": 0, "data": {"taskId": "rh-saved-id"}})
                self_outer.assertEqual(observer_events[0], ("submitted", "rh-saved-id"))
                return FakeResponse({"code": 0, "data": [{"fileUrl": "/assets/output/rh-result.png"}]})

        class FakeResponse:
            status_code = 200

            def __init__(self, payload):
                self.payload = payload

            def json(self):
                return self.payload

        self_outer = self

        def credential(provider_id):
            credential_ids.append(provider_id)
            return "saved-provider-secret"

        async def observer(event, details):
            observer_events.append((event, details.get("task_id")))

        with patch.object(main.httpx, "AsyncClient", RunningHubClient), patch.object(
            main, "get_api_provider_exact", return_value=live
        ), patch.object(
            main, "provider_env_key_value", side_effect=credential
        ), patch.object(main.asyncio, "sleep", AsyncMock()):
            image, _raw = asyncio.run(main.generate_ai_image(
                "prompt", "1024x1024", "auto", "workflow:wf-saved", [], "runninghub",
                async_task_observer=observer,
                provider_override=snapshot,
            ))
        self.assertEqual(image["value"], "/assets/output/rh-result.png")
        self.assertEqual(posted_urls, [
            "https://saved-rh.example/task/openapi/create",
            "https://saved-rh.example/task/openapi/outputs",
        ])
        self.assertNotIn("https://changed-live-rh.example", " ".join(posted_urls))
        self.assertTrue(credential_ids)
        self.assertEqual(set(credential_ids), {"runninghub"})

        task_id = "image_generation_runninghub_restart"
        candidate_id = "runninghub-candidate"
        task = {
            "id": task_id,
            "type": "image-generation",
            "mode_id": self.free_mode_id,
            "status": "recovering",
            "candidates": [{
                "id": candidate_id,
                "status": "recovering",
                "upstream_task_id": "rh-restart-saved",
                "provider_snapshot": snapshot,
            }],
        }
        self.store.save_task(task)
        main.IMAGE_GENERATION_RUNTIME_TASKS[task_id] = task
        restart_seen = []

        async def restart_query(upstream_id, use_wallet=False, provider_override=None):
            restart_seen.append((upstream_id, provider_override["base_url"]))
            return {"status": "SUCCESS", "urls": ["/assets/output/rh-restart.png"]}

        restart_submit = AsyncMock(side_effect=AssertionError("restart recovery must never submit"))
        with patch.object(main, "query_runninghub_task_remote", side_effect=restart_query), patch.object(
            main, "submit_prepared_runninghub_entry", restart_submit
        ), patch.object(
            main, "detail_page_result_from_async_payload", AsyncMock(return_value=self.media_result((8, 7, 6)))
        ), patch.object(main.asyncio, "sleep", AsyncMock()):
            asyncio.run(main.run_image_generation_candidate_recovery(task_id, candidate_id))
        restart_submit.assert_not_awaited()
        self.assertEqual(restart_seen, [("rh-restart-saved", "https://saved-rh.example")])
        self.assertEqual(
            self.store.load_task(task_id, include_admin=True)["candidates"][0]["status"],
            "succeeded",
        )

    def test_aggregate_stays_active_until_every_candidate_is_terminal(self):
        for terminal in ("succeeded", "failed", "cancelled"):
            task = {
                "candidates": [{"status": terminal}, {"status": "queued"}],
                "completed_at": 123.0,
            }
            main.image_generation_refresh_summary(task)
            self.assertEqual(task["status"], "queued")
            self.assertNotIn("completed_at", task)

        submission = str(uuid.uuid4())
        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "image_generation_schedule_candidate", return_value=(None, False)
        ):
            first = self.client.post("/api/image-generation-tasks", json=self.payload(submission, image_count=2)).json()
            internal = self.store.load_task(first["task_id"], include_admin=True)
            internal["candidates"][0]["status"] = "succeeded"
            internal["candidates"][1]["status"] = "queued"
            main.image_generation_refresh_summary(internal)
            self.store.save_task(internal)
            main.IMAGE_GENERATION_RUNTIME_TASKS[first["task_id"]] = internal
            replay = self.client.post("/api/image-generation-tasks", json=self.payload(image_count=2)).json()
        self.assertEqual(replay["task_id"], first["task_id"])
        self.assertEqual(replay["reuse_reason"], "active_config")
        cancelled = self.client.post(f"/api/image-generation-tasks/{first['task_id']}/cancel").json()
        self.assertEqual(cancelled["status"], "cancelled")

        restart_task = json.loads(json.dumps(internal))
        restart_task["id"] = "image_generation_mixed_restart"
        restart_task["status"] = "queued"
        restart_task["cancel_requested"] = False
        self.store.save_task(restart_task)
        main.load_persisted_image_generation_tasks()
        restarted = self.store.load_task(restart_task["id"], include_admin=True)
        self.assertEqual([item["status"] for item in restarted["candidates"]], ["succeeded", "cancelled"])
        self.assertEqual(restarted["status"], "succeeded")

    def test_regenerate_submission_id_permanently_reuses_one_candidate(self):
        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "image_generation_schedule_candidate", return_value=(None, False)
        ):
            created = self.client.post("/api/image-generation-tasks", json=self.payload()).json()
        task = self.store.load_task(created["task_id"], include_admin=True)
        source = task["candidates"][0]
        source["status"] = "failed"
        main.image_generation_refresh_summary(task)
        self.store.save_task(task)
        main.IMAGE_GENERATION_RUNTIME_TASKS[task["id"]] = task
        operation_id = str(uuid.uuid4())
        scheduled = []

        def regenerate_once():
            request = main.ImageGenerationCandidateRegenerateRequest(
                confirm_cost=True, submission_id=operation_id
            )
            return asyncio.run(main.regenerate_image_generation_candidate(task["id"], source["id"], request))

        with patch.object(main, "image_generation_schedule_candidate", side_effect=lambda *args: scheduled.append(args)):
            with ThreadPoolExecutor(max_workers=2) as pool:
                responses = list(pool.map(lambda _index: regenerate_once(), range(2)))
            persisted = self.store.load_task(task["id"], include_admin=True)
            persisted["candidates"][0]["status"] = "generating"
            self.store.save_task(persisted)
            third = regenerate_once()
            persisted["candidates"][0]["status"] = "failed"
            self.store.save_task(persisted)
            different = main.ImageGenerationCandidateRegenerateRequest(
                confirm_cost=True, submission_id=str(uuid.uuid4())
            )
            asyncio.run(main.regenerate_image_generation_candidate(task["id"], source["id"], different))
        self.assertEqual(len({item["candidate_id"] for item in responses}), 1)
        self.assertEqual(sum(bool(item["reused"]) for item in responses), 1)
        self.assertTrue(third["reused"])
        self.assertEqual(len(scheduled), 2)
        self.assertEqual(len(self.store.load_task(task["id"], include_admin=True)["candidates"]), 3)

    def test_deleting_tombstone_blocks_mutations_and_waits_for_registered_jobs(self):
        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "image_generation_schedule_candidate", return_value=(None, False)
        ):
            created = self.client.post("/api/image-generation-tasks", json=self.payload()).json()
        task = self.store.load_task(created["task_id"], include_admin=True)
        task["candidates"][0]["status"] = "failed"
        main.image_generation_refresh_summary(task)
        self.store.save_task(task)
        main.IMAGE_GENERATION_RUNTIME_TASKS[task["id"]] = task

        cancel_called = threading.Event()
        release = threading.Event()

        class RegisteredJob:
            def done(self):
                return release.is_set()

            def cancel(self):
                cancel_called.set()

        key = f"{task['id']}:{task['candidates'][0]['id']}"
        main.IMAGE_GENERATION_CANDIDATE_TASKS[key] = RegisteredJob()
        response_holder = []

        def delete():
            response_holder.append(self.client.delete(f"/api/image-generation-tasks/{task['id']}"))

        thread = threading.Thread(target=delete)
        thread.start()
        self.assertTrue(cancel_called.wait(2))
        closing = self.store.load_task(task["id"], include_admin=True)
        self.assertTrue(closing["deleting"])
        self.assertEqual(closing["status"], "deleting")
        self.assertEqual(self.client.patch(f"/api/image-generation-tasks/{task['id']}", json={"name": "race"}).status_code, 409)
        self.assertEqual(self.client.post(
            f"/api/image-generation-tasks/{task['id']}/candidates/{task['candidates'][0]['id']}/regenerate",
            json={"confirm_cost": True, "submission_id": str(uuid.uuid4())},
        ).status_code, 409)
        self.assertEqual(self.client.post(
            f"/api/image-generation-tasks/{task['id']}/candidates/{task['candidates'][0]['id']}/recover"
        ).status_code, 409)
        self.assertEqual(main.image_generation_schedule_candidate(task["id"], task["candidates"][0]["id"]), (None, True))
        release.set()
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(response_holder[0].status_code, 202)
        self.assertIsNone(self.store.load_task(task["id"], include_admin=True))

    def test_delete_failure_keeps_durable_tombstone_for_safe_retry(self):
        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "image_generation_schedule_candidate", return_value=(None, False)
        ):
            created = self.client.post("/api/image-generation-tasks", json=self.payload()).json()
        original_delete = self.store.delete_task
        with patch.object(self.store, "delete_task", side_effect=OSError("locked")):
            failed = self.client.delete(f"/api/image-generation-tasks/{created['task_id']}")
        self.assertEqual(failed.status_code, 500)
        tombstone = self.store.load_task(created["task_id"], include_admin=True)
        self.assertTrue(tombstone["deleting"])
        self.assertEqual(tombstone["status"], "deleting")
        with patch.object(self.store, "delete_task", side_effect=original_delete):
            retried = self.client.delete(f"/api/image-generation-tasks/{created['task_id']}")
        self.assertEqual(retried.status_code, 202)
        self.assertIsNone(self.store.load_task(created["task_id"], include_admin=True))

    def test_fingerprint_uses_effective_normalized_execution_configuration(self):
        provider_a = self.provider(provider_id="mock-image-provider")
        provider_a["image_model_resolution_maps"] = {
            "logical": {"enabled": True, "models": {"2k": "effective-a"}}
        }
        provider_b = json.loads(json.dumps(provider_a))
        provider_b["image_model_resolution_maps"]["logical"]["models"]["2k"] = "effective-b"
        with patch.object(main, "image_generation_schedule_candidate", return_value=(None, False)), patch.object(
            main, "get_api_provider_exact", return_value=provider_a
        ):
            first = self.client.post("/api/image-generation-tasks", json=self.payload(
                user_prompt="  cat  ", image_provider_id="mock-image-provider", image_model="logical"
            )).json()
            equivalent = self.client.post("/api/image-generation-tasks", json=self.payload(
                user_prompt="cat", image_provider_id="MOCK-IMAGE-PROVIDER", image_model="logical"
            )).json()
        self.assertEqual(equivalent["task_id"], first["task_id"])
        with patch.object(main, "image_generation_schedule_candidate", return_value=(None, False)), patch.object(
            main, "get_api_provider_exact", return_value=provider_b
        ):
            remapped = self.client.post("/api/image-generation-tasks", json=self.payload(
                user_prompt="cat", image_provider_id="mock-image-provider", image_model="logical"
            )).json()
        self.assertNotEqual(remapped["task_id"], first["task_id"])

    def test_ratio_modes_normalize_to_durable_execution_settings(self):
        source_media = self.media.adopt_bytes(png_bytes(), ".png", "image/png")
        source_image = {"slot_key": "ref1", "media_id": source_media["id"]}
        provider = self.provider()

        def create(**overrides):
            with patch.object(main, "get_api_provider_exact", return_value=provider), patch.object(
                main, "image_generation_schedule_candidate", return_value=(None, False)
            ):
                response = self.client.post(
                    "/api/image-generation-tasks",
                    json=self.payload(mode_id=self.required_mode_id, images=[source_image], **overrides),
                )
            self.assertEqual(response.status_code, 200, response.text)
            return self.store.load_task(response.json()["task_id"], include_admin=True)

        source = create(
            ratio_mode="source", aspect_ratio="1:1", size="1x1",
        )
        self.assertEqual(source["generation_settings"]["ratio_mode"], "source")
        self.assertEqual(source["generation_settings"]["aspect_ratio"], "3:2")
        self.assertEqual(source["generation_settings"]["size"], "2016x1344")
        source_request = main.image_generation_request_from_task(source)
        self.assertEqual(source_request.aspect_ratio, "3:2")
        self.assertTrue(source_request.reference_images)
        self.assertEqual(
            {item.stretch_aspect_ratio for item in source_request.reference_images},
            {"3:2"},
        )

        adaptive = create(
            ratio_mode="adaptive", aspect_ratio="16:9", size="3840x2160",
        )
        self.assertEqual(adaptive["generation_settings"]["aspect_ratio"], "")
        self.assertEqual(adaptive["generation_settings"]["size"], "auto")
        self.assertIn("自适应", adaptive["final_prompt"])
        adaptive_request = main.image_generation_request_from_task(adaptive)
        self.assertEqual(adaptive_request.aspect_ratio, "")
        self.assertEqual(adaptive_request.size, "auto")
        self.assertEqual(
            {item.stretch_aspect_ratio for item in adaptive_request.reference_images},
            {""},
        )

        custom = create(
            ratio_mode="custom", custom_ratio_width="14", custom_ratio_height="6",
            aspect_ratio="1:1", size="1x1",
        )
        self.assertEqual(custom["generation_settings"]["ratio_mode"], "custom")
        self.assertEqual(custom["generation_settings"]["custom_ratio_width"], "14")
        self.assertEqual(custom["generation_settings"]["custom_ratio_height"], "6")
        self.assertEqual(custom["generation_settings"]["aspect_ratio"], "7:3")
        self.assertEqual(custom["generation_settings"]["size"], "2016x864")

    def test_source_ratio_requires_a_persisted_input_dimension(self):
        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "image_generation_schedule_candidate", return_value=(None, False)
        ):
            response = self.client.post(
                "/api/image-generation-tasks",
                json=self.payload(ratio_mode="source", aspect_ratio="1:1", size="1x1"),
            )
        self.assertEqual(response.status_code, 422)
        self.assertIn("尺寸", response.json()["detail"])

    def test_auto_resolution_forces_auto_size_for_every_ratio_mode(self):
        media = self.media.adopt_bytes(png_bytes(), ".png", "image/png")
        normalized_inputs = [{"media": self.media.media_record(media["id"])}]
        cases = (
            ("fixed", {"aspect_ratio": "4:5"}),
            ("source", {}),
            ("adaptive", {}),
            ("custom", {"custom_ratio_width": "7", "custom_ratio_height": "3"}),
        )
        for ratio_mode, extras in cases:
            with self.subTest(ratio_mode=ratio_mode):
                payload = main.ImageGenerationTaskRequest(**self.payload(
                    ratio_mode=ratio_mode,
                    resolution="auto",
                    size="must-be-overridden",
                    **extras,
                ))
                settings = main.image_generation_effective_settings(payload, normalized_inputs)
                self.assertEqual(settings["size"], "auto")

    def test_fixed_ratio_size_is_recomputed_instead_of_trusting_the_client(self):
        payload = main.ImageGenerationTaskRequest(**self.payload(
            ratio_mode="fixed",
            aspect_ratio="4:5",
            resolution="2k",
            size="9999x1",
        ))
        settings = main.image_generation_effective_settings(payload, [])
        self.assertEqual(settings["aspect_ratio"], "4:5")
        self.assertEqual(settings["size"], "1600x2000")

    def test_ultrawide_fixed_ratios_keep_their_public_labels(self):
        for aspect_ratio, expected_size in (("21:9", "2016x864"), ("9:21", "864x2016")):
            with self.subTest(aspect_ratio=aspect_ratio):
                payload = main.ImageGenerationTaskRequest(**self.payload(
                    ratio_mode="fixed",
                    aspect_ratio=aspect_ratio,
                    resolution="2k",
                    size="must-be-recomputed",
                ))
                settings = main.image_generation_effective_settings(payload, [])
                self.assertEqual(settings["aspect_ratio"], aspect_ratio)
                self.assertEqual(settings["size"], expected_size)

    def test_custom_ratio_rejects_non_positive_fractional_and_oversized_values(self):
        for width, height in (("0", "3"), ("2.5", "3"), ("1000", "1"), ("3", "")):
            with self.subTest(width=width, height=height), patch.object(
                main, "get_api_provider_exact", return_value=self.provider()
            ), patch.object(main, "image_generation_schedule_candidate", return_value=(None, False)):
                response = self.client.post(
                    "/api/image-generation-tasks",
                    json=self.payload(
                        ratio_mode="custom",
                        custom_ratio_width=width,
                        custom_ratio_height=height,
                    ),
                )
            self.assertEqual(response.status_code, 422)
            self.assertIn("自定义比例", response.json()["detail"])

    def test_ratio_mode_is_part_of_active_configuration_fingerprint(self):
        source_media = self.media.adopt_bytes(png_bytes(), ".png", "image/png")
        images = [{"slot_key": "ref1", "media_id": source_media["id"]}]
        with patch.object(main, "get_api_provider_exact", return_value=self.provider()), patch.object(
            main, "image_generation_schedule_candidate", return_value=(None, False)
        ):
            fixed = self.client.post("/api/image-generation-tasks", json=self.payload(
                mode_id=self.required_mode_id, images=images, ratio_mode="fixed",
                aspect_ratio="3:2", size="2016x1344",
            )).json()
            source = self.client.post("/api/image-generation-tasks", json=self.payload(
                mode_id=self.required_mode_id, images=images, ratio_mode="source",
                aspect_ratio="3:2", size="2016x1344",
            )).json()
        self.assertNotEqual(fixed["task_id"], source["task_id"])

    def test_legacy_task_without_ratio_mode_remains_a_fixed_ratio_request(self):
        task = {
            "final_prompt": "legacy",
            "inputs": [],
            "generation_settings": {
                "image_provider_id": "mock-image-provider",
                "image_model": "mock-image-model",
                "aspect_ratio": "4:5",
                "resolution": "2k",
                "size": "1632x2048",
            },
        }
        request = main.image_generation_request_from_task(task)
        self.assertEqual(request.aspect_ratio, "4:5")
        self.assertEqual(request.size, "1632x2048")
        self.assertEqual(request.reference_images, [])

    def test_execution_snapshot_preserves_custom_routing_and_recursively_removes_secrets(self):
        provider = self.provider(async_enabled=False, base_url="https://user:pw@saved.example/v1?token=x")
        provider.update({
            "image_generation_endpoint": "https://u:p@submit.example/custom?api_key=x",
            "image_edit_endpoint": "/custom/edit?secret=x",
            "image_task_endpoint": "https://q:p@query.example/tasks/{task_id}?token=x",
            "model_protocols": {"mock-image-model": "gemini"},
            "model_image_strategies": {"mock-image-model": "banana"},
            "image_model_resolution_maps": {"mock-image-model": {"enabled": True, "models": {"2k": "resolved"}}},
            "nested": {"authorization": "Bearer leak", "safe": "kept"},
        })
        snapshot = main.image_generation_provider_snapshot(provider, "resolved")
        encoded = json.dumps(snapshot).lower()
        for secret in ("user", "pw", "api_key", "secret=x", "bearer leak", "token=x", "q:p"):
            self.assertNotIn(secret, encoded)
        self.assertEqual(snapshot["image_generation_endpoint"], "https://submit.example/custom")
        self.assertEqual(snapshot["image_edit_endpoint"], "/custom/edit")
        self.assertEqual(snapshot["image_task_endpoint"], "https://query.example/tasks/{task_id}")
        self.assertEqual(main.provider_endpoint_url(snapshot, "image_generation_endpoint", "/v1/images/generations"), "https://submit.example/custom")
        self.assertEqual(snapshot["model_protocols"]["mock-image-model"], "gemini")
        self.assertEqual(snapshot["model_image_strategies"]["mock-image-model"], "banana")
        with patch.object(main, "get_api_provider_exact", return_value=provider), patch.object(
            main, "image_generation_schedule_candidate", return_value=(None, False)
        ):
            created = self.client.post("/api/image-generation-tasks", json=self.payload()).json()
        stored_snapshot = self.store.load_task(created["task_id"], include_admin=True)["candidates"][0]["provider_snapshot"]
        self.assertEqual(stored_snapshot["image_generation_endpoint"], "https://submit.example/custom")

        runninghub = self.provider(provider_id="runninghub")
        runninghub["protocol"] = "runninghub"
        frozen_entry = {"kind": "workflow", "id": "wf-1", "fields": [], "workflowJson": {"1": {"inputs": {}}}}
        with patch.object(main, "runninghub_entry_config_from_model", return_value=frozen_entry):
            rh_snapshot = main.image_generation_provider_snapshot(runninghub, "workflow:wf-1")
        self.assertEqual(rh_snapshot["_task5_runninghub_entry"], frozen_entry)

    def test_zip_rejects_noncanonical_media_and_redacts_local_read_errors(self):
        good = self.media.adopt_bytes(png_bytes(), ".png", "image/png")
        task_id = "image_generation_zip_security"
        self.store.save_task({
            "id": task_id, "type": "image-generation", "status": "succeeded",
            "candidates": [
                {"id": "good", "status": "succeeded", "image": good},
                {"id": "bad", "status": "succeeded", "image": {"id": "a" * 64, "url": "https://remote.invalid/a.png?token=leak"}},
            ],
        })
        original_read = self.media.read_bytes

        def read(media_id):
            if media_id == good["id"]:
                return original_read(media_id)
            raise ValueError("Authorization: Bearer ZIP-SECRET https://u:p@host/x?api_key=ZIP-QUERY")

        with patch.object(self.media, "read_bytes", side_effect=read), patch.object(
            main, "detail_page_download_bytes", side_effect=AssertionError("network fetch forbidden")
        ):
            response = self.client.get(f"/api/image-generation-tasks/{task_id}/download.zip")
        self.assertEqual(response.status_code, 200)
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            errors = archive.read("download-errors.txt").decode("utf-8")
        self.assertNotIn("ZIP-SECRET", errors)
        self.assertNotIn("ZIP-QUERY", errors)

    def test_persisted_and_public_errors_are_redacted_and_internal_fields_are_hidden(self):
        secret = "LIVE-PROVIDER-SECRET"

        async def fail(_request, **_kwargs):
            raise main.HTTPException(
                status_code=502,
                detail=f"Authorization: Bearer PUBLIC-LEAK-SECRET api_key={secret} https://u:p@host/x?token=URL-SECRET",
            )

        with patch.object(main, "get_api_provider_exact", return_value=self.provider(async_enabled=True)), patch.object(
            main, "provider_env_key_value", return_value=secret
        ), patch.object(main, "build_online_image_result", side_effect=fail):
            created = self.client.post("/api/image-generation-tasks", json=self.payload()).json()
            public = self.wait_for_status(created["task_id"], {"failed"})
        encoded = json.dumps(public)
        for leaked in ("PUBLIC-LEAK-SECRET", secret, "URL-SECRET", "provider_snapshot", "upstream_task_id"):
            self.assertNotIn(leaked, encoded)
        stored = json.dumps(self.store.load_task(created["task_id"], include_admin=True))
        self.assertNotIn("PUBLIC-LEAK-SECRET", stored)
        self.assertNotIn(secret, stored)
        self.store.save_task({
            "id": "image_generation_legacy_secret", "type": "image-generation",
            "status": "failed", "error_summary": "Bearer LEGACY-LIST-SECRET LIVE-BARE-SECRET",
            "candidates": [{
                "id": "legacy", "status": "failed", "error": "failure LIVE-BARE-SECRET",
                "provider_snapshot": {"id": "mock-image-provider"},
            }],
        })
        with patch.object(main, "provider_env_key_value", return_value="LIVE-BARE-SECRET"):
            listed = json.dumps(self.client.get("/api/image-generation-tasks").json())
            detailed = json.dumps(self.client.get("/api/image-generation-tasks/image_generation_legacy_secret").json())
        self.assertNotIn("LEGACY-LIST-SECRET", listed)
        self.assertNotIn("LIVE-BARE-SECRET", listed + detailed)

    def test_recover_live_registry_is_reused_after_status_becomes_generating(self):
        provider_snapshot = main.detail_page_async_provider_snapshot(
            self.provider(async_enabled=True), "mock-image-model"
        )
        task_id = "image_generation_recover_generating"
        candidate_id = "candidate-recover"
        task = {
            "id": task_id, "type": "image-generation", "mode_id": self.free_mode_id,
            "status": "unknown", "candidates": [{
                "id": candidate_id, "status": "unknown", "upstream_task_id": "saved",
                "provider_snapshot": provider_snapshot,
            }],
        }
        self.store.save_task(task)
        main.IMAGE_GENERATION_RUNTIME_TASKS[task_id] = task
        querying = asyncio.Event()
        release = asyncio.Event()

        async def query(_client, _upstream, _provider, observer=None):
            await observer("querying", {"attempt": 1})
            querying.set()
            await release.wait()
            return {"data": {"status": "SUCCESS", "data": [{"url": "https://result.invalid/a.png"}]}}

        async def scenario():
            first = await main.recover_image_generation_candidate(task_id, candidate_id)
            await querying.wait()
            second = await main.recover_image_generation_candidate(task_id, candidate_id)
            release.set()
            await asyncio.gather(*list(main.IMAGE_GENERATION_CANDIDATE_RECOVERY_TASKS.values()))
            return first, second

        with patch.object(main, "wait_for_detail_page_image_task", side_effect=query), patch.object(
            main, "detail_page_result_from_async_payload", AsyncMock(return_value=self.media_result())
        ):
            first, second = asyncio.run(scenario())
        self.assertFalse(first["reused"])
        self.assertTrue(second["reused"])


if __name__ == "__main__":
    unittest.main()
