/**
 * dsh-tide-badge —— 浏览器半边（模板）
 *
 * 由 build.mjs 把 lib/season.mjs 内联到下面的 SEASON 标记处，生成最终的
 * lib/client.js。这样前端与宿主**共用同一份峰谷与节假日判定源码**，前端不必
 * 自己维护节假日表，也不会出现两端算出的切换点不一致。
 *
 * 形态沿用 billing-badge：一枚小药丸挂在输入框下方的原生统计行里（"缓存命中"
 * 那一排），点击展开面板。数据来自宿主 /plugins/tide-badge/state 单一路由。
 */
window.__ModuleLoader__.load({
	id: "dsh-tide-badge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

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

		/** 样式取自原生统计行与面板，使芯片看起来是那一排的一部分。 */
		const CSS = `
.dsh-tide-badge {
  box-sizing: border-box; max-width: 100%;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  font: inherit; font-variant-numeric: tabular-nums; line-height: inherit;
  white-space: nowrap; background: 0 0; border: none; border-radius: 24px;
  align-items: center; gap: 6px; padding: 1px 8px; display: inline-flex;
  cursor: pointer;
}
.dsh-tide-badge:hover, .dsh-tide-badge[aria-expanded="true"] {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}
.dsh-tide-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dsh-tide-muted { opacity: .6; }
.dsh-tide-balance { opacity: .85; font-variant-numeric: tabular-nums; }
.dsh-tide-balance[hidden] { display: none; }
.dsh-tide-cost[hidden] { display: none; }
/* 面板背景必须用**实心不透明**的 --dsw-alias-bg-layer-1（原生模态卡片 lc-modal-card 同款）。
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

		/** 每页只注入一次样式表。 */
		function injectCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-tide-badge";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/**
		 * 金额格式：**符号后置**（`123¥`、`0.5$`），跟随接口给的币种与精度。
		 *
		 * 0 也要正常显示成 `0¥`：原实现用 `/0+$/` 去尾零，遇到 `0.0000` 会被整串
		 * 吃成空、再被 `/\.$/` 吃掉小数点，最后只剩一个 `¥`。改成 `\.?0+$`
		 * 只吃「小数点及其后的零」，`0` 与 `0.50` 都能留下正确数字。
		 */
		function formatMoney(amount, currency) {
			if (typeof amount !== "number" || !Number.isFinite(amount)) return "--";
			const digits = amount >= 1 ? 2 : 4;
			const text = amount.toFixed(digits).replace(/\.?0+$/, "") || "0";
			const symbol = currency === "CNY" ? "\u00a5" : currency === "USD" ? "$" : currency === "EUR" ? "\u20ac" : "";
			if (symbol !== "") return `${text}${symbol}`;
			return `${text} ${currency || ""}`.trim();
		}

		/** 宿主下发的节假日清单只应用一次，避免每次渲染都重建 Set。 */
		let holidays = null;

		/**
		 * 读宿主状态。失败也返回可渲染的对象，绝不抛出。
		 *
		 * 宿主返回的 holidays 是**节假日判定的单一来源**：把它交给共用的 season
		 * 源码后，前端算出的切换点与宿主完全一致（法定节假日最容易算错切换点）。
		 */
		async function loadState(force) {
			try {
				const response = await fetch(STATE_URL + (force ? "?refresh=1" : ""), { headers: { accept: "application/json" } });
				if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
				const data = await response.json();
				const list = data && data.season && data.season.holidays;
				if (Array.isArray(list) && list.length > 0 && holidays === null) {
					holidays = list;
					setHolidays(list);
				}
				return data;
			} catch (err) {
				return { ok: false, error: String((err && err.message) || err) };
			}
		}

		/**
		 * 面板正文。
		 *
		 * 有时段数据就用宿主下发的（与宿主时刻严格一致），否则用共用的 season
		 * 源码本地算一份（节假日清单已由 setHolidays 注入）。
		 */
		function panelBody(state) {
			const now = new Date();
			const season = (state && state.season) || describePhase(now);
			const bal = state && state.balance;
			const flip = season.flipAt === null || season.flipAt === undefined ? null : new Date(season.flipAt);
			const rows = [];

			const kindText = season.holiday ? "（法定节假日）" : season.weekend ? "（周末）" : "";
			rows.push(["计费时段", (season.peak ? "高峰时段（峰价）" : "空闲时段（谷价，半价）") + kindText]);
			rows.push([
				"下次切换",
				season.countdown === "" || season.countdown === undefined
					? "--"
					: `${season.countdown}后` + (flip === null ? "" : `，${beijingClock(flip).weekday} ${beijingClock(flip).clock}（北京）`),
			]);
			rows.push(["北京时间", `${season.beijing.weekday} ${season.beijing.clock}`]);

			if (bal && bal.ok) {
				rows.push(["账户余额", formatMoney(bal.total, bal.currency) + (bal.currency ? ` ${bal.currency}` : "")]);
				const granted = typeof bal.granted === "number" ? bal.granted : 0;
				const toppedUp = typeof bal.toppedUp === "number" ? bal.toppedUp : 0;
				if (granted > 0) {
					rows.push(["赠送金额", formatMoney(bal.granted, bal.currency)]);
					if (toppedUp > 0) rows.push(["充值金额", formatMoney(bal.toppedUp, bal.currency)]);
				}
				if (bal.isAvailable === false) rows.push(["API 调用", "余额不足", "warn"]);
			} else if (bal) {
				rows.push(["账户余额", "暂不可用"]);
			}
			return rows;
		}

		/** 芯片要挂进的那一行：原生统计行（兼容两种形态）。 */
		function statsRow() {
			const legacy = document.querySelector('[data-composer-stats="true"]');
			if (legacy !== null) return legacy;
			const dock = document.querySelector('[data-slot="conversation.composer.dock"]');
			if (dock === null) return null;
			// 原生文案随语言变化，中英文都要匹配（只匹配 cache hit 会在中文界面挂不上）
			const reading = [...dock.querySelectorAll("button")].find((el) =>
				/cache hit|缓存命中/i.test(el.textContent || ""),
			);
			if (reading === undefined) return null;
			for (const child of dock.children) {
				if (child.contains(reading)) return child;
			}
			return null;
		}

		/** 挂载芯片与面板。 */
		function mountChip(row) {
			injectCss();

			const chip = document.createElement("button");
			chip.type = "button";
			chip.className = "dsh-tide-badge";
			chip.setAttribute("aria-haspopup", "dialog");
			chip.setAttribute("aria-expanded", "false");

			const dot = document.createElement("span");
			dot.className = "dsh-tide-dot";
			const label = document.createElement("span");
			const count = document.createElement("span");
			count.className = "dsh-tide-muted";
			// 账户余额与本次对话花费都常显：不必点开面板就能看到。
			const balance = document.createElement("span");
			balance.className = "dsh-tide-balance";
			const cost = document.createElement("span");
			cost.className = "dsh-tide-muted dsh-tide-cost";
			chip.append(dot, label, count, balance, cost);

			let panel = null;
			let state = null;
			let tick = 0;

			/**
			 * 本次对话花费 —— 用**余额差值**记账。
			 *
			 * 为什么用差值而不是 token×单价：余额减少是**真实扣费**，把缓存命中、
			 * 思考 token、峰谷价这些都交给账单自己去体现，不必维护价目表，也不会
			 * 出现"算出 ¥0.42、实际扣 ¥0.51"的偏差。
			 *
			 * 记账节奏搭在既有的"对话停止一分钟后刷新余额"上（IDLE_REFRESH_MS）：
			 * 每次拿到新余额就与基准做差累加。于是
			 *   · 对话进行中 → 显示已结算的累计值
			 *   · 一轮结束满一分钟后 → 该轮花费被计入
			 *   · 新对话 → 基准即当前余额 → ¥0
			 *
			 * 两个已知边界：
			 *   · 余额是**账户级**读数，若同一账号在别处（手机 App、另一个 DSH）
			 *     同时消耗，那部分会被算进来。
			 *   · 充值会让余额上升，此时不做负向记账（只累加正差值）。
			 */
			const LEDGER_KEY = "dsh-tide-badge/session-cost";
			/** 金额用整数单位累加，避免浮点累加误差。 */
			const MONEY_SCALE = 1e8;
			const toUnits = (v) => {
				const n = Number(v);
				if (!Number.isFinite(n)) return null;
				const u = Math.round(n * MONEY_SCALE);
				return Number.isSafeInteger(u) ? u : null;
			};

			let ledger = {};
			try {
				const raw = window.localStorage.getItem(LEDGER_KEY);
				const parsed = raw === null ? null : JSON.parse(raw);
				if (parsed !== null && typeof parsed === "object") ledger = parsed;
			} catch (err) {
				/* 读不到就当新账本 */
			}
			const saveLedger = () => {
				try {
					window.localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
				} catch (err) {
					/* 存不下不影响本次显示 */
				}
			};

			/** 当前对话 id。取不到时退回 "default"（全局单条账）。 */
			const sessionKey = () => {
				try {
					const ctx = typeof globalThis !== "undefined" ? globalThis.__dshTideBadgeCtx : null;
					const sessions = ctx && typeof ctx.get === "function" ? ctx.get("sessions") : null;
					const list = sessions && sessions.list;
					if (!list || typeof list.getSnapshot !== "function") return "default";
					const snap = list.getSnapshot();
					if (!snap || typeof snap !== "object") return "default";
					if (typeof snap.current === "string" && snap.current !== "") return snap.current;
					const byId = snap.byId;
					if (byId && typeof byId === "object") {
						// 没有显式 current 时，用界面自己的口径：主视图持有的那个会话。
						for (const [id, row] of Object.entries(byId)) {
							if (row && row.retainedBy && (row.retainedBy.mainView ?? 0) > 0) return id;
						}
					}
					return "default";
				} catch (err) {
					return "default";
				}
			};

			/** 本次对话已累计的花费（元）。 */
			const sessionCost = () => {
				const row = ledger[sessionKey()];
				const units = row && Number.isFinite(row.costUnits) ? row.costUnits : 0;
				return units / MONEY_SCALE;
			};

			/**
			 * 芯片上「本次 <金额>」那一段的文案。
			 *
			 * 币种优先跟宿主下发的余额走（账本里只存数字，不存币种）；余额取不到
			 * 时回落到 CNY —— 这是本项目唯一支持的记账币种，好过把整段藏起来。
			 * 永远返回非空串，调用方据此常显 `本次 0¥`。
			 */
			const costText = () => {
				const bal = state && state.balance;
				return "本次 " + formatMoney(sessionCost(), (bal && bal.currency) || "CNY");
			};

			/**
			 * 用一次新的余额读数记账。调用点与余额刷新同步（停止后满一分钟）。
			 * @param {number} total 余额读数
			 */
			const observeIdle = (total) => {
				const units = toUnits(total);
				if (units === null) return;
				const key = sessionKey();
				let row = ledger[key];
				if (!row || !Number.isFinite(row.baseUnits) || !Number.isFinite(row.costUnits)) {
					// 第一次见到这个对话：基准取当前余额，花费记 0。这正是
					// 「新开对话或此前没有此功能的显示为 0 元」。
					row = ledger[key] = { baseUnits: units, costUnits: 0 };
				} else {
					const delta = row.baseUnits - units;
					// 差值 > 0 才是消费；余额上升（充值）不作负向记账。
					if (delta > 0) row.costUnits += delta;
					row.baseUnits = units;
				}
				saveLedger();
			};

			/**
			 * 芯片常显内容：档位 + 倒计时。
			 *
			 * 档位由本地共用源码判定（每秒跟随时钟），倒计时以**宿主下发的切换时刻**
			 * 为准（它已把法定节假日算进去），本地只做秒级推进。
			 */
			const render = () => {
				const local = describePhase(new Date());
				const hostFlipAt = state && state.season ? state.season.flipAt : null;
				let countText = "";
				if (typeof hostFlipAt === "number" && Number.isFinite(hostFlipAt)) {
					const remaining = hostFlipAt - Date.now();
					countText = remaining > 0 ? formatCountdown(remaining) : "";
				} else {
					countText = local.countdown || "";
				}
				dot.style.background = local.color;
				label.textContent = local.compact;
				const narrow = typeof window !== "undefined" && window.matchMedia(NARROW).matches;
				count.textContent = narrow || countText === "" ? "" : "\u00b7 " + countText;
				// 余额常显；失败时留空而不是显示占位符，避免难看。
				const bal = state && state.balance;
				const balText = bal && bal.ok === true ? formatMoney(bal.total, bal.currency) : "";
				balance.textContent = balText === "" ? "" : "\u00b7 " + balText;
				balance.hidden = balText === "";
				// 本次对话花费：always 显示，未产生消费时为 `本次 0¥`。
				// 不隐藏是刻意的 —— 新开对话看不到这一项时，用户无法分辨
				// 是"还没花钱"还是"插件坏了"。
				cost.textContent = "\u00b7 " + costText();
				cost.hidden = false;
				chip.title = local.title;
				if (panel !== null) fillPanel();
			};

			const fillPanel = () => {
				if (panel === null) return;
				const body = panel.querySelector(".dsh-tide-rows");
				const note = panel.querySelector(".dsh-tide-note");
				body.replaceChildren();
				for (const [key, value, tone] of panelBody(state)) {
					const dt = document.createElement("dt");
					dt.textContent = key;
					const dd = document.createElement("dd");
					dd.textContent = value;
					if (tone === "warn") dd.style.color = "var(--dsw-alias-state-warn-primary)";
					body.append(dt, dd);
				}
				const bal = state && state.balance;
				if (bal && bal.ok && bal.source === "account") {
					note.textContent = "余额来自桌面端账号登录态";
				} else if (bal && bal.ok && bal.source === "key") {
					note.textContent = "余额来自 API Key";
				} else {
					// 失败时把两条路的原因都摊开，方便直接定位（否则四种失败长得一样）
					const parts = [];
					if (bal && bal.accountReason) parts.push("账号路：" + String(bal.accountReason));
					if (bal && bal.error) parts.push("API Key 路：" + String(bal.error));
					note.textContent = parts.join("；");
				}
				note.classList.toggle("dsh-tide-err", Boolean(bal && bal.ok === false));
			};

			const placePanel = () => {
				if (panel === null) return;
				const rect = chip.getBoundingClientRect();
				panel.style.visibility = "hidden";
				panel.style.left = "0px";
				panel.style.top = "0px";
				const width = panel.offsetWidth;
				const height = panel.offsetHeight;
				const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
				const above = rect.top - height - 8;
				panel.style.left = `${left}px`;
				panel.style.top = `${above >= 8 ? above : rect.bottom + 8}px`;
				panel.style.visibility = "";
			};

			const onDocumentPointer = (event) => {
				if (panel === null) return;
				if (panel.contains(event.target) || chip.contains(event.target)) return;
				closePanel();
			};
			const onKey = (event) => {
				if (event.key === "Escape") closePanel();
			};
			let repositioning = false;
			const reposition = () => {
				if (panel === null) return;
				const rect = chip.getBoundingClientRect();
				if (rect.bottom < 0 || rect.top > window.innerHeight) {
					closePanel();
					return;
				}
				placePanel();
			};
			const onViewport = () => {
				if (panel === null || repositioning) return;
				repositioning = true;
				window.requestAnimationFrame(() => {
					repositioning = false;
					reposition();
				});
			};

			function closePanel() {
				if (panel === null) return;
				panel.remove();
				panel = null;
				chip.setAttribute("aria-expanded", "false");
				document.removeEventListener("pointerdown", onDocumentPointer, true);
				document.removeEventListener("keydown", onKey, true);
				window.removeEventListener("resize", onViewport);
				window.removeEventListener("scroll", onViewport, true);
			}

			async function openPanel() {
				if (panel !== null) return;
				panel = document.createElement("div");
				panel.className = "dsh-tide-panel";
				panel.setAttribute("role", "dialog");
				panel.setAttribute("aria-label", "计费时段与余额");
				panel.innerHTML =
					'<div class="dsh-tide-head"><span class="dsh-tide-title">计费时段与余额</span>' +
					'<button class="dsh-tide-refresh" type="button">刷新</button></div>' +
					'<dl class="dsh-tide-rows"></dl>' +
					'<div class="dsh-tide-note"></div>' +
					'<div class="dsh-tide-foot">高峰：北京时间周一至周五 09:00–12:00、14:00–18:00（不含法定节假日）</div>';
				panel.querySelector(".dsh-tide-refresh").addEventListener("click", async () => {
					applyState(await loadState(true));
					fillPanel();
				});
				document.body.appendChild(panel);
				chip.setAttribute("aria-expanded", "true");
				fillPanel();
				placePanel();
				document.addEventListener("pointerdown", onDocumentPointer, true);
				document.addEventListener("keydown", onKey, true);
				window.addEventListener("resize", onViewport);
				window.addEventListener("scroll", onViewport, true);
				// 每次打开都取一次：面板上的余额不该是半小时前的旧值。
				// （宿主侧有 60 秒缓存，所以频繁开关也不会真的反复打接口。）
				applyState(await loadState(false));
				fillPanel();
				placePanel();
			}

			chip.addEventListener("click", () => {
				if (panel === null) void openPanel();
				else closePanel();
			});

			/**
			 * 把一份新状态交给芯片，并顺带记一笔账。
			 *
			 * 记账必须挂在这里而不是只挂在自动刷新上：只挂自动刷新的话，首次
			 * 挂载与「打开面板时的刷新」都不会播种基准，于是新对话的「本次」要
			 * 等第一次闲满才出现（实测就是这样）。三条路径都走这里。
			 */
			const applyState = (next) => {
				if (next && next.balance && next.balance.ok === true) observeIdle(next.balance.total);
				state = next;
				render();
			};

			/** 供外部（自动刷新）把新数据交给这个芯片。 */
			chip.__tideApply = (next) => applyState(next);

			render();
			tick = window.setInterval(render, TICK_MS);
			// 后台静默刷新一次，让芯片的倒计时以宿主时刻为准
			void loadState(false).then((s) => {
				if (s && s.ok !== false) applyState(s);
			});

			row.appendChild(chip);

			return () => {
				window.clearInterval(tick);
				closePanel();
				chip.remove();
			};
		}

		/**
		 * 是否有任何会话正在运行（宿主会话列表快照里的 `running`）。
		 *
		 * 这只是**辅助**判据：拿不到就返回 false，让刷新照常发生 —— 绝不因为探测失败
		 * 而把自动刷新永久关掉。它解决的是「一次性长工具调用期间界面静止」这种边界，
		 * 主要判据仍是下面对话区的动静。
		 */
		function anySessionRunning() {
			try {
				const ctx = typeof globalThis !== "undefined" ? globalThis.__dshTideBadgeCtx : null;
				if (ctx === null || ctx === undefined || typeof ctx.get !== "function") return false;
				const sessions = ctx.get("sessions");
				if (sessions === null || sessions === undefined) return false;
				const list = sessions.list;
				if (list === null || list === undefined || typeof list.getSnapshot !== "function") return false;
				const snap = list.getSnapshot();
				const rows = snap && Array.isArray(snap.sessions) ? snap.sessions : [];
				return rows.some((r) => r && r.running === true);
			} catch (err) {
				return false;
			}
		}

		/**
		 * 对话区静止检测：返回 { lastActivity(), stop() }。
		 *
		 * 观察 `[data-conversation-scroll]` 的变动 —— agent 在流式输出、工具调用刷新、
		 * 用户敲字，都会改动这棵子树。任何一次变动都刷新 lastActivity()，
		 * 于是「闲满一分钟」自然等价于「输出结束后用户一分钟没继续」。
		 */
		function startActivityWatch() {
			let last = Date.now();
			let observer = null;
			let tries = 0;

			const root = () => document.querySelector("[data-conversation-scroll]");
			const attach = () => {
				if (observer !== null) return true;
				const el = root();
				if (el === null) return false;
				observer = new MutationObserver(() => { last = Date.now(); });
				observer.observe(el, { childList: true, subtree: true, characterData: true });
				return true;
			};

			if (!attach()) {
				// 挂载早于对话区出现时，轮询直到它出现（最多约 20 秒）
				const timer = window.setInterval(() => {
					tries += 1;
					if (attach() || tries > 40) window.clearInterval(timer);
				}, 500);
				return {
					lastActivity: () => last,
					stop: () => { window.clearInterval(timer); if (observer !== null) observer.disconnect(); },
				};
			}
			return {
				lastActivity: () => last,
				stop: () => { if (observer !== null) observer.disconnect(); },
			};
		}

		/** 无渲染占位：唯一职责是让芯片始终附着在原生统计行上。 */
		function TideMount() {
			react.useEffect(() => {
				let teardown = null;
				let scheduled = false;

				const attach = () => {
					if (teardown !== null && document.querySelector(".dsh-tide-badge") !== null) return;
					const row = statsRow();
					if (row === null) return;
					if (teardown !== null) teardown();
					teardown = mountChip(row);
				};

				const schedule = () => {
					if (scheduled) return;
					scheduled = true;
					window.requestAnimationFrame(() => {
						scheduled = false;
						attach();
					});
				};

				attach();
				const observer = new MutationObserver(schedule);
				observer.observe(document.body, { childList: true, subtree: true });

				// 自动刷新：对话中不动，闲满一分钟且没有会话在跑才取一次新数据
				const watch = startActivityWatch();
				const idleTimer = window.setInterval(() => {
					const chip = document.querySelector(".dsh-tide-badge");
					if (chip === null) return;                                  // 没挂载就没必要请求
					if (typeof document.hidden === "boolean" && document.hidden) return; // 页面在后台
					if (Date.now() - watch.lastActivity() < IDLE_REFRESH_MS) return;     // 还在对话
					if (anySessionRunning()) return;                            // 有会话说在跑
					void loadState(false).then((s) => {
						if (s && s.ok !== false && typeof chip.__tideApply === "function") chip.__tideApply(s);
					});
				}, IDLE_CHECK_MS);

				return () => {
					observer.disconnect();
					window.clearInterval(idleTimer);
					watch.stop();
					if (teardown !== null) teardown();
				};
			}, []);
			return null;
		}

		const inject = ["slots"];

		function apply(ctx) {
			// 供自动刷新时探测“是否有会话在跑”。挂到 globalThis 是因为探测发生在
			// mountChip 的定时器里，那里拿不到 apply 的闭包。
			try { globalThis.__dshTideBadgeCtx = ctx; } catch (err) { /* 忽略 */ }
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register(
					{ name: "conversation.composer.dock", id: "tide-badge", order: 10 },
					TideMount,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__internal = { mountChip, panelBody, statsRow };
		return module.exports;
	},
});
