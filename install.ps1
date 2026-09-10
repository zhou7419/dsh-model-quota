<#
.dsh-model-quota 安装脚本（兼容路径 / 重新安装）

推荐安装方式（DSH 0.1.5-rc 及以上自带 pnpm）：
    dsh plugin --profile web add github:zhou7419/dsh-model-quota

本脚本用法（在插件目录里执行）：
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -InstallQianwenCli

脚本做的事：
  1. 若能调用 `dsh plugin`：直接把本目录作为包装入 profile（插件自带 patch 自动生效）
  2. 否则回退：复制插件到 %DSH_HOME%\profiles\<profile>\node_modules\dsh-model-quota
     并把插件 cordis.patch.yml 的条目合并进 profile 的 cordis.patch.yml（幂等）
  3. 可选：npm install -g @qianwenai/qianwen-cli

之后还需要（脚本会提示）：
  - 存储凭证：DEEPSEEK_API_KEY；QWEN_CONSOLE_COOKIE / QWEN_CONSOLE_SECTOKEN（在本机浏览器抓，见 README）
  - 若用 CLI 通道：qianwen auth login
  - 重启 dsh web
#>
param(
	[string]$ProfileName = "web",
	[switch]$InstallQianwenCli
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$profileDir = Join-Path $dshHome "profiles\$ProfileName"

if (-not (Test-Path $profileDir)) {
	Write-Error "找不到 profile 目录：$profileDir（请先安装 DSH 并创建 $ProfileName profile）"
	return
}

Write-Host "==> 1/3 安装插件"
$installedByDsh = $false
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshCmd) {
	try {
		Write-Host "    - 尝试 dsh plugin --profile $ProfileName add $root"
		& dsh plugin --profile $ProfileName add $root
		if ($LASTEXITCODE -eq 0) {
			$installedByDsh = $true
			Write-Host "    - 已通过 dsh plugin 安装（插件自带 patch 会自动生效）"
		} else {
			Write-Host "    - dsh plugin 返回非 0，回退手工安装"
		}
	} catch {
		Write-Host "    - dsh plugin 调用失败（$($_.Exception.Message)），回退手工安装"
	}
}

if (-not $installedByDsh) {
	Write-Host "==> 2/3 手工回退：复制插件 + 合并 profile patch"
	$dst = Join-Path $profileDir "node_modules\dsh-model-quota"
	New-Item -ItemType Directory -Path $dst -Force | Out-Null
	foreach ($item in @("package.json", "lib", "README.md", "cordis.patch.yml")) {
		$src = Join-Path $root $item
		if (Test-Path $src) { Copy-Item -Path $src -Destination $dst -Recurse -Force }
	}

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
		Set-Content -Path $patchFile -Value "# Your patch layer for this dsh profile.`n$entry" -Encoding UTF8
		Write-Host "    - 已创建 $patchFile"
	} elseif ($content.Trim() -eq "[]") {
		Set-Content -Path $patchFile -Value $entry -Encoding UTF8
		Write-Host "    - 已将 [] 替换为插件入口"
	} elseif ($content -match "dsh-model-quota") {
		Write-Host "    - 入口已存在，跳过"
	} else {
		Add-Content -Path $patchFile -Value "`n$entry" -Encoding UTF8
		Write-Host "    - 已追加入口"
	}
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
