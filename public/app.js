import { createTimeline } from './timeline.js';

const $ = (id) => document.getElementById(id);
const MINUTE = 60_000;
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const POSTURES = ['sit', 'stand', 'away'];
const POSTURE_NAMES = { sit: 'Sitting', stand: 'Standing', away: 'Away from desk' };
const GAUGE_TICKS = 26;

const el = {
  stage: $('stage'), posture: $('postureLabel'), readout: $('readout'),
  overdue: $('overdue'), controls: $('controls'), announce: $('announce'),
  offline: $('offline'), windowLabel: $('windowLabel'),
  gauge: $('gauge'), gaugeValue: $('gaugeValue'), gaugeNote: $('gaugeNote'),
  split: $('split'), sitTotal: $('sitTotal'), standTotal: $('standTotal'),
  awayTotal: $('awayTotal'), share: $('share'),
  chart: $('chart'), axis: $('axis'), trend: $('trend'),
  form: $('settingsForm'), days: $('days'), savedNote: $('savedNote'),
  timeline: $('timeline'), timelineEditor: $('timelineEditor'),
  editorError: $('editorError'), suspectNote: $('suspectNote'),
  conflicts: $('conflicts'), queued: $('queued'),
  notifyButton: $('notifyButton'), settingsPanel: $('settingsPanel'),
};

/** Server time minus browser time, so the two agree about elapsed seconds. */
let clockOffset = 0;
let state = null;
let busy = false;
let nudgedFor = null;
let settingsDirty = false;
let offline = false;

/* Views that are expensive or focus-bearing are rebuilt only when their
   content actually changes, not on every tick of the clock. */
let controlsFor = Symbol('unset');
let litTicks = -1;
const splitParts = {};

const serverNow = () => Date.now() + clockOffset;

/* ------------------------------------------------------- the offline queue */

/**
 * Switches made with no connection are kept here until they can be sent. The
 * moment is recorded when you press the button, not when it finally reaches
 * the tracker, so a queued switch lands at the right time.
 */
const QUEUE_KEY = 'desk-log-queue';

function readQueue() {
  try {
    const stored = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    /* private browsing, or the box is full; the queue is a convenience */
  }
  renderQueue(queue);
}

function renderQueue(queue = readQueue()) {
  el.queued.hidden = queue.length === 0;
  if (queue.length > 0) {
    el.queued.textContent =
      queue.length === 1
        ? 'One switch saved on this device, waiting to reach the tracker.'
        : `${queue.length} switches saved on this device, waiting to reach the tracker.`;
  }
}

/** Send anything waiting. Runs whenever we discover we are online again. */
async function flushQueue() {
  const queue = readQueue();
  if (queue.length === 0) return;

  try {
    const result = await api('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ actions: queue }),
    });
    writeQueue([]);
    state = result.state;
    clockOffset = state.now - Date.now();
    render();
    refreshDay();
    refreshHistory();
  } catch {
    /* Still unreachable. The queue keeps until next time. */
  }
}

/* ------------------------------------------------------------- formatting */

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const parts = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  return parts.map((n) => String(n).padStart(2, '0')).join(':');
}

function formatSpan(ms) {
  const minutes = Math.round(Math.max(0, ms) / MINUTE);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/* --------------------------------------------------------------- requests */

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    const error = new Error(payload?.error?.message ?? 'Request failed');
    error.fields = payload?.error?.fields ?? [];
    throw error;
  }
  return payload.data;
}

function setOffline(isOffline) {
  offline = isOffline;
  el.offline.hidden = !isOffline;
  syncButtons();
}

function syncButtons() {
  for (const button of el.controls.querySelectorAll('button')) button.disabled = offline || busy;
}

async function refreshState() {
  try {
    const data = await api('/api/state');
    clockOffset = data.now - Date.now();
    state = data;
    setOffline(false);
    render();
    flushQueue();
    if (!settingsDirty) fillSettings(data.settings);
  } catch {
    setOffline(true);
  }
}

const timeline = createTimeline({
  root: el.timeline,
  panel: el.timelineEditor,
  onEdit: async (path, method, body) => {
    const day = await api(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    showEditorError(null);
    // An edit changes the totals and the day's shape, so refresh what depends
    // on it. The day itself is already in hand.
    refreshState();
    refreshHistory();
    renderSuspectNote(day);
    return day;
  },
  onError: showEditorError,
});

function showEditorError(message) {
  el.editorError.hidden = !message;
  el.editorError.textContent = message ?? '';
}

function renderSuspectNote(day) {
  const count = day.implausibleCount;
  el.suspectNote.hidden = count === 0;
  if (count > 0) {
    el.suspectNote.textContent =
      count === 1
        ? 'One block is long enough to look like a switch that never got pressed. It is hatched below.'
        : `${count} blocks are long enough to look like switches that never got pressed. They are hatched below.`;
  }
}

async function refreshDay() {
  try {
    const day = await api('/api/day');
    timeline.render(day);
    renderSuspectNote(day);
  } catch {
    /* The timeline keeps its last good render. */
  }
}

async function refreshHistory() {
  try {
    const data = await api('/api/history?days=14');
    renderHistory(data.days, data.settings);
  } catch {
    /* The chart simply keeps its last good render. */
  }
}

async function act(path, body) {
  if (busy) return;
  busy = true;
  setOffline(false);
  try {
    const previous = state?.session?.posture ?? null;
    state = await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
    clockOffset = state.now - Date.now();
    if (state.session?.posture !== previous) nudgedFor = null;
    render();
    refreshHistory();
    refreshDay();
    askForNotifications();
  } catch (error) {
    setOffline(true);
    if (body?.posture) {
      // Keep the switch with the time it was actually made, and send it later.
      writeQueue([...readQueue(), { posture: body.posture, at: serverNow() }]);
    }
    console.error(error);
  } finally {
    busy = false;
    render();
  }
}

/* ------------------------------------------------------ live extrapolation */

/**
 * Milliseconds of working time between the last poll and now. Lets today's
 * totals keep moving between polls without pretending time outside the work
 * window counts.
 */
function workedSincePoll() {
  if (!state?.session) return 0;
  const window = state.workWindow;
  if (!window) return 0;
  const clamp = (t) => Math.min(Math.max(t, window.start), window.end);
  return Math.max(0, clamp(serverNow()) - clamp(state.now));
}

/* ----------------------------------------------------------------- render */

function render() {
  if (!state) return;
  const { session, settings } = state;

  const extra = workedSincePoll();
  const totals = Object.fromEntries(
    POSTURES.map((posture) => [
      posture,
      state.today[posture] + (session?.posture === posture ? extra : 0),
    ]),
  );

  el.stage.dataset.posture = session?.posture ?? 'none';
  el.posture.textContent = session ? POSTURE_NAMES[session.posture] : 'Not tracking';
  el.readout.textContent = session
    ? formatClock(serverNow() - session.started_at)
    : '--:--:--';

  renderConflicts(state.conflicts ?? []);
  renderOverdue(session, settings);
  renderControls(session);
  renderToday(totals);
  renderGauge(totals.stand, settings);

  el.windowLabel.textContent = state.workWindow
    ? `${settings.workStart}–${settings.workEnd}${state.withinWorkHours ? '' : ' · off the clock'}`
    : 'Not a working day';
}

/**
 * Disagreements between a queued switch and what was already recorded. The
 * recorded version stands until you say otherwise, so this asks rather than
 * silently picking one.
 */
function renderConflicts(conflicts = []) {
  el.conflicts.hidden = conflicts.length === 0;
  if (conflicts.length === 0) return;

  const heading = document.createElement('h2');
  heading.textContent = conflicts.length === 1 ? 'Which is right?' : 'Which of these are right?';

  const items = conflicts.map((conflict) => {
    const item = document.createElement('div');
    item.className = 'conflict-item';

    const when = new Date(conflict.queued_at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    const from = new Date(conflict.existing_started_at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    const to = conflict.existing_ended_at
      ? new Date(conflict.existing_ended_at).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'now';

    const text = document.createElement('p');
    text.textContent =
      `Another device recorded ${POSTURE_NAMES[conflict.queued_posture].toLowerCase()} at ${when}, ` +
      `but this one already has ${POSTURE_NAMES[conflict.existing_posture].toLowerCase()} from ${from} to ${to}.`;

    const choices = document.createElement('div');
    choices.className = 'chips';
    for (const [choice, label] of [
      ['existing', 'Keep what is recorded here'],
      ['queued', `Use the other device: ${POSTURE_NAMES[conflict.queued_posture].toLowerCase()} from ${when}`],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.textContent = label;
      button.addEventListener('click', () => settleConflict(conflict.id, choice));
      choices.append(button);
    }

    item.append(text, choices);
    return item;
  });

  el.conflicts.replaceChildren(heading, ...items);
}

async function settleConflict(id, choice) {
  try {
    const data = await api(`/api/conflicts/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ choice }),
    });
    state = data.state;
    renderConflicts(data.conflicts);
    render();
    refreshDay();
    refreshHistory();
  } catch (error) {
    showEditorError(error.message);
  }
}

function renderOverdue(session, settings) {
  if (!session) {
    el.stage.dataset.overdue = 'false';
    el.overdue.hidden = true;
    return;
  }

  // Away is timed but never nagged: you are already not at your desk.
  if (session.posture === 'away') {
    el.stage.dataset.overdue = 'false';
    el.overdue.hidden = true;
    return;
  }

  const limit = (session.posture === 'sit' ? settings.sitNudgeMinutes : settings.standNudgeMinutes) * MINUTE;
  const over = serverNow() - session.started_at >= limit && state.withinWorkHours;

  el.stage.dataset.overdue = String(over);
  el.overdue.hidden = !over;
  if (over) {
    el.overdue.textContent = session.posture === 'sit'
      ? `Sitting for over ${formatSpan(limit)}. Time to stand up.`
      : `Standing for over ${formatSpan(limit)}. Take a seat.`;
    maybeNotify(session, el.overdue.textContent);
  }
}

function renderControls(session) {
  const posture = session?.posture ?? null;
  if (posture === controlsFor) return syncButtons();
  controlsFor = posture;

  el.controls.replaceChildren(...controlSpecs(posture).map((spec) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = spec.text;
    button.className = spec.weight ?? '';
    if (spec.weight === 'act') button.dataset.goes = spec.posture;
    button.addEventListener('click', () => {
      if (spec.stop) return act('/api/stop');
      announce(`Now ${POSTURE_NAMES[spec.posture].toLowerCase()}.`);
      return act('/api/toggle', { posture: spec.posture });
    });
    return button;
  }));
  syncButtons();
}

/**
 * Which buttons belong on screen, in three weights: the action you came to
 * press, the one that still records something, and the one that ends the day.
 */
function controlSpecs(posture) {
  if (posture === null) {
    return [
      { text: 'Start sitting', posture: 'sit', weight: 'act' },
      { text: 'Start standing', posture: 'stand', weight: 'act' },
    ];
  }
  if (posture === 'away') {
    return [
      { text: 'Back to sitting', posture: 'sit', weight: 'act' },
      { text: 'Back to standing', posture: 'stand', weight: 'act' },
      { text: 'Stop tracking', stop: true, weight: 'quiet' },
    ];
  }
  const next = posture === 'sit' ? 'stand' : 'sit';
  return [
    { text: next === 'stand' ? 'Stand up' : 'Sit down', posture: next, weight: 'act' },
    { text: 'Away from desk', posture: 'away', weight: 'step' },
    { text: 'Stop tracking', stop: true, weight: 'quiet' },
  ];
}

function renderToday(totals) {
  const total = POSTURES.reduce((sum, posture) => sum + totals[posture], 0);
  const share = (posture) => (total > 0 ? (totals[posture] / total) * 100 : 0);

  if (!splitParts.sit) {
    for (const posture of POSTURES) {
      splitParts[posture] = Object.assign(document.createElement('span'), {
        className: `is-${posture}`,
      });
    }
    el.split.replaceChildren(...POSTURES.map((posture) => splitParts[posture]));
  }
  for (const posture of POSTURES) splitParts[posture].style.width = `${share(posture)}%`;

  el.split.setAttribute(
    'aria-label',
    total > 0
      ? `Today: ${POSTURES.map((p) => `${formatSpan(totals[p])} ${p}`).join(', ')}`
      : 'Nothing tracked today yet',
  );

  el.sitTotal.textContent = formatSpan(totals.sit);
  el.standTotal.textContent = formatSpan(totals.stand);
  el.awayTotal.textContent = formatSpan(totals.away);

  // Away counts in the percentages, so the three always add up to the day.
  const parts = [
    `${Math.round(share('sit'))}% sitting`,
    `${Math.round(share('stand'))}% standing`,
    ...(totals.away > 0 ? [`${Math.round(share('away'))}% away`] : []),
  ];
  el.share.textContent = total > 0
    ? `Of the ${formatSpan(total)} tracked today: ${parts.join(', ')}.`
    : 'Nothing tracked yet today.';
}

function renderGauge(stand, settings) {
  const goalMs = settings.standGoalMinutes * MINUTE;
  const ratio = goalMs > 0 ? Math.min(1, stand / goalMs) : 1;
  const lit = Math.round(ratio * GAUGE_TICKS);

  el.gaugeValue.textContent = formatSpan(stand);
  el.gaugeNote.textContent = stand >= goalMs
    ? `Goal of ${formatSpan(goalMs)} met`
    : `${formatSpan(goalMs - stand)} to go`;

  if (lit === litTicks) return;
  litTicks = lit;

  const ticks = [];
  for (let index = 0; index < GAUGE_TICKS; index += 1) {
    const angle = Math.PI * (index / (GAUGE_TICKS - 1));
    const [cx, cy] = [100, 104];
    const point = (r) => [cx - Math.cos(angle) * r, cy - Math.sin(angle) * r];
    const [x1, y1] = point(62);
    const [x2, y2] = point(82);

    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick.setAttribute('class', index < lit ? 'tick lit' : 'tick');
    tick.setAttribute('x1', x1.toFixed(1));
    tick.setAttribute('y1', y1.toFixed(1));
    tick.setAttribute('x2', x2.toFixed(1));
    tick.setAttribute('y2', y2.toFixed(1));
    ticks.push(tick);
  }
  el.gauge.replaceChildren(...ticks);
}

function renderHistory(days, settings) {
  const peak = Math.max(1, ...days.map((day) => day.sit + day.stand + day.away));
  const columns = [];
  const labels = [];

  for (const day of days) {
    const column = document.createElement('div');
    column.className = 'col';
    if (!day.isWorkDay) column.classList.add('off');
    if (day === days.at(-1)) column.classList.add('today');
    column.title =
      `${day.day}: ${formatSpan(day.stand)} standing, ${formatSpan(day.sit)} sitting` +
      (day.away > 0 ? `, ${formatSpan(day.away)} away` : '');

    const bar = (className, ms) => {
      const piece = document.createElement('i');
      piece.className = className;
      piece.style.height = `${(ms / peak) * 100}%`;
      return piece;
    };

    // Standing on top, then sitting, with absence resting on the baseline.
    column.append(
      Object.assign(document.createElement('i'), { className: 'rest' }),
      bar('b-stand', day.stand),
      bar('b-sit', day.sit),
      bar('b-away', day.away),
      Object.assign(document.createElement('i'), { className: 'base' }),
    );
    columns.push(column);

    const weekday = new Date(`${day.day}T12:00:00`).getDay();
    const label = document.createElement('span');
    label.textContent = DAY_LETTERS[weekday];
    if (!day.isWorkDay) label.className = 'off';
    labels.push(label);
  }

  el.chart.replaceChildren(...columns);
  el.axis.replaceChildren(...labels);

  const tracked = days.filter((day) => day.isWorkDay && day.sit + day.stand + day.away > 0);
  el.trend.textContent = tracked.length === 0
    ? 'No working days tracked yet.'
    : `Averaging ${formatSpan(
        tracked.reduce((sum, day) => sum + day.stand, 0) / tracked.length,
      )} standing across ${tracked.length} tracked working day${tracked.length === 1 ? '' : 's'}` +
      ` · goal is ${formatSpan(settings.standGoalMinutes * MINUTE)}.`;
}

function announce(message) {
  el.announce.textContent = message;
}

/* ------------------------------------------------------------ nudges */

function notificationsUsable() {
  return 'Notification' in window && window.isSecureContext;
}

function askForNotifications() {
  if (!notificationsUsable() || Notification.permission !== 'default') return;
  Notification.requestPermission().then(updateNotifyButton);
}

function updateNotifyButton() {
  el.notifyButton.hidden = !notificationsUsable() || Notification.permission !== 'default';
}

function maybeNotify(session, message) {
  if (!notificationsUsable() || Notification.permission !== 'granted') return;
  if (nudgedFor === session.id) return;
  nudgedFor = session.id;
  new Notification('Desk log', { body: message, tag: 'desk-log-nudge' });
}

/* ---------------------------------------------------------------- settings */

function buildDayCheckboxes() {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  el.days.replaceChildren(...names.map((name, index) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'workDays';
    input.value = String(index);
    input.addEventListener('change', () => { settingsDirty = true; });
    label.append(input, document.createTextNode(name));
    return label;
  }));
}

function fillSettings(settings) {
  el.form.workStart.value = settings.workStart;
  el.form.workEnd.value = settings.workEnd;
  el.form.standGoalMinutes.value = settings.standGoalMinutes;
  el.form.sitNudgeMinutes.value = settings.sitNudgeMinutes;
  el.form.standNudgeMinutes.value = settings.standNudgeMinutes;
  el.form.implausibleAfterMinutes.value = settings.implausibleAfterMinutes;
  for (const box of el.days.querySelectorAll('input')) {
    box.checked = settings.workDays.includes(Number(box.value));
  }
}

function showFieldErrors(fields) {
  for (const node of el.form.querySelectorAll('.field-error')) {
    const match = fields.find((f) => f.field === node.dataset.errorFor);
    node.hidden = !match;
    node.textContent = match?.message ?? '';
  }
}

el.form.addEventListener('input', () => { settingsDirty = true; el.savedNote.hidden = true; });

el.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const patch = {
    workStart: el.form.workStart.value,
    workEnd: el.form.workEnd.value,
    standGoalMinutes: el.form.standGoalMinutes.value,
    sitNudgeMinutes: el.form.sitNudgeMinutes.value,
    standNudgeMinutes: el.form.standNudgeMinutes.value,
    implausibleAfterMinutes: el.form.implausibleAfterMinutes.value,
    workDays: [...el.days.querySelectorAll('input:checked')].map((box) => Number(box.value)),
  };

  try {
    const data = await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
    showFieldErrors([]);
    settingsDirty = false;
    litTicks = -1;
    el.savedNote.hidden = false;
    fillSettings(data.settings);
    await refreshState();
    refreshHistory();
    refreshDay();
  } catch (error) {
    showFieldErrors(error.fields?.length ? error.fields : [
      { field: 'workStart', message: error.message },
    ]);
  }
});

el.notifyButton.addEventListener('click', askForNotifications);

/* ------------------------------------------------------- live from the server */

/**
 * Both devices talk to one server, so it is the server that knows when a
 * switch happened. It pushes the new state down this stream as it happens,
 * which is what makes a change on the phone appear here without a reload.
 *
 * EventSource reconnects on its own, with backoff, so there is nothing to do
 * on error but wait. The slow poll below stays as a safety net in case a
 * stream dies quietly.
 */
function listenForChanges() {
  if (!('EventSource' in window)) return;

  const stream = new EventSource('/api/events');

  stream.addEventListener('state', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    state = data;
    clockOffset = data.now - Date.now();
    setOffline(false);
    render();
    if (!settingsDirty) fillSettings(data.settings);

    // Redrawing the timeline would throw away whatever is half-typed in the
    // editor, so leave it alone while a block is being corrected.
    if (timeline.selectedId === null) refreshDay();
  });

  stream.addEventListener('open', () => setOffline(false));
}

/* -------------------------------------------------------------------- boot */

// Registering the worker is what makes the app installable and lets it open
// offline. It is a progressive extra: everything works without it.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    /* not a secure context, or the browser declined; carry on */
  });
}

buildDayCheckboxes();
updateNotifyButton();
renderQueue();
await refreshState();
await refreshHistory();
await refreshDay();

listenForChanges();

setInterval(render, 1000);
// The stream carries changes as they happen; this is only a safety net.
setInterval(refreshState, 60_000);
setInterval(refreshHistory, 5 * MINUTE);
setInterval(refreshDay, MINUTE);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refreshState();
    refreshDay();
  }
});

window.addEventListener('online', () => {
  refreshState();
  refreshDay();
});
