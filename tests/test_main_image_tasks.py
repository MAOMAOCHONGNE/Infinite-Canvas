import asyncio
import copy
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import main
import main_image_v4 as v4


def main_image_payload(**overrides):
    values = {
        "main_image_mode": "continuous",
        "product_images": ["https://example.test/product.png"],
        "reference_images": ["https://example.test/reference.png"],
        "image_provider_id": "image-provider",
        "image_model": "gpt-image-2",
        "llm_provider_id": "vision-provider",
        "llm_model": "gemini-3-flash",
        "aspect_ratio": "1:1",
        "resolution": "2k",
        "size": "2048x2048",
        "image_count": 4,
        "copywriting": "required",
        "richness": "concise",
        "font_style": "auto",
        "output_language": "自动识别",
        "model_setting": "none",
        "model_pose": "normal",
        "model_usage": 0,
        "product_name": "智能电饭锅",
        "product_facts": "玫瑰金拉丝机身\n深咖色上盖\n左前方按键面板",
        "selling_points": "微压精煮\n多种参数可选",
        "user_instruction": "暖灰厨房，高级克制",
    }
    values.update(overrides)
    return main.MainImageTaskRequest(**values)


def planned_prompt(number, *, mode="continuous", ratio="1:1"):
    marker = f"电商连续主图第{number}屏" if mode == "continuous" else "电商创意主图"
    scene = ["品牌首图", "智能面板特写", "家庭用餐场景", "功能卖点收官", "厨房台面", "细节近景"][number % 6]
    return (
        f"{ratio}方形{marker}，使用图1产品图锁定电饭锅真实身份，严格保留玫瑰金拉丝机身、深咖色上盖、"
        "顶部圆形蒸汽口、左前方按键控制面板、右侧提手、产品比例与可见标签，不改变结构和配件；"
        "图2是设计参考图，仅允许参考构图、配色、字体层级、光影和场景语言，禁止复制参考图商品、品牌、文字和人物身份；"
        f"本张采用{scene}构图，产品居中偏右占画面约六成，暖灰米色现代厨房背景，柔和自然侧光与克制暖金轮廓光，"
        "商业摄影质感清晰，材质反射真实；画面文案使用现代粗体无衬线中文，大标题“智能电饭锅”，"
        f"副标题“第{number}张核心卖点”，小标签“家用多功能”，文字清晰且不遮挡产品；"
        "禁止虚构容量、认证、材质或促销信息，禁止其他品牌、水印、重复产品、错误文字、结构变形和比例失真，无人物。"
    )


def planner_json(count=4, mode="continuous"):
    return json.dumps({"prompts": [planned_prompt(index, mode=mode) for index in range(1, count + 1)]}, ensure_ascii=False)


class MainImagePlannerTests(unittest.TestCase):
    def test_request_keeps_image_roles_fact_boundaries_and_defaults(self):
        payload = main_image_payload()
        preview = v4.build_planning_request(payload)
        self.assertEqual(preview["aspect_ratio"], "1:1")
        self.assertEqual(preview["mode"], "continuous")
        for expected in (
            "图1=产品图", "图2=设计参考图", "规划4张连续主图", "目标画幅：1:1",
            "玫瑰金拉丝机身", "微压精煮", "全部禁止人物", "数量必须为4",
        ):
            self.assertIn(expected, preview["request"])

    def test_continuous_and_creative_contracts_are_strict(self):
        continuous = main_image_payload(image_count=2)
        prompts = v4.postprocess_prompts([planned_prompt(1), planned_prompt(2)], continuous)
        v4.validate_planning_prompts(prompts, continuous)
        with self.assertRaisesRegex(v4.MainImagePlanningError, "跨屏依赖"):
            v4.validate_planning_prompts([prompts[0], prompts[1] + "延续上一屏。"], continuous)

        creative = main_image_payload(main_image_mode="creative", image_count=2)
        creative_prompts = v4.postprocess_prompts([planned_prompt(1, mode="creative"), planned_prompt(2, mode="creative")], creative)
        v4.validate_planning_prompts(creative_prompts, creative)
        with self.assertRaisesRegex(v4.MainImagePlanningError, "创意模式误用"):
            v4.validate_planning_prompts(prompts, creative)

    def test_postprocess_removes_internal_labels_and_duplicate_prefix_and_appends_features(self):
        payload = main_image_payload(
            image_count=1,
            product_facts="微压精煮\n多种参数可选\n八大功能智能预约蒸煮焖炖送",
            selling_points="不粘锅\n官方正品\n不溢锅",
        )
        raw = (
            "1:1方形电商连续主图第1屏，1:1+电商连续主图第1屏。"
            "【产品图职责】使用图1中的电饭锅，严格保留真实外观与比例；"
            "【参考图使用边界】图2仅参考构图和配色，禁止复制品牌与产品；"
            "【构图/场景】产品居中放大，暖灰厨房背景，柔和自然光；"
            "【文案与字体】主标题“智能电饭锅”，小标签【官方正品】，现代无衬线字体；"
            "【人物约束】无人物；【禁止项】禁止水印、错误品牌、结构变形和比例失真。"
        )
        prompt = v4.postprocess_prompts([raw], payload)[0]
        self.assertTrue(prompt.startswith("1:1方形电商连续主图第1屏，"))
        self.assertIn(v4.product_image_role_clause(payload), prompt)
        self.assertIn(v4.reference_image_role_clause(payload), prompt)
        self.assertIn("使用图1中的电饭锅", prompt)
        self.assertEqual(prompt.count("电商连续主图第1屏"), 1)
        self.assertNotIn("1:1+", prompt)
        self.assertNotIn("【", prompt)
        self.assertIn("小标签“官方正品”", prompt)
        self.assertTrue(prompt.endswith(
            "生图务必保持产品一致性，产品大小比例不可失真：微压精煮\n多种参数可选\n八大功能智能预约蒸煮焖炖送\n不粘锅\n官方正品\n不溢锅"
        ))
        v4.validate_planning_prompts([prompt], payload)

    def test_creative_postprocess_uses_one_natural_prefix(self):
        payload = main_image_payload(main_image_mode="creative", image_count=1)
        raw = "1:1方形电商创意主图，1:1电商创意主图。【构图】使用图1商品，图2仅参考配色且禁止复制品牌，现代厨房场景，画面有明确文案和字体，禁止水印、人物、假参数和产品变形。"
        prompt = v4.postprocess_prompts([raw], payload)[0]
        self.assertTrue(prompt.startswith("1:1方形电商创意主图，"))
        self.assertIn(v4.product_image_role_clause(payload), prompt)
        self.assertIn(v4.reference_image_role_clause(payload), prompt)
        self.assertEqual(prompt.count("电商创意主图"), 1)
        self.assertNotIn("【", prompt)

    def test_postprocess_injects_roles_when_model_uses_unnumbered_semantics(self):
        payload = main_image_payload(main_image_mode="creative", image_count=1, output_language="英文")
        raw = (
            "Use the supplied product photograph as the sole identity and fact source, preserving the exact cooker shape, colors, labels and proportions. "
            "Borrow only the visual language of the supplied design example while excluding its product, brand and wording. "
            "Place the cooker in a premium warm-gray kitchen scene with balanced commercial composition and soft directional light. "
            "Add concise readable sans-serif copy. Do not invent capacity, certification or functions; no watermark, extra product or deformation."
        )
        prompt = v4.postprocess_prompts([raw], payload)[0]
        self.assertIn(v4.product_image_role_clause(payload), prompt)
        self.assertIn(v4.reference_image_role_clause(payload), prompt)
        v4.validate_planning_prompts([prompt], payload)

    def test_role_validation_binds_product_and_reference_contracts_separately(self):
        payload = main_image_payload(main_image_mode="creative", image_count=1, output_language="英文")
        prompt = v4.postprocess_prompts([planned_prompt(1, mode="creative")], payload)[0]
        without_product = prompt.replace(v4.product_image_role_clause(payload), "", 1)
        with self.assertRaisesRegex(v4.MainImagePlanningError, "产品图职责"):
            v4.validate_planning_prompts([without_product], payload)
        without_reference = prompt.replace(v4.reference_image_role_clause(payload), "", 1)
        with self.assertRaisesRegex(v4.MainImagePlanningError, "参考图使用边界"):
            v4.validate_planning_prompts([without_reference], payload)

    def test_postprocess_role_contract_is_idempotent(self):
        payload = main_image_payload(main_image_mode="creative", image_count=1, output_language="英文")
        first = v4.postprocess_prompt(planned_prompt(1, mode="creative"), payload, 1)
        second = v4.postprocess_prompt(first, payload, 1)
        self.assertEqual(second.count(v4.product_image_role_clause(payload)), 1)
        self.assertEqual(second.count(v4.reference_image_role_clause(payload)), 1)

    def test_role_contract_uses_supported_output_language(self):
        expected = {
            "中文": ("图1是产品图", "图2是设计参考图"),
            "英文": ("Image 1 is a product image", "Reference Image 2 is a design reference image"),
            "日文": ("画像1は商品画像", "参照画像2はデザイン参考"),
            "韩文": ("이미지 1은 제품 이미지", "참조 이미지 2은 디자인 참고용"),
        }
        for language, fragments in expected.items():
            with self.subTest(language=language):
                payload = main_image_payload(output_language=language)
                self.assertIn(fragments[0], v4.product_image_role_clause(payload))
                self.assertIn(fragments[1], v4.reference_image_role_clause(payload))

    def test_legacy_feature_headings_are_filtered_and_english_body_validates(self):
        payload = main_image_payload(
            image_count=1,
            output_language="英文",
            product_facts="【产品信息】\n24pcs mini plastic bottles\n【已确认核心卖点】\nLeak-proof\n【官方正品】",
            selling_points="",
        )
        raw = (
            "1:1 Square e-commerce continuous main image screen 1. "
            "[Product Image Responsibility] Use Image 1 as the only product identity source and preserve its shape, cap and proportions. "
            "[Reference Image Boundary] The design Reference Image 2 is only for composition, color and lighting; never copy its brand, product or text. "
            "[Composition/Scene] Place the product in a clean kitchen background with a clear commercial composition. "
            "Use readable sans-serif copy. No people, watermark, invented capacity or structural changes."
        )
        prompt = v4.postprocess_prompts([raw], payload)[0]
        self.assertNotIn("【产品信息】", prompt)
        self.assertNotIn("【已确认核心卖点】", prompt)
        self.assertNotIn("[Product Image Responsibility]", prompt)
        self.assertNotIn("[Reference Image Boundary]", prompt)
        self.assertIn("24pcs mini plastic bottles\nLeak-proof\n官方正品", prompt)
        v4.validate_planning_prompts([prompt], payload)

    def test_analysis_is_structured_and_model_flags_are_deterministic(self):
        analysis = v4.parse_analysis_output(json.dumps({
            "product_name": " 电饭锅 ",
            "product_facts": ["玫瑰金机身", "玫瑰金机身", "深咖色上盖"],
            "selling_points": ["微压精煮"],
            "uncertain_items": ["容量无法确认"],
        }, ensure_ascii=False))
        self.assertEqual(analysis["product_facts"], ["玫瑰金机身", "深咖色上盖"])
        payload = main_image_payload(image_count=3, model_setting="use", model_usage=2, model_pose="specific")
        records = v4.infer_screen_records([planned_prompt(1), planned_prompt(2), planned_prompt(3)], payload)
        self.assertEqual([item["use_model"] for item in records], [True, True, False])
        self.assertEqual(records[0]["model_pose"], "specific")
        self.assertEqual(records[2]["model_pose"], "")


class MainImageTaskLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.original_tasks = copy.deepcopy(main.CANVAS_TASKS)
        self.original_cleanup_jobs = copy.deepcopy(main.ONE_CLICK_CLEANUP_JOBS)
        self.cleanup_dir = tempfile.TemporaryDirectory()
        self.cleanup_job_dir_patcher = patch.object(
            main, "ONE_CLICK_CLEANUP_JOB_DIR", os.path.join(self.cleanup_dir.name, "jobs")
        )
        self.cleanup_job_dir_patcher.start()
        main.CANVAS_TASKS.clear()
        main.ONE_CLICK_CLEANUP_JOBS.clear()
        main.MAIN_IMAGE_BACKGROUND_TASKS.clear()
        main.MAIN_IMAGE_SCREEN_TASKS.clear()
        main.MAIN_IMAGE_CANDIDATE_RECOVERY_TASKS.clear()
        main.MAIN_IMAGE_GENERATION_SEMAPHORE = None

    def tearDown(self):
        main.CANVAS_TASKS.clear()
        main.CANVAS_TASKS.update(self.original_tasks)
        main.ONE_CLICK_CLEANUP_JOBS.clear()
        main.ONE_CLICK_CLEANUP_JOBS.update(self.original_cleanup_jobs)
        self.cleanup_job_dir_patcher.stop()
        self.cleanup_dir.cleanup()
        main.MAIN_IMAGE_BACKGROUND_TASKS.clear()
        main.MAIN_IMAGE_SCREEN_TASKS.clear()
        main.MAIN_IMAGE_CANDIDATE_RECOVERY_TASKS.clear()
        main.MAIN_IMAGE_GENERATION_SEMAPHORE = None

    def test_submission_id_and_active_config_are_idempotent(self):
        first_payload = main_image_payload(submission_id="11111111-1111-4111-8111-111111111111")
        same_config = main_image_payload(submission_id="22222222-2222-4222-8222-222222222222")
        runner = AsyncMock(return_value=None)
        with tempfile.TemporaryDirectory() as folder, patch.object(main, "MAIN_IMAGE_TASK_DIR", folder), patch.object(main, "run_main_image_task", runner):
            first = asyncio.run(main.create_main_image_task(first_payload))
            repeat = asyncio.run(main.create_main_image_task(first_payload))
            reused = asyncio.run(main.create_main_image_task(same_config))
        self.assertFalse(first["reused"])
        self.assertEqual(repeat["task_id"], first["task_id"])
        self.assertEqual(repeat["reuse_reason"], "submission_id")
        self.assertEqual(reused["task_id"], first["task_id"])
        self.assertEqual(reused["reuse_reason"], "active_config")
        self.assertEqual(runner.await_count, 1)

    def test_permanent_group_numbers_are_not_reused_after_delete(self):
        runner = AsyncMock(return_value=None)
        with tempfile.TemporaryDirectory() as folder, patch.object(main, "MAIN_IMAGE_TASK_DIR", folder), patch.object(main, "run_main_image_task", runner):
            first = asyncio.run(main.create_main_image_task(main_image_payload(submission_id="11111111-1111-4111-8111-111111111111")))
            second = asyncio.run(main.create_main_image_task(main_image_payload(submission_id="22222222-2222-4222-8222-222222222222", force_new=True)))
            main.CANVAS_TASKS[first["task_id"]]["status"] = "succeeded"
            asyncio.run(main.delete_main_image_task(first["task_id"]))
            third = asyncio.run(main.create_main_image_task(main_image_payload(submission_id="33333333-3333-4333-8333-333333333333", force_new=True)))
        self.assertEqual([first["group_no"], second["group_no"], third["group_no"]], [1, 2, 3])

    def test_twelve_images_use_at_most_ten_concurrent_requests(self):
        payload = main_image_payload(image_count=12)
        task_id = "main_image_test_concurrency"
        main.CANVAS_TASKS[task_id] = main.new_main_image_task_record(task_id, payload, "sub", "fingerprint", 1)
        active = 0
        peak = 0

        async def fake_image(_request, **_kwargs):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1
            return {"images": [f"/output/result-{peak}.png"]}

        llm = AsyncMock(return_value={"text": planner_json(12)})
        with tempfile.TemporaryDirectory() as folder, patch.object(main, "MAIN_IMAGE_TASK_DIR", folder), patch.object(main, "execute_canvas_llm", llm), patch.object(main, "build_online_image_result", side_effect=fake_image), patch.object(main, "detail_page_async_snapshot_for_request", return_value=None):
            main.MAIN_IMAGE_GENERATION_SEMAPHORE = None
            asyncio.run(main.run_main_image_task(task_id, payload))
        task = main.CANVAS_TASKS[task_id]
        self.assertEqual(peak, 10)
        self.assertEqual(len(task["screens"]), 12)
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(llm.await_count, 1)

    def test_invalid_plan_repairs_once_and_second_failure_never_calls_image_model(self):
        payload = main_image_payload(image_count=1)
        task_id = "main_image_test_invalid"
        main.CANVAS_TASKS[task_id] = main.new_main_image_task_record(task_id, payload, "sub", "fingerprint", 1)
        llm = AsyncMock(side_effect=[{"text": "bad"}, {"text": json.dumps({"prompts": ["still too short"]})}])
        image = AsyncMock()
        with tempfile.TemporaryDirectory() as folder, patch.object(main, "MAIN_IMAGE_TASK_DIR", folder), patch.object(main, "execute_canvas_llm", llm), patch.object(main, "build_online_image_result", image):
            asyncio.run(main.run_main_image_task(task_id, payload))
        self.assertEqual(llm.await_count, 2)
        image.assert_not_awaited()
        task = main.CANVAS_TASKS[task_id]
        self.assertEqual(task["status"], "failed")
        self.assertIn("主图规划失败", task["error"])
        self.assertEqual(task["llm_trace"]["planning_calls"], 1)
        self.assertEqual(task["llm_trace"]["repair_calls"], 1)
        self.assertIn("模型没有返回可解析", task["llm_trace"]["planning_error"])
        self.assertIn("内容过短", task["llm_trace"]["repair_error"])
        self.assertEqual(task["llm_trace"]["planning_response_excerpt"], "bad")
        self.assertIn("still too short", task["llm_trace"]["repair_response_excerpt"])

    def test_unnumbered_semantic_plan_reaches_image_generation_without_repair(self):
        payload = main_image_payload(main_image_mode="creative", image_count=1, output_language="英文")
        task_id = "main_image_test_deterministic_roles"
        main.CANVAS_TASKS[task_id] = main.new_main_image_task_record(task_id, payload, "sub", "fingerprint", 1)
        raw = (
            "Use the supplied product photograph as the sole identity source and preserve every visible product fact. "
            "Borrow only composition and color from the supplied design example while excluding its product, brand and wording. "
            "Create a premium warm-gray kitchen scene with a balanced commercial composition and clear sans-serif copy. "
            "Do not invent capacity or certification; no watermark, duplicate product or deformation."
        )
        llm = AsyncMock(return_value={"text": json.dumps({"prompts": [raw]})})
        image = AsyncMock(return_value={"images": ["/output/result.png"]})
        with tempfile.TemporaryDirectory() as folder, patch.object(main, "MAIN_IMAGE_TASK_DIR", folder), patch.object(main, "execute_canvas_llm", llm), patch.object(main, "build_online_image_result", image), patch.object(main, "detail_page_async_snapshot_for_request", return_value=None):
            asyncio.run(main.run_main_image_task(task_id, payload))
        task = main.CANVAS_TASKS[task_id]
        self.assertEqual(llm.await_count, 1)
        self.assertEqual(task["llm_trace"]["repair_calls"], 0)
        self.assertEqual(task["llm_trace"]["parse_method"], "strict_json")
        self.assertEqual(task["status"], "succeeded")
        self.assertIn(v4.product_image_role_clause(payload), task["screens"][0]["prompt"])
        self.assertIn(v4.reference_image_role_clause(payload), task["screens"][0]["prompt"])


if __name__ == "__main__":
    unittest.main()
