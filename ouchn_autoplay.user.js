// ==UserScript==
// @name         国开学习网自动连播 v15.2
// @namespace    https://github.com/ouchn-autoplay
// @version      1.1.0
// @description  国开学习网全屏活动页自动连播。启发于国开学习的不便，经长期试用推出正式版。
// @match        https://*.ouchn.cn/*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const DEBUG = false;
  // 轮询间隔随机范围（ms），替代固定 2s
  const POLL_MIN = 2200;
  const POLL_MAX = 4200;
  // view-only 延迟范围（秒）
  const VIEW_MIN_SEC = 4;
  const VIEW_MAX_SEC = 6;
  // 会话限制：完成 N 个活动后强制休息
  const SESSION_MIN = 5;
  const SESSION_MAX = 9;
  // 强制休息时长（秒）
  const BREAK_MIN_SEC = 30;
  const BREAK_MAX_SEC = 60;
  // 播放中途暂停概率
  const MID_PAUSE_CHANCE = 0.12;
  const MID_PAUSE_MIN_SEC = 40;
  const MID_PAUSE_MAX_SEC = 180;
  // 转码卡住检测
  const STUCK_CHECK_SEC = 22;
  const MAX_STUCK_RETRIES = 3;

  // 画质排序
  const QUALITY_ORDER = {
    "流畅": 0, "极速": 0, "省流": 0, "low": 0,
    "标清": 1, "sd": 1, "标准": 1, "medium": 1,
    "高清": 2, "hd": 2, "high": 2,
    "超清": 3, "fhd": 3, "1080p": 4, "2k": 5, "4k": 6,
    "自动": 9, "auto": 9,
  };

  // ====== 状态 ======
  let paused = true; // 默认暂停，用户点击启动
  let lastUserActivity = 0;
  let advancing = false;
  let autoPlayAttempted = false;
  let viewOnlyTimer = null;
  let consecutiveAdvances = 0;
  let breakActive = false;
  let breakTimer = null;
  let breakRemaining = 0;
  let midPauseTimer = null;
  let midPauseActive = false; // 模拟暂停进行中，避免 watchdog 误恢复
  let pollTimer = null;
  let observer = null;
  let stuckCheckTimer = null;
  let stuckRetries = 0;
  const watched = new WeakSet();

  // ====== 工具 ======
  function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function randSec(min, max) { return rand(min * 1000, max * 1000); }
  function log(...a) { if (DEBUG) console.log("[AP]", ...a); }

  // ====== 指示器（低调） ======
  const ind = document.createElement("div");
  Object.assign(ind.style, {
    position: "fixed", bottom: "100px", right: "20px", zIndex: "99999",
    background: "rgba(80,0,0,0.85)", color: "#d88", padding: "6px 12px",
    borderRadius: "6px", fontSize: "12px", fontFamily: "monospace",
    cursor: "pointer", pointerEvents: "auto",
  });
  ind.textContent = "已暂停";
  ind.title = "点击启动/暂停自动连播";
  document.documentElement.appendChild(ind);

  ind.addEventListener("click", (e) => {
    e.stopPropagation();
    if (breakActive) {
      // 双击可跳过休息
      skipBreak();
      return;
    }
    paused = !paused;
    GM_setValue("ap_paused", JSON.stringify(paused));
    if (paused) {
      ind.style.background = "rgba(80,0,0,0.85)";
      ind.style.color = "#d88";
      ind.textContent = "已暂停";
      clearTimeout(viewOnlyTimer);
      clearTimeout(midPauseTimer);
      clearTimeout(stuckCheckTimer);
      midPauseActive = false;
    } else {
      ind.style.background = "rgba(0,0,0,0.78)";
      ind.style.color = "#aaa";
      ind.textContent = "就绪";
      consecutiveAdvances = 0;
      scanAll();
      schedulePoll();
      checkCurrentActivity();
    }
  });

  function status(msg, c) {
    if (paused && !breakActive) return;
    ind.textContent = msg;
    if (c) ind.style.color = c;
  }

  // ====== 用户交互检测 ======
  ["mousemove", "keydown", "scroll", "click", "touchstart"].forEach((evt) => {
    document.addEventListener(evt, () => { lastUserActivity = Date.now(); }, { passive: true });
  });
  function userActiveRecently(ms) { return Date.now() - lastUserActivity < ms; }

  // ====== Tab 焦点保持播放 ======
  let tabHidden = false;
  document.addEventListener("visibilitychange", () => {
    tabHidden = document.visibilityState === "hidden";
    if (tabHidden) {
      clearTimeout(midPauseTimer);
      midPauseActive = false;
    } else {
      if (!paused && !breakActive && !advancing) checkCurrentActivity();
    }
  });

  // ====== 真人行为模拟 ======
  function simHumanActivity() {
    if (Math.random() < 0.3) {
      // 偶尔移动鼠标
      const evt = new MouseEvent("mousemove", {
        clientX: rand(100, window.innerWidth - 100),
        clientY: rand(100, window.innerHeight - 100),
        bubbles: true,
      });
      document.dispatchEvent(evt);
    }
    if (Math.random() < 0.15) {
      // 偶尔滚动
      unsafeWindow.scrollBy({ top: rand(-30, 30), behavior: "smooth" });
    }
  }

  // ====== 会话休息 ======
  function skipBreak() {
    clearTimeout(breakTimer);
    breakActive = false;
    breakRemaining = 0;
    ind.style.background = "rgba(0,0,0,0.78)";
    ind.style.color = "#aaa";
    ind.textContent = "就绪";
    consecutiveAdvances = 0;
    status("恢复", "#0f0");
    log("用户跳过休息");
    checkCurrentActivity();
  }

  function startBreak() {
    breakActive = true;
    breakRemaining = rand(BREAK_MIN_SEC, BREAK_MAX_SEC);
    ind.style.background = "rgba(0,0,40,0.9)";
    ind.style.color = "#8af";

    function tick() {
      if (!breakActive || paused) return;
      breakRemaining--;
      if (breakRemaining <= 0) {
        breakActive = false;
        consecutiveAdvances = 0;
        ind.style.background = "rgba(0,0,0,0.78)";
        ind.style.color = "#aaa";
        ind.textContent = "就绪";
        log("休息结束，恢复");
        // 当前媒体已结束则直接跳转（避免重播）
        let allEnded = true;
        const mediaEls = document.querySelectorAll("video, audio");
        for (const el of mediaEls) {
          if (!el.ended && el.duration > 0 && !el.paused) { allEnded = false; break; }
        }
        if (mediaEls.length > 0 && allEnded) {
          doAdvance();
        } else {
          checkCurrentActivity();
        }
        return;
      }
      ind.textContent = "休息 " + breakRemaining + "s";
      breakTimer = setTimeout(tick, 1000);
    }
    log("进入休息模式: " + breakRemaining + "s");
    tick();
  }

  function shouldTakeBreak() {
    if (consecutiveAdvances < SESSION_MIN) return false;
    if (consecutiveAdvances >= SESSION_MAX) return true;
    // 在 SESSION_MIN ~ SESSION_MAX 区间，概率递增
    const range = SESSION_MAX - SESSION_MIN;
    const progress = (consecutiveAdvances - SESSION_MIN) / range;
    return Math.random() < progress * 0.8;
  }

  // ====== AngularJS scope（通过 unsafeWindow 访问） ======
  function getScope() {
    if (typeof unsafeWindow.angular === "undefined") return null;
    try {
      for (const el of document.querySelectorAll("[ng-controller]")) {
        if (el.getAttribute("ng-controller") === "ViewActivityCtrl") {
          return unsafeWindow.angular.element(el).scope();
        }
      }
    } catch (e) {}
    return null;
  }

  function classifyActivity(act) {
    if (!act) return "unknown";
    const t = act.type || "";
    if (/exam/.test(t)) return "exam";
    if (t === "homework") return "homework";
    if (t === "questionnaire") return "questionnaire";
    if (t === "forum") return "forum";
    if (t === "online_video" || t === "lesson") return "media";
    if (t === "page" || t === "material") return "view";
    if (t === "tencent_meeting" || t === "live") return "meeting";
    const ck = act.completion_criterion_key || "";
    if (ck === "submit" || ck === "post") return "manual";
    if (ck === "view" || ck === "completeness") return "media";
    return "unknown";
  }

  function isManual(act) {
    const c = classifyActivity(act);
    if (["exam", "homework", "questionnaire", "forum", "meeting", "manual"].includes(c)) return true;
    return /形考|终考|考试|答题|测验|作业|问卷|讨论/.test((act?.title || "").toLowerCase());
  }

  function isViewOnly(act) {
    return classifyActivity(act) === "view";
  }

  function hasPreviewButton() {
    var kw = /^(预览|查看|查阅|打开|下载|附件|预\s*览)$/i;
    var selectors = ["button", "a[ng-click]", "a[href]", ".ivu-btn", "a", "span[ng-click]", "div[ng-click]"];
    for (var s = 0; s < selectors.length; s++) {
      var els = document.querySelectorAll(selectors[s]);
      for (var i = 0; i < els.length; i++) {
        var t = (els[i].textContent || "").trim();
        if (t && kw.test(t) && els[i].offsetParent !== null) return els[i];
      }
    }
    // 兜底：所有元素
    var all = document.querySelectorAll("button, a, span, div");
    for (var j = 0; j < all.length; j++) {
      var t2 = (all[j].textContent || "").trim();
      if ((t2 === "查看" || t2 === "预览") && all[j].offsetParent !== null) return all[j];
    }
    return null;
  }

  function handleReferenceActivity() {
    var previewBtn = hasPreviewButton();
    if (!previewBtn) return false;
    log("参考资料: 点击预览");
    status("预览...", "#aaa");
    // 在页面上下文中点击预览按钮
    execInPage(function () {
      var kw = /^(预览|查看|查阅|打开|下载|附件|预\s*览)$/i;
      var btn;
      // 优先按钮/链接（和 hasPreviewButton 顺序一致），避免误匹配 <div class="ivu-table-cell">
      var priority = ["button", "a[ng-click]", "a[href]", ".ivu-btn", "a", "span[ng-click]", "div[ng-click]"];
      for (var p = 0; p < priority.length && !btn; p++) {
        var els = document.querySelectorAll(priority[p]);
        for (var i = 0; i < els.length; i++) {
          var t = (els[i].textContent || "").trim();
          if (t && kw.test(t) && els[i].offsetParent !== null) { btn = els[i]; break; }
        }
      }
      if (!btn) return;
      // 如果是纯文本容器（div/span无事件），向上找可点击父元素
      if ((btn.tagName === "DIV" || btn.tagName === "SPAN") && !btn.getAttribute("ng-click")) {
        var pEl = btn.parentElement;
        if (pEl && (pEl.tagName === "A" || pEl.tagName === "BUTTON")) btn = pEl;
      }
      btn.click();
      // 3 秒后关闭预览（PDF 需要加载时间）
      setTimeout(function () {
        // 1. PDF 预览面板关闭按钮
        var sel = "a.close, a[class*='close'], .font-close, i[class*='close'], .ivu-icon-ios-close, .ivu-icon-ios-close-empty";
        var btns = document.querySelectorAll(sel);
        for (var b = 0; b < btns.length; b++) {
          if (btns[b].offsetParent !== null) { btns[b].click(); return; }
        }
        // 2. 文本按钮
        var textBtns = document.querySelectorAll("button, a, span, i");
        for (var j = 0; j < textBtns.length; j++) {
          var txt = (textBtns[j].textContent || "").trim();
          if ((txt === "关闭" || txt === "×" || txt === "✕") && textBtns[j].offsetParent !== null) {
            textBtns[j].click(); return;
          }
        }
        // 3. 遮罩点击
        var mask = document.querySelector(".ivu-modal-mask, .ivu-drawer-mask, [class*='mask'], [class*='backdrop']");
        if (mask && mask.offsetParent !== null) { mask.click(); return; }
        // 4. PDF viewer iframe
        var pdfFrame = document.querySelector("iframe[src*='pdf'], iframe[src*='viewer']");
        if (pdfFrame) { pdfFrame.remove(); return; }
        // 5. ESC
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      }, 3000);
    });
    var delay = rand(4000, 5500);
    setTimeout(function () {
      if (!paused && !breakActive && !advancing) doAdvance();
    }, delay);
    return true;
  }

  // ====== 页面上下文执行（绕过沙箱点击限制） ======
  function execInPage(fn) {
    var a = Array.prototype.slice.call(arguments, 1);
    try { new unsafeWindow.Function("var __a=" + JSON.stringify(a) + ";(" + fn.toString() + ").apply(null,__a);")(); } catch (e) {}
  }

  // ====== 画质控制（仅视频） ======
  let qualityApplied = false;
  let qualityTries = 0;

  function clickLowestQuality() {
    if (qualityApplied) { return; }
    if (qualityTries >= 3) { qualityApplied = true; return; }
    var qb = document.querySelector(".mvp-player-quality-btn");
    // 按钮还不存在 = 玩家未初始化完毕，不计尝试次数，等 poll 重试
    if (!qb) {
      qualityApplied = false;
      return;
    }
    qualityTries++;
    var prevText = (qb.textContent || "").trim();
    var rank = { "流畅": 0, "极速": 0, "省流": 0, "low": 0, "标清": 10, "sd": 10, "标准": 10, "medium": 10, "高清": 20, "hd": 20, "high": 20, "超清": 30, "fhd": 30, "1080p": 40, "2k": 50, "4k": 60, "自动": 90, "auto": 90 };
    function tryPick() {
      var visibleOpts = document.querySelectorAll(".mvp-player-quality");
      var lowest = null, lowestScore = 999;
      for (var i = 0; i < visibleOpts.length; i++) {
        if (visibleOpts[i].offsetParent === null) continue;
        var t = visibleOpts[i].textContent.trim();
        if (visibleOpts[i].classList.contains("active")) continue;
        var score, pm = t.match(/^(\d+)p$/i);
        if (pm) { score = parseInt(pm[1]); }
        else if (rank.hasOwnProperty(t.toLowerCase())) { score = rank[t.toLowerCase()]; }
        else { continue; }
        if (score < lowestScore) { lowestScore = score; lowest = visibleOpts[i]; }
      }
      return lowest;
    }
    var lowest = tryPick();
    if (lowest) { lowest.click(); return; }
    // 选项不可见，先从沙箱点击按钮
    if (qb && qb.offsetParent !== null) { qb.click(); }
    // 400ms 后扫描
    setTimeout(function () {
      var l = tryPick();
      if (l) { l.click(); return; }
      var l = tryPick();
      if (l) { l.click(); return; }
      // 沙箱点击也没打开菜单，execInPage 兜底
      execInPage(function () {
        var btn = document.querySelector(".mvp-player-quality-btn");
        if (!btn) return;
        btn.click();
        setTimeout(function () {
          var best = null, bestScore = 999;
          var r = { "流畅": 0, "极速": 0, "省流": 0, "low": 0, "标清": 10, "sd": 10, "标准": 10, "medium": 10, "高清": 20, "hd": 20, "high": 20, "超清": 30, "fhd": 30, "1080p": 40, "2k": 50, "4k": 60, "自动": 90, "auto": 90 };
          var all = document.querySelectorAll(".mvp-player-quality, span, li, div, button");
          for (var i = 0; i < all.length; i++) {
            var t = all[i].textContent.trim();
            if (!t || t.length > 15 || all[i].classList.contains("active")) continue;
            var s, pm2 = t.match(/^(\d+)p$/i);
            if (pm2) { s = parseInt(pm2[1]); }
            else if (r.hasOwnProperty(t.toLowerCase())) { s = r[t.toLowerCase()]; }
            else { continue; }
            if (s < bestScore) { bestScore = s; best = all[i]; }
          }
          if (best) best.click();
          setTimeout(function () { if (btn) btn.click(); }, 200);
        }, 400);
      });
    }, 400);
    // 验证：3s 后没变则重试
    setTimeout(function () {
      var after = document.querySelector(".mvp-player-quality-btn");
      var afterText = after ? (after.textContent || "").trim() : "";
      if (prevText && afterText === prevText && qualityTries < 3) {
        qualityApplied = false;
      }
    }, 3000);
  }

  // ====== 倍速（仅视频） ======
  let speedApplied = false;
  let speedTries = 0;

  function clickMaxSpeedUI() {
    if (speedApplied) return;
    if (speedTries >= 3) { speedApplied = true; return; }
    // 玩家按钮不存在 = 未初始化完毕，等 poll 重试
    if (!document.querySelector(".mvp-play-rate")) {
      speedApplied = false;
      return;
    }
    speedTries++;
    var thresh = getProgressThreshold();
    var maxAllowed = thresh ? 1.75 : 99;
    // 先扫描已可见的倍速选项（菜单可能已经开着，避免toggle关闭）
    var visibleOpts = document.querySelectorAll(".mvp-play-rate");
    var best = null, bestRate = 0;
    for (var i = 0; i < visibleOpts.length; i++) {
      if (visibleOpts[i].offsetParent === null) continue;
      var t = visibleOpts[i].textContent.trim();
      if (visibleOpts[i].classList.contains("active")) continue;
      var m = t.match(/^(\d+\.?\d*)\s*[xX×]$/);
      if (m) {
        var r = parseFloat(m[1]);
        if (r <= maxAllowed && r > bestRate) { bestRate = r; best = visibleOpts[i]; }
      }
    }
    if (best) {
      best.click();
      // 点完 500ms 后验证，没变才直接设（保持 UI 同步优先）
      setTimeout(function () {
        var v = document.querySelector(".vjs-tech");
        if (v && v.playbackRate < bestRate - 0.1) {
          // 重试点击（有时第一次点没反应）
          var opts = document.querySelectorAll(".mvp-play-rate");
          for (var j = 0; j < opts.length; j++) {
            var t2 = opts[j].textContent.trim();
            if (t2.indexOf(bestRate.toFixed(2)) === 0 || t2.indexOf(bestRate.toFixed(1)) === 0 || t2.indexOf(bestRate + "X") >= 0 || t2.indexOf(bestRate + "x") >= 0) {
              opts[j].click();
              break;
            }
          }
          // 再等 400ms 还没变才直接设
          setTimeout(function () {
            var v2 = document.querySelector(".vjs-tech");
            if (v2 && v2.playbackRate < bestRate - 0.1) v2.playbackRate = bestRate;
          }, 400);
        }
      }, 500);
      return;
    }
    // 菜单未开，execInPage 打开
    execInPage(function (limit) {
      var btn = document.querySelector(".mvp-play-rate-btn");
      if (!btn) return;
      btn.click();
      setTimeout(function () {
        var bestEl = null, br = 0;
        var all = document.querySelectorAll(".mvp-play-rate");
        for (var i = 0; i < all.length; i++) {
          var t = all[i].textContent.trim();
          var m = t.match(/^(\d+\.?\d*)\s*[xX×]$/);
          if (m) {
            var r = parseFloat(m[1]);
            if (r <= limit && r > br && !all[i].classList.contains("active")) {
              br = r; bestEl = all[i];
            }
          }
        }
        if (bestEl) bestEl.click();
        setTimeout(function () {
          var v = document.querySelector(".vjs-tech");
          if (v && v.playbackRate < br - 0.1) v.playbackRate = br;
          var b = document.querySelector(".mvp-play-rate-btn");
          if (b) b.click();
        }, 300);
      }, 400);
    }, maxAllowed);
    // 沙箱侧兜底：如果 UI 点击没生效，通过 DOM 点击选项来补救
    setTimeout(function () {
      var v = document.querySelector(".vjs-tech");
      if (!v || v.playbackRate >= maxAllowed - 0.1) return;
      // 找对应倍速的 DOM 元素点击（先不改 playbackRate，保持 UI 同步）
      var vis = document.querySelectorAll(".mvp-play-rate");
      var targetEl = null, maxR = 1;
      for (var i = 0; i < vis.length; i++) {
        var m2 = vis[i].textContent.trim().match(/^(\d+\.?\d*)\s*[xX×]$/);
        if (m2) { var r2 = parseFloat(m2[1]); if (r2 <= maxAllowed && r2 > maxR) { maxR = r2; targetEl = vis[i]; } }
      }
      if (targetEl && targetEl.offsetParent !== null) {
        targetEl.click();
        // 点完 500ms 后如果还没变，才直接设 playbackRate
        setTimeout(function () {
          var v2 = document.querySelector(".vjs-tech");
          if (v2 && v2.playbackRate < maxR - 0.1) v2.playbackRate = maxR;
        }, 500);
      } else if (maxR > 1) {
        v.playbackRate = maxR;
      }
    }, 2000);
    // 验证：3s 后检查是否真的变了
    setTimeout(function () {
      var v = document.querySelector(".vjs-tech");
      if (v && v.playbackRate < 1.2 && speedTries < 3) {
        speedApplied = false;
      }
    }, 3000);
  }

  // ====== 播放中途暂停模拟 ======
  function scheduleMidPause(el) {
    if (!el || el.tagName !== "AUDIO" && el.tagName !== "VIDEO") return;
    if (Math.random() > MID_PAUSE_CHANCE) return;
    if (el.duration < 60) return; // 短内容不暂停

    const delay = randSec(
      Math.floor(el.duration * 0.4),
      Math.floor(el.duration * 0.75)
    );
    const pauseLen = randSec(MID_PAUSE_MIN_SEC, MID_PAUSE_MAX_SEC);

    midPauseTimer = setTimeout(() => {
      if (paused || breakActive || tabHidden) return;
      if (el.paused || el.ended) return;
      midPauseActive = true;
      el.pause();
      log("模拟暂停: " + (pauseLen / 1000).toFixed(0) + "s");
      status("暂停中...", "#f90");

      midPauseTimer = setTimeout(() => {
        if (paused || breakActive) return;
        midPauseActive = false;
        if (!el.paused) return;
        el.play().catch(() => {});
        log("模拟暂停结束，继续播放");
        status("播放中", "#aaa");
      }, pauseLen);
    }, delay);
  }

  // ====== 转码卡住检测 ======
  function detectStuckMessage() {
    // 扫描页面文本中是否包含转码/无法播放相关提示
    const kw = /转码|无法支持直接播放|无法播放|请等待转码|视频转码|正在转码/i;
    for (const el of document.querySelectorAll("div, span, p, .ivu-alert, .ivu-message, [class*='error'], [class*='tip'], [class*='notice'], [class*='toast']")) {
      const t = (el.textContent || "").trim();
      if (t.length > 5 && t.length < 200 && kw.test(t)) {
        return t.substring(0, 100);
      }
    }
    return null;
  }

  function isMediaStuck() {
    const media = document.querySelectorAll("video, audio");
    if (media.length === 0) return false;
    for (const el of media) {
      // 媒体 error 事件
      if (el.error) {
        log("媒体错误: code=" + el.error.code + " msg=" + (el.error.message || ""));
        return true;
      }
      // 已加载但长时间未开始播放（currentTime 一直为 0）
      if (el.readyState >= 2 && el.currentTime < 0.5 && el.duration > 0 && el.paused && !el.ended) {
        log("媒体卡住: readyState=" + el.readyState + " currentTime=" + el.currentTime);
        return true;
      }
    }
    return false;
  }

  function handleStuck() {
    clearTimeout(stuckCheckTimer);
    if (paused || breakActive || advancing) return;
    stuckRetries++;
    const msg = detectStuckMessage();
    log("检测到卡住(retry " + stuckRetries + "/" + MAX_STUCK_RETRIES + "): " + (msg || "媒体无进度"));
    status("转码中,刷新(" + stuckRetries + "/" + MAX_STUCK_RETRIES + ")", "#f90");

    if (stuckRetries > MAX_STUCK_RETRIES) {
      log("已达最大重试次数，跳过");
      status("跳过卡住活动", "#f66");
      stuckRetries = 0;
      doAdvance();
      return;
    }
    // 随机延迟后刷新
    setTimeout(() => {
      if (!paused && !breakActive) {
        unsafeWindow.location.reload();
      }
    }, rand(2000, 4000));
  }

  function startStuckCheck() {
    clearTimeout(stuckCheckTimer);
    stuckCheckTimer = setTimeout(() => {
      if (paused || breakActive || advancing) return;
      const msg = detectStuckMessage();
      if (msg || isMediaStuck()) {
        handleStuck();
      }
    }, STUCK_CHECK_SEC * 1000);
  }

  // ====== 进度阈值检测 ======
  function getProgressThreshold() {
    var scope = getScope();
    if (!scope?.currentActivity) return 0;
    var act = scope.currentActivity;
    if (act.completion_criterion_key !== "completeness") return 0;
    // completion_criterion_value 存的是阈值，如 "80"
    var val = act.completion_criterion_value;
    if (val) return parseInt(val);
    return 0;
  }


  // ====== 媒体绑定 ======
  function tryAutoPlay(el) {
    if (!el.paused || el.readyState < 1 || paused || breakActive) return;
    autoPlayAttempted = true;
    var isAudio = el.tagName === "AUDIO";
    if (isAudio) {
      el.play().catch(function () {
        var btn = document.querySelector("[ng-click*='togglePlay']");
        if (btn) btn.click();
      });
    } else {
      execInPage(function () {
        var btn = document.querySelector(".mvp-toggle-play");
        if (btn && btn.offsetParent !== null) btn.click();
      });
      el.play().catch(function () {
        var btn = document.querySelector("[ng-click*='togglePlay']");
        if (btn) btn.click();
      });
    }
    log("播放: " + el.tagName);
  }

  function bindOne(el) {
    if (watched.has(el)) return false;
    watched.add(el);

    const isVideo = el.tagName === "VIDEO";
    let nearEnd = false;
    let midPauseScheduled = false;

    el.addEventListener("loadeddata", () => {
      if (!autoPlayAttempted && !breakActive) tryAutoPlay(el);
    });
    el.addEventListener("canplay", () => {
      if (!autoPlayAttempted && !breakActive) tryAutoPlay(el);
    });
    el.addEventListener("play", () => {
      if (!midPauseScheduled) {
        midPauseScheduled = true;
        scheduleMidPause(el);
      }
    });
    el.addEventListener("timeupdate", () => {
      if (el.duration > 0 && el.duration - el.currentTime < 3 && el.currentTime > 1) {
        nearEnd = true;
      }
    });
    el.addEventListener("ended", () => {
      if (advancing || paused || breakActive) return;
      var delay = rand(2000, 5000);
      log("ended, " + (delay / 1000).toFixed(0) + "s 后跳转");
      setTimeout(() => {
        if (!advancing && !paused && !breakActive) doAdvance();
      }, delay);
    });
    el.addEventListener("pause", () => {
      if (nearEnd && !advancing && !paused && !breakActive) {
        scheduleAdvance("media_near_end");
        return;
      }
      // Watchdog: 平台因标签页失焦/最小化自动暂停 → 立即恢复
      if (!nearEnd && !paused && !breakActive && !midPauseActive && !advancing && el.currentTime > 0) {
        setTimeout(() => {
          if (!paused && !breakActive && !midPauseActive && el.paused && !el.ended) {
            var isAud = el.tagName === "AUDIO";
            if (!isAud) {
              var pb = document.querySelector(".mvp-toggle-play");
              if (pb && pb.offsetParent !== null) {
                execInPage(function () {
                  var b = document.querySelector(".mvp-toggle-play");
                  if (b) b.click();
                });
              }
            }
            // 失败重试：后台标签页 Firefox 可能拦截 play()
            var retryPlay = function (attempts) {
              el.play().then(function () {
                // play 成功
              }).catch(function () {
                if (attempts < 10 && !paused && !breakActive && el.paused && !el.ended) {
                  setTimeout(function () { retryPlay(attempts + 1); }, 2000);
                }
              });
            };
            retryPlay(0);
          }
        }, rand(200, 600));
      }
    });
    el.addEventListener("error", () => {
      log("媒体 error 事件触发");
      handleStuck();
    });

    if (el.readyState >= 1 && !autoPlayAttempted) {
      setTimeout(() => tryAutoPlay(el), rand(800, 2000));
    }
    return true;
  }

  function scanAll() {
    let hasVideo = false;
    let n = 0;
    for (const el of document.querySelectorAll("video, audio")) {
      if (bindOne(el)) {
        n++;
        if (el.tagName === "VIDEO") hasVideo = true;
      }
    }
    if (hasVideo) {
      if (!speedApplied) clickMaxSpeedUI();
      if (!qualityApplied) clickLowestQuality();
    }
    return n;
  }

  // ====== 自检 ======
  function runHealthCheck() {
    var v = document.querySelector(".vjs-tech");
    if (!v || paused || breakActive) return;
    var issues = [];
    // 倍速
    var thresh = getProgressThreshold();
    var expectedRate = thresh ? 1.75 : 2.0;
    if (v.playbackRate < expectedRate - 0.2) {
      issues.push("倍速=" + v.playbackRate.toFixed(1) + "x 预期=" + expectedRate + "x");
      // 自动重试
      speedApplied = false;
      speedTries = 0;
      clickMaxSpeedUI();
    }
    // 画质
    var qb = document.querySelector(".mvp-player-quality-btn");
    if (qb) {
      var qt = (qb.textContent || "").trim();
      // 如果还是初始画质（≥720p），尝试重试
      if (/\d+p/i.test(qt)) {
        var res = parseInt(qt);
        if (res >= 720) {
          issues.push("画质=" + qt + " 未切到最低");
          qualityApplied = false;
          qualityTries = 0;
          clickLowestQuality();
        }
      }
    }
    // 播放状态
    if (v.paused && !v.ended) {
      issues.push("视频未播放");
      tryAutoPlay(v);
    }
    if (issues.length) console.log("[AP] 自检问题:", issues.join(" | "));
  }

  // ====== View-only 定时器 ======
  function startViewOnlyTimer() {
    clearTimeout(viewOnlyTimer);
    if (breakActive) return;
    const scope = getScope();
    if (!scope?.currentActivity || !isViewOnly(scope.currentActivity)) return;
    if (paused) return;

    let delay = randSec(VIEW_MIN_SEC, VIEW_MAX_SEC);
    if (userActiveRecently(5000)) delay += randSec(10, 20);
    if (consecutiveAdvances > 5 && Math.random() < 0.3) delay += randSec(30, 60);

    log("view-only: " + (delay / 1000).toFixed(0) + "s");
    status("阅读...", "#aaa");

    viewOnlyTimer = setTimeout(() => {
      if (userActiveRecently(3000)) {
        startViewOnlyTimer();
        return;
      }
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") {
        startViewOnlyTimer();
        return;
      }
      if (!advancing && !paused && !breakActive) doAdvance();
    }, delay);
  }

  // ====== 导航 ======
  function scheduleAdvance(reason) {
    // 检查是否需要休息
    if (shouldTakeBreak()) {
      log("触发会话休息");
      startBreak();
      return;
    }
    const delay = rand(2000, 5000);
    log("计划跳转(" + reason + "), " + (delay / 1000).toFixed(1) + "s");
    setTimeout(() => {
      if (!advancing && !paused && !breakActive) doAdvance();
    }, delay);
  }

  function doAdvance() {
    if (advancing || paused || breakActive) return;
    advancing = true;
    clearTimeout(viewOnlyTimer);
    clearTimeout(midPauseTimer);
    clearTimeout(stuckCheckTimer);
    midPauseActive = false;

    const scope = getScope();
    if (!scope) { advancing = false; return; }

    let next = scope.next;
    var acts = scope.syllabus?.activities || scope.module?.directActivities || [];
    if (!next?.id) {
      var curIdx = acts.findIndex(function (a) { return a.id === scope.currentActivity?.id; });
      if (curIdx >= 0 && curIdx < acts.length - 1) next = acts[curIdx + 1];
    }

    if (!next?.id) {
      status("已到最后", "#ff0");
      advancing = false;
      return;
    }

    // 手动活动向前跳过，直到找到非手动活动
    while (next && isManual(next)) {
      var nextIdx = acts.findIndex(function (a) { return a.id === next.id; });
      if (nextIdx >= 0 && nextIdx < acts.length - 1) {
        next = acts[nextIdx + 1];
      } else {
        status("全是手动活动", "#ff0");
        advancing = false;
        return;
      }
    }

    log("前进: " + next.id + " " + next.type + " " + next.title);
    status("→ " + (next.title || "").substring(0, 22), "#aaa");
    autoPlayAttempted = false;
    speedApplied = false;
    speedTries = 0;
    qualityApplied = false;
    qualityTries = 0;
    consecutiveAdvances++;
    stuckRetries = 0;
    clearTimeout(stuckCheckTimer);

    // 模拟真人操作
    simHumanActivity();

    if (scope.changeActivity) {
      try {
        scope.$apply(() => scope.changeActivity(next));
      } catch (e) {
        const cid = scope.course?.id || scope._course?.id;
        if (cid) unsafeWindow.location.href = "https://lms.ouchn.cn/course/" + cid + "/learning-activity/full-screen#/" + next.id;
      }
    }

    const loadDelay = rand(3000, 5500);
    setTimeout(() => {
      advancing = false;
      scanAll();
      startStuckCheck();
      // 自检：8s 后验证倍速/画质/播放状态，问题自动修复
      setTimeout(() => { if (!paused && !breakActive) runHealthCheck(); }, 8000);
      setTimeout(() => {
        if (!paused && !breakActive) {
          if (shouldTakeBreak()) {
            startBreak();
          } else if (!handleReferenceActivity()) {
            startViewOnlyTimer();
          }
        }
      }, rand(1500, 3000));
    }, loadDelay);
  }

  function checkCurrentActivity() {
    if (breakActive) return;
    const scope = getScope();
    if (!scope?.currentActivity || paused) return;
    const act = scope.currentActivity;
    var cat = classifyActivity(act);
    log("当前: " + act.id + " " + classifyActivity(act) + " " + act.title);

    if (isManual(act)) {
      setTimeout(function () { if (!paused && !breakActive && !advancing) doAdvance(); }, rand(800, 2000));
      return;
    }
    if (isViewOnly(act)) {
      // 参考资料需要点击"预览"按钮
      if (handleReferenceActivity()) return;
      startViewOnlyTimer();
    } else if (classifyActivity(act) === "media") {
      startStuckCheck();
      setTimeout(() => {
        if (!breakActive) {
          for (const el of document.querySelectorAll("video, audio")) tryAutoPlay(el);
        }
      }, rand(1000, 2500));
    }
  }

  // ====== 可变轮询 ======
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (paused) return;
    const delay = rand(POLL_MIN, POLL_MAX);
    pollTimer = setTimeout(() => {
      if (!paused && !breakActive) scanAll();
      schedulePoll();
    }, delay);
  }

  // ====== 初始化 ======
  function init() {
    log("v13 | " + unsafeWindow.location.href);
    // 页面重载后恢复运行状态
    var wasRunning = JSON.parse(GM_getValue("ap_paused", "true")) === false;
    if (wasRunning) {
      paused = false;
      ind.style.background = "rgba(0,0,0,0.78)";
      ind.style.color = "#aaa";
      ind.textContent = "就绪";
      log("恢复运行状态（页面重载）");
    }
    scanAll();

    schedulePoll();
    observer = new MutationObserver(() => {
      if (!paused && !breakActive) scanAll();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 延迟检查，等页面渲染完成
    setTimeout(() => {
      if (!paused && !breakActive) checkCurrentActivity();
    }, rand(2500, 4000));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
