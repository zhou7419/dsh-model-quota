/* E2E: personal Token Plan via the console gateway (plugin code path). */
import { readFileSync, existsSync } from "node:fs";
import { apply } from "../lib/index.js";

const credsPath = process.env.USERPROFILE ? process.env.USERPROFILE + "/.dsh/.credentials.yaml" : "";
if (!credsPath || !existsSync(credsPath)) {
	console.log("no credentials file — skipping");
	process.exit(0);
}
const creds = readFileSync(credsPath, "utf8");
const cookie = (/QWEN_CONSOLE_COOKIE:\s*"?(.+?)"?\s*$/m.exec(creds)?.[1] ?? "").trim();
const secToken = /QWEN_CONSOLE_SECTOKEN:\s*"?([^"\s]+)"?/.exec(creds)?.[1];
console.log("cookie found:", !!cookie, "| secToken found:", !!secToken);
if (!cookie || !secToken) process.exit(2);

let registered = null;
const ctx = {
	connection: {
		requestRejection: () => void 0,
		fetch: {
			register(route) {
				registered = route;
				return () => {};
			}
		}
	},
	get(name) {
		if (name === "credentials") {
			return {
				resolve: async (ref) => {
					if (ref === "QWEN_CONSOLE_COOKIE") return { value: cookie, source: "file" };
					if (ref === "QWEN_CONSOLE_SECTOKEN") return { value: secToken, source: "file" };
					return void 0;
				}
			};
		}
		return void 0;
	}
};
apply(ctx, { qianwenCli: { enabled: false }, qianwenPersonal: { enabled: true, cookieCredential: "QWEN_CONSOLE_COOKIE", secTokenCredential: "QWEN_CONSOLE_SECTOKEN" } });
const request = new Request("http://127.0.0.1/api/model-quota", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ type: "client-request", rpcId: "e2e", method: "get", payload: {} })
});
const response = await registered.fetch(request);
const result = (await response.json()).result;
console.log(JSON.stringify(result, null, 1));
const qianwen = result.value && result.value.qianwen;
if (result.ok && qianwen && qianwen.subscribed === true) {
	console.log("E2E OK — personal Token Plan credits visible");
} else if (qianwen && typeof qianwen.error === "string" && /NotLogined|未登录|login/i.test(qianwen.error)) {
	console.log("E2E SKIPPED — console session expired; re-capture QWEN_CONSOLE_COOKIE / QWEN_CONSOLE_SECTOKEN (see README)");
} else {
	console.log("E2E FAILED");
	process.exit(1);
}
