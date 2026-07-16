/**
 * communities-cron.js
 * -------------------------------------------------------------------------
 * بديل مجاني بالكامل عن Cloud Functions المجدولة (لا يتطلب خطة Blaze).
 *
 * هذا سكربت Node.js عادي يتصل بقاعدة بيانات Firebase Realtime Database
 * مباشرة عبر Admin SDK باستخدام مفتاح خدمة (Service Account)، وينفّذ
 * المهام "المجدولة" الثلاث نفسها التي كانت في communities-scheduled.js:
 *
 *   1) الانتخابات الأسبوعية (تتويج الفائز + دوران المرشحين)
 *   2) إغلاق تصويت الاسم الجديد تلقائيًا
 *   3) فحص الأعضاء غير النشطين (3 أيام) وترقية أول متابع
 *
 * الفرق الوحيد: بدل أن يستدعيها Firebase Scheduler (يتطلب Blaze)، تستدعيها
 * أنت من أي مكان مجاني — جهاز شخصي، GitHub Actions، أو أي خدمة استضافة تدعم
 * "cron jobs" مجانية. كل دالة هنا "idempotent" (آمنة عند التكرار)، لذلك يمكنك
 * تشغيل هذا السكربت كل ساعة بلا خوف من تكرار تنفيذ نفس الإجراء مرتين:
 *   - الانتخابات تُعالَج فقط إن مرّ أسبوع كامل منذ آخر معالجة (lastElectionRunAt).
 *   - تصويت الاسم يُغلق فقط إن مرّت مدة النافذة الزمنية المحددة.
 *   - فحص النشاط يعتمد على lastActiveAt الفعلي لكل عضو.
 * ---------------------------------------------------------------------------
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  const localPath = path.join(__dirname, 'serviceAccountKey.json');
  if (fs.existsSync(localPath)) {
    return JSON.parse(fs.readFileSync(localPath, 'utf8'));
  }
  throw new Error('لم يتم العثور على مفتاح الخدمة. عرّف FIREBASE_SERVICE_ACCOUNT_JSON أو ضع serviceAccountKey.json بجانب السكربت.');
}

const databaseURL = process.env.FIREBASE_DATABASE_URL;
if (!databaseURL) {
  throw new Error('عرّف متغير البيئة FIREBASE_DATABASE_URL (رابط قاعدة بيانات Realtime Database الخاصة بمشروعك).');
}

admin.initializeApp({
  credential: admin.credential.cert(loadServiceAccount()),
  databaseURL
});
const db = admin.database();

/* ================= ثوابت مطابقة لكود العميل ================= */
const COMM_INACTIVITY_DAYS = 3;
const COMM_NAME_VOTE_WINDOW_HOURS = 48;
const COMM_ELECTION_INTERVAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ============================================================
   1) الانتخابات الأسبوعية — تُعالَج فقط إن مرّ أسبوع كامل فعليًا
   ============================================================ */
async function runWeeklyElections() {
  const snap = await db.ref('communities').once('value');
  const communities = snap.val() || {};
  const updates = {};
  const now = Date.now();
  let processed = 0;

  for (const cid of Object.keys(communities)) {
    const c = communities[cid];
    if (!c || !Array.isArray(c.candidates) || c.candidates.length === 0) continue;

    const lastRun = c.lastElectionRunAt || 0;
    if (now - lastRun < COMM_ELECTION_INTERVAL_DAYS * DAY_MS) continue;

    const core = c.core || {};
    const votes = c.electionVotes || {};

    const counts = {};
    c.candidates.forEach(code => { counts[code] = 0; });
    Object.values(votes).forEach(code => { if (counts[code] !== undefined) counts[code]++; });

    let winner = c.candidates[0];
    c.candidates.forEach(code => { if (counts[code] > counts[winner]) winner = code; });

    if (winner && winner !== c.ownerCode) {
      if (c.ownerCode && core[c.ownerCode]) updates[`communities/${cid}/core/${c.ownerCode}/role`] = 'member';
      if (core[winner]) updates[`communities/${cid}/core/${winner}/role`] = 'owner';
      updates[`communities/${cid}/ownerCode`] = winner;
      updates[`communities/${cid}/ownerSince`] = admin.database.ServerValue.TIMESTAMP;
      updates[`communities/${cid}/nameProposalUsedThisTerm`] = false;
    }

    let lowest = c.candidates[0];
    c.candidates.forEach(code => { if (counts[code] < counts[lowest]) lowest = code; });
    const remaining = c.candidates.filter(code => code !== lowest);

    const coreSortedByJoin = Object.keys(core).sort((a, b) => (core[a].joinedAt || 0) - (core[b].joinedAt || 0));
    const poolIndex = typeof c.candidatePoolIndex === 'number' ? c.candidatePoolIndex : 5;
    let nextCandidates = remaining;
    let nextPoolIndex = poolIndex;
    if (poolIndex < coreSortedByJoin.length) {
      const nextCode = coreSortedByJoin[poolIndex];
      if (!remaining.includes(nextCode)) nextCandidates = [...remaining, nextCode];
      nextPoolIndex = poolIndex + 1;
    }

    updates[`communities/${cid}/candidates`] = nextCandidates;
    updates[`communities/${cid}/candidatePoolIndex`] = nextPoolIndex;
    updates[`communities/${cid}/electionVotes`] = null;
    updates[`communities/${cid}/lastElectionRunAt`] = now;
    processed++;
  }

  if (Object.keys(updates).length > 0) await db.ref().update(updates);
  console.log(`[weeklyElections] عولجت ${processed} جماعة`);
}

/* ============================================================
   2) إغلاق تصويت الاسم الجديد تلقائيًا
   ============================================================ */
async function runCloseNameVotes() {
  const snap = await db.ref('communities').once('value');
  const communities = snap.val() || {};
  const updates = {};
  const now = Date.now();
  let processed = 0;

  for (const cid of Object.keys(communities)) {
    const c = communities[cid];
    const proposal = c && c.nameProposal;
    if (!proposal || !proposal.open) continue;
    const ageHours = (now - (proposal.proposedAt || now)) / (60 * 60 * 1000);
    if (ageHours < COMM_NAME_VOTE_WINDOW_HOURS) continue;

    const votes = proposal.votes || {};
    let keep = 0, neu = 0;
    Object.values(votes).forEach(v => { if (v === 'new') neu++; else keep++; });

    if (neu > keep) updates[`communities/${cid}/name`] = proposal.newName;
    updates[`communities/${cid}/nameProposal/open`] = false;
    updates[`communities/${cid}/nameProposal/closedAt`] = admin.database.ServerValue.TIMESTAMP;
    updates[`communities/${cid}/nameProposal/result`] = neu > keep ? 'new' : 'keep';
    processed++;
  }

  if (Object.keys(updates).length > 0) await db.ref().update(updates);
  console.log(`[closeNameVotes] عولجت ${processed} جماعة`);
}

/* ============================================================
   3) فحص عدم النشاط (3 أيام) + ترقية أول متابع
   ============================================================ */
async function runCheckInactiveMembers() {
  const snap = await db.ref('communities').once('value');
  const communities = snap.val() || {};
  const updates = {};
  const now = Date.now();
  let totalRemoved = 0;

  for (const cid of Object.keys(communities)) {
    const c = communities[cid];
    if (!c || !c.core) continue;
    const core = c.core;

    const inactiveCodes = Object.keys(core).filter(code => {
      const m = core[code];
      const lastActive = m.lastActiveAt || m.joinedAt || now;
      return (now - lastActive) / DAY_MS >= COMM_INACTIVITY_DAYS;
    });
    if (inactiveCodes.length === 0) continue;

    const followers = c.followers || {};
    const followerCodesSorted = Object.keys(followers)
      .filter(code => !inactiveCodes.includes(code))
      .sort((a, b) => (followers[a].joinedAt || 0) - (followers[b].joinedAt || 0));
    let followerCursor = 0;

    inactiveCodes.forEach(code => {
      updates[`communities/${cid}/core/${code}`] = null;
      updates[`userCommunities/${code}`] = null;
      if (c.candidates && c.candidates.includes(code)) {
        updates[`communities/${cid}/candidates`] = c.candidates.filter(x => x !== code);
      }
      if (c.ownerCode === code) updates[`communities/${cid}/ownerCode`] = null;

      if (followerCursor < followerCodesSorted.length) {
        const promotedCode = followerCodesSorted[followerCursor];
        followerCursor++;
        const f = followers[promotedCode];
        updates[`communities/${cid}/core/${promotedCode}`] = {
          name: f.name || promotedCode,
          role: 'member',
          joinedAt: admin.database.ServerValue.TIMESTAMP,
          lastActiveAt: admin.database.ServerValue.TIMESTAMP
        };
        updates[`communities/${cid}/followers/${promotedCode}`] = null;
      }
    });

    totalRemoved += inactiveCodes.length;
  }

  if (Object.keys(updates).length > 0) await db.ref().update(updates);
  console.log(`[checkInactiveMembers] أُزيل ${totalRemoved} عضوًا غير نشط إجمالاً`);
}

/* ============================================================
   تشغيل كل شيء بالتسلسل، ثم إنهاء العملية بأمان
   ============================================================ */
async function main() {
  console.log('بدء صيانة الجماعات —', new Date().toISOString());
  await runWeeklyElections();
  await runCloseNameVotes();
  await runCheckInactiveMembers();
  console.log('انتهت الصيانة بنجاح.');
  process.exit(0);
}

main().catch(err => {
  console.error('فشلت الصيانة:', err);
  process.exit(1);
});
