import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();
const now = new Date();
const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
const date = `${parts.year}-${parts.month}-${parts.day}`;
const currentMinute = Number(parts.hour) * 60 + Number(parts.minute);
for (const user of (await db.collection('users').get()).docs) {
  const { events = [], pushToken } = user.data();
  if (!pushToken) continue;
  for (const event of events) {
    if (!event.start || !event.reminder || event.date !== date) continue;
    const [h, m] = event.start.split(':').map(Number);
    if (h * 60 + m - Number(event.reminder) !== currentMinute) continue;
    const sent = user.ref.collection('sentReminders').doc(`${date}_${event.id}`);
    const send = await db.runTransaction(async tx => { if ((await tx.get(sent)).exists) return false; tx.set(sent, { sentAt: FieldValue.serverTimestamp() }); return true; });
    if (send) await getMessaging().send({ token: pushToken, notification: { title: 'Tempo', body: `${event.title} começa às ${event.start}` }, webpush: { fcmOptions: { link: 'https://delightful-treacle-f249d7.netlify.app/' } } });
  }
}
