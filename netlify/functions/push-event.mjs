import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { getMessaging } from 'firebase-admin/messaging';

const PROJECT_ID = 'i-s-wholesale-communication';
const DATABASE_URL = 'https://i-s-wholesale-communication-default-rtdb.firebaseio.com';
const SITE_URL = 'https://is-wholesale-communication.netlify.app/';

function getAdminApp() {
  if (getApps().length) return getApps()[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT environment variable');
  const serviceAccount = JSON.parse(raw);
  return initializeApp({
    credential: cert(serviceAccount),
    projectId: PROJECT_ID,
    databaseURL: DATABASE_URL
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function tokensForUid(db, uid) {
  const snap = await db.ref(`pushTokens/${uid}`).once('value');
  const records = snap.val() || {};
  const entries = Object.entries(records).filter(([, value]) => value?.token);
  return { records, entries, tokens: [...new Set(entries.map(([, value]) => value.token))] };
}

async function sendToUid(db, messaging, uid, title, body, tag, url = SITE_URL) {
  if (!uid) return { sent: 0, skipped: true };
  const { records, entries, tokens } = await tokensForUid(db, uid);
  if (!tokens.length) return { sent: 0, skipped: true };

  let successCount = 0;
  const invalid = new Set();
  for (let offset = 0; offset < tokens.length; offset += 500) {
    const batch = tokens.slice(offset, offset + 500);
    const result = await messaging.sendEachForMulticast({
      tokens: batch,
      notification: { title, body },
      data: { url, tag },
      webpush: {
        notification: { icon: `${SITE_URL}logo.jpg`, badge: `${SITE_URL}logo.jpg`, tag, renotify: true },
        fcmOptions: { link: url }
      }
    });
    successCount += result.successCount;
    result.responses.forEach((response, index) => {
      const code = response.error?.code || '';
      if (!response.success && (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token'))) {
        invalid.add(batch[index]);
      }
    });
  }

  const removals = [];
  for (const [key, value] of entries) {
    if (invalid.has(value.token)) removals.push(db.ref(`pushTokens/${uid}/${key}`).remove());
  }
  await Promise.all(removals);
  return { sent: successCount, skipped: false };
}

async function claimEvent(db, eventKey) {
  const ref = db.ref(`pushEventClaims/${eventKey}`);
  const result = await ref.transaction(current => current ? undefined : { createdAt: Date.now() }, undefined, false);
  return { claimed: result.committed, ref };
}

export default async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const authorization = request.headers.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) return json({ error: 'Authentication required' }, 401);

    const app = getAdminApp();
    const decoded = await getAuth(app).verifyIdToken(match[1]);
    const db = getDatabase(app);
    const messaging = getMessaging(app);
    const body = await request.json();
    const event = String(body.event || '');
    const ownerUid = String(body.ownerUid || '');
    const orderId = String(body.orderId || '');
    const listId = String(body.listId || '');

    if (event === 'new-order') {
      if (!ownerUid || !orderId) return json({ error: 'Missing order details' }, 400);
      const orderSnap = await db.ref(`customerOrders/${ownerUid}/${orderId}`).once('value');
      const order = orderSnap.val();
      if (!order || order.customerUid !== decoded.uid || order.confirmed === true) return json({ error: 'Order not authorized' }, 403);
      const { tokens } = await tokensForUid(db, ownerUid);
      if (!tokens.length) return json({ ok: true, sent: 0, message: 'No opted-in shop devices' });
      const claim = await claimEvent(db, `new-order_${ownerUid}_${orderId}`);
      if (!claim.claimed) return json({ ok: true, duplicate: true, sent: 0 });
      try {
        const result = await sendToUid(db, messaging, ownerUid, 'i.S Wholesale Communication', 'आपकी वेबसाइट पर एक नया ऑर्डर आया है।', `new-order-${orderId}`);
        return json({ ok: true, ...result });
      } catch (error) {
        await claim.ref.remove();
        throw error;
      }
    }

    if (event === 'order-confirmed') {
      if (!ownerUid || !orderId || decoded.uid !== ownerUid) return json({ error: 'Not authorized' }, 403);
      const orderSnap = await db.ref(`customerOrders/${ownerUid}/${orderId}`).once('value');
      const order = orderSnap.val();
      if (!order || order.confirmed !== true || !order.customerUid) return json({ error: 'Confirmed order not found' }, 404);
      const { tokens } = await tokensForUid(db, order.customerUid);
      if (!tokens.length) return json({ ok: true, sent: 0, message: 'No opted-in customer devices' });
      const claim = await claimEvent(db, `order-confirmed_${ownerUid}_${orderId}`);
      if (!claim.claimed) return json({ ok: true, duplicate: true, sent: 0 });
      try {
        const result = await sendToUid(db, messaging, order.customerUid, 'i.S Wholesale Communication', 'डिलीवरी कन्फर्म।', `delivery-confirmed-${orderId}`);
        return json({ ok: true, ...result });
      } catch (error) {
        await claim.ref.remove();
        throw error;
      }
    }

    if (event === 'list-reshared') {
      if (!ownerUid || !listId || decoded.uid !== ownerUid || !Number.isFinite(Number(body.sharedAt))) return json({ error: 'Not authorized' }, 403);
      const listSnap = await db.ref(`publicLists/${ownerUid}/${listId}`).once('value');
      const payload = listSnap.val();
      if (!payload || Number(payload.sharedAt) !== Number(body.sharedAt)) return json({ error: 'List share version not found' }, 404);
      const subscriberSnap = await db.ref(`publicListSubscribers/${ownerUid}/${listId}`).once('value');
      const subscribers = Object.keys(subscriberSnap.val() || {}).filter(uid => uid !== ownerUid);
      if (!subscribers.length) return json({ ok: true, sent: 0, message: 'No subscribed customers' });
      const claim = await claimEvent(db, `list-reshared_${ownerUid}_${listId}_${body.sharedAt}`);
      if (!claim.claimed) return json({ ok: true, duplicate: true, sent: 0 });
      try {
        const listName = payload.list?.name || 'नई लिस्ट';
        let sent = 0;
        for (const uid of subscribers) {
          const result = await sendToUid(db, messaging, uid, 'i.S Wholesale Communication', `दुकानदार ने आपको नई लिस्ट भेजी है: ${listName}`, `list-reshared-${listId}-${body.sharedAt}`);
          sent += result.sent;
        }
        return json({ ok: true, sent });
      } catch (error) {
        await claim.ref.remove();
        throw error;
      }
    }

    return json({ error: 'Unknown event' }, 400);
  } catch (error) {
    console.error('Push event failed:', error);
    return json({ error: 'Push event failed', detail: error.message || 'Unknown error' }, 500);
  }
};
