// popup.js —— 弹窗逻辑：智能/完整提取（支持 iframe + Shadow DOM）、批量抓取、复制、转发到 AI

let pageData = null;          // { title, url, text, markdown, selection }
let currentFormat = "text";   // text | markdown
let extractMode = "smart";    // smart | full
let batchTabs = [];

const $ = (id) => document.getElementById(id);

// ============================================================
// 在目标页面【每个 frame】里执行的提取函数（序列化注入，不能引用外部变量）
// 通过 allFrames:true 注入到包括 iframe 在内的所有框架，结果在弹窗端合并
// ============================================================
function extractPageContent(mode) {
  const NEG = /comment|sidebar|footnote|advert|adsense|banner|share|social|related|recommend|breadcrumb|copyright|login|signup|popup|cookie|subscribe|tooltip/i;
  const POS = /article|content|post|main|entry|text|detail|doc|body|page|blog|story|markdown|wiki|read|preview/i;
  const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "canvas", "video", "audio", "object", "embed", "link", "meta"]);

  // ---------- 判断某元素是否为噪音（遍历时跳过，不再克隆删除） ----------
  function shouldSkip(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (SKIP_TAGS.has(tag)) return true;
    if (el.getAttribute) {
      if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) return true;
    }
    // 内联样式隐藏的元素（深度遍历不经过渲染引擎，需要自行排除）
    if (el.style && (el.style.display === "none" || el.style.visibility === "hidden")) return true;
    const idc = ((el.className || "") + " " + (el.id || "")).toString();
    // 噪音类名 + 文本量小 → 跳过（文本量大的保护起来，防止误删正文）
    if (NEG.test(idc) && !POS.test(idc) && (el.textContent || "").length < 250) return true;
    return false;
  }

  // ---------- 取子节点：宿主元素有 shadowRoot 时进入其内部 ----------
  function childrenOf(node) {
    if (node.shadowRoot) return node.shadowRoot.childNodes;
    return node.childNodes;
  }

  // ---------- 深度纯文本提取：穿透 Shadow DOM 与 slot ----------
  // 关键：innerText/textContent 都不包含 Shadow Root 内容，
  // 而 wujie 等微前端框架把子应用整个渲染在 <wujie-app> 的 Shadow Root 里，
  // 必须自行遍历才能抓到
  const BLOCK_TAGS = new Set([
    "p", "div", "section", "article", "li", "ul", "ol", "dl", "dd", "dt",
    "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "table", "tr",
    "figcaption", "main", "aside", "details", "summary", "form", "fieldset",
    "address", "figure", "wujie-app", "micro-app",
  ]);

  function deepText(rootNode) {
    let out = "";
    function processNode(child) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent.replace(/\s+/g, " ");
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      if (shouldSkip(child)) return;
      const tag = child.tagName.toLowerCase();

      if (tag === "slot") {
        child.assignedNodes({ flatten: true }).forEach(processNode);
        return;
      }
      if (tag === "br") { out += "\n"; return; }
      if (tag === "td" || tag === "th") {
        walk(child);
        out += "\t";
        return;
      }
      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) out += "\n";
      walk(child);
      if (isBlock) out += "\n";
    }
    function walk(n) {
      childrenOf(n).forEach(processNode);
    }
    walk(rootNode);
    return out
      .replace(/[ \t]+\n/g, "\n")
      .replace(/ {2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ---------- 候选评分（innerText 基于渲染结果，天然包含 Shadow DOM 文本） ----------
  function score(el) {
    const text = el.innerText || "";
    if (text.length < 140) return 0;
    const pCount = el.querySelectorAll("p, pre, td, li, h1, h2, h3").length;
    let linkLen = 0;
    el.querySelectorAll("a").forEach((a) => { linkLen += (a.innerText || "").length; });
    const linkDensity = linkLen / Math.max(text.length, 1);
    let s = text.length * (1 - Math.min(linkDensity, 0.9)) + pCount * 25;
    const idc = ((el.className || "") + " " + (el.id || "")).toString();
    if (POS.test(idc)) s *= 1.35;
    if (NEG.test(idc)) s *= 0.35;
    return s;
  }

  function pickRoot() {
    if (mode === "full") return document.body;

    const candidates = new Set();
    ["article", "main", '[role="main"]', "wujie-app", "micro-app"].forEach((sel) =>
      document.querySelectorAll(sel).forEach((el) => candidates.add(el))
    );
    document.querySelectorAll("div, section").forEach((el) => {
      if ((el.innerText || "").length > 400) candidates.add(el);
    });

    let best = document.body, bestScore = 0;
    candidates.forEach((el) => {
      const s = score(el);
      if (s > bestScore) { best = el; bestScore = s; }
    });
    return best;
  }

  // ---------- DOM → Markdown（直接遍历活动 DOM，穿透 Shadow DOM 与 slot） ----------
  function toMd(node, ctx) {
    ctx = ctx || { listDepth: 0, ordered: false, index: 0 };
    let out = "";
    childrenOf(node).forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent.replace(/\s+/g, " ");
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      if (shouldSkip(child)) return;
      const tag = child.tagName.toLowerCase();
      const inner = () => toMd(child, ctx).trim();

      switch (tag) {
        case "slot": {
          // slot 元素：渲染的是分发进来的外部节点
          child.assignedNodes({ flatten: true }).forEach((n) => {
            if (n.nodeType === Node.TEXT_NODE) out += n.textContent.replace(/\s+/g, " ");
            else if (n.nodeType === Node.ELEMENT_NODE && !shouldSkip(n)) out += toMd(n, ctx);
          });
          break;
        }
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
          out += "\n\n" + "#".repeat(+tag[1]) + " " + inner() + "\n\n"; break;
        case "p":
          out += "\n\n" + inner() + "\n\n"; break;
        case "br":
          out += "\n"; break;
        case "strong": case "b":
          out += "**" + inner() + "**"; break;
        case "em": case "i":
          out += "*" + inner() + "*"; break;
        case "a": {
          const href = child.getAttribute("href") || "";
          const text = inner() || href;
          try {
            out += href && !href.startsWith("javascript")
              ? `[${text}](${new URL(href, location.href).href})` : text;
          } catch { out += text; }
          break;
        }
        case "img": {
          const src = child.getAttribute("src") || child.getAttribute("data-src") ||
                      child.getAttribute("data-original") || child.getAttribute("data-lazy-src");
          if (src) {
            try { out += `![${child.getAttribute("alt") || ""}](${new URL(src, location.href).href})`; }
            catch {}
          }
          break;
        }
        case "code":
          if (child.parentElement && child.parentElement.tagName === "PRE") out += child.textContent;
          else out += "`" + child.textContent + "`";
          break;
        case "pre":
          out += "\n\n```\n" + (child.innerText || child.textContent).replace(/\n$/, "") + "\n```\n\n"; break;
        case "blockquote":
          out += "\n\n" + inner().split("\n").map((l) => "> " + l).join("\n") + "\n\n"; break;
        case "ul": case "ol": {
          const sub = { listDepth: ctx.listDepth + 1, ordered: tag === "ol", index: 0 };
          out += "\n" + toMd(child, sub) + "\n";
          break;
        }
        case "li": {
          ctx.index++;
          const indent = "  ".repeat(Math.max(0, ctx.listDepth - 1));
          const bullet = ctx.ordered ? `${ctx.index}. ` : "- ";
          out += "\n" + indent + bullet + inner();
          break;
        }
        case "hr":
          out += "\n\n---\n\n"; break;
        case "table": {
          const rows = [...child.querySelectorAll("tr")].map((tr) =>
            [...tr.querySelectorAll("th,td")].map((c) =>
              (c.innerText || c.textContent || "").trim().replace(/\|/g, "\\|").replace(/\n+/g, " ")
            )
          );
          if (rows.length) {
            out += "\n\n| " + rows[0].join(" | ") + " |\n";
            out += "| " + rows[0].map(() => "---").join(" | ") + " |\n";
            rows.slice(1).forEach((r) => { out += "| " + r.join(" | ") + " |\n"; });
            out += "\n";
          }
          break;
        }
        default:
          out += toMd(child, ctx);
      }
    });
    return out;
  }

  let root = pickRoot();

  // 纯文本：深度遍历提取（穿透 Shadow DOM，兼容 wujie 等微前端）
  let text = deepText(root);

  // 覆盖率检查（基于深度文本）：智能选中的容器若漏掉了大量内容
  // （典型场景：正文渲染在 wujie-app 的 Shadow Root 里，evalText 评分感知不到），
  // 退回整页提取
  if (mode !== "full" && root !== document.body) {
    const bodyText = deepText(document.body);
    if (bodyText.length > 0 && text.length / bodyText.length < 0.5) {
      root = document.body;
      text = bodyText;
    }
  }

  const isTopFrame = window === window.top;
  const head = isTopFrame ? "# " + document.title + "\n\n> 来源：" + location.href + "\n\n" : "";
  const markdown = (head + toMd(root)).replace(/\n{3,}/g, "\n\n").trim();

  const selection = (window.getSelection() ? window.getSelection().toString() : "").trim();

  return {
    title: document.title,
    url: location.href,
    text,
    markdown,
    selection,
    isTop: isTopFrame,
  };
}

// ============================================================
// 合并多个 frame 的提取结果（主文档在前，iframe 内容追加在后）
// ============================================================
function mergeFrameResults(results) {
  const ok = (results || []).map((r) => r && r.result).filter(Boolean);
  if (!ok.length) throw new Error("提取失败，请刷新页面后重试。");

  const main = ok.find((r) => r.isTop) || ok[0];
  // 子框架：过滤掉空壳/极短的（广告、统计 iframe），并粗略去重
  const subs = ok.filter((r) => r !== main && r.text && r.text.length > 120);

  let text = main.text;
  let markdown = main.markdown;
  for (const s of subs) {
    const sample = s.text.slice(0, 200);
    if (sample && text.includes(sample)) continue; // 内容已包含，跳过
    text += "\n\n" + s.text;
    markdown += "\n\n" + s.markdown;
  }

  const selection = ok.map((r) => r.selection).find((s) => s) || "";
  return { title: main.title, url: main.url, text, markdown, selection };
}

// ============================================================
// 单页提取
// ============================================================
function showManualStart() {
  $("manualStart").classList.add("show");
  $("preview").style.display = "none";
  $("error").style.display = "none";
  $("meta").innerHTML = "";
  $("stats").textContent = "";
}

function hideManualStart() {
  $("manualStart").classList.remove("show");
  $("preview").style.display = "block";
}

async function init() {
  hideManualStart();
  $("error").style.display = "none";
  $("preview").textContent = "正在提取页面内容…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || /^(chrome|edge|about|chrome-extension):/.test(tab.url || "")) {
      throw new Error("当前页面是浏览器内部页面，无法抓取。请在普通网页上使用。");
    }
    // allFrames: 注入到页面里的所有框架（含 iframe），一并提取后合并
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: extractPageContent,
      args: [extractMode],
    });
    pageData = mergeFrameResults(results);
    render();
  } catch (e) {
    pageData = null;
    $("preview").textContent = "";
    const err = $("error");
    err.style.display = "block";
    err.textContent = e.message || "提取失败，请刷新页面后重试。";
  }
}

// ============================================================
// 启动：读取设置，决定自动提取还是等待手动触发
// ============================================================
async function startup() {
  let autoOn = true;
  try {
    const saved = await chrome.storage.sync.get({ autoExtract: true });
    autoOn = saved.autoExtract;
  } catch {}
  $("autoExtract").checked = autoOn;
  if (autoOn) init();
  else showManualStart();
}

// ============================================================
// 批量抓取
// ============================================================
async function loadTabList() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  batchTabs = tabs.filter((t) => t.url && !/^(chrome|edge|about|chrome-extension):/.test(t.url));

  const list = $("tabList");
  list.innerHTML = "";
  batchTabs.forEach((t) => {
    const item = document.createElement("label");
    item.className = "tab-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.tabId = t.id;
    const icon = document.createElement("img");
    icon.src = t.favIconUrl || "icons/icon16.png";
    icon.onerror = () => { icon.src = "icons/icon16.png"; };
    const title = document.createElement("span");
    title.textContent = t.title || t.url;
    item.append(cb, icon, title);
    list.appendChild(item);
  });
  updateBatchCount();
}

function selectedTabIds() {
  return [...document.querySelectorAll("#tabList input:checked")].map((cb) => +cb.dataset.tabId);
}

function updateBatchCount() {
  $("batchCount").textContent = `已选 ${selectedTabIds().length} / ${batchTabs.length} 个`;
}

async function batchGrab() {
  const ids = selectedTabIds();
  if (!ids.length) return;

  const btn = $("batchGrab");
  btn.disabled = true;
  btn.textContent = `抓取中… 0/${ids.length}`;

  const results = [];
  let done = 0;
  for (const tabId of ids) {
    const tabInfo = batchTabs.find((t) => t.id === tabId);
    try {
      const frameResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: extractPageContent,
        args: [extractMode],
      });
      results.push(mergeFrameResults(frameResults));
    } catch {
      results.push({
        title: (tabInfo && tabInfo.title) || "未知页面",
        url: (tabInfo && tabInfo.url) || "",
        text: "（该页面抓取失败，可能需要先打开并加载它）",
        markdown: "（该页面抓取失败，可能需要先打开并加载它）",
        selection: "",
      });
    }
    done++;
    btn.textContent = `抓取中… ${done}/${ids.length}`;
  }

  const mergedText = results
    .map((r) => `【${r.title}】\n${r.url}\n\n${r.text}`)
    .join("\n\n========================================\n\n");
  const mergedMd = results.map((r) => r.markdown).join("\n\n---\n\n");

  pageData = {
    title: `已抓取 ${results.length} 个标签页`,
    url: "",
    text: mergedText,
    markdown: mergedMd,
    selection: "",
  };
  render();

  btn.disabled = false;
  btn.textContent = "抓取选中的标签页";
}

// ============================================================
// 渲染与复制
// ============================================================
function getContent() {
  return currentFormat === "markdown" ? pageData.markdown : pageData.text;
}

function render() {
  if (!pageData) return;
  $("meta").innerHTML = `<b>${escapeHtml(pageData.title)}</b>`;
  const content = getContent();
  $("preview").textContent = content.slice(0, 3000) + (content.length > 3000 ? "\n…（预览已截断）" : "");
  $("stats").textContent = `共 ${content.length.toLocaleString()} 字符` +
    (pageData.selection ? ` ｜ 已选中 ${pageData.selection.length} 字符` : "");
  $("copySelection").disabled = !pageData.selection;
  $("copySelection").style.opacity = pageData.selection ? 1 : 0.45;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = "✓ 已复制";
  btn.classList.add("copied");
  setTimeout(() => { btn.textContent = old; btn.classList.remove("copied"); }, 1200);
}

// ============================================================
// 事件绑定
// ============================================================
$("formatSeg").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-format]");
  if (!btn) return;
  currentFormat = btn.dataset.format;
  document.querySelectorAll("#formatSeg button").forEach((b) => b.classList.toggle("active", b === btn));
  render();
});

$("modeSeg").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn || btn.dataset.mode === extractMode) return;
  extractMode = btn.dataset.mode;
  document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("active", b === btn));
  if (!$("batchPanel").classList.contains("show") && pageData) init();
});

// 重新提取：页面内容变动后（展开折叠区、SPA 加载新内容）点这里刷新
$("refreshBtn").addEventListener("click", () => {
  if (!$("batchPanel").classList.contains("show")) init();
  else batchGrab();
});

$("manualStartBtn").addEventListener("click", init);

// 自动提取开关（设置保存，下次打开弹窗生效）
$("autoExtract").addEventListener("change", (e) => {
  const on = e.target.checked;
  try { chrome.storage.sync.set({ autoExtract: on }); } catch {}
  if (on && !pageData) init();
});

$("batchToggle").addEventListener("click", () => {
  const panel = $("batchPanel");
  const on = !panel.classList.contains("show");
  panel.classList.toggle("show", on);
  $("batchToggle").classList.toggle("on", on);
  if (on) loadTabList();
});

$("selectAll").addEventListener("change", (e) => {
  document.querySelectorAll("#tabList input").forEach((cb) => { cb.checked = e.target.checked; });
  updateBatchCount();
});

$("tabList").addEventListener("change", updateBatchCount);
$("batchGrab").addEventListener("click", batchGrab);

$("copyAll").addEventListener("click", (e) => pageData && copy(getContent(), e.target));
$("copySelection").addEventListener("click", (e) => pageData?.selection && copy(pageData.selection, e.target));
$("copyLink").addEventListener("click", (e) => {
  if (!pageData) return;
  const s = currentFormat === "markdown"
    ? `[${pageData.title}](${pageData.url})`
    : `${pageData.title}\n${pageData.url}`;
  copy(s, e.target);
});

document.querySelector(".forward-btns").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-target]");
  if (!btn || !pageData) return;

  const preset = $("preset").value;
  const body = pageData.selection || getContent();
  const content = preset ? `${preset}\n\n${body}` : body;

  try { await navigator.clipboard.writeText(content); } catch {}
  chrome.runtime.sendMessage({ action: "forward", target: btn.dataset.target, content });
});

startup();
