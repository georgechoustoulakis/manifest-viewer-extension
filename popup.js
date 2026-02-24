'use strict';

const STORAGE_KEY = 'recentUrls';
const MAX_RECENT = 10;

const urlInput = document.getElementById('url-input');
const viewBtn = document.getElementById('view-btn');
const recentSection = document.getElementById('recent-section');
const recentList = document.getElementById('recent-list');
const clearBtn = document.getElementById('clear-btn');

// Open the viewer tab for a given URL
function openViewer(url) {
  if (!url) return;
  const viewerUrl = chrome.runtime.getURL('viewer.html') + '?url=' + encodeURIComponent(url);
  chrome.tabs.create({ url: viewerUrl });
  saveRecent(url);
  window.close();
}

// Save a URL to recent list
function saveRecent(url) {
  chrome.storage.local.get(STORAGE_KEY, data => {
    let urls = data[STORAGE_KEY] || [];
    urls = [url, ...urls.filter(u => u !== url)].slice(0, MAX_RECENT);
    chrome.storage.local.set({ [STORAGE_KEY]: urls });
  });
}

// Render the recent URL list
function renderRecent(urls) {
  if (!urls || urls.length === 0) {
    recentSection.hidden = true;
    return;
  }
  recentSection.hidden = false;
  recentList.innerHTML = '';
  urls.forEach(url => {
    const li = document.createElement('li');
    li.className = 'recent-item';
    li.title = url;

    const icon = document.createElement('span');
    icon.className = 'recent-item-icon';
    icon.textContent = '↗';

    const text = document.createElement('span');
    text.className = 'recent-item-url';
    text.textContent = url;

    li.appendChild(icon);
    li.appendChild(text);
    li.addEventListener('click', () => openViewer(url));
    recentList.appendChild(li);
  });
}

// Load recent URLs on startup
chrome.storage.local.get(STORAGE_KEY, data => {
  renderRecent(data[STORAGE_KEY] || []);
});

// Submit handlers
viewBtn.addEventListener('click', () => openViewer(urlInput.value.trim()));
urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') openViewer(urlInput.value.trim());
});

// Clear history
clearBtn.addEventListener('click', () => {
  chrome.storage.local.remove(STORAGE_KEY, () => renderRecent([]));
});

// Focus the input on open
urlInput.focus();
