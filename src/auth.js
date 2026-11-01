import { auth } from "./firebase.js";

// ALLOWED_EMAILS: danh sách email Google được vào trang quản lý, cách nhau bởi dấu phẩy
const allowed = (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

// Trang web gửi Firebase ID token; công cụ quét tin cũ gửi APP_SECRET
export async function requireUser(req, res, next) {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "Chưa đăng nhập" });

    if (process.env.APP_SECRET && token === process.env.APP_SECRET) {
        req.user = { email: "import-tool" };
        return next();
    }
    try {
        const user = await auth.verifyIdToken(token);
        if (!allowed.includes((user.email || "").toLowerCase())) {
            return res.status(403).json({ error: `Email ${user.email} không có quyền truy cập` });
        }
        req.user = user;
        next();
    } catch {
        res.status(401).json({ error: "Phiên đăng nhập không hợp lệ, hãy đăng nhập lại" });
    }
}
