let lastRightClickedImage = null;

document.addEventListener('contextmenu', (e) => {
  const target = e.target;
  if (target.tagName === 'IMG' || target.tagName === 'PICTURE') {
    lastRightClickedImage = {
      src: target.src || target.currentSrc,
      alt: target.alt || '',
      naturalWidth: target.naturalWidth,
      naturalHeight: target.naturalHeight,
    };
  } else {
    const bgUrl = extractBackgroundImage(target);
    if (bgUrl) {
      lastRightClickedImage = { src: bgUrl, alt: '', naturalWidth: 0, naturalHeight: 0 };
    }
  }
}, true);

function extractBackgroundImage(el) {
  const style = window.getComputedStyle(el);
  const bg = style.backgroundImage;
  if (bg && bg !== 'none') {
    const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
    if (match) return match[1];
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_LAST_IMAGE') {
    sendResponse(lastRightClickedImage);
    lastRightClickedImage = null;
  }
});
