/**
 * dsh-fingerprint / client.js —— 侧栏入口 + 整页 UI（契约 §2.1 / §2.2 / §2.3 / §5）
 *
 * 硬约束（违反即整格失效）：
 *   1. 单文件 classic script：全文禁止 ESM 语法（宿主以 <script async> 加载）。
 *   2. 必须包裹为 window.__ModuleLoader__.load({ id, factory })，factory 返回 bundleModule.exports。
 *   3. require 只允许命中外壳 11 个种子词，本文件只用到三个：
 *      react / react/jsx-runtime / @deepseek-ai/dsh-client-ui-primitives。
 *   4. 原语取不到时必须走内置降级实现，绝不渲染 undefined（否则 React 抛错、宿主 retire 整格）。
 *   5. 一切网络访问都走 try/catch；接口未就绪（404 / 非 JSON）必须显示明确状态，不白屏。
 *
 * 本文件只做 UI：不取密钥、不做模型调用、不做指纹算法（契约 §2.6）。
 */
window.__ModuleLoader__.load({
  id: "dsh-fingerprint",
  factory: (require) => {
    const bundleModule = { exports: {} };
    Object.defineProperty(bundleModule.exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;
    const Fragment = React.Fragment;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useMemo = React.useMemo;
    const useCallback = React.useCallback;
    const useRef = React.useRef;

    //#region 常量
    /** 面板 id 与 main key 必须是同一个字符串（契约 §1 / §2.1）。 */
    const PANEL_ID = "dsh-fingerprint";
    /** 字典命名空间。 */
    const NS = "dsh-fingerprint";
    /** HTTP 前缀（契约 §5）。 */
    const API = "/fingerprint";
    /** 侧栏顺序：排在 Purge（30）之后（契约 §1）。 */
    const SIDEBAR_ORDER = 40;

    const ROUNDS = { min: 1, max: 20, def: 3 };
    const CHALLENGE_COUNT = { min: 1, max: 3, def: 3 };
    const PARALLEL = { min: 1, max: 3, def: 3 };
    const TIMEOUT_SEC = { min: 10, max: 600, def: 120 };
    /** 严格模式强制挑战数（契约 §5 options.count）。 */
    const STRICT_COUNT = 3;
    /** 轮询兜底间隔。 */
    const POLL_MS = 1000;
    /** 空闲期探测「宿主是否有正在跑的任务」的间隔（契约 §28.3：彻底消灭"有任务在跑但界面看不见"）。 */
    const IDLE_POLL_MS = 4000;
    /** 明细里展示的排名条数上限。 */
    const TOP_RANKING = 10;

    /** 颜色一律走主题变量 + fallback（契约 §2.3：primitives 没有 Table/Progress，自己画）。 */
    const COLOR = {
      fg: "var(--dsw-alias-label-primary, currentColor)",
      mute: "var(--dsw-alias-label-secondary, rgba(127,127,127,.95))",
      border: "var(--dsw-alias-border-l1, rgba(127,127,127,.28))",
      borderStrong: "var(--dsw-alias-border-l2, rgba(127,127,127,.45))",
      bg: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
      bg2: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.10))",
      accent: "var(--dsw-alias-brand-primary, #4d6bfe)",
      ok: "var(--dsw-alias-state-success-primary, #1f9d55)",
      warn: "var(--dsw-alias-state-warn-primary, #b7791f)",
      bad: "var(--dsw-alias-state-error-primary, #d14343)",
    };

    const S = {
      page: {
        boxSizing: "border-box",
        height: "100%",
        minHeight: 0,
        overflow: "auto",
        padding: "18px 22px 40px",
        color: COLOR.fg,
        fontSize: "14px",
        lineHeight: 1.55,
      },
      head: { display: "flex", alignItems: "center", gap: "10px", minWidth: 0 },
      title: { margin: 0, fontSize: "1.1em", fontWeight: 600 },
      sub: { margin: "2px 0 0", fontSize: ".85em", color: COLOR.mute },
      strip: {
        display: "flex",
        flexWrap: "wrap",
        gap: "6px 16px",
        margin: "12px 0 0",
        padding: "8px 0 10px",
        borderBottom: "1px solid " + COLOR.border,
        fontSize: ".84em",
        color: COLOR.mute,
      },
      section: {
        border: "1px solid " + COLOR.border,
        borderRadius: "12px",
        background: COLOR.bg,
        padding: "14px 16px",
        margin: "14px 0 0",
        minWidth: 0,
      },
      sectionTitle: { margin: "0 0 10px", fontSize: "1em", fontWeight: 600 },
      row: { display: "flex", flexWrap: "wrap", gap: "8px 10px", alignItems: "center", minWidth: 0 },
      field: {
        display: "grid",
        gridTemplateColumns: "minmax(96px, 150px) minmax(0, 1fr)",
        gap: "6px 12px",
        alignItems: "center",
        margin: "8px 0 0",
      },
      fieldLabel: { fontSize: ".92em" },
      hint: { color: COLOR.mute, fontSize: ".82em", lineHeight: 1.6, margin: 0 },
      groupHead: {
        display: "flex",
        flexWrap: "wrap",
        gap: "8px",
        alignItems: "center",
        padding: "6px 0",
        borderTop: "1px solid " + COLOR.border,
      },
      groupTitle: { fontWeight: 600, fontSize: ".94em" },
      modelRow: {
        display: "flex",
        flexWrap: "wrap",
        gap: "8px",
        alignItems: "center",
        padding: "3px 0 3px 4px",
        minWidth: 0,
      },
      chip: {
        border: "1px solid " + COLOR.border,
        borderRadius: "999px",
        padding: "0 7px",
        fontSize: ".76em",
        color: COLOR.mute,
        whiteSpace: "nowrap",
      },
      chipWarn: {
        border: "1px solid " + COLOR.warn,
        borderRadius: "999px",
        padding: "0 7px",
        fontSize: ".76em",
        color: COLOR.warn,
        whiteSpace: "nowrap",
      },
      chipBad: {
        border: "1px solid " + COLOR.bad,
        borderRadius: "999px",
        padding: "0 7px",
        fontSize: ".76em",
        color: COLOR.bad,
        whiteSpace: "nowrap",
      },
      actions: {
        position: "sticky",
        top: 0,
        zIndex: 4,
        display: "flex",
        flexWrap: "wrap",
        gap: "8px",
        alignItems: "center",
        padding: "8px 0 10px",
        margin: "6px 0 2px",
        borderBottom: "1px solid " + COLOR.border,
        background: "var(--dsw-alias-bg-base, canvas)",
      },
      table: { width: "100%", borderCollapse: "collapse", fontSize: ".85em" },
      th: {
        textAlign: "left",
        padding: "6px 8px",
        borderBottom: "1px solid " + COLOR.border,
        color: COLOR.mute,
        fontWeight: 500,
        whiteSpace: "nowrap",
      },
      td: {
        textAlign: "left",
        padding: "6px 8px",
        borderBottom: "1px solid " + COLOR.border,
        verticalAlign: "top",
        overflowWrap: "anywhere",
      },
      bar: {
        position: "relative",
        height: "6px",
        borderRadius: "999px",
        background: COLOR.bg2,
        overflow: "hidden",
        minWidth: "80px",
        width: "140px",
      },
      notice: {
        border: "1px solid " + COLOR.borderStrong,
        borderRadius: "10px",
        padding: "12px 14px",
        background: COLOR.bg2,
        margin: "14px 0 0",
      },
      /** 「检测 / 历史」切换：非当前视图整体隐藏（DOM 保留，run 视图不中断）。 */
      hidden: { display: "none" },
      noticeBad: {
        border: "1px solid " + COLOR.bad,
        borderRadius: "10px",
        padding: "12px 14px",
        background: COLOR.bg2,
        margin: "14px 0 0",
        color: COLOR.bad,
      },
      pre: {
        margin: "6px 0 0",
        padding: "8px 10px",
        border: "1px solid " + COLOR.border,
        borderRadius: "8px",
        background: COLOR.bg2,
        fontSize: ".82em",
        maxHeight: "260px",
        overflow: "auto",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      },
      code: { fontSize: ".86em", color: COLOR.mute },
    };

    /** 任务状态 → 颜色 / 中文标签（契约 §5：queued/waiting/streaming/complete/truncated/failed）。 */
    const TASK_STATE = {
      queued: { color: COLOR.mute, label: "排队" },
      waiting: { color: COLOR.warn, label: "等待首字节" },
      streaming: { color: COLOR.accent, label: "流式接收" },
      complete: { color: COLOR.ok, label: "完成" },
      truncated: { color: COLOR.warn, label: "截断" },
      failed: { color: COLOR.bad, label: "失败" },
    };

    const RUN_PHASE = {
      idle: "未开始",
      running: "运行中",
      done: "已完成",
      cancelled: "已取消",
      failed: "失败",
    };
    //#endregion

    //#region 字典（zh 为主，en 对齐键集）
    const ZH = {
      nav: "指纹检测",
      title: "LM Fingerprint Detection",
      intro: "对 DSH 已配置的模型跑多轮指纹检测，输出参考库内的封闭排名。",
      detectorReady: "检测器就绪",
      detectorNotReady: "检测器未构建",
      detectorBank: "参考模型",
      detectorBuiltAt: "构建时间",
      detectorRefresh: "重载检测器",
      detectorRefreshing: "重载中…",
      targetsTitle: "1. 选择模型",
      targetsSearch: "搜索模型（id / 名称）",
      selectAll: "全选",
      selectClear: "清空",
      selectCount: "已选 {n} / {total}",
      groupSelectAll: "全选本组",
      groupSelectNone: "取消本组",
      noModelMatched: "没有匹配的模型",
      noProvider: "宿主未返回任何 provider",
      credByAccount: "凭据由账号/其他机制提供",
      credTransient: "暂时无法判定（本机设置/目录查询异常）",
      credMissingProfile: "未配置凭据，无法运行",
      credMissingGuessed: "未检测到凭据，无法运行",
      inputUnknown: "未知",
      ctxLabel: "上下文",
      outLabel: "输出",
      dormant: "休眠路由（active=false）",
      dormantTag: "休眠",
      dormantGroup: "未启用（{n}）",
      dormantReason: "该 provider 未启用适配器，无法检测",
      dormantExcluded: "{n} 个未启用 provider 不参与全选",
      sourceConfig: "配置",
      sourceCatalog: "目录",
      inputLabel: "输入",
      roundsTitle: "2. 轮次",
      rounds: "轮次",
      roundsHint: "范围 1–20，默认 3",
      estimated: "预计总请求 {n} 次（{targets} 模型 × {rounds} 轮 × {count} 挑战）；在飞请求数 = min(并发 {parallel}, 目标×轮次 {slots}) × 每轮挑战 {count} = {inflight}",
      advanced: "高级选项",
      challenges: "每轮挑战数",
      challengesHint: "1–3，默认 3；严格模式下强制为 3",
      parallel: "并发",
      parallelHint: "1–3，默认 3；同时在跑的轮次数（跨「目标 × 轮次」）",
      runtimeBanner: "运行中",
      attached: "已接上正在运行的任务",
      idleWatch: "正在探测宿主是否有运行中的任务…",
      tabDetect: "检测",
      tabHistory: "历史",
      viewSwitch: "视图切换",
      historyTitle: "检测历史",
      historySub: "按模型汇总曾经跑过的检测（落盘记录，不含回答正文）",
      historyRefresh: "刷新历史",
      historyEmpty: "还没有检测记录",
      historyLoadFailed: "历史读取失败：{reason}",
      historySkipped: "跳过 {n} 行无法解析的记录",
      historyClear: "清空历史",
      historyClearConfirm: "确认清空？",
      historyClearCancel: "不，先留着",
      historyCleared: "已清空 {n} 条记录",
      historyClearFailed: "清空失败：{reason}",
      historyDetailTitle: "最近 {n} 条",
      historyDetailEmpty: "该模型暂无明细记录",
      /** ⚠️ stats.count 是**历史文件总量**，与过滤无关 —— 只能用于这个口径。 */
      historyTotal: "历史文件共 {n} 条记录",
      historyShowing: "当前显示 {shown} / {all} 个模型",
      colLastSeen: "最近检测",
      colRuns: "次数",
      colLastTop1: "最近 top1",
      colWhen: "时间",
      colDetail: "明细",
      collapse: "收起明细",
      strict: "严格模式",
      strictHint: "不截断，且要求每轮 3 条全部有效",
      timeout: "超时（秒）",
      timeoutHint: "默认 120",
      clampHint: "已按范围校正为 {n}",
      runTitle: "3. 运行",
      start: "开始检测",
      cancel: "取消",
      exportJson: "导出 JSON",
      needSelection: "请至少选择一个可用模型",
      busy: "宿主侧已有运行中的任务（BUSY）",
      noRun: "尚未开始运行",
      runPhase: "阶段",
      runId: "任务 ID",
      feedMode: "数据通道",
      feedSse: "SSE",
      feedPoll: "轮询兜底",
      feedConnecting: "连接中",
      feedDone: "已结束",
      feedCancelled: "已取消",
      feedFailed: "失败",
      feedError: "通道异常",
      feedStopped: "未连接",
      progressTitle: "4. 运行明细",
      tasksEmpty: "暂无任务",
      colModel: "模型",
      colRound: "轮次",
      colState: "状态",
      colCount: "样本数",
      colFirstByte: "首字节",
      colProgress: "进度",
      resultsTitle: "5. 结果",
      resultsEmpty: "暂无结果",
      colTop1: "top1 预测",
      colFamily: "家族",
      colConfidence: "置信度",
      colAgreement: "一致率",
      colStability: "稳定标记",
      colDecision: "decision",
      colError: "失败原因",
      stabilityStable: "稳定",
      stabilityUnstable: "结果不稳定，建议增加轮次",
      stabilityInconclusive: "样本不足，建议增加轮次",
      decisionScored: "已评分",
      decisionPartial: "部分回合有效",
      decisionUnscorable: "无可评分回合",
      noRank: "无排名",
      colValidRounds: "有效回合",
      metricNote:
        "口径：一致率 = 胜者得票 / 有效回合（不是总轮次）；置信度 = 有效回合 probability 的中位数；有效回合 = decision 为 scored 且给出 top1 的回合。",
      rankingNote: "排名是参考库内的封闭集合排序，不是身份证明。",
      detail: "展开明细",
      detailLoading: "明细加载中…",
      detailFailed: "明细不可用",
      rankingTitle: "完整排名（前 {n}）",
      perRoundTitle: "每轮明细",
      rawTitle: "原始回答",
      colRank: "名次",
      colVotes: "票数",
      colMeanRank: "平均名次",
      colScore: "得分",
      colProb: "概率",
      colRoundDecision: "decision",
      colRoundProb: "概率",
      colRawText: "原始文本",
      interfaceUnready: "宿主接口未就绪",
      interfaceUnreadyHint:
        "请求 {path} 没有得到契约格式的 JSON（{reason}）。宿主侧 /fingerprint 路由可能尚未实现或尚未挂载，本页面不会白屏，稍后点「重试」即可。",
      interfaceError: "接口调用失败",
      retry: "重试",
      reload: "重新加载模型列表",
      cancelFailed: "取消失败",
      exportFailed: "导出失败，已改为导出当前快照",
      exported: "已触发下载 {name}",
      strictForced: "严格模式已开启，挑战数固定为 {n}",
      pageCrash: "本页面渲染出错（已捕获，不影响其它面板）",
      errorRaw: "错误原文",
      cancelled: "已请求取消",
    };
    const EN = {
      nav: "Fingerprint",
      title: "LM Fingerprint Detection",
      intro: "Run multi-round fingerprint detection against configured models.",
      detectorReady: "Detector ready",
      detectorNotReady: "Detector not built",
      detectorBank: "Bank models",
      detectorBuiltAt: "Built at",
      detectorRefresh: "Reload detector",
      detectorRefreshing: "Reloading…",
      targetsTitle: "1. Models",
      targetsSearch: "Search models (id / name)",
      selectAll: "Select all",
      selectClear: "Clear",
      selectCount: "{n} / {total} selected",
      groupSelectAll: "Select group",
      groupSelectNone: "Clear group",
      noModelMatched: "No model matched",
      noProvider: "Host returned no provider",
      credByAccount: "credential provided by the account or another mechanism",
      credTransient: "cannot determine yet (local settings/catalog query failed)",
      credMissingProfile: "no credential configured; cannot run",
      credMissingGuessed: "no credential detected; cannot run",
      inputUnknown: "unknown",
      ctxLabel: "ctx",
      outLabel: "out",
      dormant: "Dormant route (active=false)",
      dormantTag: "dormant",
      dormantGroup: "Disabled ({n})",
      dormantReason: "No adapter registered for this provider; cannot be probed",
      dormantExcluded: "{n} disabled providers are excluded from select-all",
      sourceConfig: "config",
      sourceCatalog: "catalog",
      inputLabel: "input",
      roundsTitle: "2. Rounds",
      rounds: "Rounds",
      roundsHint: "1–20, default 3",
      estimated: "~{n} requests total ({targets} models x {rounds} rounds x {count} challenges); in-flight = min(parallel {parallel}, slots {slots}) x {count} = {inflight}",
      advanced: "Advanced",
      challenges: "Challenges per round",
      challengesHint: "1–3, default 3 (forced to 3 in strict mode)",
      parallel: "Parallel",
      parallelHint: "1–3, default 3; rounds running at the same time (across target x round)",
      runtimeBanner: "Running",
      attached: "Attached to the run already in progress",
      idleWatch: "Watching the host for an active run…",
      tabDetect: "Detect",
      tabHistory: "History",
      viewSwitch: "View switch",
      historyTitle: "Detection history",
      historySub: "Per-model summary of past runs (on-disk records, no answer text)",
      historyRefresh: "Reload history",
      historyEmpty: "No records yet",
      historyLoadFailed: "Failed to read history: {reason}",
      historySkipped: "skipped {n} unparsable lines",
      historyClear: "Clear history",
      historyClearConfirm: "Confirm clear?",
      historyClearCancel: "Keep them",
      historyCleared: "Cleared {n} records",
      historyClearFailed: "Clear failed: {reason}",
      historyDetailTitle: "Latest {n}",
      historyDetailEmpty: "No detail records for this model",
      historyTotal: "{n} records in the history file",
      historyShowing: "showing {shown} / {all} models",
      colLastSeen: "Last seen",
      colRuns: "Runs",
      colLastTop1: "Last top1",
      colWhen: "Time",
      colDetail: "Detail",
      collapse: "Collapse",
      strict: "Strict mode",
      strictHint: "No truncation; all 3 challenges must be valid",
      timeout: "Timeout (s)",
      timeoutHint: "default 120",
      clampHint: "clamped to {n}",
      runTitle: "3. Run",
      start: "Start",
      cancel: "Cancel",
      exportJson: "Export JSON",
      needSelection: "Select at least one usable model",
      busy: "A run is already active (BUSY)",
      noRun: "No run yet",
      runPhase: "Phase",
      runId: "Run id",
      feedMode: "Feed",
      feedSse: "SSE",
      feedPoll: "polling fallback",
      feedConnecting: "connecting",
      feedDone: "closed",
      feedCancelled: "cancelled",
      feedFailed: "failed",
      feedError: "feed error",
      feedStopped: "idle",
      progressTitle: "4. Progress",
      tasksEmpty: "No task",
      colModel: "Model",
      colRound: "Round",
      colState: "State",
      colCount: "Samples",
      colFirstByte: "First byte",
      colProgress: "Progress",
      resultsTitle: "5. Results",
      resultsEmpty: "No result",
      colTop1: "top1",
      colFamily: "Family",
      colConfidence: "Confidence",
      colAgreement: "Agreement",
      colStability: "Stability",
      colDecision: "decision",
      colError: "Error",
      stabilityStable: "stable",
      stabilityUnstable: "unstable — add rounds",
      stabilityInconclusive: "insufficient samples — add rounds",
      decisionScored: "scored",
      decisionPartial: "partial",
      decisionUnscorable: "unscorable",
      noRank: "no ranking",
      colValidRounds: "Valid rounds",
      metricNote:
        "Definitions: agreement = winner votes / valid rounds (not total rounds); confidence = median probability over valid rounds; a valid round is one with decision 'scored' and a top1.",
      rankingNote: "Ranking is a closed-set order inside the reference bank, not proof of identity.",
      detail: "Details",
      detailLoading: "Loading details…",
      detailFailed: "Details unavailable",
      rankingTitle: "Full ranking (top {n})",
      perRoundTitle: "Per-round detail",
      rawTitle: "Raw answers",
      colRank: "#",
      colVotes: "Votes",
      colMeanRank: "Mean rank",
      colScore: "Score",
      colProb: "Probability",
      colRoundDecision: "decision",
      colRoundProb: "probability",
      colRawText: "Raw text",
      interfaceUnready: "Host API not ready",
      interfaceUnreadyHint:
        "{path} did not return contract JSON ({reason}). The /fingerprint route may be missing; the page stays usable — press Retry later.",
      interfaceError: "Request failed",
      retry: "Retry",
      reload: "Reload models",
      cancelFailed: "Cancel failed",
      exportFailed: "Export failed, downloading current snapshot instead",
      exported: "Download started: {name}",
      strictForced: "Strict mode forces challenge count to {n}",
      pageCrash: "This panel failed to render (caught; other panels unaffected)",
      errorRaw: "Raw error",
      cancelled: "Cancel requested",
    };

    /** apply() 里绑定的翻译器；未绑定时回退内置中文表。 */
    let boundTranslate = null;

    /** 模板插值：把 {name} 换成 params.name。 */
    function interpolate(template, params) {
      if (params === null || params === undefined) return template;
      let out = template;
      for (const key of Object.keys(params)) {
        // 显式守卫（对齐宿主 translate 的 `name in params`）：原型链上的键不参与替换。
        if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
        const value = params[key];
        // null/undefined 不参与替换：宁可保留 {name} 占位，也绝不产出字面量 "undefined"。
        if (value === null || value === undefined) continue;
        out = out.split("{" + key + "}").join(String(value));
      }
      return out;
    }

    /** 安全翻译：优先宿主 locale 绑定，其次内置字典，最后回退 key 本身。 */
    function t(key, params) {
      if (boundTranslate !== null) {
        try {
          const text = boundTranslate(key, params);
          if (typeof text === "string" && text.length > 0 && text !== key) return text;
        } catch (err) {
          /* 翻译器异常不能影响渲染 */
        }
      }
      const raw = ZH[key];
      if (typeof raw === "string") return interpolate(raw, params);
      return key;
    }

    /** 给英文环境用的字典（宿主 locale 会自行选择；这里同时注册两套）。 */
    function enTable() {
      return EN;
    }
    //#endregion

    //#region 原语安全取用 + 降级实现
    /** 取原语组件；拿不到就用降级实现，绝不把 undefined 交给 React。 */
    function pickPrimitive(name, fallback) {
      try {
        const value = primitives === null || primitives === undefined ? undefined : primitives[name];
        if (value !== undefined && value !== null) return value;
      } catch (err) {
        /* 取属性都不许抛 */
      }
      return fallback;
    }

    /** 降级按钮。 */
    function FallbackButton(props) {
      return jsx("button", {
        type: props.type === undefined ? "button" : props.type,
        className: props.className,
        style: {
          font: "inherit",
          fontSize: ".9em",
          padding: "5px 12px",
          borderRadius: "8px",
          border: "1px solid " + COLOR.border,
          background: COLOR.bg2,
          color: COLOR.fg,
          cursor: props.disabled === true ? "not-allowed" : "pointer",
          opacity: props.disabled === true ? 0.5 : 1,
          ...(props.style === undefined ? {} : props.style),
        },
        disabled: props.disabled === true,
        onClick: props.onClick,
        "aria-label": props["aria-label"],
        children: props.children,
      });
    }

    /** 降级复选框（onChange 传 boolean，与宿主 Checkbox 一致）。 */
    function FallbackCheckbox(props) {
      return jsxs("label", {
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          cursor: props.disabled === true ? "not-allowed" : "pointer",
          opacity: props.disabled === true ? 0.55 : 1,
        },
        children: [
          jsx("input", {
            key: "box",
            type: "checkbox",
            checked: props.checked === true,
            disabled: props.disabled === true,
            onChange: (event) => {
              if (typeof props.onChange === "function") props.onChange(event.target.checked);
            },
          }),
          props.label === undefined || props.label === null
            ? null
            : jsx("span", { key: "text", style: { fontSize: ".9em" }, children: props.label }),
        ],
      });
    }

    /** 降级开关（onChange 传 boolean）。 */
    function FallbackSwitch(props) {
      return jsxs("label", {
        style: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: ".9em" },
        children: [
          jsx("input", {
            key: "switch",
            type: "checkbox",
            checked: props.checked === true,
            disabled: props.disabled === true,
            title: props.title,
            onChange: (event) => {
              if (typeof props.onChange === "function") props.onChange(event.target.checked);
            },
          }),
          props.label === undefined || props.label === null ? null : jsx("span", { key: "text", children: props.label }),
        ],
      });
    }

    /** 降级提示：没有 Tooltip 时用原生 title。 */
    function FallbackTooltip(props) {
      if (props.disabled === true || props.label === undefined || props.label === null) return props.children;
      return jsx("span", {
        title: typeof props.label === "string" ? props.label : undefined,
        style: { display: "inline-flex", alignItems: "center", gap: "6px", minWidth: 0 },
        children: props.children,
      });
    }

    /** 降级折叠行。 */
    function FallbackDisclosureRow(props) {
      const open = props.open === true;
      const expandable = props.expandable !== false;
      return jsxs("div", {
        style: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 },
        children: [
          jsxs("button", {
            key: "head",
            type: "button",
            onClick: expandable ? props.onToggle : undefined,
            style: {
              display: "flex",
              alignItems: "center",
              gap: "8px",
              font: "inherit",
              fontSize: ".92em",
              padding: "6px 8px",
              borderRadius: "8px",
              border: "1px solid " + COLOR.border,
              background: "transparent",
              color: COLOR.fg,
              cursor: expandable ? "pointer" : "default",
              width: "100%",
              textAlign: "left",
            },
            children: [
              jsx("span", { key: "chev", "aria-hidden": "true", children: open ? "▾" : "▸" }),
              props.icon === undefined || props.icon === null ? null : jsx("span", { key: "icon", children: props.icon }),
              jsx("span", { key: "title", children: props.title }),
              jsx("span", { key: "collapse", style: { marginLeft: "auto", color: COLOR.mute, fontSize: ".9em" }, children: props.collapsedContent }),
            ],
          }),
          open ? jsx("div", { key: "body", children: props.children }) : null,
        ],
      });
    }

    /** 降级 JSON 展示。 */
    function FallbackJsonBlock(props) {
      let text = "";
      try {
        text = JSON.stringify(props.payload, null, 2);
      } catch (err) {
        text = String(props.payload);
      }
      if (text === undefined) text = "undefined";
      return jsxs("div", {
        children: [
          props.label === undefined ? null : jsx("p", { key: "label", style: S.hint, children: props.label }),
          jsx("pre", { key: "pre", style: S.pre, children: text }),
        ],
      });
    }

    const Button = pickPrimitive("Button", FallbackButton);
    const Checkbox = pickPrimitive("Checkbox", FallbackCheckbox);
    const Switch = pickPrimitive("Switch", FallbackSwitch);
    /** primitives.Input 观察到的用法就是原生 input 属性透传，降级直接用原生 input。 */
    const Input = pickPrimitive("Input", "input");
    const Tooltip = pickPrimitive("Tooltip", FallbackTooltip);
    const DisclosureRow = pickPrimitive("DisclosureRow", FallbackDisclosureRow);
    const JsonBlock = pickPrimitive("JsonBlock", FallbackJsonBlock);
    const CodeBlock = pickPrimitive("CodeBlock", null);
    /** 分段控件（「检测 / 历史」）；缺失时用降级按钮组。 */
    const Tabs = pickPrimitive("SegmentedTabs", FallbackTabs);

    /**
     * 数值输入的统一封装（D7）。
     * 宿主 `Input` 的结构是 `<span class=wrap><input {...rest}/></span>` —— 把 style 直接传给它
     * 会落到**内层 input**，宽度不受外层容器约束。所以宽度统一作用在显式 wrapper `<span>` 上，
     * 内层只负责填满 wrapper（`width:100%`）。
     */
    function NumberField(props) {
      return jsx("span", {
        style: { display: "inline-flex", width: props.width, alignItems: "center", minWidth: 0 },
        children: jsx(Input, {
          type: "number",
          min: props.min,
          max: props.max,
          step: props.step,
          value: props.value,
          disabled: props.disabled === true,
          "aria-label": props.ariaLabel,
          style: { width: "100%", boxSizing: "border-box", minWidth: 0 },
          onChange: props.onChange,
        }),
      });
    }

    /**
     * 分段控件降级实现（D7 同源问题：primitives 缺失时不能没有切换入口）。
     * 接受与宿主 `SegmentedTabs` 相同的 {value, onChange, items:[{value,label}]}。
     */
    function FallbackTabs(props) {
      const items = Array.isArray(props.items) ? props.items : [];
      return jsx("div", {
        style: { display: "inline-flex", gap: "6px", alignItems: "center" },
        role: "tablist",
        children: items.map((item) =>
          jsx("button", {
            key: item.value,
            type: "button",
            role: "tab",
            "aria-selected": props.value === item.value,
            onClick: () => {
              if (typeof props.onChange === "function") props.onChange(item.value);
            },
            style: {
              font: "inherit",
              fontSize: ".9em",
              padding: "4px 14px",
              borderRadius: "999px",
              border: "1px solid " + (props.value === item.value ? COLOR.accent : COLOR.border),
              background: props.value === item.value ? COLOR.bg2 : "transparent",
              color: props.value === item.value ? COLOR.accent : COLOR.fg,
              cursor: "pointer",
            },
            children: item.label,
          }),
        ),
      });
    }

    /** 内置指纹图标（永不返回 undefined；primitives 图标一律不依赖）。 */
    function FingerprintIcon(props) {
      const size = props !== null && props !== undefined && Number.isFinite(props.size) ? props.size : 18;
      const active = props !== null && props !== undefined && props.active === true;
      return jsxs("svg", {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.6,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false",
        style: { color: active ? COLOR.accent : "currentColor", display: "block" },
        children: [
          jsx("path", { key: "a", d: "M12 4.4c-4.2 0-7.6 3.3-7.6 7.4 0 1.7.5 3.2 1.4 4.5" }),
          jsx("path", { key: "b", d: "M12 7.9c-2.2 0-4 1.7-4 3.9 0 1.3.5 2.4 1.4 3.2" }),
          jsx("path", { key: "c", d: "M12 11.4c-.8 0-1.5.7-1.5 1.5 0 .7.3 1.4.8 1.9" }),
          jsx("path", { key: "d", d: "M19.6 11.6c0 3.1-1.1 6-3.1 8.1" }),
          jsx("path", { key: "e", d: "M16.1 11.6c0 2.5-.9 4.8-2.5 6.5" }),
        ],
      });
    }
    //#endregion

    //#region 工具函数
    /** 目标主键。 */
    function targetKey(provider, model) {
      return String(provider) + "\u0000" + String(model);
    }

    /**
     * 从宿主返回体里取 runId（契约 §28.3）。
     * `activeRunId` / `error.runId` 都可能**缺失**（宿主未重组合 / 旧形状）⇒ 正向判定：
     * 只有非空字符串才算，其余（undefined / null / 空串 / 非字符串）一律返回 null，由调用方走回退路径。
     */
    function pickRunId(value) {
      return typeof value === "string" && value.length > 0 ? value : null;
    }

    /** 终态判定：只有这三个是终态，其余（含 idle / running）都算"还在跑"。 */
    function isTerminalPhase(phase) {
      return phase === "done" || phase === "cancelled" || phase === "failed";
    }

    /** 整数夹取。 */
    function clampInt(text, min, max, fallback) {
      const parsed = Number.parseInt(String(text).trim(), 10);
      if (!Number.isFinite(parsed)) return fallback;
      if (parsed < min) return min;
      if (parsed > max) return max;
      return parsed;
    }

    /** 数字文本是否被校正过（用来显示「已按范围校正」）。 */
    function isClamped(text, min, max) {
      const parsed = Number.parseInt(String(text).trim(), 10);
      if (!Number.isFinite(parsed)) return true;
      return parsed < min || parsed > max;
    }

    /** 百分比展示：<=1 视为比例。 */
    function formatProbability(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      if (value <= 1) return (value * 100).toFixed(1) + "%";
      return value.toFixed(3);
    }

    /** 毫秒展示。 */
    function formatMs(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      return Math.round(value) + " ms";
    }

    /** 计数展示：非有限值（含 null / undefined）一律 —，绝不显示成 0（契约 §14.5）。 */
    function formatNumber(value) {
      return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
    }

    /** 紧凑计数展示：1048576 → 1.05M；384000 → 384K；未知 → —（契约 §14.5）。 */
    function formatCount(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      if (value >= 1000000) return (value / 1000000).toFixed(2) + "M";
      if (value >= 1000) return Math.round(value / 1000) + "K";
      return String(value);
    }

    /** 时间展示（历史记录的 ts 是 ISO 字符串）：空/不可解析 → —（§14.5），可解析则本地化。 */
    function formatWhen(value) {
      const text = textOf(value).trim();
      if (text.length === 0) return "—";
      const parsed = Date.parse(text);
      if (!Number.isFinite(parsed)) return text;
      try {
        return new Date(parsed).toLocaleString();
      } catch (err) {
        return text;
      }
    }

    /**
     * 安全取数组（契约 §32.4）：export / 历史里可能有 `null` / `undefined` **空洞**，
     * 一律先滤掉再交给渲染，绝不把空洞当对象解引用，也绝不产出「第 NaN 轮」。
     */
    function safeList(value) {
      return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined) : [];
    }

    /**
     * 凭据三态（契约 §14.3 + §15.2 更正）+ ref 来源措辞（§14.2 / §15.3）+ null 的三种成因（§24.3）。
     * 返回 { kind, tone, text, blocking }：
     *   kind='ok'    → 已探测到凭据，不额外标注
     *   kind='info'  → credentialAvailable === null：**不置灰**。text 再分两种：
     *                    · 旁证丢失（settingsOk === false || catalogState === 'error'）⇒「暂时无法判定（本机设置/目录查询异常）」
     *                      这是**本机临时故障**，说成"凭据由别处提供"会是"听起来确定但实际是错的"文案。
     *                    · 其余（账号路由 / catalog 有模型 / 字段缺失无法判定）⇒「凭据由账号/其他机制提供」
     *   kind='warn'  → 探测过确实没有：置灰；措辞按 refSource 分级
     * ⚠️ 全部走**正向判定**：只有 `settingsOk === false` 或 `catalogState === 'error'` 才算临时故障；
     *    字段缺失 / null / 未知值一律退回通用文案（§15.3 / §24.3 兼容性要求），绝不报错。
     * ⚠️ credentialRefSource 允许为 null（§15.3：provider 级异常路径合法退化）——只做「是否等于
     *    profile / nativeAuth」的正向判定，其余一律走弱化措辞，绝不做严格枚举校验。
     */
    function credentialState(providerInfo) {
      if (providerInfo === null || providerInfo === undefined) {
        return { kind: "warn", tone: "hard", text: t("credMissingProfile"), blocking: true };
      }
      const available = providerInfo.credentialAvailable;
      if (available === true) return { kind: "ok", tone: "plain", text: "", blocking: false };
      if (available === null || available === undefined) {
        // 无法判定：不得显示成「未配置」，也不得置灰为不可用
        const transient = providerInfo.settingsOk === false || providerInfo.catalogState === "error";
        return transient
          ? { kind: "info", tone: "warn", text: t("credTransient"), blocking: false }
          : { kind: "info", tone: "plain", text: t("credByAccount"), blocking: false };
      }
      const refSource = textOf(providerInfo.credentialRefSource);
      if (refSource === "profile" || refSource === "nativeAuth") {
        // 确定 ref：可以说「未配置」
        return { kind: "warn", tone: "hard", text: t("credMissingProfile"), blocking: true };
      }
      // 'guessed' / null / 任何未知来源：ref 名是推断的，措辞弱化为「未检测到凭据」
      return { kind: "warn", tone: "soft", text: t("credMissingGuessed"), blocking: true };
    }

    /** 时间戳展示。 */
    function formatClock(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      try {
        return new Date(value).toLocaleTimeString();
      } catch (err) {
        return String(value);
      }
    }

    /** 任意值转可显示文本（失败原因可能是对象）。 */
    function textOf(value) {
      if (value === null || value === undefined) return "";
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      try {
        return JSON.stringify(value);
      } catch (err) {
        return String(value);
      }
    }

    /**
     * 契约 §9.2：null / undefined / 空串 / 纯空白一律视为「无排名」。
     * 依次取第一个非空值；全空返回 null（由调用方渲染成占位文案）。
     * 绝不能只判 `=== ''`：顶层字段无胜者是 null，perRound 里 SDK 原样透传的是 ''。
     */
    function pickText() {
      for (let i = 0; i < arguments.length; i += 1) {
        const value = arguments[i];
        if (value === null || value === undefined) continue;
        const text = typeof value === "string" ? value.trim() : textOf(value).trim();
        if (text.length > 0) return text;
      }
      return null;
    }

    /** 无排名占位文案由调用方传入 tt("noRank")，此处不再兜一层翻译。 */

    /** 触发浏览器下载。 */
    function downloadJson(filename, payload) {
      try {
        const text = JSON.stringify(payload, null, 2);
        const blob = new Blob([text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => {
          try {
            URL.revokeObjectURL(url);
          } catch (err) {
            /* 忽略 */
          }
        }, 2000);
        return true;
      } catch (err) {
        return false;
      }
    }

    /**
     * 统一 JSON 请求。
     * 返回 { ok:true, data } 或 { ok:false, kind, message, status, code }
     *   kind: "unready"（404 / 非 JSON，宿主接口未就绪）| "http" | "network" | "api" | "server"
     */
    async function requestJson(path, options) {
      const init = options === undefined ? {} : options;
      const url = API + path;
      let response = null;
      try {
        response = await fetch(url, {
          method: init.method === undefined ? "GET" : init.method,
          headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
      } catch (err) {
        return { ok: false, kind: "network", message: textOf(err && err.message ? err.message : err) };
      }
      if (response === null || response === undefined) {
        return { ok: false, kind: "network", message: "no response" };
      }
      const status = response.status;
      if (status === 404 || status === 405 || status === 501) {
        return {
          ok: false,
          kind: "unready",
          status,
          message: "HTTP " + String(status) + "（路由不存在）",
        };
      }
      let text = "";
      try {
        text = await response.text();
      } catch (err) {
        return { ok: false, kind: "unready", status, message: "读取响应失败：" + textOf(err && err.message) };
      }
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (err) {
        return {
          ok: false,
          kind: "unready",
          status,
          message: "HTTP " + String(status) + "，响应不是 JSON（前 120 字符：" + text.slice(0, 120) + "）",
        };
      }
      if (data === null || typeof data !== "object") {
        return { ok: false, kind: "unready", status, message: "响应 JSON 不是对象" };
      }
      if (data.ok === false) {
        const error = data.error === null || data.error === undefined ? {} : data.error;
        return {
          ok: false,
          kind: status >= 500 ? "server" : "api",
          status,
          code: textOf(error.code),
          // §28.3：BUSY 会带结构化 runId（可能缺失 ⇒ null，调用方走 /status 回退）
          runId: pickRunId(error.runId),
          message: textOf(error.message) || textOf(error.code) || "宿主返回 ok:false",
        };
      }
      if (status >= 500) {
        return { ok: false, kind: "server", status, message: "HTTP " + String(status) };
      }
      return { ok: true, data };
    }

    /**
     * 是否休眠 provider（契约 §12.4：`dormant = !active`；§12.5：41 个休眠目录项要收进折叠分组）。
     * 拿不到 providerInfo 时保守判为休眠 —— 绝不给用户一个勾了却跑不动的选项。
     */
    function isDormantProvider(providerInfo) {
      if (providerInfo === null || providerInfo === undefined) return true;
      return providerInfo.dormant === true || providerInfo.active === false;
    }

    /** 判定一行是否可选：provider 必须已启用适配器、且凭据确实不可用才禁用（null 不禁用，§14.3）。 */
    function rowDisabledReason(providerInfo) {
      if (isDormantProvider(providerInfo)) return t("dormantReason");
      const cred = credentialState(providerInfo);
      return cred.blocking ? cred.text : null;
    }

    /** 扁平化 provider → 模型行。 */
    function flattenRows(providers) {
      const rows = [];
      if (!Array.isArray(providers)) return rows;
      for (const providerInfo of providers) {
        if (providerInfo === null || providerInfo === undefined) continue;
        const provider = textOf(providerInfo.provider);
        const models = Array.isArray(providerInfo.models) ? providerInfo.models : [];
        for (const model of models) {
          if (model === null || model === undefined) continue;
          const id = textOf(model.id) || textOf(model.name);
          if (id.length === 0) continue;
          rows.push({ key: targetKey(provider, id), provider, model, providerInfo });
        }
      }
      return rows;
    }

    /** 按 provider 分组，保持扫描顺序（Map 迭代顺序 = 首次出现顺序）。 */
    function groupRowsByProvider(rows) {
      const map = new Map();
      for (const row of rows) {
        if (!map.has(row.provider)) map.set(row.provider, []);
        map.get(row.provider).push(row);
      }
      return map;
    }
    //#endregion

    //#region 运行数据通道（SSE + 轮询兜底，契约 §5）
    /**
     * 订阅一次运行的快照流。
     * 策略：先立即拉一次快照；EventSource 可用则开 SSE，收到消息就停轮询；
     * SSE 报错 / 不可用则开 1s 轮询；phase 进入终态即收尾。
     */
    function useRunFeed(runId) {
      const [snapshot, setSnapshot] = useState(null);
      const [feed, setFeed] = useState({ mode: "idle", error: null });

      useEffect(() => {
        if (runId === null || runId === undefined || runId === "") {
          setSnapshot(null);
          setFeed({ mode: "idle", error: null });
          return undefined;
        }
        let disposed = false;
        let settled = false;
        let source = null;
        let timer = null;

        const stopPoll = () => {
          if (timer !== null) {
            clearInterval(timer);
            timer = null;
          }
        };

        const shutdown = (mode) => {
          if (settled) return;
          settled = true;
          stopPoll();
          if (source !== null) {
            try {
              source.close();
            } catch (err) {
              /* 忽略 */
            }
            source = null;
          }
          if (!disposed) setFeed({ mode: mode, error: null });
        };

        const applySnapshot = (data) => {
          if (disposed || settled) return;
          setSnapshot(data);
          const phase = textOf(data.phase);
          // 终态：把**真实的 phase** 交给 shutdown，别一律写死「已结束」（取消/失败要能区分）
          if (phase === "done" || phase === "cancelled" || phase === "failed") shutdown(phase);
        };

        const pollOnce = async () => {
          const result = await requestJson("/run/" + encodeURIComponent(runId));
          if (disposed || settled) return;
          if (!result.ok) {
            setFeed((prev) => ({ ...prev, mode: prev.mode === "sse" ? "sse" : "poll-error", error: result.message }));
            return;
          }
          applySnapshot(result.data);
        };

        const startPoll = () => {
          if (timer !== null || disposed || settled) return;
          // D3：轮询真的接管时把 mode 也切过去 —— 否则通道标签会永远停在上一次的 "sse"，
          // 而数据其实全部来自轮询（诊断误导）。SSE 若恢复，onmessage 会再把 mode 切回 "sse"。
          setFeed({ mode: "poll", error: null });
          timer = setInterval(() => {
            void pollOnce();
          }, POLL_MS);
        };

        void pollOnce();

        if (typeof EventSource === "function") {
          try {
            source = new EventSource(API + "/run/" + encodeURIComponent(runId) + "/events");
            /**
             * 建连成功即把通道标成 SSE：否则在**首条消息到达之前**标签一直是「连接中」，
             * 而数据其实已经走 SSE（诊断误导）。同时停掉兜底轮询。
             */
            source.onopen = () => {
              if (disposed || settled) return;
              if (timer !== null) stopPoll();
              setFeed({ mode: "sse", error: null });
            };
            source.onmessage = (event) => {
              if (disposed || settled) return;
              if (timer !== null) stopPoll();
              setFeed({ mode: "sse", error: null });
              try {
                const parsed = JSON.parse(event.data);
                if (parsed !== null && typeof parsed === "object") applySnapshot(parsed);
              } catch (err) {
                setFeed({ mode: "sse", error: "SSE 数据不是 JSON" });
              }
            };
            source.addEventListener("done", () => {
              shutdown("done");
            });
            source.onerror = () => {
              if (disposed || settled) return;
              // EventSource 会自己重连；同时开轮询兜底，避免 404 时页面没有数据。
              startPoll();
            };
          } catch (err) {
            source = null;
            startPoll();
          }
        } else {
          startPoll();
        }

        return () => {
          disposed = true;
          stopPoll();
          if (source !== null) {
            try {
              source.close();
            } catch (err) {
              /* 忽略 */
            }
            source = null;
          }
        };
      }, [runId]);

      return { snapshot: snapshot, feed: feed };
    }
    //#endregion

    //#region 展示用小组件
    /** 自绘进度条（primitives 没有 Progress）。 */
    function ProgressBar(props) {
      const ratio = typeof props.ratio === "number" && Number.isFinite(props.ratio) ? props.ratio : 0;
      const clamped = Math.max(0, Math.min(1, ratio));
      const color = props.color === undefined ? COLOR.accent : props.color;
      return jsx("div", {
        style: S.bar,
        role: "progressbar",
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": Math.round(clamped * 100),
        children: jsx("div", {
          style: {
            position: "absolute",
            inset: 0,
            width: (clamped * 100).toFixed(1) + "%",
            background: color,
            borderRadius: "999px",
            transition: "width .2s ease",
          },
        }),
      });
    }

    /** 自绘状态点。 */
    function Dot(props) {
      return jsx("span", {
        "aria-hidden": "true",
        style: {
          display: "inline-block",
          width: "7px",
          height: "7px",
          borderRadius: "50%",
          background: props.color,
          flex: "none",
        },
      });
    }

    /** 自绘表格（primitives 没有 Table）。 */
    function DataTable(props) {
      const columns = Array.isArray(props.columns) ? props.columns : [];
      const rows = Array.isArray(props.rows) ? props.rows : [];
      if (rows.length === 0) {
        return jsx("p", { style: S.hint, children: props.emptyText === undefined ? "—" : props.emptyText });
      }
      return jsx("table", {
        style: S.table,
        children: jsxs("tbody", {
          children: [
            jsx("tr", {
              key: "head",
              children: columns.map((column) =>
                jsx("th", { key: column.key, style: { ...S.th, ...(column.style === undefined ? {} : column.style) }, children: column.title }),
              ),
            }),
            ...rows.map((row, index) =>
              jsx(
                "tr",
                {
                  key: row.__key === undefined ? String(index) : row.__key,
                  children: columns.map((column) =>
                    jsx("td", { key: column.key, style: { ...S.td, ...(column.style === undefined ? {} : column.style) }, children: column.render(row) }),
                  ),
                },
                row.__key === undefined ? String(index) : row.__key,
              ),
            ),
          ],
        }),
      });
    }

    /** 小标签。 */
    function Chip(props) {
      const style = props.tone === "warn" ? S.chipWarn : props.tone === "bad" ? S.chipBad : S.chip;
      return jsx("span", { style: style, children: props.children });
    }

    /** 原始 JSON / 代码块展示（JsonBlock → CodeBlock → pre 三级降级）。 */
    function RawViewer(props) {
      if (JsonBlock !== null && JsonBlock !== undefined) {
        return jsx(JsonBlock, {
          label: props.label,
          payload: props.payload,
          truncatedLabel: (total) => "… 共 " + String(total) + " 行",
        });
      }
      if (CodeBlock !== null && CodeBlock !== undefined) {
        let code = "";
        try {
          code = JSON.stringify(props.payload, null, 2);
        } catch (err) {
          code = String(props.payload);
        }
        try {
          return jsx(CodeBlock, {
            code: code === undefined ? "undefined" : code,
            lang: "json",
            toolbarLabels: { codeLabel: props.label === undefined ? "raw" : props.label, wrapLabel: "wrap", unwrapLabel: "unwrap" },
            className: undefined,
          });
        } catch (err) {
          return jsx("pre", { style: S.pre, children: code === undefined ? "undefined" : code });
        }
      }
      return jsx(FallbackJsonBlock, { label: props.label, payload: props.payload });
    }

    /** 渲染错误兜底：任何渲染异常都不许冒泡到宿主（否则整格失效）。 */
    class PageBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error: error };
      }

      componentDidCatch(error) {
        try {
          console.error("dsh-fingerprint: page crashed", error);
        } catch (err) {
          /* 忽略 */
        }
      }

      render() {
        if (this.state.error !== null && this.state.error !== undefined) {
          return jsxs("div", {
            style: S.noticeBad,
            children: [
              jsx("strong", { key: "t", children: t("pageCrash") }),
              jsx("p", { key: "m", style: S.hint, children: textOf(this.state.error && this.state.error.message ? this.state.error.message : this.state.error) }),
              jsx("pre", { key: "s", style: S.pre, children: textOf(this.state.error && this.state.error.stack ? this.state.error.stack : "") }),
            ],
          });
        }
        return this.props.children;
      }
    }

    /**
     * 真正交给 `main` 槽位的组件（D1 修复）：PageBoundary 包住 FingerprintPage。
     * 宿主通过槽位把 props（kit + injected + ownerProps）交给这一层，这里原样转给页面，
     * 因此页面收到的 props 与直接注册 FingerprintPage 时完全一致。
     * @param {object} props 宿主注入的槽位 props
     * @returns 带错误边界的页面元素
     */
    function FingerprintPanel(props) {
      return jsx(PageBoundary, { children: jsx(FingerprintPage, props) });
    }
    //#endregion

    //#region 主页面
    /**
     * 取某个 target 的明细切片。
     * 契约 §12.8：`/run/<id>/export` 的**权威形状是 `targets[]`** —— 只要 payload 带 targets 数组，
     * 就只在该数组里匹配，不再猜其它形状；其它容器（results[] / runs[] / items[] / 顶层数组 /
     * 单目标顶层）仅作为老版本兜底，且只在 targets 不存在时启用。
     */
    function pickTargetDetail(payload, provider, model) {
      const matches = (entry) => {
        if (entry === null || typeof entry !== "object") return false;
        const p = textOf(entry.provider);
        const m = textOf(entry.model) || textOf(entry.modelId) || textOf(entry.target);
        return (p === "" || p === provider) && m === model;
      };
      const isObject = payload !== null && typeof payload === "object" && !Array.isArray(payload);

      // ── 首选：§12.8 targets[] ────────────────────────────────────────────
      if (isObject && Array.isArray(payload.targets)) {
        for (const entry of payload.targets) {
          if (matches(entry)) return { found: true, scope: "targets", value: entry };
        }
        return { found: false, scope: "targets", value: payload };
      }

      // ── 兜底（仅在 targets 缺失时）：其它容器 / 顶层数组 / 单目标顶层 ──────
      const containers = [];
      if (isObject) {
        for (const key of ["results", "runs", "items"]) {
          if (Array.isArray(payload[key])) containers.push(payload[key]);
        }
      }
      if (Array.isArray(payload)) containers.push(payload);
      for (const list of containers) {
        for (const entry of list) {
          if (matches(entry)) return { found: true, scope: "target", value: entry };
        }
      }
      if (isObject) {
        if (payload.samples !== undefined || payload.challenges !== undefined || payload.analysis !== undefined || payload.aggregate !== undefined) {
          return { found: true, scope: "single", value: payload };
        }
      }
      return { found: false, scope: "none", value: payload };
    }

    /** 从明细里抽取可读的原始回答文本。 */
    function extractRawAnswers(detail) {
      const value = detail === null || detail === undefined ? null : detail.value;
      const out = [];
      if (value === null || typeof value !== "object") return out;
      const rounds = Array.isArray(value.rounds) ? value.rounds : null;
      if (rounds !== null) {
        for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
          const round = rounds[roundIndex];
          // §32.4：被取消的 run 会在 rounds[] 里留空洞（null/undefined 槽位）—— 直接跳过，
          // 既不崩也不产出「第 NaN 轮」。
          if (round === null || round === undefined) continue;
          const samples = safeList(round.samples);
          for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
            const sample = samples[sampleIndex];
            // §12.8：export 的 targets[].rounds[] 不带 index 字段，轮次号用数组下标 +1；
            // rawText 是「原始回答」的主路径，text / error 依次兜底。
            const declared = Number(round.index);
            const roundNo = Number.isFinite(declared) ? declared + 1 : roundIndex + 1;
            out.push({
              label: "第 " + String(roundNo) + " 轮 / " + (textOf(sample.challengeId) || "sample " + String(sampleIndex + 1)),
              text: textOf(sample.rawText) || textOf(sample.text) || textOf(sample.error),
              state: textOf(sample.state),
            });
          }
        }
      }
      const samples = safeList(value.samples);
      for (const sample of samples) {
        out.push({
          label: textOf(sample.challengeId) || "sample",
          text: textOf(sample.rawText) || textOf(sample.text) || textOf(sample.error),
          state: textOf(sample.state),
        });
      }
      return out;
    }

    /** 整页组件。 */
    function FingerprintPage(props) {
      const injectedT = props !== null && props !== undefined && typeof props.t === "function" ? props.t : null;
      const tt = useCallback(
        (key, params) => {
          if (injectedT !== null) {
            try {
              const text = injectedT(key, params);
              if (typeof text === "string" && text.length > 0 && text !== key) return text;
            } catch (err) {
              /* 忽略，走内置字典 */
            }
          }
          return t(key, params);
        },
        [injectedT],
      );

      // ── 目标数据 ────────────────────────────────────────────────────────
      const [targets, setTargets] = useState({ status: "loading", providers: [], detector: null, error: null, unready: null });
      const [refreshing, setRefreshing] = useState(false);
      // ── 选择 ────────────────────────────────────────────────────────────
      const [selected, setSelected] = useState({});
      const [query, setQuery] = useState("");
      const [openGroups, setOpenGroups] = useState({});
      // ── 参数 ────────────────────────────────────────────────────────────
      const [roundsText, setRoundsText] = useState(String(ROUNDS.def));
      const [countText, setCountText] = useState(String(CHALLENGE_COUNT.def));
      const [parallelText, setParallelText] = useState(String(PARALLEL.def));
      const [timeoutText, setTimeoutText] = useState(String(TIMEOUT_SEC.def));
      const [strict, setStrict] = useState(false);
      const [advancedOpen, setAdvancedOpen] = useState(false);
      // ── 运行 ────────────────────────────────────────────────────────────
      const [runId, setRunId] = useState(null);
      const [actionError, setActionError] = useState(null);
      const [actionNote, setActionNote] = useState(null);
      const [starting, setStarting] = useState(false);
      const [expanded, setExpanded] = useState({});
      const [detailCache, setDetailCache] = useState({ status: "none", payload: null, error: null });
      // ── 视图 / 历史（契约 §29.6）─────────────────────────────────────────
      /** 当前视图：'detect' | 'history'。 */
      const [tab, setTab] = useState("detect");
      /** 聚合表数据（/history/models）。 */
      const [history, setHistory] = useState({ status: "idle", models: [], stats: null, error: null });
      const [historyQuery, setHistoryQuery] = useState("");
      /** 每个模型展开后的明细（懒加载，key = provider\u0000model）。 */
      const [historyDetail, setHistoryDetail] = useState({});
      const [historyNotice, setHistoryNotice] = useState(null);
      /** 「清空历史」二次确认。 */
      const [confirmClear, setConfirmClear] = useState(false);

      /**
       * 最近一次从宿主看到的 activeRunId（§28.3）。
       * 用 ref 而不是 state：它不参与渲染（横幅由 runId + phase 驱动），
       * 这样也不会改变上面的 hook 顺序。
       */
      const serverActiveRunIdRef = useRef(null);

      /** 接上一个正在运行的任务：统一入口，保证展开态/明细缓存被重置。 */
      const attachRun = useCallback((nextRunId, noteKey) => {
        setExpanded({});
        setDetailCache({ status: "none", payload: null, error: null });
        setActionError(null);
        setRunId(nextRunId);
        if (noteKey !== undefined) setActionNote(tt(noteKey));
      }, [tt]);

      const feedState = useRunFeed(runId);
      const snapshot = feedState.snapshot;

      // ── 历史（契约 §29.6）：3 条冻结路由，全部容忍「接口未就绪」────────────────
      /** 形状容错：`{ok:true, models:[...]}` / `{ok:true, records:[...]}` / 裸数组（§29.5 旧形状）。 */
      function pickList(payload, key) {
        if (Array.isArray(payload)) return payload;
        if (payload !== null && typeof payload === "object" && Array.isArray(payload[key])) return payload[key];
        return [];
      }

      /** 拉聚合表：/history/models（切到历史页时调用 —— 不做长缓存）。 */
      const loadHistory = useCallback(async () => {
        setHistory((prev) => ({ ...prev, status: prev.models.length > 0 ? "refreshing" : "loading", error: null }));
        const result = await requestJson("/history/models");
        if (!result.ok) {
          setHistory({ status: result.kind === "unready" ? "unready" : "error", models: [], stats: null, error: result.message });
          return;
        }
        const stats = Array.isArray(result.data) ? null : result.data.stats === undefined ? null : result.data.stats;
        setHistory({ status: "ready", models: pickList(result.data, "models"), stats: stats, error: null });
      }, []);

      /** 展开某个模型的最近记录：/history?limit=20&provider=&model=。 */
      const loadHistoryDetail = useCallback(async (provider, model, key) => {
        setHistoryDetail((prev) => ({ ...prev, [key]: { status: "loading", records: [], stats: null, statsError: "", error: null } }));
        const query = "?limit=20&provider=" + encodeURIComponent(provider) + "&model=" + encodeURIComponent(model);
        const result = await requestJson("/history" + query);
        if (!result.ok) {
          setHistoryDetail((prev) => ({ ...prev, [key]: { status: "error", records: [], stats: null, statsError: "", error: result.message } }));
          return;
        }
        // ⚠️ /history 也带 stats（父任务更正 3）：error 非空必须显式提示，
        // 否则「读失败」会被看成「这个模型没有记录」。records.length 才是**当前列表条数**。
        const stats = Array.isArray(result.data) ? null : result.data.stats === undefined ? null : result.data.stats;
        const statsError = stats === null ? "" : textOf(stats.error);
        setHistoryDetail((prev) => ({ ...prev, [key]: { status: "ready", records: pickList(result.data, "records"), stats: stats, statsError: statsError, error: null } }));
      }, []);

      /** 清空历史（POST /history/clear）。 */
      const clearHistory = useCallback(async () => {
        setConfirmClear(false);
        setHistoryNotice(null);
        const result = await requestJson("/history/clear", { method: "POST", body: {} });
        if (!result.ok) {
          setHistoryNotice(tt("historyClearFailed", { reason: result.message }));
          return;
        }
        const removed = result.data === null || result.data === undefined ? null : result.data.removed;
        setHistoryNotice(tt("historyCleared", { n: formatNumber(removed) }));
        setHistoryDetail({});
        await loadHistory();
      }, [loadHistory, tt]);

      /** 切到历史页就刷新一次（§29.6：不要长缓存）。 */
      useEffect(() => {
        if (tab !== "history") return;
        void loadHistory();
      }, [tab, loadHistory]);

      /** 展开/收起某模型明细（首次展开才拉数据）。 */
      const toggleHistoryDetail = useCallback((provider, model, key) => {
        const isOpen = historyDetail[key] !== undefined && historyDetail[key].status !== "closed";
        if (isOpen) {
          setHistoryDetail((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
          return;
        }
        void loadHistoryDetail(provider, model, key);
      }, [historyDetail, loadHistoryDetail]);

      /** 拉 targets + status（两个都容错）。 */
      const loadTargets = useCallback(async () => {
        setTargets((prev) => ({ ...prev, status: prev.providers.length > 0 ? "refreshing" : "loading", error: null, unready: null }));
        const results = await Promise.all([requestJson("/targets"), requestJson("/status")]);
        const targetsResult = results[0];
        const statusResult = results[1];
        const detector = targetsResult.ok
          ? targetsResult.data.detector === undefined
            ? null
            : targetsResult.data.detector
          : statusResult.ok
            ? statusResult.data.detector
            : null;
        // §28.3：/status 的 activeRunId 可能缺失（旧形状）⇒ 正向判定，缺失即 null（不报错）
        const activeRunId = statusResult.ok ? pickRunId(statusResult.data.activeRunId) : null;
        serverActiveRunIdRef.current = activeRunId;
        if (targetsResult.ok) {
          setTargets({
            status: "ready",
            providers: Array.isArray(targetsResult.data.providers) ? targetsResult.data.providers : [],
            detector: detector,
            error: null,
            unready: null,
          });
          return;
        }
        setTargets({
          status: targetsResult.kind === "unready" ? "unready" : "error",
          providers: [],
          detector: detector,
          error: targetsResult.message,
          unready: { path: "/fingerprint/targets", reason: targetsResult.message },
        });
      }, []);

      useEffect(() => {
        void loadTargets();
      }, [loadTargets]);

      /**
       * 挂载时从 /status 恢复正在运行的任务（§28.3）。
       * 刷新页面 / 重开面板都能接上；只在本地还没有 runId 时接管，不抢用户当前正在看的任务。
       */
      useEffect(() => {
        if (runId !== null && runId !== "") return;
        if (targets.status !== "ready" && targets.status !== "refreshing") return;
        const active = pickRunId(serverActiveRunIdRef.current);
        if (active !== null) attachRun(active, "attached");
      }, [targets.status, runId, attachRun]);

      /**
       * 空闲期轮询：本地没有 runId 时每 IDLE_POLL_MS 探一次 /status，
       * 一旦出现 activeRunId 就接上 —— 彻底消灭「有任务在跑但界面看不见」这一整类问题。
       */
      useEffect(() => {
        if (runId !== null && runId !== "") return undefined;
        let disposed = false;
        const tick = async () => {
          const result = await requestJson("/status");
          if (disposed || !result.ok) return; // 空闲轮询失败静默：不打扰用户、不写错误态
          const active = pickRunId(result.data.activeRunId);
          serverActiveRunIdRef.current = active;
          if (active !== null) attachRun(active, "attached");
        };
        const timer = setInterval(() => {
          void tick();
        }, IDLE_POLL_MS);
        return () => {
          disposed = true;
          clearInterval(timer);
        };
      }, [runId, attachRun]);

      const rows = useMemo(() => flattenRows(targets.providers), [targets.providers]);

      const loweredQuery = query.trim().toLowerCase();
      const matchedRows = useMemo(() => {
        if (loweredQuery.length === 0) return rows;
        return rows.filter((row) => {
          const id = textOf(row.model.id).toLowerCase();
          const name = textOf(row.model.name).toLowerCase();
          return id.includes(loweredQuery) || name.includes(loweredQuery);
        });
      }, [rows, loweredQuery]);

      /** 已启用适配器的行（可勾选候选）。 */
      const enabledMatchedRows = useMemo(() => matchedRows.filter((row) => !isDormantProvider(row.providerInfo)), [matchedRows]);

      /** 休眠目录项（§12.5：默认折叠的「未启用（N）」分组，复选框禁用）。 */
      const dormantMatchedRows = useMemo(() => matchedRows.filter((row) => isDormantProvider(row.providerInfo)), [matchedRows]);

      const selectableRows = useMemo(() => enabledMatchedRows.filter((row) => rowDisabledReason(row.providerInfo) === null), [enabledMatchedRows]);

      /** 全量可选行：用于「已选 n / total」的分母 —— 选择集本来就是全量的，分母也必须全量，否则会出现 n > total。 */
      const allSelectableRows = useMemo(() => rows.filter((row) => rowDisabledReason(row.providerInfo) === null), [rows]);

      const selectedRows = useMemo(() => rows.filter((row) => selected[row.key] === true && rowDisabledReason(row.providerInfo) === null), [rows, selected]);

      const groupedMatches = useMemo(() => groupRowsByProvider(enabledMatchedRows), [enabledMatchedRows]);

      const dormantGroups = useMemo(() => groupRowsByProvider(dormantMatchedRows), [dormantMatchedRows]);

      // ── 参数解析 ────────────────────────────────────────────────────────
      const rounds = clampInt(roundsText, ROUNDS.min, ROUNDS.max, ROUNDS.def);
      const rawCount = clampInt(countText, CHALLENGE_COUNT.min, CHALLENGE_COUNT.max, CHALLENGE_COUNT.def);
      const count = strict ? STRICT_COUNT : rawCount;
      const parallel = clampInt(parallelText, PARALLEL.min, PARALLEL.max, PARALLEL.def);
      const timeoutSec = clampInt(timeoutText, TIMEOUT_SEC.min, TIMEOUT_SEC.max, TIMEOUT_SEC.def);
      const expectedRequests = selectedRows.length * rounds * count;
      /**
       * §33.3 裁决 4：在飞请求数的**精确封顶**。
       * W7 把队列改成按 (目标 × 轮次) 展平后，能同时在跑的轮次数 = min(parallel, 目标数 × 轮次数)，
       * 每轮内部 count 个挑战全并发 ⇒ 在飞 = min(parallel, targets × rounds) × count。
       */
      const roundSlots = selectedRows.length * rounds;
      const inflightRequests = Math.min(parallel, roundSlots) * count;

      const toggleRow = useCallback((key) => {
        setSelected((prev) => {
          const next = { ...prev };
          if (next[key] === true) delete next[key];
          else next[key] = true;
          return next;
        });
      }, []);

      const setGroup = useCallback((provider, value) => {
        setSelected((prev) => {
          const next = { ...prev };
          for (const row of rows) {
            if (row.provider !== provider) continue;
            if (rowDisabledReason(row.providerInfo) !== null) continue;
            if (value) next[row.key] = true;
            else delete next[row.key];
          }
          return next;
        });
      }, [rows]);

      const selectAllMatched = useCallback(() => {
        setSelected((prev) => {
          const next = { ...prev };
          for (const row of selectableRows) next[row.key] = true;
          return next;
        });
      }, [selectableRows]);

      const clearAll = useCallback(() => {
        setSelected({});
      }, []);

      // ── 动作 ────────────────────────────────────────────────────────────
      const startRun = useCallback(async () => {
        setActionError(null);
        setActionNote(null);
        if (selectedRows.length === 0) {
          setActionError({ message: tt("needSelection") });
          return;
        }
        setStarting(true);
        const body = {
          targets: selectedRows.map((row) => ({ provider: row.provider, model: textOf(row.model.id) || textOf(row.model.name) })),
          rounds: rounds,
          count: count,
          parallel: parallel,
          strict: strict,
          timeoutSec: timeoutSec,
          gapSec: 0,
        };
        const result = await requestJson("/run", { method: "POST", body: body });
        setStarting(false);
        if (!result.ok) {
          if (result.code === "BUSY") {
            // §28.3：BUSY 不是终点 —— 优先用结构化 error.runId，其次回退查 /status 的 activeRunId，
            // 接上正在跑的任务并明确告知用户「已接上」，而不是只丢一句报错把人卡死。
            let recovered = pickRunId(result.runId);
            if (recovered === null) {
              const statusResult = await requestJson("/status");
              recovered = statusResult.ok ? pickRunId(statusResult.data.activeRunId) : null;
              serverActiveRunIdRef.current = recovered;
            } else {
              serverActiveRunIdRef.current = recovered;
            }
            if (recovered !== null) {
              attachRun(recovered, "attached");
              return;
            }
            // 两条路都拿不到（旧形状 / 宿主未重组合）⇒ 退回原有行为，不得报错
            setActionError({ message: tt("busy") });
            return;
          }
          setActionError({ message: result.message, raw: result.raw === undefined ? undefined : result.raw });
          return;
        }
        const nextRunId = pickRunId(result.data.runId);
        if (nextRunId === null) {
          setActionError({ message: "宿主未返回 runId" });
          return;
        }
        serverActiveRunIdRef.current = nextRunId;
        attachRun(nextRunId);
      }, [selectedRows, rounds, count, parallel, strict, timeoutSec, tt, attachRun]);

      const cancelRun = useCallback(async () => {
        setActionError(null);
        if (runId === null || runId === "") return;
        const result = await requestJson("/cancel", { method: "POST", body: { runId: runId } });
        if (!result.ok) {
          setActionError({ message: tt("cancelFailed") + "：" + result.message });
          return;
        }
        setActionNote(tt("cancelled"));
      }, [runId, tt]);

      /** 明细请求的在飞守卫：React updater 可能被重复调用，光靠 detailCache.status 闭包值挡不住同步重入。 */
      const detailInFlight = useRef(false);

      const loadDetail = useCallback(async () => {
        if (runId === null || runId === "") return;
        if (detailInFlight.current) return;
        if (detailCache.status === "loading") return;
        if (detailCache.status === "ready") return;
        detailInFlight.current = true;
        setDetailCache({ status: "loading", payload: null, error: null });
        try {
          const result = await requestJson("/run/" + encodeURIComponent(runId) + "/export");
          if (!result.ok) {
            setDetailCache({ status: "error", payload: null, error: result.message });
            return;
          }
          setDetailCache({ status: "ready", payload: result.data, error: null });
        } finally {
          detailInFlight.current = false;
        }
      }, [runId, detailCache.status]);

      /**
       * 展开/收起明细。
       * ⚠️ 副作用（loadDetail）**必须留在 updater 之外**：React 允许重复调用 updater，
       * 放在里面会在重复调用时发出两次 /export，违反「updater 必须纯」。
       */
      const toggleDetail = useCallback((key) => {
        const nowOpen = expanded[key] !== true;
        setExpanded((prev) => ({ ...prev, [key]: nowOpen }));
        if (nowOpen) void loadDetail();
      }, [expanded, loadDetail]);

      const exportRun = useCallback(async () => {
        setActionError(null);
        let payload = snapshot;
        let usedFallback = false;
        if (runId !== null && runId !== "") {
          const result = await requestJson("/run/" + encodeURIComponent(runId) + "/export");
          if (result.ok) payload = result.data;
          else usedFallback = true;
        } else {
          usedFallback = true;
        }
        const name = "fingerprint-" + (runId === null ? "draft" : runId) + ".json";
        const ok = downloadJson(name, payload === null || payload === undefined ? {} : payload);
        if (!ok) {
          setActionError({ message: tt("exportFailed") });
          return;
        }
        if (usedFallback) setActionNote(tt("exportFailed"));
        else setActionNote(tt("exported", { name: name }));
      }, [runId, snapshot, tt]);

      const refreshDetector = useCallback(async () => {
        setRefreshing(true);
        const result = await requestJson("/detector/refresh", { method: "POST", body: {} });
        setRefreshing(false);
        if (!result.ok) {
          setActionError({ message: "重载检测器失败：" + result.message });
          return;
        }
        setActionNote("检测器已重载（参考模型 " + textOf(result.data.bankModelCount) + "）");
        await loadTargets();
      }, [loadTargets]);

      // ── 派生展示数据 ────────────────────────────────────────────────────
      const detector = targets.detector;
      // §32.4：tasks / results 里可能有空洞（取消的 run）⇒ 先滤掉再渲染，绝不空指针。
      const tasks = snapshot !== null ? safeList(snapshot.tasks) : [];
      const results = snapshot !== null ? safeList(snapshot.results) : [];
      const phase = snapshot === null ? "idle" : textOf(snapshot.phase) || "running";
      /**
       * §28.3：只要有 runId 且未终态，就一直显示「运行中」横幅（含取消 / 导出），
       * 不依赖"用户是否刚点过开始" —— 这样刷新页面、被 BUSY 挡回、或空闲轮询接上的任务都看得见。
       */
      const running = runId !== null && runId !== "" && !isTerminalPhase(phase);
      /** 当前是否检测视图；历史视图下把检测区整体隐藏（DOM 保留，run 视图不中断）。 */
      const showDetect = tab !== "history";

      const errorByTarget = useMemo(() => {
        const map = new Map();
        for (const task of tasks) {
          const key = targetKey(textOf(task.provider), textOf(task.model));
          const error = textOf(task.error);
          if (error.length > 0) map.set(key, error);
        }
        return map;
      }, [tasks]);

      const totalTaskSlots = tasks.length === 0 ? selectedRows.length * rounds : tasks.length;
      const finishedTaskSlots = tasks.filter((task) => {
        const state = textOf(task.state);
        return state === "complete" || state === "truncated" || state === "failed";
      }).length;

      /** 渲染一个模型行。 */
      function renderModelRow(row) {
        const disabledReason = rowDisabledReason(row.providerInfo);
        const cred = credentialState(row.providerInfo);
        const rawInput = row.model.input;
        const modalities = Array.isArray(rawInput) ? rawInput.filter((item) => typeof item === "string" && item.length > 0) : [];
        // §14.5：input 为 null（或空数组）＝ 模态未知 —— 显示「未知」，绝不 (input||[]).join() 变成空串
        const inputText = modalities.length > 0 ? modalities.join("+") : tt("inputUnknown");
        const sourceText = textOf(row.model.source);
        const checkbox = jsx(Checkbox, {
          checked: selected[row.key] === true,
          disabled: disabledReason !== null,
          onChange: () => toggleRow(row.key),
          label: undefined,
        });
        const rowNode = jsxs("div", {
          style: S.modelRow,
          children: [
            jsx("span", { key: "box", style: { display: "inline-flex" }, children: checkbox }),
            jsx("span", {
              key: "name",
              style: { minWidth: 0, wordBreak: "break-all", opacity: disabledReason === null ? 1 : 0.55 },
              children: textOf(row.model.name) || textOf(row.model.id),
            }),
            textOf(row.model.id) !== textOf(row.model.name)
              ? jsx("span", { key: "id", style: S.code, children: textOf(row.model.id) })
              : null,
            jsx("span", {
              key: "input",
              style: S.chip,
              children: tt("inputLabel") + ": " + inputText,
            }),
            jsx("span", {
              key: "window",
              style: S.chip,
              // §14.5：catalog 行的 contextWindow / maxTokens 为 null → 渲染成 —，绝不显示 0 或 undefined
              children: tt("ctxLabel") + " " + formatCount(row.model.contextWindow) + " · " + tt("outLabel") + " " + formatCount(row.model.maxTokens),
            }),
            sourceText === "catalog" ? jsx("span", { key: "src", style: S.chip, children: tt("sourceCatalog") }) : null,
            // §14.3 / §24.3：credentialAvailable === null 时显示说明，**不置灰**；临时故障用 warn 色区分
            cred.kind === "info" ? jsx("span", { key: "credinfo", style: cred.tone === "warn" ? S.chipWarn : S.chip, children: cred.text }) : null,
            row.providerInfo !== null && row.providerInfo !== undefined && row.providerInfo.dormant === true
              ? jsx("span", { key: "dormant", style: S.chipWarn, children: tt("dormantTag") })
              : null,
            disabledReason !== null ? jsx("span", { key: "off", style: S.chipBad, children: disabledReason }) : null,
          ],
        });
        return jsx(
          Tooltip,
          {
            label: disabledReason === null ? undefined : disabledReason,
            disabled: disabledReason === null,
            children: rowNode,
          },
          row.key,
        );
      }

      /** 渲染一个 provider 分组（可折叠）。 */
      function renderProviderGroup(provider, providerRows) {
        const info = providerRows.length > 0 ? providerRows[0].providerInfo : null;
        const disabledReason = rowDisabledReason(info);
        const openFromState = openGroups[provider];
        const searching = loweredQuery.length > 0;
        const open = searching ? true : openFromState === undefined ? true : openFromState === true;
        const selectedInGroup = providerRows.filter((row) => selected[row.key] === true).length;
        const head = jsxs("div", {
          style: S.groupHead,
          children: [
            jsx("span", { key: "name", style: S.groupTitle, children: textOf(info && info.displayName ? info.displayName : provider) }),
            textOf(info && info.api).length > 0 ? jsx("span", { key: "api", style: S.code, children: textOf(info.api) }) : null,
            textOf(info && info.baseURL).length > 0 ? jsx("span", { key: "base", style: S.code, children: textOf(info.baseURL) }) : null,
            textOf(info && info.credentialRef).length > 0
              ? jsx("span", { key: "cred", style: S.code, children: textOf(info.credentialRef) })
              : null,
            // §14.3 / §24.3：无法判定时说明原因，且**不置灰**
            credentialState(info).kind === "info"
              ? jsx("span", { key: "credinfo", style: credentialState(info).tone === "warn" ? S.chipWarn : S.chip, children: credentialState(info).text })
              : null,
            disabledReason !== null ? jsx("span", { key: "off", style: S.chipBad, children: disabledReason }) : null,
            jsx("span", { key: "sel", style: S.chip, children: String(selectedInGroup) + "/" + String(providerRows.length) }),
            jsx("span", {
              key: "acts",
              style: { marginLeft: "auto", display: "inline-flex", gap: "6px" },
              children: [
                jsx(
                  Button,
                  {
                    key: "all",
                    disabled: disabledReason !== null,
                    onClick: () => setGroup(provider, true),
                    children: tt("groupSelectAll"),
                  },
                  "all",
                ),
                jsx(
                  Button,
                  { key: "none", onClick: () => setGroup(provider, false), children: tt("groupSelectNone") },
                  "none",
                ),
              ],
            }),
          ],
        });
        return jsxs(
          "div",
          {
            style: { margin: "8px 0 0", minWidth: 0 },
            children: [
              jsx("div", { key: "head", children: head }),
              jsxs(
                DisclosureRow,
                {
                  key: "body",
                  title: textOf(provider) + " · " + String(providerRows.length) + " 个模型",
                  open: open,
                  expandable: !searching,
                  expandOnRowClick: true,
                  onToggle: () =>
                    setOpenGroups((prev) => ({ ...prev, [provider]: !(prev[provider] === undefined ? true : prev[provider] === true) })),
                  collapsedContent: searching ? "搜索匹配" : undefined,
                  children: providerRows.map((row) => renderModelRow(row)),
                },
                "disc",
              ),
            ],
          },
          provider,
        );
      }

      /**
       * 渲染「未启用（N）」分组（契约 §12.5）。
       * - 默认折叠（openGroups 里没有该键时为 false）
       * - 内部按 provider 分段，每段标题带 api / 休眠 chip / 模型数
       * - 每行复选框由 rowDisabledReason 置为 disabled，并注明「该 provider 未启用适配器，无法检测」
       * - 搜索命中时自动展开（便于看清为什么都不可勾），但绝不变成可勾选
       */
      function renderDormantGroup(groups) {
        const groupKey = "__dormant__";
        const searching = loweredQuery.length > 0;
        const open = searching ? true : openGroups[groupKey] === true;
        return jsxs(
          "div",
          {
            style: { margin: "14px 0 0", paddingTop: "10px", borderTop: "1px solid " + COLOR.border, minWidth: 0 },
            children: [
              jsxs(
                DisclosureRow,
                {
                  key: "dormant-body",
                  title: tt("dormantGroup", { n: groups.size }),
                  open: open,
                  expandable: true,
                  expandOnRowClick: true,
                  onToggle: () =>
                    setOpenGroups((prev) => ({ ...prev, [groupKey]: !(prev[groupKey] === true) })),
                  collapsedContent: tt("dormantReason"),
                  children: Array.from(groups.entries()).map(([provider, providerRows]) => {
                    const info = providerRows.length > 0 ? providerRows[0].providerInfo : null;
                    return jsxs(
                      "div",
                      {
                        key: provider,
                        style: { margin: "8px 0 0", minWidth: 0 },
                        children: [
                          jsxs("div", {
                            key: "head",
                            style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", padding: "4px 0 2px" },
                            children: [
                              jsx("span", { key: "name", style: { fontWeight: 600, fontSize: ".92em" }, children: textOf(info && info.displayName ? info.displayName : provider) }),
                              textOf(info && info.api).length > 0 ? jsx("span", { key: "api", style: S.code, children: textOf(info.api) }) : null,
                              jsx("span", { key: "tag", style: S.chipWarn, children: tt("dormantTag") }),
                              jsx("span", { key: "n", style: S.chip, children: String(providerRows.length) + " 个模型" }),
                            ],
                          }),
                          ...providerRows.map((row) => renderModelRow(row)),
                        ],
                      },
                      provider,
                    );
                  }),
                },
                "dormant-disc",
              ),
            ],
          },
          "dormant-group",
        );
      }

      // ── 结果表 ──────────────────────────────────────────────────────────
      const resultRows = results.map((entry) => {
        const aggregate = entry === null || entry === undefined ? null : entry.aggregate;
        const provider = textOf(entry && entry.provider);
        const model = textOf(entry && entry.model);
        const key = targetKey(provider, model);
        return {
          __key: key,
          provider: provider,
          model: model,
          aggregate: aggregate,
          error: errorByTarget.get(key) === undefined ? textOf(aggregate && aggregate.error) : errorByTarget.get(key),
        };
      });

      const resultColumns = [
        {
          key: "model",
          title: tt("colModel"),
          render: (row) => jsxs("span", { children: [jsx("span", { children: row.model }), jsx("span", { style: S.code, children: " @" + row.provider })] }),
        },
        {
          key: "top1",
          title: tt("colTop1"),
          render: (row) => {
            const aggregate = row.aggregate;
            const top1 = pickText(aggregate ? aggregate.predictionName : null, aggregate ? aggregate.prediction : null);
            return jsx("span", { children: top1 === null ? tt("noRank") : top1 });
          },
        },
        {
          key: "family",
          title: tt("colFamily"),
          render: (row) => {
            const aggregate = row.aggregate;
            const family = pickText(aggregate ? aggregate.familyName : null, aggregate ? aggregate.family : null);
            return jsx("span", { children: family === null ? "—" : family });
          },
        },
        {
          key: "confidence",
          title: tt("colConfidence"),
          render: (row) => jsx("span", { children: formatProbability(row.aggregate ? row.aggregate.confidence : null) }),
        },
        {
          key: "agreement",
          title: tt("colAgreement"),
          // 契约 §9.4：agreement = 胜者得票 / validRounds；为 null（有效回合 0）时显示 —。
          render: (row) => jsx("span", { children: formatProbability(row.aggregate ? row.aggregate.agreement : null) }),
        },
        {
          key: "validRounds",
          title: tt("colValidRounds"),
          // 契约 §9.4：必须同时给出 validRounds / totalRounds，让用户知道多少回合真的算数。
          render: (row) =>
            row.aggregate === null || row.aggregate === undefined
              ? jsx("span", { children: "—" })
              : jsxs("span", {
                  children: [
                    jsx("b", { children: formatNumber(row.aggregate.validRounds) }),
                    jsx("span", { style: S.code, children: " / " + textOf(row.aggregate.totalRounds) }),
                  ],
                }),
        },
        {
          key: "stability",
          title: tt("colStability"),
          render: (row) => {
            const stability = textOf(row.aggregate && row.aggregate.stability);
            if (stability === "stable") return jsx("span", { style: { color: COLOR.ok }, children: tt("stabilityStable") });
            if (stability === "unstable") return jsx("span", { style: { color: COLOR.warn }, children: tt("stabilityUnstable") });
            if (stability === "inconclusive") return jsx("span", { style: { color: COLOR.mute }, children: tt("stabilityInconclusive") });
            return jsx("span", { children: "—" });
          },
        },
        {
          key: "decision",
          title: tt("colDecision"),
          render: (row) => {
            const decision = textOf(row.aggregate && row.aggregate.decision);
            const label =
              decision === "scored" ? tt("decisionScored") : decision === "partial" ? tt("decisionPartial") : decision === "unscorable" ? tt("decisionUnscorable") : decision;
            const color = decision === "scored" ? COLOR.ok : decision === "partial" ? COLOR.warn : COLOR.mute;
            return jsx("span", { style: { color: color }, children: label.length > 0 ? label : "—" });
          },
        },
        {
          key: "error",
          title: tt("colError"),
          render: (row) =>
            row.error !== null && row.error !== undefined && textOf(row.error).length > 0
              ? jsx("span", { style: { color: COLOR.bad }, children: textOf(row.error) })
              : jsx("span", { children: "—" }),
        },
      ];

      /** 某个目标的结果明细（展开区）。 */
      function renderDetail(row) {
        const aggregate = row.aggregate;
        // §32.4：ranking / perRound 同样先滤空洞 —— 否则 ranking 里的 null 会被当对象解引用、
        // perRound 里的空洞会渲染成「第 NaN 轮」。
        const ranking = aggregate !== null ? safeList(aggregate.ranking).slice(0, TOP_RANKING) : [];
        const perRound = aggregate !== null ? safeList(aggregate.perRound) : [];
        const detailSlice = detailCache.status === "ready" ? pickTargetDetail(detailCache.payload, row.provider, row.model) : null;
        const rawAnswers = detailSlice !== null && detailSlice.found ? extractRawAnswers(detailSlice) : [];
        return jsxs(
          "div",
          {
            style: { padding: "8px 0 4px", display: "flex", flexDirection: "column", gap: "10px" },
            children: [
              jsxs("div", {
                key: "rank",
                children: [
                  jsx("p", { style: S.hint, children: tt("rankingTitle", { n: ranking.length }) }),
                  jsx(DataTable, {
                    emptyText: "—",
                    columns: [
                      { key: "rank", title: tt("colRank"), render: (item) => String(item.__rank) },
                      { key: "model", title: tt("colModel"), render: (item) => jsx("span", { children: pickText(item.displayName, item.model) || textOf(item.model) }) },
                      { key: "family", title: tt("colFamily"), render: (item) => jsx("span", { children: pickText(item.familyName, item.family) || "—" }) },
                      { key: "votes", title: tt("colVotes"), render: (item) => formatNumber(item.votes) },
                      { key: "meanRank", title: tt("colMeanRank"), render: (item) => (Number.isFinite(item.meanRank) ? item.meanRank.toFixed(2) : "—") },
                      { key: "score", title: tt("colScore"), render: (item) => (Number.isFinite(item.score) ? item.score.toFixed(4) : "—") },
                      { key: "probability", title: tt("colProb"), render: (item) => formatProbability(item.probability) },
                    ],
                    rows: ranking.map((item, index) => ({ __key: textOf(item.model) + String(index), __rank: index + 1, ...item })),
                  }),
                ],
              }),
              jsxs("div", {
                key: "rounds",
                children: [
                  jsx("p", { style: S.hint, children: tt("perRoundTitle") }),
                  jsx(DataTable, {
                    emptyText: "—",
                    columns: [
                      {
                        key: "index",
                        title: tt("colRound"),
                        // §32.4：index 缺失/非数值时退回**数组位置**，绝不渲染「第 NaN 轮」。
                        render: (item) => {
                          const declared = Number(item.index);
                          const roundNo = Number.isFinite(declared) ? declared + 1 : item.__position;
                          return "第 " + String(roundNo) + " 轮";
                        },
                      },
                      { key: "decision", title: tt("colRoundDecision"), render: (item) => textOf(item.decision) || "—" },
                      {
                        key: "prediction",
                        title: tt("colTop1"),
                        // 契约 §9.2：perRound 的 prediction 是 SDK 原样透传，无排名时可能是空串。
                        render: (item) => {
                          const top1 = pickText(item.predictionName, item.prediction);
                          return jsx("span", { children: top1 === null ? tt("noRank") : top1 });
                        },
                      },
                      { key: "probability", title: tt("colRoundProb"), render: (item) => formatProbability(item.probability) },
                      { key: "error", title: tt("colError"), render: (item) => (textOf(item.error).length > 0 ? jsx("span", { style: { color: COLOR.bad }, children: textOf(item.error) }) : "—") },
                    ],
                    rows: perRound.map((item, index) => ({ __key: String(index), __position: index + 1, ...item })),
                  }),
                ],
              }),
              jsxs("div", {
                key: "raw",
                children: [
                  jsx("p", { style: S.hint, children: tt("rawTitle") }),
                  detailCache.status === "loading" ? jsx("p", { style: S.hint, children: tt("detailLoading") }) : null,
                  detailCache.status === "error"
                    ? jsx("p", { style: { ...S.hint, color: COLOR.bad }, children: tt("detailFailed") + "：" + textOf(detailCache.error) })
                    : null,
                  rawAnswers.length > 0
                    ? jsx(DataTable, {
                        emptyText: "—",
                        columns: [
                          { key: "label", title: "sample", render: (item) => textOf(item.label) },
                          { key: "state", title: tt("colState"), render: (item) => textOf(item.state) || "—" },
                          {
                            key: "text",
                            title: tt("colRawText"),
                            render: (item) => jsx("pre", { style: { ...S.pre, maxHeight: "160px", margin: 0 }, children: item.text.slice(0, 4000) }),
                          },
                        ],
                        rows: rawAnswers.map((item, index) => ({ __key: String(index), ...item })),
                      })
                    : null,
                  detailCache.status === "ready"
                    ? jsx(RawViewer, {
                        label: detailSlice !== null && detailSlice.found ? "export / " + row.model : "export（未匹配到该目标，展示完整体）",
                        payload: detailSlice !== null && detailSlice.found ? detailSlice.value : detailCache.payload,
                      })
                    : null,
                ],
              }),
            ],
          },
          "detail",
        );
      }

      // ── 历史页（契约 §29.6）─────────────────────────────────────────────
      /** 聚合表里某个模型的明细行（最近 N 条）。 */
      function renderHistoryDetail(provider, model, key) {
        const entry = historyDetail[key];
        if (entry === undefined) return null;
        if (entry.status === "loading") return jsx("p", { style: S.hint, children: tt("detailLoading") });
        if (entry.status === "error") {
          return jsx("p", { style: { ...S.hint, color: COLOR.bad }, children: tt("interfaceError") + "：" + textOf(entry.error) });
        }
        const records = safeList(entry.records);
        const detailStatsError = textOf(entry.statsError);
        return jsxs("div", {
          children: [
            // 父任务更正 3：/history 的 stats.error 非空 ⇒ 必须显式提示，不得显示成「暂无明细记录」
            detailStatsError.length > 0
              ? jsx("div", { key: "stats-error", style: S.noticeBad, children: tt("historyLoadFailed", { reason: detailStatsError }) })
              : null,
            jsx("p", { key: "t", style: S.hint, children: tt("historyDetailTitle", { n: records.length }) }),
            jsx(DataTable, {
              key: "table",
              // records.length === 0 且 stats.error 非空时不要谎报「暂无记录」
              emptyText: detailStatsError.length > 0 ? tt("interfaceError") : tt("historyDetailEmpty"),
              columns: [
                { key: "ts", title: tt("colWhen"), render: (row) => formatWhen(row.ts) },
                {
                  key: "decision",
                  title: tt("colDecision"),
                  render: (row) => {
                    const decision = textOf(row.decision);
                    const label =
                      decision === "scored" ? tt("decisionScored") : decision === "partial" ? tt("decisionPartial") : decision === "unscorable" ? tt("decisionUnscorable") : decision;
                    const color = decision === "scored" ? COLOR.ok : decision === "partial" ? COLOR.warn : COLOR.mute;
                    return jsx("span", { style: { color: color }, children: label.length > 0 ? label : "—" });
                  },
                },
                {
                  key: "top1",
                  title: tt("colTop1"),
                  render: (row) => {
                    const top1 = pickText(row.predictionName, row.prediction);
                    return jsx("span", { children: top1 === null ? tt("noRank") : top1 });
                  },
                },
                { key: "probability", title: tt("colConfidence"), render: (row) => formatProbability(row.probability) },
                { key: "agreement", title: tt("colAgreement"), render: (row) => formatProbability(row.agreement) },
                {
                  key: "validRounds",
                  title: tt("colValidRounds"),
                  render: (row) => formatNumber(row.validRounds) + " / " + formatNumber(row.totalRounds),
                },
                {
                  key: "error",
                  title: tt("colError"),
                  render: (row) => (textOf(row.error).length > 0 ? jsx("span", { style: { color: COLOR.bad }, children: textOf(row.error) }) : "—"),
                },
              ],
              rows: records.map((row, index) => ({ __key: String(index), ...row })),
            }),
          ],
        });
      }

      /** 历史视图主体。 */
      function renderHistory() {
        const models = safeList(history.models);
        const lowered = historyQuery.trim().toLowerCase();
        const filtered = lowered.length === 0 ? models : models.filter((item) => (textOf(item.model) + " " + textOf(item.provider)).toLowerCase().includes(lowered));
        const stats = history.stats;
        const statsError = stats === null || stats === undefined ? "" : textOf(stats.error);
        const skipped = stats === null || stats === undefined ? 0 : Number(stats.skippedLines);
        /**
         * ⚠️ 父任务更正 2：`stats.count` 是**历史文件总量**，与任何过滤无关
         * （真机实测：`?provider=nope` → records=0 但 stats.count=1）。
         * 所以「当前有几条」一律用 records/models 的长度，stats.count 只用于「文件共 N 条」这一句。
         */
        const fileTotal = stats === null || stats === undefined ? null : stats.count;
        const body = [];
        // §29.6：stats.error 非空必须显式提示 —— 否则用户会把"读失败"看成"没有记录"
        if (statsError.length > 0) {
          body.push(jsx("div", { key: "stats-error", style: S.noticeBad, children: tt("historyLoadFailed", { reason: statsError }) }));
        }
        if (Number.isFinite(skipped) && skipped > 0) {
          body.push(jsx("p", { key: "skipped", style: S.hint, children: tt("historySkipped", { n: skipped }) }));
        }
        if (history.status === "unready") {
          body.push(
            jsxs("div", {
              key: "unready",
              style: S.noticeBad,
              children: [
                jsx("strong", { key: "t", children: tt("interfaceUnready") }),
                jsx("p", { key: "m", style: { ...S.hint, color: COLOR.bad }, children: tt("interfaceUnreadyHint", { path: "/fingerprint/history/models", reason: textOf(history.error) }) }),
                jsx("div", { key: "act", style: { marginTop: "10px" }, children: jsx(Button, { onClick: () => void loadHistory(), children: tt("retry") }) }),
              ],
            }),
          );
        } else if (history.status === "error") {
          body.push(
            jsxs("div", {
              key: "error",
              style: S.noticeBad,
              children: [
                jsx("strong", { key: "t", children: tt("interfaceError") }),
                jsx("pre", { key: "raw", style: S.pre, children: textOf(history.error) }),
                jsx("div", { key: "act", style: { marginTop: "10px" }, children: jsx(Button, { onClick: () => void loadHistory(), children: tt("retry") }) }),
              ],
            }),
          );
        }
        if (history.status === "loading" || history.status === "refreshing") {
          body.push(jsx("p", { key: "loading", style: S.hint, children: tt("detailLoading") }));
        }
        if (history.status === "ready" && models.length === 0 && statsError.length === 0) {
          // ⚠️ stats.error 非空时**不得**说「还没有检测记录」—— 那会把"读失败"说成"没有记录"（父任务更正 3）
          body.push(jsx("p", { key: "empty", style: S.hint, children: tt("historyEmpty") }));
        }
        if (models.length > 0) {
          body.push(
            jsx(DataTable, {
              key: "aggregate",
              emptyText: tt("historyEmpty"),
              columns: [
                {
                  key: "model",
                  title: tt("colModel"),
                  render: (row) => jsxs("span", { children: [jsx("span", { children: textOf(row.model) || "—" }), jsx("span", { style: S.code, children: " @" + (textOf(row.provider) || "—") })] }),
                },
                { key: "lastTs", title: tt("colLastSeen"), render: (row) => formatWhen(row.lastTs) },
                { key: "runs", title: tt("colRuns"), render: (row) => formatNumber(row.runs) },
                {
                  key: "lastTop1",
                  title: tt("colLastTop1"),
                  render: (row) => {
                    const top1 = pickText(row.lastPredictionName, row.lastPrediction);
                    return jsx("span", { children: top1 === null ? tt("noRank") : top1 });
                  },
                },
                { key: "lastProbability", title: tt("colConfidence"), render: (row) => formatProbability(row.lastProbability) },
                {
                  key: "lastStability",
                  title: tt("colStability"),
                  render: (row) => {
                    const stability = textOf(row.lastStability);
                    if (stability === "stable") return jsx("span", { style: { color: COLOR.ok }, children: tt("stabilityStable") });
                    if (stability === "unstable") return jsx("span", { style: { color: COLOR.warn }, children: tt("stabilityUnstable") });
                    if (stability === "inconclusive") return jsx("span", { style: { color: COLOR.mute }, children: tt("stabilityInconclusive") });
                    return jsx("span", { children: "—" });
                  },
                },
                {
                  key: "detail",
                  title: tt("colDetail"),
                  render: (row) => {
                    const key = targetKey(textOf(row.provider), textOf(row.model));
                    const open = historyDetail[key] !== undefined;
                    return jsx(Button, {
                      onClick: () => toggleHistoryDetail(textOf(row.provider), textOf(row.model), key),
                      children: open ? tt("collapse") : tt("detail"),
                    });
                  },
                },
              ],
              rows: filtered.map((row, index) => ({ __key: String(index) + targetKey(textOf(row.provider), textOf(row.model)), ...row })),
            }),
          );
          // 展开中的模型：明细跟在表下面
          for (const row of filtered) {
            const key = targetKey(textOf(row.provider), textOf(row.model));
            if (historyDetail[key] === undefined) continue;
            body.push(
              // ⚠️ children 必须在 props 里：jsx(type, props, key) 的第三个参数是 **key**，
              // 传元素进去会得到一个没有 children 的空 div（曾经把明细块整个吃掉）。
              jsx("div", {
                key: "detail-" + key,
                style: { marginTop: "10px" },
                children: jsx(
                  DisclosureRow,
                  {
                    title: tt("detail") + "：" + (textOf(row.model) || "—"),
                    open: true,
                    expandable: true,
                    expandOnRowClick: true,
                    onToggle: () => toggleHistoryDetail(textOf(row.provider), textOf(row.model), key),
                    children: renderHistoryDetail(textOf(row.provider), textOf(row.model), key),
                  },
                  "hd",
                ),
              }),
            );
          }
        }
        return jsxs("section", {
          style: S.section,
          children: [
            jsxs("div", {
              key: "h",
              style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" },
              children: [
                jsx("h2", { key: "t", style: S.sectionTitle, children: tt("historyTitle") }),
                jsx("span", { key: "sub", style: S.hint, children: tt("historySub") }),
                jsx("span", { key: "showing", style: S.chip, children: tt("historyShowing", { shown: filtered.length, all: models.length }) }),
                fileTotal === null
                  ? null
                  : jsx("span", { key: "total", style: S.chip, children: tt("historyTotal", { n: formatNumber(fileTotal) }) }),
                jsx("span", {
                  key: "acts",
                  style: { marginLeft: "auto", display: "inline-flex", gap: "6px", flexWrap: "wrap" },
                  children: [
                    jsx(Button, { key: "reload", onClick: () => void loadHistory(), children: tt("historyRefresh") }, "reload"),
                    confirmClear
                      ? jsx(Button, { key: "confirm", onClick: () => void clearHistory(), children: tt("historyClearConfirm") }, "confirm")
                      : jsx(Button, { key: "clear", onClick: () => setConfirmClear(true), children: tt("historyClear") }, "clear"),
                    confirmClear
                      ? jsx(Button, { key: "abort", onClick: () => setConfirmClear(false), children: tt("historyClearCancel") }, "abort")
                      : null,
                  ],
                }),
              ],
            }),
            jsx("div", {
              key: "search",
              style: { margin: "10px 0 4px", maxWidth: "420px" },
              children: jsx(Input, {
                type: "text",
                value: historyQuery,
                placeholder: tt("targetsSearch"),
                "aria-label": tt("targetsSearch"),
                onChange: (event) => setHistoryQuery(event.target.value),
              }),
            }),
            historyNotice !== null ? jsx("div", { key: "notice", style: S.notice, children: textOf(historyNotice) }) : null,
            ...body,
          ],
        });
      }

      // ── 渲染 ────────────────────────────────────────────────────────────
      const unreadyNotice =
        targets.status === "unready"
          ? jsxs("div", {
              style: S.noticeBad,
              children: [
                jsx("strong", { key: "t", children: tt("interfaceUnready") }),
                jsx("p", {
                  key: "m",
                  style: { ...S.hint, color: COLOR.bad },
                  children: tt("interfaceUnreadyHint", { path: targets.unready ? targets.unready.path : "/fingerprint/targets", reason: textOf(targets.error) }),
                }),
                jsx("pre", { key: "raw", style: S.pre, children: tt("errorRaw") + "：\n" + textOf(targets.error) }),
                jsx("div", {
                  key: "act",
                  style: { marginTop: "10px" },
                  children: jsx(Button, { onClick: () => void loadTargets(), children: tt("retry") }),
                }),
              ],
            })
          : targets.status === "error"
            ? jsxs("div", {
                style: S.noticeBad,
                children: [
                  jsx("strong", { key: "t", children: tt("interfaceError") }),
                  jsx("pre", { key: "raw", style: S.pre, children: textOf(targets.error) }),
                  jsx("div", {
                    key: "act",
                    style: { marginTop: "10px" },
                    children: jsx(Button, { onClick: () => void loadTargets(), children: tt("retry") }),
                  }),
                ],
              })
            : null;

      return jsxs("div", {
        style: S.page,
        children: [
          jsxs("div", {
            key: "head",
            style: S.head,
            children: [
              jsx("span", { key: "glyph", children: jsx(FingerprintIcon, { size: 26, active: true }) }),
              jsxs("div", {
                key: "text",
                style: { minWidth: 0 },
                children: [
                  jsx("h1", { style: S.title, children: tt("title") }),
                  jsx("p", { style: S.sub, children: tt("intro") }),
                ],
              }),
            ],
          }),
          jsxs("div", {
            key: "strip",
            style: S.strip,
            children: [
              jsxs("span", {
                children: [
                  jsx(Dot, { color: detector && detector.ready === true ? COLOR.ok : COLOR.warn }),
                  " ",
                  detector && detector.ready === true ? tt("detectorReady") : tt("detectorNotReady"),
                ],
              }),
              jsxs("span", { children: [tt("detectorBank") + ": ", textOf(detector ? detector.bankModelCount : null) || "—"] }),
              jsxs("span", { children: [tt("detectorBuiltAt") + ": ", textOf(detector ? detector.builtAt : null) || "—"] }),
              jsxs("span", { children: [tt("runPhase") + ": ", jsx("b", { children: RUN_PHASE[phase] === undefined ? phase : RUN_PHASE[phase] })] }),
              jsxs("span", {
                children: [
                  tt("feedMode") + ": ",
                  feedState.feed.mode === "sse" ? tt("feedSse") : feedState.feed.mode === "poll" || feedState.feed.mode === "poll-error" ? tt("feedPoll") : feedState.feed.mode === "done" ? tt("feedDone") : feedState.feed.mode === "cancelled" ? tt("feedCancelled") : feedState.feed.mode === "failed" ? tt("feedFailed") : feedState.feed.mode === "idle" ? tt("feedStopped") : tt("feedConnecting"),
                  feedState.feed.error === null ? null : "（" + textOf(feedState.feed.error) + "）",
                ],
              }),
              jsx("span", {
                children: jsx(Button, {
                  onClick: () => void refreshDetector(),
                  disabled: refreshing || targets.status !== "ready",
                  children: refreshing ? tt("detectorRefreshing") : tt("detectorRefresh"),
                }),
              }),
            ],
          }),
          // 视图切换（契约 §29.6）：检测 / 历史
          jsx("div", {
            key: "tabs",
            style: { margin: "14px 0 0" },
            children: jsx(Tabs, {
              label: tt("viewSwitch"),
              value: tab,
              onChange: (next) => setTab(next === "history" ? "history" : "detect"),
              items: [
                { value: "detect", label: tt("tabDetect"), id: "fp-tab-detect", panelId: "fp-panel-detect" },
                { value: "history", label: tt("tabHistory"), id: "fp-tab-history", panelId: "fp-panel-history" },
              ],
            }),
          }),
          unreadyNotice,
          actionError !== null
            ? jsxs("div", {
                key: "action-error",
                style: S.noticeBad,
                children: [
                  jsx("strong", { key: "t", children: tt("interfaceError") }),
                  jsx("p", { key: "m", style: { ...S.hint, color: COLOR.bad }, children: textOf(actionError.message) }),
                  actionError.raw === undefined ? null : jsx("pre", { key: "raw", style: S.pre, children: textOf(actionError.raw) }),
                ],
              })
            : null,
          actionNote !== null
            ? jsx("div", { key: "action-note", style: S.notice, children: textOf(actionNote) })
            : null,
          running
            ? jsxs("div", {
                key: "running-banner",
                style: S.notice,
                children: [
                  jsxs("div", {
                    key: "line",
                    style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" },
                    children: [
                      jsx(Dot, { key: "dot", color: COLOR.accent }),
                      jsx("strong", { key: "t", children: tt("runtimeBanner") }),
                      jsx("span", { key: "id", style: S.code, children: runId }),
                      jsx("span", { key: "phase", style: S.chip, children: RUN_PHASE[phase] === undefined ? phase : RUN_PHASE[phase] }),
                      jsx("span", {
                        key: "feed",
                        style: S.chip,
                        children:
                          feedState.feed.mode === "sse" ? tt("feedSse") : feedState.feed.mode === "poll" || feedState.feed.mode === "poll-error" ? tt("feedPoll") : tt("feedConnecting"),
                      }),
                      jsx("span", {
                        key: "actions",
                        style: { marginLeft: "auto", display: "inline-flex", gap: "6px", flexWrap: "wrap" },
                        children: [
                          jsx(Button, { key: "cancel", onClick: () => void cancelRun(), children: tt("cancel") }, "cancel"),
                          jsx(Button, { key: "export", onClick: () => void exportRun(), children: tt("exportJson") }, "export"),
                        ],
                      }),
                    ],
                  }),
                ],
              })
            : null,

          // 1. 选择模型
          jsxs("section", {
            key: "targets",
            style: showDetect ? S.section : S.hidden,
            children: [
              jsxs("div", {
                key: "h",
                style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" },
                children: [
                  jsx("h2", { key: "t", style: S.sectionTitle, children: tt("targetsTitle") }),
                  jsx("span", { key: "c", style: S.chip, children: tt("selectCount", { n: selectedRows.length, total: allSelectableRows.length }) }),
                  dormantMatchedRows.length > 0
                    ? jsx("span", {
                        key: "excluded",
                        style: S.chip,
                        children: tt("dormantExcluded", { n: dormantGroups.size }),
                      })
                    : null,
                  jsx("span", {
                    key: "acts",
                    style: { marginLeft: "auto", display: "inline-flex", gap: "6px", flexWrap: "wrap" },
                    children: [
                      jsx(Button, { key: "all", onClick: selectAllMatched, disabled: selectableRows.length === 0, children: tt("selectAll") }, "all"),
                      jsx(Button, { key: "none", onClick: clearAll, disabled: selectedRows.length === 0, children: tt("selectClear") }, "none"),
                      jsx(Button, { key: "reload", onClick: () => void loadTargets(), children: tt("reload") }, "reload"),
                    ],
                  }),
                ],
              }),
              jsx("div", {
                key: "search",
                style: { margin: "10px 0 4px", maxWidth: "420px" },
                children: jsx(Input, {
                  type: "text",
                  value: query,
                  placeholder: tt("targetsSearch"),
                  "aria-label": tt("targetsSearch"),
                  onChange: (event) => setQuery(event.target.value),
                }),
              }),
              targets.status === "loading" ? jsx("p", { style: S.hint, children: "加载中…" }) : null,
              targets.status === "ready" && rows.length === 0 ? jsx("p", { style: S.hint, children: tt("noProvider") }) : null,
              targets.status === "ready" && rows.length > 0 && matchedRows.length === 0
                ? jsx("p", { style: S.hint, children: tt("noModelMatched") })
                : null,
              ...Array.from(groupedMatches.entries()).map(([provider, providerRows]) => renderProviderGroup(provider, providerRows)),
              dormantMatchedRows.length > 0 ? renderDormantGroup(dormantGroups) : null,
            ],
          }),

          // 2. 轮次 + 高级
          jsxs("section", {
            key: "options",
            style: showDetect ? S.section : S.hidden,
            children: [
              jsx("h2", { key: "t", style: S.sectionTitle, children: tt("roundsTitle") }),
              jsxs("div", {
                key: "rounds",
                style: S.field,
                children: [
                  jsx("span", { style: S.fieldLabel, children: tt("rounds") }),
                  jsxs("span", {
                    style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", minWidth: 0 },
                    children: [
                      jsx(NumberField, {
                        key: "rounds-field",
                        width: "88px",
                        min: ROUNDS.min,
                        max: ROUNDS.max,
                        step: 1,
                        value: roundsText,
                        ariaLabel: tt("rounds"),
                        onChange: (event) => setRoundsText(event.target.value),
                      }),
                      jsx("span", { style: S.hint, children: tt("roundsHint") }),
                      isClamped(roundsText, ROUNDS.min, ROUNDS.max) ? jsx("span", { style: S.chipWarn, children: tt("clampHint", { n: rounds }) }) : null,
                    ],
                  }),
                ],
              }),
              jsxs("div", {
                key: "estimate",
                style: S.field,
                children: [
                  jsx("span", { style: S.fieldLabel, children: "预计" }),
                  jsx("span", {
                    style: S.hint,
                    // §28.2 + §33.3：parallel 是「同时在跑的轮次数」（跨 目标 × 轮次），
                    // 在飞请求数按 min(parallel, 目标×轮次) × count 精确封顶。
                    children: tt("estimated", {
                      n: expectedRequests,
                      targets: selectedRows.length,
                      rounds: rounds,
                      count: count,
                      parallel: parallel,
                      slots: roundSlots,
                      inflight: inflightRequests,
                    }),
                  }),
                ],
              }),
              jsxs("div", {
                key: "run-actions",
                style: { ...S.actions, marginTop: "10px" },
                children: [
                  jsx(Button, {
                    key: "start",
                    disabled: starting || selectedRows.length === 0,
                    onClick: () => void startRun(),
                    children: starting ? "启动中…" : tt("start"),
                  }),
                  jsx(Button, {
                    key: "cancel",
                    // §28.3：取消始终可点（只要有一条在跑的 runId）；宿主 /cancel 空 body 默认指向 activeRunId
                    disabled: runId === null || isTerminalPhase(phase),
                    onClick: () => void cancelRun(),
                    children: tt("cancel"),
                  }),
                  jsx(Button, { key: "export", onClick: () => void exportRun(), children: tt("exportJson") }),
                  selectedRows.length === 0 ? jsx("span", { key: "hint", style: S.hint, children: tt("needSelection") }) : null,
                  jsx("span", {
                    key: "phase",
                    style: { marginLeft: "auto", ...S.hint },
                    children: tt("runId") + ": " + (runId === null ? tt("noRun") : runId),
                  }),
                ],
              }),
              jsx("div", {
                key: "advanced",
                style: { marginTop: "10px" },
                children: jsxs(
                  DisclosureRow,
                  {
                    title: tt("advanced"),
                    open: advancedOpen,
                    expandable: true,
                    expandOnRowClick: true,
                    onToggle: () => setAdvancedOpen((prev) => !prev),
                    collapsedContent: "count=" + String(count) + " · parallel=" + String(parallel) + " · strict=" + (strict ? "on" : "off"),
                    children: [
                      jsxs("div", {
                        key: "count",
                        style: S.field,
                        children: [
                          jsx("span", { style: S.fieldLabel, children: tt("challenges") }),
                          jsxs("span", {
                            style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" },
                            children: [
                              jsx(NumberField, {
                                key: "count-field",
                                width: "88px",
                                min: CHALLENGE_COUNT.min,
                                max: CHALLENGE_COUNT.max,
                                step: 1,
                                value: strict ? String(STRICT_COUNT) : countText,
                                disabled: strict,
                                ariaLabel: tt("challenges"),
                                onChange: (event) => setCountText(event.target.value),
                              }),
                              jsx("span", { style: S.hint, children: tt("challengesHint") }),
                              strict ? jsx("span", { style: S.chipWarn, children: tt("strictForced", { n: STRICT_COUNT }) }) : null,
                            ],
                          }),
                        ],
                      }),
                      jsxs("div", {
                        key: "parallel",
                        style: S.field,
                        children: [
                          jsx("span", { style: S.fieldLabel, children: tt("parallel") }),
                          jsxs("span", {
                            style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" },
                            children: [
                              jsx(NumberField, {
                                key: "parallel-field",
                                width: "88px",
                                min: PARALLEL.min,
                                max: PARALLEL.max,
                                step: 1,
                                value: parallelText,
                                ariaLabel: tt("parallel"),
                                onChange: (event) => setParallelText(event.target.value),
                              }),
                              jsx("span", { style: S.hint, children: tt("parallelHint") }),
                            ],
                          }),
                        ],
                      }),
                      jsxs("div", {
                        key: "strict",
                        style: S.field,
                        children: [
                          jsx("span", { style: S.fieldLabel, children: tt("strict") }),
                          jsxs("span", {
                            style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" },
                            children: [
                              jsx(Switch, {
                                checked: strict,
                                label: tt("strict"),
                                onChange: (value) => setStrict((prev) => (typeof value === "boolean" ? value : !prev)),
                              }),
                              jsx("span", { style: S.hint, children: tt("strictHint") }),
                            ],
                          }),
                        ],
                      }),
                      jsxs("div", {
                        key: "timeout",
                        style: S.field,
                        children: [
                          jsx("span", { style: S.fieldLabel, children: tt("timeout") }),
                          jsxs("span", {
                            style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" },
                            children: [
                              jsx(NumberField, {
                                key: "timeout-field",
                                width: "100px",
                                min: TIMEOUT_SEC.min,
                                max: TIMEOUT_SEC.max,
                                step: 10,
                                value: timeoutText,
                                ariaLabel: tt("timeout"),
                                onChange: (event) => setTimeoutText(event.target.value),
                              }),
                              jsx("span", { style: S.hint, children: tt("timeoutHint") }),
                              isClamped(timeoutText, TIMEOUT_SEC.min, TIMEOUT_SEC.max)
                                ? jsx("span", { style: S.chipWarn, children: tt("clampHint", { n: timeoutSec }) })
                                : null,
                            ],
                          }),
                        ],
                      }),
                    ],
                  },
                  "advanced-body",
                ),
              }),
            ],
          }),

          // 3/4. 运行明细
          jsxs("section", {
            key: "run",
            style: showDetect ? S.section : S.hidden,
            children: [
              jsxs("div", {
                key: "h",
                style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" },
                children: [
                  jsx("h2", { key: "t", style: S.sectionTitle, children: tt("progressTitle") }),
                  jsx("span", {
                    key: "overall",
                    style: { display: "inline-flex", alignItems: "center", gap: "8px" },
                    children: [
                      jsx(ProgressBar, { ratio: totalTaskSlots === 0 ? 0 : finishedTaskSlots / totalTaskSlots }),
                      jsx("span", { style: S.code, children: String(finishedTaskSlots) + "/" + String(totalTaskSlots) }),
                    ],
                  }),
                  snapshot !== null && snapshot.options !== null && snapshot.options !== undefined
                    ? jsx("span", {
                        key: "opt",
                        style: S.code,
                        children:
                          "rounds=" +
                          formatNumber(snapshot.options.rounds) +
                          " count=" +
                          formatNumber(snapshot.options.count) +
                          " parallel=" +
                          formatNumber(snapshot.options.parallel) +
                          " timeout=" +
                          formatNumber(snapshot.options.timeoutSec) +
                          " strict=" +
                          (snapshot.options.strict === true ? "on" : "off"),
                      })
                    : null,
                ],
              }),
              phase === "failed" || snapshot !== null && textOf(snapshot.error).length > 0
                ? jsxs("div", {
                    key: "run-error",
                    style: S.noticeBad,
                    children: [
                      jsx("strong", { key: "t", children: tt("errorRaw") }),
                      jsx("pre", { key: "raw", style: S.pre, children: textOf(snapshot === null ? "" : snapshot.error) || "（宿主未提供 error 字段）" }),
                    ],
                  })
                : null,
              jsx(DataTable, {
                key: "tasks",
                emptyText: tt("tasksEmpty"),
                columns: [
                  { key: "model", title: tt("colModel"), render: (row) => jsxs("span", { children: [jsx("span", { children: textOf(row.model) }), jsx("span", { style: S.code, children: " @" + textOf(row.provider) })] }) },
                  { key: "round", title: tt("colRound"), render: (row) => "第 " + textOf(row.round) + "/" + textOf(row.totalRounds) + " 轮" },
                  {
                    key: "state",
                    title: tt("colState"),
                    render: (row) => {
                      const state = textOf(row.state);
                      const meta = TASK_STATE[state];
                      return jsxs("span", {
                        style: { display: "inline-flex", alignItems: "center", gap: "6px" },
                        children: [
                          jsx(Dot, { color: meta === undefined ? COLOR.mute : meta.color }),
                          jsx("span", { style: { color: meta === undefined ? COLOR.fg : meta.color }, children: meta === undefined ? state : meta.label }),
                          jsx("span", { style: S.code, children: state }),
                        ],
                      });
                    },
                  },
                  {
                    key: "count",
                    title: tt("colCount"),
                    render: (row) => formatNumber(row.count) + " / " + formatNumber(row.expectedCount),
                  },
                  { key: "firstByte", title: tt("colFirstByte"), render: (row) => formatMs(row.firstByteMs) },
                  {
                    key: "progress",
                    title: tt("colProgress"),
                    render: (row) => {
                      const expected = typeof row.expectedCount === "number" && row.expectedCount > 0 ? row.expectedCount : 0;
                      const got = typeof row.count === "number" ? row.count : 0;
                      const state = textOf(row.state);
                      const meta = TASK_STATE[state];
                      return jsx(ProgressBar, { ratio: expected === 0 ? 0 : got / expected, color: meta === undefined ? COLOR.accent : meta.color });
                    },
                  },
                  {
                    key: "error",
                    title: tt("colError"),
                    render: (row) => (textOf(row.error).length > 0 ? jsx("span", { style: { color: COLOR.bad }, children: textOf(row.error) }) : "—"),
                  },
                  // 契约 §12.8：tasks[] 没有 per-task 时间戳 —— 不展示「开始时间」，避免所有行显示同一时刻。
                ],
                rows: tasks.map((task, index) => ({ __key: targetKey(textOf(task.provider), textOf(task.model)) + ":" + String(index), ...task })),
              }),
            ],
          }),

          // 5. 结果
          jsxs("section", {
            key: "results",
            style: showDetect ? S.section : S.hidden,
            children: [
              jsxs("div", {
                key: "h",
                style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" },
                children: [
                  jsx("h2", { key: "t", style: S.sectionTitle, children: tt("resultsTitle") }),
                  jsx("span", { key: "note", style: S.chip, children: tt("rankingNote") }),
                ],
              }),
              jsx(DataTable, {
                key: "table",
                emptyText: tt("resultsEmpty"),
                columns: resultColumns,
                rows: resultRows,
              }),
              results.length === 0
                ? null
                : jsx("p", { key: "metric-note", style: { ...S.hint, marginTop: "8px" }, children: tt("metricNote") }),
              results.length === 0
                ? null
                : jsxs("div", {
                    key: "details",
                    style: { marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px" },
                    children: resultRows.map((row) =>
                      jsx(
                        DisclosureRow,
                        {
                          key: row.__key,
                          title: tt("detail") + "：" + row.model,
                          open: expanded[row.__key] === true,
                          expandable: true,
                          expandOnRowClick: true,
                          onToggle: () => toggleDetail(row.__key),
                          collapsedContent: row.aggregate
                            ? formatNumber(row.aggregate.validRounds) + "/" + formatNumber(row.aggregate.totalRounds) + " 有效回合"
                            : undefined,
                          children: renderDetail(row),
                        },
                        row.__key,
                      ),
                    ),
                  }),
            ],
          }),
          // 视图切换：历史视图（契约 §29.6）
          tab === "history" ? renderHistory() : null,
        ],
      });
    }
    //#endregion

    //#region 注册
    /** cordis 服务名（不是包名）：slots 用于注册槽位，locale 用于注册字典并拿到 t。 */
    const inject = ["slots", "locale"];

    /** 建立侧栏行与主区页面。 */
    function apply(ctx) {
      const locale = ctx.get("locale");
      if (locale !== null && locale !== undefined) {
        try {
          ctx.effect(() => locale.register(NS, { zh: ZH, en: enTable() }), "dsh-fingerprint: dictionaries");
          boundTranslate = locale.bind(NS);
        } catch (err) {
          try {
            ctx.logger.warn("dsh-fingerprint: locale 注册失败，回退内置字典", err);
          } catch (logErr) {
            /* 忽略 */
          }
        }
      }

      /** 侧栏行标签用 thunk，语言切换时由宿主重新投影。 */
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: SIDEBAR_ORDER,
            label: () => t("nav"),
            locale: NS,
          },
          FingerprintIcon,
        ),
      );

      /**
       * 中央主区页面：key 必须等于上面的 id，否则点行会抛未注册。
       *
       * ⚠️ D1（V-B 审查）：这里**必须**交 `FingerprintPanel`（PageBoundary + FingerprintPage），
       * 不能直接交 `FingerprintPage` —— 否则渲染期异常会冒泡到宿主的 SlotErrorBoundary，
       * 用户只会看到没有任何说明的空格子 `<div data-slot-error="main">`，
       * 而本文件的 pageCrash 文案与 PageBoundary 全文就都成了死代码。
       */
      ctx.slots.inject("main", () =>
        ctx.slots.register(
          {
            name: "main",
            key: PANEL_ID,
            locale: NS,
            inject: () => ({ t: boundTranslate === null ? t : boundTranslate }),
          },
          FingerprintPanel,
        ),
      );
    }
    //#endregion

    bundleModule.exports.NS = NS;
    bundleModule.exports.PANEL_ID = PANEL_ID;
    bundleModule.exports.FingerprintIcon = FingerprintIcon;
    bundleModule.exports.FingerprintPage = FingerprintPage;
    bundleModule.exports.PageBoundary = PageBoundary;
    bundleModule.exports.FingerprintPanel = FingerprintPanel;
    bundleModule.exports.interpolate = interpolate;
    bundleModule.exports.apply = apply;
    bundleModule.exports.inject = inject;
    return bundleModule.exports;
  },
});


