/**
 * عماد شات — فحص النشاط الإجباري اليومي
 * ==========================================
 * تُشغَّل هذه السكربت يوميًا عبر GitHub Actions. أي عضو أساسي لم ينشط
 * (lastActiveAt) منذ 3 أيام كاملة تتم إزالته تلقائيًا من جماعته، ويحل محله
 * أول متابع بالانتظار (الأقدم انضمامًا) كعضو أساسي جديد.
 *
 * تشغيل يدوي محلي (للاختبار):
 *   FIREBASE_SERVICE_ACCOUNT_KEY='...' FIREBASE_DATABASE_URL='...' node scripts/inactivityCheck.js
 */
const { initAdmin } = require('./firebaseAdmin');

const COMM_INACTIVITY_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function run() {
  const admin = initAdmin();
  const db = admin.database();

  const snap = await db.ref('communities').once('value');
  const communities = snap.val() || {};
  const updates = {};
  const now = Date.now();
  let removedCount = 0;

  for (const cid of Object.keys(communities)) {
    const c = communities[cid] || {};
    const core = c.core || {};
    const followers = c.followers || {};

    const inactiveCodes = Object.keys(core).filter(code => {
      const lastActive = core[code].lastActiveAt || core[code].joinedAt || 0;
      return (now - lastActive) > (COMM_INACTIVITY_DAYS * MS_PER_DAY);
    });
    if (inactiveCodes.length === 0) continue;

    let waitingFollowers = Object.keys(followers).sort(
      (a, b) => (followers[a].joinedAt || 0) - (followers[b].joinedAt || 0)
    );

    inactiveCodes.forEach(code => {
      updates[`communities/${cid}/core/${code}`] = null;
      updates[`userCommunities/${code}`] = null;
      removedCount++;

      if (c.ownerCode === code) {
        updates[`communities/${cid}/ownerCode`] = null;
      }

      const nextFollower = waitingFollowers.shift();
      if (nextFollower) {
        const followerData = followers[nextFollower] || {};
        updates[`communities/${cid}/followers/${nextFollower}`] = null;
        updates[`communities/${cid}/core/${nextFollower}`] = {
          name: followerData.name || nextFollower,
          nickname: followerData.nickname || '',
          role: 'member',
          points: followerData.points || 0,
          joinedAt: admin.database.ServerValue.TIMESTAMP,
          lastActiveAt: admin.database.ServerValue.TIMESTAMP
        };
        updates[`userCommunities/${nextFollower}`] = cid;
      }
    });
  }

  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
    console.log(`تمت إزالة ${removedCount} عضوًا غير نشط وترقية بدلاء لهم حيثما أمكن.`);
  } else {
    console.log('لا يوجد أعضاء غير نشطين اليوم.');
  }

  process.exit(0);
}

run().catch(err => {
  console.error('فشل تنفيذ inactivityCheck:', err);
  process.exit(1);
});
