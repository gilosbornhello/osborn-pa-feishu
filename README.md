# Osborn PA 飞书版（osborn-pa-feishu）

把 Osborn PA 的非知识库业务能力——**目标中心、项目中心（要事为先）、工作台（目标拖进日历）**——做成可以独立安装到飞书多维表格的产品：先供自己公司多人使用，之后交付给其他企业。页面、数据与运行由飞书平台承载，不自建服务器、数据库、缓存或常驻服务。

> **当前阶段：一期 F0（端到端可行性门槛）进行中。** 本仓库是公开的开发仓库，**不代表已开源授权**：未附许可证，保留所有权利。

## 现在能做什么、不能做什么

| 层级 | 状态 |
| --- | --- |
| 文档 | ✅ 独立审计、技术产品方案、分阶段任务与验收、审阅处置、进度记录 |
| 本地原型 | ✅ 规则包（两套评分、周期迁移、重复系列、权限、写入合同）＋ 工作台原型＋安装计划器＋Base SDK 端口；103 项测试通过 |
| 飞书实测 | 🟡 OpenAPI 幂等探针（`client_token` 创建幂等 ✅；记录更新无版本检查 ⚠️）；安装器在真实测试 Base 上建出 F0 表、重复执行 0 写入、合成数据读回一致 ✅；妙搭托管页作为多维表格插件在桌面客户端与浏览器中加载并读取当前 Base ✅；插件内经 SDK 写入自检 21 步通过（新建、读回、同键重试、改期、版本冲突、对账）✅；工作台 Base 模式在插件内拖入、改期、版本冲突、表格改动自动刷新、表单安排均通过 ✅ |
| 内部试用 | 🟡 2026-11-04 已向本组织全员发出试用邀请（按 D-11=C：私有仅在工作台内隐藏）；F0 尚有未完成项 |
| 跨企业交付 | ❌ 尚未达到 |

**尚未实现或未实测：** 应用模式插件组件、并发重试实测（F0-06）、评分公式字段、应用模式三入口页面、两种权限身份的真实验证、第二实例安装、评分公式在飞书中的实现、移动端单日视图。详见 [任务与验收](docs/plan/phase-tasks-and-acceptance.md)。

## 文档

- [独立审计报告](docs/audit/2026-11-02-independent-audit.md)
- [技术产品开发与移植方案 v1.0](docs/plan/technical-product-plan.md)（含字段规则、状态机、权限矩阵、评分样例、安装与升级、待你决定的事项）
- [分阶段任务与验收清单](docs/plan/phase-tasks-and-acceptance.md)
- [原 CEO／工程审阅意见处置](docs/plan/review-dispositions.md)
- [实施进度记录](docs/progress/implementation-log.md)

## 目录

```text
packages/rules       业务规则唯一来源：评分、周期、重复、权限、写入命令、内存参考端口
packages/schema      逻辑字段字典 manifest.json 与规范化 hash
packages/workbench   工作台原型（左日历、右目标、拖入、改期、表单安排、回执）
packages/installer   安装计划器：清单＋现有结构 → 最小写入步骤（可重复执行）
fixtures             评分黄金样例（任何飞书实现都必须逐字段对上）
tools                本地静态服务、OpenAPI 探针、公开前检查脚本
```

## 开发与验证

需要 Node.js 20+，无第三方依赖。

```bash
npm test
```

```bash
npm run workbench
```

打开 `http://127.0.0.1:4317/`。数据为合成样例，保存在浏览器本地存储；“故障注入”菜单可模拟响应丢失、另一标签页改动、刷新读回。这只是本地演示，**不连接飞书**。

```bash
npm run manifest:hash
```

## 飞书探针（可选，需要你自己的授权）

`tools/probe-client-token.mjs` 只能对**专门为探针新建、只含合成数据**的 Base 运行：

```bash
node tools/probe-client-token.mjs <probe_base_token> --as bot
```

输出请保存到 `local/`（已忽略），不要提交。

## 安装到飞书测试 Base（需要你自己的 lark-cli 用户授权）

默认只打印计划；`--execute` 才写入。安装记录含 Base 标识，只能写在 `local/`（已忽略）。

```bash
node tools/install-instance.mjs --record local/instances/test-a.json --name "Osborn PA 测试（合成数据）"
```

```bash
node tools/install-instance.mjs --record local/instances/test-a.json --name "Osborn PA 测试（合成数据）" --execute
```

```bash
node tools/seed-instance.mjs --record local/instances/test-a.json
```

## 公开仓库规则

- 不提交：凭据、令牌、授权二维码、会话缓存、真实客户数据、原始日志、真实飞书资源标识、个人机器路径。
- 原始方案草案与审阅原文含内部标识，只保存在本地 `local/`。
- 提交前运行 `bash tools/check-public.sh`（扫描暂存内容）。
