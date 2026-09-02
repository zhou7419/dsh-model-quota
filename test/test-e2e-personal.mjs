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
const fakeConnection = {
	rpc: { handle(channel, handler, options) { registered = { channel, handler, options }; return () => {}; } }
};
const ctx = {
	connection: fakeConnection,
	get(name) {
		if (name === "connection") return fakeConnection;
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
	},
	inject(services, callback) { return callback(this); }
};
apply(ctx, { qianwenCli: { enabled: false }, qianwenPersonal: { enabled: true, cookieCredential: "QWEN_CONSOLE_COOKIE", secTokenCredential: "QWEN_CONSOLE_SECTOKEN" } });
const result = await registered.handler("get", {}, new AbortController().signal);
console.log(JSON.stringify(result, null, 1));
if (result.ok && result.value.qianwen && result.value.qianwen.subscribed === true) {
	console.log("E2E OK — personal Token Plan credits visible");
} else {
	console.log("E2E FAILED");
	process.exit(1);
}
