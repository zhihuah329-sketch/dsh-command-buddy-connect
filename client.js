window.__ModuleLoader__.load({
	id: "dsh-command-buddy-connect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		const inject = ["slots"];

		/** The host route that carries the check-in status. */
		const STATUS_URL = "/api/dsh-command-buddy-connect/status";

		/**
		 * Which switch id owns each region's accounts.
		 *
		 * CN and AI are separate ids on purpose: they share one adapter in the
		 * host, so a single provider-level id would make one region's switch
		 * silently disable the other.
		 */
		const REGION_SWITCH = { cn: "cn", ai: "ai" };

		/**
		 * How often an open page re-reads the status.
		 *
		 * The card only exists while the plugin's own page is open — the Slot
		 * unmounts with the page — so closing the page stops the timer by
		 * unmounting this component. 60 s is comfortably above the 30 s floor
		 * the UI rules set.
		 */
		const POLL_MS = 60 * 1000;

/**
 * How the first read behaves while the host is still coming up.
 *
 * A cold start can refuse the very first request because the route is not
 * registered yet. Retrying briefly turns that into a short delay instead of an
 * error panel the user has to dismiss or wait out.
 */
const FIRST_READ_ATTEMPTS = 5;
const FIRST_READ_RETRY_MS = 1200;

		// ==== Localisable copy =================================================
		// Every visible string lives here, so localising the card means editing
		// this one object. The installed reference plugin of this shape
		// (dsh-token-usage) hard-codes its copy rather than routing through the
		// Client locale service, and this bundle follows that precedent: the
		// locale service's registration API could not be verified live here, and
		// a throwing component blanks its whole slot entry.
		const TEXT = {
			title: "WorkBuddy 自动签到",
			autoOn: "自动签到已开启",
			autoOff: "自动签到已关闭",
			next: "下次",
			updated: "更新于",
			refresh: "刷新",
			refreshing: "刷新中…",
			checkin: "立即签到",
			checkingIn: "签到中…",
			checkinDone: "签到已完成，积分已更新。",
			busy: "签到进行中…",
			account: "账号",
			accountUnknown: "未知账号",
			today: "今日签到",
			balance: "当前积分",
			credits: "本次",
			totalCredits: "累计",
			streak: "连续",
			days: "天",
			checkedIn: "今日已签到",
			pending: "签到未完成",
			noCheckin: "尚未签到",
			unavailable: "—",
			balanceUnavailable: "积分余额不可用",
			loading: "正在读取签到状态…",
			readFailed: "读取签到状态失败",
			notInstalled: "未检测到 WorkBuddy 桌面版。",
			notInstalledHint: "安装并登录 WorkBuddy 后，DSH 启动时会自动完成当日签到。",
			notSignedIn: "WorkBuddy 已安装，但没有可用的登录凭据。",
			notSignedInHint: "登录 WorkBuddy 桌面版后重新打开本页即可。",
			unknownError: "未知错误",
			// ==== Problem reporting ============================================
			// When the card detects a real problem it offers a ready-to-send
			// prompt, so the user never has to describe symptoms themselves.
			problemTitle: "检测到问题",
			problemHint: "复制下面的提示词发给 AI，它已包含诊断所需的全部信息。",
			copyPrompt: "复制提示词",
			copied: "已复制",
			copyFailed: "复制失败，请手动选中文本",
			pools: "号池",
			poolsUnreadable: "账号库读取失败",
			poolsDetail: "CN {cn} · 国际版 {ai}",
			poolsEmpty: "还没有导入任何账号。",
			// ==== Section titles ==============================================
			secCheckin: "今日签到",
			secPools: "区域号池",
			secModels: "模型线路",
			modelsNote: "两个区域独立轮询，不会互相回退",
			modelCn: "中国版账号池 · 每日签到与调用",
			modelAi: "国际版账号池 · 仅调用，不参与签到",			// ==== Three regions ==============================================
			// The pools are two independent regions plus one external provider,
			// so the page mirrors that: one fold per region, each carrying its
			// own switch, accounts, and (for Command Code) its key.
			regionCn: "国内版",
			regionAi: "国际版",
			regionCc: "Command Code",
			regionCnHint: "中国版账号池 · 签到与调用",
			regionAiHint: "国际版账号池 · 仅调用",
			regionCcHint: "外部服务商 · 需填 API Key",
			regionEmpty: "这个区域还没有账号",
			regionEmptyHint: "展开后用下面的授权按钮打开对应版本的客户端。",
			regionDisabled: "该区域已在插件管理器中停用",
			accounts: "账号",
			switchOn: "已启用",
			switchOff: "已停用",
			// ==== Per-region authorization ====================================
			// The two regions cannot be authorized the same way: an AI client
			// writes its token in the clear, a CN client seals it. Each region
			// therefore gets its own flow and its own explanation, instead of one
			// button that can only be right for one of them.
			authCn: "授权国内版账号",
			authAi: "授权国际版账号",
			authCnHint: "国内版客户端会加密凭据，登录后需抓取一次请求才能导入。",
			authAiHint: "国际版凭据是明文，登录后直接导入即可。",
			authPlanCnFile: "国内版凭据可读，可直接导入。",
			authPlanCnCapture: "国内版凭据被加密，需要用「抓取凭据」接入。",
			authPlanCnSignin: "还没有国内版凭据，请先登录客户端。",
			authPlanAiFile: "国际版凭据可读，可直接导入。",
			authPlanAiCapture: "国际版凭据读不到，请重新登录客户端。",
			authPlanAiSignin: "还没有国际版凭据，请先登录客户端。",
			authClientMissing: "未安装该版本客户端，点开查看说明",
			authImportRegion: "导入本区域凭据",
			authorizing: "打开中…",
			authScanning: "扫描中…",
			authImporting: "导入中…",
			authImportDone: "已导入",
			authImportFailed: "导入失败",
			// ==== Route switches =============================================
			// A switch has to say whether a route is *serving*, not just whether
			// the user asked for it: "on but missing a key" is a different
			// situation from "off", and conflating them hides the fix.
			routes: "模型线路",
			routesHint: "每条线路可以单独启用或停用",
			routeOn: "已启用",
			routeOff: "已停用",
			routeBroken: "已启用但不可用",
			routePending: "正在切换…",
			routeApplyHint: "开关会写入插件配置，立即生效。",
			noRoutes: "暂时读不到线路信息，点「刷新」重试。",
			// ==== Command Code key ===========================================
			// The key is the user's, so it is entered here rather than shipped
			// in configuration. Testing asks the upstream for its model list,
			// which costs no credit.
			ccKeyTitle: "Command Code API Key",
			ccKeyHint: "在 commandcode.ai 注册后取得，通常以 user_ 开头。",
			ccKeyPlaceholder: "user_…",
			ccKeySave: "保存",
			ccKeyTest: "测试连接",
			ccKeyClear: "清除",
			ccKeySaving: "保存中…",
			ccKeyTesting: "测试中…",
			ccKeySaved: "已保存",
			ccKeySavedRestart: "已保存，重启 DSH 后该线路会出现在模型列表里",
			ccKeyCleared: "已清除",
			ccKeyStored: "已保存：",
			ccKeyMissing: "尚未填写",
			// ==== Account status + authorization ==============================
			// The verdict is computed on the host, not here: a stored "有效"
			// does not mean the account can serve a call, and the page must not
			// invent its own answer.
			statusOk: "可用",
			statusCooling: "冷却中",
			statusExpired: "已过期",
			statusSignin: "需重新登录",
			statusNoToken: "缺少令牌",
			statusDisabled: "已停用",
			statusUnknown: "未知",
			colRegion: "区域",
			colAccount: "账号",
			colStatus: "状态",
			colCalls: "调用",
			colOkRate: "成功率",
			colExpiry: "令牌到期",
			expirySoon: "即将到期",
			noAccounts: "还没有导入任何账号",
			noAccountsHint: "点击右上角的「授权账号」打开 WorkBuddy 登录，登录后会自动出现在这里。",
			// ==== Authorization flow ==========================================
			authorize: "授权账号",
			authorizing: "正在打开…",
			authTitle: "授权 WorkBuddy 账号",
			authStep1: "1. 打开 WorkBuddy 客户端",
			authStep1Hint: "在客户端里完成登录（中国版或国际版都可以）。",
			authOpen: "打开 WorkBuddy",
			authStep2: "2. 扫描本机凭据",
			authStep2Hint: "客户端登录后，扫描它保存的凭据文件。",
			authScan: "扫描凭据",
			authScanning: "扫描中…",
			authStep3: "3. 写入号池",
			authStep3Hint: "凭据可读时，通过 守护进程 的导入接口写入号池。",
			authImport: "导入到号池",
			authImporting: "导入中…",
			authClose: "收起",
			authOpened: "已打开 WorkBuddy，请完成登录后点「扫描凭据」。",
			authOpenFailed: "打开失败",
			authNotFound: "本机没有找到 WorkBuddy 客户端",
			authFound: "已找到客户端",
			authScanEmpty: "没有找到凭据文件",
			authImportable: "可导入",
			authSealed: "已加密",
			authIgnored: "不可用",
			authImportDone: "已写入号池",
			authImportFailed: "导入失败",
			authSealedHint: "中国版客户端会把凭据加密存放，插件无法离线读取；请改用「打开 WorkBuddy」登录后由抓包或导出方式接入。",
			// ==== Credential capture ==========================================
			// Capturing installs a temporary certificate and routes the client
			// through a local proxy, so it is never silent: the button states
			// the cost first, and the result says exactly what happened.
			captureBtn: "抓取凭据",
			captureRunning: "抓取中…",
			captureConfirm: "抓取凭据需要临时修改系统设置，请确认后开始。",
			captureWarnCa: "会临时安装本插件的根证书到「当前用户」信任库，结束后自动删除。",
			captureWarnScope: "只拦截 WorkBuddy 相关域名，其他网络流量不受影响。",
			captureWarnSteps: "开始后请重启 WorkBuddy，登录要添加的账号并随便发一条消息。",
			captureStart: "开始抓取",
			captureCancel: "取消",
			captureOk: "已抓到凭据并写入号池。",
			captureFailed: "抓取失败",
			captureWaiting: "正在等待凭据…请在 WorkBuddy 登录并发一条消息。",
			captureTimeout: "抓取超时，已自动清理证书和代理。",
			captureCancelled: "已取消抓取，证书和代理已清理。",
		};

		/**
		 * How a failing state is turned into a prompt the user can paste into a
		 * chat.
		 *
		 * The prompt names the symptom, the exact evidence the card holds, and
		 * the diagnostic tool the agent should call first. That last part is
		 * what makes it useful: an agent receiving "签到失败了" has to guess,
		 * while an agent receiving this knows which tool answers the question.
		 *
		 * @param kind - which problem was detected.
		 * @param detail - the evidence, already rendered as text.
		 * @param status - the raw status snapshot, for the context line.
		 * @returns the prompt text.
		 */
		function buildPrompt(kind, detail, status) {
			const lines = [];
			const when = new Date().toISOString();
			lines.push("请帮我排查 DSH 插件 dsh-command-buddy-connect 的问题。");
			lines.push("");
			lines.push("## 现象");
			lines.push(kind);
			if (isText(detail)) {
				lines.push("");
				lines.push("## 错误信息");
				lines.push(detail);
			}
			lines.push("");
			lines.push("## 已采集的现状");
			if (isObject(status)) {
				lines.push("- signedIn: " + String(status.signedIn));
				lines.push("- autoCheckin: " + String(status.autoCheckin));
				lines.push("- busy: " + String(status.busy));
				if (isObject(status.checkin)) {
					const c = status.checkin;
					lines.push("- 今日签到: " + (isText(c.status) ? c.status : String(c.checkedIn))
						+ (isNum(c.credits) ? "，本次 +" + fmtNum(c.credits) : "")
						+ (isNum(c.totalCredits) ? "，累计 " + fmtNum(c.totalCredits) : ""));
				}
				lines.push("- 积分余额: " + (isNum(status.balance) ? fmtNum(status.balance) : "不可用"));
				const pools = isObject(status.pools) ? status.pools : null;
				if (pools !== null) {
					lines.push("- 账号库可读: " + String(pools.ok === true));
					if (isObject(pools.pools)) {
						lines.push("- 号池: CN " + String(pools.pools.cn) + " / 国际版 " + String(pools.pools.ai));
					}
					if (Array.isArray(pools.accounts)) {
						for (const a of pools.accounts) {
							lines.push("  - " + String(a.site) + " " + String(a.label)
								+ " 状态=" + String(a.authState)
								+ " 启用=" + String(a.enabled)
								+ (a.cooldownUntil ? " 冷却至=" + fmtWhen(new Date(a.cooldownUntil).toISOString()) : "")
								+ (a.lastError ? " 最近错误=" + String(a.lastError) : ""));
						}
					}
				}
			} else {
				lines.push("- 无法读取状态接口（连页面自身都拿不到快照）");
			}
			lines.push("- 采集时间: " + when);
			lines.push("");
			lines.push("## 请你");
			lines.push("1. 先调用 `buddy_connect_pools` 查看两个区域号池的真实状态。");
			lines.push("2. 如需判断某个凭据文件为何无法导入，调用 `buddy_connect_diagnose_import` 并传入该文件路径。");
			lines.push("3. 如需查看守护进程日志，调用 `daemon_logs`。");
			lines.push("4. 给出原因与可执行的修复步骤；不要只复述上面的信息。");
			return lines.join("\n");
		}

		// ==== Styles ===========================================================
		// Colour tokens come only from the verified light/dark-safe set
		// (`--dsw-alias-*`); no literal colour appears anywhere, so every section
		// follows both themes. The `--dsw-radius-*` values are shape tokens.
		//
		// The page is organised as titled sections rather than one flat card: a
		// user diagnosing a problem needs the account, the pools, and the actions
		// to be visually separable, not one undifferentiated block.
		const CSS = `
.bh-wrap { display:flex; flex-direction:column; gap:14px; padding:2px 0 14px; }
.bh-head { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.bh-title { font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }
.bh-meta { font-size:11px; color:var(--dsw-alias-label-secondary); margin-top:3px; }
.bh-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.bh-btn { box-sizing:border-box; height:28px; padding:0 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-md); background:transparent; color:var(--dsw-alias-label-primary); font-size:12px; line-height:18px; cursor:pointer; }
.bh-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
.bh-btn:disabled { cursor:not-allowed; opacity:0.4; }
.bh-btn-primary { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.bh-btn-primary:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }

/* ---- collapsible sections ---- */
.bh-fold { border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-lg); background:var(--dsw-alias-bg-layer-1); overflow:hidden; }
.bh-fold-head { display:flex; align-items:center; gap:10px; padding:11px 14px; background:var(--dsw-alias-bg-layer-2); cursor:pointer; user-select:none; }
.bh-fold-head:hover { background:var(--dsw-alias-bg-layer-1); }
.bh-fold-head:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-2px; }
.bh-fold-caret { flex:0 0 auto; width:12px; text-align:center; font-size:10px; color:var(--dsw-alias-label-secondary); transition:transform 0.15s ease; }
.bh-fold-open .bh-fold-caret { transform:rotate(90deg); }
.bh-fold-title { font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary); }
.bh-fold-icon { font-size:13px; line-height:1; }
.bh-fold-note { flex:1 1 auto; min-width:0; font-size:11px; color:var(--dsw-alias-label-secondary); text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bh-fold-action { flex:0 0 auto; display:flex; align-items:center; margin-left:2px; }
.bh-fold-body { padding:12px 14px; border-top:1px solid var(--dsw-alias-border-l1); }

/* ---- route switch rows ---- */
.bh-route { display:flex; align-items:center; gap:11px; padding:10px 0; border-bottom:1px dashed var(--dsw-alias-border-l1); }
.bh-route:last-child { border-bottom:none; padding-bottom:0; }
.bh-route:first-child { padding-top:0; }
.bh-route-main { flex:1 1 auto; min-width:0; }
.bh-route-name { font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary); }
.bh-route-id { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:10px; color:var(--dsw-alias-label-secondary); margin-left:6px; }
.bh-route-detail { font-size:11px; color:var(--dsw-alias-label-secondary); margin-top:3px; }
.bh-switch { flex:0 0 auto; position:relative; width:38px; height:21px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2); background:transparent; cursor:pointer; transition:background 0.15s ease, border-color 0.15s ease; padding:0; }
.bh-switch:disabled { cursor:not-allowed; opacity:0.45; }
.bh-switch-on { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.bh-switch-knob { position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%; background:var(--dsw-alias-label-secondary); transition:transform 0.15s ease, background 0.15s ease; }
.bh-switch-on .bh-switch-knob { transform:translateX(17px); background:var(--dsw-alias-bg-layer-1); }
.bh-route-badge { flex:0 0 auto; font-size:10px; color:var(--dsw-alias-label-secondary); }

/* ---- command code key entry ---- */
.bh-capture { margin-top:10px; padding:10px 12px; border:1px solid var(--dsw-alias-state-warn-primary); border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-base); }
.bh-capture-warn { font-size:11px; font-weight:600; color:var(--dsw-alias-state-warn-primary); }
.bh-capture-list { margin:6px 0 0; padding-left:18px; font-size:11px; line-height:1.7; color:var(--dsw-alias-label-secondary); }
.bh-auth { margin-top:12px;  padding-top:12px; border-top:1px solid var(--dsw-alias-border-l1); }
.bh-auth-hint { font-size:11px; color:var(--dsw-alias-label-secondary); line-height:1.6; }
.bh-key { margin-top:12px;  padding-top:12px; border-top:1px solid var(--dsw-alias-border-l1); }
.bh-key-title { font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary); }
.bh-key-hint { font-size:11px; color:var(--dsw-alias-label-secondary); margin-top:3px; }
.bh-key-row { display:flex; align-items:center; gap:8px; margin-top:9px; flex-wrap:wrap; }
.bh-input { flex:1 1 220px; min-width:0; box-sizing:border-box; height:28px; padding:0 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:12px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.bh-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.bh-input::placeholder { color:var(--dsw-alias-label-secondary); }
.bh-key-result { margin-top:8px; font-size:11px; }
.bh-key-result-ok { color:var(--dsw-alias-state-success-primary); }
.bh-key-result-err { color:var(--dsw-alias-state-error-primary); }
.bh-key-result-warn { color:var(--dsw-alias-state-warn-primary); }

/* ---- status chips ---- */
.bh-chips { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; }
.bh-chip { border:1px solid var(--dsw-alias-border-l1); border-left-width:3px; border-radius:var(--dsw-radius-md); padding:9px 11px; background:var(--dsw-alias-bg-base); }
.bh-chip-info { border-left-color:var(--dsw-alias-brand-primary); }
.bh-chip-ok { border-left-color:var(--dsw-alias-state-success-primary); }
.bh-chip-warn { border-left-color:var(--dsw-alias-state-warn-primary); }
.bh-chip-label { font-size:10px; letter-spacing:0.02em; color:var(--dsw-alias-label-secondary); }
.bh-chip-value { font-size:16px; font-weight:600; color:var(--dsw-alias-label-primary); margin-top:3px; overflow-wrap:anywhere; }
.bh-chip-sub { font-size:10px; color:var(--dsw-alias-label-secondary); margin-top:2px; font-variant-numeric:tabular-nums; }

/* ---- key/value rows ---- */
.bh-rows { display:flex; flex-direction:column; }
.bh-row { display:flex; align-items:baseline; justify-content:space-between; gap:12px; padding:7px 0; border-bottom:1px dashed var(--dsw-alias-border-l1); font-size:12px; }
.bh-row:last-child { border-bottom:none; padding-bottom:0; }
.bh-row:first-child { padding-top:0; }
.bh-row-key { color:var(--dsw-alias-label-secondary); flex:0 0 auto; }
.bh-row-val { color:var(--dsw-alias-label-primary); text-align:right; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
.bh-row-val-ok { color:var(--dsw-alias-state-success-primary); }
.bh-row-val-warn { color:var(--dsw-alias-state-warn-primary); }
.bh-row-val-err { color:var(--dsw-alias-state-error-primary); }

/* ---- pool table ---- */
.bh-table { width:100%; border-collapse:collapse; font-size:11px; }
.bh-table th { text-align:left; font-weight:500; color:var(--dsw-alias-label-secondary); padding:0 8px 6px 0; border-bottom:1px solid var(--dsw-alias-border-l1); white-space:nowrap; }
.bh-table td { padding:7px 8px 7px 0; border-bottom:1px dashed var(--dsw-alias-border-l1); color:var(--dsw-alias-label-primary); vertical-align:middle; }
.bh-table tr:last-child td { border-bottom:none; }
.bh-table tr.bh-row-off td { color:var(--dsw-alias-label-secondary); }
.bh-td-num { font-variant-numeric:tabular-nums; text-align:right; }
.bh-tag { display:inline-block; padding:1px 7px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2); font-size:10px; line-height:16px; color:var(--dsw-alias-label-secondary); }
.bh-tag-ok { border-color:var(--dsw-alias-state-success-primary); color:var(--dsw-alias-state-success-primary); }
.bh-tag-warn { border-color:var(--dsw-alias-state-warn-primary); color:var(--dsw-alias-state-warn-primary); }
.bh-tag-err { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.bh-tag-cn { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.bh-empty { padding:16px 0; text-align:center; font-size:12px; color:var(--dsw-alias-label-secondary); }
.bh-empty-hint { margin-top:5px; font-size:11px; color:var(--dsw-alias-label-secondary); opacity:0.85; }

/* ---- account cards ---- */
.bh-accts { display:flex; flex-direction:column; gap:8px; }
.bh-acct { display:flex; align-items:center; gap:11px; padding:10px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-base); }
.bh-acct-off { opacity:0.72; }
.bh-acct-main { flex:1 1 auto; min-width:0; }
.bh-acct-name { font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bh-acct-sub { margin-top:3px; font-size:10px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.bh-site { flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; min-width:30px; height:20px; padding:0 6px; border-radius:var(--dsw-radius-sm); font-size:10px; font-weight:600; letter-spacing:0.03em; }
.bh-site-cn { color:var(--dsw-alias-brand-primary); border:1px solid var(--dsw-alias-brand-primary); }
.bh-site-ai { color:var(--dsw-alias-label-secondary); border:1px solid var(--dsw-alias-border-l2); }

/* ---- status badge ---- */
.bh-badge { flex:0 0 auto; display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border-radius:999px; font-size:11px; line-height:15px; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.bh-badge-dot { width:6px; height:6px; border-radius:50%; background:currentColor; display:inline-block; }
.bh-badge-ok { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }
.bh-badge-warn { color:var(--dsw-alias-state-warn-primary); border-color:var(--dsw-alias-state-warn-primary); }
.bh-badge-err { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.bh-badge-idle { color:var(--dsw-alias-state-idle-primary); border-color:var(--dsw-alias-border-l2); }

/* ---- authorize drawer ---- */
.bh-drawer { border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-lg); background:var(--dsw-alias-bg-layer-1); overflow:hidden; }
.bh-drawer-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:11px 14px; background:var(--dsw-alias-bg-layer-2); border-bottom:1px solid var(--dsw-alias-border-l1); }
.bh-drawer-title { font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary); }
.bh-drawer-body { display:flex; flex-direction:column; gap:12px; padding:14px; }
.bh-step { display:flex; gap:11px; align-items:flex-start; }
.bh-step-num { flex:0 0 auto; width:20px; height:20px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:10px; font-weight:600; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); }
.bh-step-main { flex:1 1 auto; min-width:0; }
.bh-step-title { font-size:12px; color:var(--dsw-alias-label-primary); }
.bh-step-hint { margin-top:3px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.bh-step-action { margin-top:8px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.bh-file { display:flex; align-items:center; gap:9px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-base); font-size:11px; }
.bh-file-main { flex:1 1 auto; min-width:0; }
.bh-file-name { color:var(--dsw-alias-label-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bh-file-msg { font-size:10px; color:var(--dsw-alias-label-secondary); margin-top:2px; }
.bh-files { display:flex; flex-direction:column; gap:7px; margin-top:9px; }

/* ---- model routes ---- */
.bh-models { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:10px; }
.bh-model { border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); padding:10px 12px; background:var(--dsw-alias-bg-base); }
.bh-model-id { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; color:var(--dsw-alias-label-primary); overflow-wrap:anywhere; }
.bh-model-desc { font-size:10px; color:var(--dsw-alias-label-secondary); margin-top:4px; }

/* ---- alerts, notice, problem ---- */
.bh-alerts { display:flex; flex-direction:column; gap:8px; }
.bh-alert { border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); padding:8px 11px; font-size:12px; background:var(--dsw-alias-bg-layer-1); }
.bh-alert-error { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.bh-alert-warn { border-color:var(--dsw-alias-state-warn-primary); color:var(--dsw-alias-state-warn-primary); }
.bh-alert-ok { border-color:var(--dsw-alias-state-success-primary); color:var(--dsw-alias-state-success-primary); }
.bh-notice { display:flex; flex-direction:column; gap:4px; border:1px dashed var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-lg); padding:14px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font-size:13px; }
.bh-notice-detail { font-size:11px; color:var(--dsw-alias-label-secondary); }
.bh-pill { display:inline-flex; align-items:center; gap:5px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.bh-dot { width:7px; height:7px; border-radius:50%; display:inline-block; background:var(--dsw-alias-state-warn-primary); }
.bh-problem { border:1px solid var(--dsw-alias-state-warn-primary); border-radius:var(--dsw-radius-lg); padding:12px 14px; background:var(--dsw-alias-bg-layer-1); display:flex; flex-direction:column; gap:8px; }
.bh-problem-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.bh-problem-title { font-size:13px; font-weight:600; color:var(--dsw-alias-state-warn-primary); }
.bh-problem-hint { font-size:11px; color:var(--dsw-alias-label-secondary); }
.bh-prompt { margin:0; padding:10px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; max-height:240px; overflow:auto; }
`;

		/** Whether a value is a usable JSON object (not null, not an array). */
		function isObject(value) {
			return value !== null && typeof value === "object" && !Array.isArray(value);
		}

		/** Whether a value is a usable finite number. */
		function isNum(value) {
			return typeof value === "number" && Number.isFinite(value);
		}

		/** Whether a value is a non-empty string. */
		function isText(value) {
			return typeof value === "string" && value.length > 0;
		}

		/** Render a number with thousands separators. */
		function fmtNum(value) {
			const n = Math.round(Number(value));
			if (!Number.isFinite(n)) return String(value);
			return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}

		/** Render an ISO instant in local time, falling back to the raw text. */
		function fmtWhen(value) {
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return value;
			try { return date.toLocaleString(); } catch (error) { return value; }
		}

		/** Render an epoch-millisecond instant as a local clock time. */
		function fmtClock(value) {
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return TEXT.unavailable;
			try { return date.toLocaleTimeString(); } catch (error) { return TEXT.unavailable; }
		}

		/** Shorten a long account uid for display. */
		function shortUid(uid) {
			return uid.length > 12 ? uid.slice(0, 8) + "…" : uid;
		}

		/** Turn anything thrown or rejected into a displayable line. */
		function errText(error) {
			if (error === null || error === undefined) return TEXT.unknownError;
			if (typeof error === "string") return error;
			if (isText(error.message)) return error.message;
			return String(error);
		}

		/**
		 * Read the status route.
		 *
		 * Any well-formed status object is returned, including one carried by a
		 * 500 — the host answers a failed check-in with the snapshot plus an
		 * `error`, and showing that beats showing "HTTP 500". A body that is not
		 * a JSON object carries no status at all, so it becomes an HTTP error.
		 *
		 * @param method - `GET` to read, `POST` to act.
		 * @param body - the JSON request body, omitted for `GET`.
		 * @returns a promise of the status object; rejects on transport failure.
		 */
		function request(method, body) {
			const headers = { accept: "application/json" };
			const init = { method: method, headers: headers, credentials: "same-origin" };
			if (body !== undefined) {
				headers["content-type"] = "application/json";
				init.body = JSON.stringify(body);
			}
			return fetch(STATUS_URL, init).then((response) => {
				return response.text().then((text) => {
					let parsed = null;
					if (text.length > 0) {
						try { parsed = JSON.parse(text); } catch (error) { parsed = null; }
					}
					if (isObject(parsed)) return parsed;
					throw new Error("HTTP " + response.status);
				});
			});
		}

		/**
		 * The registered slot entry.
		 *
		 * The owner dispatches one key with two views: `summary` is the one-liner
		 * in the bundle list, `page` is the bundle's own page. Only `page` mounts
		 * the card, so the list stays a one-liner and a collapsed entry never
		 * polls. This wrapper holds no hooks, so returning early is safe; the
		 * card's own effects unmount with it.
		 *
		 * @param props - the owner's `PluginConfigViewProps`.
		 * @returns the card for the page view, otherwise nothing.
		 */
		function BuddyCard(props) {
			const view = isObject(props) ? props.view : undefined;
			if (view === "summary") return null;
			return React.createElement(CheckinStatus);
		}

		/**
		 * The Command Code key field.
		 *
		 * Shown inside the routes section because that is where a user who
		 * cannot see the models ends up looking. The stored key is never
		 * sent back to the page — only its masked form — so the field is
		 * empty until the user types a replacement.
		 */
		function CommandCodeKey(props) {
			const cc = props.commandCode !== null && isObject(props.commandCode) ? props.commandCode : null;
			const configured = cc !== null && cc.configured === true;
			const [draft, setDraft] = React.useState("");
			const [busy, setBusy] = React.useState(null);
			const [result, setResult] = React.useState(null);
			// The input is controlled, so a non-string would throw on every
			// keystroke path. Coerce once instead of trusting the hook value.
			const typed = typeof draft === "string" ? draft : "";
			const hasDraft = typed.trim().length > 0;

			const submit = (action, extra) => {
				setBusy(action);
				const done = () => setBusy(null);
				props.onAction({ action: action, ...(extra ?? {}) }).then((snapshot) => {
					done();
					if (snapshot === null) {
						setResult({ ok: false, message: TEXT.unknownError });
						return;
					}
					if (action === "cc-test") {
						const verdict = isObject(snapshot.commandCodeTest) ? snapshot.commandCodeTest : null;
						setResult(verdict === null
							? { ok: false, message: TEXT.unknownError }
							: { ok: verdict.ok === true, warn: verdict.reason === "missing", message: String(verdict.message ?? "") });
						return;
					}
					const info = isObject(snapshot.commandCode) ? snapshot.commandCode : null;
					if (isText(snapshot.error)) {
						setResult({ ok: false, message: snapshot.error });
						return;
					}
					if (info !== null && info.cleared === true) {
						setDraft("");
						setResult({ ok: true, message: TEXT.ccKeyCleared });
						props.onChanged?.();
						return;
					}
					setDraft("");
					setResult({
						ok: true,
						message: info !== null && info.restartRequired === true ? TEXT.ccKeySavedRestart : TEXT.ccKeySaved
					});
					props.onChanged?.();
				}, done);
			};

			const tone = result === null ? "" : result.ok === true
				? "bh-key-result-ok"
				: result.warn === true ? "bh-key-result-warn" : "bh-key-result-err";

			return React.createElement("div", { className: "bh-key", "data-buddy-connect-cc-key": "" },
				React.createElement("div", { className: "bh-key-title" }, TEXT.ccKeyTitle),
				React.createElement("div", { className: "bh-key-hint" },
					configured
						? TEXT.ccKeyStored + String(cc.key ?? "") + " · " + TEXT.ccKeyHint
						: TEXT.ccKeyMissing + " · " + TEXT.ccKeyHint),
				React.createElement("div", { className: "bh-key-row" },
					React.createElement("input", {
						className: "bh-input",
						type: "password",
						autoComplete: "off",
						spellCheck: false,
						placeholder: TEXT.ccKeyPlaceholder,
						value: typed,
						disabled: busy !== null,
						onChange: (event) => setDraft(event.target.value)
					}),
					React.createElement("button", {
						type: "button",
						className: "bh-btn bh-btn-primary",
						disabled: busy !== null || !hasDraft,
						onClick: () => submit("cc-key", { apiKey: typed })
					}, busy === "cc-key" ? TEXT.ccKeySaving : TEXT.ccKeySave),
					React.createElement("button", {
						type: "button",
						className: "bh-btn",
						disabled: busy !== null || (!hasDraft && !configured),
						onClick: () => submit("cc-test", hasDraft ? { apiKey: typed } : {})
					}, busy === "cc-test" ? TEXT.ccKeyTesting : TEXT.ccKeyTest),
					configured
						? React.createElement("button", {
							type: "button",
							className: "bh-btn",
							disabled: busy !== null,
							onClick: () => submit("cc-key", { clear: true })
						}, TEXT.ccKeyClear)
						: null
				),
				result !== null
					? React.createElement("div", { className: "bh-key-result " + tone }, String(result.message))
					: null
			);
		}

		/**
		 * A collapsible section.
		 *
		 * The page shows several blocks of unequal importance — today's
		 * check-in matters every visit, the route switches matter once —
		 * so they fold. The open state lives in the page component rather
		 * than here, because a fold whose state is lost on the next poll
		 * would close itself under the user.
		 *
		 * @param props - `title`, `icon`, `note`, `open`, `onToggle`, body.
		 */
		/**
		 * A collapsible region section.
		 *
		 * The open state lives in the page component rather than here: a fold
		 * whose state is lost on the next poll would close itself under the
		 * user while they were reading it.
		 *
		 * `action` is rendered beside the note and must stop propagating its own
		 * clicks, because the whole header is the fold toggle.
		 *
		 * @param props - `title`, `icon`, `note`, `open`, `onToggle`, `action`, body.
		 */
		function Fold(props) {
			const open = props.open === true;
			return React.createElement("section", {
				className: "bh-fold" + (open ? " bh-fold-open" : "")
			},
				React.createElement("div", {
					className: "bh-fold-head",
					role: "button",
					tabIndex: 0,
					"aria-expanded": open ? "true" : "false",
					onClick: props.onToggle,
					onKeyDown: (event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							props.onToggle();
						}
					}
				},
					React.createElement("span", { className: "bh-fold-caret", "aria-hidden": "true" }, "▶"),
					isText(props.icon) ? React.createElement("span", { className: "bh-fold-icon" }, props.icon) : null,
					React.createElement("span", { className: "bh-fold-title" }, props.title),
					isText(props.note) ? React.createElement("span", { className: "bh-fold-note", title: props.note }, props.note) : null,
					props.action !== undefined && props.action !== null
						? React.createElement("span", { className: "bh-fold-action" }, props.action)
						: null
				),
				open ? React.createElement("div", { className: "bh-fold-body" }, props.children) : null
			);
		}

		/** One key/value row inside a section. */
		function Row(props) {
			return React.createElement("div", { className: "bh-row" },
				React.createElement("span", { className: "bh-row-key" }, props.name),
				React.createElement("span", {
					className: "bh-row-val" + (isText(props.tone) ? " bh-row-val-" + props.tone : "")
				}, props.value)
			);
		}

		/**
		 * One model route, with its live switch.
		 *
		 * `enabled` is the user's choice; `active` is whether the route can
		 * actually serve. They differ when a route is switched on but has no
		 * credential, and saying so is the point: "on but broken" and "off"
		 * need different fixes.
		 */
		function RouteRow(props) {
			const route = props.route;
			const on = route.enabled === true;
			const broken = on && route.active !== true;
			const busy = props.pending === true;
			return React.createElement("div", { className: "bh-route" },
				React.createElement("div", { className: "bh-route-main" },
					React.createElement("div", { className: "bh-route-name" },
						String(route.name ?? route.id),
						React.createElement("span", { className: "bh-route-id" }, String(route.id))
					),
					React.createElement("div", { className: "bh-route-detail" },
						(broken ? TEXT.routeBroken + " · " : on ? TEXT.routeOn + " · " : TEXT.routeOff + " · ")
						+ String(route.detail ?? ""))
				),
				React.createElement("button", {
					type: "button",
					className: "bh-switch" + (on ? " bh-switch-on" : ""),
					role: "switch",
					"aria-checked": on ? "true" : "false",
					"aria-label": String(route.name ?? route.id),
					disabled: busy,
					onClick: () => props.onToggle(route.id, !on)
				}, React.createElement("span", { className: "bh-switch-knob" }))
			);
		}

		/**
		 * The status card: account, today's check-in, balance, and a manual
		 * "check in now" action.
		 *
		 * Every degraded shape the host contract allows is handled here without
		 * throwing, because a throwing component blanks its whole slot entry.
		 */
		function CheckinStatus() {
			const [data, setData] = React.useState(null);
			const [loading, setLoading] = React.useState(true);
			const [transportError, setTransportError] = React.useState(null);
			const [pending, setPending] = React.useState(false);
			const [flash, setFlash] = React.useState(null);
			const [authOpen, setAuthOpen] = React.useState(false);
			// Fold state lives here, not inside Fold: a poll re-renders every
			// 60 s, and a fold owning its own state would still be fine, but
			// keeping it at the page level lets one toggle close the others.
			// Check-in opens by default because it is what most visits are for;
			// the three regions start folded, since they are configuration-shaped
			// rather than routine reading.
			const [openSections, setOpenSections] = React.useState({
				checkin: true, cn: false, ai: false, cc: false
			});
			const [toggling, setToggling] = React.useState(null);
			// Per-region authorization state. Kept here rather than in the drawer
			// because each region has its own buttons and its own result.
			const [authBusy, setAuthBusy] = React.useState(null);
			const [authNote, setAuthNote] = React.useState(null);
			const [discovery, setDiscovery] = React.useState(null);
			// Capturing changes system state (a temporary trusted certificate),
			// so it starts closed and requires an explicit confirmation.
			const [captureOpen, setCaptureOpen] = React.useState(false);

			/**
			 * Run a credential capture.
			 *
			 * A capture can wait up to ten minutes for the user to restart the
			 * client and sign in, so this is not a fire-and-forget request: it
			 * starts the session in the background, then polls for progress and
			 * offers cancel. Blocking the UI on one long request — the first
			 * version — left no way to tell "waiting for you" from "broken".
			 */
			const runCaptureNow = () => {
				if (authBusy !== null) return;
				setAuthBusy("capture");
				setAuthNote({ ok: true, warn: true, message: TEXT.captureWaiting });
				load("POST", { action: "capture-start" }, { spinner: false }).then((started) => {
					const startedOk = started !== null && isObject(started.captureState) && started.captureState.running === true;
					if (!startedOk) {
						setAuthBusy(null);
						setAuthNote({
							ok: false,
							message: started !== null && isObject(started.captureState) && isText(started.captureState.error)
								? started.captureState.error
								: TEXT.captureFailed
						});
						return;
					}
					pollCapture();
				}, () => setAuthBusy(null));
			};

			/** Poll the running capture until it finishes, fails, or times out. */
			const pollCapture = () => {
				let tries = 0;
				const tick = () => {
					tries += 1;
					// The session caps itself at ten minutes; poll a little past
					// that so the host's own verdict wins over a client guess.
					if (tries > 130) {
						setAuthBusy(null);
						setAuthNote({ ok: false, message: TEXT.captureTimeout });
						return;
					}
					load("GET", undefined, { spinner: false }).then((snapshot) => {
						const state = snapshot !== null && isObject(snapshot.captureState) ? snapshot.captureState : null;
						if (state === null) {
							setTimeout(tick, 3000);
							return;
						}
						if (state.running === true) {
							setAuthNote({
								ok: true,
								warn: true,
								message: TEXT.captureWaiting + (isText(state.message) ? " " + state.message : "")
							});
							setTimeout(tick, 3000);
							return;
						}
						setAuthBusy(null);
						if (state.ok === true) {
							const written = isObject(state.written) ? state.written : null;
							setAuthNote(written !== null && written.ok !== true
								? { ok: false, message: TEXT.captureOk + " " + String(written.error ?? "") }
								: { ok: true, message: TEXT.captureOk });
							setCaptureOpen(false);
							load("GET", undefined, { spinner: false });
							return;
						}
						setAuthNote({ ok: false, message: String(state.error ?? TEXT.captureFailed) });
					}, () => setTimeout(tick, 3000));
				};
				setTimeout(tick, 2000);
			};

			/** Abandon a capture; the host tears down the CA and proxy. */
			const cancelCaptureNow = () => {
				if (authBusy !== "capture") return;
				load("POST", { action: "capture-cancel" }, { spinner: false }).then(() => {
					setAuthBusy(null);
					setAuthNote({ ok: false, warn: true, message: TEXT.captureCancelled });
				}, () => setAuthBusy(null));
			};

			const toggleSection = (id) => {
				setOpenSections((prev) => ({ ...prev, [id]: prev[id] !== true }));
			};

			/** Open the client for one region, recording why when it fails. */
			const openClient = (site) => {
				if (authBusy !== null) return;
				setAuthBusy("open-" + site);
				setAuthNote(null);
				load("POST", { action: "authorize", site: site }).then((snapshot) => {
					setAuthBusy(null);
					const opened = snapshot !== null && isObject(snapshot.authorize) ? snapshot.authorize : null;
					if (opened === null) {
						setAuthNote({ ok: false, message: TEXT.unknownError });
						return;
					}
					setAuthNote(opened.ok === true
						? { ok: true, message: TEXT.authOpened }
						: { ok: false, message: String(opened.error ?? TEXT.authOpenFailed) });
				}, () => setAuthBusy(null));
			};

			/** Scan credential files and keep the per-region plan. */
			const scanAll = () => {
				if (authBusy !== null) return;
				setAuthBusy("scan");
				setAuthNote(null);
				load("POST", { action: "discover" }).then((snapshot) => {
					setAuthBusy(null);
					const found = snapshot !== null && isObject(snapshot.discovery) ? snapshot.discovery : null;
					setDiscovery(found);
					setAuthNote(found === null
						? { ok: false, message: TEXT.unknownError }
						: { ok: true, message: String(found.summary ?? "") });
				}, () => setAuthBusy(null));
			};

			/** Import whatever is importable, reporting the real outcome. */
			const importAll = () => {
				if (authBusy !== null) return;
				setAuthBusy("import");
				setAuthNote(null);
				load("POST", { action: "import" }).then((snapshot) => {
					setAuthBusy(null);
					const result = snapshot !== null && isObject(snapshot.importResult) ? snapshot.importResult : null;
					if (result === null) {
						setAuthNote({ ok: false, message: TEXT.unknownError });
						return;
					}
					const changed = Number(result.added ?? 0) + Number(result.updated ?? 0);
					setAuthNote(result.ok === true
						? { ok: true, message: TEXT.authImportDone + (changed > 0 ? "（新增 " + Number(result.added ?? 0) + "，更新 " + Number(result.updated ?? 0) + "）" : "") }
						: { ok: false, message: String(result.error ?? TEXT.authImportFailed) });
				}, () => setAuthBusy(null));
			};

			/**
			 * Flip one route's switch.
			 *
			 * The host persists it, so the change survives a restart, and the
			 * adapters read it per call, so no remount is needed.
			 */
			const toggleRoute = (id, next) => {
				if (toggling !== null) return;
				setToggling(id);
				const done = () => setToggling(null);
				load("POST", { action: "toggle", route: id, enabled: next }).then((snapshot) => {
					done();
					if (snapshot !== null && isText(snapshot.error)) setFlash(null);
				}, done);
			};

			/**
			 * Run one request and fold it into state.
			 *
			 * @param method - `GET` or `POST`.
			 * @param body - the request body, omitted for `GET`.
			 * @param options - `guard` refuses writes after unmount; `spinner`
			 *   marks a foreground read that should show progress.
			 * @returns the resulting status object, or null on failure.
			 */
			const load = (method, body, options) => {
				const opts = options === undefined ? {} : options;
				const live = () => opts.guard === undefined || opts.guard() === true;
				if (live() && opts.spinner === true) setLoading(true);
				return request(method, body).then(
					(next) => {
						if (!live()) return next;
						setData(next);
						setTransportError(null);
						setLoading(false);
						if (method === "GET") setFlash(null);
						return next;
					},
					(error) => {
						if (!live()) return null;
						setTransportError(errText(error));
						setLoading(false);
						return null;
					}
				);
			};

			// Poll while mounted. Unmounting (closing the plugin page) clears the
			// timer, so a closed page never polls.
			//
			// The first read retries quickly rather than reporting failure at once:
			// right after the host starts, its HTTP routes can still be settling,
			// and one refused request used to surface as an error panel that stayed
			// up until the next poll a whole minute later.
			React.useEffect(() => {
				let cancelled = false;
				const guard = () => !cancelled;
				let retryTimer = null;
				let attempts = 0;

				const firstRead = () => {
					if (!guard()) return;
					attempts += 1;
					request("GET").then((next) => {
						if (!guard()) return;
						setData(next);
						setTransportError(null);
						setLoading(false);
					}, (error) => {
						if (!guard()) return;
						if (attempts < FIRST_READ_ATTEMPTS) {
							retryTimer = setTimeout(firstRead, FIRST_READ_RETRY_MS);
							return;
						}
						setTransportError(errText(error));
						setLoading(false);
					});
				};

				// A retry in flight must not be abandoned silently: `cancelled`
				// already stops it, and the timer is cleared below.
				firstRead();
				const timer = setInterval(() => {
					if (!guard()) return;
					load("GET", undefined, { guard: guard, spinner: false });
				}, POLL_MS);
				return () => {
					cancelled = true;
					clearInterval(timer);
					if (retryTimer !== null) clearTimeout(retryTimer);
				};
			}, []);

			/** Claim today's reward now, then show the refreshed snapshot. */
			const checkinNow = () => {
				if (pending) return;
				setPending(true);
				setFlash(null);
				const done = () => setPending(false);
				load("POST", { action: "checkin" }).then((next) => {
					done();
					if (next === null) return;
					const failed = isText(next.error);
					setFlash(failed ? null : TEXT.checkinDone);
				}, done);
			};

			const status = isObject(data) ? data : null;
			// Only an explicit `installed: false` counts as missing; a snapshot
			// that omits the flag is treated as present and rendered defensively.
			const installed = status === null || status.installed !== false;
			const signedIn = status !== null && status.signedIn === true;
			const checkin = status !== null && isObject(status.checkin) ? status.checkin : null;
			const account = status !== null && isObject(status.account) ? status.account : null;
			const balance = status !== null && isNum(status.balance) ? status.balance : null;
			const serverError = status !== null && isText(status.error) ? status.error : null;
			const busy = status !== null && status.busy === true;
			const showCards = status !== null && installed && signedIn;
			// A check-in needs a CN credential. Enabling the button without one
			// guarantees a failure the page already knows about, so it stays
			// disabled and the notice above explains why.
			const canCheckin = status !== null && installed && signedIn && !pending && !busy;
			const pools = status !== null && isObject(status.pools) ? status.pools : null;

			// ==== Problem detection ===========================================
			// Ordered by severity: the first finding wins, because a prompt that
			// lists several unrelated causes is worse than one naming the real
			// blocker. A transient cooldown is deliberately *not* a problem: it
			// clears itself, and reporting it would train the user to ignore the
			// panel.
			let problem = null;
			if (transportError !== null) {
				problem = { kind: "页面无法读取插件状态接口（HTTP 请求失败）。", detail: transportError };
			} else if (status !== null && serverError !== null) {
				problem = { kind: "插件状态接口返回了错误。", detail: serverError };
			} else if (status !== null && pools !== null && pools.ok === false) {
				problem = {
					kind: "守护进程 账号库无法读取，因此两个区域号池都不可用。",
					detail: String(pools.reason === undefined ? "" : pools.reason)
						+ (isText(pools.error) ? "：" + pools.error : "")
				};
			} else if (status !== null && pools !== null && isObject(pools.pools)
				&& pools.pools.cn === 0 && pools.pools.ai === 0) {
				problem = {
					kind: "两个区域号池都没有可用账号，模型调用会失败。",
					detail: "请在 守护进程 中导入账号；若导入后仍为空，用 buddy_connect_diagnose_import 检查凭据文件。"
				};
			} else if (status !== null && checkin !== null && checkin.checkedIn !== true
				&& isText(checkin.error)) {
				problem = {
					kind: "今日签到未成功。",
					detail: String(checkin.status === undefined ? "" : checkin.status + "：") + String(checkin.error)
				};
			} else if (status !== null && installed && !signedIn) {
				problem = { kind: "没有可用于签到的 CN 账号凭据。", detail: serverError };
			}
			const meta = [];
			if (status !== null) meta.push(status.autoCheckin === true ? TEXT.autoOn : TEXT.autoOff);
			if (status !== null && isText(status.nextCheckinAt)) meta.push(TEXT.next + " " + fmtWhen(status.nextCheckinAt));
			if (checkin !== null && isNum(checkin.at)) meta.push(TEXT.updated + " " + fmtClock(checkin.at));

			const alerts = [];
			if (transportError !== null && status !== null) {
				alerts.push(React.createElement("div", {
					key: "transport", className: "bh-alert bh-alert-error", role: "alert"
				}, TEXT.readFailed + ": " + transportError));
			}
			if (serverError !== null) {
				alerts.push(React.createElement("div", {
					key: "server", className: "bh-alert bh-alert-warn", role: "status"
				}, serverError));
			}
			if (flash !== null) {
				alerts.push(React.createElement("div", {
					key: "flash", className: "bh-alert bh-alert-ok", role: "status"
				}, flash));
			}
			// Expiry warnings are shown even when everything works today: a token
			// that stops working in two days with no refresh token is the kind of
			// silent failure this panel exists to prevent.
			const accountOverview = isObject(status) && isObject(status.accounts) ? status.accounts : null;
			if (accountOverview !== null && Array.isArray(accountOverview.warnings)) {
				accountOverview.warnings.forEach((w, index) => {
					alerts.push(React.createElement("div", {
						key: "expiry-" + index,
						className: "bh-alert " + (w.severity === "error" ? "bh-alert-error" : "bh-alert-warn"),
						role: "status"
					}, String(w.message)));
				});
			}

			// Degraded shapes: a notice instead of the card grid.
			let notice = null;
			if (status === null) {
				notice = React.createElement("div", { className: "bh-notice" },
					React.createElement("div", null, loading ? TEXT.loading : TEXT.readFailed),
					transportError !== null
						? React.createElement("div", { className: "bh-notice-detail" }, transportError)
						: null
				);
			} else if (!installed) {
				notice = React.createElement("div", { className: "bh-notice" },
					React.createElement("div", null, TEXT.notInstalled),
					React.createElement("div", { className: "bh-notice-detail" }, TEXT.notInstalledHint)
				);
			} else if (!signedIn) {
				notice = React.createElement("div", { className: "bh-notice" },
					React.createElement("div", null, TEXT.notSignedIn),
					React.createElement("div", { className: "bh-notice-detail" }, TEXT.notSignedInHint)
				);
			}

			// The three readings. Each tolerates its own field being absent.
			const chips = [];
			if (showCards) {
				const accountLabel = account !== null && isText(account.label) ? account.label : TEXT.accountUnknown;
				const accountSub = account !== null && isText(account.uid) ? shortUid(account.uid) : "";
				chips.push({ key: "account", label: TEXT.account, value: accountLabel, sub: accountSub, tone: "info" });

				const checkedIn = checkin !== null && checkin.checkedIn === true;
				const stateText = checkin === null
					? TEXT.noCheckin
					: (isText(checkin.status) ? checkin.status : (checkedIn ? TEXT.checkedIn : TEXT.pending));
				const detail = [];
				if (checkin !== null) {
					if (isText(checkin.date)) detail.push(checkin.date);
					if (isNum(checkin.credits)) detail.push(TEXT.credits + " +" + fmtNum(checkin.credits));
					if (isNum(checkin.totalCredits)) detail.push(TEXT.totalCredits + " " + fmtNum(checkin.totalCredits));
					if (isNum(checkin.streakDays) && checkin.streakDays > 0) {
						detail.push(TEXT.streak + " " + checkin.streakDays + " " + TEXT.days);
					}
				}
				chips.push({ key: "today", label: TEXT.today, value: stateText, sub: detail.join(" · "), tone: checkedIn ? "ok" : "warn" });

				chips.push({
					key: "balance",
					label: TEXT.balance,
					value: balance === null ? TEXT.unavailable : fmtNum(balance),
					sub: balance === null ? TEXT.balanceUnavailable : "",
					tone: balance === null ? "warn" : "info"
				});
			}

			// ==== Section: check-in ==========================================
			// The daily answer, first because it is what most visits are for.
			const checkinRows = [];
			if (status !== null) {
				checkinRows.push(React.createElement(Row, {
					key: "auto", name: "自动签到", value: status.autoCheckin === true ? "已开启" : "已关闭"
				}));
				if (isText(status.nextCheckinAt)) {
					checkinRows.push(React.createElement(Row, { key: "next", name: "下次检查", value: fmtWhen(status.nextCheckinAt) }));
				}
				if (checkin !== null) {
					checkinRows.push(React.createElement(Row, {
						key: "when", name: "最近一次", value: isNum(checkin.at) ? fmtClock(checkin.at) : TEXT.unavailable
					}));
					if (isNum(checkin.streakDays)) {
						checkinRows.push(React.createElement(Row, {
							key: "streak", name: "连续天数", value: checkin.streakDays + " " + TEXT.days
						}));
					}
					if (isText(checkin.error)) {
						checkinRows.push(React.createElement(Row, {
							key: "err", name: "最近错误", value: checkin.error, tone: "err"
						}));
					}
				}
			}
			const checkinSection = status === null ? null : React.createElement(Fold,
				{
					title: TEXT.secCheckin,
					icon: "✓",
					note: status.autoCheckin === true ? TEXT.autoOn : TEXT.autoOff,
					open: openSections.checkin,
					onToggle: () => toggleSection("checkin")
				},
				chips.length > 0 ? React.createElement("div", { className: "bh-chips", style: { marginBottom: "12px" } },
					chips.map((chip) => React.createElement("div", {
						className: "bh-chip bh-chip-" + chip.tone, key: chip.key
					},
						React.createElement("div", { className: "bh-chip-label" }, chip.label),
						React.createElement("div", { className: "bh-chip-value", title: String(chip.value) }, chip.value),
						chip.sub ? React.createElement("div", { className: "bh-chip-sub" }, chip.sub) : null
					))) : null,
				checkinRows.length > 0 ? React.createElement("div", { className: "bh-rows" }, checkinRows) : null
			);

			// ==== Section: pools =============================================
			// The verdict comes from the host (`accounts.accounts[].status`), which
			// combines enabled/authState/cooldown/expiry. Recomputing it here would
			// let the page and the agent disagree, and it would show a cooling
			// account as available.
			const overview = isObject(status) && isObject(status.accounts) ? status.accounts : null;
			const accountRows = overview !== null && Array.isArray(overview.accounts) ? overview.accounts : [];

			const STATUS_TONE = {
				ok: "ok",
				"cooling-down": "warn",
				expired: "err",
				"signin-required": "err",
				"no-token": "err",
				disabled: "idle"
			};
			const STATUS_TEXT = {
				ok: TEXT.statusOk,
				"cooling-down": TEXT.statusCooling,
				expired: TEXT.statusExpired,
				"signin-required": TEXT.statusSignin,
				"no-token": TEXT.statusNoToken,
				disabled: TEXT.statusDisabled
			};

			/** Success rate as a percentage, or a dash when there is no history. */
			function okRate(a) {
				const total = a.successes + a.failures;
				if (total === 0) return "—";
				return Math.round((a.successes / total) * 100) + "%";
			}

			/** A compact expiry reading, warning when it is close. */
			function expiryText(a) {
				if (!isNum(a.expiresAt) || a.expiresAt <= 0) return "—";
				const d = new Date(a.expiresAt);
				if (Number.isNaN(d.getTime())) return "—";
				const days = Math.round((a.expiresAt - Date.now()) / 86400000);
				const date = d.toISOString().slice(0, 10);
				return a.expiringSoon === true ? date + " · " + days + " 天" : date;
			}

			// ==== Three region sections ======================================
			// One fold per region, each carrying its own switch, its own accounts,
			// and — for Command Code — its own key field. Splitting them this way
			// matches how the pools actually behave: CN, AI and Command Code are
			// independent, and a problem in one says nothing about the others.
			const routeRows = isObject(status) && Array.isArray(status.routes) ? status.routes : [];
			const models = pools !== null && Array.isArray(pools.models) ? pools.models : [];
			const routeOf = (id) => routeRows.find((r) => r && r.id === id) ?? null;

			/** Account cards for one region. */
			const regionAccounts = (site) => {
				const rows = accountRows.filter((a) => a && a.site === site);
				if (rows.length === 0) {
					return React.createElement("div", { className: "bh-empty" },
						React.createElement("div", null,
							overview !== null && overview.vaultOk === false ? TEXT.poolsUnreadable : TEXT.regionEmpty),
						React.createElement("div", { className: "bh-empty-hint" }, TEXT.regionEmptyHint));
				}
				return React.createElement("div", { className: "bh-accts" }, rows.map((a) => {
					const tone = STATUS_TONE[a.status] ?? "idle";
					const text = STATUS_TEXT[a.status] ?? TEXT.statusUnknown;
					const title = Array.isArray(a.reasons) && a.reasons.length > 0 ? a.reasons.join("\n") : undefined;
					return React.createElement("div", {
						key: String(a.id),
						className: "bh-acct" + (a.usable === true ? "" : " bh-acct-off"),
						title: title
					},
						React.createElement("div", { className: "bh-acct-main" },
							React.createElement("div", { className: "bh-acct-name" }, String(a.label)),
							React.createElement("div", { className: "bh-acct-sub" },
								TEXT.colCalls + " " + fmtNum(a.requests)
								+ " · " + TEXT.colOkRate + " " + okRate(a)
								+ " · " + TEXT.colExpiry + " " + expiryText(a))
						),
						React.createElement("span", { className: "bh-badge bh-badge-" + tone },
							React.createElement("i", { className: "bh-badge-dot" }),
							text)
					);
				}));
			};

			/**
			 * A switch for one region or route.
			 *
			 * `label` is passed separately because CN and AI are both served by
			 * "Buddy Connect": using the route name alone would give two
			 * identical accessible names, and a switch whose name does not say
			 * which region it controls is worse than no name at all.
			 */
			const regionSwitch = (id, label) => {
				const route = routeOf(id);
				if (route === null) return null;
				const on = route.enabled === true;
				return React.createElement("button", {
					type: "button",
					className: "bh-switch" + (on ? " bh-switch-on" : ""),
					role: "switch",
					"aria-checked": on ? "true" : "false",
					"aria-label": isText(label) ? label : String(route.name ?? id),
					title: (on ? TEXT.switchOn : TEXT.switchOff) + (isText(route.detail) ? " · " + route.detail : ""),
					disabled: toggling !== null,
					onClick: (event) => {
						// The header is clickable for the fold; a switch inside it
						// must not also toggle the fold.
						event.stopPropagation();
						toggleRoute(id, !on);
					}
				}, React.createElement("span", { className: "bh-switch-knob" }));
			};

			/** The one-line state summary shown in a region header. */
			const regionNote = (site, fallback) => {
				if (overview === null) return fallback;
				const count = site === "cn" ? overview.pools.cn : overview.pools.ai;
				return count + " 个可用";
			};

			/**
			 * The authorization block for one region.
			 *
			 * Each region states what its own route is: AI's credential file is
			 * readable so a plain import works, while CN's is sealed and only a
			 * capture can read it. Showing one shared instruction would be wrong
			 * for at least one of them, so the wording comes from the host's
			 * per-region plan.
			 */
			const regionAuthorize = (site) => {
				const plan = isObject(discovery) && isObject(discovery.plan) ? discovery.plan[site] : null;
				const client = isObject(status) && isObject(status.workbuddy) && isObject(status.workbuddy[site])
					? status.workbuddy[site]
					: null;
				const clientReady = client !== null && client.path !== undefined;
				const busyNow = authBusy !== null;
				const route = plan === null ? null : plan.route;
				const explain = route === null
					? (site === "cn" ? TEXT.authCnHint : TEXT.authAiHint)
					: route === "file" ? (site === "cn" ? TEXT.authPlanCnFile : TEXT.authPlanAiFile)
						: route === "capture" ? (site === "cn" ? TEXT.authPlanCnCapture : TEXT.authPlanAiCapture)
							: (site === "cn" ? TEXT.authPlanCnSignin : TEXT.authPlanAiSignin);

				return React.createElement("div", { className: "bh-auth" },
					React.createElement("div", { className: "bh-auth-hint" }, explain),
					React.createElement("div", { className: "bh-key-row" },
						React.createElement("button", {
							type: "button",
							className: "bh-btn bh-btn-primary",
							disabled: busyNow || !clientReady,
							title: clientReady ? String(client.path) : (client !== null && isText(client.hint) ? client.hint : ""),
							onClick: () => openClient(site)
						}, clientReady
							? (authBusy === "open-" + site ? TEXT.authorizing : (site === "cn" ? TEXT.authCn : TEXT.authAi))
							: TEXT.authClientMissing),
						React.createElement("button", {
							type: "button",
							className: "bh-btn",
							disabled: busyNow,
							onClick: () => { scanAll(); }
						}, authBusy === "scan" ? TEXT.authScanning : TEXT.authScan),
						React.createElement("button", {
							type: "button",
							className: "bh-btn",
							disabled: busyNow || plan === null || plan.fileImport !== true,
							title: plan !== null && plan.fileImport === true ? "" : String(explain),
							onClick: () => { importAll(); }
						}, authBusy === "import" ? TEXT.authImporting : TEXT.authImportRegion),
						// A capture is offered only where it is the honest route:
						// when the credential file itself cannot be read.
						plan !== null && plan.captureRequired === true
							? React.createElement("button", {
								type: "button",
								className: "bh-btn",
								disabled: busyNow,
								onClick: () => setCaptureOpen(!captureOpen)
							}, captureOpen ? TEXT.captureCancel : TEXT.captureBtn)
							: null
					),
					captureOpen && plan !== null && plan.captureRequired === true
						? React.createElement("div", { className: "bh-capture" },
							React.createElement("div", { className: "bh-capture-warn" }, TEXT.captureConfirm),
							React.createElement("ul", { className: "bh-capture-list" },
								React.createElement("li", null, TEXT.captureWarnCa),
								React.createElement("li", null, TEXT.captureWarnScope),
								React.createElement("li", null, TEXT.captureWarnSteps)
							),
							React.createElement("div", { className: "bh-key-row" },
								React.createElement("button", {
									type: "button",
									className: "bh-btn bh-btn-primary",
									disabled: busyNow,
									onClick: () => { runCaptureNow(); }
								}, authBusy === "capture" ? TEXT.captureRunning : TEXT.captureStart),
								// While a session runs, closing the panel is not
								// enough: the capture has to be stopped so the host
								// tears down the certificate and proxy.
								React.createElement("button", {
									type: "button",
									className: "bh-btn",
									disabled: false,
									onClick: () => {
										if (authBusy === "capture") cancelCaptureNow();
										else setCaptureOpen(false);
									}
								}, TEXT.captureCancel)
							))
						: null,
					authNote !== null
						? React.createElement("div", { className: "bh-key-result " + (authNote.ok === true ? "bh-key-result-ok" : authNote.warn === true ? "bh-key-result-warn" : "bh-key-result-err") },
							String(authNote.message))
						: null
				);
			};

			const cnSection = React.createElement(Fold, {
				title: TEXT.regionCn,
				icon: "🇨🇳",
				note: regionNote("cn", TEXT.regionCnHint),
				open: openSections.cn,
				onToggle: () => toggleSection("cn"),
				action: regionSwitch(REGION_SWITCH.cn, TEXT.regionCn)
			}, regionAccounts("cn"), regionAuthorize("cn"));

			const aiSection = React.createElement(Fold, {
				title: TEXT.regionAi,
				icon: "🌐",
				note: regionNote("ai", TEXT.regionAiHint),
				open: openSections.ai,
				onToggle: () => toggleSection("ai"),
				action: regionSwitch(REGION_SWITCH.ai, TEXT.regionAi)
			}, regionAccounts("ai"), regionAuthorize("ai"));

			const ccRoute = routeOf("command-code");
			const ccState = isObject(status) && isObject(status.commandCode) ? status.commandCode : null;
			const ccSection = React.createElement(Fold, {
				title: TEXT.regionCc,
				icon: "⌁",
				note: ccState !== null && ccState.configured === true
					? (ccRoute !== null && ccRoute.active === true ? TEXT.switchOn : "待重启")
					: "未配置",
				open: openSections.cc,
				onToggle: () => toggleSection("cc"),
				action: regionSwitch("command-code", TEXT.regionCc)
			},
				models.length > 0 ? React.createElement("div", { className: "bh-models", style: { marginBottom: "4px" } }, models
					.filter((id) => !String(id).endsWith("-cn") && !String(id).endsWith("-ai"))
					.map((id) => React.createElement("div", { className: "bh-model", key: String(id) },
						React.createElement("div", { className: "bh-model-id" }, String(id))))) : null,
				React.createElement(CommandCodeKey, {
					commandCode: ccState,
					onAction: (body) => load("POST", body),
					onChanged: () => { load("GET", undefined, { spinner: false }); }
				})
			);

			return React.createElement("div", { className: "bh-wrap", "data-buddy-connect-card": "" },
				React.createElement("div", { className: "bh-head" },
					React.createElement("div", null,
						React.createElement("div", { className: "bh-title" }, TEXT.title),
						meta.length > 0 ? React.createElement("div", { className: "bh-meta" }, meta.join(" · ")) : null
					),
					React.createElement("div", { className: "bh-actions" },
						busy ? React.createElement("span", { className: "bh-pill" },
							React.createElement("i", { className: "bh-dot" }),
							TEXT.busy
						) : null,
						React.createElement("button", {
							type: "button",
							className: "bh-btn",
							onClick: () => setAuthOpen(!authOpen)
						}, TEXT.authorize),
						React.createElement("button", {
							type: "button",
							className: "bh-btn",
							onClick: () => { load("GET", undefined, { spinner: true }); },
							disabled: loading
						}, loading ? TEXT.refreshing : TEXT.refresh),
						React.createElement("button", {
							type: "button",
							className: "bh-btn bh-btn-primary",
							onClick: checkinNow,
							disabled: !canCheckin
						}, pending ? TEXT.checkingIn : TEXT.checkin)
					)
				),
				alerts.length > 0 ? React.createElement("div", { className: "bh-alerts" }, alerts) : null,
				notice,
				problem !== null
					? React.createElement(ProblemPanel, { kind: problem.kind, detail: problem.detail, status: status })
					: null,
				authOpen
					? React.createElement(AuthorizeDrawer, {
						onClose: () => setAuthOpen(false),
						onAction: (body) => load("POST", body),
						onChanged: () => { load("GET", undefined, { spinner: false }); }
					})
					: null,
				checkinSection,
				cnSection,
				aiSection,
				ccSection
			);
		}

		/**
		 * A detected problem, with a prompt the user can hand straight to an AI.
		 *
		 * This exists because the useful diagnosis is the one the user cannot
		 * easily write: which region pool is empty, which account is cooling
		 * down, which credential file is sealed. The card already holds all of
		 * it, so it composes the message instead of asking the user to describe
		 * symptoms.
		 *
		 * @param props - `kind`, `detail`, `status`, and the text to show.
		 */
		function ProblemPanel(props) {
			const [copied, setCopied] = React.useState(null);
			const prompt = buildPrompt(props.kind, props.detail, props.status);

			const copy = () => {
				const done = () => setCopied(true);
				const failed = () => setCopied(false);
				try {
					if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === "function") {
						navigator.clipboard.writeText(prompt).then(done, failed);
						return;
					}
				} catch (error) {
					// Fall through to the selection-based copy below.
				}
				try {
					const area = document.createElement("textarea");
					area.value = prompt;
					area.setAttribute("readonly", "");
					area.style.position = "fixed";
					area.style.opacity = "0";
					document.body.appendChild(area);
					area.select();
					const ok = document.execCommand("copy");
					area.remove();
					if (ok) done(); else failed();
				} catch (error) {
					failed();
				}
			};

			return React.createElement("div", { className: "bh-problem", "data-buddy-connect-problem": "" },
				React.createElement("div", { className: "bh-problem-head" },
					React.createElement("div", { className: "bh-problem-title" }, TEXT.problemTitle),
					React.createElement("button", {
						type: "button",
						className: "bh-btn bh-btn-primary",
						onClick: copy
					}, copied === true ? TEXT.copied : TEXT.copyPrompt)
				),
				React.createElement("div", { className: "bh-problem-hint" },
					copied === false ? TEXT.copyFailed : TEXT.problemHint),
				React.createElement("pre", { className: "bh-prompt" }, prompt)
			);
		}

		/**
		 * The account-authorization drawer.
		 *
		 * Authorizing an account is inherently three steps — launch the client,
		 * sign in, then import what it wrote — and doing them blind is why the
		 * original "import" button looked broken: a sealed CN credential is
		 * skipped silently. This drawer makes each step explicit and reports
		 * its outcome, including "found but sealed", which no import can fix
		 * and which therefore needs a different instruction.
		 *
		 * @param props - `onAction` runs a host action and returns its result.
		 */
		function AuthorizeDrawer(props) {
			const [opened, setOpened] = React.useState(null);
			const [discovery, setDiscovery] = React.useState(null);
			const [busy, setBusy] = React.useState(null);
			const [imported, setImported] = React.useState(null);

			const run = (kind, action) => {
				setBusy(kind);
				const done = () => setBusy(null);
				props.onAction(action).then((result) => {
					done();
					if (result === null) return;
					if (kind === "open") setOpened(result.authorize ?? { ok: false, error: "无响应" });
					if (kind === "scan") setDiscovery(result.discovery ?? null);
					if (kind === "import") {
						setImported(result.importResult ?? { ok: false, error: "无响应" });
						// The pool cards live in the parent; re-read them so a
						// successful import is visible without a manual refresh.
						props.onChanged?.();
					}
				}, done);
			};

			const files = discovery !== null && Array.isArray(discovery.files) ? discovery.files : [];

			return React.createElement("div", { className: "bh-drawer", "data-buddy-connect-auth": "" },
				React.createElement("div", { className: "bh-drawer-head" },
					React.createElement("div", { className: "bh-drawer-title" }, TEXT.authTitle),
					React.createElement("button", {
						type: "button", className: "bh-btn", onClick: props.onClose
					}, TEXT.authClose)
				),
				React.createElement("div", { className: "bh-drawer-body" },

					// Step 1 — launch the client.
					React.createElement("div", { className: "bh-step" },
						React.createElement("span", { className: "bh-step-num" }, "1"),
						React.createElement("div", { className: "bh-step-main" },
							React.createElement("div", { className: "bh-step-title" }, TEXT.authStep1),
							React.createElement("div", { className: "bh-step-hint" }, TEXT.authStep1Hint),
							React.createElement("div", { className: "bh-step-action" },
								React.createElement("button", {
									type: "button",
									className: "bh-btn bh-btn-primary",
									disabled: busy !== null,
									onClick: () => run("open", { action: "authorize" })
								}, busy === "open" ? TEXT.authorizing : TEXT.authOpen),
								opened !== null ? React.createElement("span", {
									className: "bh-badge " + (opened.ok === true ? "bh-badge-ok" : "bh-badge-err")
								}, opened.ok === true ? TEXT.authOpened : (opened.error ?? TEXT.authOpenFailed)) : null
							)
						)
					),

					// Step 2 — scan what the client wrote.
					React.createElement("div", { className: "bh-step" },
						React.createElement("span", { className: "bh-step-num" }, "2"),
						React.createElement("div", { className: "bh-step-main" },
							React.createElement("div", { className: "bh-step-title" }, TEXT.authStep2),
							React.createElement("div", { className: "bh-step-hint" }, TEXT.authStep2Hint),
							React.createElement("div", { className: "bh-step-action" },
								React.createElement("button", {
									type: "button",
									className: "bh-btn",
									disabled: busy !== null,
									onClick: () => run("scan", { action: "discover" })
								}, busy === "scan" ? TEXT.authScanning : TEXT.authScan)
							),
							discovery !== null ? React.createElement("div", { className: "bh-files" },
								files.length === 0
									? React.createElement("div", { className: "bh-empty" }, discovery.summary)
									: files.map((f) => React.createElement("div", { className: "bh-file", key: f.path },
										React.createElement("span", {
											className: "bh-badge " + (f.importable === true ? "bh-badge-ok"
												: f.reason === "encrypted_credential" ? "bh-badge-warn" : "bh-badge-idle")
										}, f.importable === true ? TEXT.authImportable
											: f.reason === "encrypted_credential" ? TEXT.authSealed : TEXT.authIgnored),
										React.createElement("div", { className: "bh-file-main" },
											React.createElement("div", { className: "bh-file-name", title: f.path },
												f.name + (isText(f.site) ? " · " + f.site.toUpperCase() : "")),
											React.createElement("div", { className: "bh-file-msg" }, f.message)
										)
									))
							) : null
						)
					),

					// Step 3 — import through 守护进程.
					React.createElement("div", { className: "bh-step" },
						React.createElement("span", { className: "bh-step-num" }, "3"),
						React.createElement("div", { className: "bh-step-main" },
							React.createElement("div", { className: "bh-step-title" }, TEXT.authStep3),
							React.createElement("div", { className: "bh-step-hint" }, TEXT.authStep3Hint),
							React.createElement("div", { className: "bh-step-action" },
								React.createElement("button", {
									type: "button",
									className: "bh-btn",
									disabled: busy !== null || discovery === null || discovery.importable === 0,
									onClick: () => run("import", { action: "import" })
								}, busy === "import" ? TEXT.authImporting : TEXT.authImport),
								imported !== null ? React.createElement("span", {
									className: "bh-badge " + (imported.ok === true ? "bh-badge-ok" : "bh-badge-err")
								}, imported.ok === true
									? TEXT.authImportDone + " · 新增 " + imported.added + " · 更新 " + imported.updated
									: TEXT.authImportFailed + "：" + (imported.error ?? "")) : null
							),
							discovery !== null && discovery.sealed > 0
								? React.createElement("div", { className: "bh-step-hint" }, TEXT.authSealedHint)
								: null
						)
					)
				)
			);
		}

		function apply(ctx) {
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.setAttribute("data-buddy-connect", "");
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => { tag.remove(); };
			}, "dsh-command-buddy-connect: css");
			// `plugins.bundle.config` is a keyed slot declared by the shipped
			// plugin-manager page; the key is the bundle's package name, which is
			// also what makes the page show its configuration section at all.
			ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register(
				{ name: "plugins.bundle.config", key: "dsh-command-buddy-connect" },
				BuddyCard
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
