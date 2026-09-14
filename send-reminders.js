import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const TIME_ZONE = 'Europe/Lisbon';
const MINUTE = 60000;
const DAY = 86400000;
const OVERLAP = 30 * MINUTE;
const MAX_CATCH_UP = DAY;
const LEASE_TIME = 5 * MINUTE;
const APP_URL = 'https://delightful-treacle-f249d7.netlify.app/';
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function localParts(value) {
  return Object.fromEntries(formatter.formatToParts(new Date(value))
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

export function localDate(value) {
  const p = localParts(value);
  return `${p.year}-${p.month}-${p.day}`;
}

function dateNumber(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const value = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date ? value : NaN;
}

function shiftedDate(date, days) {
  return new Date(dateNumber(date) + days * DAY).toISOString().slice(0, 10);
}

// Use calendar dates, not elapsed local-midnight hours, across daylight-saving changes.
export function occursOn(event, date) {
  const origin = dateNumber(event.date);
  const target = dateNumber(date);
  if (!Number.isFinite(origin) || !Number.isFinite(target) || target < origin) return false;
  if (target === origin || event.repeat === 'daily') return true;
  if (event.repeat === 'weekly') return ((target - origin) / DAY) % 7 === 0;
  return event.repeat === 'monthly' && event.date.slice(8) === date.slice(8);
}

// Ambiguous autumn times use the first occurrence. Nonexistent spring times move
// forward by the DST gap, matching the usual local-calendar interpretation.
export function occurrenceTime(date, time) {
  const day = dateNumber(date);
  if (!Number.isFinite(day) || typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
  const [hour, minute] = time.split(':').map(Number);
  const wallTime = day + (hour * 60 + minute) * MINUTE;
  const offsets = new Set([-36, 0, 36].map(hours => {
    const instant = wallTime + hours * 60 * MINUTE;
    const p = localParts(instant);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - instant;
  }));
  const candidates = [...offsets].map(offset => wallTime - offset);
  const exact = candidates.filter(instant => {
    const p = localParts(instant);
    return `${p.year}-${p.month}-${p.day}` === date && `${p.hour}:${p.minute}` === time;
  });
  return exact.length ? Math.min(...exact) : wallTime - Math.min(...offsets);
}

export function dueReminders(events, now, checkedThrough) {
  if (!Array.isArray(events)) return [];
  const checkpoint = Number.isFinite(checkedThrough) ? Math.min(checkedThrough, now) : now;
  const since = Math.max(now - MAX_CATCH_UP, checkpoint - OVERLAP);
  const due = [];
  for (const event of events) {
    if (!event || typeof event.id !== 'string' || !event.id || event.id.length > 200 ||
        !event.start || ((event.task || event.taskList) && event.done)) continue;
    const reminder = Number(event.reminder);
    if (!Number.isFinite(reminder) || reminder <= 0 || reminder > 7 * 24 * 60) continue;
    // Include adjacent dates so reminders can fall before midnight or cross DST.
    const first = shiftedDate(localDate(since + reminder * MINUTE), -1);
    const last = shiftedDate(localDate(now + reminder * MINUTE), 1);
    for (let date = first; date <= last; date = shiftedDate(date, 1)) {
      if (!occursOn(event, date)) continue;
      const startsAt = occurrenceTime(date, event.start);
      const dueAt = startsAt - reminder * MINUTE;
      // Drop reminders more than 30 minutes after the event has begun.
      if (!Number.isFinite(dueAt) || dueAt < since || dueAt > now || now > startsAt + OVERLAP) continue;
      due.push({ event, date, dueAt, startsAt,
        id: `${date}_${encodeURIComponent(event.id)}`,
        tag: `tempo-${date}-${event.id}`,
        scheduleKey: `${date}T${event.start}|${reminder}` });
    }
  }
  return due.sort((a, b) => a.dueAt - b.dueAt);
}

function errorCode(error) {
  return typeof error?.code === 'string' ? error.code.slice(0, 100) : 'send-failed';
}

function isInvalidToken(error) {
  return ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error?.code);
}

async function claimReminder(db, ref, reminder, now, owner, fields) {
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const previous = snapshot.exists ? snapshot.data() : {};
    const sameSchedule = !previous.scheduleKey || previous.scheduleKey === reminder.scheduleKey;
    // Respect confirmations made by the previous version as well as this worker.
    if (sameSchedule && (previous.status === 'sent' || (!previous.status && previous.sentAt))) return 'sent';
    if (sameSchedule && (previous.leaseUntilMs > now || previous.nextAttemptAtMs > now)) return 'busy';
    tx.set(ref, {
      status: 'sending', scheduleKey: reminder.scheduleKey, owner,
      dueAtMs: reminder.dueAt, leaseUntilMs: now + LEASE_TIME,
      attempts: sameSchedule ? (Number(previous.attempts) || 0) + 1 : 1,
      nextAttemptAtMs: fields.delete(), sentAt: fields.delete(), lastError: fields.delete()
    }, { merge: true });
    return 'claimed';
  });
}

async function recordResult(db, ref, reminder, owner, fields, now, error) {
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const record = snapshot.exists ? snapshot.data() : {};
    if (record.owner !== owner || record.scheduleKey !== reminder.scheduleKey) return;
    const result = error ? {
      status: 'retry', lastError: errorCode(error),
      nextAttemptAtMs: now + Math.min(15, 2 ** Math.min(Number(record.attempts) || 1, 4)) * MINUTE
    } : {
      status: 'sent', sentAt: fields.serverTimestamp(),
      lastError: fields.delete(), nextAttemptAtMs: fields.delete()
    };
    tx.set(ref, { ...result, leaseUntilMs: fields.delete(), owner: fields.delete() }, { merge: true });
  });
}

async function removeExpiredToken(db, agendaRef, token, fields) {
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(agendaRef);
    if (snapshot.exists && snapshot.data().pushToken === token) {
      tx.update(agendaRef, { pushToken: fields.delete(), pushTokenInvalidatedAt: fields.serverTimestamp() });
    }
  });
}

export async function processAgenda({ db, messaging, fields, agenda, now, log = console }) {
  const data = agenda.data();
  const { pushToken } = data;
  const result = { sent: 0, failed: 0, skipped: 0 };
  if (typeof pushToken !== 'string' || !pushToken) return result;
  const pending = dueReminders(data.events, now, data.reminderCheckedThroughMs);
  let complete = true;
  for (const reminder of pending) {
    const ref = agenda.ref.collection('sentReminders').doc(reminder.id);
    const owner = randomUUID();
    let claimed = false;
    try {
      const claim = await claimReminder(db, ref, reminder, now, owner, fields);
      if (claim !== 'claimed') {
        if (claim === 'busy') complete = false;
        result.skipped++;
        continue;
      }
      claimed = true;
      const when = reminder.date === localDate(now) ? reminder.event.start : `${reminder.date} às ${reminder.event.start}`;
      await messaging.send({
        token: pushToken,
        notification: { title: 'Tempo', body: `${String(reminder.event.title || 'Evento').slice(0, 300)} · ${when}` },
        data: { reminderId: reminder.tag, reminderVersion: reminder.scheduleKey, eventId: reminder.event.id, date: reminder.date, start: reminder.event.start },
        webpush: {
          notification: { tag: reminder.tag, renotify: false },
          fcmOptions: { link: APP_URL }
        }
      });
      // A sent marker is only committed after FCM accepts the message.
      await recordResult(db, ref, reminder, owner, fields, now);
      result.sent++;
    } catch (error) {
      complete = false;
      result.failed++;
      log.error('Reminder attempt failed:', errorCode(error));
      if (claimed) {
        try { await recordResult(db, ref, reminder, owner, fields, now, error); }
        catch (writeError) { log.error('Could not record retry:', errorCode(writeError)); }
      }
      if (isInvalidToken(error)) {
        try { await removeExpiredToken(db, agenda.ref, pushToken, fields); }
        catch (writeError) { log.error('Could not remove expired token:', errorCode(writeError)); }
        break;
      }
    }
  }
  // Also establish a checkpoint for a brand-new agenda when its first send
  // fails. Otherwise a later retry would revert to the rolling 30-minute window.
  if (complete || !Number.isFinite(data.reminderCheckedThroughMs)) {
    await db.runTransaction(async tx => {
      const current = await tx.get(agenda.ref);
      if (current.exists) {
        const checkpoint = current.data().reminderCheckedThroughMs;
        if (complete || !Number.isFinite(checkpoint)) {
          tx.update(agenda.ref, { reminderCheckedThroughMs: Math.max(Number.isFinite(checkpoint) ? checkpoint : 0, now) });
        }
      }
    });
  }
  return result;
}

export async function runReminders({ db, messaging, fields, now = Date.now(), log = console }) {
  const agendas = await db.collectionGroup('agenda').get();
  const total = { sent: 0, failed: 0, skipped: 0 };
  for (const agenda of agendas.docs) {
    try {
      const result = await processAgenda({ db, messaging, fields, agenda, now, log });
      for (const key of Object.keys(total)) total[key] += result[key];
    } catch (error) {
      total.failed++;
      log.error('Agenda processing failed:', errorCode(error));
    }
  }
  log.info(`Reminders: ${total.sent} accepted, ${total.failed} failed, ${total.skipped} already handled or waiting.`);
  return total;
}

export async function main() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT is not configured');
  const [{ cert, getApps, initializeApp }, { getFirestore, FieldValue }, { getMessaging }] = await Promise.all([
    import('firebase-admin/app'), import('firebase-admin/firestore'), import('firebase-admin/messaging')
  ]);
  const credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!getApps().length) initializeApp({ credential: cert(credentials) });
  const result = await runReminders({ db: getFirestore(), messaging: getMessaging(), fields: FieldValue });
  if (result.failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Reminder worker could not finish:', errorCode(error));
    process.exitCode = 1;
  });
}
