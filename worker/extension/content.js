// Content Script (content.js)
// Injected into https://chatgpt.com/*
// Directly handles DOM interaction: inputting text, clicking send, and streaming answers.

(function () {
  'use strict';

  console.log('[ChatGPT Worker Extension] Content script initializing on ' + location.href);

  // Floating Status Pill in ChatGPT UI (reuse if already present)
  let badge = document.getElementById('lgw-chatgpt-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'lgw-chatgpt-badge';
    badge.style.position = 'fixed';
    badge.style.top = '12px';
    badge.style.right = '80px';
    badge.style.padding = '6px 14px';
    badge.style.borderRadius = '16px';
    badge.style.fontSize = '12px';
    badge.style.fontWeight = 'bold';
    badge.style.zIndex = '999999';
    badge.style.boxShadow = '0 2px 8px rgba(0,0,0,0.25)';
    badge.style.transition = 'all 0.3s ease';
    badge.style.background = '#27ae60';
    badge.style.color = '#ffffff';
    badge.innerText = 'Worker Bridge: Ready';
    document.body.appendChild(badge);
  } else {
    badge.style.background = '#27ae60';
    badge.innerText = 'Worker Bridge: Ready';
  }

  function updateBadge(state, text) {
    if (state === 'busy') {
      badge.style.background = '#f39c12';
      badge.innerText = text || 'Worker: Generating...';
    } else if (state === 'disconnected') {
      badge.style.background = '#e74c3c';
      badge.innerText = text || 'Worker: Disconnected';
    } else {
      badge.style.background = '#27ae60';
      badge.innerText = text || 'Worker Bridge: Ready';
    }
  }

  let isCurrentlyGenerating = false;

  // Keep background service worker awake and verify connection
  setInterval(() => {
    try {
      chrome.runtime.sendMessage({ action: 'ping' }, (res) => {
        if (chrome.runtime.lastError) {
          if (!isCurrentlyGenerating) updateBadge('disconnected', 'Worker: Disconnected');
          return;
        }
        if (res && res.connected) {
          if (!isCurrentlyGenerating) updateBadge('ready');
        } else {
          if (!isCurrentlyGenerating) updateBadge('disconnected', 'Worker: Connecting...');
        }
      });
    } catch {}
  }, 2500);

  // --- Input Helper (ProseMirror & Rich-Text Compatible) ---
  function setPromptText(inputEl, text) {
    inputEl.focus();
    if (inputEl.getAttribute('contenteditable') === 'true') {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, text);
    } else {
      inputEl.value = text;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // --- Task Message Listener from background / popup ---
  if (window.__LGW_CHATGPT_HANDLER) {
    try {
      chrome.runtime.onMessage.removeListener(window.__LGW_CHATGPT_HANDLER);
    } catch {}
  }
  window.__LGW_CHATGPT_HANDLER = (request, sender, sendResponse) => {
    if (request.action === 'readiness') {
      const input = document.querySelector('#prompt-textarea, div[contenteditable="true"], textarea');
      sendResponse({ ready: !!input && !input.disabled && input.getAttribute('contenteditable') !== 'false' && input.getClientRects().length > 0 });
      return;
    }
    if (request.action === 'prompt') {
      executePrompt(request, sendResponse);
      return true; // Keep channel open for asynchronous sendResponse
    }
  };
  chrome.runtime.onMessage.addListener(window.__LGW_CHATGPT_HANDLER);

  function getAssistantResponseText() {
    const main = document.querySelector('main');
    if (!main) return '';
    const text = main.innerText || '';
    const parts = text.split(/ChatGPT said:\s*/i);
    if (parts.length < 2) return '';
    const lastPart = parts[parts.length - 1];
    let answer = lastPart.split(/You said:\s*/i)[0].trim();
    // Clean trailing ChatGPT footer disclaimers
    answer = answer.replace(/\n*ChatGPT can make mistakes[\s\S]*$/i, '').trim();
    return answer;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const findInput = () => document.querySelector('#prompt-textarea') ||
                          document.querySelector('div[contenteditable="true"]') ||
                          document.querySelector('textarea');

  // Every prompt starts in a new, temporary chat: earlier prompts in the tab must not steer the answer, and a
  // temporary chat does not read the account's memory. The model is never touched (ChatGPT's default).
  const hasConversation = () => !!document.querySelector('[data-message-author-role]') ||
    /You said:/i.test(String(document.querySelector('main')?.innerText || ''));
  const tempToggle = () => [...document.querySelectorAll('button, a, [role="switch"]')]
    .find((e) => /temporary/i.test((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('data-testid') || '') + ' ' + (e.innerText || '').slice(0, 40)));
  const isTemporary = () => {
    const t = tempToggle();
    const label = t ? (t.getAttribute('aria-label') || t.innerText || '') : '';
    return /turn off temporary/i.test(label) || t?.getAttribute('aria-pressed') === 'true' || t?.getAttribute('aria-checked') === 'true' ||
      /temporary chat/i.test(String(document.querySelector('main')?.innerText || '').slice(0, 400));
  };
  async function openFreshChat() {
    if (hasConversation()) {
      for (const b of document.querySelectorAll('a[data-testid="create-new-chat-button"], button[data-testid="create-new-chat-button"], button[aria-label="New chat" i], a[aria-label="New chat" i]')) {
        b.click();
        for (let i = 0; i < 10 && hasConversation(); i++) await sleep(200);
        if (!hasConversation()) break;
      }
    }
    if (hasConversation()) {
      // ChatGPT's own shortcut for a new chat.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true, bubbles: true }));
      for (let i = 0; i < 15 && hasConversation(); i++) await sleep(200);
    }
    for (let i = 0; i < 25 && !findInput(); i++) await sleep(200);
    if (!hasConversation() && !isTemporary()) {
      const t = tempToggle();
      if (t) { t.click(); await sleep(800); }
    }
    for (let i = 0; i < 25 && !findInput(); i++) await sleep(200);
    const unpersonalized = await chooseUnpersonalized();
    return { fresh: !hasConversation(), temporary: isTemporary(), unpersonalized };
  }

  // A temporary chat is "Personalized" by default: it can read the account's memory and custom instructions. The
  // "Unpersonalized" choice of that menu makes this one chat ignore them, so the answer is what a stranger would get.
  const press = (el) => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const E = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new E(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true }));
    }
    el.click();
  };
  async function chooseUnpersonalized() {
    const radio = () => [...document.querySelectorAll('[role="menuitemradio"]')].find((e) => /^\s*Unpersonali[sz]ed/i.test(e.innerText || ''));
    const trigger = [...document.querySelectorAll('button')].find((e) => /^\s*(Un)?personali[sz]ed\s*$/i.test(String(e.innerText || '')));
    if (!trigger) return false;
    if (/^\s*Unpersonali/i.test(trigger.innerText || '')) return true;
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true }));
    for (let i = 0; i < 10 && !radio(); i++) await sleep(150);
    const r = radio();
    if (!r) return false;
    press(r);
    await sleep(600);
    if (document.querySelector('[role="menu"]')) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    const now = [...document.querySelectorAll('button')].find((e) => /^\s*(Un)?personali[sz]ed\s*$/i.test(String(e.innerText || '')));
    return !!now && /^\s*Unpersonali/i.test(now.innerText || '');
  }

  const pageState = (chat) => ({
    url: location.href, chat, conversation: hasConversation(),
    controls: [...document.querySelectorAll('a[href="/"], [data-testid*="chat" i], [aria-label*="chat" i], [aria-label*="temporary" i], [data-testid*="temporary" i]')]
      .filter((e) => !/Pin chat|Chat actions/.test(e.getAttribute('aria-label') || '')).slice(0, 20)
      .map((e) => [e.tagName, e.getAttribute('data-testid'), e.getAttribute('aria-label'), e.getAttribute('href'), e.getAttribute('aria-pressed'), e.getAttribute('aria-checked')].filter(Boolean).join('|')),
    personal: [...document.querySelectorAll('button, [role="switch"], [role="menuitem"], [role="menuitemcheckbox"], label')]
      .filter((e) => /personali|memory/i.test((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')))
      .slice(0, 10).map((e) => [e.tagName, e.getAttribute('role'), e.getAttribute('data-testid'), e.getAttribute('aria-label'), e.getAttribute('aria-pressed'), e.getAttribute('aria-checked'), e.getAttribute('aria-haspopup'), String(e.innerText || '').slice(0, 60)].filter(Boolean).join('|')),
    answers: document.querySelectorAll('[data-message-author-role="assistant"]').length,
    turns: document.querySelectorAll('article, [data-testid^="conversation-turn"]').length,
    top: String((document.querySelector('main') || document.body).innerText || '').slice(0, 300),
  });

  async function executePrompt(task, sendResponse) {
    isCurrentlyGenerating = true;
    updateBadge('busy', 'Worker: Opening a new chat...');
    let chat = { fresh: false, temporary: false };
    if (task.freshChat !== false) {
      try { chat = await openFreshChat(); } catch (err) { console.log('[ChatGPT Worker Extension] new chat failed: ' + err.message); }
    }
    // A health check of the page itself: nothing is sent to ChatGPT.
    if (task.prompt === '__LGW_PAGE_STATE__') {
      isCurrentlyGenerating = false;
      updateBadge('ready');
      sendResponse({ id: task.id, type: 'error', error: 'page state: ' + JSON.stringify(pageState(chat)) });
      return;
    }
    if (task.freshChat !== false && !chat.fresh) {
      // The page would not leave the old chat: load a new temporary chat and ask the caller to send again.
      isCurrentlyGenerating = false;
      updateBadge('busy', 'Worker: Reloading into a new chat...');
      sendResponse({ id: task.id, type: 'error', error: 'the ChatGPT tab could not leave the old chat; it is reloading into a new temporary chat, send the prompt again: ' + JSON.stringify(pageState(chat)) });
      setTimeout(() => location.assign('https://chatgpt.com/?temporary-chat=true'), 300);
      return;
    }
    updateBadge('busy', 'Worker: Entering prompt...');

    const promptInput = findInput();
    if (!promptInput) {
      isCurrentlyGenerating = false;
      updateBadge('ready');
      sendResponse({
        id: task.id,
        type: 'error',
        error: '#prompt-textarea input element not found on chatgpt.com'
      });
      return;
    }

    // Capture the current answer BEFORE sending, so we know when the NEW answer appears
    const initialAnswer = getAssistantResponseText();

    // Set text
    setPromptText(promptInput, task.prompt);
    await new Promise((r) => setTimeout(r, 350));

    // Find and click Send Button
    const sendBtn = document.querySelector('button[data-testid="send-button"]') ||
                    document.querySelector('button[data-testid="fruitjuice-send-button"]') ||
                    document.querySelector('button[aria-label*="Send"]') ||
                    document.querySelector('form button[type="submit"]');

    if (!sendBtn) {
      isCurrentlyGenerating = false;
      updateBadge('ready');
      sendResponse({
        id: task.id,
        type: 'error',
        error: 'Send button not found or disabled'
      });
      return;
    }

    sendBtn.click();
    updateBadge('busy', 'Worker: Generating answer...');

    let lastAnswer = '';
    let started = false;
    let stableTicks = 0;
    const startTime = Date.now();

    const poller = setInterval(() => {
      const isStopBtnVisible = !!document.querySelector(
        'button[data-testid="stop-button"], button[aria-label*="Stop"]'
      );
      const currentText = getAssistantResponseText();

      // If text changed from before send, or stop button appeared, generation has started
      if (isStopBtnVisible || (currentText.length > 0 && currentText !== initialAnswer)) {
        started = true;
      }

      if (currentText.length > 0 && currentText !== initialAnswer) {
        if (currentText === lastAnswer) {
          stableTicks++;
        } else {
          stableTicks = 0;
          lastAnswer = currentText;
        }
      }

      // Check for error banners
      const errorBanner = document.querySelector('div[class*="border-red-"]');
      if (errorBanner && errorBanner.innerText) {
        clearInterval(poller);
        updateBadge('ready');
        sendResponse({
          id: task.id,
          type: 'error',
          error: errorBanner.innerText.trim()
        });
        return;
      }

      // Nothing started 30 s after Send: say what the page looks like instead of waiting out the bridge's timeout.
      if (!started && Date.now() - startTime > 30000) {
        clearInterval(poller);
        isCurrentlyGenerating = false;
        updateBadge('ready');
        const input = findInput();
        const btn = document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"]');
        sendResponse({
          id: task.id,
          type: 'error',
          error: 'the prompt did not start: ' + JSON.stringify({
            url: location.href, chat, input: input ? (input.id || input.tagName) + ':' + String(input.innerText || input.value || '').slice(0, 60) : null,
            send: btn ? (btn.disabled ? 'disabled' : 'enabled') : 'missing',
            main: String((document.querySelector('main') || document.body).innerText || '').slice(-200),
            controls: [...document.querySelectorAll('a[href="/"], a[href^="/?"], [data-testid*="chat" i], [aria-label*="chat" i], [aria-label*="temporary" i]')].slice(0, 25)
              .map((e) => [e.tagName, e.getAttribute('data-testid'), e.getAttribute('aria-label'), e.getAttribute('href'), e.getAttribute('aria-pressed')].filter(Boolean).join('|')),
          })
        });
        return;
      }

      // Finished when:
      // 1. Generation started, stop button is gone, and new text is stable for 3 checks (600ms)
      // 2. OR hard timeout safeguard after 170s if we have text (a web-search answer can take over a minute)
      const isComplete =
        (started && !isStopBtnVisible && stableTicks >= 3 && lastAnswer.length > 0) ||
        (Date.now() - startTime > 170000 && lastAnswer.length > 0);

      if (isComplete) {
        clearInterval(poller);
        isCurrentlyGenerating = false;
        updateBadge('ready');
        sendResponse({
          id: task.id,
          type: 'done',
          ok: true,
          answer: lastAnswer,
          fresh: chat.fresh,
          temporary: chat.temporary
        });
      }
    }, 200);
  }
})();
