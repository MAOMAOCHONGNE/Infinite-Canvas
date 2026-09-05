import asyncio
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import main


ROOT = Path(__file__).resolve().parents[1]


class FastApiLifespanTests(unittest.IsolatedAsyncioTestCase):
    async def exercise_lifespan(self, failing_migration=""):
        calls = []
        sync_versions = Mock(side_effect=lambda: calls.append("sync_static_html_versions"))
        migrate_library = Mock()
        migrate_double_extensions = Mock()
        migrate_mislabeled_extensions = Mock()
        migration_names = {
            migrate_library: "migrate_asset_library_into_dirs",
            migrate_double_extensions: "migrate_double_extension_uploads",
            migrate_mislabeled_extensions: "migrate_mislabeled_image_extensions",
        }

        async def fake_to_thread(function, *args, **kwargs):
            name = migration_names[function]
            calls.append(name)
            if name == failing_migration:
                raise RuntimeError("simulated migration failure")

        previous_loop = main.GLOBAL_LOOP
        try:
            with (
                patch.object(main, "sync_static_html_versions", sync_versions),
                patch.object(main, "migrate_asset_library_into_dirs", migrate_library),
                patch.object(main, "migrate_double_extension_uploads", migrate_double_extensions),
                patch.object(main, "migrate_mislabeled_image_extensions", migrate_mislabeled_extensions),
                patch.object(main.asyncio, "to_thread", new=fake_to_thread),
            ):
                async with main.app.router.lifespan_context(main.app):
                    active_loop = main.GLOBAL_LOOP
        finally:
            main.GLOBAL_LOOP = previous_loop

        return calls, active_loop

    async def test_lifespan_runs_every_startup_action_once_and_in_order(self):
        calls, active_loop = await self.exercise_lifespan()

        self.assertEqual(
            calls,
            [
                "sync_static_html_versions",
                "migrate_asset_library_into_dirs",
                "migrate_double_extension_uploads",
                "migrate_mislabeled_image_extensions",
            ],
        )
        self.assertIs(active_loop, asyncio.get_running_loop())

    async def test_one_migration_failure_does_not_skip_later_actions(self):
        calls, _ = await self.exercise_lifespan("migrate_asset_library_into_dirs")

        self.assertEqual(
            calls,
            [
                "sync_static_html_versions",
                "migrate_asset_library_into_dirs",
                "migrate_double_extension_uploads",
                "migrate_mislabeled_image_extensions",
            ],
        )

    def test_app_uses_lifespan_without_the_deprecated_startup_decorator(self):
        source = (ROOT / "main.py").read_text(encoding="utf-8")

        self.assertIn("app = FastAPI(lifespan=lifespan)", source)
        self.assertNotIn('@app.on_event("startup")', source)

    async def test_lifespan_clears_global_loop_after_shutdown(self):
        async def fake_startup():
            main.GLOBAL_LOOP = asyncio.get_running_loop()

        previous_loop = main.GLOBAL_LOOP
        try:
            with (
                patch.object(main, "run_startup_initialization", new=fake_startup),
                patch.object(main, "stop_one_click_cleanup_worker", new=AsyncMock()),
            ):
                async with main.app.router.lifespan_context(main.app):
                    self.assertIs(main.GLOBAL_LOOP, asyncio.get_running_loop())
                self.assertIsNone(main.GLOBAL_LOOP)
        finally:
            main.GLOBAL_LOOP = previous_loop


if __name__ == "__main__":
    unittest.main()
