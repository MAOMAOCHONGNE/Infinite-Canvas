import datetime
import re
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


CREATIVE_AGENT_ACTIONS = {
    "chat",
    "canvas_analysis",
    "clarify",
    "local_reply",
    "generate_image",
    "edit_image",
    "generate_video",
}
CREATIVE_AGENT_IMAGE_RATIOS = {
    "", "1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3",
    "4:5", "5:4", "8:1", "9:16", "16:9", "21:9", "adaptive", "source", "custom",
}
CREATIVE_AGENT_IMAGE_RESOLUTIONS = {"", "auto", "1k", "2k", "4k", "custom"}
CREATIVE_AGENT_VIDEO_RATIOS = {"", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "9:21", "keep_ratio", "adaptive"}
CREATIVE_AGENT_VIDEO_RESOLUTIONS = {"", "480p", "720p", "1080p", "780P"}
CANVAS_CONTEXT_KEYWORDS = (
    "画布", "画板", "节点", "连线", "连接关系", "工作流", "流程", "上游", "下游",
    "循环节点", "选中提示词", "当前提示词", "这个提示词", "分析提示词", "检查提示词",
    "canvas", "node", "workflow", "upstream", "downstream",
)


class CreativeModelCandidate(BaseModel):
    provider: str = Field(min_length=1, max_length=120)
    model: str = Field(min_length=1, max_length=240)


class CanvasCreativeConversationCreate(BaseModel):
    canvas_id: str = Field(min_length=1, max_length=120)
    title: str = Field(default="新对话", max_length=80)


class CanvasCreativeAgentStreamRequest(BaseModel):
    conversation_id: str = Field(default="", max_length=160)
    canvas_id: str = Field(min_length=1, max_length=120)
    mode: str = Field(default="agent", pattern=r"^(agent|image|video)$")
    message: str = Field(min_length=1, max_length=100000)
    system_prompt: str = Field(default="", max_length=20000)
    brain_provider: str = Field(default="comfly", max_length=120)
    brain_model: str = Field(default="", max_length=240)
    brain_ms_model: str = Field(default="", max_length=240)
    image_candidates: List[CreativeModelCandidate] = Field(default_factory=list, max_length=80)
    video_candidates: List[CreativeModelCandidate] = Field(default_factory=list, max_length=80)
    preferences: Dict[str, Any] = Field(default_factory=dict)
    reference_images: List[Dict[str, Any]] = Field(default_factory=list, max_length=20)
    canvas_context: Optional[Dict[str, Any]] = None


def should_include_canvas_context(message: str) -> bool:
    text = str(message or "").strip().lower()
    return bool(text and any(keyword in text for keyword in CANVAS_CONTEXT_KEYWORDS))


def deterministic_creative_reply(message: str, now: Optional[datetime.datetime] = None) -> Optional[Dict[str, str]]:
    text = re.sub(r"\s+", "", str(message or "")).lower()
    if not any(keyword in text for keyword in ("今天星期几", "今天周几", "今天礼拜几", "whatdayisittoday")):
        return None
    current = now or datetime.datetime.now()
    weekdays = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]
    return {
        "action": "local_reply",
        "reply": f"今天是{current.year}年{current.month}月{current.day}日，{weekdays[current.weekday()]}。",
    }


def _candidate_items(values: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    result = []
    seen = set()
    for item in values or []:
        if not isinstance(item, dict):
            continue
        provider = str(item.get("provider") or "").strip()[:120]
        model = str(item.get("model") or "").strip()[:240]
        key = (provider, model)
        if not provider or not model or key in seen:
            continue
        seen.add(key)
        result.append({"provider": provider, "model": model})
    return result


def _selected_candidate(raw: Dict[str, Any], candidates: List[Dict[str, str]]) -> Dict[str, str]:
    requested = (str(raw.get("provider") or "").strip(), str(raw.get("model") or "").strip())
    return next((item for item in candidates if (item["provider"], item["model"]) == requested), candidates[0] if candidates else {"provider": "", "model": ""})


def normalize_creative_plan(
    raw: Dict[str, Any],
    *,
    mode: str,
    image_candidates: List[Dict[str, Any]],
    video_candidates: List[Dict[str, Any]],
    has_references: bool,
) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    clean_mode = mode if mode in {"agent", "image", "video"} else "agent"
    action = str(source.get("action") or "chat").strip()
    if clean_mode == "image":
        action = "edit_image" if has_references else "generate_image"
    elif clean_mode == "video":
        action = "generate_video"
    elif action not in CREATIVE_AGENT_ACTIONS:
        action = "chat"
    candidates = _candidate_items(video_candidates if action == "generate_video" else image_candidates)
    selected = _selected_candidate(source, candidates) if action in {"generate_image", "edit_image", "generate_video"} else {"provider": "", "model": ""}
    image_ratio = str(source.get("aspect_ratio") or "").strip()
    image_resolution = str(source.get("resolution") or "").strip()
    video_ratio = image_ratio if image_ratio in CREATIVE_AGENT_VIDEO_RATIOS else ""
    video_resolution = image_resolution if image_resolution in CREATIVE_AGENT_VIDEO_RESOLUTIONS else ""
    result = {
        "action": action,
        "reply": str(source.get("reply") or "").strip()[:4000],
        "optimized_prompt": str(source.get("optimized_prompt") or source.get("prompt") or "").strip()[:100000],
        "provider": selected["provider"],
        "model": selected["model"],
        "image_count": max(1, min(10, int(source.get("image_count") or 1))),
        "quality": str(source.get("quality") or "auto").strip().lower() if str(source.get("quality") or "auto").strip().lower() in {"auto", "low", "medium", "high"} else "auto",
        "duration": max(1, min(60, int(source.get("duration") or 5))),
        "aspect_ratio": video_ratio if action == "generate_video" else (image_ratio if image_ratio in CREATIVE_AGENT_IMAGE_RATIOS else ""),
        "resolution": video_resolution if action == "generate_video" else (image_resolution if image_resolution in CREATIVE_AGENT_IMAGE_RESOLUTIONS else ""),
        "generate_audio": bool(source.get("generate_audio")),
        "enhance_prompt": bool(source.get("enhance_prompt")),
        "enable_upsample": bool(source.get("enable_upsample")),
        "watermark": bool(source.get("watermark")),
        "camera_fixed": bool(source.get("camera_fixed")),
        "multimodal": bool(source.get("multimodal")),
    }
    if action in {"generate_image", "edit_image", "generate_video"} and not candidates:
        result["action"] = "clarify"
        result["reply"] = "当前模式没有勾选可用模型，请先在模型设置中选择。"
    return result


def sanitize_creative_references_for_storage(references: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    stored = []
    for index, item in enumerate((references or [])[:20]):
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        embedded = url.lower().startswith("data:image/")
        stored.append({
            "url": "" if embedded else url,
            "name": str(item.get("name") or f"图片{index + 1}").strip()[:240],
            "marker": str(item.get("marker") or f"图片{index + 1}").strip()[:80],
            "role": str(item.get("role") or "").strip()[:80],
            "embedded": embedded,
        })
    return stored
