import asyncio
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class MediaPreviewDedupTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_same_key_builds_decode_only_once(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / 'source.png'
            cache = root / 'previews'
            cache.mkdir()
            webp = cache / 'same.webp'
            png = cache / 'same.png'
            Image.new('RGB', (640, 480), (40, 90, 140)).save(source, 'PNG')

            original_open = main.Image.open
            call_lock = threading.Lock()
            open_calls = 0

            def slow_open(*args, **kwargs):
                nonlocal open_calls
                with call_lock:
                    open_calls += 1
                time.sleep(0.1)
                return original_open(*args, **kwargs)

            with (
                patch.object(main, 'MEDIA_PREVIEW_DIR', str(cache)),
                patch.object(main, 'output_file_from_url', return_value=str(source)),
                patch.object(main, 'media_preview_cache_paths', return_value=(str(webp), str(png))),
                patch.object(main.Image, 'open', side_effect=slow_open),
            ):
                first, second = await asyncio.gather(
                    main.media_preview('/fake/source.png', 160),
                    main.media_preview('/fake/source.png', 160),
                )

            self.assertEqual(open_calls, 1)
            self.assertEqual(Path(first.path), Path(second.path))
            self.assertTrue(Path(first.path).is_file())
            self.assertEqual(main.MEDIA_PREVIEW_BUILD_REGISTRY, {})


if __name__ == '__main__':
    unittest.main()
