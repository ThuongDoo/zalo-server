import express from "express";
import cors from "cors";
import { ThreadType } from "zca-js";
import { requireUser } from "./auth.js";
import { db, config, loadStore, save, saveConfig, touch } from "./store.js";
import { processMessages, processReactions } from "./processor.js";
import { login, listGroups, fetchGroupHistory, loginState } from "./zalo.js";

const state = { group: null, ownerIds: [], scanning: false, listening: false, lastError: null };

// Mọi lần ghi dữ liệu đi qua hàng đợi này để quét định kỳ, realtime và nhập tin cũ không đè lên nhau
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn, fn));

let api = null;
let groups = [];

function toReactions(list) {
    return list
        .filter((r) => r.threadId === state.group?.id)
        .flatMap((r) =>
            (r.data.content?.rMsg || []).map((m) => ({
                uidFrom: r.data.uidFrom,
                icon: r.data.content.rIcon,
                gMsgId: m.gMsgID,
                cMsgId: m.cMsgID,
                ts: Number(r.data.ts),
            })),
        );
}

// Cảm xúc cũ lấy qua websocket; Zalo không trả lời thì bỏ qua
function fetchOldReactions() {
    if (!state.listening) return Promise.resolve([]);
    return new Promise((resolve) => {
        const timer = setTimeout(() => done([]), 10_000);
        const onOld = (list, isGroup) => isGroup && done(list);
        function done(list) {
            clearTimeout(timer);
            api.listener.off("old_reactions", onOld);
            resolve(toReactions(list));
        }
        api.listener.on("old_reactions", onOld);
        api.listener.requestOldReactions(ThreadType.Group);
    });
}

async function scan() {
    if (!api || !state.group) throw new Error("Chưa đăng nhập Zalo hoặc chưa chọn nhóm");
    if (state.scanning) throw new Error("Đang quét, vui lòng chờ");
    state.scanning = true;
    try {
        const groupMsgs = await fetchGroupHistory(api, state.group.id, config.historyCount);
        const reactions = await fetchOldReactions();
        const result = await enqueue(async () => {
            const r = await processMessages(groupMsgs, state.ownerIds, config.groupWindowSeconds);
            r.soldOut += (await processReactions(reactions, state.ownerIds)).soldOut;
            return r;
        });
        db.lastScan = Date.now();
        await save();
        state.lastError = null;
        return result;
    } catch (e) {
        state.lastError = e.message;
        throw e;
    } finally {
        state.scanning = false;
    }
}

function startListener() {
    api.listener.on("message", (msg) => {
        if (!config.autoScan || msg.type !== ThreadType.Group || msg.threadId !== state.group?.id) return;
        enqueue(() => processMessages([msg], state.ownerIds, config.groupWindowSeconds)).catch((e) =>
            console.error("Lỗi xử lý tin realtime:", e.message),
        );
    });
    api.listener.on("reaction", (reaction) => {
        if (!config.autoScan) return;
        const list = toReactions([reaction]);
        if (list.length) enqueue(() => processReactions(list, state.ownerIds));
    });
    api.listener.on("connected", () => (state.listening = true));
    api.listener.on("closed", () => {
        state.listening = false;
        loginState.status = "mất kết nối – có thể nick này vừa mở Zalo Web. Bấm \"Đăng nhập lại\"";
    });
    api.listener.start({ retryOnClose: true });
}

// Render chạy giờ UTC, giờ quét tính theo giờ Việt Nam
function vnTime() {
    const now = new Date(Date.now() + 7 * 3600_000);
    return { hhmm: now.toISOString().slice(11, 16), day: now.toISOString().slice(0, 10) };
}

function scheduleScans() {
    let lastRun = "";
    setInterval(() => {
        if (!config.autoScan || !state.group) return;
        const { hhmm, day } = vnTime();
        if (config.scanTimes.includes(hhmm) && lastRun !== day + hhmm) {
            lastRun = day + hhmm;
            scan().catch(() => {});
        }
    }, 20_000);
}

async function selectGroup(groupId) {
    const g = groups.find((x) => x.id === groupId);
    if (!g) return false;
    state.group = g;
    state.ownerIds = [g.creatorId, ...(g.adminIds || [])].filter(Boolean);
    config.groupId = g.id;
    config.groupName = g.name;
    await saveConfig();
    return true;
}

async function connect({ forceQR = false } = {}) {
    try {
        if (api) api.listener.stop();
        state.listening = false;
        api = await login({ forceQR });
        groups = await listGroups(api);
        if (config.groupId) await selectGroup(config.groupId);
        startListener();
        await new Promise((resolve) => {
            api.listener.once("connected", resolve);
            setTimeout(resolve, 15_000);
        });
        if (state.group && config.autoScan) await scan().catch(() => {});
    } catch (e) {
        state.lastError = e.message;
        console.error("Lỗi đăng nhập Zalo:", e);
    }
}

const app = express();
// Chưa đặt CORS_ORIGIN thì cho mọi trang gọi (API vẫn cần đăng nhập)
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()) : true }));
app.use(express.json({ limit: "25mb" }));

// Cronjob gọi mỗi 10 phút để Render không cho server ngủ
app.get("/ping", (req, res) => res.send("ok"));

app.use("/api", requireUser);

app.get("/api/status", (req, res) => {
    res.json({
        login: loginState.status,
        qrImage: loginState.qrImage,
        group: state.group?.name || null,
        groupId: state.group?.id || null,
        scanning: state.scanning,
        listening: state.listening,
        lastScan: db.lastScan,
        lastError: state.lastError,
        config,
    });
});

app.get("/api/groups", (req, res) => {
    res.json(groups.map((g) => ({ id: g.id, name: g.name, totalMember: g.totalMember })));
});

app.post("/api/settings", async (req, res) => {
    const { groupId, autoScan, scanTimes, historyCount } = req.body;
    if (groupId && groupId !== config.groupId && !(await selectGroup(groupId))) {
        return res.status(400).json({ error: "Không tìm thấy nhóm" });
    }
    if (typeof autoScan === "boolean") config.autoScan = autoScan;
    if (Array.isArray(scanTimes)) config.scanTimes = scanTimes.filter((t) => /^\d\d:\d\d$/.test(t));
    if (Number(historyCount) > 0) config.historyCount = Number(historyCount);
    await saveConfig();
    res.json(config);
});

app.post("/api/relogin", (req, res) => {
    connect({ forceQR: true });
    res.json({ ok: true });
});

app.get("/api/products", (req, res) => {
    res.json([...db.products].sort((a, b) => b.createdAt - a.createdAt));
});

app.patch("/api/products/:id", async (req, res) => {
    const product = db.products.find((p) => p.id === req.params.id);
    if (!product) return res.status(404).json({ error: "Không tìm thấy" });
    const { status, note, hidden } = req.body;
    if (status === "con" || status === "het") {
        product.status = status;
        product.soldAt = status === "het" ? Date.now() : null;
        product.soldBy = status === "het" ? "tay" : null;
    }
    if (typeof note === "string") product.note = note;
    if (typeof hidden === "boolean") product.hidden = hidden;
    touch(product);
    await enqueue(save);
    res.json(product);
});

app.post("/api/scan", async (req, res) => {
    try {
        res.json(await scan());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Công cụ quét tin cũ gửi lên từng lô: { messages, reactions, adminIds }
app.post("/api/import", async (req, res) => {
    const { messages = [], reactions = [], adminIds = [] } = req.body;
    const ownerIds = [...new Set([...state.ownerIds, ...adminIds])];
    try {
        const result = await enqueue(async () => {
            const r = await processMessages(messages, ownerIds, config.groupWindowSeconds);
            r.soldOut += (await processReactions(reactions, ownerIds)).soldOut;
            return r;
        });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

if (!process.env.APP_SECRET) throw new Error("Thiếu biến môi trường APP_SECRET");
await loadStore();
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server chạy ở cổng ${port}`);
    connect();
    scheduleScans();
});
