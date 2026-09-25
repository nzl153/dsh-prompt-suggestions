# dsh-prompt-suggestions

DeepSeek Harness 输入框的「下一句建议」：助手回复完后，空着的输入框里会出现一句灰色的建议，是根据当前对话猜你接下来最可能发的话。按 **Tab** 填进输入框，**Esc** 忽略；一开始打字建议就消失，删空了又会出现。

[English](README.en.md)

## 安装

在 profile 目录（例如 `~/.dsh/profiles/web`）的 `package.json` 里加上依赖和 bundle：

```json
{
  "dependencies": { "dsh-prompt-suggestions": "^0.1.0" },
  "dsh": { "profile": { "bundles": ["...原有的...", "dsh-prompt-suggestions"] } }
}
```

然后在该目录执行 `pnpm install`，重启 DSH。桌面端要从托盘「退出」再打开。

需要 DSH 0.1.7-rc.2 及以上。

## 用哪个模型

默认自动找一个 DeepSeek 的 flash 模型，关闭思考，每条建议最多 80 个 token。要换模型，在 profile 的 `cordis.patch.yml` 里加：

```yaml
- id: dsh-prompt-suggestions
  config:
    provider: deepseek-official
    model: deepseek-flash
```

`provider` 和 `model` 要一起写。其他可调项：`maxContextChars`（带给模型的对话字数，默认 6000）、`timeoutMs`（默认 10000）。

## 说明

- 每条助手回复只请求一次模型，结果按会话缓存，反复清空输入框不会重复计费。
- 只在助手说完话、轮到你的时候给建议；新对话、助手还在工作时不显示。
- 带给模型的是当前会话最近几轮的文字内容，走的是你在 DSH 里配置好的同一个模型服务，密钥由 DSH 管理，插件不接触。
- 建议接口挂在 DSH 自己的网页服务上，复用官方的登录校验，未登录的请求会被拒绝。
- 输入法组字时不会抢 Tab；`/` 命令和 `@` 引用菜单打开时 Tab 仍归菜单。

## 许可

MIT
