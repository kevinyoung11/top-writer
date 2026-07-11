截至 2026-07-10，我调研到的结论是：视频脚本工作台的最佳实践不是“AI 一键写稿”，而是把创作者真实流程结构化：选题 brief → 资料/参考 → 大纲 → 口播稿 → 分镜/B-roll → 拍摄清单 → 复盘。

**核心发现**

1. **先有 brief，再写脚本**
   社区里反复提到：脚本前要先明确受众、平台、视频目标、核心观点和素材风格。Clipchamp 的指南也把目标、受众、平台、研究主题、素材需求放在写稿之前。
   来源：[Clipchamp 视频脚本指南](https://clipchamp.com/zh-hans/blog/writing-video-scripts-guide/)

2. **大纲比全文更重要**
   Reddit 创作者常见做法是先拆 section / bullet points，再扩成完整稿；视频论文类常用“hook → suspense/body → payoff ending”。也有人只用关键词稿来保持自然，但仍强调必须先有 outline。
   来源：[Reddit: How write a YouTube script/outline?](https://www.reddit.com/r/NewTubers/comments/ts4625/how_write_a_youtube_scriptoutline/)、[Reddit: video essay workflow](https://www.reddit.com/r/youtubers/comments/zvyqxb/people_who_make_video_essays_how_do_you_manage_to/)

3. **脚本必须服务拍摄和剪辑，不只是文案**
   好的工作台应该支持 AV script：口播/旁白、画面、B-roll、字幕、屏幕文字、道具、镜头、素材状态分列管理。Descript 和 Later 的实践都指向这一点：B-roll 要和脚本对齐，shot list 要追踪状态、镜头类型、平台、脚本链接、制作备注。
   来源：[Descript B-roll workflow](https://www.descript.com/tools/add-broll-video)、[Later Shot List Template](https://later.com/resources/downloadable/shot-list-template-notion/)

4. **首 30 秒是单独的产品对象**
   YouTube 官方 retention 报告会单独看前 30 秒，且建议检查标题/缩略图/开头内容是否匹配预期。脚本工作台里应该把 hook、标题、封面承诺、开头兑现做成一个检查区，而不是藏在正文里。
   来源：[YouTube audience retention](https://support.google.com/youtube/answer/9314415?hl=en)

5. **写稿要有多轮：初稿、删减、口语化、读稿计时**
   Reddit 里高频做法是先写完整初稿，再逐段压缩，第三轮打磨表达；Teleprompter.com 也强调清晰主旨、强 hook、简单口语、视觉提示、完整朗读检查。
   来源：[Reddit: How to script your videos?](https://www.reddit.com/r/NewTubers/comments/1ipumcn/how_to_script_your_videos/)、[Teleprompter script mistakes](https://www.teleprompter.com/blog/video-script-writing-mistakes)

6. **AI 最适合做分阶段助手，不适合直接替代作者**
   X/Twitter 和 AI 创作者社区里很多“全自动 faceless YouTube”流程，但高质量讨论都指向同一件事：AI 应该辅助研究、结构、hook 变体、B-roll 建议、标题封面、复盘，而不是直接输出最终稿。否则容易变成同质化 AI 内容。

**我建议你的工作台这样设计**

P0 核心模块：

- `项目 brief`：平台、时长、目标受众、核心观点、视频类型、参考账号、禁忌、语气。
- `资料区`：链接、评论、竞品视频、历史脚本、引用片段、素材标签。
- `结构板`：hook、问题、冲突、论点、案例、转折、结尾 CTA，每个 section 可拖拽。
- `脚本编辑器`：按段落/镜头管理，而不是一个长文本框。字段包括：口播、画面、B-roll、屏幕字、素材、预计秒数、状态。
- `读稿与时长`：字数估算、语速、预计时长、超时提醒、口语化检查。
- `拍摄清单`：从脚本自动生成 A-roll、B-roll、道具、屏幕录制、素材缺口。
- `导出`：Markdown、分镜表、提词器文本、字幕草稿、剪辑备注。

P1 增强模块：

- `Hook 工作台`：生成/比较多个开头，检查是否兑现标题和封面承诺。
- `B-roll 建议`：基于每段口播推荐画面、素材关键词、镜头类型。
- `AI 审稿`：检查废话、信息过载、跳跃、弱转场、无证据断言。
- `版本管理`：初稿、删减稿、拍摄稿、剪辑后稿。
- `复盘库`：记录发布后的 retention dips/spikes、评论反馈、标题 CTR，把高表现结构沉淀成模板。

P2 长期壁垒：

- `素材/知识库`：像 Beav 这种方向，把网页、评论、视频转写、图片、历史稿件沉淀为可检索资产，而不是每次从聊天开始。
  来源：[Beav GitHub](https://github.com/Jamailar/Beav)
- `数据闭环`：把 YouTube/B站/小红书发布数据回填到脚本段落，知道哪种 hook、结构、B-roll 真有效。
- `团队协作`：编剧、拍摄、剪辑、运营在同一个脚本项目里看不同视图。

**一句话产品原则**

不要做“AI 写脚本聊天框”。做一个结构化的视频创作操作台：让创作者把想法、素材、脚本、镜头、B-roll、时长和复盘都沉淀下来，AI 只是在每一步帮他更快、更稳、更可复用。


---


对，那你的产品方向应该彻底从“视频生产工作台”改成“深度文本创作工作台”。视频脚本只是最终输出格式之一，核心不是分镜、TTS、字幕、剪辑，而是：选题判断、观点挖掘、资料组织、论证结构、表达打磨、版本演进。

我会把前面结论修正成这样：

**不建议作为主底座**

| 项目 | 为什么不适合主线 |
|---|---|
| [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) | 偏自动成片，文本只是流水线中间产物，不适合“写深” |
| [OpenCut](https://github.com/OpenCut-app/OpenCut) | 偏视频编辑器，太后链路 |
| Shorts 自动化项目 | 都在优化发布效率，不在优化内容质量 |

**更适合你的 GitHub 方向**

| 项目 | 适合借鉴什么 | 许可证 |
|---|---|---|
| [langchain-ai/local-deep-researcher](https://github.com/langchain-ai/local-deep-researcher) | 本地深度研究、资料收集、报告生成 | MIT |
| [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm) | 本地知识库、RAG、工作区、文档问答 | MIT |
| [GeekyWizKid/writing-helper](https://github.com/GeekyWizKid/writing-helper) | 多模型写作助手、风格定制、内容创作 UI | MIT |
| [guoguo-tju/write_agent](https://github.com/guoguo-tju/write_agent) | FastAPI + LangGraph + RAG 的写作/改写/审稿链路 | MIT |
| [poloclub/wordflow](https://github.com/poloclub/wordflow) | 可定制写作助手、prompt 工作流 | MIT |
| [ExplosiveCoderflome/AI-Novel-Writing-Assistant](https://github.com/ExplosiveCoderflome/AI-Novel-Writing-Assistant) | 长文本规划、世界观/结构/RAG/整本生产流 | 许可证需核实，不建议直接商用二开 |

**我建议你的产品定位**

不是“AI 帮我写一个视频脚本”，而是：

> 一个面向创作者的深度内容写作工作台，把素材、观点、论证、草稿、改稿和最终脚本串起来。

核心模块应该是：

1. **选题工作台**
   记录选题、目标受众、冲突点、核心问题、反常识角度、为什么现在值得讲。

2. **资料库**
   收集网页、文章、视频转录、书摘、评论、历史素材。每个资料都能打标签、引用、摘要、关联到段落。

3. **观点池**
   不直接写正文，先沉淀观点：主张、证据、案例、反方观点、可展开问题。

4. **结构编辑器**
   用卡片组织内容：开头、背景、问题、冲突、论证、案例、转折、结尾。重点是结构深度，不是字数。

5. **段落级写作**
   每一段都有目的：提出问题、解释概念、举例、反驳、转场、升华。AI 只在段落级辅助。

6. **审稿系统**
   检查空话、跳跃、重复、证据不足、观点不清、口播不自然、信息密度不均。

7. **视频脚本导出**
   最后才把深度文本转换成视频格式：口播稿、标题、开头 hook、分镜建议、B-roll 提示。

**技术路线**

我会优先组合：

- 知识库/RAG：`AnythingLLM` 或自己用 LangChain/LlamaIndex 做轻量版
- 深度研究：参考 `local-deep-researcher`
- 写作工作流：参考 `writing-helper` + `write_agent`
- 编辑器：Tiptap / ProseMirror / Lexical
- 后端：FastAPI + PostgreSQL + pgvector
- 工作流：LangGraph，负责“研究 → 大纲 → 初稿 → 审稿 → 改稿”

最小 MVP 不要做视频功能。先做一个能把内容写深的系统：

`选题 brief → 资料收集 → 观点池 → 大纲 → 段落写作 → AI 审稿 → 改稿 → 导出 Markdown/口播稿`

这个方向比自动成片更有价值，也更符合你说的“文本内容深度”。



---



截至 2026-07-10，我看了一轮 GitHub，结论是：可以二开，但不要直接找“AI 视频脚本生成器”这个关键词，结果大多是 demo。更靠谱的路线是用成熟的“AI 成片/视频生产流水线”做后端能力，再自己做脚本工作台 UI 和数据模型。

**优先推荐**

| 项目 | 适合二开方向 | 许可证/风险 | 判断 |
|---|---|---|---|
| [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) | 脚本生成、素材关键词、TTS、字幕、素材下载、视频合成、发布 | MIT，活跃，约 96k stars | 最值得作为后端底座 |
| [handsomejustin/ai-video-script-generator](https://github.com/handsomejustin/ai-video-script-generator) | 短视频脚本工作台原型：标题、前 5 秒、脚本、分镜、存储 | MIT，小项目，约 22 stars | 最贴近“脚本工作台”，但工程要重构 |
| [gongxings/ai-creator](https://github.com/gongxings/ai-creator) | AI 创作者平台、写作工具、多模型、发布系统 | MIT，FastAPI + Vue + MySQL + Redis | 可借鉴平台架构，不建议直接重度二开 |
| [poyrazemun/youtube-shorts-generator](https://github.com/poyrazemun/youtube-shorts-generator) | 选题评分、脚本审阅暂停、场景规划、事实检查、成本追踪、复盘反馈 | MIT，小而完整 | 很适合借鉴“创作流水线”设计 |
| [OpenCut](https://github.com/OpenCut-app/OpenCut) | 视频编辑器/时间线/素材管理底座 | MIT，约 61k stars，但正在重写 | 适合做未来编辑器底座，当前要谨慎 |
| [Revideo](https://github.com/midrender/revideo) | 结构化脚本转程序化视频渲染 | MIT，TypeScript | 适合从脚本段落生成预览/成片 |

**不建议直接二开的，但值得研究**

- [SamurAIGPT/AI-Youtube-Shorts-Generator](https://github.com/SamurAIGPT/AI-Youtube-Shorts-Generator)：高光检测、Whisper 转写、竖屏裁切很强，但 GitHub 元数据里未识别到许可证，商业二开风险较高。
- [OpenMontage](https://github.com/calesthio/OpenMontage)：能力很强，agentic video production，包含脚本、素材、审批、Backlot 看板、Remotion 合成，但 AGPLv3，除非你接受开源整个衍生服务，否则只适合研究架构。
- [Remotion](https://github.com/remotion-dev/remotion)：生态成熟，但 licenseInfo 是 Other，商业使用要单独核对条款；如果只是开源/内部实验没问题，商业产品要谨慎。

**我建议的二开路线**

最快 MVP：

1. 用 `handsomejustin/ai-video-script-generator` 的思路起步，但不要沿用它的单文件 Flask 架构。
2. 后端参考 `MoneyPrinterTurbo` 的服务拆分：`llm`、`material`、`voice`、`subtitle`、`video`、`task`。
3. 数据模型重新设计为：`Project`、`Brief`、`ScriptSection`、`Scene`、`BrollCue`、`Asset`、`ReviewNote`、`Version`。
4. 引入 `poyrazemun/youtube-shorts-generator` 的能力：选题评分、脚本审阅暂停、事实检查、成本记录、复盘反馈。
5. 如果要做视频预览，用 `Revideo`；如果要做完整时间线编辑，再评估 `OpenCut classic` 或等新版 OpenCut 稳定。

**推荐技术组合**

- 后端：FastAPI + PostgreSQL/MySQL + Redis + Celery/RQ
- 前端：Next.js 或 Vue 3，重点做结构化脚本编辑器
- AI：OpenAI/Claude/Qwen/Ollama 多模型适配
- 视频链路：MoneyPrinterTurbo 的素材、TTS、字幕、合成逻辑
- 渲染预览：Revideo
- 编辑器底座：OpenCut 作为中长期选项

一句话：如果目标是“写视频脚本的工作台”，不要 fork 一个自动成片工具就改 UI。最佳路线是以 MoneyPrinterTurbo 做能力层，自己重做脚本项目模型和编辑体验，再吸收 poyrazemun 的流水线设计。



我建议你不要找一个“大而全”的项目直接 fork。这个链条最好的跳板，是按环节拼一个工作台骨架：

`研究 agent + 网页采集 + 知识库/RAG + 块级编辑器 + 写作工作流 + 审稿 linter + 导出器`

**总架构推荐**

| 环节 | 最精准跳板 | 作用 |
|---|---|---|
| 选题 brief | [GPT Researcher](https://github.com/assafelovic/gpt-researcher) / [Open Deep Research](https://github.com/langchain-ai/open_deep_research) | 把选题变成研究问题、子问题、资料计划 |
| 资料收集 | [Crawl4AI](https://github.com/unclecode/crawl4ai) | 抓网页并转成 LLM 友好的 Markdown |
| 资料沉淀 | [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) | 本地知识库、RAG、工作区模型 |
| 观点池 | [Logseq](https://github.com/logseq/logseq) / [SiYuan](https://github.com/siyuan-note/siyuan) | 双链、块引用、观点卡片、资料关系 |
| 大纲 | [Open Deep Research](https://github.com/langchain-ai/open_deep_research) 的 report plan / LangGraph | 人在环路的大纲规划、可反馈迭代 |
| 段落写作 | [Tiptap](https://github.com/ueberdosis/tiptap) / [Lexical](https://github.com/facebook/lexical) | 深度文本编辑器底座 |
| AI 审稿 | [write_agent](https://github.com/guoguo-tju/write_agent) + [Vale](https://github.com/vale-cli/vale) + [textlint](https://github.com/textlint/textlint) | LLM 审稿 + 规则型文本 lint |
| 改稿 | [GeekyWizKid/writing-helper](https://github.com/GeekyWizKid/writing-helper) / write_agent | 风格定制、重写、审阅循环 |
| 导出 | [markdown-it](https://github.com/markdown-it/markdown-it) + [Pandoc](https://github.com/jgm/pandoc) | Markdown、HTML、DOCX、PDF、口播稿导出 |

**逐环节判断**

1. **选题 brief**
   最好不要用那些 `content-brief-generator` 小项目，质量普遍偏 SEO 小工具。更好的跳板是 `GPT Researcher`：它有 planner/executor/publisher 架构，会把一个主题拆成研究问题、收集资料、总结来源、生成报告。
   如果你要可控流程，优先看 `Open Deep Research`，它基于 LangGraph，支持模型、搜索工具、MCP 配置，也有 plan-and-execute / human-in-loop 思路。

2. **资料收集**
   首选 `Crawl4AI`，Apache-2.0，比 Firecrawl 更适合二开商业产品。Firecrawl 很强但 AGPLv3，除非你接受开源服务端，否则不建议作为内嵌底座。
   如果你还要“资料存档”，可以借鉴 `ArchiveBox` 的归档思路，但不要把它作为主采集器。

3. **观点池**
   这里的关键不是聊天，而是“卡片化观点”。可以借鉴 Logseq/SiYuan 的块级模型：每个观点是一个 block，能引用资料、关联反方观点、挂证据。
   但 Logseq、SiYuan 都是 AGPL，不建议直接 fork 商用。更适合学习数据模型：block、backlink、page、tag、reference。

4. **大纲**
   最适合跳板是 `Open Deep Research` 的 report planning：先生成章节计划，再允许用户反馈，再进入写作。
   你可以把大纲设计成：主张、问题、证据、案例、反方、转折、结论，而不是普通 H2/H3。

5. **段落写作**
   编辑器底座首选 `Tiptap`。它是 MIT、生态成熟、基于 ProseMirror，适合做“段落卡片 + AI 操作菜单 + 引用来源 + 评论审稿”。
   如果你更重性能和复杂编辑行为，可看 `Lexical`。如果你更偏 Markdown WYSIWYG，可看 `Milkdown`。

6. **AI 审稿**
   不要只用 LLM。推荐三层：
   - `Vale`：风格规则、禁用词、冗余表达、品牌语气。
   - `textlint`：Markdown/中文文本规则扩展。
   - `write_agent`：LLM 审稿、RAG 引用、draft → review → retry 的循环。

   这样审稿才稳定，不会每次都靠 prompt 运气。

7. **改稿**
   `write_agent` 是最贴近你的，它已经有素材库、RAG、风格提取、改写、review、人工修订的闭环。
   `writing-helper` 更轻，适合参考“风格编辑器”和多模型配置，但产品深度不如 write_agent。

8. **导出 Markdown/口播稿**
   Markdown 渲染用 `markdown-it`。多格式导出用 `Pandoc`，但 Pandoc 是 GPLv2，如果是服务端内部调用通常要仔细确认合规边界。
   口播稿导出不需要复杂项目，自己做模板更好：`标题 / 开头 hook / 正文口播 / 重点停顿 / B-roll 提示 / CTA`。

**最推荐的 MVP 拼法**

- 后端：FastAPI + PostgreSQL + pgvector
- 工作流：LangGraph
- 采集：Crawl4AI
- 研究：参考 GPT Researcher / Open Deep Research
- 编辑器：Tiptap
- 审稿：Vale + textlint + LLM review
- 写作闭环：参考 write_agent
- 导出：Markdown-it + 自定义口播稿模板

**真正的“精准跳板”排序**

1. [write_agent](https://github.com/guoguo-tju/write_agent)：最贴近你的写作闭环，优先读。
2. [Open Deep Research](https://github.com/langchain-ai/open_deep_research)：最适合做研究到大纲的工作流。
3. [Crawl4AI](https://github.com/unclecode/crawl4ai)：最适合作为资料收集器。
4. [Tiptap](https://github.com/ueberdosis/tiptap)：最适合作为编辑器底座。
5. [Vale](https://github.com/vale-cli/vale) + [textlint](https://github.com/textlint/textlint)：最适合作为审稿规则引擎。
6. [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm)：适合参考知识库/RAG 工作区，不一定直接 fork。

我的判断：你应该以 `write_agent` 为产品原型参考，以 `Open Deep Research` 做研究流程参考，以 `Tiptap` 重做自己的编辑器体验。这样最接近“写出有深度的文本”，而不是变成另一个 AI 生成器。
