import asyncio
import json
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import main
import detail_page_v4 as v4


def detail_payload(**overrides):
    values = {
        "page_type": "detail",
        "product_images": ["https://example.test/product.png"],
        "reference_images": ["https://example.test/reference.png"],
        "image_provider_id": "image-provider",
        "image_model": "gpt-image-2",
        "llm_provider_id": "vision-provider",
        "llm_model": "gemini-3-flash",
        "aspect_ratio": "3:4",
        "resolution": "2k",
        "size": "1536x2048",
        "quality": "auto",
        "screen_count": 3,
        "copywriting": "required",
        "richness": "concise",
        "font_style": "auto",
        "output_language": "自动识别",
        "model_setting": "use",
        "model_pose": "specific",
        "model_usage": 2,
        "reversal_screens": 1,
        "product_name": "迷你瓶",
        "product_features": "透明瓶身；白色竖纹盖；保持吊牌字符",
        "user_instruction": "请使用中文文案，突出婚礼伴手礼",
    }
    values.update(overrides)
    return main.DetailPageTaskRequest(**values)


FIXED_MODEL_IDENTITY = (
    "25岁左右东亚女性，鹅蛋脸，清晰柔和的杏仁眼与自然平眉，暖象牙肤色，"
    "深棕色自然长微卷发低松束起，身材匀称修长，气质温柔克制且具有高级亲和力，"
    "淡杏色自然妆容，穿低饱和奶油白亚麻连衣裙与浅卡其针织开衫，佩戴极简珍珠耳钉"
)


def planned_prompt(number, *, model=False, reversal=False, screen_class="A"):
    human = (
        f"人物为内部唯一固定模特：{FIXED_MODEL_IDENTITY}；"
        "她以自然站姿靠近桌面，身体微侧，视线落在产品上，一手托住瓶底、另一手轻扶瓶肩，"
        "双手接触点、承托方向和受力关系真实可信，产品与手掌及前臂保持真实生活尺度。"
        if model else
        "本屏为非人物画面，禁止人物、脸部、身体、人体局部、手、腿、剪影、影子、人物反射、背景路人及人物操作；"
        "产品保持日常单手可握的真实生活尺度，瓶底稳定接触桌面，禁止悬浮和比例失真。"
    )
    reversal_text = (
        "画面为反转屏，使用同源深胡桃木、焦糖金和暖象牙白，只改变主色明暗、背景与版式节奏，"
        "不改变产品、卖点、模特身份和叙事事实。"
        if reversal else
        "画面为主基调屏，使用奶油白、蜂蜜木色、香槟金与深胡桃木文字色，保持全组统一视觉母版。"
    )
    return (
        f"使用图1产品帮我设计淘宝详情页其中一屏，审美要顶级，目标画幅3:4。"
        f"本屏为{screen_class}类第{number}屏体验页，唯一购买任务是证明第{number}个清晰且不与其他屏重复的购买理由。"
        "图1产品图只负责锁定真实产品结构、透明轮廓、白色竖纹旋盖、天然麻绳、吊牌、小漏斗、真实比例与可见字符；"
        "产品字符必须原样保留，不翻译、不改写、不重排，不新增图片中不存在的颜色、结构、包装、认证或配件。"
        "图2设计参考图只允许参考字体层级、字色、配色、材质、光影、元素、场景语义、布局方向和视觉节奏；"
        "严格禁止图2中的文字、品牌、产品、包装、模特、人物和具体道具混入目标商品。"
        f"{human}"
        "【镜头】采用略高于桌面的45度斜前方中近景，产品正面略朝向镜头并位于右侧视觉重心，"
        "清楚呈现透明轮廓、瓶口螺纹、白色竖纹盖、麻绳结、吊牌和小漏斗；背景保持舒适浅景深，"
        "透视、接触与焦点符合真实商业摄影规律，不生成夸张广角和重复产品。"
        "【场景】提取图2暖金婚礼长桌、奶油白花艺、原木、亚麻与柔和灯串的场景语义，"
        "采用暖金侧逆光、透明材质边缘高光、低对比阴影和细腻胶片颗粒，禁止复制图2的具体摆放。"
        f"{reversal_text}"
        "【布局】采用上方标题留白、中部单一产品主视觉、底部轻量辅助信息的竖向结构，"
        "主体与文字形成明确阅读动线，只保留一个最强记忆点；避免普通淘宝模板、白底PPT、"
        "密集信息卡、等权拼贴、无意义图标墙和说明书感。"
        f"【文字排版】主标题（深胡桃木字色，优雅手写展示字体，72px，约占画布高度7%，固定字重，"
        f"两行左对齐）：“第{number}屏核心标题”；副标题（暖象牙白字色，典雅衬线字体，32px，"
        "约占画布高度3.1%，固定字重，单行左对齐）：“围绕本屏唯一购买任务的利益说明”；"
        "小字（浅暖灰字色，简洁窄体无衬线，20px，约占画布高度2%，固定字重，单行左对齐）："
        "“真实产品细节与克制辅助信息”。三层字体类型、字号、字重、字色和对齐关系必须跨屏统一。"
        "构图、留白、空间、道具、光影与装饰达到国际头部品牌详情页水准，保证产品和文案可读；"
        "参考图仅用于视觉系统，禁止其中的文字、品牌、产品、包装、模特和人物。"
        "只生成本屏这一张独立完整画面，禁止多宫格、过程图、画框、设备样机、无关解释和产品失真。"
    )


def planner_json(count=3):
    classes = v4.expected_screen_classes(count)
    prompts = [
        planned_prompt(number, model=number <= 2, reversal=number == 2, screen_class=classes[number - 1])
        for number in range(1, count + 1)
    ]
    return json.dumps({"prompts": prompts}, ensure_ascii=False)


class DetailPagePlannerTests(unittest.TestCase):
    def test_desktop_variable_assembly_order_and_language_resolution(self):
        preview = v4.build_planning_request(detail_payload())
        request = preview["request"]
        self.assertEqual(preview["resolved_language"], "中文")
        self.assertLess(request.index("【后台指令】"), request.index("【设置】"))
        self.assertLess(request.index("【设置】"), request.index("【用户指令（创意层最高优先级）】"))
        self.assertLess(request.index("【用户指令（创意层最高优先级）】"), request.index("【目标画幅】"))
        for expected in (
            "输出3屏", "插入反转屏1屏", "图1为产品图", "图2为设计参考图",
            "产品名称：迷你瓶", "文案：需要文案", "输出语种：中文",
            "恰好2屏使用同一固定模特", "姿态：特定姿态", "字体：自动判断",
            "画面丰富度：精简", "突出婚礼伴手礼", "【目标画幅】3:4",
            '只输出严格 JSON：{"prompts"', "prompts 数量必须严格为 3",
        ):
            self.assertIn(expected, request)
        self.assertNotIn("透明瓶身；白色竖纹盖", request)
        self.assertEqual(preview["local_postprocess"]["product_feature_suffix"], "透明瓶身；白色竖纹盖；保持吊牌字符")
        self.assertEqual(preview["image_request"]["model"], "gpt-image-2")
        self.assertEqual(preview["image_roles"], [
            "图1=产品图（产品身份与事实依据）",
            "图2=设计参考图（仅参考视觉系统，禁止复制内容）",
        ])

    def test_auto_language_uses_input_language_then_taobao_chinese_default(self):
        english = detail_payload(product_name="Bottle", product_features="transparent plastic bottle with a white cap and funnel", user_instruction="", output_language="auto")
        self.assertEqual(v4.resolve_output_language(english), "英文")
        empty = detail_payload(product_name="", product_features="", user_instruction="", output_language="自动识别")
        self.assertEqual(v4.resolve_output_language(empty), "中文")
        explicit = detail_payload(user_instruction="所有画面文字使用 English 英文输出", output_language="自动识别")
        self.assertEqual(v4.resolve_output_language(explicit), "英文")

    def test_parser_accepts_strict_fenced_embedded_and_numbered_outputs(self):
        strict = '{"prompts":["A","B"]}'
        self.assertEqual(v4.parse_planning_output(strict, 2), (["A", "B"], "strict_json"))
        self.assertEqual(v4.parse_planning_output(f"```json\n{strict}\n```", 2), (["A", "B"], "fenced_json"))
        self.assertEqual(v4.parse_planning_output(f"结果如下：\n{strict}\n完成", 2), (["A", "B"], "embedded_json"))
        numbered = "1. 第一张完整提示词\n\n2. 第二张完整提示词"
        self.assertEqual(v4.parse_planning_output(numbered, 2), (["第一张完整提示词", "第二张完整提示词"], "numbered_text"))
        merged = json.dumps({"prompts": [numbered]}, ensure_ascii=False)
        self.assertEqual(v4.parse_planning_output(merged, 2), (["第一张完整提示词", "第二张完整提示词"], "strict_json_local_split"))

    def test_parser_rejects_hard_count_empty_and_length_errors(self):
        with self.assertRaises(v4.DetailPagePlanningError):
            v4.parse_planning_output('{"prompts":["A"]}', 2)
        with self.assertRaises(v4.DetailPagePlanningError):
            v4.parse_planning_output('{"prompts":["", "B"]}', 2)
        with self.assertRaises(v4.DetailPagePlanningError):
            v4.parse_planning_output('{"prompts":["123456"]}', 1, max_prompt_length=5)

    def test_v4_contract_rejects_short_prompts_and_accepts_global_masters(self):
        payload = detail_payload()
        with self.assertRaisesRegex(v4.DetailPagePlanningError, f"至少需要 {v4.PLANNING_PROMPT_MIN_LENGTH}"):
            v4.validate_planning_prompts([
                "短提示词",
                "短提示词",
                "短提示词",
            ], payload)
        prompts = json.loads(planner_json())["prompts"]
        v4.validate_planning_prompts(prompts, payload)
        self.assertEqual(v4.expected_screen_classes(7), ["A", "A", "B", "B", "B", "C", "D"])

    def test_v4_contract_accepts_equivalent_wording_instead_of_exact_keywords(self):
        payload = detail_payload(screen_count=1, model_usage=1, reversal_screens=0)
        prompt = planned_prompt(1, model=True)
        prompt = prompt.replace("图1产品图只负责锁定", "忠实呈现图1中的")
        prompt = prompt.replace("人物为内部唯一固定模特：", "本组统一人物设定为：")
        prompt = prompt.replace("真实生活尺度", "自然大小")
        prompt = prompt.replace("字重", "文字粗细").replace("字色", "文字颜色").replace("对齐", "排列方式")
        v4.validate_planning_prompts([prompt], payload)

    def test_system_prompt_keeps_concise_visuals_verbose_and_reserves_long_output(self):
        system = v4.DETAIL_PAGE_V4_SYSTEM_PROMPT
        for marker in (
            "四份全局母版", "逐字重复同一段完整身份", "A、A、B、B、B、C、D",
            "【镜头】", "【场景】", "【布局】", "【文字排版】",
            "精简\u201d只控制画面元素数量", "700 至 1800 个字符",
        ):
            self.assertIn(marker, system)
        self.assertGreater(v4.planning_max_tokens(7), 8192)
        self.assertLessEqual(v4.planning_max_tokens(12), 32768)
        self.assertEqual(
            v4.PLANNING_RESPONSE_SCHEMA["properties"]["prompts"]["items"]["minLength"],
            v4.PLANNING_PROMPT_MIN_LENGTH,
        )

    def test_postprocess_matches_desktop_suffix_and_omits_parameter_dump(self):
        payload = detail_payload(screen_count=1, model_usage=1, reversal_screens=0)
        prompt = v4.postprocess_prompts([planned_prompt(1, model=True)], payload)[0]
        self.assertIn("生图务必保持产品一致性，产品大小比例不可失真：透明瓶身", prompt)
        self.assertNotIn("【所选生成参数】", prompt)
        self.assertNotIn("视觉 LLM：", prompt)


class DetailPageTaskLifecycleTests(unittest.TestCase):
    def test_new_task_uses_product_name_as_its_editable_display_title(self):
        payload = detail_payload(product_name="圣诞香水")
        record = main.new_detail_page_task_record("detail_test_auto_title", payload)
        self.assertEqual(record["title"], "圣诞香水详情页")
        self.assertNotIn("title", record["settings"])

    def test_rename_changes_only_the_persisted_display_title(self):
        task_id = "detail_page_test_rename_title"
        payload = detail_payload(product_name="旧名称")
        record = main.new_detail_page_task_record(task_id, payload)
        original_updated_at = record["updated_at"]
        original_fingerprint = record["config_fingerprint"]
        main.CANVAS_TASKS[task_id] = record

        with tempfile.TemporaryDirectory() as folder, patch.object(main, "DETAIL_PAGE_TASK_DIR", folder):
            renamed = asyncio.run(main.rename_detail_page_task(
                task_id,
                main.DetailPageTaskRenameRequest(title="  圣诞   香水礼盒  "),
            ))
            with open(main.detail_page_task_file(task_id), "r", encoding="utf-8") as handle:
                persisted = json.load(handle)

        self.assertEqual(renamed["title"], "圣诞 香水礼盒")
        self.assertEqual(persisted["title"], "圣诞 香水礼盒")
        self.assertEqual(renamed["updated_at"], original_updated_at)
        self.assertEqual(renamed["config_fingerprint"], original_fingerprint)
        self.assertEqual(renamed["status"], "planning")

    def test_source_image_metadata_is_optional_and_persisted_with_task_settings(self):
        payload = detail_payload(
            product_image_meta=[{"url": "https://example.test/product.png", "name": "产品原图.png", "width": 1200, "height": 1600}],
            reference_image_meta=[{"url": "https://example.test/reference.png", "name": "参考风格.png", "width": 900, "height": 1200}],
        )
        record = main.new_detail_page_task_record("detail_test_source_meta", payload)
        self.assertEqual(record["settings"]["product_image_meta"][0]["name"], "产品原图.png")
        self.assertEqual(record["settings"]["reference_image_meta"][0]["width"], 900)
        legacy = detail_payload()
        self.assertEqual(legacy.product_image_meta, [])
        self.assertEqual(legacy.reference_image_meta, [])

    def tearDown(self):
        for task_id in list(main.CANVAS_TASKS):
            task = main.CANVAS_TASKS.get(task_id) or {}
            if str(task_id).startswith(("detail_test_", "detail_page_test_")) or str(task.get("submission_id") or "") in {
                "11111111-1111-4111-8111-111111111111",
                "22222222-2222-4222-8222-222222222222",
                "33333333-3333-4333-8333-333333333333",
            }:
                main.CANVAS_TASKS.pop(task_id, None)
        main.DETAIL_PAGE_BACKGROUND_TASKS.clear()
        main.DETAIL_PAGE_SCREEN_TASKS.clear()

    def test_config_fingerprint_uses_generation_inputs_but_ignores_submission_metadata(self):
        first = detail_payload(
            submission_id="11111111-1111-4111-8111-111111111111",
            product_image_meta=[{"url": "https://example.test/product.png", "name": "旧名称.png", "width": 800, "height": 1200}],
        )
        same_generation = detail_payload(
            submission_id="22222222-2222-4222-8222-222222222222",
            force_new=True,
            product_image_meta=[{"url": "https://example.test/product.png", "name": "新名称.png", "width": 1600, "height": 2400}],
        )
        changed_generation = detail_payload(
            submission_id="33333333-3333-4333-8333-333333333333",
            image_model="another-image-model",
        )

        first_fingerprint = main.detail_page_config_fingerprint(first)
        self.assertEqual(first_fingerprint, main.detail_page_config_fingerprint(same_generation))
        self.assertNotEqual(first_fingerprint, main.detail_page_config_fingerprint(changed_generation))
        self.assertRegex(first_fingerprint, r"^[0-9a-f]{64}$")

    def test_create_is_idempotent_by_submission_and_reuses_an_active_matching_config(self):
        first_submission = "11111111-1111-4111-8111-111111111111"
        second_submission = "22222222-2222-4222-8222-222222222222"
        first_payload = detail_payload(submission_id=first_submission)
        matching_payload = detail_payload(submission_id=second_submission)
        runner = AsyncMock(return_value=None)

        with tempfile.TemporaryDirectory() as folder, patch.object(main, "DETAIL_PAGE_TASK_DIR", folder), patch.object(main, "run_detail_page_task", runner):
            first = asyncio.run(main.create_detail_page_task(first_payload))
            repeated_transport = asyncio.run(main.create_detail_page_task(first_payload))
            reused_config = asyncio.run(main.create_detail_page_task(matching_payload))
            main.CANVAS_TASKS[first["task_id"]]["status"] = "succeeded"
            repeated_reuse = asyncio.run(main.create_detail_page_task(matching_payload))

        self.assertFalse(first["reused"])
        self.assertEqual(first["reuse_reason"], "")
        self.assertEqual(repeated_transport["task_id"], first["task_id"])
        self.assertEqual(repeated_transport["reuse_reason"], "submission_id")
        self.assertEqual(reused_config["task_id"], first["task_id"])
        self.assertEqual(reused_config["reuse_reason"], "active_config")
        self.assertEqual(repeated_reuse["task_id"], first["task_id"])
        self.assertEqual(repeated_reuse["reuse_reason"], "submission_id")
        self.assertEqual(runner.await_count, 1)
        stored = main.CANVAS_TASKS[first["task_id"]]
        self.assertEqual(stored["submission_id"], first_submission)
        self.assertEqual(stored["submission_ids"], [first_submission, second_submission])
        self.assertEqual(stored["config_fingerprint"], main.detail_page_config_fingerprint(first_payload))

    def test_force_new_bypasses_only_active_config_reuse_and_terminal_tasks_do_not_block(self):
        original_payload = detail_payload(submission_id="11111111-1111-4111-8111-111111111111")
        forced_payload = detail_payload(submission_id="22222222-2222-4222-8222-222222222222", force_new=True)
        after_terminal_payload = detail_payload(submission_id="33333333-3333-4333-8333-333333333333")
        runner = AsyncMock(return_value=None)

        with tempfile.TemporaryDirectory() as folder, patch.object(main, "DETAIL_PAGE_TASK_DIR", folder), patch.object(main, "run_detail_page_task", runner):
            first = asyncio.run(main.create_detail_page_task(original_payload))
            forced = asyncio.run(main.create_detail_page_task(forced_payload))
            repeated_forced = asyncio.run(main.create_detail_page_task(forced_payload))
            main.CANVAS_TASKS[first["task_id"]]["status"] = "succeeded"
            main.CANVAS_TASKS[forced["task_id"]]["status"] = "succeeded"
            after_terminal = asyncio.run(main.create_detail_page_task(after_terminal_payload))

        self.assertNotEqual(forced["task_id"], first["task_id"])
        self.assertFalse(forced["reused"])
        self.assertEqual(repeated_forced["task_id"], forced["task_id"])
        self.assertEqual(repeated_forced["reuse_reason"], "submission_id")
        self.assertNotIn(after_terminal["task_id"], {first["task_id"], forced["task_id"]})
        self.assertEqual(runner.await_count, 3)

    def test_normal_flow_uses_one_selected_visual_llm_and_concurrent_images(self):
        payload = detail_payload()
        task_id = "detail_test_single_call"
        main.CANVAS_TASKS[task_id] = main.new_detail_page_task_record(task_id, payload)
        llm = AsyncMock(return_value={"text": planner_json()})
        starts = []
        all_started = asyncio.Event()

        async def fake_image(request):
            starts.append(request.prompt)
            if len(starts) == 3:
                all_started.set()
            await asyncio.wait_for(all_started.wait(), timeout=1)
            if "第3屏核心标题" in request.prompt:
                raise RuntimeError("third failed")
            return {"images": [f"/output/{len(starts)}.png"]}

        with patch.object(main, "execute_canvas_llm", llm), patch.object(main, "build_online_image_result", side_effect=fake_image):
            asyncio.run(main.run_detail_page_task(task_id, payload))

        task = main.CANVAS_TASKS[task_id]
        self.assertEqual(llm.await_count, 1)
        request = llm.await_args.args[0]
        self.assertEqual(request.provider, "vision-provider")
        self.assertEqual(request.model, "gemini-3-flash")
        self.assertEqual(request.images, [*payload.product_images, *payload.reference_images])
        self.assertEqual(request.temperature, 0.7)
        self.assertEqual(request.max_tokens, 8192)
        self.assertEqual(request.response_schema, v4.PLANNING_RESPONSE_SCHEMA)
        self.assertEqual(len(starts), 3)
        self.assertEqual(task["status"], "partial")
        self.assertEqual(task["llm_trace"]["planning_calls"], 1)
        self.assertEqual(task["llm_trace"]["compilation_calls"], 0)
        self.assertEqual(task["llm_trace"]["repair_calls"], 0)
        self.assertEqual(task["screens"][0]["prompt"], task["screens"][0]["submitted_prompt"])
        self.assertEqual(task["screens"][0]["prompt"], starts[0])
        self.assertEqual(task["screens"][2]["status"], "failed")

    def test_hard_planning_error_repairs_once_with_same_model(self):
        payload = detail_payload(screen_count=1, model_usage=1, reversal_screens=0)
        task_id = "detail_test_repair"
        main.CANVAS_TASKS[task_id] = main.new_detail_page_task_record(task_id, payload)
        llm = AsyncMock(side_effect=[{"text": '{"prompts":[]}'}, {"text": json.dumps({"prompts": [planned_prompt(1, model=True)]}, ensure_ascii=False)}])
        image = AsyncMock(return_value={"images": ["/output/repaired.png"]})
        with patch.object(main, "execute_canvas_llm", llm), patch.object(main, "build_online_image_result", image):
            asyncio.run(main.run_detail_page_task(task_id, payload))
        task = main.CANVAS_TASKS[task_id]
        self.assertEqual(llm.await_count, 2)
        self.assertTrue(all(call.args[0].provider == "vision-provider" for call in llm.await_args_list))
        self.assertEqual(task["llm_trace"]["planning_calls"], 1)
        self.assertEqual(task["llm_trace"]["repair_calls"], 1)
        self.assertEqual(task["status"], "succeeded")

    def test_structurally_valid_but_short_planning_result_repairs_before_images(self):
        payload = detail_payload(screen_count=1, model_usage=1, reversal_screens=0)
        task_id = "detail_test_short_repair"
        main.CANVAS_TASKS[task_id] = main.new_detail_page_task_record(task_id, payload)
        short = json.dumps({"prompts": [
            "使用图1产品帮我设计淘宝详情页其中一屏，审美要顶级，目标画幅3:4。"
            "本屏为A类首屏KV，唯一购买任务是建立产品第一印象。"
        ]}, ensure_ascii=False)
        repaired = json.dumps({"prompts": [planned_prompt(1, model=True)]}, ensure_ascii=False)
        llm = AsyncMock(side_effect=[{"text": short}, {"text": repaired}])
        submitted = []

        async def fake_image(request):
            submitted.append(request.prompt)
            return {"images": ["/output/quality-repaired.png"]}

        with patch.object(main, "execute_canvas_llm", llm), patch.object(main, "build_online_image_result", side_effect=fake_image):
            asyncio.run(main.run_detail_page_task(task_id, payload))
        task = main.CANVAS_TASKS[task_id]
        self.assertEqual(llm.await_count, 2)
        self.assertEqual(task["llm_trace"]["repair_calls"], 1)
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(len(submitted), 1)
        self.assertGreaterEqual(len(submitted[0].replace("\n", "")), v4.PLANNING_PROMPT_MIN_LENGTH)
        self.assertNotIn("建立产品第一印象。\n生图务必", submitted[0])

    def test_second_invalid_planning_result_fails_without_images(self):
        payload = detail_payload()
        task_id = "detail_test_invalid"
        main.CANVAS_TASKS[task_id] = main.new_detail_page_task_record(task_id, payload)
        llm = AsyncMock(side_effect=[{"text": "bad"}, {"text": "still bad"}])
        image = AsyncMock()
        with patch.object(main, "execute_canvas_llm", llm), patch.object(main, "build_online_image_result", image):
            asyncio.run(main.run_detail_page_task(task_id, payload))
        self.assertEqual(llm.await_count, 2)
        image.assert_not_awaited()
        self.assertEqual(main.CANVAS_TASKS[task_id]["status"], "failed")
        self.assertIn("规划修复失败", main.CANVAS_TASKS[task_id]["error"])

    def test_four_candidate_regeneration_preserves_old_candidates(self):
        payload = detail_payload(screen_count=1, model_usage=1, reversal_screens=0)
        task_id = "detail_test_candidates"
        record = main.new_detail_page_task_record(task_id, payload)
        record["status"] = "succeeded"
        record["screens"] = main.detail_page_screen_records(v4.infer_screen_records([planned_prompt(1, model=True)], payload))
        record["screens"][0].update({"status": "succeeded", "candidates": [{"id": "old", "status": "succeeded", "result": {"images": ["/output/old.png"]}, "image_url": "/output/old.png"}], "selected_candidate": 0, "result": {"images": ["/output/old.png"]}})
        main.CANVAS_TASKS[task_id] = record
        counter = 0

        async def fake_image(_request):
            nonlocal counter
            counter += 1
            return {"images": [f"/output/new-{counter}.png"]}

        with patch.object(main, "build_online_image_result", side_effect=fake_image):
            asyncio.run(main.run_detail_page_regeneration(task_id, payload, 1, "edited prompt", candidate_count=4))
        screen = main.CANVAS_TASKS[task_id]["screens"][0]
        self.assertEqual(len(screen["candidates"]), 5)
        self.assertEqual(screen["selected_candidate"], 4)
        self.assertEqual(screen["result"]["images"], ["/output/new-4.png"])
        self.assertEqual(screen["prompt"], "edited prompt")

    def test_failed_sibling_screens_can_regenerate_concurrently(self):
        async def scenario():
            payload = detail_payload(screen_count=2, model_usage=1, reversal_screens=0)
            task_id = "detail_test_parallel_regeneration"
            prompts = [
                planned_prompt(1, model=True, screen_class="A"),
                planned_prompt(2, model=False, screen_class="D"),
            ]
            record = main.new_detail_page_task_record(task_id, payload)
            record["status"] = "partial"
            record["screens"] = main.detail_page_screen_records(v4.infer_screen_records(prompts, payload))
            for screen in record["screens"]:
                screen["status"] = "failed"
                screen["error"] = "upstream disconnected"
            main.CANVAS_TASKS[task_id] = record

            started = []
            both_started = asyncio.Event()

            async def fake_image(request):
                started.append(request.prompt)
                if len(started) == 2:
                    both_started.set()
                await asyncio.wait_for(both_started.wait(), timeout=1)
                return {"images": [f"/output/retry-{len(started)}.png"]}

            with patch.object(main, "build_online_image_result", side_effect=fake_image):
                await main.regenerate_detail_page_screen(
                    task_id, 1, main.DetailPageRegenerateRequest(prompt=prompts[0], count=1)
                )
                first_snapshot = main.CANVAS_TASKS[task_id]
                self.assertEqual(first_snapshot["status"], "generating")
                self.assertEqual(first_snapshot["screens"][0]["status"], "queued")
                self.assertEqual(first_snapshot["screens"][1]["status"], "failed")

                await main.regenerate_detail_page_screen(
                    task_id, 2, main.DetailPageRegenerateRequest(prompt=prompts[1], count=1)
                )
                registered = dict(main.DETAIL_PAGE_SCREEN_TASKS[task_id])
                self.assertEqual(set(registered), {1, 2})
                await asyncio.gather(*registered.values())
                await asyncio.sleep(0)

            finished = main.CANVAS_TASKS[task_id]
            self.assertEqual(len(started), 2)
            self.assertEqual(finished["status"], "succeeded")
            self.assertTrue(all(screen["status"] == "succeeded" for screen in finished["screens"]))
            self.assertNotIn(task_id, main.DETAIL_PAGE_SCREEN_TASKS)

        asyncio.run(scenario())

    def test_patch_candidate_reorder_and_screen_delete(self):
        payload = detail_payload(screen_count=2, model_usage=1, reversal_screens=0)
        task_id = "detail_test_edit"
        record = main.new_detail_page_task_record(task_id, payload)
        record["status"] = "succeeded"
        record["screens"] = main.detail_page_screen_records(v4.infer_screen_records([planned_prompt(1, model=True), planned_prompt(2)], payload))
        record["screens"][0]["candidates"] = [
            {"id": "a", "status": "succeeded", "result": {"images": ["/output/a.png"]}, "image_url": "/output/a.png"},
            {"id": "b", "status": "succeeded", "result": {"images": ["/output/b.png"]}, "image_url": "/output/b.png"},
        ]
        main.CANVAS_TASKS[task_id] = record
        patched = asyncio.run(main.patch_detail_page_screen(task_id, 1, main.DetailPageScreenPatchRequest(prompt="saved", selected_candidate=1, generation_params={"resolution": "4k", "secret": "ignored"})))
        self.assertEqual(patched["screens"][0]["prompt"], "saved")
        self.assertEqual(patched["screens"][0]["result"]["images"], ["/output/b.png"])
        self.assertEqual(patched["screens"][0]["generation_params"], {"resolution": "4k"})
        reordered = asyncio.run(main.reorder_detail_page_screens(task_id, main.DetailPageScreenReorderRequest(screen_order=[2, 1])))
        self.assertEqual([item["screen_no"] for item in reordered["screens"]], [2, 1])
        deleted = asyncio.run(main.delete_detail_page_screen(task_id, 2))
        self.assertEqual([item["screen_no"] for item in deleted["screens"]], [1])

    def test_persistence_marks_active_work_interrupted_after_restart(self):
        payload = detail_payload(screen_count=1, model_usage=1, reversal_screens=0)
        with tempfile.TemporaryDirectory() as folder, patch.object(main, "DETAIL_PAGE_TASK_DIR", folder):
            task_id = "detail_page_test_restart"
            record = main.new_detail_page_task_record(task_id, payload)
            record["status"] = "generating"
            record["screens"] = main.detail_page_screen_records(v4.infer_screen_records([planned_prompt(1, model=True)], payload))
            record["screens"][0]["status"] = "generating"
            main.detail_page_persist_task(record)
            main.CANVAS_TASKS.pop(task_id, None)
            main.load_persisted_detail_page_tasks()
            restored = main.CANVAS_TASKS[task_id]
            self.assertEqual(restored["status"], "interrupted")
            self.assertEqual(restored["screens"][0]["status"], "interrupted")
            self.assertNotIn("system_prompt", restored)
            self.assertNotIn("raw_llm_response", restored)

    def test_download_zip_uses_selected_candidate(self):
        payload = detail_payload(screen_count=1, model_usage=1, reversal_screens=0)
        task_id = "detail_test_zip"
        record = main.new_detail_page_task_record(task_id, payload)
        record["status"] = "succeeded"
        record["screens"] = main.detail_page_screen_records(v4.infer_screen_records([planned_prompt(1, model=True)], payload))
        record["screens"][0].update({"candidates": [{"status": "succeeded", "image_url": "/output/chosen.png", "result": {"images": ["/output/chosen.png"]}}], "selected_candidate": 0})
        main.CANVAS_TASKS[task_id] = record
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as handle:
            handle.write(b"image-bytes")
            path = handle.name
        try:
            with patch.object(main, "output_file_from_url", return_value=path):
                response = asyncio.run(main.download_detail_page_task(task_id))
            self.assertEqual(response.media_type, "application/zip")
            self.assertIn(b"screen-01", response.body)
        finally:
            os.remove(path)

    def test_prompt_optimization_saves_candidates_without_generating(self):
        payload = detail_payload(screen_count=1, model_usage=1, reversal_screens=0)
        task_id = "detail_test_optimize"
        record = main.new_detail_page_task_record(task_id, payload)
        record["status"] = "succeeded"
        record["screens"] = main.detail_page_screen_records(v4.infer_screen_records([planned_prompt(1, model=True)], payload))
        main.CANVAS_TASKS[task_id] = record
        llm = AsyncMock(return_value={"text": json.dumps({"prompts": ["optimized A", "optimized B"]})})
        image = AsyncMock()
        request = main.DetailPagePromptOptimizeRequest(instruction="更克制", prompt=planned_prompt(1, model=True), candidate_count=2)
        with patch.object(main, "execute_canvas_llm", llm), patch.object(main, "build_online_image_result", image):
            result = asyncio.run(main.optimize_detail_page_prompt(task_id, 1, request))
        self.assertEqual([item["prompt"] for item in result["prompt_candidates"]], [
            "optimized A\n生图务必保持产品一致性，产品大小比例不可失真：透明瓶身；白色竖纹盖；保持吊牌字符",
            "optimized B\n生图务必保持产品一致性，产品大小比例不可失真：透明瓶身；白色竖纹盖；保持吊牌字符",
        ])
        self.assertEqual(llm.await_count, 1)
        image.assert_not_awaited()
        self.assertEqual(main.CANVAS_TASKS[task_id]["llm_trace"]["optimize_calls"], 1)

    def test_resume_and_cancel_operate_only_on_unfinished_screens(self):
        async def scenario():
            payload = detail_payload(screen_count=2, model_usage=1, reversal_screens=0)
            task_id = "detail_test_resume"
            record = main.new_detail_page_task_record(task_id, payload)
            record["status"] = "partial"
            record["screens"] = main.detail_page_screen_records(v4.infer_screen_records([planned_prompt(1, model=True), planned_prompt(2)], payload))
            record["screens"][0].update({"status": "succeeded", "result": {"images": ["/output/keep.png"]}})
            record["screens"][1]["status"] = "failed"
            main.CANVAS_TASKS[task_id] = record
            with patch.object(main, "build_online_image_result", AsyncMock(return_value={"images": ["/output/resumed.png"]})):
                resumed = await main.resume_detail_page_task(task_id)
                self.assertEqual(resumed["status"], "generating")
                background = main.DETAIL_PAGE_BACKGROUND_TASKS[task_id]
                await background
            finished = main.CANVAS_TASKS[task_id]
            self.assertEqual(finished["status"], "succeeded")
            self.assertEqual(finished["screens"][0]["result"]["images"], ["/output/keep.png"])

            finished["status"] = "generating"
            sleeper = asyncio.create_task(asyncio.sleep(60))
            main.DETAIL_PAGE_BACKGROUND_TASKS[task_id] = sleeper
            cancelled = await main.cancel_detail_page_task(task_id)
            await asyncio.gather(sleeper, return_exceptions=True)
            self.assertEqual(cancelled["status"], "cancelled")
            self.assertTrue(sleeper.cancelled())

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
