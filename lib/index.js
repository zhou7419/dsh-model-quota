/**
 * dsh-model-quota — server half.
 *
 * A small DSH web-profile plugin that reports "how much model quota is left":
 *
 *  1. DeepSeek official account balance (`GET {baseURL}/user/balance`) using the
 *     credential stored under `apiKeyEnv` (the same credential the
 *     `llm-deepseek` provider reads, stored through the web Models page or the
 *     launching environment).
 *
*  2. Qwen Token Plan remaining Credits via the official `qianwen` CLI
 *     (`qianwen usage summary --format json` → `token_plan`), authenticated by
 *     `qianwen auth login` (account session, not the `sk-sp-` key). The CLI
 *     must be installed (`npm install -g @qianwenai/qianwen-cli`) and logged
 *     in once; until then this source reports a hint instead of failing.
 *
 *  3. An optional custom JSON source — a cookie-authenticated endpoint with a
 *     dot path to the remaining value (legacy/advanced fallback for Aliyun
 *     Bailian; see README).
 *
 * The client half renders a pill in the sidebar footer and fetches through a
 * dedicated loopback RPC channel (`/rpc-quota`). Nothing here ships secrets to
 * the browser: the API key and cookie stay in the host process.
 *
 * @module dsh-model-quota
 */
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

const name = "dsh-model-quota";
/**
 * Required host services. `connection` (dsh-client-connection) owns both the
 * RPC registry and the exact Fetch routes mounted inside its trust/auth fence.
 */
const inject = ["connection"];

/** Exact Fetch route served under the shared `/api` channel. */
const RPC_PATH = "/api/model-quota";

const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY";
const PUBLIC_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
/** Temporary diagnostics: set DSH_MODEL_QUOTA_DEBUG=<file> to trace loading. */
const DEBUG_LOG = process.env.DSH_MODEL_QUOTA_DEBUG;
function debugLog(message) {
	if (!DEBUG_LOG) return;
	try {
		appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`);
	} catch {
		/* ignore */
	}
}
/** Node >= 18.17 has AbortSignal.timeout; keep a guard for older runtimes. */
const timeoutSignal = (ms) =>
	typeof AbortSignal.timeout === "function"
		? AbortSignal.timeout(ms)
		: AbortSignal.abort(new Error(`timeout after ${ms}ms`));

const Config = z.object({
	/** Credential reference (env var name) holding the DeepSeek API key. */
	apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV),
	/** DeepSeek API base; `$DEEPSEEK_BASE_URL` wins when set in the environment. */
	baseURL: z.string().default(PUBLIC_DEEPSEEK_BASE_URL),
	/** Server-side result cache window in milliseconds. */
	refreshIntervalMs: z.number().default(30_000),
	/** Network timeout per upstream request in milliseconds. */
	requestTimeoutMs: z.number().default(10_000),
	/** Qwen Token Plan source: the official `qianwen` CLI (usage summary). */
	qianwenCli: z
		.object({
			enabled: z.boolean().default(true),
			/** CLI executable name/path (resolved on PATH). */
			command: z.string().default("qianwen")
		})
		.default({}),
	/**
	 * Console-gateway fallback for the PERSONAL (solo) Token Plan. The CLI
	 * (v1.5.0) still queries the retired `sfm_tokenplanpersonal_dp_cn` BSS
	 * commodity and misses gray/solo subscriptions (upstream issues #9/#12);
	 * this source replicates the console page's zelda envelope calls with the
	 * user's browser session instead.
	 */
	qianwenPersonal: z
		.object({
			enabled: z.boolean().default(false),
			/** Console data gateway (the page's own envelope host). */
			baseUrl: z.string().default("https://cs-data.qianwenai.com"),
			product: z.string().default("sfm_bailian"),
			action: z.string().default("BroadScopeAspnGateway"),
			region: z.string().default("cn-beijing"),
			commodityCode: z.string().default("sfm_tokenplansolo_public_cn"),
			/** Page origin used for referer/origin headers (gateway validates it). */
			refererBaseUrl: z.string().default("https://platform.qianwenai.com"),
			/** Raw `Cookie` header; prefer `cookieCredential` instead. */
			cookie: z.string().default(""),
			/** Credential ref holding the console Cookie (checked first). */
			cookieCredential: z.string().default("QWEN_CONSOLE_COOKIE"),
			secToken: z.string().default(""),
			/** Credential ref holding the console `sec_token` (checked first). */
			secTokenCredential: z.string().default("QWEN_CONSOLE_SECTOKEN")
		})
		.default({}),
	/** Optional second source: a cookie-authenticated JSON endpoint (Aliyun Token Plan). */
	aliyunTokenPlan: z
		.object({
			enabled: z.boolean().default(false),
			/** Full GET URL returning the quota JSON. */
			endpoint: z.string().default(""),
			/** Raw `Cookie` header value (from the Bailian console, see README). */
			cookie: z.string().default(""),
			/** Dot path (with optional numeric indices) to the remaining amount, e.g. `data.remainingTokens`. */
			remainingTokensPath: z.string().default("data.remainingTokens"),
			/** Optional dot path to a plan/display name, e.g. `data.planName`. */
			planNamePath: z.string().default("")
		})
		.default({})
});

/** Walk a dot path (with numeric segments as array indices) through a JSON value. */
function readPath(value, path) {
	if (!path) return void 0;
	let current = value;
	for (const segment of path.split(".")) {
		if (current === null || current === void 0) return void 0;
		if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[Number(segment)];
		else if (typeof current === "object") current = current[segment];
		else return void 0;
	}
	if (typeof current === "string") {
		const parsed = Number(current);
		return Number.isFinite(parsed) ? parsed : current;
	}
	return current;
}

/** Format a balance amount with its currency symbol. */
function formatBalance(value, currency) {
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n)) return null;
	switch (currency) {
		case "CNY": return `¥${n.toFixed(2)}`;
		case "USD": return `$${n.toFixed(2)}`;
		default: return `${currency ?? ""} ${n.toFixed(2)}`.trim();
	}
}

/**
 * Fetch the DeepSeek account balance. Resolves the API key through the
 * credentials service (which also covers the process environment), falls back
 * to the ambient environment variable when no credentials service is mounted.
 * @param ctx - plugin context (for the credentials service).
 * @param apiKeyEnv - credential ref name.
 * @param baseURL - DeepSeek API base.
 * @param timeoutMs - network timeout.
 * @param signal - optional caller cancellation.
 * @returns a normalized source record.
 */
async function fetchDeepSeekBalance(ctx, apiKeyEnv, baseURL, timeoutMs, signal) {
	const ref = credentialRef(apiKeyEnv);
	let apiKey;
	const credentials = ctx.get("credentials");
	if (credentials !== void 0) {
		const hit = await credentials.resolve(ref);
		if (hit !== void 0 && typeof hit.value === "string" && hit.value.length > 0) apiKey = hit.value;
	}
	if (apiKey === void 0) {
		const ambient = process.env[ref];
		if (typeof ambient === "string" && ambient.length > 0) apiKey = ambient;
	}
	if (apiKey === void 0) {
		return {
			configured: false,
			error: `未配置凭证 ${ref}（在 Web 的 Models 页面存储，或导出为环境变量）`
		};
	}
	const url = `${(baseURL ?? process.env.DEEPSEEK_BASE_URL ?? PUBLIC_DEEPSEEK_BASE_URL).replace(/\/+$/, "")}/user/balance`;
	const response = await fetch(url, {
		method: "GET",
		headers: {
			authorization: `Bearer ${apiKey}`,
			accept: "application/json",
			"user-agent": "dsh-model-quota/0.1"
		},
		signal: signal !== void 0 ? signal : timeoutSignal(timeoutMs)
	});
	const text = await response.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`DeepSeek /user/balance 返回了非 JSON 响应（HTTP ${response.status}）`);
	}
	if (!response.ok) {
		const message = typeof data?.error?.message === "string" ? data.error.message : JSON.stringify(data);
		throw new Error(`DeepSeek /user/balance 失败（HTTP ${response.status}）：${message}`);
	}
	const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
	if (infos.length === 0) {
		throw new Error("DeepSeek /user/balance 未返回 balance_infos");
	}
	const first = infos[0];
	return {
		configured: true,
		available: data.is_available !== false,
		currency: typeof first?.currency === "string" ? first.currency : "CNY",
		totalBalance: formatBalance(first?.total_balance, first?.currency),
		grantedBalance: formatBalance(first?.granted_balance, first?.currency),
		toppedUpBalance: formatBalance(first?.topped_up_balance, first?.currency),
		raw: { is_available: data.is_available, balance_infos: infos }
	};
}

/**
 * Fetch the optional custom quota source (Aliyun Token Plan). When not
 * enabled or not configured it reports `configured: false` instead of failing.
 */
async function fetchCustomQuota(source, timeoutMs, signal) {
	if (source?.enabled !== true || typeof source.endpoint !== "string" || source.endpoint.length === 0) {
		return { configured: false };
	}
	if (typeof source.cookie !== "string" || source.cookie.length === 0) {
		return { configured: true, error: "Token Plan 已启用但未配置 Cookie（见 README）" };
	}
	const response = await fetch(source.endpoint, {
		method: "GET",
		headers: {
			cookie: source.cookie,
			accept: "application/json",
			"user-agent": "dsh-model-quota/0.1"
		},
		signal: signal !== void 0 ? signal : timeoutSignal(timeoutMs)
	});
	const text = await response.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`Token Plan 接口返回了非 JSON 响应（HTTP ${response.status}）`);
	}
	if (!response.ok) {
		const message = typeof data?.message === "string" ? data.message : typeof data?.error === "string" ? data.error : JSON.stringify(data);
		throw new Error(`Token Plan 接口失败（HTTP ${response.status}）：${message}`);
	}
	const remaining = readPath(data, source.remainingTokensPath);
	const planName = source.planNamePath ? readPath(data, source.planNamePath) : void 0;
	if (typeof remaining !== "number") {
		throw new Error(`Token Plan 响应中未找到路径 ${source.remainingTokensPath} 处的数值`);
	}
	return {
		configured: true,
		remainingTokens: remaining,
		planName: typeof planName === "string" ? planName : void 0
	};
}

/**
 * Qwen Token Plan quota through the official `qianwen` CLI
 * (`qianwen usage summary --format json`). The CLI authenticates with an
 * account session (`qianwen auth login`), so the `sk-sp-` key itself is never
 * used here. Missing CLI / missing login degrade to hints, not failures.
 */
async function fetchQianwenQuota(source, timeoutMs) {
	if (source?.enabled !== true) return { configured: false };
	const command = typeof source.command === "string" && source.command.length > 0 ? source.command : "qianwen";
	const { error, stdout, stderr } = await new Promise((resolve) => {
		execFile(
			command,
			["usage", "summary", "--format", "json"],
			{ timeout: timeoutMs, shell: process.platform === "win32", windowsHide: true, maxBuffer: 1 << 20 },
			(err, out, errOut) => resolve({ error: err, stdout: out, stderr: errOut })
		);
	});
	let payload = null;
	const text = String(stdout ?? "").trim();
	if (text.length > 0) {
		try {
			payload = JSON.parse(text);
		} catch {
			payload = null;
		}
	}
	if (payload === null) {
		// The CLI prints structured errors to stderr (e.g. AUTH_REQUIRED).
		const errText = String(stderr ?? "").trim();
		if (errText.startsWith("{")) {
			try {
				payload = JSON.parse(errText);
			} catch {
				payload = null;
			}
		}
	}
	if (payload && typeof payload === "object" && payload.error) {
		const err = payload.error;
		const code = typeof err === "object" && typeof err.code === "string" ? err.code : "";
		const message = typeof err === "object" && typeof err.message === "string" ? err.message : String(err);
		if (/AUTH|LOGIN|NOT_AUTHENTICATED|UNAUTH/i.test(code)) {
			return { configured: true, error: `qianwen CLI 未登录或凭证已过期：运行 qianwen auth login（${message}）` };
		}
		return { configured: true, error: `qianwen CLI：${message}` };
	}
	if (payload === null) {
		if (error && error.code === "ENOENT") {
			return { configured: false, error: `未找到 qianwen CLI（${command}）：npm install -g @qianwenai/qianwen-cli` };
		}
		if (error && (error.signal === "SIGTERM" || error.code === "ETIMEDOUT" || /killed/i.test(String(error.message)))) {
			return { configured: true, error: `qianwen CLI 调用超时（>${timeoutMs}ms）` };
		}
		const detail = String(stderr ?? "").trim().slice(0, 200);
		if (/auth|login|未登录/i.test(detail)) {
			return { configured: true, error: "qianwen CLI 未登录：运行 qianwen auth login" };
		}
		if (error || detail) return { configured: true, error: detail || (error instanceof Error ? error.message : String(error)) };
		return { configured: true, error: "qianwen CLI 未返回可解析的 JSON" };
	}
	const tp = payload.token_plan;
	if (!tp || typeof tp !== "object" || tp.subscribed !== true) {
		return { configured: true, subscribed: false };
	}
	return {
		configured: true,
		subscribed: true,
		via: "cli",
		planName: typeof tp.planName === "string" ? tp.planName : "Token Plan",
		status: typeof tp.status === "string" ? tp.status : void 0,
		totalCredits: typeof tp.totalCredits === "number" ? tp.totalCredits : void 0,
		remainingCredits: typeof tp.remainingCredits === "number" ? tp.remainingCredits : void 0,
		usedPct: typeof tp.usedPct === "number" ? tp.usedPct : void 0,
		resetDate: typeof tp.resetDate === "string" ? tp.resetDate : void 0
	};
}

/** Resolve a credential ref through the credentials service, then the environment. */
async function resolveCredentialValue(ctx, ref) {
	if (typeof ref !== "string" || ref.length === 0) return void 0;
	const credentials = ctx.get("credentials");
	if (credentials !== void 0) {
		const hit = await credentials.resolve(credentialRef(ref));
		if (hit !== void 0 && typeof hit.value === "string" && hit.value.length > 0) return hit.value;
	}
	const ambient = process.env[ref];
	return typeof ambient === "string" && ambient.length > 0 ? ambient : void 0;
}

/** Unwrap the console gateway envelope by walking DataV2/data layers. */
function unwrapConsole(j) {
	let cur = j;
	for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
		if (cur && typeof cur === "object" && cur.success === false) {
			throw new Error(
				typeof cur.message === "string"
					? cur.message
					: typeof cur.errorMsg === "string" && cur.errorMsg.length > 0
						? cur.errorMsg
						: "控制台网关返回业务错误"
			);
		}
		if (cur.DataV2 && typeof cur.DataV2 === "object" && cur.DataV2.data !== void 0) {
			cur = cur.DataV2.data;
			continue;
		}
		if (cur.data !== void 0 && cur.data !== null && (typeof cur.data === "object" || Array.isArray(cur.data))) {
			cur = cur.data;
			continue;
		}
		break;
	}
	return cur;
}

/**
 * Personal (solo) Token Plan through the console gateway — the same zelda
 * envelope calls the platform web page makes. Requires the browser session's
 * `Cookie` (+ `sec_token`); both stay server-side.
 */
async function fetchQianwenPersonal(ctx, source, timeoutMs, signal) {
	if (source?.enabled !== true) return { configured: false };
	const cookie = source.cookie || (await resolveCredentialValue(ctx, source.cookieCredential));
	if (typeof cookie !== "string" || cookie.length === 0) {
		return { configured: true, error: `个人版通道已启用但未提供 Cookie（配置 qianwenPersonal.cookie 或凭证 ${source.cookieCredential || "QWEN_CONSOLE_COOKIE"}，见 README）` };
	}
	const secToken = source.secToken || (await resolveCredentialValue(ctx, source.secTokenCredential)) || "";
	// The console injects this identity block into every envelope `Data`
	// (shared.js `bP()`); without it the gateway rejects the call.
	const corner = {
		domain: typeof source.refererBaseUrl === "string" ? new URL(source.refererBaseUrl).hostname : "platform.qianwenai.com",
		consoleSite: "QIANWENAI",
		console: "ONE_CONSOLE",
		xsp_lang: "zh-CN",
		protocol: "V2",
		productCode: "p_efm"
	};
	const call = async (api, data) => {
		const url = new URL("/data/api.json", source.baseUrl);
		url.searchParams.set("product", source.product);
		url.searchParams.set("action", source.action);
		url.searchParams.set("api", api);
		const form = new URLSearchParams({
			product: source.product,
			action: source.action,
			sec_token: secToken,
			region: source.region,
			params: JSON.stringify({ Api: api, Data: { ...data, cornerstoneParam: corner }, V: "1.0" })
		});
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				accept: "application/json, text/plain, */*",
				cookie,
				origin: source.refererBaseUrl,
				referer: `${source.refererBaseUrl}/home/analytics/token-plan/individual`,
				"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
			},
			body: form,
			signal: signal !== void 0 ? signal : timeoutSignal(timeoutMs)
		});
		const text = await response.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			throw new Error(`控制台网关 ${api} 返回非 JSON（HTTP ${response.status}）`);
		}
		if (!response.ok) {
			const message = typeof json?.message === "string" ? json.message : `HTTP ${response.status}`;
			throw new Error(`控制台网关 ${api.split("/").pop()} 失败：${message}`);
		}
		return unwrapConsole(json);
	};
	const sub = await call("zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription", { commodityCode: source.commodityCode });
	if (!sub || typeof sub !== "object") throw new Error("subscription 接口返回空");
	if (sub.status !== "VALID") {
		return { configured: true, subscribed: false, via: "console", status: typeof sub.status === "string" ? sub.status : void 0 };
	}
	const [usage, quotaConfig] = await Promise.all([
		call("zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage", {}),
		call("zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config", {})
	]);
	const pct = typeof usage?.per1WeekPercentage === "number" ? usage.per1WeekPercentage : void 0;
	const spec = typeof sub.specCode === "string" ? sub.specCode : void 0;
	let weekly;
	if (quotaConfig && typeof quotaConfig === "object") {
		if (spec && quotaConfig[spec] && Number.isFinite(Number(quotaConfig[spec].weekly))) weekly = Number(quotaConfig[spec].weekly);
		else {
			const hit = Object.values(quotaConfig).find((v) => v && typeof v === "object" && Number.isFinite(Number(v.weekly)));
			if (hit) weekly = Number(hit.weekly);
		}
	}
	const remaining = pct !== void 0 && Number.isFinite(weekly) ? Math.max(0, Math.round(weekly * (1 - Math.min(1, Math.max(0, pct))))) : void 0;
	return {
		configured: true,
		subscribed: true,
		via: "console",
		planName: `Token Plan 个人版${spec ? ` (${spec})` : ""}`,
		status: "valid",
		totalCredits: Number.isFinite(weekly) ? weekly : void 0,
		remainingCredits: remaining,
		usedPct: pct !== void 0 ? Math.round(pct * 100) : void 0,
		remainingDays: typeof sub.remainingDays === "number" ? sub.remainingDays : void 0,
		expiry: typeof sub.endTime === "number" ? new Date(sub.endTime).toISOString() : typeof sub.endTime === "string" ? sub.endTime : void 0
	};
}

/**
 * RPC handler for the `/rpc-quota` channel. Endpoints:
 *  - `get` — return the composed quota snapshot (both sources, best-effort).
 */
function makeHandler(ctx, config) {
	let lastFetch = null;
	let lastAt = 0;
	let pending = null;

	const snapshot = async (signal) => {
		const now = Date.now();
		if (lastFetch !== null && now - lastAt < Math.max(config.refreshIntervalMs, 1000)) return lastFetch;
		if (pending !== null) {
			// Another caller is already refreshing; share its result.
			const shared = await pending;
			if (lastFetch !== null && lastFetch.error === void 0) return lastFetch;
			return shared;
		}
		pending = (async () => {
			const fetchedAt = new Date().toISOString();
			const [deepseek, cliQ, webQ, aliyunTokenPlan] = await Promise.all([
				fetchDeepSeekBalance(ctx, config.apiKeyEnv, config.baseURL, config.requestTimeoutMs, signal)
					.then((value) => value)
					.catch((error) => ({
						configured: true,
						error: error instanceof Error ? error.message : String(error)
					})),
				fetchQianwenQuota(config.qianwenCli, config.requestTimeoutMs)
					.then((value) => value)
					.catch((error) => ({
						configured: true,
						error: error instanceof Error ? error.message : String(error)
					})),
				fetchQianwenPersonal(ctx, config.qianwenPersonal, config.requestTimeoutMs, signal)
					.then((value) => value)
					.catch((error) => ({
						configured: true,
						error: error instanceof Error ? error.message : String(error)
					})),
				fetchCustomQuota(config.aliyunTokenPlan, config.requestTimeoutMs, signal)
					.then((value) => value)
					.catch((error) => ({
						configured: true,
						error: error instanceof Error ? error.message : String(error)
					}))
			]);
			// The console channel covers solo (gray) subscriptions the CLI
			// cannot see; use it whenever it has real data or a concrete
			// problem, otherwise keep the CLI view.
			let qianwen = cliQ;
			if (webQ && webQ.configured === true && webQ.subscribed === true) qianwen = webQ;
			else if (webQ && cliQ.subscribed !== true && webQ.configured === true && typeof webQ.error === "string" && webQ.error.length > 0) qianwen = webQ;
			const record = { fetchedAt, deepseek, qianwen, aliyunTokenPlan };
			lastFetch = record;
			lastAt = Date.now();
			return record;
		})();
		try {
			return await pending;
		} finally {
			pending = null;
		}
	};

	return async (endpoint, payload, signal) => {
		if (endpoint !== "get") {
			return {
				ok: false,
				error: { code: "unknown-endpoint", message: `dsh-model-quota: 未知端点 ${endpoint}`, details: {} }
			};
		}
		try {
			const value = await snapshot(signal);
			return { ok: true, value };
		} catch (error) {
			return {
				ok: false,
				error: {
					code: "model-quota/fetch-failed",
					message: error instanceof Error ? error.message : String(error),
					details: {}
				}
			};
		}
	};
}

/**
 * Plugin body: mount the `/rpc-quota` loopback RPC channel once the
 * `connection` service exists (its own fiber disposer covers teardown).
 */
function apply(ctx, config) {
	const resolved = {
		apiKeyEnv: config?.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
		baseURL: config?.baseURL ?? PUBLIC_DEEPSEEK_BASE_URL,
		refreshIntervalMs: config?.refreshIntervalMs ?? 30_000,
		requestTimeoutMs: config?.requestTimeoutMs ?? 10_000,
		qianwenCli: {
			enabled: config?.qianwenCli?.enabled ?? true,
			command: config?.qianwenCli?.command ?? "qianwen"
		},
		qianwenPersonal: {
			enabled: config?.qianwenPersonal?.enabled ?? false,
			baseUrl: config?.qianwenPersonal?.baseUrl ?? "https://cs-data.qianwenai.com",
			product: config?.qianwenPersonal?.product ?? "sfm_bailian",
			action: config?.qianwenPersonal?.action ?? "BroadScopeAspnGateway",
			region: config?.qianwenPersonal?.region ?? "cn-beijing",
			commodityCode: config?.qianwenPersonal?.commodityCode ?? "sfm_tokenplansolo_public_cn",
			refererBaseUrl: config?.qianwenPersonal?.refererBaseUrl ?? "https://platform.qianwenai.com",
			cookie: config?.qianwenPersonal?.cookie ?? "",
			cookieCredential: config?.qianwenPersonal?.cookieCredential ?? "QWEN_CONSOLE_COOKIE",
			secToken: config?.qianwenPersonal?.secToken ?? "",
			secTokenCredential: config?.qianwenPersonal?.secTokenCredential ?? "QWEN_CONSOLE_SECTOKEN"
		},
		aliyunTokenPlan: config?.aliyunTokenPlan ?? {}
	};
	const handler = makeHandler(ctx, resolved);
	// DSH >= 0.1.5 mounts third-party endpoints as exact Fetch routes inside
	// Connection's trust/authentication fence (`ctx.connection.fetch`), which is
	// the supported replacement for the retired custom RPC channel +
	// `{ authority }` option.
	debugLog("apply() called");
	try {
		ctx.connection.fetch.register({
			path: RPC_PATH,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: async (request) => {
				const rejection = ctx.connection.requestRejection(request);
				if (rejection !== void 0) {
					return new Response(rejection === 401 ? "unauthorized" : "forbidden", { status: rejection });
				}
				let envelope = null;
				try {
					envelope = await request.json();
				} catch {
					envelope = null;
				}
				if (envelope === null || typeof envelope !== "object" || envelope.type !== "client-request" || typeof envelope.method !== "string") {
					return Response.json(
						{
							type: "server-response",
							rpcId: "model-quota-invalid",
							result: { ok: false, error: { code: "model-quota/bad-request", message: "invalid request envelope", details: {} } }
						},
						{ status: 400 }
					);
				}
				const rpcId = typeof envelope.rpcId === "string" ? envelope.rpcId : "model-quota-unknown";
				const endpoint = envelope.method;
				const payload = envelope.payload !== void 0 ? envelope.payload : {};
				let result;
				try {
					result = await handler(endpoint, payload, request.signal);
				} catch (error) {
					result = {
						ok: false,
						error: {
							code: "model-quota/internal",
							message: error instanceof Error ? error.message : String(error),
							details: {}
						}
					};
				}
				return Response.json({ type: "server-response", rpcId, result });
			}
		});
		debugLog("fetch route registered OK");
	} catch (error) {
		debugLog(`register FAILED: ${error instanceof Error ? error.stack : String(error)}`);
		throw error;
	}
}

export { Config, apply, inject, name };
debugLog("module loaded (exports ready)");