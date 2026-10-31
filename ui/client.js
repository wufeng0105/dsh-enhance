// dsh-enhance-ui — 设置页：四组设置，按宿主设置页的刻度排版（16/24 标题、14/22 行标题、
// 0.5px 发丝线、12px 节间距、720 宽度上限），先给控件再给后果，没有的按钮不画。
//
// 装载协议与官方 bundle 相同：window.__ModuleLoader__.load({ id, factory })。
// 数据只走 /enhance/api 的四个 op：state / check / set / preset。
//
// 页面纪律：
//   1. 一屏只有四件事：内容边界、越界审批、Enhanced 权限档、检查。别的都删了——
//      装/卸/升级归插件市场，本页不重复一遍。
//   2. 一个控件只说一次后果：每组是「标题 + 右上现状 + 正文 + 一行后果」。
//   3. 不用内部指代：「那句话」「尾段」这类词离开上下文就没意义。
//   4. 纯宿主：颜色/圆角/动效/焦点环全走宿主 token，不画页面底色、不换字体族。
//   5. 只画真实能力：CLI 或市场才能做的事只给说明，不做假按钮。
//
// 语义边界（这一页最容易做错的地方）：
//   本页能改「档位**存在与否**」——点一下就往当前 profile 的 patch 里写 Enhanced 档；
//   但改不了「这一轮用哪个档」——那永远归宿主的档位菜单。
//
// 主线在这一页的落法：只追加一段文本、只多声明一个档位，别的一个字不动。
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

		// 三档说的是「拿到审批请求之后怎么回」，与档位菜单里那几档不是一回事——
		// 菜单管的是权限范围，这里的词与它错开，叫「自动同意」「先问我」「自动回绝」。
		var APPROVAL = {
			allow: {
				word: "自动同意",
				tone: "warn",
				note: "越界的事直接做，不再打断你——回一次性的 allowed-once，只放行这一次，不改档位。",
			},
			ask: {
				word: "先问我",
				tone: "ok",
				note: "每次停下来等你点同意或回绝，你不在就停在那儿等——把决定交还宿主自己的审批界面；状态说不清时也回落到这里。",
			},
			deny: {
				word: "自动回绝",
				tone: "mute",
				note: "越界的事直接回绝，不给你选择——回 rejected，不留一次性放行的通道。",
			},
		};

		var APPROVAL_ORDER = ["allow", "ask", "deny"];

		// 检查项：API 的 name 是机读键，标题是这一侧的映射——不假设服务端会改文案。
		var CHECK_TITLES = {
			plugins: "插件在进程里",
			text: "文字合规",
			inject: "真的进了系统提示",
			preset: "Enhanced 档",
		};

		/** 三态真正起作用的档位：宿主只在「沙箱挡住 → 申请放宽」时发审批请求。名称用宿主中文菜单的叫法。 */
		var APPROVAL_SCOPE_HINT = "该设置只对「仅可查看」和「工作区内修改」两个档位生效。当档位为「完全权限」或「Enhanced」时，宿主不会产生需要审批的请求，因此这三项不会起作用。";

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

		/** 错误行里用来指明「哪一组」；与各组的标题一致，便于对照。 */
		var SECTION_LABELS = {
			page: "页面：",
			scope: "「内容边界」：",
			approval: "「越界审批」：",
			preset: "「Enhanced 权限档」：",
			check: "「检查」：",
		};

		function sectionLabel(section) {
			return SECTION_LABELS[section] || "这一页：";
		}

		/**
		 * 按错误码给一句「怎么改」（WCAG 3.3.3）。服务端的话已经说清了「错在哪」，
		 * 这里只补动作；没有对应建议就返回空串，不硬编一句废话。
		 */
		function errorHint(code) {
			if (code === "ETOOLARGE") return " 超过上限了，删掉一些字再存。";
			if (code === "EBADOP") return " 页面发出了服务端不认的字段，刷新后重试。";
			if (code === "EIO") return " 写盘失败：看看 <home>/enhance/ 能不能写，再试一次。";
			if (code === "EORIGIN") return " 只接受本机页面的请求，换个地址访问不行。";
			if (code === "EMETHOD") return " 请求方法不对，刷新页面重试。";
			if (code === "EPROFILE") return " 拿不到 profile 上下文：到桌面版或 dsh --profile <名字> 里打开这一页。";
			if (code === "EBADSHAPE") return " profile 里的档位表写法认不出：把 presets 改成块风格后重试。";
			if (code === "ERECORD") return " 没有「这一档是我们写的」记录，不替你猜：手工删掉那三行，或重新点一次写入。";
			return "";
		}

		// ---------------------------------------------------------------- 派生

		/**
		 * 首帧读不到状态时，页面不能就这么锁死：给一个「重试」，
		 * 状态标签说「读取中…」而不是「读不到状态」（后者会让用户先慌一下）。
		 */
		function statusOf(state) {
			if (state === null) return { text: "读取中…", tone: "mute" };
			if (state.enabled === false) return { text: "已停手", tone: "mute" };
			// 插件没挂上时，任何开关都不会生效——这跟「开关关了」是两回事，必须分开说。
			// 这个标签与 shared/state.mjs 的 derive() 里那条 reason 同词：改一处要一起看。
			if (state.active === false) return { text: "插件未激活", tone: "bad" };
			if (state.degraded) return { text: "降级运行", tone: "warn" };
			if (state.injecting) return { text: "正在生效", tone: "ok" };
			return { text: "未生效", tone: "warn" };
		}

		/**
		 * Enhanced 档的四种状态。判定顺序就是这张表从上到下：
		 * 「不知道在哪写」和「写法认不出」都排在「有没有写」前面——
		 * 这两种情况下「已写入」这个结论根本不成立。
		 */
		function presetStatusOf(state) {
			var preset = state === null || state.preset === undefined ? null : state.preset;
			if (preset === null) return { kind: "unknown", word: "—", tone: "mute" };
			if (preset.patchPath === null || preset.patchPath === undefined) {
				return { kind: "noprofile", word: "不可用", tone: "mute" };
			}
			if (preset.unreadable === true) return { kind: "unreadable", word: "改不动", tone: "bad" };
			if (preset.present === true) return { kind: "written", word: "已写入", tone: "ok" };
			return { kind: "absent", word: "未写入", tone: "mute" };
		}

		/** 四组按 API 的 name 排；pass / na 一律用服务端值，本页不伪造 ✓；na = 当前装法不适用。 */
		function checkRows(checks) {
			if (!checks || !checks.checks) return [];
			return checks.checks.map(function (item) {
				return {
					key: item.name,
					title: CHECK_TITLES[item.name] || item.name,
					pass: item.pass === true,
					na: item.na === true,
					detail: item.detail || "",
				};
			});
		}

		// ---------------------------------------------------------------- 样式

		// 全部颜色/圆角/动效/焦点环走宿主 token。
		// 字体族显式继承宿主（不引入第二字体）；等宽只在代码/数字处用 --ds-font-family-code。
		// 刻度照宿主设置页：标题 16/24、行标题 14/22、辅助 12/18、发丝线 .5px、节间距 12。
		// 深色：宿主把 body[data-ds-dark-theme] 挂上之后，自己翻 --dsw-alias-* 的值；
		// 我们不重定义任何宿主变量，只补两处「宿主语义色在深色下对比不够」的本地变量。
		var CSS = [
			".enh{display:flex;flex-direction:column;gap:12px;width:100%;max-width:720px;padding:4px 0 24px;box-sizing:border-box;font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary)}",
			"body[data-ds-dark-theme] .enh{--enh-rule:var(--dsw-alias-border-l2);--enh-mark-pass:var(--dsw-alias-state-success-secondary);--enh-mark-fail:var(--dsw-alias-state-error-secondary)}",
			"body:not([data-ds-dark-theme]) .enh{--enh-rule:var(--dsw-alias-border-l2);--enh-mark-pass:var(--dsw-alias-state-success-primary);--enh-mark-fail:var(--dsw-alias-state-error-primary)}",
			".enh-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}",
			".enh-head-main{display:flex;align-items:center;gap:8px;min-width:0}",
			".enh-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}",
			".enh-pill{font-size:12px;line-height:16px;padding:2px 8px;border-radius:var(--dsw-radius-xs);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}",
			".enh-pill[data-tone=ok]{color:var(--dsw-alias-state-success-primary);border-color:currentColor}",
			".enh-pill[data-tone=warn]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}",
			".enh-pill[data-tone=bad]{color:var(--dsw-alias-state-error-primary);border-color:currentColor}",
			".enh-pill[data-tone=mute]{color:var(--dsw-alias-label-tertiary)}",
			".enh-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}",
			".enh-group{display:flex;flex-direction:column;gap:12px;min-width:0}",
			".enh-group+.enh-group{border-top:.5px solid var(--enh-rule);padding-top:16px}",
			".enh-row-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;min-width:0}",
			".enh-h3{margin:0;font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary)}",
			".enh-sub{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".enh-now{flex:none;font-size:12px;line-height:18px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}",
			".enh-now[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}",
			".enh-now[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}",
			".enh-now[data-tone=bad]{color:var(--dsw-alias-state-error-primary)}",
			".enh-now[data-tone=mute]{color:var(--dsw-alias-label-tertiary)}",
			".enh-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}",
			".enh-hint[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}",
			".enh-stack{display:flex;flex-direction:column;gap:12px;min-width:0}",
			".enh-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l4);padding:2px 0 2px 12px;overflow-wrap:anywhere}",
			".enh-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
			".enh-btn{font:inherit;font-size:13px;line-height:20px;padding:4px 12px;min-width:72px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-primary);cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}",
			".enh-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".enh-btn[data-kind=primary]{background:var(--dsw-alias-border-l2);font-weight:500}",
			".enh-btn[data-kind=danger]{color:var(--dsw-alias-state-error-primary);border-color:currentColor}",
			// 必须排在 data-kind 之后：同特异性下后写的赢，否则禁用态仍显示危险色
			".enh-btn:disabled,.enh-btn[data-kind]:disabled,.enh-btn[data-kind=danger]:disabled{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l2);background:none;cursor:default}",
			".enh-switch{display:inline-flex;align-items:center;gap:8px;flex:none;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:none;border:none;padding:0;cursor:pointer}",
			".enh-switch:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
			".enh-track{width:30px;height:16px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-border-l2);position:relative;flex:none;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}",
			".enh-switch[aria-checked=true] .enh-track{background:var(--dsw-alias-state-success-primary)}",
			".enh-knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform var(--ds-transition-duration-fast) var(--ds-ease-in-out)}",
			".enh-switch[aria-checked=true] .enh-knob{transform:translateX(14px)}",
			".enh-seg{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);align-self:flex-start}",
			".enh-seg-btn{font:inherit;font-size:13px;line-height:20px;padding:4px 12px;border:none;border-radius:var(--dsw-radius-xs);background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out)}",
			".enh-seg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".enh-seg-btn[aria-checked=true]{background:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:500}",
			".enh-seg-btn:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
			".enh-textarea{width:100%;min-height:76px;box-sizing:border-box;font:13px/20px var(--ds-font-family-code);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:8px;resize:vertical}",
			".enh-textarea:disabled{color:var(--dsw-alias-label-tertiary)}",
			".enh-textmeta{display:flex;justify-content:space-between;gap:12px;font:12px/18px var(--ds-font-family-code);color:var(--dsw-alias-label-tertiary)}",
			".enh-over{color:var(--dsw-alias-state-error-primary)}",
			".enh-checks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}",
			".enh-check-row{display:grid;grid-template-columns:16px minmax(0,1fr) 46%;gap:8px;padding:8px 0;border-top:.5px solid var(--enh-rule);font-size:12px;line-height:18px;align-items:start}",
			".enh-mark{font:12px/18px var(--ds-font-family-code);text-align:center}",
			".enh-mark[data-r=pass]{color:var(--enh-mark-pass)}",
			".enh-mark[data-r=fail]{color:var(--enh-mark-fail)}",
			".enh-mark[data-r=na]{color:var(--dsw-alias-label-tertiary)}",
			".enh-name{color:var(--dsw-alias-label-primary)}",
			".enh-ev{font:11px/18px var(--ds-font-family-code);color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}",
			".enh-term{margin:2px 0 0}",
			".enh-term>summary{cursor:pointer;list-style:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".enh-term>summary::-webkit-details-marker{display:none}",
			".enh-term>summary::before{content:'\\203A\\00a0'}",
			".enh-term[open]>summary::before{content:'\\2304\\00a0'}",
			".enh-term>summary:hover{color:var(--dsw-alias-label-secondary)}",
			".enh-term>p{margin:4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}",
			// 焦点环：宿主设置页的同一套 token（缺变量时退化到业务色），只对键盘焦点可见。
			".enh-btn:focus-visible,.enh-switch:focus-visible,.enh-seg-btn:focus-visible,.enh-textarea:focus-visible,.enh-term>summary:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
			".enh-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}",
			// 减少动效：开关的位移与背景过渡全部关掉，状态仍然可读。
			"@media (prefers-reduced-motion: reduce){.enh-switch .enh-track,.enh-switch .enh-knob,.enh-btn,.enh-seg-btn{transition:none}}",
		].join("\n");

		// ---------------------------------------------------------------- 控件

		// 这一页只用这几类控件。每类只在这里定义一次外形，调用点不许再写 className。
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

			var confirmRemoveBox = React.useState(false);
			var confirmRemove = confirmRemoveBox[0];
			var setConfirmRemove = confirmRemoveBox[1];

			var presetNoteBox = React.useState(null);
			var presetNote = presetNoteBox[0];
			var setPresetNote = presetNoteBox[1];

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
			 * 每一组各自一行错误：错误贴住它来的地方，不做一个全页横幅。
			 *
			 * WCAG 3.3.1 要求「指明哪一项出错」，3.3.3 要求「给出怎么改」：
			 * 所以这一行由三部分组成——组名 + 服务端原话 + 一句针对 code 的建议。
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
			 * 错误行只清掉「同一组」的那条：在别处成功，不该把这一组还没处理的错误擦掉
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

			function group(id, title, sub, now, nowTone, body, notes) {
				var noteNodes = (notes || []).filter(function (item) { return item !== null && item !== ""; })
					.map(function (item, index) {
						return h("p", { className: "enh-note", key: "note" + index }, item);
					});
				return h("section", { className: "enh-group", id: id, key: id },
					h("div", { className: "enh-row-head" },
						h("div", null,
							h("h3", { className: "enh-h3" }, title),
							sub === null ? null : h("p", { className: "enh-sub" }, sub),
						),
						now === null ? null : h("span", { className: "enh-now", "data-tone": nowTone }, now),
					),
					body,
					noteNodes,
				);
			}

			var on = state !== null && state.enabled !== false;
			var locked = busy || state === null || !on;
			var status = statusOf(state);
			var ap = approvalOf(state === null ? "ask" : state.approval);
			var bytes = state === null ? 0 : state.bytes || 0;
			var draftSize = draftBytes(draft);
			var over = state !== null && draftSize > state.limit;
			// 右上角描述的是服务端此刻的行为，所以只能看已保存的文本；
			// 草稿的空白与否只影响按钮禁用态，不能拿去改写状态显示（否则清空未保存时自相矛盾）。
			var savedEmpty = state !== null && normalizeText(state.text) === "";
			var preset = state === null ? null : (state.preset === undefined ? null : state.preset);
			var presetStatus = presetStatusOf(state);
			var rows = checkRows(checks);
			var allPass = rows.length > 0 && rows.every(function (r) { return r.pass; });

			// ---- 头部：标题 + 状态 + 页级总开关 ----
			var header = h("div", { className: "enh-head" },
				h("div", { className: "enh-head-main" },
					h("h2", { className: "enh-title" }, "增强"),
					h("span", { className: "enh-pill", "data-tone": status.tone }, status.text),
					// 首帧失败时给一条出路：否则所有控件全灰，只能刷新页面
					state === null && error !== null && error.section === "page"
						? h(Button, { onClick: function () { run("page", call({ op: "state" })); } }, "重试")
						: null,
				),
				h(Switch, {
					checked: state === null ? "mixed" : on,
					disabled: busy || state === null,
					onClick: function () { run("page", call({ op: "set", enabled: !on })); },
				}, "总开关"),
			);

			var intro = h("p", { className: "enh-intro" },
				"这一页管四件事：写一段文字接到系统提示末尾、越界时怎么答、要不要多一个档位、以及它有没有真的生效。");
			// 版本行：本包版本 + 本机 DSH 版本 + 已验范围。
			// 「超出已验范围」只变黄、不拦人——拦人是宿主 engines.dsh 门禁的职责（装时拒、载时禁），这一页只负责把事实说清。
			function compatLine(compat) {
				if (compat === null || compat === undefined || typeof compat.tool !== "string") return null;
				var range = typeof compat.range === "string" && compat.range !== "" ? compat.range : null;
				var head = "增强 " + compat.tool;
				if (typeof compat.host !== "string" || compat.host === "") {
					return h("p", { className: "enh-hint" }, head + (range === null ? "" : " · 已验 DSH " + range));
				}
				if (compat.inRange === false) {
					return h("p", { className: "enh-hint", "data-tone": "warn" }, head + " · DSH " + compat.host + (range === null ? "" : " · 超出已验范围 " + range));
				}
				return h("p", { className: "enh-hint" }, head + " · DSH " + compat.host + (range === null ? "" : " · 已验 " + range));
			}

			var versionLine = compatLine(state === null ? null : state.compat);

			// 状态文件坏了不再有「元信息」块，用一行说清降级原因（这是唯一会丢的信息）
			var degradedLine = state !== null && state.degraded
				? h("p", { className: "enh-hint" },
					state.degradedReason === "missing"
						? "状态文件不存在，这一页按默认值运行。"
						: "状态文件损坏，这一页按默认值运行；审批回落到「先问我」。")
				: null;

			// ---- 01 内容边界 ----
			var scopeNow = state === null ? "—" : !on ? "不生效" : !state.contentScope ? "不接" : savedEmpty ? "文字为空" : "带 · " + fmtBytes(bytes);
			var scopeNowTone = state === null ? "mute" : (!on || !state.contentScope || savedEmpty ? "mute" : "ok");
			var blockScope = group("enh-block-scope", "内容边界",
				"接在系统提示最后一段之后（persona-suffix 之后），每条消息都带。",
				scopeNow, scopeNowTone,
				h("div", { className: "enh-stack" },
					h(Switch, {
						checked: state !== null && state.contentScope === true,
						disabled: locked,
						onClick: function () { run("scope", call({ op: "set", contentScope: !(state !== null && state.contentScope) })); },
					}, state !== null && state.contentScope === true ? "接在系统提示末尾" : "不接"),
					h("div", { className: "enh-stack" },
						h(TextArea, {
							label: "这段文字",
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
							over ? h("span", { className: "enh-hint" }, "超上限，删一点再存") : null,
						),
					),
					h("p", { className: "enh-hint" }, "不会清空你配置里的 personaSuffix / suffix；这段文字接在它们之后。"),
					errorLine("scope"),
				),
				[state === null
					? null
					: state.enabled === false
						? "总开关关着，这段文字不接进去。"
						: state.injecting
							? "写人设、写内容边界、写行为规矩都行；它只是追加在末尾，不改 DSH 自己的系统提示。"
							: "没有生效，卡在：" + (state.reason || "未知原因") + "。",
				]);

			// ---- 02 越界审批 ----
			var blockApproval = group("enh-block-approval", "越界审批",
				"DSH 要做的事，超出当前档位允许的范围时。",
				state === null ? "—" : (on ? ap.word : "不接管"),
				state === null ? "mute" : (on ? ap.tone : "mute"),
				h("div", { className: "enh-stack" },
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
						h("p", null, "主菜单里的档位管的是权限范围；这里三档管的是拿到审批请求之后怎么回——两回事，所以这里的词与菜单错开，叫「自动同意」「先问我」「自动回绝」。"),
					),
					errorLine("approval"),
				),
				[state === null
					? null
					: !on
						? "总开关关着，这三项只是存下来的偏好；审批交回宿主——宿主设成 never 就直接拒，设成 ask 就弹给你。"
						: ap.note,
				APPROVAL_SCOPE_HINT,
				]);

			// ---- 03 Enhanced 权限档 ----
			// 已写入时不再多写一句确认：右上角的状态标签已经是结论，
			// 多写一行落盘位置只是把同一件事说第二遍。
			var presetDetail = [];
			if (presetStatus.kind === "noprofile") {
				presetDetail.push(h("p", { className: "enh-hint", key: "n" },
					"拿不到 profile 上下文（不是从 profile 启动的），不知道往哪写。到桌面版或 dsh --profile <名字> 里打开这一页。",
				));
			} else if (presetStatus.kind === "unreadable") {
				presetDetail.push(h("p", { className: "enh-hint", key: "u" },
					"profile 里的档位表写法认不出（" + ((preset && preset.unreadableReason) || "未知形态") + "）。为了不写坏配置，这一页不动它；把 presets 改成块风格后重试。",
				));
			}
			if (presetNote !== null) {
				presetDetail.push(h("p", { className: "enh-hint", key: "note", role: "status", "aria-live": "polite" }, presetNote));
			}

			var presetActions = [];
			if (presetStatus.kind === "absent") {
				presetActions.push(h(Button, {
					key: "add",
					kind: "primary",
					disabled: busy || state === null,
					onClick: function () {
						setPresetNote(null);
						run("preset", call({ op: "preset", action: "add" }), function (result) {
							setConfirmRemove(false);
							setPresetNote("已写入，重启后生效" + (result && result.backup ? "（备份：" + result.backup + "）" : "") + "。");
							run("preset", call({ op: "state" }));
						});
					},
				}, "写入 Enhanced 档"));
			}
			if (presetStatus.kind === "written") {
				presetActions.push(h(Button, {
					key: "remove",
					kind: "danger",
					disabled: busy || state === null,
					onClick: function () {
						if (!confirmRemove) {
							setConfirmRemove(true);
							return;
						}
						setPresetNote(null);
						run("preset", call({ op: "preset", action: "remove" }), function (result) {
							setConfirmRemove(false);
							setPresetNote((result && result.changed ? "已移除，重启后生效" : "本来就不在") + (result && result.backup ? "（备份：" + result.backup + "）" : "") + "。");
							run("preset", call({ op: "state" }));
						});
					},
				}, confirmRemove ? "再点一次确认移除" : "移除 Enhanced 档"));
			}

			var blockPreset = group("enh-block-preset", "Enhanced 权限档",
				"档位菜单里可以通过 profile 增加一个「全开沙箱、保留审批」的可选档；DSH 本身不直接提供该组合，按需添加。",
				state === null ? "—" : presetStatus.word,
				state === null ? "mute" : presetStatus.tone,
				h("div", { className: "enh-stack" },
					presetDetail.length === 0 ? null : h("div", null, presetDetail),
					presetActions.length === 0 ? null : h("div", { className: "enh-actions" }, presetActions),
					errorLine("preset"),
				), null);

			// ---- 04 检查 ----
			var blockCheck = group("enh-block-check", "检查",
				"扫最近的会话日志（一次 10 份，任一命中即过）读回系统提示，看这段文字在不在末尾。只读，不改任何东西。",
				checks === null ? "还没查过" : (allPass ? "全部通过" : "有失败项"),
				checks === null ? "mute" : (allPass ? "ok" : "bad"),
				h("div", { className: "enh-stack" },
					h("div", { className: "enh-actions" },
						h(Button, { disabled: busy || state === null, onClick: function () {
								run("check", call({ op: "check" }), function (result) { setChecks(result); });
							} }, checks === null ? "开始检查" : "再查一次"),
						h("span", { className: "enh-hint" }, "读最近的会话日志（一次 10 份）；多个工作区并行时，可能混着别的工作区的日志。"),
					),
					checks === null
						? h("p", { className: "enh-hint" }, "还没有结果。")
						: h("ul", { className: "enh-checks", "aria-live": "polite" },
							rows.map(function (row) {
								return h("li", { key: row.key, className: "enh-check-row" },
									h("span", { className: "enh-mark", "data-r": row.na ? "na" : (row.pass ? "pass" : "fail") }, row.na ? "–" : (row.pass ? "✓" : "✗")),
									h("span", { className: "enh-name" }, row.title),
									h("span", { className: "enh-ev" }, row.detail),
								);
							})),
					errorLine("check"),
				),
				[checks === null
					? null
					: allPass
						? "四项都过了：插件在进程里、文字合规、真的进了系统提示、Enhanced 档状态明确。"
						: "有项没过，现在还确认不了它真的生效；证据列写的是卡在哪。",
				]);

			// ---- 页面 ----
			return h("div", { className: "enh" },
				header,
				intro,
				versionLine,
				degradedLine,
				errorLine("page"),
				blockScope,
				blockApproval,
				blockPreset,
				blockCheck,
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
			checkRows: checkRows,
			approvalOf: approvalOf,
			presetStatusOf: presetStatusOf,
		};
		return module.exports;
	},
});
