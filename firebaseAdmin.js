/**
 * تهيئة Firebase Admin SDK باستخدام مفتاح حساب الخدمة (Service Account)
 * الممرَّر عبر متغيرات البيئة من GitHub Actions.
 *
 * يتوقع هذا الملف متغيرين بيئيين (يتم تمريرهما من ملف الـ workflow):
 *   FIREBASE_SERVICE_ACCOUNT_KEY  -> محتوى ملف JSON الخاص بحساب الخدمة (كنص كامل)
 *   FIREBASE_DATABASE_URL         -> رابط قاعدة البيانات، مثل:
 *                                    https://idousalhnews-default-rtdb.firebaseio.com
 */
const admin = require('firebase-admin');

function initAdmin() {
  if (admin.apps.length) return admin; // منع التهيئة المزدوجة إن استُدعيت أكثر من مرة

  const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  const databaseURL = process.env.FIREBASE_DATABASE_URL;

  if (!rawKey) {
    throw new Error('المتغير FIREBASE_SERVICE_ACCOUNT_KEY غير موجود. تأكد من ضبطه كـ GitHub Secret وتمريره في ملف الـ workflow.');
  }
  if (!databaseURL) {
    throw new Error('المتغير FIREBASE_DATABASE_URL غير موجود. تأكد من ضبطه كـ GitHub Secret وتمريره في ملف الـ workflow.');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(rawKey);
  } catch (e) {
    throw new Error('تعذّر قراءة FIREBASE_SERVICE_ACCOUNT_KEY كـ JSON صالح. تأكد من نسخ محتوى الملف كاملاً دون تعديل عند إضافته كـ Secret.');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL
  });

  return admin;
}

module.exports = { initAdmin };
