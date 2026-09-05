import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import storage_cleanup
from storage_cleanup import StorageCleanupTransaction


class StorageCleanupTransactionTests(unittest.TestCase):
    def test_late_stage_failure_rolls_every_file_back(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest_root = root / "manifests"
            first_root = root / "generated-a"
            second_root = root / "generated-b"
            first_root.mkdir()
            second_root.mkdir()
            first = first_root / "first.png"
            second = second_root / "second.png"
            first.write_bytes(b"first")
            second.write_bytes(b"second")
            transaction = StorageCleanupTransaction(manifest_root, (first_root, second_root))
            transaction.begin()
            original_replace = storage_cleanup.os.replace

            def fail_second_source(source, target):
                if Path(source) == second:
                    raise OSError("simulated locked file")
                return original_replace(source, target)

            with patch.object(storage_cleanup.os, "replace", side_effect=fail_second_source):
                with self.assertRaises(OSError):
                    transaction.stage((first, second))
            transaction.rollback()
            self.assertEqual(first.read_bytes(), b"first")
            self.assertEqual(second.read_bytes(), b"second")
            self.assertFalse(manifest_root.exists())

    def test_startup_recovery_restores_an_uncommitted_transaction(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest_root = root / "manifests"
            generated = root / "generated"
            generated.mkdir()
            image = generated / "image.png"
            image.write_bytes(b"image")
            transaction = StorageCleanupTransaction(manifest_root, (generated,))
            transaction.begin()
            transaction.stage((image,))
            self.assertFalse(image.exists())

            StorageCleanupTransaction.recover_pending(manifest_root, (generated,))
            self.assertEqual(image.read_bytes(), b"image")
            self.assertFalse(manifest_root.exists())

    def test_commit_to_recycle_bin_uses_staged_paths_and_cleans_transaction(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest_root = root / "manifests"
            generated = root / "generated"
            generated.mkdir()
            image = generated / "image.png"
            image.write_bytes(b"image")
            transaction = StorageCleanupTransaction(manifest_root, (generated,))
            transaction.begin()
            transaction.stage((image,))
            staged = next(generated.glob(".infinite-canvas-cleanup/*/*.png"))
            seen = []

            def fake_recycle(paths):
                seen.extend(Path(item) for item in paths)
                for item in seen:
                    item.unlink()

            with patch.object(storage_cleanup, "move_paths_to_recycle_bin", side_effect=fake_recycle):
                transaction.commit_to_recycle_bin()
            self.assertEqual(seen, [staged])
            self.assertFalse(image.exists())
            self.assertFalse(manifest_root.exists())

    def test_recycle_bin_failure_leaves_file_recoverable_for_rollback(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest_root = root / "manifests"
            generated = root / "generated"
            generated.mkdir()
            image = generated / "image.png"
            image.write_bytes(b"image")
            transaction = StorageCleanupTransaction(manifest_root, (generated,))
            transaction.begin()
            transaction.stage((image,))
            with patch.object(
                storage_cleanup,
                "move_paths_to_recycle_bin",
                side_effect=OSError("recycle bin unavailable"),
            ):
                with self.assertRaises(OSError):
                    transaction.commit_to_recycle_bin()
            transaction.rollback()
            self.assertEqual(image.read_bytes(), b"image")
            self.assertFalse(manifest_root.exists())


if __name__ == "__main__":
    unittest.main()
