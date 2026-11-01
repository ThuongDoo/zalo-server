// Chạy bên trong trang chat.zalo.me (page.evaluate). Đọc 1 bong bóng tin nhắn,
// trả về danh sách tin con (album nhiều ảnh = nhiều tin) theo dạng gần giống zca-js.
export function extractBubble(bubble) {
    const inQuote = (el) => !!el.closest(".message-quote-fragment__container");
    const parseQid = (qid) => {
        const [globalMsgId, rest = ""] = qid.split("@");
        const [cliMsgId, uidFrom] = rest.split("_");
        return { globalMsgId, cliMsgId, uidFrom };
    };

    const item = bubble.closest(".chat-item");
    const dName = bubble.querySelector(".message-sender-name-content .truncate")?.textContent.replace(/ /g, " ").trim() || "";
    const isAdmin = !!item?.querySelector(".zavatar-admin");

    let quote = null;
    const quoteEl = bubble.querySelector(".message-quote-fragment__container");
    if (quoteEl) {
        const qImg = quoteEl.querySelector("img[id$='-QUOTE_MESSAGE']");
        quote = {
            cliMsgId: qImg ? qImg.id.replace(/^img-/, "").split(".")[0] : null,
            msg: quoteEl.querySelector(".message-quote-fragment__description")?.textContent.trim() || "",
        };
    }

    const textEl = [...bubble.querySelectorAll("[data-component='message-text-content']")].find((el) => !inQuote(el));
    const text = textEl ? textEl.innerText.trim() : "";

    const out = [];
    const photos = [...bubble.querySelectorAll("[data-component='photo'][data-qid]")];
    if (photos.length) {
        for (const p of photos) {
            const img = p.querySelector("img.zimg-el");
            const isVideo = !!p.querySelector(".card--group-photo__row__item__video, .fa-play");
            out.push({ ...parseQid(p.dataset.qid), type: isVideo ? "video" : "photo", img: img?.src || null, imgId: img?.id || null });
        }
    } else {
        const frame = [...bubble.querySelectorAll("[data-qid]")].find((el) => !inQuote(el));
        if (!frame) return [];
        const img = [...bubble.querySelectorAll("img.zimg-el")].find((el) => !inQuote(el));
        const isPhoto = !!bubble.querySelector("[data-id='div_ReceivedMsg_Photo']");
        out.push({ ...parseQid(frame.dataset.qid), type: isPhoto ? "photo" : "text", img: isPhoto ? img?.src || null : null, imgId: isPhoto ? img?.id || null : null });
    }

    // Cảm xúc đã thả hiện ngoài bảng chọn (.emoji-list-wrapper). Zalo ghi mã emoji
    // dạng chữ ("/-heart") trong span hoặc dùng ảnh có tên heart.
    const shown = [...bubble.querySelectorAll(".message-reaction-container *")].filter(
        (el) => !el.closest(".emoji-list-wrapper") && !el.classList.contains("default-react-icon-thumb"),
    );
    const hasHeart = shown.some(
        (el) => (el.children.length === 0 && el.textContent.trim() === "/-heart") || /heart/i.test(el.getAttribute?.("src") || ""),
    );
    const reactionHtml = shown.some((el) => el.children.length === 0 && el.textContent.trim())
        ? bubble.querySelector(".message-reaction-container")?.outerHTML.slice(0, 3000)
        : null;

    // Chú thích ảnh / chữ / quote gắn vào tin cuối của bong bóng
    out[out.length - 1].text = text;
    out[out.length - 1].quote = quote;
    return out.map((m) => ({ ...m, dName, isAdmin, hasHeart, reactionHtml, bubbleId: bubble.id }));
}
