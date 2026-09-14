import test from 'node:test';
import assert from 'node:assert/strict';
import { dueReminders, occursOn, occurrenceTime, runReminders } from './send-reminders.js';

const MINUTE = 60000;
const now = Date.parse('2026-09-12T08:45:00Z'); // 09:45 Lisbon, event starts at 10:00.
const event = (extra = {}) => ({ id: 'example', title: 'Example', date: '2026-09-12', start: '10:00', reminder: 15, repeat: 'none', ...extra });

function fixture(agendas = [{ events: [event()], pushToken: 'mock-token' }]) {
  const records = new Map(agendas.map((data, i) => [`users/user${i}/agenda/current`, structuredClone(data)]));
  const deletion = Symbol('delete');
  const fields = { delete: () => deletion, serverTimestamp: () => ({ timestamp: 'mock' }) };
  const reference = path => ({ path, collection: name => ({ doc: id => reference(`${path}/${name}/${id}`) }) });
  const snapshot = ref => ({ ref, exists: records.has(ref.path), data: () => structuredClone(records.get(ref.path)) });
  let lock = Promise.resolve();
  const db = {
    collectionGroup: name => ({ get: async () => ({ docs: [...records.keys()]
      .filter(path => path.split('/').at(-2) === name).map(path => snapshot(reference(path))) }) }),
    runTransaction: callback => {
      const task = lock.then(async () => {
        const writes = [];
        const transaction = {
          get: async ref => snapshot(ref),
          set: (ref, data, options) => writes.push({ ref, data, merge: options?.merge }),
          update: (ref, data) => {
            assert.ok(records.has(ref.path));
            writes.push({ ref, data, merge: true });
          }
        };
        const result = await callback(transaction);
        for (const { ref, data, merge } of writes) {
          const value = { ...(merge ? records.get(ref.path) : {}), ...data };
          for (const key of Object.keys(value)) if (value[key] === deletion) delete value[key];
          records.set(ref.path, value);
        }
        return result;
      });
      lock = task.catch(() => {});
      return task;
    }
  };
  const messages = [];
  let send = async () => 'mock-message';
  const messaging = { send: async message => { messages.push(message); return send(message); } };
  const log = { info() {}, error() {} };
  return { db, fields, messaging, records, messages,
    useSend: callback => { send = callback; },
    run: (time = now) => runReminders({ db, fields, messaging, log, now: time }) };
}

test('recurrence respects start date, weekly and monthly calendar dates', () => {
  assert.equal(occursOn(event({ repeat: 'daily', date: '2026-09-13' }), '2026-09-12'), false);
  assert.equal(occursOn(event({ repeat: 'weekly', date: '2026-03-22' }), '2026-03-29'), true);
  assert.equal(occursOn(event({ repeat: 'weekly', date: '2026-03-22' }), '2026-03-30'), false);
  assert.equal(occursOn(event({ repeat: 'monthly', date: '2026-01-31' }), '2026-02-28'), false);
  assert.equal(occursOn(event({ repeat: 'monthly', date: '2026-01-31' }), '2026-03-31'), true);
  assert.equal(occursOn(event({ date: '2026-02-30' }), '2026-03-02'), false);
});

test('Lisbon timing handles summer, winter, skipped and repeated DST hours', () => {
  assert.equal(occurrenceTime('2026-09-12', '10:00'), Date.parse('2026-09-12T09:00:00Z'));
  assert.equal(occurrenceTime('2026-01-12', '10:00'), Date.parse('2026-01-12T10:00:00Z'));
  assert.equal(occurrenceTime('2026-03-29', '01:30'), Date.parse('2026-03-29T01:30:00Z'));
  assert.equal(occurrenceTime('2026-10-25', '01:30'), Date.parse('2026-10-25T00:30:00Z'));
  assert.equal(Number.isNaN(occurrenceTime('2026-09-12', '25:00')), true);
});

test('delayed, weekly and monthly reminders are eligible; future daily ones are not', () => {
  assert.equal(dueReminders([event()], now + 5 * MINUTE).length, 1);
  assert.equal(dueReminders([event({ repeat: 'weekly', date: '2026-09-05' })], now).length, 1);
  assert.equal(dueReminders([event({ repeat: 'monthly', date: '2026-08-12' })], now).length, 1);
  assert.equal(dueReminders([event({ repeat: 'daily', date: '2026-09-13' })], now).length, 0);
});

test('midnight reminders belong to the following event date', () => {
  const due = dueReminders([event({ date: '2026-09-13', start: '00:10', reminder: 30 })], Date.parse('2026-09-12T22:40:00Z'));
  assert.equal(due.length, 1);
  assert.equal(due[0].date, '2026-09-13');
  assert.equal(due[0].tag, 'tempo-2026-09-13-example');
});

test('watermark recovers a >30min scheduler gap without sending yesterday events', () => {
  assert.equal(dueReminders([event({ reminder: 60 })], now, now - 90 * MINUTE).length, 1);
  assert.equal(dueReminders([event({ reminder: 60 })], now).length, 0);
  assert.equal(dueReminders([event({ date: '2026-09-11', reminder: 60 })], now, now - 86400000).length, 0);
  assert.equal(dueReminders([event()], now + 46 * MINUTE, now).length, 0);
});

test('completed tasks, all-day events, disabled and malformed reminders are skipped', () => {
  const events = [event({ task: true, done: true }), event({ task: false, taskList: 'compras', done: true }), event({ start: '' }), event({ reminder: 0 }),
    event({ reminder: 'invalid' }), event({ start: '25:00' }), event({ date: 'bad' }), null];
  assert.deepEqual(dueReminders(events, now), []);
  assert.deepEqual(dueReminders({}, now), []);
});

test('send is confirmed afterwards and repeated invocations do not send twice', async () => {
  const f = fixture();
  const sentKey = 'users/user0/agenda/current/sentReminders/2026-09-12_example';
  f.useSend(async () => {
    assert.equal(f.records.get(sentKey).status, 'sending');
    assert.equal(f.records.get(sentKey).sentAt, undefined);
    return 'mock-message';
  });
  assert.deepEqual(await f.run(), { sent: 1, failed: 0, skipped: 0 });
  assert.equal(f.records.get(sentKey).status, 'sent');
  assert.ok(f.records.get(sentKey).sentAt);
  assert.equal(f.messages[0].webpush.notification.tag, f.messages[0].data.reminderId);
  assert.deepEqual(await f.run(now + 5 * MINUTE), { sent: 0, failed: 0, skipped: 1 });
  assert.equal(f.messages.length, 1);
});

test('failed sending leaves a retry, retains checkpoint and retries successfully', async () => {
  const f = fixture([{ events: [event()], pushToken: 'mock-token', reminderCheckedThroughMs: now - 10 * MINUTE }]);
  f.useSend(async () => { throw Object.assign(new Error('temporary'), { code: 'messaging/server-unavailable' }); });
  assert.equal((await f.run()).failed, 1);
  const record = f.records.get('users/user0/agenda/current/sentReminders/2026-09-12_example');
  assert.equal(record.status, 'retry');
  assert.equal(record.sentAt, undefined);
  assert.equal(f.records.get('users/user0/agenda/current').reminderCheckedThroughMs, now - 10 * MINUTE);
  f.useSend(async () => 'mock-message');
  assert.equal((await f.run(now + MINUTE)).sent, 0);
  assert.equal((await f.run(now + 5 * MINUTE)).sent, 1);
});

test('one message failing does not prevent other events or agendas from sending', async () => {
  const f = fixture([{ events: [event(), event({ id: 'second' })], pushToken: 'mock-token' },
    { events: [event({ id: 'third' })], pushToken: 'other-token' }]);
  f.useSend(async message => {
    if (message.data.eventId === 'example') throw Object.assign(new Error('temporary'), { code: 'messaging/server-unavailable' });
    return 'mock-message';
  });
  assert.deepEqual(await f.run(), { sent: 2, failed: 1, skipped: 0 });
});

test('first-ever failed delivery is recoverable after a scheduler gap over 30 minutes', async () => {
  const firstRun = now - 45 * MINUTE;
  const f = fixture([{ events: [event({ reminder: 60 })], pushToken: 'mock-token' }]);
  f.useSend(async () => { throw Object.assign(new Error('temporary'), { code: 'messaging/server-unavailable' }); });
  assert.equal((await f.run(firstRun)).failed, 1);
  assert.equal(f.records.get('users/user0/agenda/current').reminderCheckedThroughMs, firstRun);
  f.useSend(async () => 'mock-message');
  assert.equal((await f.run(now)).sent, 1);
});

test('invalid token is removed while unrelated devices still receive reminders', async () => {
  const f = fixture([{ events: [event()], pushToken: 'invalid-token' }, { events: [event()], pushToken: 'valid-token' }]);
  f.useSend(async message => {
    if (message.token === 'invalid-token') throw Object.assign(new Error('expired'), { code: 'messaging/registration-token-not-registered' });
    return 'mock-message';
  });
  assert.deepEqual(await f.run(), { sent: 1, failed: 1, skipped: 0 });
  assert.equal(f.records.get('users/user0/agenda/current').pushToken, undefined);
  assert.equal(f.records.get('users/user1/agenda/current').pushToken, 'valid-token');
});

test('a newly refreshed token is not erased by an old-token delivery failure', async () => {
  const f = fixture();
  f.useSend(async () => {
    f.records.get('users/user0/agenda/current').pushToken = 'new-token';
    throw Object.assign(new Error('expired'), { code: 'messaging/registration-token-not-registered' });
  });
  await f.run();
  assert.equal(f.records.get('users/user0/agenda/current').pushToken, 'new-token');
});

test('concurrent workers share a lease and only one submits a notification', async () => {
  const f = fixture();
  let release;
  let started;
  const sending = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  f.useSend(async () => { started(); await blocked; return 'mock-message'; });
  const first = f.run();
  await sending;
  assert.equal((await f.run()).skipped, 1);
  release();
  await first;
  assert.equal(f.messages.length, 1);
});

test('expired leases can be recovered and legacy sent markers stay deduplicated', async () => {
  const f = fixture();
  const key = 'users/user0/agenda/current/sentReminders/2026-09-12_example';
  f.records.set(key, { status: 'sending', leaseUntilMs: now - MINUTE });
  assert.equal((await f.run()).sent, 1);
  f.records.set(key, { sentAt: { timestamp: 'previous-worker' } });
  assert.equal((await f.run()).skipped, 1);
  assert.equal(f.messages.length, 1);
});

test('rescheduling an already delivered event allows the new due time', async () => {
  const f = fixture();
  assert.equal((await f.run()).sent, 1);
  f.records.get('users/user0/agenda/current').events[0].start = '10:05';
  assert.equal((await f.run(now + 5 * MINUTE)).sent, 1);
  assert.equal(f.messages[0].data.reminderId, f.messages[1].data.reminderId);
  assert.notEqual(f.messages[0].data.reminderVersion, f.messages[1].data.reminderVersion);
  assert.equal(f.messages[1].data.reminderVersion, '2026-09-12T10:05|15');
});
