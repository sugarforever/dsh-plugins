# dsh-zvec-grep

面向 DeepSeek Harness 的自动化语义工作区搜索插件，底层使用 Alibaba [zvec](https://github.com/alibaba/zvec) 和 [zvec-grep](https://github.com/zvec-ai/zvec-grep) 的公开引擎 API。

## 一键安装

```bash
npx @deepseek-ai/dsh plugin --profile web add @sugarforever/dsh-zvec-grep
npx @deepseek-ai/dsh web
```

安装到这里就结束了。无需运行 `zg install`、`zg index`，也无需启动 MCP Server。

Harness 创建或恢复 Session 时，插件从不可变的 `session.header.cwd` 获取当前 workspace，立即启动文件 watcher，并在后台建立首次索引。搜索不会等待索引，也不会触发刷新。如果索引正忙或不可用，`zvec_search` 会立即返回结构化的 `indexing`、`refreshing` 或 `error` 状态，由 Agent 或用户决定稍后重试，还是改用精确 grep。

新增、修改和删除事件会在后台合并，通过 zvec-grep 的增量索引 API 提交。插件还会每小时执行一次全量 reconciliation，用来修复操作系统 watcher 可能漏掉的事件。

Harness 工作区右下角会自动出现 **Zvec index** 状态胶囊，显示 `Indexing`、`Refreshing`、`Ready` 或 `Error`，且不会阻塞搜索。点击胶囊可以查看当前 workspace 和待处理的变更数。UI 随插件一起安装，不需要单独配置前端。

第一个 workspace 可能需要下载默认的本地 embedding 模型。索引存储在 `<workspace>/.zvec-grep/`，该目录不会被索引自身收录。如果项目尚未忽略本地工具状态，建议把 `.zvec-grep/` 加入忽略规则。

## Agent 获得的能力

插件注册一个 Harness 原生工具：`zvec_search`。它始终检索发起调用的 Session workspace。成功时返回 `status: ready`，以及有限数量的源码片段、相对路径、行号、新鲜度、命中路线和分数；未就绪时立即返回状态，不返回部分结果或未经说明的旧结果。

- 不知道原始措辞或文件位置，或者需要理解架构、关系、控制流、设计原因及跨文件综合时，使用 `zvec_search`。
- 已知标识符、字面量、正则、配置项、错误信息，或者需要完整匹配列表时，继续使用 Harness 自带的精确 grep。

语义搜索是精确搜索的补充，不是替代。

## 为什么复用 zvec-grep 引擎，而不是包装 CLI 或从 zvec 重写

插件直接导入 zvec-grep 正式导出的 `createZvecGrep()` API，不启动 `zg` 子进程，不使用共享 daemon，不修改其他 Agent 配置，也不经过 MCP。

这样可以直接复用已经实现并测试的完整检索管线：遵守 Git ignore 的文件发现，代码与文档内容提取，BM25、全文与向量检索，RRF 排名融合，zvec 持久化 collection，文件级增量 diff 与刷新，以及本地 embedding 模型。

若直接基于底层 zvec 重写，插件还需要重新拥有文件扫描、分块、语言解析、embedding、元数据 schema、增量更新、排序和结果裁剪；这不会改善 Harness 的一键体验，只会扩大维护面。

## 生命周期

```text
安装 DSH bundle
  -> 自动挂载插件
  -> session/created 提供 session.header.cwd
  -> 自动启动文件 watcher 和后台首次索引
  -> watcher 事件合并为 index({ changedPaths }) 调用
  -> 每小时执行 index() reconciliation，补偿漏事件
  -> zvec_search 根据调用方 Session 选择 workspace
  -> 仅在索引 ready 时调用 context(autoUpdate: false)
  -> 插件卸载时关闭所有 workspace 引擎
```

多个 Session 使用同一个 workspace 时，共享同一个进程内引擎、watcher 和索引协调器。后台操作若失败，工具返回 `status: error`；搜索不会隐式重试，也不会隐式重建持久化索引。

## 默认配置

```yaml
- id: zvec-grep
  name: '@sugarforever/dsh-zvec-grep'
  config:
    embedding: local/potion-code-16m-v2
    device: auto
    defaultLimit: 10
    maxLimit: 30
    watchDebounceMs: 750
    reconcileIntervalMs: 3600000
    statusPollIntervalMs: 2000
```

要求 Node.js 22 或更高版本。`device` 支持 `auto`、`cpu`、`metal`、`vulkan` 和 `cuda`。设置 `reconcileIntervalMs: 0` 可关闭周期 reconciliation；默认值是一小时。`statusPollIntervalMs` 控制轻量状态 UI 的刷新频率，默认值是两秒。

## 开发验证

```bash
npm install
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

## 发布

发布由仓库中的 `Publish dsh-zvec-grep` GitHub Actions workflow 完成。先创建名为 `npm` 的 GitHub Environment，然后选择以下一种认证方式：

- 在该 Environment 中添加具备 `@sugarforever` scope 发布权限的 `NPM_TOKEN` secret；首次发布通常需要这种方式。
- 在 npm 中为仓库 `sugarforever/dsh-plugins`、workflow `publish-dsh-zvec-grep.yml` 配置 Trusted Publishing。

推送与版本一致的标签（例如 `dsh-zvec-grep-v0.1.0`），或者在 Actions 页面手动运行 workflow。流程会依次测试、类型检查、构建、检查发布内容，并通过 npm provenance 发布；已经存在的版本不会重复发布。

本插件采用 MIT 许可证。[zvec-grep](https://github.com/zvec-ai/zvec-grep) 与 [zvec](https://github.com/alibaba/zvec) 是由各自维护者发布的 Apache-2.0 项目。
