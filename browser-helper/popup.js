document.querySelector('#open-app').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://127.0.0.1:4318' });
});
