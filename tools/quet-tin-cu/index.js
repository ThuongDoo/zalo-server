// Mở Zalo Web trong Chrome, người dùng đăng nhập + đồng bộ + mở nhóm, công cụ cuộn lên
// tải tin cũ, đọc ảnh/mô tả/tin trả lời/thả tim ngay trên trang (dữ liệu lưu trên máy bị
// Zalo mã hóa) rồi gửi lên server theo từng lô.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { extractBubble } from "./extract.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const SERVER = config.serverUrl.replace(/\/$/, "");
const MAX_ROUNDS = 60;
const BATCH = 15;

const FIND_CHAT = () => {
    let best = null;
    for (const el of document.querySelectorAll("*")) {
        const style = getComputedStyle(el);
        if (!/(auto|scroll)/.test(style.overflowY) || el.scrollHeight <= el.clientHeight + 50) continue;
        const rect = el.getBoundingClientRect();
        if (rect.left < 250) continue;
        const area = rect.width * rect.height;
        if (!best || area > best.area) best = { el, area };
    }
    document.querySelectorAll("[data-quet]").forEach((el) => el.removeAttribute("data-quet"));
    if (!best) return false;
    best.el.setAttribute("data-quet", "chat");
    return true;
};

// Cuộn tới từng ảnh (Zalo chỉ tải ảnh đang hiện trên màn hình), chờ tải xong,
// đọc nội dung, đổi ảnh blob thành data URL
const READ_BUBBLE = `async ([id]) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const b = document.getElementById(id);
    if (!b) return [];
    b.scrollIntoView({ block: "center" });
    const slots = [...b.querySelectorAll("[data-component='photo']")];
    if (!slots.length && b.querySelector("[data-id='div_ReceivedMsg_Photo']")) slots.push(b);
    for (const slot of slots) {
        if (slot.querySelector(".card--group-photo__row__item__video, .fa-play")) continue;
        slot.scrollIntoView({ block: "center" });
        for (let t = 0; t < 80; t++) {
            const img = [...slot.querySelectorAll("img.zimg-el")].find((i) => !i.closest(".message-quote-fragment__container"));
            if (img && img.src.startsWith("blob:") && img.complete && img.naturalWidth > 0) break;
            await sleep(100);
        }
    }
    const items = (${extractBubble.toString()})(b);
    for (const it of items) {
        if (it.type !== "photo" || !it.img) continue;
        try {
            const blob = await (await fetch(it.img)).blob();
            it.dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
        } catch (e) { it.error = String(e); }
    }
    return items;
}`;

function toPayload(items) {
    const messages = [];
    const reactions = [];
    const names = {};
    const texts = [];
    for (const it of items) {
        if (it.dName) names[it.uidFrom] = it.dName;
        if (it.type === "video") continue;
        const ts = Number(it.cliMsgId);

        let quote;
        if (it.quote) {
            let cliMsgId = it.quote.cliMsgId;
            // Trả lời tin chữ (không có ảnh): tìm tin chữ trước đó có nội dung khớp
            if (!cliMsgId && it.quote.msg) {
                const key = it.quote.msg.replace(/\s+/g, " ").slice(0, 30);
                cliMsgId = texts.findLast((t) => t.key.startsWith(key))?.cliMsgId;
            }
            quote = { globalMsgId: null, cliMsgId, msg: it.quote.msg };
        }

        const isPhoto = it.type === "photo";
        if (isPhoto && !it.dataUrl) continue;
        messages.push({
            data: {
                msgId: it.globalMsgId,
                cliMsgId: it.cliMsgId,
                uidFrom: it.uidFrom,
                dName: names[it.uidFrom] || "",
                ts: String(ts),
                msgType: isPhoto ? "chat.photo" : "webchat",
                content: isPhoto ? { href: it.dataUrl, params: "", title: it.text || "" } : it.text,
                quote,
            },
        });
        if (!isPhoto && it.text) texts.push({ key: it.text.replace(/\s+/g, " "), cliMsgId: it.cliMsgId });
        if (it.hasHeart) reactions.push({ uidFrom: null, icon: "/-heart", gMsgId: it.globalMsgId, cMsgId: it.cliMsgId, ts });
    }
    return { messages, reactions };
}

async function post(body) {
    const res = await fetch(`${SERVER}/api/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.appSecret}` },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server trả lỗi ${res.status}`);
    return data;
}

// Đánh thức server Render (bản miễn phí có thể đang ngủ)
console.log("Đang kết nối server...");
await fetch(`${SERVER}/ping`).catch(() => {});

const context = await chromium.launchPersistentContext(path.join(DIR, "zaloweb-profile"), {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
});
const page = context.pages()[0] || (await context.newPage());
await page.goto("https://chat.zalo.me/");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("\n=== LÀM THEO CÁC BƯỚC TRONG CỬA SỔ CHROME VỪA MỞ ===");
console.log("1. Quét QR đăng nhập Zalo (lần sau không cần nếu chưa đăng xuất).");
console.log("2. Nếu Zalo hỏi đồng bộ tin nhắn: bấm đồng bộ, xác nhận trên điện thoại, chờ xong.");
console.log("3. Mở nhóm cần quét.");
await rl.question("4. Xong thì quay lại cửa sổ này và bấm Enter... ");
rl.close();

if (!(await page.evaluate(FIND_CHAT))) {
    console.error("Không thấy khung chat. Hãy mở nhóm rồi chạy lại.");
    await context.close();
    process.exit(1);
}

let lastHeight = 0, still = 0;
for (let round = 1; round <= MAX_ROUNDS && still < 4; round++) {
    const { height, bubbles } = await page.evaluate(() => {
        const el = document.querySelector("[data-quet=chat]");
        el.scrollTop = 0;
        return { height: el.scrollHeight, bubbles: document.querySelectorAll("[data-component='bubble-message']").length };
    });
    still = height === lastHeight ? still + 1 : 0;
    lastHeight = height;
    process.stdout.write(`\rĐang cuộn lên tải tin cũ... lượt ${round}, ${bubbles} tin   `);
    await page.waitForTimeout(2000);
}
console.log();

const ids = await page.evaluate(() => [...document.querySelectorAll("[data-component='bubble-message']")].map((b) => b.id));
const items = [];
const reactionSamples = [];
const readBubble = await page.evaluateHandle(READ_BUBBLE);
for (let i = 0; i < ids.length; i++) {
    process.stdout.write(`\rĐang đọc tin và ảnh ${i + 1}/${ids.length}   `);
    const got = await readBubble.evaluate((fn, id) => fn([id]), ids[i]);
    for (const it of got) {
        if (it.reactionHtml && reactionSamples.length < 20) reactionSamples.push(it.reactionHtml);
        delete it.reactionHtml;
    }
    items.push(...got);
}
console.log();
await context.close();

// Lưu thống kê + mẫu HTML cảm xúc để kiểm tra nhận diện thả tim
fs.writeFileSync(path.join(DIR, "debug.json"), JSON.stringify({
    bubbles: ids.length,
    photos: items.filter((i) => i.type === "photo").length,
    photosNoData: items.filter((i) => i.type === "photo" && !i.dataUrl).length,
    hearts: items.filter((i) => i.hasHeart).length,
    reactionSamples,
}, null, 2));

const adminIds = [...new Set(items.filter((i) => i.isAdmin).map((i) => i.uidFrom))];
const { messages, reactions } = toPayload(items);
let added = 0, soldOut = 0;
for (let i = 0; i < messages.length; i += BATCH) {
    process.stdout.write(`\rĐang gửi lên server ${Math.min(i + BATCH, messages.length)}/${messages.length}   `);
    const r = await post({ messages: messages.slice(i, i + BATCH), reactions: [], adminIds });
    added += r.added;
    soldOut += r.soldOut;
}
soldOut += (await post({ messages: [], reactions, adminIds })).soldOut;

console.log(`\n\nXong! Đọc ${messages.length} tin, thêm ${added} sản phẩm, ${soldOut} hết hàng.`);
console.log(`Thả tim nhận được: ${reactions.length}. Mở trang quản lý để xem.`);
