import { Zalo, LoginQRCallbackEventType } from "zca-js";
import { loadSession, saveSession } from "./store.js";

export const loginState = { status: "chưa đăng nhập", qrImage: null, name: null };

async function loginWithQR(zalo) {
    loginState.status = "đang tạo mã QR";
    return zalo.loginQR({}, (event) => {
        switch (event.type) {
            case LoginQRCallbackEventType.QRCodeGenerated: {
                const img = event.data.image;
                loginState.qrImage = img.startsWith("data:") ? img : `data:image/png;base64,${img}`;
                loginState.status = "cần quét QR";
                break;
            }
            case LoginQRCallbackEventType.QRCodeExpired:
                loginState.status = "QR hết hạn, đang tạo lại";
                event.actions.retry();
                break;
            case LoginQRCallbackEventType.QRCodeScanned:
                loginState.status = `đã quét bởi ${event.data.display_name}, hãy bấm xác nhận trên điện thoại`;
                break;
            case LoginQRCallbackEventType.GotLoginInfo:
                saveSession(event.data).catch((e) => console.error("Không lưu được phiên Zalo:", e.message));
                break;
        }
    });
}

export async function login({ forceQR = false } = {}) {
    const zalo = new Zalo({ selfListen: false, logging: false });
    let api = null;

    const session = forceQR ? null : await loadSession();
    if (session) {
        try {
            api = await zalo.login(session);
        } catch (e) {
            console.log("Phiên đăng nhập cũ hết hạn, cần quét QR lại.");
        }
    }
    if (!api) api = await loginWithQR(zalo);

    loginState.status = "đã đăng nhập";
    loginState.qrImage = null;
    return api;
}

/**
 * Lấy lịch sử nhóm qua /api/cm/getrecentv2 (api.getGroupChatHistory của zca-js 2.2.0 gọi
 * /api/group/history đã bị Zalo trả 404). Zalo chỉ trả tin gửi sau lúc nick đăng nhập công cụ,
 * tin cũ hơn trả về rỗng với isFiltered=1, nên gặp vài trang rỗng liên tiếp thì dừng.
 */
export async function fetchGroupHistory(api, groupId, maxMsgs) {
    if (!api.getRecentGroupMsgs) {
        api.custom("getRecentGroupMsgs", async ({ ctx, utils, props }) => {
            const url = utils.makeURL(`${api.zpwServiceMap.group_cloud_message[0]}/api/cm/getrecentv2`);
            const params = { groupId: props.groupId, globalMsgId: props.cursor, count: 50, msgIds: [], imei: ctx.imei, src: 3 };
            const res = await utils.request(
                utils.makeURL(url, { params: utils.encodeAES(JSON.stringify(params)), nretry: 0 }),
                { method: "GET" },
            );
            return utils.resolve(res, (r) => (typeof r.data === "string" ? JSON.parse(r.data) : r.data));
        });
    }

    const msgs = new Map();
    let cursor = 0;
    let emptyPages = 0;
    while (msgs.size < maxMsgs && emptyPages < 3) {
        const page = await api.getRecentGroupMsgs({ groupId, cursor });
        const list = page.groupMsgs || [];
        list.forEach((m) => msgs.set(m.msgId, { data: m, threadId: groupId }));
        emptyPages = list.length ? 0 : emptyPages + 1;

        const next = Number(page.lastMsgId);
        if (!page.hasMore || !next || next === cursor) break;
        cursor = next;
    }
    return [...msgs.values()];
}

export async function listGroups(api) {
    const { gridVerMap } = await api.getAllGroups();
    const ids = Object.keys(gridVerMap);
    const groups = [];

    // getGroupInfo nhận tối đa ~50 nhóm mỗi lần
    for (let i = 0; i < ids.length; i += 50) {
        const { gridInfoMap } = await api.getGroupInfo(ids.slice(i, i + 50));
        for (const [id, info] of Object.entries(gridInfoMap)) groups.push({ id, ...info });
    }
    return groups.sort((a, b) => a.name.localeCompare(b.name, "vi"));
}
