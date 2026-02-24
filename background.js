'use strict';

// ─── URL interception ─────────────────────────────────────────────────────────
// Redirect top-level navigations to .m3u8/.m3u URLs into the viewer.
// The original URL is passed in the fragment so that query-string characters
// like & and = are preserved without encoding issues.

async function setupInterceptRules() {
  const viewerBase = chrome.runtime.getURL('viewer.html');

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 100,
      action: {
        type: 'redirect',
        redirect: {
          // \\1 references the first capture group (the full matched URL).
          // Putting it in the fragment avoids query-string parsing issues.
          regexSubstitution: viewerBase + '#\\1'
        }
      },
      condition: {
        // Matches http(s) URLs ending in .m3u8, .m3u, or .mpd with an optional query string.
        regexFilter: '^(https?://.+\\.(?:m3u8?|mpd)(\\?[^#]*)?)$',
        resourceTypes: ['main_frame']
      }
    }]
  });
}

// Run immediately on every service worker init so rules are always current,
// regardless of whether onInstalled or onStartup fired (e.g. extension reload
// from chrome://extensions doesn't reliably trigger either for dynamic rules).
setupInterceptRules().catch(console.error);

chrome.runtime.onInstalled.addListener(setupInterceptRules);
chrome.runtime.onStartup.addListener(setupInterceptRules);

// ─── Manifest fetch proxy ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fetchManifest') {
    fetch(message.url, {
      headers: {
        'Accept': 'application/x-mpegURL, application/vnd.apple.mpegurl, text/plain, */*'
      }
    })
      .then(async response => {
        const text = await response.text();
        sendResponse({
          success: true,
          content: text,
          status: `${response.status} ${response.statusText}`,
          contentType: response.headers.get('content-type') || ''
        });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });

    return true; // Keep message channel open for async response
  }
});
