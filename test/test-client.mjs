/* Scratch validation for the dsh-model-quota client bundle. */
import { pathToFileURL } from "node:url";

const assert = (cond, msg) => {
	if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
	console.log(`ok - ${msg}`);
};

// 1) Simulate the browser module loader.
let registration = null;
globalThis.window = {
	__ModuleLoader__: {
		load(reg) {
			registration = reg;
		}
	}
};

await import(new URL("../lib/client.js", import.meta.url).href);

assert(registration !== null, "bundle registered via window.__ModuleLoader__.load");
assert(registration.id === "dsh-model-quota", "registration id is the package name");
assert(typeof registration.factory === "function", "factory is a function");

// 2) Stub React and execute the factory.
const hooksLog = [];
let useStateOverrides = null;
let useStateCall = 0;
const stubReact = {
	Fragment: Symbol("Fragment"),
	createElement(type, props, ...children) {
		if (typeof type === "function") return type(props || {});
		return { type, props: props || null, children };
	},
	useState(initial) {
		hooksLog.push("useState");
		const idx = useStateCall++;
		const base = typeof initial === "function" ? initial() : initial;
		if (useStateOverrides && Object.prototype.hasOwnProperty.call(useStateOverrides, idx)) {
			return [useStateOverrides[idx], function set() {}];
		}
		return [base, function set() {}];
	},
	useEffect(fn) {
		hooksLog.push("useEffect");
		if (typeof fn === "function") fn();
		return undefined;
	},
	useCallback(fn) {
		hooksLog.push("useCallback");
		return fn;
	},
	useRef(initial) {
		hooksLog.push("useRef");
		return { current: initial };
	},
	useLayoutEffect(fn) {
		hooksLog.push("useLayoutEffect");
		if (typeof fn === "function") fn();
		return undefined;
	}
};

const requireMock = (spec) => {
	if (spec === "react") return stubReact;
	throw new Error(`unexpected require("${spec}")`);
};

const moduleExports = registration.factory(requireMock);
assert(moduleExports && typeof moduleExports.apply === "function", "factory exports apply()");
assert(
	Array.isArray(moduleExports.inject) && moduleExports.inject.length === 1 && moduleExports.inject[0] === "slots",
	`exports.inject is [slots] (got ${JSON.stringify(moduleExports.inject)})`
);

// 3) apply() registers into sidebar.footer.action (rich fake with register).
let injectedKey = null;
let registerCall = null;
const richCtx = {
	slots: {
		inject(key, callback) {
			injectedKey = key;
			callback(); // triggers register, which records registerCall
			return () => {};
		},
		register(options, component) {
			registerCall = { options, component };
			return () => {};
		}
	}
};
moduleExports.apply(richCtx);
assert(injectedKey === "sidebar.footer.action", "registers into sidebar.footer.action");
assert(registerCall !== null, "register performed");
assert(registerCall.options && registerCall.options.name === "sidebar.footer.action", "register targets sidebar.footer.action");
assert(registerCall.options.id === "model-quota", "entry id model-quota");
const QuotaPill = registerCall.component;
assert(typeof QuotaPill === "function", "registered component is a function");

// 5) Execute the component body with the stub React (wide + rail variants).
const LIVE_VALUE = {
	fetchedAt: "2026-09-01T00:00:00.000Z",
	deepseek: { configured: true, available: true, currency: "CNY", totalBalance: "¥47.49", grantedBalance: "¥0.00", toppedUpBalance: "¥47.49" },
	qianwen: { configured: true, subscribed: true, via: "console", planName: "Token Plan 个人版 (lite)", status: "valid", totalCredits: 25000, remainingCredits: 18000, usedPct: 28, resetDate: "2026-09-07T00:00:00.000Z", expiry: "2026-10-01T00:00:00.000Z", remainingDays: 18 },
	aliyunTokenPlan: { configured: false }
};
const injected = registerCall.options.inject();
useStateCall = 0;
const wideTree = QuotaPill(Object.assign({ wide: true }, injected));
useStateCall = 0;
const railTree = QuotaPill(Object.assign({ wide: false }, injected));
assert(wideTree && railTree && wideTree.type === "div", "component renders a root element");
console.log("component hooks executed:", hooksLog.join(", "));
assert(hooksLog.includes("useState") && hooksLog.includes("useEffect"), "hooks executed");

// Verify the inject share carries the host caller.
assert(typeof injected.call === "function", "inject share provides the host caller");
assert(wideTree.props.style && wideTree.props.style.position === "relative", "root styles applied");

// 6) Render the OPEN state with data (state overrides: open, record, pos).
Object.assign(globalThis.window, {
	innerWidth: 1280,
	innerHeight: 900,
	addEventListener() {},
	removeEventListener() {}
});
globalThis.document = { addEventListener() {}, removeEventListener() {} };
const collect = (node, out) => {
	if (typeof node === "string" || typeof node === "number") out.push(String(node));
	else if (Array.isArray(node)) node.forEach((child) => collect(child, out));
	else if (node && typeof node === "object" && Array.isArray(node.children)) collect(node.children, out);
	return out;
};
const countType = (node, tag) => {
	let n = 0;
	const walk = (x) => {
		if (Array.isArray(x)) return x.forEach(walk);
		if (x && typeof x === "object") {
			if (x.type === tag) n++;
			if (Array.isArray(x.children)) x.children.forEach(walk);
		}
	};
	walk(node);
	return n;
};
useStateOverrides = { 0: true, 1: { ok: true, value: LIVE_VALUE }, 4: { left: 20, top: 200 } };
useStateCall = 0;
const openTree = QuotaPill(Object.assign({ wide: true }, injected));
useStateOverrides = null;
const texts = collect(openTree, []).join(" | ");
assert(texts.includes("¥47.49") && texts.includes("18.0K"), "wide pill shows both balances");
assert(countType(openTree, "svg") >= 4, "logos in pill and popover sections (>=4)");
assert(texts.includes("DeepSeek 余额"), "deepseek section title rendered");
assert(texts.includes("Qwen Token Plan · Credits"), "token plan section rendered");
assert(texts.includes("18.0K") && texts.includes("/ 25.0K"), "credits fraction rendered");
assert(texts.includes("28%"), "used pct rendered");
assert(texts.includes("订阅到期"), "subscription expiry row rendered");
assert(texts.includes("额度重置"), "quota reset row rendered");
assert(texts.includes("剩余天数") && texts.includes("18 天"), "remaining days row rendered");
assert(texts.includes("每 60s 自动刷新"), "meta footer rendered");

// Rail variant with the same data.
useStateOverrides = { 0: false, 1: { ok: true, value: LIVE_VALUE } };
useStateCall = 0;
const railDataTree = QuotaPill(Object.assign({ wide: false }, injected));
useStateOverrides = null;
const railTexts = collect(railDataTree, []).join(" | ");
assert(railTexts.includes("¥47.49"), "rail pill shows DeepSeek balance");
assert(countType(railDataTree, "svg") === 1, "rail pill shows a single logo");

// Green check after a successful refresh (state index 2 = justRefreshed).
useStateOverrides = { 0: true, 1: { ok: true, value: LIVE_VALUE }, 2: true, 4: { left: 20, top: 200 } };
useStateCall = 0;
const refreshedTree = QuotaPill(Object.assign({ wide: true }, injected));
useStateOverrides = null;
const refreshedTexts = collect(refreshedTree, []).join(" | ");
assert(!refreshedTexts.includes("刷新中"), "no 刷新中 text");
assert(countType(refreshedTree, "svg") >= 5, "green check icon appears after successful refresh");

// Refresh button disabled during the 3s cooldown (state index 3 = cooling).
const findButtons = (node, out) => {
	if (Array.isArray(node)) return node.forEach((c) => findButtons(c, out));
	if (node && typeof node === "object") {
		if (node.type === "button") out.push(node);
		if (Array.isArray(node.children)) node.children.forEach((c) => findButtons(c, out));
	}
	return out;
};
useStateOverrides = { 0: true, 1: { ok: true, value: LIVE_VALUE }, 3: true, 4: { left: 20, top: 200 } };
useStateCall = 0;
const coolingTree = QuotaPill(Object.assign({ wide: true }, injected));
useStateOverrides = null;
const buttons = findButtons(coolingTree, []);
const refreshBtn = buttons.find((b) => b.props && b.props.disabled === true);
assert(refreshBtn !== undefined, "refresh button disabled during cooldown");
assert(countType(coolingTree, "svg") === 4, "no check icon while still cooling");

console.log("ALL CLIENT-HALF CHECKS PASSED");
process.exit(0);