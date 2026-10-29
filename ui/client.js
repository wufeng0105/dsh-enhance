// dsh-enhance-ui — 设置页：五节，先给结论再给旋钮。
//
// 装载协议与官方 bundle 相同：window.__ModuleLoader__.load({ id, factory })。
// 数据只走 /enhance/api 的四个 op：state / check / set / uninstall(dryRun)。
//
// 页面回答两个问题，其余都是注脚：
//   · 越界时谁说了算
//   · 提示词末尾带不带内容边界
//
// 页面纪律：
//   1. 先结论再旋钮：第一节是「现在会怎么做事」，结论里的分句可跳到对应设置。
//   2. 一个控件只说一次后果：每节四层——标题说事、副行说判据、右上说现状、下面说后果。
//   3. 不用内部指代：「那句话」「尾段」这类词离开上下文就没意义。
//   4. 纯宿主：颜色/圆角/动效全走宿主 token，不画页面底色、不换字体族。
//   5. 只画真实能力：CLI 才能做的事只给命令文本，不做假按钮。
window.__ModuleLoader__.load({
	id: "dsh-enhance-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		var ENDPOINT = "/enhance/api";
		var CSS_TAG = "dsh-enhance-ui/settings.css";

		function call(body) {
			return fetch(ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}).then(function (response) {
				return response.json().then(function (payload) {
					// `check` 的 ok=false 是"检查没过"，是数据不是错误；只有带 code 或 HTTP 失败才抛
					if (!response.ok || (payload && typeof payload.code === "string")) {
						var error = new Error((payload && payload.message) || ("HTTP " + response.status));
						error.code = payload && payload.code;
						throw error;
					}
					return payload;
				});
			});
		}

		// ---------------------------------------------------------------- 文案

		// 三档说的是「拿到审批请求之后怎么回」，与主菜单里那个叫「直接放行」的档位不是一回事，
		// 同名不同义，所以这里的词与菜单错开。
		var APPROVAL = {
			allow: {
				word: "自动同意",
				tone: "warn",
				detail: "越界的事直接做，不再打断你。省事，也等于把边界交出去。",
				why: "回的是 allowed-once：这一次放行，不改档位。",
			},
			ask: {
				word: "先问我",
				tone: "ok",
				detail: "每次停下来等你点同意或回绝；你不在，它就停在那儿等。",
				why: "把请求交还给宿主自己的审批界面，是默认值——状态说不清时也回落到这里。",
			},
			deny: {
				word: "自动回绝",
				tone: "mute",
				detail: "越界的事直接回绝，不给你选择。要它做，先去菜单改档位。",
				why: "回的是 rejected：不给一次性的放行通道。",
			},
		};

		var APPROVAL_ORDER = ["allow", "ask", "deny"];

		// 检查项：API 的 name 是机读键，标题是这一侧的映射——不假设服务端会改文案。
		var CHECK_TITLES = {
			plugins: "插件在进程里",
			text: "文本合不合规",
			inject: "真的进了系统提示",
			// 标题直接写文件名：用户不用猜「派生件」是什么。
			client: "enhance-permissions/client.js",
		};

		function approvalOf(value) {
			return APPROVAL[value] || APPROVAL.ask;
		}

		// ---------------------------------------------------------------- 口径

		// 与 shared/state.mjs 的 normalizeText 同一套：去 BOM → 折 CRLF → 去控制字符 → trim。
		// 口径不一致时，页面上的字节数会和服务端写入的字节数对不上。
		function normalizeText(value) {
			return String(value === null || value === undefined ? "" : value)
				.replace(/^\uFEFF/, "")
				.replace(/\r\n?/g, "\n")
				.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
				.trim();
		}

		function utf8Bytes(text) {
			var s = String(text === null || text === undefined ? "" : text);
			var n = 0;
			for (var i = 0; i < s.length; i += 1) {
				var c = s.charCodeAt(i);
				if (c < 0x80) n += 1;
				else if (c < 0x800) n += 2;
				else if (c >= 0xd800 && c <= 0xdbff) {
					n += 4;
					i += 1;
				} else n += 3;
			}
			return n;
		}

		/** 草稿的字节数：先按服务端口径归一，再数 UTF-8。 */
		function draftBytes(text) {
			return utf8Bytes(normalizeText(text));
		}

		function fmtBytes(n) {
			return n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B";
		}

		/** 错误行里用来指明「哪一节」；与各节的标题一致，便于对照。 */
		var SECTION_LABELS = {
			page: "总开关：",
			approval: "「越界时怎么办」：",
			scope: "「提示词末尾的内容边界」：",
			check: "「检查它真的进去了」：",
			uninstall: "「卸载这一层」：",
		};

		function sectionLabel(section) {
			return SECTION_LABELS[section] || "这一页：";
		}

		/**
		 * 按错误码给一句「怎么改」（WCAG 3.3.3）。服务端的话已经说清了「错在哪」，
		 * 这里只补动作；没有对应建议就返回空串，不硬编一句废话。
		 */
		function errorHint(code) {
			if (code === "ETOOLARGE") return " 删掉一些字再存，上限 8 KB。";
			if (code === "EBADOP") return " 这一页发出了服务端不接受的字段，刷新后重试。";
			if (code === "EIO") return " 写盘失败：检查 <home>/enhance/ 是否可写，然后再试一次。";
			if (code === "EORIGIN") return " 请求来源不被接受：从本机页面操作，别用别的域名访问。";
			if (code === "EMETHOD") return " 请求方法不对，刷新页面重试。";
			return "";
		}

		/** `updatedAt` 是 ISO 字符串；缺值或解析失败显示破折号，不显示 Invalid Date。 */
		function fmtTime(iso) {
			if (typeof iso !== "string" || iso === "") return "—";
			var d = new Date(iso);
			if (isNaN(d.getTime())) return "—";
			return d.toLocaleString();
		}

		/**
		 * 把 snapshot 的 home 拼成「这个目录」的可读路径。
		 * Windows 上混用 `\` 和 `/` 读起来像笔误，所以按 home 自己的分隔符拼。
		 */
		function homePath(state) {
			if (state === null || typeof state.home !== "string" || state.home === "") return "~/.dsh/enhance/";
			var sep = state.home.indexOf("\\") >= 0 ? "\\" : "/";
			return state.home.replace(/[\\/]+$/, "") + sep + "enhance" + sep;
		}

		function jump(id) {
			if (typeof document === "undefined") return;
			var el = document.getElementById(id);
			if (el && typeof el.scrollIntoView === "function") {
				el.scrollIntoView({ behavior: "smooth", block: "center" });
			}
		}

		// ---------------------------------------------------------------- 派生

		/**
		 * 首帧读不到状态时，页面不能就这么锁死：错误行给一个「重试」，
		 * 状态 pill 说「读不到状态」而不是「读取中…」（后者会让用户一直等）。
		 */
		function statusOf(state) {
			if (state === null) return { text: "读取中…", tone: "mute" };
			if (state.enabled === false) return { text: "已停手", tone: "mute" };
			// 插件没挂上时，任何开关都不会生效——这跟「开关关了」是两回事，必须分开说。
			if (state.active === false) return { text: "插件未激活", tone: "bad" };
			if (state.degraded) return { text: "降级运行", tone: "warn" };
			if (state.injecting) return { text: "正在生效", tone: "ok" };
			return { text: "未注入", tone: "warn" };
		}

		/**
		 * 结论句的分句。关闭态只有一句静态文本；开启态三句，前两句可跳到对应节。
		 * 第三句「范围」不可点——这一页改不了档位，给它做入口就是假按钮。
		 */
		function verdictClauses(state) {
			if (state === null) return [];
			if (state.enabled === false) {
				return [{
					kind: "static",
					text: "它已经停手：不接管审批，不往提示词里加字。开关和文本都还在。",
				}];
			}
			var ap = approvalOf(state.approval);
			var empty = normalizeText(state.text) === "";
			var boundary = !state.contentScope
				? "提示词末尾不带内容边界"
				: empty
					? "尾段为空、实际不注入"
					: "提示词末尾带内容边界";
			return [
				{ kind: "jump", text: "越界时" + ap.word, target: "enh-block-approval" },
				{ kind: "jump", text: boundary, target: "enh-block-scope" },
				{ kind: "static", text: "范围按左下角菜单的档位" },
			];
		}

		function metaItems(state) {
			if (state === null) return [];
			return [
				["格式", "v" + state.version],
				["最后改动", fmtTime(state.updatedAt)],
				["文本", fmtBytes(state.bytes || 0)],
				["状态文件", state.degraded ? (state.degradedReason === "missing" ? "不存在（按默认值运行）" : "损坏（按默认值运行）") : "正常"],
			];
		}

		/** 四项按 API 的 name 排；pass 一律用服务端值，本页不伪造 ✓。 */
		function checkRows(checks) {
			if (!checks || !checks.checks) return [];
			return checks.checks.map(function (item) {
				return {
					key: item.name,
					title: CHECK_TITLES[item.name] || item.name,
					pass: item.pass === true,
					detail: item.detail || "",
				};
			});
		}

		/** 把预览的五个状态组摆出来；一组都不丢（参考稿只画了 planned）。 */
		function planGroups(plan) {
			if (plan === null || plan === undefined) return null;
			return {
				planned: plan.planned || [],
				skipped: plan.skipped || [],
				warnings: plan.warnings || [],
				failed: plan.failed || [],
				backups: plan.backups || [],
			};
		}

		// ---------------------------------------------------------------- 样式

		// 全部颜色/圆角/动效走宿主 token。
		// 字体族显式继承宿主（不引入第二字体）；等宽只在代码/数字处用 --ds-font-family-code。
		// 深色：宿主把 body[data-ds-dark-theme] 挂上之后，自己翻 --dsw-alias-* 的值；
		// 我们不重定义任何宿主变量，只补三处「宿主语义色在深色下对比不够」的本地变量。
		var CSS = [
			".enh{display:flex;flex-direction:column;gap:24px;max-width:760px;padding:4px 2px 24px;font-family:var(--dsw-font-family)}",
			"body[data-ds-dark-theme] .enh{--enh-rule:var(--dsw-alias-border-l2);--enh-mark-pass:var(--dsw-alias-state-success-secondary);--enh-mark-fail:var(--dsw-alias-state-error-secondary)}",
			"body:not([data-ds-dark-theme]) .enh{--enh-rule:var(--dsw-alias-border-l2);--enh-mark-pass:var(--dsw-alias-state-success-primary);--enh-mark-fail:var(--dsw-alias-state-error-primary)}",
			".enh-eyebrow{display:flex;align-items:center;justify-content:space-between;gap:12px}",
			".enh-eyebrow-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".enh-title-row{display:flex;align-items:center;gap:8px}",
			".enh-h1{margin:0;font:var(--dsw-font-xl-24);color:var(--dsw-alias-label-primary)}",
			".enh-pill{font-size:12px;line-height:16px;padding:2px 8px;border-radius:var(--dsw-radius-xs);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
			".enh-pill[data-tone=ok]{color:var(--dsw-alias-state-success-primary);border-color:currentColor}",
			".enh-pill[data-tone=warn]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}",
			".enh-pill[data-tone=bad]{color:var(--dsw-alias-state-error-primary);border-color:currentColor}",
			".enh-pill[data-tone=mute]{color:var(--dsw-alias-label-tertiary)}",
			".enh-lede{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
			".enh-block{display:flex;gap:16px;border-top:1px solid var(--enh-rule);padding-top:16px}",
			".enh-rail{flex:none;width:26px;padding-top:2px}",
			".enh-idx{font:12px/18px var(--ds-font-family-code);color:var(--dsw-alias-label-tertiary)}",
			".enh-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:12px}",
			".enh-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}",
			".enh-h3{margin:0;font:var(--dsw-font-s-14);font-weight:600;color:var(--dsw-alias-label-primary)}",
			".enh-sub{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".enh-now{flex:none;font-size:12px;line-height:18px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}",
			".enh-now[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}",
			".enh-now[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}",
			".enh-now[data-tone=bad]{color:var(--dsw-alias-state-error-primary)}",
			".enh-now[data-tone=mute]{color:var(--dsw-alias-label-tertiary)}",
			".enh-verdict{margin:0;font:var(--dsw-font-m-18);font-weight:400;color:var(--dsw-alias-label-primary)}",
			".enh-clause{font:inherit;color:inherit;background:none;border:none;padding:0;cursor:pointer;box-shadow:inset 0 -1px 0 var(--dsw-alias-border-l4)}",
			".enh-clause:hover,.enh-clause:focus-visible{box-shadow:inset 0 -1px 0 var(--dsw-alias-label-primary)}",
			".enh-static{color:var(--dsw-alias-label-secondary)}",
			".enh-sep{color:var(--dsw-alias-label-tertiary)}",
			".enh-meta{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".enh-meta b{color:var(--dsw-alias-label-secondary);font-weight:500}",
			".enh-banner{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l4);padding:2px 0 2px 12px}",
			".enh-seg{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);align-self:flex-start}",
			".enh-seg-btn{font:inherit;font-size:13px;line-height:20px;padding:4px 12px;border:none;border-radius:var(--dsw-radius-xs);background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}",
			".enh-seg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".enh-seg-btn[aria-checked=true]{background:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:500}",
			".enh-seg-btn:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
			".enh-switch{display:inline-flex;align-items:center;gap:8px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:none;border:none;padding:0;cursor:pointer}",
			".enh-switch:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
			".enh-track{width:30px;height:16px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-border-l2);position:relative;flex:none;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}",
			".enh-switch[aria-checked=true] .enh-track{background:var(--dsw-alias-state-success-primary)}",
			".enh-knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform var(--ds-transition-duration-fast) var(--ds-ease-in-out)}",
			".enh-switch[aria-checked=true] .enh-knob{transform:translateX(14px)}",
			".enh-textarea{width:100%;min-height:76px;box-sizing:border-box;font:13px/20px var(--ds-font-family-code);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:8px;resize:vertical}",
			".enh-textarea:disabled{color:var(--dsw-alias-label-tertiary)}",
			".enh-textmeta{display:flex;justify-content:space-between;gap:12px;font:12px/18px var(--ds-font-family-code);color:var(--dsw-alias-label-tertiary)}",
			".enh-over{color:var(--dsw-alias-state-error-primary)}",
			".enh-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
			".enh-btn{font:inherit;font-size:13px;line-height:20px;padding:4px 12px;min-width:72px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-primary);cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}",
			".enh-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".enh-btn[data-kind=primary]{background:var(--dsw-alias-border-l2);font-weight:500}",
			".enh-btn[data-kind=danger]{color:var(--dsw-alias-state-error-primary);border-color:currentColor}",
			// 必须排在 data-kind 之后：同特异性下后写的赢，否则禁用态仍显示危险色
			".enh-btn:disabled,.enh-btn[data-kind]:disabled,.enh-btn[data-kind=danger]:disabled{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l2);background:none;cursor:default}",
			".enh-reason{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l4);padding:2px 0 2px 12px}",
			".enh-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".enh-term{margin:2px 0 0}",
			".enh-term>summary{cursor:pointer;list-style:none}",
			".enh-term>summary::-webkit-details-marker{display:none}",
			".enh-term>summary::before{content:'\u203A\u00a0';color:var(--dsw-alias-label-tertiary)}",
			".enh-term[open]>summary::before{content:'\u2304\u00a0'}",
			".enh-term>p{margin:4px 0 0}",
			".enh-term>summary:hover{color:var(--dsw-alias-label-secondary)}",
			".enh-checks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}",
			".enh-check-row{display:grid;grid-template-columns:16px minmax(0,1fr) 44%;gap:8px;padding:4px 0;border-top:1px solid var(--enh-rule);font-size:12px;line-height:18px;align-items:start}",
			".enh-mark{font:12px/18px var(--ds-font-family-code);text-align:center}",
			".enh-mark[data-r=pass]{color:var(--enh-mark-pass)}",
			".enh-mark[data-r=fail]{color:var(--enh-mark-fail)}",
			".enh-name{color:var(--dsw-alias-label-primary)}",
			".enh-ev{font:11px/18px var(--ds-font-family-code);color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}",
			".enh-group{display:flex;flex-direction:column;gap:8px}",
			// 分组之间要留白；写成一条高特异性规则，避免被上面那条 4px 的通用规则压掉（原来那条 14px 从未生效）。
			".enh-body .enh-group+.enh-group{margin-top:16px}",
			".enh-body .enh-actions,.enh-body .enh-choice{margin-top:4px}",
			".enh-h4{margin:0 0 2px;font:12px/18px var(--ds-font-family-code);color:var(--dsw-alias-label-tertiary)}",
			".enh-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}",
			".enh-row{display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".enh-tag{font:11px/18px var(--ds-font-family-code);text-align:left;white-space:nowrap}",
			".enh-tag[data-k=del]{color:var(--dsw-alias-state-error-primary)}",
			".enh-tag[data-k=arc]{color:var(--dsw-alias-state-business-primary)}",
			".enh-tag[data-k=keep]{color:var(--dsw-alias-state-success-primary)}",
			".enh-tag[data-k=back]{color:var(--dsw-alias-state-warn-primary)}",
			".enh-code{font:11px/18px var(--ds-font-family-code);color:var(--dsw-alias-label-secondary)}",
			".enh-choice{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:2px 0 0}",
			".enh-choice input{margin-top:2px;accent-color:var(--dsw-alias-label-primary)}",
			".enh-out{margin:0;font:11px/18px var(--ds-font-family-code);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-sm);padding:8px}",
			".enh-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}",
		].join("\n");

		// ---------------------------------------------------------------- 控件

		// 这一页只用六类控件。每类只在这里定义一次外形，调用点不许再写 className。
		// 这样「同类控件长得一样」是结构保证，不是靠自觉（Nielsen #4 一致性）。
		// 没有抽成独立文件：本仓无构建链、单文件 bundle，抽文件要动 loader 与 code-map，
		// 收益只是少几行重复，不划算。

		function Button(props) {
			return h("button", {
				type: "button",
				className: "enh-btn",
				"data-kind": props.kind,
				disabled: props.disabled === true,
				onClick: props.onClick,
				key: props.key,
			}, props.children);
		}

		function Switch(props) {
			return h("button", {
				type: "button",
				className: "enh-switch",
				role: "switch",
				// 状态未知时用 "mixed"：说 false 等于告诉屏幕阅读器「已关闭」，而真相是「还不知道」
				"aria-checked": props.checked === "mixed" ? "mixed" : props.checked === true,
				disabled: props.disabled === true,
				onClick: props.onClick,
			},
				h("span", { className: "enh-track" }, h("span", { className: "enh-knob" })),
				h("span", null, props.children),
			);
		}

		function TextArea(props) {
			return h("textarea", {
				className: "enh-textarea",
				spellCheck: false,
				"aria-label": props.label,
				value: props.value,
				disabled: props.disabled === true,
				onChange: props.onChange,
			});
		}

		function Segmented(props) {
			return h("div", {
				className: "enh-seg",
				role: "radiogroup",
				"aria-label": props.label,
				onKeyDown: props.onKeyDown,
			}, props.children);
		}

		function Option(props) {
			return h("button", {
				type: "button",
				role: "radio",
				className: "enh-seg-btn",
				"aria-checked": props.checked === true,
				tabIndex: props.checked === true ? 0 : -1,
				disabled: props.disabled === true,
				onClick: props.onClick,
				key: props.key,
			}, props.children);
		}

		function Checkbox(props) {
			return h("input", {
				type: "checkbox",
				checked: props.checked === true,
				disabled: props.disabled === true,
				onChange: props.onChange,
			});
		}

		/** 结论句里可点的那一段。与 Button 分开：它长得像链接，不共用外观。 */
		function Clause(props) {
			return h("button", {
				type: "button",
				className: "enh-clause",
				onClick: props.onClick,
			}, props.children);
		}

		function Tag(props) {
			return h("span", { className: "enh-tag", "data-k": props.kind }, props.children);
		}

		// ---------------------------------------------------------------- 组件

		function EnhanceSection() {
			var stateBox = React.useState(null);
			var state = stateBox[0];
			var setState = stateBox[1];

			var draftBox = React.useState("");
			var draft = draftBox[0];
			var setDraft = draftBox[1];

			var busyBox = React.useState(false);
			var busy = busyBox[0];
			var setBusy = busyBox[1];

			var errorBox = React.useState(null);
			var error = errorBox[0];
			var setError = errorBox[1];

			var checksBox = React.useState(null);
			var checks = checksBox[0];
			var setChecks = checksBox[1];

			var planBox = React.useState(null);
			var plan = planBox[0];
			var setPlan = planBox[1];

			var thoroughBox = React.useState(false);
			var thorough = thoroughBox[0];
			var setThorough = thoroughBox[1];

			var confirmBox = React.useState(false);
			var confirmThorough = confirmBox[0];
			var setConfirmThorough = confirmBox[1];

			/**
			 * 用服务端快照替换本地状态。
			 *
			 * 只有「文本确实变了」才覆盖草稿——否则切一下开关就会把用户没保存的编辑静默丢掉。
			 * 首帧（state 为 null）必须覆盖，那时草稿还是空的。
			 */
			function adopt(next) {
				var previous = state === null ? null : state.text;
				setState(next);
				if (previous === null || previous !== next.text) setDraft(next.text || "");
			}

			/**
			 * 每个 section 各自一行错误：错误贴住它来的地方，不做一个全页横幅。
			 *
			 * WCAG 3.3.1 要求「指明哪一项出错」，3.3.3 要求「给出怎么改」：
			 * 所以这一行由三部分组成——节名 + 服务端原话 + 一句针对 code 的建议。
			 */
			function fail(section, err) {
				var code = err && err.code ? String(err.code) : "";
				var message = (err && err.message) || "未知错误";
				setError({
					section: section,
					text: sectionLabel(section) + "没成：" + message + (code ? "（" + code + "）" : "") + errorHint(code),
				});
			}

			/**
			 * 发一个请求。
			 *
			 * 错误行只清掉「同一节」的那条：在别的节成功，不该把这一节还没处理的错误擦掉
			 * （擦掉之后用户既看不到原因，也看不到自己修没修好）。
			 */
			function run(section, promise, done) {
				setBusy(true);
				setError(function (current) {
					return current !== null && current.section === section ? null : current;
				});
				return promise
					.then(function (result) {
						if (done) done(result);
						else if (result && result.ok) adopt(result);
					})
					.catch(function (err) {
						fail(section, err);
					})
					.then(function () {
						setBusy(false);
					});
			}

			React.useEffect(function () {
				run("page", call({ op: "state" }));
			}, []);

			function errorLine(section) {
				if (error === null || error.section !== section) return null;
				return h("p", { className: "enh-error", role: "alert" }, error.text);
			}

			var on = state !== null && state.enabled !== false;
			var locked = busy || state === null || !on;
			var status = statusOf(state);
			var ap = approvalOf(state === null ? "ask" : state.approval);
			var bytes = state === null ? 0 : state.bytes || 0;
			var draftSize = draftBytes(draft);
			var over = state !== null && draftSize > state.limit;
			// 03 右上角说的是「服务端现在会怎么做事」，所以只能看已保存的文本；
			// 草稿的空白与否只影响按钮禁用态，不能拿去改写状态显示（否则清空未保存时自相矛盾）。
			var savedEmpty = state !== null && normalizeText(state.text) === "";
			var groups = planGroups(plan);

			function section(index, id, title, sub, now, nowTone, body, consequence) {
				return h("section", { className: "enh-block", id: id, key: id },
					h("div", { className: "enh-rail" }, h("span", { className: "enh-idx" }, index)),
					h("div", { className: "enh-body" },
						h("div", { className: "enh-head" },
							h("div", null,
								h("h3", { className: "enh-h3" }, title),
								sub === null ? null : h("p", { className: "enh-sub" }, sub),
							),
							now === null ? null : h("span", { className: "enh-now", "data-tone": nowTone }, now),
						),
						body,
						consequence === null ? null : h("p", { className: "enh-reason" }, consequence),
					),
				);
			}

			// 01 结论 ------------------------------------------------------
			var clauses = verdictClauses(state);
			var verdictNodes = [];
			clauses.forEach(function (clause, i) {
				if (i > 0) verdictNodes.push(h("span", { className: "enh-sep", key: "sep" + i }, "；"));
				verdictNodes.push(clause.kind === "jump"
					? h(Clause, { key: "c" + i, onClick: function () { jump(clause.target); } }, clause.text)
					: h("span", { key: "c" + i, className: "enh-static" }, clause.text));
			});
			if (clauses.length > 1) verdictNodes.push(h("span", { key: "dot" }, "。"));

			var blockVerdict = section("01", "enh-block-verdict", "现在会怎么做事",
				"三句是组合结果，不是把开关念一遍。", null, null,
				h("div", null,
					h("p", { className: "enh-verdict", "aria-live": "polite" }, verdictNodes),
					h("div", { className: "enh-meta" },
						metaItems(state).map(function (pair) {
							return h("span", { key: pair[0] }, pair[0] + " ", h("b", null, pair[1]));
						}),
					),
					h("div", { className: "enh-banner" },
						h("b", null, "当前会话档位以左下角菜单为准。"),
						"本页不读、也不显示具体档位；这一页只能改审批三档，改不了权限范围。",
					),
					errorLine("page"),
				), null);

			// 02 审批 ------------------------------------------------------
			var blockApproval = section("02", "enh-block-approval", "越界时怎么办",
				"它想做的事，超出当前权限档位允许的范围时。",
				state === null ? "—" : (on ? ap.word : "不接管"),
				state === null ? "mute" : (on ? ap.tone : "mute"),
				h("div", null,
					h(Segmented, {
						label: "越界时怎么办",
						onKeyDown: function (event) {
							if (locked) return;
							// WAI-ARIA APG radio group：Tab 进出整组，方向键在组内移动**并选中**，两端回绕。
							// Right/Down 前进、Left/Up 后退——只做水平方向是不完整的。
							var at = APPROVAL_ORDER.indexOf(state === null ? "ask" : state.approval);
							if (at < 0) at = 1;
							var forward = event.key === "ArrowRight" || event.key === "ArrowDown";
							var backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
							if (forward) at = (at + 1) % APPROVAL_ORDER.length;
							else if (backward) at = (at + APPROVAL_ORDER.length - 1) % APPROVAL_ORDER.length;
							else if (event.key === " " || event.key === "Enter") {
								// Space/Enter：按钮原生行为已经会 click，这里只需拦掉滚动
								if (event.key === " ") event.preventDefault();
								return;
							} else return;
							event.preventDefault();
							run("approval", call({ op: "set", approval: APPROVAL_ORDER[at] }));
						},
					}, APPROVAL_ORDER.map(function (value) {
						var checked = state !== null && state.approval === value;
						return h(Option, {
							key: value,
							checked: checked,
							disabled: locked,
							onClick: function () { run("approval", call({ op: "set", approval: value })); },
						}, APPROVAL[value].word);
					})),
					// 术语说明收进折叠区：它是「为什么这三个词和主菜单不一样」的注解，
					// 不是当前状态的一部分。常驻会在用户选「先问我」时原地讲「自动同意」，读起来像没更新。
					h("details", { className: "enh-term" },
						h("summary", { className: "enh-hint" }, "为什么这三个词和主菜单不一样"),
						h("p", { className: "enh-hint" }, "主菜单里已经有一个叫「直接放行」的档位，那是权限范围；这里三档说的是拿到审批请求之后怎么回。同名不同义，所以这里用「自动同意」「自动回绝」。"),
					),
					errorLine("approval"),
				),
				state === null
					? null
					: !on
						? "总开关关着，这一段只是存下来的偏好，不生效；审批交回宿主策略——宿主说 never 就直接拒，说 ask 就弹给你，不是自动放行。"
						: ap.detail + " 拿到审批请求之后回什么：" + ap.why + " 完全权限（never）下宿主不发请求，三档都轮不到。");

			// 03 边界 ------------------------------------------------------
			var blockScope = section("03", "enh-block-scope", "提示词末尾的内容边界",
				"挂在系统提示的最后一段之后（persona-suffix 之后），每条消息都带。",
				state === null ? "—" : !on ? "不生效" : !state.contentScope ? "不带" : savedEmpty ? "空文本" : "带 · " + fmtBytes(bytes),
				state === null ? "mute" : (!on || !state.contentScope || savedEmpty ? "mute" : "ok"),
				h("div", null,
					h(Switch, {
						checked: state !== null && state.contentScope === true,
						disabled: locked,
						onClick: function () { run("scope", call({ op: "set", contentScope: !(state !== null && state.contentScope) })); },
					}, state !== null && state.contentScope === true ? "在提示词末尾追加这段文字" : "不加这段文字"),
					h(TextArea, {
						label: "内容边界",
						value: draft,
						disabled: locked,
						onChange: function (event) { setDraft(event.target.value); },
					}),
					h("div", { className: "enh-textmeta" },
						h("span", { className: over ? "enh-over" : "" }, fmtBytes(draftSize) + " / 上限 " + fmtBytes(state === null ? 8192 : state.limit)),
						h("span", null, "sha " + (state === null || state.degraded ? "—" : state.sha256 || "—")),
					),
					h("div", { className: "enh-actions" },
						h(Button, { kind: "primary", disabled: locked || over || draft === (state === null ? "" : state.text), onClick: function () { run("scope", call({ op: "set", text: draft })); } }, "保存"),
						h(Button, { disabled: locked || draft === (state === null ? "" : state.text), onClick: function () { setDraft(state === null ? "" : state.text || ""); } }, "还原"),
						h(Button, { disabled: locked || draft === "", onClick: function () { setDraft(""); } }, "清空（= 不加）"),
						over ? h("span", { className: "enh-hint" }, "超上限，删一点再存") : null,
					),
					errorLine("scope"),
				),
				state === null
					? null
					: state.enabled === false
						? "总开关关着，这一段不注入。"
						: state.injecting
							? "四个条件都成立：插件在本进程活着、总开关开、这个开关开、文本非空——现在真的会注入。"
							: "现在没有注入，卡在：" + (state.reason || "未知原因") + "。");

			// 04 检查 ------------------------------------------------------
			var rows = checkRows(checks);
			var allPass = rows.length > 0 && rows.every(function (r) { return r.pass; });
			var blockCheck = section("04", "enh-block-check", "检查它真的进去了",
				"翻最新一份会话日志读回系统提示，证明那段文字确实在末尾。只读，不改任何东西。",
				checks === null ? "还没查过" : (allPass ? "全部通过" : "有失败项"),
				checks === null ? "mute" : (allPass ? "ok" : "bad"),
				h("div", null,
					h("div", { className: "enh-actions" },
						h(Button, { disabled: busy || state === null, onClick: function () {
								run("check", call({ op: "check" }), function (result) { setChecks(result); });
							} }, checks === null ? "开始检查" : "再查一次"),
						h("span", { className: "enh-hint" }, "读最新一份会话日志；多工作区并行时可能读到别的工作区。"),
					),
					checks === null
						? h("p", { className: "enh-hint" }, "还没有结果。")
						: h("ul", { className: "enh-checks", "aria-live": "polite" },
							rows.map(function (row) {
								return h("li", { key: row.key, className: "enh-check-row" },
									h("span", { className: "enh-mark", "data-r": row.pass ? "pass" : "fail" }, row.pass ? "✓" : "✗"),
									h("span", { className: "enh-name" }, row.title),
									h("span", { className: "enh-ev" }, row.detail),
								);
							})),
					errorLine("check"),
				),
				checks === null
					? null
					: allPass
						? "四项都过了：插件在、文本合规、会话日志里确实有那段文字、派生件带戳。"
						: "有项没过，说明现在还不能确认它真的生效；上面的证据列写的是卡在哪。");

			// 05 卸载 ------------------------------------------------------
			function tagged(title, items) {
				return h("div", { className: "enh-group", key: title },
					h("h4", { className: "enh-h4" }, title),
					items.length === 0
						? h("p", { className: "enh-hint" }, "（无）")
						: h("ul", { className: "enh-rows" }, items.map(function (row, i) {
							return h("li", { key: title + i, className: "enh-row" },
								h(Tag, { kind: row.kind }, row.tag),
								h("span", row.code ? { className: "enh-code" } : null, row.text),
							);
						})),
				);
			}

			function taggedFromList(title, kind, tag, list) {
				return tagged(title, list.map(function (text) {
					return { kind: kind, tag: tag, text: text };
				}));
			}

			var confirmLabel = plan === null
				? "确认卸载"
				: thorough
					? (confirmThorough ? "再次确认：彻底删除" : "确认彻底清理")
					: "确认卸载";

			var previewText = groups === null ? "" : [
				groups.planned.length === 0 ? null : "planned:\n" + groups.planned.join("\n"),
				groups.skipped.length === 0 ? null : "skipped:\n" + groups.skipped.join("\n"),
				groups.warnings.length === 0 ? null : "warnings:\n" + groups.warnings.join("\n"),
				groups.failed.length === 0 ? null : "failed:\n" + groups.failed.join("\n"),
			].filter(Boolean).join("\n\n") || "（没有可删的行）";

			var blockUninstall = section("05", "enh-block-uninstall", "卸载这一层",
				"先看影响再决定。生效层必做；用户数据默认归档，「彻底清理」是另一档。",
				plan === null ? "已安装" : "待确认",
				plan === null ? "mute" : "warn",
				h("div", null,
					tagged("生效层（必做）", [
						{ kind: "del", tag: "删除", text: "三行挂载：enhance-scope / auto-approve / enhance-ui" },
						{ kind: "del", tag: "删除", text: "权限替换行 enhance-permissions，并把 ui-permission 的 disabled 还回去" },
						{ kind: "del", tag: "删除", text: homePath(state), code: true },
					]),
					h("div", { className: "enh-group" },
						h("h4", { className: "enh-h4" }, "用户数据"),
						h("ul", { className: "enh-rows" },
							h("li", { className: "enh-row" },
								h(Tag, { kind: "arc" }, "归档"),
								h("span", null, "默认：state.json / content-scope.txt / install-manifest.json 先归档到 enhance-archive-<时间戳>/，再删目录"),
							),
							h("li", { className: "enh-row" },
								h(Tag, { kind: "del" }, "不归档"),
								h("span", null, "彻底清理：不归档，随目录一起删掉"),
							),
						),
						h("label", { className: "enh-choice" },
							h(Checkbox, {
								checked: thorough,
								disabled: busy || plan === null,
								onChange: function (event) {
									var next = event.target.checked;
									setThorough(next);
									setConfirmThorough(false);
									run("uninstall", call({ op: "uninstall", dryRun: true, thorough: next }), function (result) { setPlan(result); });
								},
							}),
							h("span", null, "彻底清理：不归档，并删掉本工具自己造的 .bak-* 备份。别人写的备份不动。"),
						),
					),
					// 这一组的标题与标签必须跟着 thorough 走：勾了彻底清理，这些备份是要被删的，
					// 再写「默认保留 / 保留」就是自相矛盾（用户实测指出过这一点）。
					groups === null
						? tagged("回滚备份", [])
						: tagged(
							thorough ? "回滚备份（彻底清理会删掉）" : "回滚备份（默认保留）",
							groups.backups.map(function (item) {
								return {
									kind: thorough ? "del" : "keep",
									tag: thorough ? "会删" : "保留",
									text: item.profile + " / " + item.name,
								};
							}),
						),
					plan === null ? null : h("div", { className: "enh-group" },
						h("h4", { className: "enh-h4" }, "预览明细"),
						h("pre", { className: "enh-out" }, previewText),
					),
					plan === null ? null : taggedFromList("预览里的跳过与告警", "back", "留意",
						groups.skipped.concat(groups.warnings).concat(groups.failed)),
					h("div", { className: "enh-actions" },
						h(Button, { disabled: busy || state === null, onClick: function () { run("uninstall", call({ op: "uninstall", dryRun: true, thorough: thorough }), function (result) { setPlan(result); }); } }, "先看影响"),
						h(Button, { kind: "danger", disabled: busy || plan === null, onClick: function () {
								if (thorough && !confirmThorough) {
									setConfirmThorough(true);
									return;
								}
								run("uninstall", call({ op: "uninstall", thorough: thorough }), function () {
									setPlan(null);
									setConfirmThorough(false);
								});
							} }, confirmLabel),
						h(Button, { disabled: busy || plan === null, onClick: function () { setPlan(null); setConfirmThorough(false); } }, "取消"),
					),
					errorLine("uninstall"),
					h("div", { className: "enh-group" },
						h("h4", { className: "enh-h4" }, "归档之后怎么恢复（命令行）"),
						h("ul", { className: "enh-rows" },
							h("li", { className: "enh-row" },
								h(Tag, { kind: "arc" }, "CLI"),
								h("span", { className: "enh-code" }, "node install.mjs --home <DSH_HOME> --restore <归档目录> --replace"),
							),
							h("li", { className: "enh-row" },
								h(Tag, { kind: "arc" }, "说明"),
								h("span", null, "先加 --dry-run 看一遍；归档不参与加载，重装不会自动读；只写回 state.json 与 content-scope.txt"),
							),
							h("li", { className: "enh-row" },
								h(Tag, { kind: "back" }, "不是这个"),
								h("span", null, "--to <备份文件> 是回滚一个档位的 patch，保留 enhance/ 与 staging，不叫卸载"),
							),
						),
					),
				),
				"这一步在真机上会先回包、再动手（needRestart: true），重启后生效。");

			// 页面 ---------------------------------------------------------
			return h("div", { className: "enh" },
				h("div", { className: "enh-eyebrow" },
					h("span", { className: "enh-eyebrow-label" }, "ENHANCE · 设置"),
					h(Switch, {
						checked: state === null ? "mixed" : on,
						disabled: busy || state === null,
						onClick: function () { run("page", call({ op: "set", enabled: !on })); },
					}, state === null ? "总开关：读取中" : "总开关" + (on ? "开" : "关")),
				),
				h("div", { className: "enh-title-row" },
					h("h1", { className: "enh-h1" }, "增强"),
					h("span", { className: "enh-pill", "data-tone": status.tone }, status.text),
					// 首帧失败时给一条出路：否则 12 个控件全灰，只能刷新页面
					state === null && error !== null && error.section === "page"
						? h(Button, {
							onClick: function () { run("page", call({ op: "state" })); },
						}, "重试")
						: null,
				),
				h("p", { className: "enh-lede" }, "这一页只说清两件事：越界时谁说了算，提示词末尾带不带内容边界。改完不用重启——下一条消息就按新的来。"),
				blockVerdict,
				blockApproval,
				blockScope,
				blockCheck,
				blockUninstall,
			);
		}

		function apply(ctx) {
			// CSS 挂载：Node 测试里没有 document；假 ctx 也没有 effect。两个守卫都必要。
			if (typeof document !== "undefined" && ctx && typeof ctx.effect === "function") {
				ctx.effect(function () {
					if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") !== null) {
						return function () {};
					}
					var tag = document.createElement("style");
					tag.dataset.plugin = "dsh-enhance-ui";
					tag.dataset.pluginCss = CSS_TAG;
					tag.textContent = CSS;
					document.head.appendChild(tag);
					return function () {
						if (tag.parentNode) tag.parentNode.removeChild(tag);
					};
				});
			}
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "enhance",
					order: 30,
					label: function () { return "增强"; },
					inject: function () { return {}; },
				}, EnhanceSection);
			});
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		exports.__testing = {
			call: call,
			normalizeText: normalizeText,
			draftBytes: draftBytes,
			verdictClauses: verdictClauses,
			checkRows: checkRows,
			planGroups: planGroups,
			approvalOf: approvalOf,
			metaItems: metaItems,
		};
		return module.exports;
	},
});
