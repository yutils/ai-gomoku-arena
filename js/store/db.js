// 对局历史存储（IndexedDB）：每局完整记录（棋谱 + 指标 + 思考过程）

const DB_NAME = 'aiai-db';
const DB_VER = 1;
const STORE = 'games';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function saveGame(rec) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(rec);
    t.oncomplete = () => resolve(rec.id);
    t.onerror = () => reject(t.error);
  });
}

export async function getGame(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function listGames() {
  const db = await openDb();
  const all = await new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  return all
    .map((g) => ({
      id: g.id,
      startedAt: g.startedAt,
      endedAt: g.endedAt,
      status: g.status,
      result: g.result,
      moveCount: g.moves?.length || 0,
      black: g.players?.black?.name || '黑方',
      white: g.players?.white?.name || '白方',
      blackKind: g.players?.black?.kind,
      whiteKind: g.players?.white?.kind,
      totals: g.totals || null,
      settings: g.settings || {},
    }))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export async function deleteGame(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).delete(id);
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

export async function clearGames() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).clear();
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}