"""Small deterministic official catalog used by local image-generation tests.

The public runtime seed is intentionally empty. Tests that exercise the
historical 65-mode workspace use this isolated fixture instead of repopulating
the GitHub distribution file.
"""

from pathlib import Path
import json


def ensure_seed(path: Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    modes = []
    for number in range(1, 66):
        required = number == 25
        modes.append({
            "id": f"builtin-test-{number:02d}",
            "display_name": f"{number:02d}测试模式",
            "description": "测试官方模式",
            "category": "测试",
            "tags": [],
            "synonyms": [],
            "sort_order": number,
            "preset_prompt": f"测试提示词 {number}",
            "required_reference_count": 1 if required else 0,
            "reference_images": ([{"key": "ref1", "label": "参考图1", "required": True}] if required else []),
            "max_upload_count": 6,
            "allow_extra_images": True,
            "extra_image_limit": 6,
            "special_hint": "",
            "remark": "",
            "mode_no": number,
        })
    modes[0]["example"] = {
        "id": "test-example-1",
        "mode_id": modes[0]["id"],
        "updated_at": "2026-01-01T00:00:00+00:00",
        "input_media": [],
        "output_media": {"url": "/static/image-generation-examples/builtin-free/9833f55e49977652e10e03e146a2bb65b952457b9f144c169641e2a20bfb969a.png"},
        "source": {},
    }
    path.write_text(json.dumps({
        "source_url": "",
        "source_version": "test-catalog-v1",
        "distribution_version": "test-catalog-v1",
        "captured_at": "",
        "modes": modes,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
