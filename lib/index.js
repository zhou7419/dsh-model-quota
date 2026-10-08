/**
 * dsh-model-quota — server half.
 *
 * A small DSH web-profile plugin that reports the DeepSeek account balance:
 * `GET {baseURL}/user/balance` using the credential stored under `apiKeyEnv`
 * (the same credential the `llm-deepseek` provider reads, stored through the
 * web Models page or the launching environment).
 *
 * The client half renders a pill in the sidebar footer and fetches through an
 * exact Fetch route (`/api/model-quota`) mounted inside Connection's trust and
 * authentication fence. Nothing here ships the API key to the browser.
 *
 * @module dsh-model-quota
 */
import { appendFileSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

const name = "dsh-model-quota";
/**
 * Required host services. `connection` (dsh-client-connection) owns the exact
 * Fetch routes mounted inside its trust/auth fence.
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
	requestTimeoutMs: z.number().default(10_000)
});

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
			"user-agent": "dsh-model-quota/0.3"
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
 * RPC handler for the `/api/model-quota` route. Endpoints:
 *  - `get` — return the DeepSeek balance snapshot (best-effort).
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
			if (lastFetch !== null && lastFetch.deepseek?.error === void 0) return lastFetch;
			return shared;
		}
		pending = (async () => {
			const fetchedAt = new Date().toISOString();
			const deepseek = await fetchDeepSeekBalance(ctx, config.apiKeyEnv, config.baseURL, config.requestTimeoutMs, signal).catch(
				(error) => ({
					configured: true,
					error: error instanceof Error ? error.message : String(error)
				})
			);
			const record = { fetchedAt, deepseek };
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
 * Plugin body: mount the `/api/model-quota` exact Fetch route inside
 * Connection's trust and authentication fence.
 */
function apply(ctx, config) {
	const resolved = {
		apiKeyEnv: config?.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
		baseURL: config?.baseURL ?? PUBLIC_DEEPSEEK_BASE_URL,
		refreshIntervalMs: config?.refreshIntervalMs ?? 30_000,
		requestTimeoutMs: config?.requestTimeoutMs ?? 10_000
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
