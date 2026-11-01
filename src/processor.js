import { v2 as cloudinary } from "cloudinary";
import { db, save, touch } from "./store.js";

// Chủ nhóm reply tin cũ với các chữ này => hết hàng
const SOLD_RE = /(hết|het|sold|đã bán|da ban|bán rồi|ban roi)/i;
// Reply với các chữ này => có hàng lại
const RESTOCK_RE = /(còn hàng|con hang|về lại|ve lai|có lại|co lai|về thêm|ve them|restock)/i;
// Chủ nhóm thả tim vào ảnh => hết hàng
const HEART = "/-heart";

function textOf(data) {
    if (typeof data.content === "string") return data.content;
    return data.content?.title || data.content?.description || "";
}

function photoUrlOf(data) {
    if (data.msgType !== "chat.photo" || typeof data.content !== "object") return null;
    try {
        const params = JSON.parse(data.content.params || "{}");
        if (params.hd) return params.hd;
    } catch {}
    return data.content.href || data.content.thumb || null;
}

// Cloudinary nhận cả link ảnh Zalo lẫn data URL (từ công cụ quét tin cũ).
// CLOUDINARY_URL trong biến môi trường được SDK tự đọc.
async function uploadImage(url, productId, msgId) {
    const res = await cloudinary.uploader.upload(url, {
        folder: `zalo/${productId}`,
        public_id: String(msgId),
        overwrite: false,
    });
    return res.secure_url;
}

function findProductByQuote(quote) {
    const id = db.msgIndex[String(quote.globalMsgId)] || db.msgIndex["c" + quote.cliMsgId];
    return id ? db.products.find((p) => p.id === id) : null;
}

function productOfMsg(gMsgId, cMsgId) {
    const id = (gMsgId && db.msgIndex[String(gMsgId)]) || (cMsgId && db.msgIndex["c" + cMsgId]);
    return id ? db.products.find((p) => p.id === id) : null;
}

function applyReaction(product, r) {
    touch(product);
    if (r.icon === HEART) {
        if (product.status !== "het") {
            product.status = "het";
            product.soldAt = r.ts;
            product.updates.push({ ts: r.ts, text: "❤ Chủ nhóm thả tim" });
        }
        product.soldBy = "tim";
        return true;
    }
    // Bỏ tim (icon rỗng) => còn hàng lại, chỉ khi trước đó hết vì tim
    if (!r.icon && product.soldBy === "tim") {
        product.status = "con";
        product.soldAt = null;
        product.soldBy = null;
        product.updates.push({ ts: r.ts, text: "Bỏ thả tim" });
    }
    return false;
}

// Tim có thể đến trước khi thấy ảnh (vd. quét lịch sử sau) nên lưu lại theo mã tin
function applyStoredReactions(product, gMsgId, cMsgId) {
    for (const key of [String(gMsgId), "c" + cMsgId]) {
        const r = db.reactions[key];
        if (r) applyReaction(product, r);
    }
}

/**
 * Xử lý cảm xúc. Mỗi phần tử: { uidFrom, icon, gMsgId, cMsgId, ts }.
 * uidFrom = null khi đọc từ Zalo Web (không biết ai thả) thì vẫn tính.
 */
export async function processReactions(reactions, ownerIds) {
    let soldOut = 0;
    for (const r of reactions.sort((a, b) => a.ts - b.ts)) {
        if (r.uidFrom && !ownerIds.includes(r.uidFrom)) continue;
        if (r.icon !== HEART && r.icon) continue;
        const stored = { icon: r.icon, ts: r.ts };
        if (r.gMsgId) db.reactions[String(r.gMsgId)] = stored;
        if (r.cMsgId) db.reactions["c" + r.cMsgId] = stored;
        const product = productOfMsg(r.gMsgId, r.cMsgId);
        if (product && applyReaction(product, r)) soldOut++;
    }
    await save();
    return { soldOut };
}

// Sản phẩm cùng người đăng có khoảng thời gian sát với tin này (tin cũ nhập sau vẫn gộp đúng)
function nearbyProductOf(uid, ts, windowMs) {
    for (let i = db.products.length - 1; i >= 0; i--) {
        const p = db.products[i];
        if (p.ownerId === uid && ts >= p.createdAt - windowMs && ts <= p.lastTs + windowMs) return p;
    }
    return null;
}

/**
 * Xử lý danh sách tin nhắn nhóm (từ lịch sử hoặc realtime).
 * - Tin của chủ nhóm gửi liền nhau (ảnh + mô tả) được gộp thành 1 sản phẩm.
 * - Tin chủ nhóm reply lại tin cũ có chữ "hết" => đánh dấu hết hàng.
 */
export async function processMessages(messages, ownerIds, windowSeconds) {
    const msgs = messages
        .map((m) => m.data)
        .filter((d) => !db.seen[d.msgId])
        .sort((a, b) => Number(a.ts) - Number(b.ts));

    let added = 0, soldOut = 0;

    for (const d of msgs) {
        if (db.seen[d.msgId]) continue;
        db.seen[d.msgId] = true;
        if (!ownerIds.includes(d.uidFrom)) continue;
        // Bỏ tin hệ thống (ghim/bỏ ghim, thêm thành viên…), chỉ lấy chữ và ảnh
        if (d.msgType !== "webchat" && d.msgType !== "chat.photo") continue;

        const ts = Number(d.ts);
        const text = textOf(d).trim();

        if (d.quote) {
            const product = findProductByQuote(d.quote);
            if (!product) continue;
            touch(product);
            product.updates.push({ ts, text });
            if (RESTOCK_RE.test(text)) {
                product.status = "con";
                product.soldAt = null;
            } else if (SOLD_RE.test(text)) {
                product.status = "het";
                product.soldAt = ts;
                soldOut++;
            }
            continue;
        }

        const photoUrl = photoUrlOf(d);
        if (!photoUrl && !text) continue;

        let product = nearbyProductOf(d.uidFrom, ts, windowSeconds * 1000);
        if (!product) {
            product = {
                id: String(d.msgId),
                ownerId: d.uidFrom,
                ownerName: d.dName,
                createdAt: ts,
                lastTs: ts,
                text: "",
                images: [],
                status: "con",
                soldAt: null,
                updates: [],
                note: "",
            };
            db.products.push(product);
            db.products.sort((a, b) => a.createdAt - b.createdAt);
            added++;
        }

        touch(product);
        product.createdAt = Math.min(product.createdAt, ts);
        product.lastTs = Math.max(product.lastTs, ts);
        db.msgIndex[String(d.msgId)] = product.id;
        db.msgIndex["c" + d.cliMsgId] = product.id;
        applyStoredReactions(product, d.msgId, d.cliMsgId);

        if (photoUrl) {
            try {
                product.images.push(await uploadImage(photoUrl, product.id, d.msgId));
            } catch (e) {
                console.error("Không tải được ảnh lên Cloudinary:", e.message);
                // Link Zalo vẫn xem được một thời gian; data URL thì quá lớn để lưu
                if (!photoUrl.startsWith("data:")) product.images.push(photoUrl);
            }
            if (text) product.text = product.text ? `${product.text}\n${text}` : text;
        } else {
            product.text = product.text ? `${product.text}\n${text}` : text;
        }
    }

    await save();
    return { added, soldOut };
}
