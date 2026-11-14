# Changelog

## v1.23.0

- 新增 `creative_project_save`：Agent 把成品保存进命名项目
- 新增 `creative_project_list`：Agent 先查询项目再决定归档位置
- Agent preset 升级到 1.1.0：明确“计划 → 调用 → 校验 → 入库 → 报告”工作方式
- 项目最多保留 20 版快照，可恢复上一版
- 视频方案支持逐段修改入点/出点、移除和撤销
- ASR 配置与测试连接；视频转写后可回填台词
- 12 个 `creative_*` Agent 工具，对话内工具卡显示运行/完成/失败、摘要和打开文件夹
- README 重写为完整仓库介绍；新增静态测试、CI、MODELS、SECURITY 与 CONTRIBUTING

## v1.21.1

- 视频逐段改时间；项目版本快照；`Ctrl+Shift+M` 快捷键
- ASR mock 链路验证：抽音频 → `/audio/transcriptions` → 时间台词
- 绿色文档预览与冒烟测试

## v1.19.0 — v1.20.2

- 生图/语言/ASR 测试连接与模型发现
- 视频按描述剪、方案预览、撤销、SRT 回退
- 最近成品与项目工作区
- 自定义声线试听、重命名、删除
- MuRaSame Agent preset

## v1.0.0

- 首个版本：生图、优化、超分、视频时间线、TTS、字幕与 PR XML
