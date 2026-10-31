/**
 * dsh-tide-badge —— 浏览器半边（模板）
 *
 * 由 build.mjs 把 lib/season.mjs 内联到下面的 SEASON_INLINE 标记处，生成最终的
 * lib/client.js。这样前端与宿主**共用同一份峰谷与节假日判定源码**，前端不必
 * 自己维护节假日表，也不会出现两端算出的切换点不一致。
 *
 * 形态：输入框下方 `conversation.composer.dock` 里的一枚小药丸（原生「缓存命中」
 * 那一排的后面），点击展开面板。数据来自宿主 /plugins/tide-badge/state 单一路由。
 *
 * ⚠️ 为什么要"作为 dock 条目渲染"而不是往原生 DOM 里塞节点（0.2.4 的改动）
 *
 *   0.2.x 的输入框统计行换了实现：它不再是带 `data-composer-stats` 的普通容器，
 *   而是由 ui-chat 以**两个 dock 条目**（activity / usage）渲染出来的，并且
 *   `usage` 条目在没有 token 用量（新会话）时会直接返回 null。于是 0.2.3 里
 *   "先找 `[data-composer-stats]`、再找含『缓存命中』的 button、然后 appendChild"
 *   的挂法在两种情况下彻底失效：找不到锚点 → 药丸永远不出现。
 *
 *   现在改为：我们在同一个 dock 槽位里注册**自己的条目**（order 2，紧跟原生
 *   activity(0)、usage(1)），药丸本身是 React 元素。dock 是 `display:flex` 的
 *   一行，所以视觉位置不变，但不再依赖任何原生 DOM 结构或文案。
 *
 *   同理，"本次对话花费"的账本键改用槽位下发的 `sessionId`（旧实现读
 *   `ctx.get("sessions").list.getSnapshot()`，0.2.x 的 sessions 服务已没有
 *   `list` 字段，会一直退化成全局单条账）。
 */

window.__ModuleLoader__.load({
	id: "dsh-tide-badge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		/**
		 * 面板要浮在整个输入框之上（原生统计对话框同样用 portal），所以挂到
		 * document.body。宿主没有暴露 react-dom 时降级成就地 fixed 渲染。
		 */
		const reactDom = (() => {
			try {
				return require("react-dom");
			} catch (err) {
				return null;
			}
		})();

		// >>> tide-badge:season（由 build.mjs 从 lib/season.mjs 内联，请勿手改） >>>
		/* SEASON_INLINE */
		// <<< tide-badge:season <<<

		const STATE_URL = "/plugins/tide-badge/state";
		const TICK_MS = 1000;
		/** 闲多久才自动刷新余额（对话区静默计时）。 */
		const IDLE_REFRESH_MS = 60 * 1000;
		/** 检查“是否已闲够”的频率。 */
		const IDLE_CHECK_MS = 5000;
		const NARROW = "(max-width: 760px)";
		const CSS_TAG_ID = "dsh-tide-badge/core.css";
		/** 条目在原生 dock 里的位置：activity 是 0、usage（缓存命中）是 1。 */
		const DOCK_ORDER = 2;

		/**
		 * 样式对齐原生统计药丸（ui-chat 的 StatsPills）：同一套字号、内距与
		 * hover 令牌，贴在同一行里看不出是外来条目。
		 */
		const CSS = `
.dsh-tide-badge {
  box-sizing: border-box; max-width: 100%;
  font: inherit;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  font-variant-numeric: tabular-nums;
  white-space: nowrap; background: 0 0; border: none; border-radius: var(--dsw-radius-sm, 8px);
  align-items: center; gap: 6px; padding: 1px 8px; display: inline-flex;
  cursor: pointer;
}
.dsh-tide-badge:hover, .dsh-tide-badge[aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-secondary);
}
.dsh-tide-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dsh-tide-muted { opacity: .6; }
.dsh-tide-balance { opacity: .85; font-variant-numeric: tabular-nums; }
/* 面板背景必须用**实心不透明**的 --dsw-alias-bg-layer-1（原生模态卡片同款）。
   此前用的是 --dsw-specific-menu，那是覆盖层令牌、半透明，背后的对话文字会透出来。 */
.dsh-tide-panel {
  position: fixed; z-index: 1100; box-sizing: border-box;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 16px;
  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px #0006);
  font-size: 12px; line-height: 18px;
  min-width: min(320px, 100vw - 24px); max-width: min(440px, 100vw - 24px);
}
.dsh-tide-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.dsh-tide-title { font-weight: 500; color: var(--dsw-alias-label-primary); flex: 1; }
.dsh-tide-refresh {
  background: 0 0; border: none; padding: 0 2px; cursor: pointer;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font: inherit;
}
.dsh-tide-refresh:hover { color: var(--dsw-alias-label-primary); }
.dsh-tide-rows { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
.dsh-tide-rows dt { color: var(--dsw-alias-label-secondary); }
.dsh-tide-rows dd { margin: 0; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; text-align: right; }
.dsh-tide-badge-tag {
  font-size: 10px; padding: 0 5px; border-radius: 999px; margin-left: 4px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  border: 1px solid var(--dsw-alias-border-l2);
}
.dsh-tide-note { margin-top: 10px; color: var(--dsw-alias-label-secondary); }
.dsh-tide-note:empty { display: none; }
.dsh-tide-err { color: var(--dsw-alias-state-warn-primary); }
.dsh-tide-foot { margin-top: 10px; color: var(--dsw-alias-label-secondary); opacity: .75; }
`;

		/** 每页只注入一次样式表；返回清理函数。 */
		function injectCss() {
			if (typeof document === "undefined") return () => {};
			const existing = document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]');
			if (existing !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-tide-badge";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}

		/**
		 * 金额格式：**符号后置**（`123¥`、`0.5$`），跟随接口给的币种与精度。
		 *
		 * 0 也要正常显示成 `0¥`：用 `/\.?0+$/` 只吃掉「小数点及其后的零」，
		 * `0` 与 `0.50` 都能留下正确数字（旧版 `/0+$/` 会把 `0.0000` 整串吃空）。
		 */
		function formatMoney(amount, currency) {
			if (typeof amount !== "number" || !Number.isFinite(amount)) return "--";
			const digits = amount >= 1 ? 2 : 4;
			const text = amount.toFixed(digits).replace(/\.?0+$/, "") || "0";
			const symbol = currency === "CNY" ? "\u00a5" : currency === "USD" ? "$" : currency === "EUR" ? "\u20ac" : "";
			if (symbol !== "") return `${text}${symbol}`;
			return `${text} ${currency || ""}`.trim();
		}

		// ------------------------------------------------------------------
		// 本次对话花费 —— 用**余额差值**记账
		//
		// 为什么用差值而不是 token×单价：余额减少是**真实扣费**，把缓存命中、
		// 思考 token、峰谷价这些都交给账单自己去体现，不必维护价目表，也不会
		// 出现"算出 ¥0.42、实际扣 ¥0.51"的偏差。
		//
		// 记账节奏搭在"对话停止一分钟后刷新余额"上（IDLE_REFRESH_MS）：每次拿到
		// 新余额就与基准做差累加。于是
		//   · 对话进行中 → 显示已结算的累计值
		//   · 一轮结束满一分钟后 → 该轮花费被计入
		//   · 新对话 → 基准即当前余额 → ¥0
		//
		// 两个已知边界：
		//   · 余额是**账户级**读数，若同一账号在别处同时消耗，那部分会被算进来。
		//   · 充值会让余额上升，此时不做负向记账（只累加正差值）。
		// ------------------------------------------------------------------
		const LEDGER_KEY = "dsh-tide-badge/session-cost";
		/** 金额用整数单位累加，避免浮点累加误差。 */
		const MONEY_SCALE = 1e8;

		const toUnits = (value) => {
			const n = Number(value);
			if (!Number.isFinite(n)) return null;
			const units = Math.round(n * MONEY_SCALE);
			return Number.isSafeInteger(units) ? units : null;
		};

		let ledger = null;

		/** 账本按**对话 id**分开记，存在浏览器 localStorage，刷新/重启不丢。 */
		function readLedger() {
			if (ledger !== null) return ledger;
			ledger = {};
			try {
				const raw = window.localStorage.getItem(LEDGER_KEY);
				const parsed = raw === null ? null : JSON.parse(raw);
				if (parsed !== null && typeof parsed === "object") ledger = parsed;
			} catch (err) {
				/* 读不到就当新账本 */
			}
			return ledger;
		}

		function saveLedger() {
			try {
				window.localStorage.setItem(LEDGER_KEY, JSON.stringify(readLedger()));
			} catch (err) {
				/* 存不下不影响本次显示 */
			}
		}

		/** 该对话已累计的花费（元）。 */
		function sessionCostOf(key) {
			const row = readLedger()[key];
			const units = row !== undefined && row !== null && Number.isFinite(row.costUnits) ? row.costUnits : 0;
			return units / MONEY_SCALE;
		}

		/**
		 * 用一次新的余额读数记账。
		 * @param {string} key 对话 id
		 * @param {number} total 余额读数
		 */
		function observeBalance(key, total) {
			const units = toUnits(total);
			if (units === null) return;
			const store = readLedger();
			let row = store[key];
			if (row === undefined || row === null || !Number.isFinite(row.baseUnits) || !Number.isFinite(row.costUnits)) {
				// 第一次见到这个对话：基准取当前余额，花费记 0。
				row = store[key] = { baseUnits: units, costUnits: 0 };
			} else {
				const delta = row.baseUnits - units;
				// 差值 > 0 才是消费；余额上升（充值）不作负向记账。
				if (delta > 0) row.costUnits += delta;
				row.baseUnits = units;
			}
			saveLedger();
		}

		// ------------------------------------------------------------------
		// 宿主状态
		// ------------------------------------------------------------------

		/** 宿主下发的节假日清单只应用一次，避免每次渲染都重建 Set。 */
		let holidaysApplied = false;

		/**
		 * 读宿主状态。失败也返回可渲染的对象，绝不抛出。
		 *
		 * 宿主返回的 holidays 是**节假日判定的单一来源**：交给共用的 season
		 * 源码后，前端算出的切换点与宿主完全一致（法定节假日最容易算错切换点）。
		 */
		async function loadState(force) {
			try {
				const response = await fetch(STATE_URL + (force ? "?refresh=1" : ""), {
					headers: { accept: "application/json" },
				});
				if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
				const data = await response.json();
				const list = data !== null && data !== undefined && data.season ? data.season.holidays : undefined;
				if (!holidaysApplied && Array.isArray(list) && list.length > 0) {
					holidaysApplied = true;
					setHolidays(list);
				}
				return data;
			} catch (err) {
				return { ok: false, error: String((err && err.message) || err) };
			}
		}

		/**
		 * 面板正文。有时段数据就用宿主下发的（与宿主时刻严格一致），否则用共用的
		 * season 源码本地算一份（节假日清单已由 setHolidays 注入）。
		 */
		function panelRows(state) {
			const now = new Date();
			const season = (state && state.season) || describePhase(now);
			const bal = state && state.balance;
			const beijing = season.beijing || beijingClock(now);
			const flip = season.flipAt === null || season.flipAt === undefined ? null : new Date(season.flipAt);
			const rows = [];

			const kindText = season.holiday ? "（法定节假日）" : season.weekend ? "（周末）" : "";
			rows.push({ key: "计费时段", value: (season.peak ? "高峰时段（峰价）" : "空闲时段（谷价，半价）") + kindText });
			rows.push({
				key: "下次切换",
				value: season.countdown === "" || season.countdown === undefined
					? "--"
					: `${season.countdown}后` + (flip === null ? "" : `，${beijingClock(flip).weekday} ${beijingClock(flip).clock}（北京）`),
			});
			rows.push({ key: "北京时间", value: `${beijing.weekday} ${beijing.clock}` });

			if (bal && bal.ok) {
				rows.push({ key: "账户余额", value: formatMoney(bal.total, bal.currency) + (bal.currency ? ` ${bal.currency}` : "") });
				const granted = typeof bal.granted === "number" ? bal.granted : 0;
				const toppedUp = typeof bal.toppedUp === "number" ? bal.toppedUp : 0;
				if (granted > 0) {
					rows.push({ key: "赠送金额", value: formatMoney(bal.granted, bal.currency) });
					if (toppedUp > 0) rows.push({ key: "充值金额", value: formatMoney(bal.toppedUp, bal.currency) });
				}
				if (bal.isAvailable === false) rows.push({ key: "API 调用", value: "余额不足", tone: "warn" });
			} else if (bal) {
				rows.push({ key: "账户余额", value: "暂不可用" });
			}
			return rows;
		}

		/**
		 * 面板脚注：成功时说明余额来源；失败时把**两条路的原因分别摊开**，
		 * 否则「服务不存在 / 未登录 / 平台查询失败 / 没有钱包」在界面上长得一样。
		 */
		function panelNote(bal) {
			if (bal && bal.ok && bal.source === "account") return "余额来自桌面端账号登录态";
			if (bal && bal.ok && bal.source === "key") return "余额来自 API Key";
			const parts = [];
			if (bal && bal.accountReason) parts.push("账号路：" + String(bal.accountReason));
			if (bal && bal.error) parts.push("API Key 路：" + String(bal.error));
			return parts.join("；");
		}

		/** 面板是否该用告警色（余额两条路都失败）。 */
		function panelIsError(bal) {
			return Boolean(bal && bal.ok === false);
		}

		// ------------------------------------------------------------------
		// 组件
		// ------------------------------------------------------------------

		/**
		 * 药丸本体。`sessionId` / `running` 由外层按槽位契约解析后传入，
		 * 这里只管状态、记账节奏与渲染。
		 *
		 * @param {{ sessionId?: string, running?: boolean }} props
		 */
		function TideBadgeBody(props) {
			const sessionId = props.sessionId;
			const running = props.running === true;
			const key = typeof sessionId === "string" && sessionId !== "" ? sessionId : "default";

			const stateHook = react.useState(null);
			const state = stateHook[0];
			const setState = stateHook[1];
			const openHook = react.useState(false);
			const open = openHook[0];
			const setOpen = openHook[1];
			const tickHook = react.useState(0);
			const setTick = tickHook[1];
			const posHook = react.useState(null);
			const pos = posHook[0];
			const setPos = posHook[1];
			const chipRef = react.useRef(null);
			const panelRef = react.useRef(null);

			/**
			 * 把一份新状态交给药丸，并顺带记一笔账。
			 *
			 * 记账必须挂在这里而不是只挂在自动刷新上：只挂自动刷新的话，首次
			 * 挂载与「打开面板时的刷新」都不会播种基准，于是新对话的「本次」要
			 * 等第一次闲满才出现（0.2.0 就是这个毛病）。三条路径都走这里。
			 */
			const apply = react.useCallback((next) => {
				if (next === null || next === undefined || next.ok === false) return;
				if (next.balance && next.balance.ok === true) observeBalance(key, next.balance.total);
				setState(next);
			}, [key]);

			// 每秒重算一次倒计时与档位（宿主时刻只做基准，本地推进）。
			react.useEffect(() => {
				const timer = window.setInterval(() => {
					setTick((value) => value + 1);
				}, TICK_MS);
				return () => {
					window.clearInterval(timer);
				};
			}, []);

			// 首次挂载播种基准；之后每 5 秒检查一次「是否已闲够」再取数。
			react.useEffect(() => {
				let lastActivity = Date.now();
				let observer = null;
				let retry = null;

				// 对话区静止检测：观察 [data-conversation-scroll] 的变动 —— agent 在
				// 流式输出、工具调用刷新、用户敲字，都会改动这棵子树。任何一次变动
				// 都刷新计时，于是「闲满一分钟」自然等价于「输出结束后用户一分钟没继续」。
				const attach = () => {
					const el = document.querySelector("[data-conversation-scroll]");
					if (el === null) return false;
					observer = new MutationObserver(() => {
						lastActivity = Date.now();
					});
					observer.observe(el, { childList: true, subtree: true, characterData: true });
					return true;
				};

				if (!attach()) {
					// 挂载早于对话区出现时，轮询直到它出现（最多约 20 秒）。
					let tries = 0;
					retry = window.setInterval(() => {
						tries += 1;
						if (attach() || tries > 40) {
							window.clearInterval(retry);
							retry = null;
						}
					}, 500);
				}

				void loadState(false).then(apply);

				const timer = window.setInterval(() => {
					// 以下任一成立就直接跳过，**不发起取数**：
					if (typeof document.hidden === "boolean" && document.hidden) return; // 页面在后台
					if (running) return;                                                 // 有会话在跑
					if (Date.now() - lastActivity < IDLE_REFRESH_MS) return;             // 60 秒内有动静
					void loadState(false).then(apply);
				}, IDLE_CHECK_MS);

				return () => {
					window.clearInterval(timer);
					if (retry !== null) window.clearInterval(retry);
					if (observer !== null) observer.disconnect();
				};
			}, [apply, running]);

			// 打开面板时按药丸位置摆放（视口内夹取，放不下就翻到下方）。
			react.useLayoutEffect(() => {
				if (!open) {
					setPos(null);
					return undefined;
				}
				const place = () => {
					const chip = chipRef.current;
					const panel = panelRef.current;
					if (chip === null || panel === null) return;
					const rect = chip.getBoundingClientRect();
					const width = panel.offsetWidth;
					const height = panel.offsetHeight;
					const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
					const above = rect.top - height - 8;
					setPos({ left, top: above >= 8 ? above : rect.bottom + 8 });
				};
				place();
				window.addEventListener("resize", place);
				window.addEventListener("scroll", place, true);
				return () => {
					window.removeEventListener("resize", place);
					window.removeEventListener("scroll", place, true);
				};
			}, [open, state]);

			// 点外面 / 按 Escape 关闭。
			react.useEffect(() => {
				if (!open) return undefined;
				const onPointer = (event) => {
					const panel = panelRef.current;
					const chip = chipRef.current;
					if (panel !== null && panel.contains(event.target)) return;
					if (chip !== null && chip.contains(event.target)) return;
					setOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointer, true);
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("pointerdown", onPointer, true);
					document.removeEventListener("keydown", onKey, true);
				};
			}, [open]);

			// 面板上的「刷新」是强制取数（宿主侧 60 秒缓存不生效）。
			const refresh = react.useCallback(() => {
				void loadState(true).then(apply);
			}, [apply]);

			const local = describePhase(new Date());
			const hostFlipAt = state && state.season ? state.season.flipAt : null;
			let countText;
			if (typeof hostFlipAt === "number" && Number.isFinite(hostFlipAt)) {
				const remaining = hostFlipAt - Date.now();
				countText = remaining > 0 ? formatCountdown(remaining) : "";
			} else {
				countText = local.countdown || "";
			}
			const narrow = typeof window !== "undefined" && window.matchMedia(NARROW).matches;
			const bal = state && state.balance;
			const balanceText = bal && bal.ok === true ? formatMoney(bal.total, bal.currency) : "";
			// 本次花费永远显示（未产生消费时是 `本次 0¥`）：新开对话看不到这一项时，
			// 用户无法分辨是"还没花钱"还是"插件坏了"。
			const costText = "本次 " + formatMoney(sessionCostOf(key), (bal && bal.currency) || "CNY");
			const dotColor = local.color;

			const chip = react.createElement("button", {
				ref: (node) => {
					chipRef.current = node;
				},
				type: "button",
				className: "dsh-tide-badge",
				"aria-haspopup": "dialog",
				"aria-expanded": open,
				title: local.title,
				onClick: () => {
					setOpen(!open);
				},
			},
				react.createElement("span", { className: "dsh-tide-dot", style: { background: dotColor }, "aria-hidden": true }),
				react.createElement("span", null, local.compact),
				countText === "" || narrow ? null : react.createElement("span", { className: "dsh-tide-muted" }, "\u00b7 " + countText),
				balanceText === "" ? null : react.createElement("span", { className: "dsh-tide-balance" }, "\u00b7 " + balanceText),
				react.createElement("span", { className: "dsh-tide-muted dsh-tide-cost" }, "\u00b7 " + costText),
			);

			if (!open) return react.createElement(react.Fragment, null, chip);

			const rows = panelRows(state);
			const body = react.createElement("dl", { className: "dsh-tide-rows" },
				rows.map((row) => react.createElement(react.Fragment, { key: row.key },
					react.createElement("dt", null, row.key),
					react.createElement("dd", {
						style: row.tone === "warn" ? { color: "var(--dsw-alias-state-warn-primary)" } : undefined,
					}, row.value),
				)),
			);

			const note = panelNote(bal);
			const panel = react.createElement("div", {
				ref: (node) => {
					panelRef.current = node;
				},
				className: "dsh-tide-panel",
				role: "dialog",
				"aria-label": "计费时段与余额",
				style: {
					left: (pos === null ? 0 : pos.left) + "px",
					top: (pos === null ? 0 : pos.top) + "px",
					visibility: pos === null ? "hidden" : "visible",
				},
			},
				react.createElement("div", { className: "dsh-tide-head" },
					react.createElement("span", { className: "dsh-tide-title" }, "计费时段与余额"),
					react.createElement("button", { type: "button", className: "dsh-tide-refresh", onClick: refresh }, "刷新"),
				),
				body,
				react.createElement("div", {
					className: panelIsError(bal) ? "dsh-tide-note dsh-tide-err" : "dsh-tide-note",
				}, note),
				react.createElement("div", { className: "dsh-tide-foot" },
					"高峰：北京时间周一至周五 09:00\u201312:00、14:00\u201318:00（不含法定节假日）"),
			);

			const floating = reactDom !== null && typeof reactDom.createPortal === "function"
				? reactDom.createPortal(panel, document.body)
				: panel;
			return react.createElement(react.Fragment, null, chip, floating);
		}

		/**
		 * 有会话钩子时取 `running`（会话快照里的布尔位）。单独一层组件是为了
		 * 让 `props.useSession` 成为**无条件**调用，符合 Hooks 规则。
		 */
		function TideBadgeLive(props) {
			const running = props.useSession((snapshot) => snapshot !== null
				&& snapshot !== undefined
				&& snapshot.running === true) === true;
			return react.createElement(TideBadgeBody, { sessionId: props.sessionId, running });
		}

		/**
		 * dock 条目入口。0.2.x 的 `conversation.composer.dock` 是 session 作用域，
		 * 标准 props 里带 `sessionId` 与 `useSession`；拿不到钩子时退化成
		 * 「不判断 running」，绝不因为探测失败而让药丸不渲染。
		 */
		function TideBadge(props) {
			const useSession = props === null || props === undefined ? undefined : props.useSession;
			if (typeof useSession === "function") return react.createElement(TideBadgeLive, props);
			const sessionId = props === null || props === undefined ? undefined : props.sessionId;
			return react.createElement(TideBadgeBody, { sessionId, running: false });
		}

		const inject = ["slots"];

		function apply(ctx) {
			ctx.effect(() => injectCss(), "tide-badge: core styles");
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register(
					{ name: "conversation.composer.dock", id: "tide-badge", order: DOCK_ORDER },
					TideBadge,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__internal = { panelRows, panelNote, formatMoney, sessionCostOf, observeBalance };
		return module.exports;
	},
});
