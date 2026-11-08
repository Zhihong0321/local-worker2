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
    } else {
      badge.style.background = '#27ae60';
      badge.innerText = text || 'Worker Bridge: Ready';
    }
  }

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

  async function executePrompt(task, sendResponse) {
    updateBadge('busy', 'Worker: Entering prompt...');

    const promptInput = document.querySelector('#prompt-textarea') ||
                        document.querySelector('div[contenteditable="true"]') ||
                        document.querySelector('textarea');
    if (!promptInput) {
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

      // Finished when:
      // 1. Generation started, stop button is gone, and new text is stable for 3 checks (600ms)
      // 2. OR hard timeout safeguard after 45s if we have text
      const isComplete =
        (started && !isStopBtnVisible && stableTicks >= 3 && lastAnswer.length > 0) ||
        (Date.now() - startTime > 45000 && lastAnswer.length > 0);

      if (isComplete) {
        clearInterval(poller);
        updateBadge('ready');
        sendResponse({
          id: task.id,
          type: 'done',
          ok: true,
          answer: lastAnswer
        });
      }
    }, 200);
  }
})();
