/**
 * عماد شات — فرز الانتخابات الأسبوعية + تدوير المرشحين
 * =======================================================
 * تُشغَّل هذه السكربت مرة كل أسبوع عبر GitHub Actions (انظر
 * .github/workflows/scheduled-tasks.yml). لكل جماعة تحتوي على مرشحين:
 *   - تفرز أصوات electionVotes.
 *   - الفائز (الأعلى أصواتًا) يُصبح المالك الجديد (إن لم يكن هو المالك أصلاً).
 *   - المرشح الأقل أصواتًا يُحذف من قائمة المرشحين، ويدخل بدلاً منه أقدم
 *     عضو أساسي (حسب تاريخ الانضمام) ليس مرشحًا حاليًا.
 *   - تصفير التصويت لبدء جولة جديدة.
 *
 * تشغيل يدوي محلي (للاختبار):
 *   FIREBASE_SERVICE_ACCOUNT_KEY='...' FIREBASE_DATABASE_URL='...' node scripts/weeklyElectionTally.js
 */
const { initAdmin } = require('./firebaseAdmin');

async function run() {
  const admin = initAdmin();
  const db = admin.database();

  const snap = await db.ref('communities').once('value');
  const communities = snap.val() || {};
  const updates = {};
  let touchedCommunities = 0;

  for (const cid of Object.keys(communities)) {
    const c = communities[cid] || {};
    const candidates = Array.isArray(c.candidates) ? c.candidates : [];
    if (candidates.length === 0) continue; // جماعة بلا مرشحين بعد (لا يوجد أعضاء كفاية)

    const core = c.core || {};
    const votes = c.electionVotes || {};

    const counts = {};
    candidates.forEach(code => { counts[code] = 0; });
    Object.values(votes).forEach(votedFor => {
      if (Object.prototype.hasOwnProperty.call(counts, votedFor)) counts[votedFor]++;
    });

    // الفائز = الأعلى أصواتًا (عند التعادل نُفضّل المالك الحالي لضمان استقرار النتيجة)
    let winner = candidates[0];
    candidates.forEach(code => {
      if (counts[code] > counts[winner]) winner = code;
      else if (counts[code] === counts[winner] && code === c.ownerCode) winner = code;
    });

    // الأقل أصواتًا يخرج من قائمة المرشحين
    let loser = candidates[0];
    candidates.forEach(code => { if (counts[code] < counts[loser]) loser = code; });

    // أقدم عضو أساسي ليس مرشحًا حاليًا يدخل بدلاً منه
    const coreSortedByJoin = Object.keys(core).sort(
      (a, b) => (core[a].joinedAt || 0) - (core[b].joinedAt || 0)
    );
    const nextCandidate = coreSortedByJoin.find(code => !candidates.includes(code) && code !== loser);

    const newCandidates = candidates.filter(code => code !== loser);
    if (nextCandidate) newCandidates.push(nextCandidate);

    updates[`communities/${cid}/candidates`] = newCandidates;
    updates[`communities/${cid}/electionVotes`] = null;

    if (winner && winner !== c.ownerCode) {
      if (c.ownerCode && core[c.ownerCode]) {
        updates[`communities/${cid}/core/${c.ownerCode}/role`] = 'member';
      }
      updates[`communities/${cid}/ownerCode`] = winner;
      updates[`communities/${cid}/ownerSince`] = admin.database.ServerValue.TIMESTAMP;
      updates[`communities/${cid}/nameProposalUsedThisTerm`] = false;
      if (core[winner]) updates[`communities/${cid}/core/${winner}/role`] = 'owner';
    }

    touchedCommunities++;
  }

  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
    console.log(`تم تحديث ${touchedCommunities} جماعة (${Object.keys(updates).length} مسار).`);
  } else {
    console.log('لا توجد جماعات لديها مرشحون بعد — لا شيء لتنفيذه هذا الأسبوع.');
  }

  process.exit(0);
}

run().catch(err => {
  console.error('فشل تنفيذ weeklyElectionTally:', err);
  process.exit(1);
});
