'use strict';

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
