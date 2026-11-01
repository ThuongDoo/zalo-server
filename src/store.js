// Dữ liệu giữ trong bộ nhớ để xử lý nhanh, ghi xuống Firestore sau mỗi lượt xử lý.
// Firestore:
//   products/{id}        – từng sản phẩm
//   system/state         – lastScan
//   system/msgIndex, system/seen, system/reactions – mỗi map một document (giới hạn 1MB/document)
//   system/config        – cài đặt (nhóm, giờ quét, bật/tắt tự động)
//   system/zaloSession   – phiên đăng nhập Zalo (đã mã hóa) để khỏi quét QR lại khi server khởi động lại
import crypto from "node:crypto";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, writeBatch } from "firebase/firestore";
import { firestore } from "./firebase.js";

// Giới hạn số mục để mỗi document luôn dưới 1MB; mục cũ nhất bị bỏ trước
const LIMITS = { msgIndex: 15_000, seen: 20_000, reactions: 5_000 };

const productDoc = (id) => doc(firestore, "products", id);
const systemDoc = (name) => doc(firestore, "system", name);

export const DEFAULT_CONFIG = {
    groupId: null,
    groupName: null,
    autoScan: true,
    scanTimes: ["07:00", "12:00", "21:00"],
    historyCount: 500,
};

export const db = {
    products: [],
    msgIndex: {},
    seen: {},
    reactions: {},
    lastScan: null,
};
export const config = { ...DEFAULT_CONFIG };

const dirty = new Set();

export async function loadStore() {
    const [productSnap, stateDoc, configDoc, ...mapDocs] = await Promise.all([
        getDocs(collection(firestore, "products")),
        getDoc(systemDoc("state")),
        getDoc(systemDoc("config")),
        ...Object.keys(LIMITS).map((name) => getDoc(systemDoc(name))),
    ]);
    // Xếp theo thời gian để processor gộp đúng tin vào sản phẩm mới nhất
    db.products = productSnap.docs.map((d) => d.data()).sort((a, b) => a.createdAt - b.createdAt);
    db.lastScan = stateDoc.data()?.lastScan || null;
    Object.keys(LIMITS).forEach((name, i) => (db[name] = mapDocs[i].data()?.map || {}));
    Object.assign(config, configDoc.data() || {});
}

export function touch(product) {
    dirty.add(product.id);
}

function prune(map, limit) {
    const keys = Object.keys(map);
    if (keys.length <= limit) return map;
    return Object.fromEntries(keys.slice(keys.length - limit).map((k) => [k, map[k]]));
}

export async function save() {
    const batch = writeBatch(firestore);
    for (const id of dirty) {
        const p = db.products.find((x) => x.id === id);
        if (p) batch.set(productDoc(id), p);
    }
    dirty.clear();
    for (const [name, limit] of Object.entries(LIMITS)) {
        db[name] = prune(db[name], limit);
        batch.set(systemDoc(name), { map: db[name] });
    }
    batch.set(systemDoc("state"), { lastScan: db.lastScan });
    await batch.commit();
}

// Xóa hết sản phẩm và chỉ mục để quét lại từ đầu; giữ cài đặt và phiên Zalo
export async function resetProducts() {
    const snap = await getDocs(collection(firestore, "products"));
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
    Object.assign(db, { products: [], msgIndex: {}, seen: {}, reactions: {}, lastScan: null });
    dirty.clear();
    await save();
}

export async function saveConfig() {
    await setDoc(systemDoc("config"), config);
}

// Firestore để mở nên phiên Zalo được mã hóa bằng APP_SECRET (AES-256-GCM),
// người khác đọc được document cũng không dùng được nick Zalo
const key = crypto.createHash("sha256").update(process.env.APP_SECRET || "").digest();

function encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

function decrypt(payload) {
    const [iv, tag, data] = payload.split(".").map((s) => Buffer.from(s, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export async function loadSession() {
    const snap = await getDoc(systemDoc("zaloSession"));
    if (!snap.exists()) return null;
    try {
        return JSON.parse(decrypt(snap.data().encrypted));
    } catch {
        // Đổi APP_SECRET hoặc dữ liệu hỏng => quét QR lại
        return null;
    }
}

export async function saveSession(session) {
    await setDoc(systemDoc("zaloSession"), { encrypted: encrypt(JSON.stringify(session)), savedAt: Date.now() });
}
