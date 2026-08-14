import io
import os
import tempfile
import unittest
import zipfile
import asyncio
from unittest import mock

from PIL import Image

import main


class PromptTemplateThumbnailTests(unittest.TestCase):
    def test_normalization_preserves_thumbnail_url(self):
        item = main.normalize_prompt_library_item({
            "id": "tpl_demo",
            "name": "Demo",
            "positive": "hello",
            "thumbnail": "/assets/prompt-thumbnails/demo.webp",
        })
        self.assertEqual(item["thumbnail"], "/assets/prompt-thumbnails/demo.webp")

    def test_save_compresses_to_bounded_webp_and_safe_path(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(main, "PROMPT_THUMBNAIL_DIR", folder):
            source = Image.new("RGB", (1200, 800), (220, 30, 60))
            buffer = io.BytesIO()
            source.save(buffer, "PNG")
            url = main.save_prompt_thumbnail_bytes(buffer.getvalue(), "tpl_demo")
            path = main.prompt_thumbnail_path(url)
            self.assertTrue(path.startswith(os.path.abspath(folder) + os.sep))
            self.assertTrue(os.path.isfile(path))
            with Image.open(path) as result:
                self.assertEqual(result.format, "WEBP")
                self.assertLessEqual(max(result.size), 512)
            self.assertEqual(main.prompt_thumbnail_path("/assets/prompt-thumbnails/../secret.webp"), "")

    def test_replacing_cleanup_never_leaves_dedicated_directory(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(main, "PROMPT_THUMBNAIL_DIR", folder):
            target = os.path.join(folder, "old.webp")
            with open(target, "wb") as handle:
                handle.write(b"old")
            self.assertTrue(main.remove_prompt_thumbnail("/assets/prompt-thumbnails/old.webp"))
            self.assertFalse(os.path.exists(target))
            self.assertFalse(main.remove_prompt_thumbnail("/assets/other/file.webp"))

    def test_upload_route_saves_thumbnail_and_returns_updated_library(self):
        source = Image.new("RGB", (80, 60), (90, 30, 180))
        binary = io.BytesIO()
        source.save(binary, "PNG")
        upload = mock.Mock(content_type="image/png")
        upload.read = mock.AsyncMock(return_value=binary.getvalue())
        data = {
            "active_library_id": "system",
            "libraries": [{
                "id": "system",
                "name": "System",
                "items": [{"id": "tpl_demo", "name": "Demo", "positive": "hello", "thumbnail": ""}],
            }],
        }

        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.object(main, "PROMPT_THUMBNAIL_DIR", folder), \
                mock.patch.object(main, "load_prompt_libraries", return_value=data), \
                mock.patch.object(main, "save_prompt_libraries", side_effect=lambda value: value):
            result = asyncio.run(main.upload_prompt_library_thumbnail("tpl_demo", upload))

        self.assertTrue(result["item"]["thumbnail"].startswith("/assets/prompt-thumbnails/"))
        self.assertEqual(result["library"]["libraries"][0]["items"][0]["thumbnail"], result["item"]["thumbnail"])

    def test_backup_restore_rewrites_embedded_thumbnail(self):
        image = Image.new("RGB", (40, 30), (10, 120, 240))
        binary = io.BytesIO()
        image.save(binary, "WEBP")
        archive_bytes = io.BytesIO()
        with zipfile.ZipFile(archive_bytes, "w") as archive:
            archive.writestr("prompt-thumbnails/demo.webp", binary.getvalue())
        archive_bytes.seek(0)
        payload = {"libraries":[{"id":"system","items":[{"id":"tpl_demo","thumbnail":"backup://prompt-thumbnails/demo.webp"}]}]}
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(main, "PROMPT_THUMBNAIL_DIR", folder):
            created = []
            with zipfile.ZipFile(archive_bytes, "r") as archive:
                restored = main.backup_restore_prompt_thumbnails(archive, payload, created)
            url = restored["libraries"][0]["items"][0]["thumbnail"]
            self.assertTrue(url.startswith("/assets/prompt-thumbnails/"))
            self.assertEqual(len(created), 1)
            self.assertTrue(os.path.isfile(created[0]))

    def test_backup_restore_skips_oversized_thumbnail_before_reading(self):
        member = "prompt-thumbnails/oversized.webp"
        archive = mock.Mock()
        archive.namelist.return_value = [member]
        archive.getinfo.return_value.file_size = main.PROMPT_THUMBNAIL_MAX_BYTES + 1
        payload = {
            "libraries": [{
                "id": "system",
                "items": [{"id": "tpl_demo", "thumbnail": f"backup://{member}"}],
            }],
        }

        restored = main.backup_restore_prompt_thumbnails(archive, payload, [])

        self.assertEqual(restored["libraries"][0]["items"][0]["thumbnail"], "")
        archive.read.assert_not_called()


if __name__ == "__main__":
    unittest.main()
