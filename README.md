# dsh-model-quota

DSH（DeepSeek Harness）Web 插件：在侧边栏底部显示 **DeepSeek 账户余额**。

> **兼容性**：要求 **DSH ≥ 0.1.5**。该版本起第三方端点在 `ctx.connection.fetch`
> 上注册为精确 Fetch 路由（`/api/...`，位于 Connection 的鉴权围栏内），旧的
> `rpc.handle(channel, handler, { authority })` 自定义通道 API 已废弃。

## 功能特性

- **侧边栏底部余额徽标**（展开/收起自适应）：DeepSeek 官方鲸鱼 logo + 总余额，点击弹出明细
- **DeepSeek 官方余额**：调用 `GET {baseURL}/user/balance`，显示总余额（大字）/ 可用状态 / 赠金 / 充值
- **服务端拉取**：API Key 只存服务端，不下发浏览器
- **自动刷新**：服务端缓存 30s、浏览器轮询 60s；「刷新」按钮带 3 秒冷却，成功后显示绿色对勾

> v0.3.0 起移除了 Qwen Token Plan 余额查询（含控制台网关通道与 `qianwen` CLI 通道），
> 只保留 DeepSeek 官方余额。需要旧行为可从 git 历史取回 v0.2.x。

## 安装

### 方式一：dsh plugin（DSH 0.1.5-rc 及以上，推荐）

DSH 0.1.5 起自带 pnpm，插件按标准包管理安装。本插件自带 `cordis.patch.yml`
（通过 `dsh.bundle.patch` 声明），**装完自动插入额度条目，无需手工编辑 profile 配置**：

```bash
dsh plugin --profile web add github:zhou7419/dsh-model-quota
# 或本地目录 / npm 源：
dsh plugin --profile web add file:/path/to/dsh-model-quota
dsh plugin --profile web add dsh-model-quota
```

装好后重启 `dsh web`，侧边栏底部出现额度徽标。

> DSH 升级会重建 profile（清空手工复制的内容与用户的 patch 层），届时重新执行上面的命令即可。

### 方式二：一键脚本（旧版 DSH / 无 pnpm）

```powershell
git clone https://github.com/zhou7419/dsh-model-quota.git
cd dsh-model-quota
powershell -ExecutionPolicy Bypass -File install.ps1
# 需要 qianwen CLI 备用通道时： install.ps1 -InstallQianwenCli
```

脚本优先调用 `dsh plugin add`，不可用时回退为手工复制 + 写入 profile 的
`cordis.patch.yml` 入口（幂等，重复执行安全）。

### 方式三：完全手动

1. 把 `lib/`、`package.json`、`cordis.patch.yml` 复制到
   `%DSH_HOME%\profiles\web\node_modules\dsh-model-quota\`
2. 把插件的 `cordis.patch.yml` 内容（`- insert:` 条目）合并进
   `%DSH_HOME%\profiles\web\cordis.patch.yml`
3. 重启 `dsh web`，侧边栏底部（设置按钮旁）出现额度徽标

## 凭证配置

存储到 `%DSH_HOME%\.credentials.yaml`（或通过 Web 的 Models 页面）：

```yaml
version: 1
refs:
  DEEPSEEK_API_KEY: sk-xxxxx
```

| 凭证 | 用途 | 获取方式 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek 官方余额 | Models 页面 / 环境变量 |

## 配置项（cordis.patch.yml 的 config 字段）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | DeepSeek API Key 凭证引用 |
| `baseURL` | `https://api.deepseek.com` | DeepSeek API 地址 |
| `refreshIntervalMs` | `30000` | 服务端结果缓存窗口 |
| `requestTimeoutMs` | `10000` | 上游请求超时 |

## 开发与测试

```bash
node test/test-quota.mjs        # 服务端逻辑 + 真实 DeepSeek 余额（需本机凭证）
node test/test-client.mjs       # 客户端 bundle 结构 + 渲染
```

## 卸载

```bash
dsh plugin --profile web remove dsh-model-quota   # 需要 pnpm
```

没有 pnpm 时：删除 `%DSH_HOME%\profiles\web\node_modules\dsh-model-quota\`，
并从 `cordis.patch.yml` 删除对应 `insert` 条目，重启 `dsh web`。

## 许可证

MIT
