<#
.dsh-model-quota 安装脚本（用于其他机器 / 重新安装）

用法（在插件目录里执行）：
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -InstallQianwenCli   # 同时安装千问 CLI

脚本做的事：
  1. 把插件包复制到 %DSH_HOME%\profiles\web\node_modules\dsh-model-quota
  2. 向 %DSH_HOME%\profiles\web\cordis.patch.yml 追加（或替换 []) 插件入口（幂等，重复执行安全）
  3. 可选：npm install -g @qianwenai/qianwen-cli

之后还需要（脚本会提示）：
  - 存储凭证：DEEPSEEK_API_KEY；QWEN_CONSOLE_COOKIE / QWEN_CONSOLE_SECTOKEN（在新机器浏览器里抓，见 README）
  - 若用 CLI 通道：qianwen auth login
  - 重启 dsh web
#>
param(
	[string]$ProfileName = "web",
	[switch]$InstallQianwenCli
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# DSH home
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$profileDir = Join-Path $dshHome "profiles\$ProfileName"
$nodeModules = Join-Path $profileDir "node_modules"
$dst = Join-Path $nodeModules "dsh-model-quota"

if (-not (Test-Path $profileDir)) {
	Write-Error "找不到 profile 目录：$profileDir（请先安装 DSH 并创建 $ProfileName profile）"
	return
}

Write-Host "==> 1/3 复制插件到 $dst"
New-Item -ItemType Directory -Path $dst -Force | Out-Null
Copy-Item -Path (Join-Path $root "package.json") -Destination $dst -Force
Copy-Item -Path (Join-Path $root "lib") -Destination $dst -Recurse -Force
Copy-Item -Path (Join-Path $root "README.md") -Destination $dst -Force

Write-Host "==> 2/3 写入 cordis.patch.yml 入口（幂等）"
$patchFile = Join-Path $profileDir "cordis.patch.yml"
$entry = @'
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
'@
$content = if (Test-Path $patchFile) { Get-Content -Path $patchFile -Raw -ErrorAction SilentlyContinue } else { "" }
if (-not $content) {
	# 新 profile：直接写入完整 patch
	Set-Content -Path $patchFile -Value "# Your patch layer for this dsh profile.`n$entry" -Encoding UTF8
	Write-Host "    - 已创建 $patchFile"
} elseif ($content.Trim() -eq "[]") {
	# 空数组：替换为真实入口
	Set-Content -Path $patchFile -Value $entry -Encoding UTF8
	Write-Host "    - 已将 [] 替换为插件入口"
} elseif ($content -match "dsh-model-quota") {
	Write-Host "    - 入口已存在，跳过"
} else {
	Add-Content -Path $patchFile -Value "`n$entry" -Encoding UTF8
	Write-Host "    - 已追加入口"
}

if ($InstallQianwenCli) {
	Write-Host "==> 可选：安装 qianwen CLI"
	if (Get-Command qianwen -ErrorAction SilentlyContinue) {
		Write-Host "    - qianwen 已安装，跳过"
	} else {
		npm install -g "@qianwenai/qianwen-cli"
	}
}

Write-Host ""
Write-Host "==== 安装完成，剩余 3 步（一次性） ===="
Write-Host "1) 存储凭证到 $dshHome\.credentials.yaml（或在 Web 的 Models 页存 DEEPSEEK_API_KEY）："
Write-Host "     DEEPSEEK_API_KEY: sk-xxxx"
Write-Host "     QWEN_CONSOLE_COOKIE: <本机浏览器抓取的 Cookie 值>   # 必须在本机抓取，跨机器复制会失效"
Write-Host "     QWEN_CONSOLE_SECTOKEN: <本机抓取的 sec_token>"
Write-Host "2) (可选，CLI 通道) 运行：qianwen auth login"
Write-Host "3) 重启 dsh web，左下角出现额度徽标"
