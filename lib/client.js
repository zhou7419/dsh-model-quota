/* dsh-model-quota — client half.
 *
 * Browser bundle consumed through the DSH client module system:
 *   - the package declares `dsh.client.platform: web` and `exports["./client"]`;
 *   - this file registers a factory (no side effects until materialized);
 *   - `apply(ctx)` registers a pill entry into the `sidebar.footer.action`
 *     list slot (declared by ui-sidebar) that renders remaining model quota,
 *     fetched from the host over the `/rpc-quota` loopback channel.
 *
 * Hand-written with zero external client dependencies beyond React (a seeded
 * platform module): inline styles only, so the bundle needs no build step.
 */
window.__ModuleLoader__.load({
	id: "dsh-model-quota",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var React = require("react");
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useCallback = React.useCallback;
		var useRef = React.useRef;
		var useLayoutEffect = React.useLayoutEffect;

		/** Services this client plugin consumes (provided by the shell roster). */
		var inject = ["slots"];

		/** Exact Fetch route registered by the host half inside Connection. */
		var RPC_PATH = "/api/model-quota";
		var POLL_MS = 60_000;
		var REFRESH_COOLDOWN_MS = 3000;
		var REFRESH_CHECK_MS = 2000;

		/** POST one request envelope to the host route; never throws. */
		function callHost(payload) {
			var rpcId = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
			return fetch(RPC_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "client-request", rpcId: rpcId, method: "get", payload: payload || {} })
			}).then(
				function (response) {
					if (!response.ok) throw new Error("HTTP " + response.status);
					return response.json();
				},
				function (error) {
					throw new Error((error && error.message) || String(error));
				}
			).then(function (envelope) {
				if (!envelope || envelope.type !== "server-response" || !envelope.result) throw new Error("malformed response envelope");
				return envelope.result;
			});
		}

		var styles = {
			root: {
				position: "relative",
				display: "inline-flex",
				alignItems: "center"
			},
			pill: {
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				maxWidth: 260,
				height: 26,
				padding: "0 10px",
				border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
				borderRadius: 999,
				background: "transparent",
				color: "var(--dsw-alias-label-secondary, inherit)",
				fontFamily: "var(--dsw-font-family, inherit)",
				fontSize: 12,
				lineHeight: 1,
				cursor: "pointer",
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis"
			},
			pillLogo: { display: "inline-flex", flex: "0 0 auto", width: 12, height: 12 },
			popover: {
				position: "fixed",
				zIndex: 300,
				width: 300,
				border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
				borderRadius: 10,
				background: "var(--dsw-specific-menu, #ffffff)",
				color: "var(--dsw-alias-label-primary, #1f1f1f)",
				boxShadow: "var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,.12))",
				fontFamily: "var(--dsw-font-family, inherit)",
				fontSize: 12,
				overflow: "hidden"
			},
			head: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				padding: "10px 12px 8px",
				borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))"
			},
			title: { fontSize: 13, fontWeight: 600 },
			refresh: {
				border: "none",
				background: "none",
				color: "var(--dsw-alias-brand-primary, #4d6bfe)",
				cursor: "pointer",
				fontSize: 12,
				padding: "2px 4px",
				borderRadius: 4
			},
			refreshDisabled: {
				color: "var(--dsw-alias-label-tertiary, #9a9a9a)",
				cursor: "default"
			},
			headRight: { display: "flex", alignItems: "center", gap: 4 },
			check: { display: "inline-flex", flex: "0 0 auto" },
			body: { padding: "8px 12px 10px" },
			section: { margin: "6px 0" },
			sectionHead: { display: "flex", alignItems: "center", gap: 6, margin: "2px 0 4px" },
			logo: { display: "inline-flex", flex: "0 0 auto", width: 16, height: 16 },
			sectionTitle: {
				fontSize: 12,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary, #1f1f1f)",
				margin: 0
			},
			big: {
				fontSize: 18,
				fontWeight: 700,
				color: "var(--dsw-alias-brand-primary, #4d6bfe)",
				lineHeight: 1.25,
				margin: "0 0 4px"
			},
			row: {
				display: "flex",
				justifyContent: "space-between",
				alignItems: "center",
				gap: 12,
				padding: "2px 0"
			},
			key: { color: "var(--dsw-alias-label-secondary, #5f5f5f)" },
			value: { fontWeight: 600, whiteSpace: "nowrap" },
			error: { color: "#d93026", margin: "2px 0", wordBreak: "break-all" },
			meta: {
				padding: "6px 12px 8px",
				borderTop: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))",
				color: "var(--dsw-alias-label-tertiary, #6b7280)",
				fontSize: 12,
				display: "flex",
				justifyContent: "space-between",
				gap: 8
			},
			unconfigured: { color: "var(--dsw-alias-label-tertiary, #6b7280)" }
		};

		function currencyGlyph(currency) {
			if (currency === "CNY") return "¥";
			if (currency === "USD") return "$";
			return currency ? String(currency).slice(0, 1) : "";
		}

		function messageOf(record) {
			if (record && record.ok === false && record.error) {
				return typeof record.error.message === "string" ? record.error.message : String(record.error);
			}
			return null;
		}

		/** DeepSeek official whale mark. */
		function DeepSeekLogo(props) {
			var size = props && props.size ? props.size : 16;
			return h(
				"svg",
				{ viewBox: "0 0 1391 1024", width: size, height: size, fill: "none", "aria-hidden": "true" },
				h("path", {
					fill: "#4D6BFE",
					d: "M1290.48631826 134.26404549c-12.13759084-6.07017626-17.37788176 5.499889-24.46849939 11.37950922-2.41647143 1.89727529-4.47944763 4.363457-6.54242381 6.63908268-17.73551954 19.34557993-38.45641692 32.05483886-65.55679893 30.53729479-39.59422976-2.27562567-73.40411731 10.43225242-103.27860851 41.34927845-6.35324862-38.12501514-27.45525808-60.8854144-59.58051983-75.49056778-16.83383047-7.58633948-33.80988755-15.17405981-45.59398314-31.67648848-8.20219449-11.75924044-10.43225242-24.84684976-14.55682396-37.74390306-2.60840831-7.77689552-5.21681664-15.74296623-13.98791754-17.07133511-9.55541849-1.51754407-13.27816535 6.63908267-17.02438651 13.46734055-14.93655518 27.8819379-20.74575252 58.60978874-20.15337181 89.71598996 1.28142029 69.99067879 30.25422243 125.75455459 87.77314691 165.39711379 6.54380466 4.55125134 8.22704962 9.10388355 6.16407344 15.74158537-3.91192206 13.65651573-8.60678085 26.93468109-12.70787809 40.59119684-2.60978915 8.72553316-6.52033037 10.62142761-15.69601764 6.82825787-31.55773616-13.46734055-58.82381906-33.38320773-82.93606151-57.47059505-40.8977435-40.40202164-77.88494578-84.97556341-123.99950592-119.87493438a545.31613447 545.31613447 0 0 0-32.8847242-22.95095532c-47.06319777-46.65999226 6.16407344-84.97418257 18.49360113-89.52681476 12.87357899-4.74180739 4.48082847-21.05368003-37.17637745-20.86450484s-79.75874677 14.41597819-128.31601433 33.38320774c-7.11133024 2.84453209-14.58167909 4.93098258-22.21496716 6.63908268-44.09991337-8.53635796-89.85821657-10.43225242-137.68087677-4.93236342-90.02391745 10.24307723-161.93534583 53.67880615-214.80636013 127.84100508-63.49382273 89.14708354-78.45523305 190.43451958-60.1273328 296.08265094 19.20473417 111.33995725 74.89680624 203.52212891 160.44127608 275.59787737 88.72040372 74.73110533 190.88467371 111.33995725 307.44006671 104.32252418 70.79570899-4.1742818 149.60581813-13.84707177 238.51539705-90.66600845 22.42899749 11.38089007 45.97233351 15.93352226 84.9990377 19.34696077 30.08714069 2.84453209 59.03646854-1.51754407 81.44199176-6.25935143 35.11340129-7.58633948 32.67069387-40.78037202 19.98629006-46.84916745-102.92235159-48.93699877-80.32765321-29.02113157-100.85937539-45.14244819 52.30210785-63.16242093 131.11221699-128.79102356 161.93534585-341.41565519 2.44132657-16.88077906 0.37835039-27.50220667 0-41.15872241-0.19055603-8.34580193 1.65838982-11.5714461 11.02463314-12.5187029 25.77201312-3.03508812 50.80941892-10.24307723 73.78384852-23.14013051 66.66975662-37.17637748 93.57958258-98.25234793 99.93421204-171.46729004 0.94863764-11.19033403-0.18917518-22.76039929-11.78409557-28.64001951M709.3939789 793.19438204c-99.72156256-80.0432-148.11312921-106.40759381-168.09941928-105.26978098-18.68277634 1.13781284-15.31628641 22.95095533-11.21518917 37.17637747 4.29165328 14.03624697 9.91029458 23.70903694 17.75761301 36.03856465 5.40737266 8.15662674 9.15359382 20.29559842-5.42808529 29.39948196-32.12664259 20.29559842-87.96232211-6.82825787-90.56934959-8.15524591-65.01136678-39.07365277-119.37783167-90.66600844-157.66854771-161.22421282-36.98582145-67.90422832-58.442707-140.73943922-61.99975296-218.50563266-0.94863764-18.77805435 4.48082847-25.41713702 22.76178014-28.8319564a220.49680515 220.49680515 0 0 1 73.0478604-1.89589444c101.80939388 15.17544065 188.49029571 61.64487685 261.13495055 135.23955021 41.46803076 41.91680402 72.8352109 91.99161563 105.17450296 140.9286144 34.35531967 51.96932523 71.34252197 101.4752304 118.40571975 142.06504638 16.61980014 14.22542217 29.87311037 25.03740581 42.58098844 33.00347652-38.29071602 4.363457-102.18636342 5.3107138-145.88307125-29.96838838m47.82127938-313.91206766c0-8.34580193 6.5451855-14.98488462 14.77085427-14.98488462q2.79758351 0.04832942 5.02626061 0.94863765a14.8661323 14.8661323 0 0 1 9.53194421 14.03624697 14.79432858 14.79432858 0 0 1-14.74737999 14.98488461 14.62862768 14.62862768 0 0 1-14.5816791-14.98488461m148.49286043 77.76619346c-9.50846991 3.98372577-19.03903327 7.39854512-28.21472053 7.77689552-14.17847357 0.75946245-29.68393518-5.12015777-38.07668571-12.32814687-13.08760932-11.19171487-22.43037833-17.45106631-26.34230037-36.98720228-1.68324496-8.34580193-0.75946245-21.24285522 0.73598816-28.64001951 3.36648992-15.93352226-0.37973123-26.17521863-11.38089007-35.46965822-8.96165695-7.58772033-20.36740213-9.67417081-32.8847242-9.67417081-4.6713845 0-8.96165695-2.08506965-12.13897168-3.79316974a12.44689918 12.44689918 0 0 1-5.40599181-17.44968548c1.30351374-2.65535691 7.6581432-9.10526439 9.15221296-10.24307722 16.99815054-9.86334601 36.60609022-6.63770183 54.71996013 0.75946245 16.81035618 7.01743307 29.49475998 19.91586719 47.82266024 38.12501511 18.68277634 22.00231767 22.04926625 28.07249393 32.67069386 44.57354179 8.41760565 12.8970533 16.07574886 26.17521863 21.29256549 41.34789759 3.19940818 9.48499561-0.92516335 17.26051028-11.94979647 22.00231767"
				})
			);
		}

		/**
		 * The sidebar footer pill. `wide` is the sidebar owner prop; `call` is
		 * the injected host caller (POSTs `/api/model-quota`).
		 */
		function QuotaPill(props) {
			var wide = props.wide;
			var call = props.call || callHost;
			var rootRef = useRef(null);
			var [open, setOpen] = useState(false);
			var [record, setRecord] = useState(null); // RpcResult or null
			var [justRefreshed, setJustRefreshed] = useState(false); // green check after a successful refresh
			var [cooling, setCooling] = useState(false); // refresh cooldown (button disabled)
			var [pos, setPos] = useState(null); // fixed popover coordinates {left, top}
			var popRef = useRef(null);

			// Fetch once and store; resolves to whether the call succeeded.
			var runFetch = useCallback(
				function () {
					return Promise.resolve()
						.then(function () {
							return call({});
						})
						.then(function (result) {
							setRecord(result);
							return !!(result && result.ok);
						})
						.catch(function (error) {
							setRecord({
								ok: false,
								error: { code: "transport", message: (error && error.message) || String(error), details: {} }
							});
							return false;
						});
				},
				[call]
			);

			// Initial load + quiet poll (no UI feedback).
			useEffect(
				function () {
					runFetch();
					var timer = setInterval(runFetch, POLL_MS);
					return function () {
						clearInterval(timer);
					};
				},
				[runFetch]
			);

			// Manual refresh: 3s cooldown after a click; brief green check on
			// success (no "刷新中" state).
			var refresh = useCallback(
				function () {
					if (cooling) return;
					setCooling(true);
					setTimeout(function () {
						setCooling(false);
					}, REFRESH_COOLDOWN_MS);
					runFetch().then(function (ok) {
						if (!ok) return;
						setJustRefreshed(true);
						setTimeout(function () {
							setJustRefreshed(false);
						}, REFRESH_CHECK_MS);
					});
				},
				[cooling, runFetch]
			);

			// Outside-pointer + Escape dismissal for the popover.
			useEffect(
				function () {
					if (!open) return;
					function onPointerDown(event) {
						if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
					}
					function onKey(event) {
						if (event.key === "Escape") setOpen(false);
					}
					document.addEventListener("pointerdown", onPointerDown, true);
					document.addEventListener("keydown", onKey, true);
					return function () {
						document.removeEventListener("pointerdown", onPointerDown, true);
						document.removeEventListener("keydown", onKey, true);
					};
				},
				[open]
			);

			// Popover placement: fixed coordinates from the pill rect so the
			// sidebar's clipping (overflow) never cuts the panel, clamped to the
			// viewport, opened upward and flipped below when space is short.
			var place = useCallback(
				function () {
					if (!rootRef.current) return;
					var pillRect = rootRef.current.getBoundingClientRect();
					var width = 300;
					var left = Math.max(8, Math.min(pillRect.left, window.innerWidth - width - 8));
					var top = pillRect.top - 380 - 8; // generous estimate; corrected after measuring
					if (top < 8) top = pillRect.bottom + 8;
					setPos({ left: left, top: top });
				},
				[]
			);

			useEffect(
				function () {
					if (!open) {
						setPos(null);
						return;
					}
					place();
					window.addEventListener("resize", place);
					return function () {
						window.removeEventListener("resize", place);
					};
				},
				[open, place]
			);

			// Post-render correction pass using the measured popover size: snap
			// flush above the pill (or below when short on space) and clamp
			// horizontally into the viewport.
			useLayoutEffect(
				function () {
					if (!open || pos === null || !popRef.current || !rootRef.current) return;
					var rect = popRef.current.getBoundingClientRect();
					var pillRect = rootRef.current.getBoundingClientRect();
					var nextLeft = Math.max(8, Math.min(pos.left, window.innerWidth - rect.width - 8));
					var idealTop = pillRect.top - rect.height - 8;
					var nextTop = idealTop >= 8 ? idealTop : Math.min(pillRect.bottom + 8, Math.max(8, window.innerHeight - rect.height - 8));
					if (nextLeft !== pos.left || nextTop !== pos.top) setPos({ left: nextLeft, top: nextTop });
				},
				[open, pos]
			);

			// Compose the pill label.
			var value = record && record.ok ? record.value : null;
			var ds = value ? value.deepseek : null;
			var transportError = messageOf(record);
			var currency = ds && ds.currency;
			var glyph = currencyGlyph(currency);
			var shortTotal = ds && ds.totalBalance;
			var pillText;
			if (transportError !== null) {
				pillText = "额度 ?";
			} else if (!value) {
				pillText = record === null ? "额度 …" : "额度 --";
			} else if (ds && ds.configured && !ds.error) {
				pillText = (wide ? "额度 " : "") + (shortTotal || ((glyph || "额") + " --"));
			} else if (ds && ds.error) {
				pillText = wide ? "额度 --" : (glyph || "额");
			} else {
				pillText = wide ? "额度 --" : (glyph || "额");
			}

			// Pill content: the DeepSeek logo + balance when available; plain
			// text otherwise.
			var dsShown = !!(ds && ds.configured && !ds.error && shortTotal);
			var pillKids = [];
			if (dsShown) {
				pillKids.push(h("span", { style: styles.pillLogo }, h(DeepSeekLogo, { size: 12 })));
				pillKids.push(shortTotal);
			} else {
				pillKids.push(pillText);
			}

			return h(
				"div",
				{ ref: rootRef, style: styles.root },
				h(
					"button",
					{
						type: "button",
						style: styles.pill,
						title: "模型额度（点击查看明细）",
						"aria-expanded": open,
						onClick: function () {
							setOpen(function (prev) {
								return !prev;
							});
							if (!open) load(false);
						}
					},
					pillKids
				),
				open && pos
					? h(
							"div",
							{
								ref: popRef,
								style: Object.assign({}, styles.popover, { left: pos.left, top: pos.top }),
								role: "dialog"
							},
							h(
								"div",
								{ style: styles.head },
								h("span", { style: styles.title }, "模型额度"),
								h(
									"div",
									{ style: styles.headRight },
									justRefreshed
										? h(
												"span",
												{ style: styles.check, role: "img", "aria-label": "刷新成功" },
												h(
													"svg",
													{ viewBox: "0 0 24 24", width: 13, height: 13, fill: "none", "aria-hidden": "true" },
													h("path", { d: "M4 12.5l5 5L20 6.5", stroke: "#2f9e44", strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round" })
												)
											)
										: null,
									h(
										"button",
										{ type: "button", style: Object.assign({}, styles.refresh, cooling ? styles.refreshDisabled : null), onClick: refresh, disabled: cooling, title: "刷新额度" },
										"刷新"
									)
								)
							),
							h(
								"div",
								{ style: styles.body },
								transportError !== null
									? h("div", { style: styles.error }, "无法从服务获取额度：", transportError)
									: h(
											React.Fragment,
											null,
											h(
												"div",
												{ style: styles.section },
												h(
													"div",
													{ style: styles.sectionHead },
													h("span", { style: Object.assign({}, styles.logo, { color: "#4d6bfe" }) }, h(DeepSeekLogo)),
													h("span", { style: styles.sectionTitle }, "DeepSeek 余额")
												),
												!ds
													? h("div", { style: styles.unconfigured }, "加载中…")
													: ds.configured === false
														? h("div", { style: styles.unconfigured }, ds.error || "未配置")
														: h(
																React.Fragment,
																null,
																ds.error
																	? h("div", { style: styles.error }, ds.error)
																	: h(
																			React.Fragment,
																			null,
																			h("div", { style: styles.big }, ds.totalBalance || "--"),
																			h(
																				"div",
																				{ style: styles.row },
																				h("span", { style: styles.key }, "可用"),
																				h("span", { style: styles.value }, ds.available ? "是" : "否")
																			),
																			h(
																				"div",
																				{ style: styles.row },
																				h("span", { style: styles.key }, "赠金"),
																				h("span", { style: styles.value }, ds.grantedBalance || "--")
																			),
																			h(
																				"div",
																				{ style: styles.row },
																				h("span", { style: styles.key }, "充值"),
																				h("span", { style: styles.value }, ds.toppedUpBalance || "--")
																			)
																	)
															)
											)
									)
							),
							value && value.fetchedAt
								? h(
										"div",
										{ style: styles.meta },
										h("span", null, "更新于 ", new Date(value.fetchedAt).toLocaleTimeString()),
										h("span", null, "每 60s 自动刷新")
									)
								: null
						)
					: null
			);
		}

		/**
		 * Client plugin body: register the pill into the sidebar footer once
		 * that slot is declared (ui-sidebar). The inject share hands the
		 * component the host caller.
		 */
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", function () {
				return ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "model-quota",
						label: "模型额度",
						order: 100,
						inject: function () {
							return { call: callHost };
						}
					},
					QuotaPill
				);
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});