# dsh-model-quota

DSH（DeepSeek Harness）Web 插件：在侧边栏底部显示模型剩余额度。

## 功能特性

- **侧边栏底部额度徽标**（展开/收起自适应）：官方 logo + 余额/剩余额度，点击弹出明细
- **DeepSeek 官方余额**：调用 `GET {baseURL}/user/balance`，显示总余额 / 赠金 / 充值 / 账户可用状态
- **Qwen Token Plan · Credits**：显示剩余 / 总额、进度条、已用百分比、额度重置、订阅到期、剩余天数
  - 数据源：千问AI平台**控制台网关通道**（个人版 solo 订阅，推荐）或官方 `qianwen` CLI
- **服务端拉取**：API Key、Cookie、sec_token 均只存服务端，不下发浏览器
- **自动刷新**：服务端缓存 30s、浏览器轮询 60s，可手动刷新

## 安装

### 方式一：一键脚本（推荐）

```powershell
git clone https://github.com/zhou7419/dsh-model-quota.git
cd dsh-model-quota
powershell -ExecutionPolicy Bypass -File install.ps1
# 需要 qianwen CLI 备用通道时： install.ps1 -InstallQianwenCli
```

脚本自动把插件复制到 `%DSH_HOME%\profiles\web\node_modules\dsh-model-quota`，
并写入 `cordis.patch.yml` 入口（幂等，重复执行安全）。

### 方式二：手动

1. 把 `lib/`、`package.json`、`README.md` 复制到 `%DSH_HOME%\profiles\web\node_modules\dsh-model-quota\`
   （依赖通过 DSH 自带安装闭包解析，无需 pnpm）
2. `%DSH_HOME%\profiles\web\cordis.patch.yml` 追加：

```yaml
- insert:
    - id: model-quota
      name: dsh-model-quota
      config:
        apiKeyEnv: DEEPSEEK_API_KEY
        baseURL: https://api.deepseek.com
        refreshIntervalMs: 30000
        qianwenPersonal:
          enabled: true
          cookieCredential: QWEN_CONSOLE_COOKIE
          secTokenCredential: QWEN_CONSOLE_SECTOKEN
```

3. 重启 `dsh web`，侧边栏底部（设置按钮旁）出现额度徽标

## 凭证配置

存储到 `%DSH_HOME%\.credentials.yaml`（或通过 Web 的 Models 页面）：

```yaml
version: 1
refs:
  DEEPSEEK_API_KEY: sk-xxxxx
  QWEN_CONSOLE_COOKIE: "登录千问AI平台后的 Cookie（见下文）"
  QWEN_CONSOLE_SECTOKEN: 控制台 sec_token
```

| 凭证 | 用途 | 获取方式 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek 官方余额 | Models 页面 / 环境变量 |
| `QWEN_CONSOLE_COOKIE` | 个人版 Token Plan（控制台通道） | 浏览器 F12 抓取（见下文） |
| `QWEN_CONSOLE_SECTOKEN` | 同上 | 同一次抓包中的 `sec_token` 字段 |

## Qwen Token Plan 数据源说明

Token Plan 的 `sk-sp-` 密钥**只能用于交互式编程工具调用模型，不能查询余额**（官方文档明确）。
查询余额有两条途径：

1. **控制台网关通道（推荐，个人版必选）**：复刻千问AI平台网页的 zelda envelope 调用，
   读取个人版（solo）订阅的剩余 Credits。配置：
   - 浏览器登录千问AI平台 → 打开 [个人版管理页](https://platform.qianwenai.com/home/analytics/token-plan/individual)
   - F12 → Network（Fetch/XHR）→ 刷新 → 找到 URL 含 `BroadScopeAspnGateway` 的 `api.json` 请求
   - 复制请求头 `Cookie` 与表单 `sec_token`，存为上述凭证
   - Cookie 有效期数天到数周，过期后重新抓取即可

2. **qianwen CLI 通道（备用）**：
   ```bash
   npm install -g @qianwenai/qianwen-cli
   qianwen auth login
   ```
   注意：CLI v1.5.0 对**个人版 solo 订阅仍查不到**（上游 issue
   [#9](https://github.com/QianWen-AI/qianwen-cli/issues/9)、
   [#12](https://github.com/QianWen-AI/qianwen-cli/issues/12)），个人版请用控制台通道。

> 额度机制：个人版按**每 7 天滚动窗口的 Credits 限额**（Lite 2500 / Standard 10000 / Pro 40000），
> 窗口内未用完不结转，触顶自动暂停、满 7 天重置。

## 配置项（cordis.patch.yml 的 config 字段）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | DeepSeek API Key 凭证引用 |
| `baseURL` | `https://api.deepseek.com` | DeepSeek API 地址 |
| `refreshIntervalMs` | `30000` | 服务端结果缓存窗口 |
| `requestTimeoutMs` | `10000` | 上游请求超时 |
| `qianwenCli.enabled` | `true` | 是否启用 qianwen CLI 通道 |
| `qianwenCli.command` | `qianwen` | CLI 可执行文件名/路径 |
| `qianwenPersonal.enabled` | `false` | 是否启用个人版控制台网关通道 |
| `qianwenPersonal.baseUrl` | `https://cs-data.qianwenai.com` | 控制台数据网关 |
| `qianwenPersonal.product` | `sfm_bailian` | 网关 product |
| `qianwenPersonal.action` | `BroadScopeAspnGateway` | 网关 action |
| `qianwenPersonal.region` | `cn-beijing` | 网关 region 参数 |
| `qianwenPersonal.commodityCode` | `sfm_tokenplansolo_public_cn` | 个人版商品码 |
| `qianwenPersonal.cookie` | `""` | 控制台 Cookie（优先用凭证） |
| `qianwenPersonal.cookieCredential` | `QWEN_CONSOLE_COOKIE` | Cookie 凭证引用 |
| `qianwenPersonal.secToken` | `""` | 控制台 sec_token（优先用凭证） |
| `qianwenPersonal.secTokenCredential` | `QWEN_CONSOLE_SECTOKEN` | sec_token 凭证引用 |

## 开发与测试

```bash
node test/test-quota.mjs        # 服务端逻辑 + 真实 DeepSeek 余额（需本机凭证）
node test/test-client.mjs       # 客户端 bundle 结构 + 渲染
node test/test-e2e-personal.mjs # 个人版控制台通道端到端（需本机凭证）
```

## 卸载

```bash
dsh plugin --profile web remove dsh-model-quota   # 需要 pnpm
```

没有 pnpm 时：删除 `%DSH_HOME%\profiles\web\node_modules\dsh-model-quota\`，
并从 `cordis.patch.yml` 删除对应 `insert` 条目，重启 `dsh web`。

## 许可证

MIT
