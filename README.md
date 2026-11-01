# Server quét nhóm Zalo

Express + [zca-js](https://github.com/RFS-ADRENO/zca-js). Đăng nhập Zalo bằng QR, nhận tin mới và thả tim ngay khi có, quét định kỳ,
lưu dữ liệu vào **Firestore** và ảnh lên **Cloudinary**. Trang quản lý ở repo web riêng (Vercel).

**Quy tắc hết hàng:** chủ nhóm/phó nhóm **thả tim** vào ảnh, hoặc **trả lời** tin với chữ "hết", "đã bán"…
Trả lời "còn hàng", "về lại"… hoặc bỏ tim → còn hàng lại. Tim của khách không tính.

## Chuẩn bị

**Firestore** (dự án `autozalo-e8aa9`): Firestore Database → Rules → dán rồi Publish:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```

Server không cần khóa service account. Phiên đăng nhập Zalo được mã hóa bằng `APP_SECRET` trước khi lưu.

## Deploy lên Render

**New → Web Service** → chọn repo này:

| Mục | Giá trị |
|---|---|
| Region | **Singapore** |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free |

**Environment** (xem `.env.example`):

| Biến | Giá trị |
|---|---|
| `CLOUDINARY_URL` | `cloudinary://API_KEY:API_SECRET@CLOUD_NAME` |
| `ALLOWED_EMAILS` | Email Google được vào trang quản lý |
| `APP_SECRET` | Chuỗi bí mật tự đặt, dài và khó đoán |
| `CORS_ORIGIN` | (Không bắt buộc) link trang Vercel |

Mở `https://<tên>.onrender.com/ping` thấy `ok` là chạy.

**Giữ server không ngủ:** tạo cronjob trên https://cron-job.org gọi `https://<tên>.onrender.com/ping` **mỗi 10 phút**.

## Quét tin cũ (`tools/quet-tin-cu`, chạy trên máy tính)

Zalo chỉ cho server đọc tin gửi sau lúc nick đăng nhập. Hàng cũ hơn lấy qua Zalo Web bằng công cụ này. Cần **Node.js** và **Google Chrome**.

1. Copy `tools/quet-tin-cu/config.example.json` thành `config.json`, điền `serverUrl` (link Render) và `appSecret` (giống `APP_SECRET`).
2. Bấm đúp `tools/quet-tin-cu/quet-tin-cu.bat`.
3. Trong Chrome: quét QR (**nên dùng nick khác nick của server**), **đồng bộ tin nhắn** từ điện thoại, mở nhóm.
4. Quay lại cửa sổ đen bấm **Enter**. Công cụ tự cuộn, đọc ảnh, mô tả, tin trả lời, thả tim và gửi lên server.

Zalo Web chỉ giữ khoảng **2 tuần** tin gần nhất.

## Chạy trên máy

```bash
cp .env.example .env   # điền giá trị
npm install
npm run dev            # http://localhost:3000
```
