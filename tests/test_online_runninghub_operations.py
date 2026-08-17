import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

import main


def operation_payload(operation_id="online-rh-1"):
    return main.OnlineRunningHubOperationRequest(
        operation_id=operation_id,
        prompt="test",
        provider_id="runninghub",
        model="workflow:workflow-1",
        size="1024x1024",
        reference_images=[main.AIReference(url="/assets/input/test.png", name="test.png")],
    )


class OnlineRunningHubOperationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        with main.ONLINE_RUNNINGHUB_OPERATION_LOCK:
            main.ONLINE_RUNNINGHUB_OPERATIONS.clear()

    def tearDown(self):
        with main.ONLINE_RUNNINGHUB_OPERATION_LOCK:
            main.ONLINE_RUNNINGHUB_OPERATIONS.clear()

    async def test_capacity_retry_reuses_prepared_uploads(self):
        prepared = {"kind": "workflow", "entry_id": "workflow-1", "node_info_list": [], "use_wallet": False}
        prepare = AsyncMock(return_value=prepared)
        submit = AsyncMock(side_effect=[
            HTTPException(status_code=429, detail={"message": "TASK_QUEUE_MAXED"}),
            "remote-task-1",
        ])
        with patch.object(main, "prepare_online_runninghub_operation", prepare), patch.object(
            main, "submit_prepared_runninghub_entry", submit
        ):
            with self.assertRaises(HTTPException) as caught:
                await main.online_runninghub_operation_submit(operation_payload())
            result = await main.online_runninghub_operation_submit(operation_payload())

        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(result["data"]["status"], "RUNNING")
        self.assertEqual(prepare.await_count, 1)
        self.assertEqual(submit.await_count, 2)

    async def test_cancel_while_locally_queued_never_calls_remote_cancel(self):
        prepare = AsyncMock(return_value={"kind": "workflow", "entry_id": "workflow-1", "node_info_list": [], "use_wallet": False})
        submit = AsyncMock(side_effect=HTTPException(status_code=429, detail={"message": "TASK_QUEUE_MAXED"}))
        remote_cancel = AsyncMock()
        with patch.object(main, "prepare_online_runninghub_operation", prepare), patch.object(
            main, "submit_prepared_runninghub_entry", submit
        ), patch.object(main, "cancel_runninghub_task_remote", remote_cancel):
            with self.assertRaises(HTTPException):
                await main.online_runninghub_operation_submit(operation_payload())
            result = await main.online_runninghub_operation_cancel(main.OnlineRunningHubOperationCancelRequest(operation_id="online-rh-1"))

        self.assertEqual(result["data"]["status"], "CANCELLED")
        remote_cancel.assert_not_awaited()

    async def test_cancel_arriving_before_submit_prevents_remote_creation(self):
        prepare = AsyncMock()
        submit = AsyncMock()
        cancelled = await main.online_runninghub_operation_cancel(
            main.OnlineRunningHubOperationCancelRequest(operation_id="online-rh-early-cancel")
        )
        with patch.object(main, "prepare_online_runninghub_operation", prepare), patch.object(
            main, "submit_prepared_runninghub_entry", submit
        ):
            submitted = await main.online_runninghub_operation_submit(
                operation_payload("online-rh-early-cancel")
            )

        self.assertEqual(cancelled["data"]["status"], "CANCELLED")
        self.assertEqual(submitted["data"]["status"], "CANCELLED")
        prepare.assert_not_awaited()
        submit.assert_not_awaited()

    async def test_cancel_during_submission_cancels_late_task_id(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def submit_late(_prepared):
            started.set()
            await release.wait()
            return "late-task"

        prepare = AsyncMock(return_value={"kind": "workflow", "entry_id": "workflow-1", "node_info_list": [], "use_wallet": False})
        remote_cancel = AsyncMock(return_value={"status": "cancelled"})
        with patch.object(main, "prepare_online_runninghub_operation", prepare), patch.object(
            main, "submit_prepared_runninghub_entry", side_effect=submit_late
        ), patch.object(main, "cancel_runninghub_task_remote", remote_cancel):
            pending = asyncio.create_task(main.online_runninghub_operation_submit(operation_payload()))
            await started.wait()
            cancelled = await main.online_runninghub_operation_cancel(main.OnlineRunningHubOperationCancelRequest(operation_id="online-rh-1"))
            release.set()
            submitted = await pending

        self.assertEqual(cancelled["data"]["status"], "CANCELLED")
        self.assertEqual(submitted["data"]["status"], "CANCELLED")
        remote_cancel.assert_awaited_once()
        self.assertEqual(remote_cancel.await_args.args[0], "late-task")

    async def test_accepted_operation_cancel_uses_remote_endpoint(self):
        prepare = AsyncMock(return_value={"kind": "app", "entry_id": "app-1", "node_info_list": [], "use_wallet": False})
        remote_cancel = AsyncMock(return_value={"status": "cancelled"})
        with patch.object(main, "prepare_online_runninghub_operation", prepare), patch.object(
            main, "submit_prepared_runninghub_entry", AsyncMock(return_value="remote-task")
        ), patch.object(main, "cancel_runninghub_task_remote", remote_cancel):
            await main.online_runninghub_operation_submit(operation_payload())
            result = await main.online_runninghub_operation_cancel(main.OnlineRunningHubOperationCancelRequest(operation_id="online-rh-1"))

        self.assertTrue(result["data"]["remote_cancelled"])
        remote_cancel.assert_awaited_once_with("remote-task", use_wallet=False)

    async def test_successful_query_finalizes_history_once(self):
        payload = operation_payload()
        record = main.new_online_runninghub_operation_record(payload)
        record.update({"status": "RUNNING", "task_id": "remote-task", "prepared": {"use_wallet": False}})
        with main.ONLINE_RUNNINGHUB_OPERATION_LOCK:
            main.ONLINE_RUNNINGHUB_OPERATIONS[payload.operation_id] = record
        query = AsyncMock(return_value={
            "status": "SUCCESS",
            "urls": ["/output/online-one.png"],
            "image_items": [{"url": "/output/online-one.png", "width": 1024, "height": 1024}],
            "code": 0,
        })
        with patch.object(main, "query_runninghub_task_remote", query), patch.object(main, "save_to_history") as save:
            first = await main.online_runninghub_operation_query("online-rh-1")
            second = await main.online_runninghub_operation_query("online-rh-1")

        self.assertEqual(first["data"]["status"], "SUCCESS")
        self.assertEqual(second["data"]["status"], "SUCCESS")
        self.assertEqual(first["data"]["result"]["images"], ["/output/online-one.png"])
        save.assert_called_once()
        query.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
