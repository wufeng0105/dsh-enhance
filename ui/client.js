// dsh-enhance-ui — 设置页：六节，先给结论再给旋钮，最后一节只说明不操作。
//
// 装载协议与官方 bundle 相同：window.__ModuleLoader__.load({ id, factory })。
// 数据只走 /enhance/api 的四个 op：state / check / set / preset。
//
// 页面回答三件事，其余都是注脚：
//   · 越界时谁说了算
//   · 提示词末尾带不带内容边界
//   · 档位菜单里有没有 Enhanced 这个档
//
// 页面纪律：
//   1. 先结论再旋钮：第一节是「现在会怎么做事」，结论里的分句可跳到对应设置。
//   2. 一个控件只说一次后果：每节四层——标题说事、副行说判据、右上说现状、下面说后果。
//   3. 不用内部指代：「那句话」「尾段」这类词离开上下文就没意义。
//   4. 纯宿主：颜色/圆角/动效全走宿主 token，不画页面底色、不换字体族。
//   5. 只画真实能力：CLI 才能做的事只给命令文本，不做假按钮。
//
// 语义边界（这一条是这一页最容易做错的地方）：
//   本页能改「档位**存在与否**」——点一下就往当前 profile 的 patch 里写 enhanced 档；
//   但改不了「当前会话在哪个档」——那永远归宿主的档位选择器。
//   所以 01 的第三分句指向 04（能真做事的那一节），而不是做一个假按钮；
//   04 里也不出现「当前档位」这种它答不出来的词。
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
			preset: "Enhanced 档",
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
			if (code === "ETOOLARGE") return " 删掉一些字再存，上限 8 KB。";
			if (code === "EBADOP") return " 这一页发出了服务端不接受的字段，刷新后重试。";
			if (code === "EIO") return " 写盘失败：检查 <home>/enhance/ 是否可写，然后再试一次。";
			if (code === "EORIGIN") return " 请求来源不被接受：从本机页面操作，别用别的域名访问。";
			if (code === "EMETHOD") return " 请求方法不对，刷新页面重试。";
			if (code === "EPROFILE") return " 这一页没拿到 profile 上下文：在桌面版或 dsh --profile <名字> 里打开它。";
			if (code === "EBADSHAPE") return " profile 的档位表写法认不出：把 presets 改成块风格后重试，或者按下面的说明手工加那三行。";
			if (code === "ERECORD") return " 没有「这一档是我们写的」的记录，不会替你猜：按下面的说明手工删掉那三行。";
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

		/**
		 * 结论句的分句。关闭态只有一句静态文本；开启态三句，三句都可跳到对应节。
		 *
		 * 第三句曾经是「范围按左下角菜单的档位」且**不可点**——那时这一页确实改不了档位，
		 * 给它做入口就是假按钮。转型后这一页能改「档位存在与否」（写 enhanced 档），
		 * 所以它现在可以点，指向 04 节；但「当前会话在哪个档」仍归宿主选择器，
		 * 分句文案必须把这两件事分开说，否则又变回假按钮。
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
			var preset = presetStatusOf(state);
			var presetClause = preset.kind === "written"
				? "菜单里有 Enhanced 档"
				: preset.kind === "unreadable"
					? "菜单里的 Enhanced 档写不进去"
					: preset.kind === "noprofile"
						? "菜单里的 Enhanced 档这一页管不了"
						: "菜单里没有 Enhanced 档";
			return [
				{ kind: "jump", text: "越界时" + ap.word, target: "enh-block-approval" },
				{ kind: "jump", text: boundary, target: "enh-block-scope" },
				{ kind: "jump", text: presetClause, target: "enh-block-preset" },
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

		/** 四项按 API 的 name 排；pass / na 一律用服务端值，本页不伪造 ✓；na = 当前装法不适用。 */
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
			".enh-mark[data-r=na]{color:var(--dsw-alias-label-tertiary)}",
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
			".enh-out{margin:0;font:11px/18px var(--ds-font-family-code);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-sm);padding:8px}",
			".enh-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}",
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
			var preset = state === null ? null : (state.preset === undefined ? null : state.preset);
			var presetStatus = presetStatusOf(state);
			var rows = checkRows(checks);
			var allPass = rows.length > 0 && rows.every(function (r) { return r.pass; });

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
						h("b", null, "当前会话在哪个档由左下角菜单决定。"),
						"本页不改那个选择，只决定菜单里有没有 Enhanced 这个档（见 04）。",
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
					h("p", { className: "enh-hint" }, "本包不会清空你配置里的 personaSuffix / suffix——它只在你那段之后追加；两者都在时按注册顺序排列。"),
					errorLine("scope"),
				),
				state === null
					? null
					: state.enabled === false
						? "总开关关着，这一段不注入。"
						: state.injecting
							? "四个条件都成立：插件在本进程活着、总开关开、这个开关开、文本非空——现在真的会注入。"
							: "现在没有注入，卡在：" + (state.reason || "未知原因") + "。");

			// 04 Enhanced 权限档 -------------------------------------------
			var presetDetail = [];
			if (presetStatus.kind === "written") {
				presetDetail.push(h("p", { className: "enh-hint", key: "w" },
					"已写进 " + (preset && preset.profile ? "profile「" + preset.profile + "」" : "当前 profile") + " 的 cordis.patch.yml；重启后出现在档位菜单、/permission 与设置页默认档下拉里。",
				));
			} else if (presetStatus.kind === "noprofile") {
				presetDetail.push(h("p", { className: "enh-hint", key: "n" },
					"这一页没拿到 profile 上下文（不是从 profile 启动的），所以不知道往哪写。在桌面版或 dsh --profile <名字> 里打开设置页。",
				));
			} else if (presetStatus.kind === "unreadable") {
				presetDetail.push(h("p", { className: "enh-hint", key: "u" },
					"profile 的档位表写法认不出（" + ((preset && preset.unreadableReason) || "未知形态") + "），为了不写坏宿主配置，这一页不动它。把 presets 改成块风格后重试，或按下面的说明手工加。",
				));
			}
			if (presetNote !== null) presetDetail.push(h("p", { className: "enh-hint", key: "note" }, presetNote));

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
							setPresetNote("已写入" + (result && result.backup ? "（备份：" + result.backup + "）" : "") + "。重启后生效。");
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
							setPresetNote((result && result.changed ? "已移除" : "本来就不在") + (result && result.backup ? "（备份：" + result.backup + "）" : "") + "。重启后生效。");
							run("preset", call({ op: "state" }));
						});
					},
				}, confirmRemove ? "再点一次确认移除" : "移除 Enhanced 档"));
			}

			var blockPreset = section("04", "enh-block-preset", "Enhanced 权限档",
				"沙箱全开（danger-full-access）+ 越界仍问人（ask）。宿主内置没有这个组合，要写进 profile 才会出现。",
				state === null ? "—" : presetStatus.word,
				state === null ? "mute" : presetStatus.tone,
				h("div", null,
					h("p", { className: "enh-hint" }, "没有图标——宿主只为内置四个档位名准备了图标，表外的名字只渲染文字行。这是宿主的显示契约，不是这里缺了什么。"),
					presetDetail.length === 0 ? null : h("div", null, presetDetail),
					presetActions.length === 0 ? null : h("div", { className: "enh-actions" }, presetActions),
					h("details", { className: "enh-term" },
						h("summary", { className: "enh-hint" }, "它改哪个文件、怎么撤、什么时候生效"),
						h("p", { className: "enh-hint" }, "改的是当前 profile 的 cordis.patch.yml" + (preset && preset.patchPath ? "（" + preset.patchPath + "）" : "") + "。写前先备份成 .bak-enhance-<时间>，再原子替换。"),
						h("p", { className: "enh-hint" }, "写入是整块替换 patch 里 permission 行的档位表，所以本工具会连宿主基础三档（read-only / workspace-write / danger-full-access）一起写全——只写一条 enhanced 会把其它三档抹掉。"),
						h("p", { className: "enh-hint" }, "不改你的默认档位：原来没有 defaultPreset 就仍然没有，宿主按组合的沙箱与审批推导。"),
						h("p", { className: "enh-hint" }, "移除只摘我们写的 enhanced 那三行；自己手写的同名档位不会被删。要手工撤：把那一节备份文件覆盖回去，或删掉 enhanced 那三行，然后重启。"),
						h("p", { className: "enh-hint" }, "改动要重启 DeepSeek Harness 才生效。"),
					),
					errorLine("preset"),
				), null);

			// 05 检查 ------------------------------------------------------
			var blockCheck = section("05", "enh-block-check", "检查",
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
									h("span", { className: "enh-mark", "data-r": row.na ? "na" : (row.pass ? "pass" : "fail") }, row.na ? "–" : (row.pass ? "✓" : "✗")),
									h("span", { className: "enh-name" }, row.title),
									h("span", { className: "enh-ev" }, row.detail),
								);
							})),
					errorLine("check"),
				),
				checks === null
					? null
					: allPass
						? "四项都过了：插件在、文本合规、会话日志里确实有那段文字、Enhanced 档的状态是明确的。"
						: "有项没过，说明现在还不能确认它真的生效；上面的证据列写的是卡在哪。");

			// 06 升级与卸载 ------------------------------------------------
			function infoRow(tagKind, tagText, text, code) {
				return h("li", { className: "enh-row" },
					h(Tag, { kind: tagKind }, tagText),
					h("span", code ? { className: "enh-code" } : null, text),
				);
			}

			var profileName = preset && preset.profile ? preset.profile : "<profile>";

			var blockLifecycle = section("06", "enh-block-lifecycle", "升级与卸载",
				"两条命令，不用点按钮——这一节只说明。",
				"说明", "mute",
				h("div", null,
					h("ul", { className: "enh-rows" },
						infoRow("arc", "升级", "升级 DeepSeek Harness 不用动这个包：它不碰宿主配置文件、不派生任何东西，所以零操作。"),
						infoRow("keep", "核验", "DSH 发新 rc 之后，照 docs/compatibility.md 的例行核验跑一遍（约 15 分钟）：重数触点 → 逐包 tree-diff → 冒烟 → 改两处声明。"),
						infoRow("arc", "卸载", "dsh plugin --profile " + profileName + " remove dsh-enhance，然后重启。", true),
						infoRow("keep", "保留", "你写的文本、开关、" + homePath(state) + " 里的 .bak 备份都会留着；想彻底清就自己删这个目录。"),
					),
					h("p", { className: "enh-hint" }, "升级后如果 node scripts/check.mjs 报「本机 DSH 版本不在声明范围」，那是提醒你去跑一遍例行核验、再把版本加进声明的意思。"),
				), null);

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
				h("p", { className: "enh-lede" }, "这一页管三件事：越界时谁说了算、提示词末尾带不带那段字、菜单里有没有 Enhanced 档。改完不用重启——写档例外，要重启一次。"),
				blockVerdict,
				blockApproval,
				blockScope,
				blockPreset,
				blockCheck,
				blockLifecycle,
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
			approvalOf: approvalOf,
			metaItems: metaItems,
			presetStatusOf: presetStatusOf,
		};
		return module.exports;
	},
});
