import { initializeApp } from "firebase/app";
import { initializeFirestore } from "firebase/firestore";
import { initializeApp as initializeAdminApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

// Server không dùng khóa service account: đọc/ghi Firestore bằng SDK web (Rules mở),
// và chỉ cần projectId để kiểm tra token đăng nhập Google của trang web.
const firebaseConfig = {
    apiKey: "AIzaSyCgP0OrQ_TSOpHGOeur3Ij4oK3S_jFG_iI",
    authDomain: "autozalo-e8aa9.firebaseapp.com",
    projectId: "autozalo-e8aa9",
    appId: "1:352708909747:web:f923122e8392e58b0b2ec6",
};

export const firestore = initializeFirestore(initializeApp(firebaseConfig), { ignoreUndefinedProperties: true });

export const auth = getAuth(initializeAdminApp({ projectId: firebaseConfig.projectId }));
