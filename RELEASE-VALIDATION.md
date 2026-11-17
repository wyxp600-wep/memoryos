# MemoryOS 个人版 0.1.4 发布验证

核验日期：2026-11-17。验证对象为独立发布副本；未覆盖桌面原安装目录或生产数据。此次仅发行个人版。

## 实际结果

| 检查 | 结果 |
|---|---|
| 个人内核聚合检查 `node dist/smoke-all.js` | 52 PASS / 0 FAIL / 2 SKIP |
| 真实本地模型 `EMBED_MODE=local node dist/smoke-local.js` | 5 PASS / 0 FAIL；BGE-M3，1024 维 |
| 桌面壳 `node --test tests/shell.test.js` | 32 PASS / 0 FAIL |
| 内核语法 `node dist/lint-syntax.js` | 176 PASS / 0 FAIL |
| SQL 调用检查 `node dist/lint-sql-arity.js` | 退出码 0 |
| 壳层一致性 `node pack-asar.js --check` | 22 个源码条目全部一致，退出码 0 |
| 安装程序安装至含空格的新目录 | 退出码 0 |
| 安装程序遇已有目录 | 退出码 1，原 `app.asar` 散列未改变 |
| 从新安装目录启动内核、使用空白数据目录 | 本地服务正常就绪 |
| 无访问令牌请求 `/api/summary` | HTTP 401 |
| 正确访问令牌请求 `/api/summary` | HTTP 200 |
| 新安装目录调用 `/v1/embeddings` | 正常返回 1024 维本地向量 |
| 安装后逐文件 SHA-256 校验 | 11738 个文件全部与发行清单一致 |
| ZIP 边界 | 11739 个条目；企业版条目 0；应用用户数据条目 0 |
| 凭据特征与体积检查 | 第一方源码扫描未发现命中；未新增 >100MB 的 Git 源码文件 |

## 发布整理

- 从实际安装的 `app.asar` 提取壳层源码，使发布源码保留原来的皮肤启动动画、图标和标题栏适配；对相关文件作了逐字节散列核对。
- 扩充壳层打包同步清单，避免启动页、皮肤状态等新增文件丢失；发行版本设为 0.1.4，清除旧的 localhost 开发更新地址。
- 两个 MCP 检查脚本原本假设 `data` 目录存在；在干净副本中复现 SQLite 打开目录失败后，为检查脚本加入目录初始化。重跑两项及完整聚合检查均通过。
- 安装器在首次验证时遇到 .NET Framework 长路径限制；启用长路径兼容后，含嵌套 npm 依赖和空格目录的安装及文件校验通过。[微软兼容开关说明](https://learn.microsoft.com/dotnet/framework/configure-apps/file-schema/runtime/appcontextswitchoverrides-element)
- 用户要求仅发行个人版后，企业内核与启动入口均移出源码及下载包，不对原安装目录作删改。

## 预览版限制

- 静默异常检查 `node dist/lint-silent-catch.js` 仍报告 14 处 HIGH，退出码 1。本次没有为发布扩大改造业务代码；告警不作为已修复项。
- 完整检查中的外部 AI Agent 调用因缺少可用服务跳过；聚合中的本地模型项先跳过，随后已单独用实际模型验证通过。
- 没有在另一台物理电脑完成桌面窗口和所有皮肤的重新验收。发行文件保留当前安装版本的相关字节，不等同于所有环境均验证通过。
- 安装程序未做商业代码签名。
- 本地原始证据保存在发布工作目录的 `evidence/`；该目录不进入源码或下载包，以避免携带测试账号、临时数据库和本机环境信息。

安装方法、维护要求及卸载方式见 [发行说明](RELEASE-20261117.md)。
