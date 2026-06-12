// background.js —— 后台处理转发：打开 AI 站点新标签页并自动填入内容
// 必须放在后台执行，因为新标签页打开后弹窗会立即关闭，弹窗里的代码会被中断

const SITES = {
  claude:  { base: "https://claude.ai/new",        supportsUrlPrefill: true  },
  chatgpt: { base: "https://chatgpt.com/",          supportsUrlPrefill: true  },
  gemini:  { base: "https://gemini.google.com/app", supportsUrlPrefill: false },
};

// URL 传参的安全长度上限（超过则改用脚本注入方式）
const URL_PREFILL_LIMIT = 3500;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "forward") {
    forwardTo(msg.target, msg.content);
    sendResponse({ ok: true });
  }
  return false;
});

async function forwardTo(target, content) {
  const site = SITES[target];
  if (!site) return;

  // 内容较短时优先用 URL 参数预填（最稳定，不依赖页面 DOM 结构）
  if (site.supportsUrlPrefill && content.length <= URL_PREFILL_LIMIT) {
    const url = target === "claude"
      ? `${site.base}?q=${encodeURIComponent(content)}`
      : `${site.base}?q=${encodeURIComponent(content)}`;
    await chrome.tabs.create({ url });
    return;
  }

  // 长内容 / Gemini：打开页面后注入脚本，把内容写进输入框
  const tab = await chrome.tabs.create({ url: site.base });

  chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
    if (tabId !== tab.id || info.status !== "complete") return;
    chrome.tabs.onUpdated.removeListener(listener);

    chrome.scripting.executeScript({
      target: { tabId },
      func: injectIntoChatInput,
      args: [target, content],
    }).catch(() => {
      // 注入失败也没关系：内容已在剪贴板，用户可直接粘贴
    });
  });
}

// ===== 在 AI 站点页面里运行（不能引用外部变量）=====
function injectIntoChatInput(target, content) {
  const SELECTORS = {
    claude: [
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"]',
    ],
    chatgpt: [
      "#prompt-textarea",
      'div[contenteditable="true"]',
      "textarea",
    ],
    gemini: [
      'rich-textarea .ql-editor[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"]',
    ],
  }[target] || ['div[contenteditable="true"]', "textarea"];

  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    let el = null;
    for (const s of SELECTORS) {
      el = document.querySelector(s);
      if (el) break;
    }

    if (el) {
      clearInterval(timer);
      el.focus();

      if (el.tagName === "TEXTAREA") {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype, "value"
        ).set;
        setter.call(el, content);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        // contenteditable：优先 insertText（能正确触发框架的状态更新）
        const ok = document.execCommand("insertText", false, content);
        if (!ok) {
          el.textContent = content;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: content }));
        }
      }
    } else if (tries > 40) {
      // 约 20 秒后放弃；内容已在剪贴板，用户可手动粘贴
      clearInterval(timer);
    }
  }, 500);
}
