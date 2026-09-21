export function createLocalStore({ indexedDB = globalThis.indexedDB, name = 'video-data-analysis-local-v1' } = {}) {
  let opening;
  function open() {
    if (!indexedDB) return Promise.reject(new Error('当前浏览器不支持本地 IndexedDB。'));
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('state')) request.result.createObjectStore('state');
      };
      request.onerror = () => { opening = null; reject(new Error('无法打开本机素材数据库。')); };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
    });
    return opening;
  }
  async function transact(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('state', mode);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(new Error('本机数据库读写失败；请检查浏览器存储空间。'));
      try {
        const request = action(transaction.objectStore('state'));
        request.onsuccess = () => { result = request.result; };
      } catch { transaction.abort(); }
    });
  }
  return {
    get: (key) => transact('readonly', (store) => store.get(key)),
    set: (key, value) => transact('readwrite', (store) => store.put(value, key)),
    remove: (key) => transact('readwrite', (store) => store.delete(key)),
    close: async () => { if (opening) (await opening).close(); opening = null; }
  };
}
