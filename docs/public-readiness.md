# 仓库公开化检查记录

## 范围与结论

检查对象包括 7 个插件的源码、测试、配置、依赖与发布入口，以及工程复原文档，包括 `packages/opencode-a2a/` 。
按维护者确认，以清理后的当前快照重建单一初始提交，作为 `main` 和 `v0.1.0` 的共同历史起点。工程会话文档保留，并继续排除在 npm 包之外。

通用化修正、模式脱敏和包级检查已完成。旧提交不纳入重建后的历史；真实 TUI 回归仍有下述待处理项，因此不能把当前仓库直接标记为“所有发布验收完成”。

## 修改依据

| 位置 | 原问题 | 处理 |
| --- | --- | --- |
| 各包 README、测试 | 示例含个人主目录、内部服务地址和私有模型标识；部分安装方式依赖已有旧标签 | 改为相对路径、保留域名及模拟模型；说明发布后的 npm 安装和可配置选项 |
| `packages/opencode-recall/doc/` | 工程记录包含真实会话/消息/追踪 ID、业务工单和检索出的私人场景 | 保留工程步骤和技术证据；ID 一致化为虚构别名，业务与网络标识泛化。标注历史片段不等于当前配置 |
| `packages/opencode-reask/src/index.ts` | 宿主缺少 API 时读取本机服务凭据并连接固定端口；模块级缓存可能跨实例混用答案 | 使用当前宿主 API，缺少能力时报兼容性错误；缓存归属当前实例 |
| `packages/opencode-auto-rename/src/index.ts` | 已处理会话缓存处于模块顶层 | 将缓存限制在当前插件实例，保持原有重命名策略 |
| `packages/opencode-a2a/src/format.ts` | 默认优先处理某个业务的非标准上下文和载荷字段 | 默认使用标准 A2A；特殊字段由 `responseMetadata` 显式映射 |
| `packages/opencode-a2a/src/auth.ts` | 自定义 Header 认证有服务专属兜底；相对 Token 文件使用服务进程 cwd | Header 由配置或 Card 声明；文件按插件位置解析，支持标准 file URL |
| `packages/opencode-a2a/src/client.ts` | Card 可指向不同源并接收 Token；重定向会携带自定义认证头；HTTP 错误页可能回显凭据；超时仅覆盖响应头 | 非配置源需明确指定 endpoint；禁止自动重定向；HTTP 错误仅给状态码；取消/超时信号持续覆盖响应体。只选 REST 接口 |
| `packages/opencode-recall/src/paths.ts` | 路径没有统一处理 `~` 和相对目录 | 按当前插件位置解析路径，保留 XDG 默认目录 |
| `packages/opencode-recall/src/db.ts` | 无项目定位时 project 搜索退化为全库；索引路径可误指向宿主数据库；索引包含完整问答 | 无定位时返回空结果；拒绝同文件；索引按私有文件权限创建 |
| `packages/opencode-recall/src/index.ts` | 搜索范围只取插件启动位置 | 优先使用调用会话的项目及当前位置 |
| 包元数据、根依赖、锁文件 | 缺少独立声明的开发依赖，UI 依赖版本混用；TPS 将服务端入口声明为 GUI | 补齐并锁定验证基线；移除无效 GUI 导出；修复现有类型错误 |
| 许可证 | 两包遗留 MIT 与元数据 GPL 冲突，五包缺少许可证文件 | 经维护者确认统一现有 GPL 声明，公开账号署名；保留历史 MIT 授权及 OpenCode/OpenAI 第三方归属和许可文本 |
| CI 与发布检查 | 包子目录下的发布 workflow 不会作为根仓库 CI 执行，内容依赖单包布局 | 增加根仓库检查 workflow，覆盖工作区测试、类型、公开内容扫描和隔离打包导入 |
| `.gitignore` | 凭据、数据库、模型和原始资料缺少统一忽略规则 | 增加相关规则；已跟踪内容仍由检查脚本扫描 |

`compact-before` 的源码、原生提示词、压缩语义及显示位置未改动；该包仅调整发布元数据、许可证和测试路径解析。

## 验证结果

- 干净依赖安装：`npm ci --ignore-scripts` 成功；`npm ls --depth=0` 无缺失/多余依赖。
- 全仓类型检查：`npm run check` 通过；auto-review 的独立检查通过。
- 单元测试：`npm test` ，7 个插件共 **81 项通过**。
- 新增回归覆盖：宿主连接与实例隔离、路径解析和搜索范围、A2A 跨源转发/HTTP 重定向/错误回显/响应体超时，以及标准/自定义 metadata。
- 实际打包：7 个 tarball 在独立临时目录安装，**22 个导出入口成功导入**；包中有 LICENSE，无工程会话文档、测试和数据库。
- 公开内容模式扫描通过；文档脱敏脚本重复运行无需再改动；`git diff --check` 通过。
- 向量测试使用模拟 embedding，未在真实历史库上执行回填，也未验证所有 GPU 平台。

## 历史处理与待处理项

### 1. 使用干净快照重建历史

重建前只读扫描的 166 个历史 blob 中，26 个含个人主目录路径，15 个含真实会话标识；另有 1 组作者身份元数据。所用常见密钥格式扫描未命中凭据形态字符串，此结果不等同于能识别任意格式秘密。

维护者选择以审查后的快照建立新历史，而非逐条改写旧提交。新提交和标签使用公开账号及 GitHub noreply 邮箱署名，替换原有分支和标签引用。原历史与工作树备份保存在仓库外的私有目录，不进入新历史。
此次检查的 Release 没有单独上传的附件。远端不可达对象与平台缓存不受 Git 引用覆盖直接控制。

### 2. 宿主 TUI 可选入口发现错误

使用 OpenCode 源码 2.2.0 / Bun 1.3.14 执行现有真实 TUI 回归：compact-before 2 通过、6 失败；TPS 1 项失败。
失败发生于宿主发现阶段：未导出的 `gui-experimental` 触发 Bun 的 `ResolveMessage`，其 `code` 是 `ERR_MODULE_NOT_FOUND`，但 `instanceof Error` 为 false。宿主的可选入口处理先要求 `instanceof Error`，因此将正常缺少可选 GUI 入口判为插件加载失败。

定位文件是宿主的 `packages/plugin/src/host.ts` 中 `resolve()` 的异常分类。Node 环境的独立安装与全部导出导入已通过。真实 TUI 验收需要宿主修正该异常分类后重跑；没有通过添加伪 GUI 导出绕过它。

## 复查命令

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run check:public
python3 scripts/sanitize-docs.py
npm run check:packages
```

文档补充脱敏可使用 `npm run docs:redact` 。私人业务词汇映射可通过 `scripts/sanitize-docs.py --rules <private-json-file> --write` 传入，不将原始词汇映射提交到仓库。
