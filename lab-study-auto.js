/*
 * 实验室安全教育平台：按页面显示的实际学习时长自动切换必学和选学章节。
 * 使用方法见同目录的 README.md。
 * 停止命令：window.labStudyAutoNext.stop()
 */
(() => {
  "use strict";

  const expectedHost = "sysaq.ustc.edu.cn";
  const expectedPath = "/lab-study-front/examTask/";
  if (location.hostname !== expectedHost || !location.pathname.startsWith(expectedPath)) {
    alert("请先打开实验室安全教育平台的学习详情页。脚本没有运行。");
    return;
  }

  if (window.labStudyAutoNext) {
    window.labStudyAutoNext.stop();
  }
  document.getElementById("lab-study-auto-next-panel")?.remove();

  const state = {
    stopped: false,
    paused: false,
    busy: false,
    completedRows: new WeakSet(),
    completedTitles: [],
    initialTotals: null,
    events: [],
    lastTitle: "",
    lastRow: null,
    lastSeconds: -1,
    lastProgressAt: Date.now(),
    timer: null,
  };

  const panel = document.createElement("div");
  panel.id = "lab-study-auto-next-panel";
  panel.style.cssText = [
    "position:fixed", "right:20px", "bottom:20px", "width:340px",
    "z-index:2147483647", "background:#13263e", "color:#fff",
    "padding:14px", "border:2px solid #22c55e", "border-radius:10px", "box-shadow:0 4px 20px #0005",
    "font:14px/1.55 system-ui,sans-serif"
  ].join(";");
  panel.innerHTML = '<strong>学习自动切换</strong> <span id="lab-study-auto-next-badge">准备中</span>' +
    '<div id="lab-study-auto-next-status" style="margin:8px 0;white-space:pre-wrap"></div>' +
    '<div id="lab-study-auto-next-meta" style="font-size:12px;color:#cbd5e1;margin-bottom:8px"></div>' +
    '<details style="margin-bottom:8px"><summary>最近事件</summary><pre id="lab-study-auto-next-log" style="white-space:pre-wrap;font:12px/1.4 system-ui,sans-serif;max-height:150px;overflow:auto"></pre></details>' +
    '<button id="lab-study-auto-next-pause" type="button" style="margin-right:8px">暂停</button>' +
    '<button id="lab-study-auto-next-stop" type="button">停止</button>';
  document.body.appendChild(panel);
  const statusElement = panel.querySelector("#lab-study-auto-next-status");
  const badgeElement = panel.querySelector("#lab-study-auto-next-badge");
  const metaElement = panel.querySelector("#lab-study-auto-next-meta");
  const logElement = panel.querySelector("#lab-study-auto-next-log");
  const pauseButton = panel.querySelector("#lab-study-auto-next-pause");

  function report(message, level = "running", record = false) {
    const labels = { running: "运行中", warning: "需处理", error: "异常停止", done: "已完成", stopped: "已停止" };
    const colors = { running: "#22c55e", warning: "#f59e0b", error: "#ef4444", done: "#38bdf8", stopped: "#94a3b8" };
    panel.style.borderColor = colors[level];
    badgeElement.textContent = labels[level];
    badgeElement.style.color = colors[level];
    statusElement.textContent = message;
    const doneMust = state.completedTitles.filter(item => item.kind === "必学").length;
    const doneOptional = state.completedTitles.filter(item => item.kind === "选学").length;
    const totals = state.initialTotals;
    metaElement.textContent = totals
      ? `本次处理：必学 ${doneMust}/${totals.must} · 选学 ${doneOptional}/${totals.optional} · 更新 ${new Date().toLocaleTimeString()}`
      : `更新 ${new Date().toLocaleTimeString()}`;
    if (record) {
      state.events.push(`${new Date().toLocaleTimeString()} ${message.replace(/\n/g, " ")}`);
      state.events = state.events.slice(-8);
      logElement.textContent = state.events.join("\n");
      console.info("[学习自动切换]", message);
    }
  }

  function stop(message = "已停止。", level = "stopped") {
    state.stopped = true;
    clearInterval(state.timer);
    report(message, level, true);
    pauseButton.disabled = true;
    window.labStudyAutoNext = null;
  }

  function pause(message) {
    state.paused = true;
    pauseButton.textContent = "继续";
    report(message, "warning", true);
  }

  function resume() {
    state.paused = false;
    state.lastProgressAt = Date.now();
    pauseButton.textContent = "暂停";
    report("已继续；正在检查当前章节。", "running", true);
    void tick();
  }

  function seconds(text) {
    const parts = String(text).trim().match(/^\d{1,3}(?::\d{1,2}){1,2}$/)?.[0].split(":").map(Number);
    if (!parts || parts.some(n => !Number.isFinite(n))) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  function title(row) {
    return row.querySelector(".itemTitle")?.textContent.replace(/^\s*(必学|选学)\s*/, "").trim() || "";
  }

  function studyRows() {
    return [...document.querySelectorAll(".task_auto .m-left li.panelItem")]
      .filter(row => row.querySelector(".must, .selectstyle"));
  }

  function kind(row) {
    return row.querySelector(".must") ? "必学" : "选学";
  }

  function isFinished(row) {
    return state.completedRows.has(row) ||
      !!row.querySelector(".ivu-icon-md-checkmark-circle");
  }

  function visibleModal() {
    return [...document.querySelectorAll(".ivu-modal-wrap")]
      .find(modal => getComputedStyle(modal).display !== "none" &&
        !modal.classList.contains("ivu-modal-hidden") &&
        modal.getBoundingClientRect().width > 0);
  }

  async function handleModal() {
    const modal = visibleModal();
    if (!modal) return false;
    const message = modal.textContent;
    if (message.includes("你已经在此页面") && message.includes("秒后自动退出")) {
      const confirm = [...modal.querySelectorAll("button")]
        .find(button => button.textContent.trim() === "确定");
      if (confirm) {
        confirm.click();
        state.lastProgressAt = Date.now();
        report("已处理平台的空闲继续提示，正在等待计时恢复。", "running", true);
        await sleep(500);
        return true;
      }
    }
    pause("页面出现了未识别的确认框。请手动处理，再点“继续”。");
    return true;
  }

  function currentTimes() {
    const read = selector => document.querySelector(selector)?.textContent.trim();
    return {
      studied: seconds(read(".task_auto .alredyTime")),
      required: seconds(read(".task_auto .allTime")),
    };
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function nextOfKind(rows, active, requestedKind) {
    const activeIndex = rows.indexOf(active);
    return rows.slice(activeIndex + 1).find(row => kind(row) === requestedKind && !isFinished(row)) ||
      rows.slice(0, activeIndex).find(row => kind(row) === requestedKind && !isFinished(row));
  }

  async function chooseStartingChapter() {
    const rows = studyRows();
    if (!rows.length) {
      stop("没有找到章节，请确认学习详情页已加载完成后重试。", "error");
      return false;
    }
    state.initialTotals = {
      must: rows.filter(row => kind(row) === "必学" && !isFinished(row)).length,
      optional: rows.filter(row => kind(row) === "选学" && !isFinished(row)).length,
    };
    const current = document.querySelector(".task_auto .m-left li.panelItem.activeitem");
    const preview = rows.slice(0, 12).map((row, index) => `${index + 1}. [${kind(row)}] ${title(row)}`).join("\n");
    const answer = window.prompt(
      `请输入起始章节的完整名称，或当前列表序号。\n共找到 ${rows.length} 项（含必学和选学）：\n${preview}\n同名章节请用序号。`,
      current ? title(current) : ""
    );
    if (answer === null) {
      stop("你取消了起始章节选择，脚本未启动。");
      return false;
    }
    const input = answer.trim().replace(/^(必学|选学)\s*/, "");
    if (!input) {
      stop("没有输入起始章节，脚本未启动。");
      return false;
    }
    const number = /^\d+$/.test(input) ? Number(input) : null;
    const matches = number === null ? rows.filter(row => title(row) === input) : [];
    if (matches.length > 1) {
      stop(`“${input}”有 ${matches.length} 个同名章节，请按清单中的序号重新运行脚本。`, "error");
      return false;
    }
    const target = number === null ? matches[0] : rows[number - 1];
    if (!target) {
      stop(`没找到起始章节“${input}”。请核对名称或序号，然后重新运行脚本。`, "error");
      return false;
    }
    const selectedTitle = title(target);
    if (!target.classList.contains("activeitem")) {
      target.scrollIntoView({ block: "nearest" });
      target.click();
      await sleep(900);
      if (await handleModal() && state.paused) {
        return true;
      }
      const active = document.querySelector(".task_auto .m-left li.panelItem.activeitem");
      if (active !== target) {
        stop(`没能打开起始章节“${selectedTitle}”，请重新运行脚本。`, "error");
        return false;
      }
    }
    state.lastRow = target;
    state.lastTitle = selectedTitle;
    state.lastSeconds = -1;
    state.lastProgressAt = Date.now();
    report(`起始章节：[${kind(target)}] ${selectedTitle}\n正在等待该章的页面计时达到要求。`, "running", true);
    return true;
  }

  async function chooseNext() {
    const rows = studyRows();
    const active = rows.find(row => row.classList.contains("activeitem"));
    if (!active) {
      pause("找不到当前章节，无法选择下一项。");
      return false;
    }
    const ownKind = kind(active);
    const next = nextOfKind(rows, active, ownKind) ||
      rows.find(row => kind(row) !== ownKind && !isFinished(row));
    if (!next) {
      stop("当前列表中的必学与选学章节均已处理。\n请等待平台更新后核对顶部累计时长。", "done");
      return false;
    }

    const nextTitle = title(next);
    next.scrollIntoView({ block: "nearest" });
    next.click();
    await sleep(900);
    if (!location.pathname.startsWith(expectedPath)) {
      stop("页面已跳转，可能进入视频或微课堂；请手动处理后再运行脚本。", "error");
      return false;
    }
    if (await handleModal()) {
      return false;
    }
    const nowActive = document.querySelector(".task_auto .m-left li.panelItem.activeitem");
    if (nowActive !== next) {
      pause(`未能确认已切换到“${nextTitle}”，请检查页面后再继续。`);
      return false;
    }
    state.lastRow = next;
    state.lastTitle = nextTitle;
    state.lastSeconds = -1;
    state.lastProgressAt = Date.now();
    report(`已切换到：[${kind(next)}] ${nextTitle}\n等页面显示达到要求时长后继续。`, "running", true);
    return true;
  }

  async function tick() {
    if (state.stopped || state.paused || state.busy) return;
    state.busy = true;
    try {
      if (!location.pathname.startsWith(expectedPath)) {
        stop("已离开学习详情页，脚本停止。", "error");
        return;
      }
      if (await handleModal()) {
        return;
      }
      const active = document.querySelector(".task_auto .m-left li.panelItem.activeitem");
      if (!active) {
        pause("找不到当前章节。请手动打开一项，再点“继续”。");
        return;
      }
      const activeTitle = title(active);
      const { studied, required } = currentTimes();
      if (studied === null || required === null || required <= 0) {
        if (Date.now() - state.lastProgressAt > 90000) {
          pause(`“${activeTitle}”的计时信息超过 90 秒没有载入。请检查网络或页面状态。`);
          return;
        }
        report(`等待“${activeTitle}”的计时信息载入。`);
        return;
      }
      if (active !== state.lastRow || studied !== state.lastSeconds) {
        state.lastRow = active;
        state.lastTitle = activeTitle;
        state.lastSeconds = studied;
        state.lastProgressAt = Date.now();
      }
      if (isFinished(active) && studied >= required) {
        report(`已完成的章节：[${kind(active)}] ${activeTitle}。正在跳过。`, "running", true);
        await chooseNext();
        return;
      }
      // 留出几秒余量，避免刚好达到阈值时服务端记录仍差一秒。
      if (studied >= required + 3) {
        if (!state.completedRows.has(active)) {
          state.completedRows.add(active);
          state.completedTitles.push({ kind: kind(active), title: activeTitle });
        }
        report(`已达到要求：[${kind(active)}] ${activeTitle}（${studied}/${required} 秒）。正在切换。`, "running", true);
        await chooseNext();
        return;
      }
      if (Date.now() - state.lastProgressAt > 90000) {
        pause(`“${activeTitle}”的页面计时超过 90 秒没有增加。\n请检查标签页是否在后台、网络是否正常，再点“继续”。`);
        return;
      }
      const background = document.hidden ? "\n注意：标签页在后台，浏览器可能放慢计时。" : "";
      report(`[${kind(active)}] ${activeTitle}\n已学 ${studied} 秒 / 要求 ${required} 秒（再留 3 秒余量）。${background}`);
    } catch (error) {
      pause(`脚本遇到错误：${error.message}\n请查看控制台并手动处理。`);
      console.error("[学习自动切换]", error);
    } finally {
      state.busy = false;
    }
  }

  pauseButton.addEventListener("click", () => state.paused ? resume() : pause("已暂停，点击“继续”恢复。"));
  panel.querySelector("#lab-study-auto-next-stop").addEventListener("click", () => stop());
  window.labStudyAutoNext = {
    stop, pause, resume,
    status: () => ({
      stopped: state.stopped, paused: state.paused, current: state.lastTitle,
      completed: [...state.completedTitles], events: [...state.events],
      lastProgressAt: new Date(state.lastProgressAt).toLocaleString()
    })
  };
  report("请选择起始章节。");
  void chooseStartingChapter().then(started => {
    if (!started || state.stopped) return;
    state.timer = setInterval(() => void tick(), 3000);
    void tick();
  }).catch(error => {
    console.error("[学习自动切换]", error);
    stop(`选择起始章节时出错：${error.message}`, "error");
  });
})();
