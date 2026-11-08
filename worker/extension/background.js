// Chrome Extension Service Worker (background.js)
const WS_URL = 'ws://127.0.0.1:8765';
let socket = null;
let isConnected = false;
let isBusy = false;

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch { }
}

async function updateStatusBadge() {
  if (!isConnected) {
    setBadge('OFF', '#e74c3c');
    return;
  }
  if (isBusy) {
    setBadge('BUSY', '#f39c12');
    return;
  }
  const tabs = await chrome.tabs.query({});
  const hasChatGpt = tabs.some((t) => t.url && (t.url.includes('chatgpt.com') || t.url.includes('chat.openai.com')));
  if (!hasChatGpt) {
    setBadge('TAB', '#95a5a6');
  } else {
    setBadge('OK', '#27ae60');
  }
}

function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    socket = new WebSocket(WS_URL);

    socket.onopen = () => {
      console.log('[Bridge BG] Connected to Local Worker on ' + WS_URL);
      isConnected = true;
      updateStatusBadge();
    };

    socket.onclose = () => {
      isConnected = false;
      isBusy = false;
      updateStatusBadge();
      setTimeout(connectWebSocket, 2000);
    };

    socket.onerror = () => {
      socket.close();
    };

    socket.onmessage = async (evt) => {
      try {
        const task = JSON.parse(evt.data);
        if (task.action === 'prompt') {
          handleIncomingTask(task);
        }
      } catch (err) {
        console.error('[Bridge BG] Error parsing task:', err);
      }
    };
  } catch (err) {
    isConnected = false;
    updateStatusBadge();
    setTimeout(connectWebSocket, 2500);
  }
}

async function handleIncomingTask(task) {
  isBusy = true;
  updateStatusBadge();

  // Find all ChatGPT tabs
  const allTabs = await chrome.tabs.query({});
  const chatGptTabs = allTabs.filter(
    (t) => t.url && (t.url.includes('chatgpt.com') || t.url.includes('chat.openai.com'))
  );

  if (chatGptTabs.length === 0) {
    const newTab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true });
    await new Promise((r) => setTimeout(r, 4500));
    chatGptTabs.push(newTab);
  }

  // Prioritize active/focused tab
  chatGptTabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));

  let delivered = false;
  for (const tab of chatGptTabs) {
    try {
      // First ensure content script is injected
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
      } catch { }

      const response = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, task, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(res);
          }
        });
      });

      delivered = true;
      isBusy = false;
      updateStatusBadge();

      if (response && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(response));
      }
      break;
    } catch (err) {
      console.log(`[Bridge BG] Tab ${tab.id} notice:`, err.message);
    }
  }

  if (!delivered) {
    isBusy = false;
    updateStatusBadge();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          id: task.id,
          type: 'error',
          error: 'Could not communicate with any active ChatGPT tab. Please click the reload icon on chrome://extensions'
        })
      );
    }
  }
}

// Keep service worker alive via events and ping from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'ping') {
    if (!isConnected) connectWebSocket();
    sendResponse({ ok: true, connected: isConnected });
  }
});

setInterval(() => {
  if (!isConnected) connectWebSocket();
  else updateStatusBadge();
}, 4000);

connectWebSocket();
