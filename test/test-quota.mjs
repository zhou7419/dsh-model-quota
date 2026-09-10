/* Scratch validation for the dsh-model-quota server half. */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { name, apply, Config, inject } from "../lib/index.js";

const assert = (cond, msg) => {
	if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
	console.log(`ok - ${msg}`);
};

// 1) exports
console.log("exports:", JSON.stringify({ name, inject, applyIsFn: typeof apply === "function", configType: typeof Config }));
assert(name === "dsh-model-quota", "plugin name");
assert(Array.isArray(inject) && inject.includes("connection"), "injects connection");

// 2) Config schema defaults
const full = await Config({});
console.log("Config({}):", JSON.stringify(full));
assert(full.apiKeyEnv === "DEEPSEEK_API_KEY", "default apiKeyEnv");
assert(full.baseURL === "https://api.deepseek.com", "default baseURL");
assert(full.refreshIntervalMs === 30000, "default refreshIntervalMs");
assert(full.aliyunTokenPlan && full.aliyunTokenPlan.enabled === false, "aliyunTokenPlan defaults disabled");
assert(full.qianwenCli && full.qianwenCli.enabled === true && full.qianwenCli.command === "qianwen", "qianwenCli enabled by default");
assert(full.qianwenPersonal && full.qianwenPersonal.enabled === false && full.qianwenPersonal.commodityCode === "sfm_tokenplansolo_public_cn" && full.qianwenPersonal.baseUrl === "https://cs-data.qianwenai.com", "qianwenPersonal defaults disabled");

const partial = await Config({ apiKeyEnv: "MY_KEY", aliyunTokenPlan: { enabled: true, endpoint: "https://x" } });
assert(partial.apiKeyEnv === "MY_KEY" && partial.aliyunTokenPlan.cookie === "", "partial config merges defaults");
console.log("Config(partial):", JSON.stringify(partial));

// 3) private helpers (re-imported through the module internals via the channel)
// We exercise readPath/formatBalance through the fetch path instead; direct
// access is not exported by design. The handler test covers the RPC contract.

// 4) Exact Fetch-route contract (CLI source off for determinism)
const NO_CLI = { qianwenCli: { enabled: false, command: "qianwen" }, qianwenPersonal: { enabled: false } };

let registered = null;
function makeCtx(options = {}) {
	return {
		get: () => void 0,
		connection: {
			requestRejection: () => options.rejection,
			fetch: {
				register(route) {
					registered = route;
					return () => {};
				}
			}
		}
	};
}
function post(body) {
	return new Request("http://127.0.0.1/api/model-quota", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body)
	});
}
async function callRoute(ctxConfig, envelope) {
	apply(makeCtx(), ctxConfig);
	const response = await registered.fetch(post(envelope));
	return { response, payload: await response.json() };
}

const first = await callRoute(NO_CLI, { type: "client-request", rpcId: "test-1", method: "get", payload: {} });
assert(registered.path === "/api/model-quota", `route path is /api/model-quota (got ${registered.path})`);
assert(Array.isArray(registered.methods) && registered.methods.includes("POST"), "route accepts POST");
assert(registered.requestBody === "buffered", "route buffers its request body");
assert(first.response.status === 200, "route answers 200");
assert(first.payload.type === "server-response" && first.payload.rpcId === "test-1", "response envelope echoes the rpcId");
const result = first.payload.result;
console.log("route get (no credentials):", JSON.stringify(result, null, 1));
assert(result.ok === true, "unconfigured credentials degrade to ok result");
assert(result.value.deepseek && result.value.deepseek.configured === false, "deepseek reports unconfigured");
assert(result.value.aliyunTokenPlan && result.value.aliyunTokenPlan.configured === false, "token plan reports unconfigured");
assert(result.value.qianwen && result.value.qianwen.configured === false, "qianwen disabled reports unconfigured");
assert(result.value.fetchedAt !== void 0, "fetchedAt present");
assert(result.value.qianwen && result.value.qianwen.error === void 0, "personal console channel disabled does not leak errors");

// Unknown endpoint
const unknown = await callRoute(NO_CLI, { type: "client-request", rpcId: "test-2", method: "nope", payload: {} });
assert(unknown.payload.result.ok === false && unknown.payload.result.error.code === "unknown-endpoint", "unknown endpoint rejected");

// Malformed body
apply(makeCtx(), NO_CLI);
const badResponse = await registered.fetch(post("not json"));
assert(badResponse.status === 400, "malformed body is rejected with 400");
assert((await badResponse.json()).result.ok === false, "malformed body degrades to an error result");

// Trust/auth fence rejection is passed through
const rejected = await (async () => {
	apply(makeCtx({ rejection: 401 }), NO_CLI);
	return registered.fetch(post({ type: "client-request", rpcId: "t", method: "get", payload: {} }));
})();
assert(rejected.status === 401, "rejection status is surfaced");

// 5) Real DeepSeek balance fetch with the stored credential (network permitting)
const credsPath = process.env.USERPROFILE ? process.env.USERPROFILE + "/.dsh/.credentials.yaml" : "";
if (credsPath && existsSync(credsPath)) {
	const creds = readFileSync(credsPath, "utf8");
	const m = /DEEPSEEK_API_KEY:\s*([A-Za-z0-9_\-\.]+)/.exec(creds);
	if (m) {
		const liveCtx = makeCtx();
		liveCtx.get = (name) =>
			name === "credentials" ? { resolve: async (ref) => (ref === "DEEPSEEK_API_KEY" ? { value: m[1], source: "file" } : void 0) } : void 0;
		apply(liveCtx, {});
		const liveResponse = await registered.fetch(post({ type: "client-request", rpcId: "live", method: "get", payload: {} }));
		const live = (await liveResponse.json()).result;
		console.log("LIVE /user/balance:", JSON.stringify(live, null, 1));
		if (live.ok && live.value.deepseek.configured) {
			assert(typeof live.value.deepseek.totalBalance === "string", "live totalBalance formatted");
		} else {
			console.warn("live fetch unavailable (network sandbox?) deepseek:", JSON.stringify(live?.value?.deepseek));
		}
		const q = live.value && live.value.qianwen;
		console.log("LIVE qianwen:", JSON.stringify(q));
		assert(q && q.configured === true, "live qianwen reports configured attempt");
		assert(typeof q.error === "string" || q.subscribed === false || q.subscribed === true, "qianwen degrades gracefully");
	} else {
		console.warn("no DEEPSEEK_API_KEY found in credentials file — skipping live fetch");
	}
} else {
	console.warn("no credentials file — skipping live fetch");
}

console.log("ALL SERVER-HALF CHECKS PASSED");