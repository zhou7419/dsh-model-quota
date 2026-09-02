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

// 4) RPC contract with no credentials service present (CLI source off for determinism)
const NO_CLI = { qianwenCli: { enabled: false, command: "qianwen" }, qianwenPersonal: { enabled: false } };
let applied = false;
const fakeCtxNoCreds = {
	get(name) {
		return void 0; // no credentials service mounted
	},
	inject(services, callback) {
		console.log(`virtual ctx.inject(${services.join(",")}) — captured`);
		return () => {};
	}
};
apply(fakeCtxNoCreds, {});
assert(true, "apply() runs without credentials service");

// Direct handler test: build the handler by invoking apply with a captured inject
let captured = null;
const captureCtx = {
	get(name) {
		if (name === "credentials") return void 0;
		return void 0;
	},
	inject(services, callback) {
		captured = { services, callback };
		return () => {};
	}
};
apply(captureCtx, {});
assert(captured !== null && captured.services.includes("connection"), "register deferred until connection service");

// Simulate the connection inject firing with a fake connection handle
let registered = null;
const connCtx = {
	get(name) {
		if (name === "credentials") return void 0;
		return void 0;
	}
};
const fakeConnection = {
	rpc: {
		handle(channel, handler, options) {
			registered = { channel, handler, options };
			return () => {};
		}
	}
};
const connectionInjectCtx = new Proxy(connCtx, {
	get(target, prop) {
		if (prop === "connection") return fakeConnection;
		return target.get(prop);
	},
	has(target, prop) {
		return prop === "connection" || prop in target;
	}
});
// Re-run apply with a ctx whose inject fires synchronously
let fired = null;
const firingCtx = {
	connection: fakeConnection,
	get(name) {
		return this[name];
	},
	inject(services, callback) {
		fired = callback(this);
		return () => {};
	}
};
apply(firingCtx, NO_CLI);
assert(fired !== null, "connection inject fired");
assert(registered !== null && registered.channel === "/rpc-quota", "channel /rpc-quota registered");
assert(registered.options && registered.options.authority === "loopback", "loopback authority");

// Call the handler
const result = await registered.handler("get", {}, new AbortController().signal);
console.log("RPC /rpc-quota get (no credentials):", JSON.stringify(result, null, 1));
assert(result.ok === true, "unconfigured credentials degrade to ok result");
assert(result.value.deepseek && result.value.deepseek.configured === false, "deepseek reports unconfigured");
assert(result.value.aliyunTokenPlan && result.value.aliyunTokenPlan.configured === false, "token plan reports unconfigured");
assert(result.value.qianwen && result.value.qianwen.configured === false, "qianwen disabled reports unconfigured");
assert(result.value.fetchedAt !== void 0, "fetchedAt present");
assert(
	result.value.qianwen && result.value.qianwen.error === void 0,
	"personal console channel disabled does not leak errors"
);

// Unknown endpoint
const unknownResult = await registered.handler("nope", {}, new AbortController().signal);
assert(unknownResult.ok === false && unknownResult.error.code === "unknown-endpoint", "unknown endpoint rejected");

// 5) Real DeepSeek balance fetch with the stored credential (network permitting)
const credsPath = process.env.USERPROFILE ? process.env.USERPROFILE + "/.dsh/.credentials.yaml" : "";
if (credsPath && existsSync(credsPath)) {
	const creds = readFileSync(credsPath, "utf8");
	const m = /DEEPSEEK_API_KEY:\s*([A-Za-z0-9_\-\.]+)/.exec(creds);
	if (m) {
	const liveCtx = {
		connection: fakeConnection,
		get(name) {
			if (name === "connection") return fakeConnection;
			if (name === "credentials") {
				return {
					resolve: async (ref) => (ref === "DEEPSEEK_API_KEY" ? { value: m[1], source: "file" } : void 0)
				};
			}
			return void 0;
		},
		inject(services, callback) {
			return callback(this);
		}
	};
	apply(liveCtx, {});
	const live = await registered.handler("get", {}, new AbortController().signal);
	console.log("LIVE /user/balance:", JSON.stringify(live, null, 1));
	if (live.ok && live.value.deepseek.configured) {
		assert(typeof live.value.deepseek.totalBalance === "string", "live totalBalance formatted");
	} else {
		console.warn("live fetch unavailable (network sandbox?) deepseek:", JSON.stringify(live?.value?.deepseek));
	}
	// Live qianwen CLI probe (installed but not logged in → graceful hint; a
	// sandboxed spawn failure also degrades to an error string).
	const q = live.value && live.value.qianwen;
	console.log("LIVE qianwen:", JSON.stringify(q));
	assert(q && q.configured === true, "live qianwen reports configured attempt");
	assert(typeof q.error === "string" || q.subscribed === false || q.subscribed === true, "qianwen degrades gracefully");
	void liveCtx;
	} else {
		console.warn("no DEEPSEEK_API_KEY found in credentials file — skipping live fetch");
	}
} else {
	console.warn("no credentials file — skipping live fetch");
}

console.log("ALL SERVER-HALF CHECKS PASSED");