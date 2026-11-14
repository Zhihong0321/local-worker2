document.addEventListener('DOMContentLoaded', async () => {
  const bridgeEl = document.getElementById('bridge-status');
  const tabEl = document.getElementById('tab-status');
  const openBtn = document.getElementById('btn-open-chatgpt');
  const browserEl = document.getElementById('browser-name');
  const browsersEl = document.getElementById('browsers');
  let ownStatus;
  try {
    ownStatus = await chrome.runtime.sendMessage({ action: 'bridgeStatus' });
    browserEl.textContent = ownStatus.name;
  } catch {
    browserEl.textContent = 'Unknown';
  }

  // Check ChatGPT Tab
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  if (tabs.length > 0) {
    tabEl.innerText = 'Active (' + tabs.length + ')';
    tabEl.className = 'pill pill-green';
  } else {
    tabEl.innerText = 'Not Found';
    tabEl.className = 'pill pill-red';
  }

  // Check Local Bridge Server via status endpoint
  try {
    const res = await fetch('http://127.0.0.1:8765/status', { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json();
      const connectedHere = ownStatus?.connected && data.browsers?.some((browser) => browser.id === ownStatus.id);
      bridgeEl.innerText = connectedHere ? 'Connected' : 'Not connected';
      bridgeEl.className = connectedHere ? 'pill pill-green' : 'pill pill-red';
      browsersEl.textContent = data.browsers?.map((browser) => browser.name).join(', ') || 'None';
    } else {
      bridgeEl.innerText = 'Offline';
      bridgeEl.className = 'pill pill-red';
    }
  } catch (err) {
    bridgeEl.innerText = 'Offline';
    bridgeEl.className = 'pill pill-red';
    browsersEl.textContent = 'Unavailable';
  }

  openBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://chatgpt.com/' });
  });

  const testBtn = document.getElementById('btn-test-prompt');
  const resultEl = document.getElementById('test-result');

  testBtn.addEventListener('click', async () => {
    resultEl.innerText = 'Sending prompt to ChatGPT tab...';
    resultEl.style.color = '#f39c12';

    const allTabs = await chrome.tabs.query({});
    const chatTabs = allTabs.filter(
      (t) => t.url && (t.url.includes('chatgpt.com') || t.url.includes('chat.openai.com'))
    );

    if (chatTabs.length === 0) {
      resultEl.innerText = 'Error: No ChatGPT tab open. Please open ChatGPT first.';
      resultEl.style.color = '#e74c3c';
      return;
    }

    // Pick active tab first
    chatTabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
    const targetTab = chatTabs[0];

    try {
      // Ensure content script is attached
      try {
        await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          files: ['content.js']
        });
      } catch {}

      chrome.tabs.sendMessage(
        targetTab.id,
        { action: 'prompt', prompt: 'Hello! Reply in 5 words.', id: 'test-' + Date.now() },
        (res) => {
          if (chrome.runtime.lastError) {
            resultEl.innerText = 'Tab error: ' + chrome.runtime.lastError.message + '\n(Try refreshing the ChatGPT tab F5)';
            resultEl.style.color = '#e74c3c';
          } else if (res && res.type === 'done') {
            resultEl.innerText = 'Success! Reply received:\n' + res.answer;
            resultEl.style.color = '#2ecc71';
          } else if (res && res.type === 'error') {
            resultEl.innerText = 'ChatGPT error: ' + res.error;
            resultEl.style.color = '#e74c3c';
          } else {
            resultEl.innerText = 'Response: ' + JSON.stringify(res);
            resultEl.style.color = '#a4b0be';
          }
        }
      );
    } catch (err) {
      resultEl.innerText = 'Error: ' + err.message;
      resultEl.style.color = '#e74c3c';
    }
  });
});
