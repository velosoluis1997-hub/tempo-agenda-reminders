import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();
const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
const date = `${p.year}-${p.month}-${p.day}`, minute = Number(p.hour) * 60 + Number(p.minute);
for (const agenda of (await db.collectionGroup('agenda').get()).docs) {
  const { events = [], pushToken } = agenda.data();
  if (!pushToken) continue;
  for (const event of events) {
    if (!event.start || !event.reminder || event.date !== date) continue;
    const [h, m] = event.start.split(':').map(Number);
    if (h * 60 + m - Number(event.reminder) !== minute) continue;
    const sent = agenda.ref.collection('sentReminders').doc(`${date}_${event.id}`);
    const shouldSend = await db.runTransaction(async tx => { if ((await tx.get(sent)).exists) return false; tx.set(sent, { sentAt: FieldValue.serverTimestamp() }); return true; });
    if (shouldSend) await getMessaging().send({ token: pushToken, notification: { title: 'Tempo', body: `${event.title} começa às ${event.start}` }, webpush: { fcmOptions: { link: 'https://delightful-treacle-f249d7.netlify.app/' } } });
  }
}
