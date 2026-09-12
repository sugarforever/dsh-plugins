# dsh-plugins

这个仓库用于维护 DeepSeek Harness 插件。目前提供 `dsh-zvec-grep`。

## dsh-zvec-grep

`dsh-zvec-grep` 为 DeepSeek Harness 增加基于 [zvec-grep](https://github.com/zvec-ai/zvec-grep) 和 [zvec](https://github.com/alibaba/zvec) 的工作区语义搜索能力。

插件会在会话创建或恢复时读取当前工作区，在后台建立索引，并持续监听文件的新增、修改和删除。Agent 可以通过 `zvec_search` 按语义查找代码和文档，适合定位表述不确定的内容，以及分析架构、调用关系、控制流和跨文件信息。对于已知标识符、固定文本、正则表达式或错误信息，仍然适合使用精确文本搜索。

安装插件：

```bash
npx @deepseek-ai/dsh plugin --profile web add @sugarforever/dsh-zvec-grep
```

然后正常启动 DeepSeek Harness，例如：

```bash
npx @deepseek-ai/dsh web
```

插件会自动完成索引初始化，不需要单独安装或启动 `zvec-grep` 服务。Web 界面还会显示索引状态，包括 `Indexing`、`Refreshing`、`Ready` 和 `Error`。

搜索引擎 `@zvec/zvec-grep` 是插件的**可选依赖**：网络正常时会随插件一并安装，安装失败也不会导致插件安装失败。此时插件照常加载，`zvec_search` 返回带修复命令的结构化错误，状态标签显示 `Error`；受限网络下可单独执行 `npm install -g @zvec/zvec-grep`，插件会自动从全局 npm root 解析到它（也可用 `engineModule` 指定路径）。引擎缺失最多每 30 秒重探一次，因此安装后无需重启 Harness。

首次使用时可能需要下载默认的本地嵌入模型。索引保存在工作区的 `.zvec-grep/` 目录中，Node.js 版本要求为 22 或更高。

配置、工作机制和开发命令请参阅 [dsh-zvec-grep/README.md](./dsh-zvec-grep/README.md)。

## License

[MIT](./dsh-zvec-grep/LICENSE)
