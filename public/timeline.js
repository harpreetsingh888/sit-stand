/**
 * The day, block by block, and the means to correct it.
 *
 * Every number in this app rests on someone remembering to press a button, so
 * the record has to be visible and fixable. Each block can have its posture
 * changed, its edges moved, be split where a switch went unrecorded, or be
 * deleted outright.
 *
 * Boundaries are edited through time fields rather than by dragging: dragging
 * cannot be driven from a keyboard, and a minute is hard to hit with a mouse.
 */

const POSTURE_NAMES = { sit: 'Sitting', stand: 'Standing', away: 'Away' };
const POSTURES = ['sit', 'stand', 'away'];

const pad2 = (n) => String(n).padStart(2, '0');

/** "HH:MM" in local time, for a time input. */
const toTimeValue = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** A local "HH:MM" resolved against the day a block belongs to. */
function fromTimeValue(value, referenceMs) {
  const match = /^(\d{2}):(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const day = new Date(referenceMs);
  day.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return day.getTime();
}

function formatSpan(ms) {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Draw the timeline and wire its editor.
 *
 * `onEdit(path, method, body)` performs the request and returns the refreshed
 * day; `onError(message)` reports a refusal. Both come from the caller so this
 * module does no fetching of its own.
 */
export function createTimeline({ root, panel, onEdit, onError }) {
  let day = null;
  let selectedId = null;

  function render(nextDay) {
    day = nextDay;
    if (selectedId !== null && !day.sessions.some((s) => s.id === selectedId)) {
      selectedId = null; // whatever was selected has just been deleted
    }
    drawTrack();
    drawEditor();
  }

  /** The span the track covers: the work window, widened by anything outside it. */
  function bounds() {
    const window = day.workWindow;
    const starts = day.sessions.map((s) => s.started_at);
    const finishes = day.sessions.map((s) => s.ended_at ?? day.now);

    const from = Math.min(window?.start ?? Infinity, ...starts);
    const to = Math.max(window?.end ?? -Infinity, ...finishes);
    return Number.isFinite(from) && to > from ? { from, to } : null;
  }

  function drawTrack() {
    const span = bounds();
    if (!span || day.sessions.length === 0) {
      root.replaceChildren(element('p', 'timeline-empty', 'Nothing recorded on this day yet.'));
      return;
    }

    const width = span.to - span.from;
    const track = element('div', 'track');
    track.setAttribute('role', 'list');

    for (const session of day.sessions) {
      const finish = session.ended_at ?? day.now;
      const block = element('button', `block is-${session.posture}`);
      block.type = 'button';
      block.dataset.id = String(session.id);
      block.setAttribute('role', 'listitem');
      block.style.left = `${((session.started_at - span.from) / width) * 100}%`;
      block.style.width = `${Math.max(0.4, ((finish - session.started_at) / width) * 100)}%`;

      const when = `${toTimeValue(session.started_at)} to ${
        session.ended_at === null ? 'now' : toTimeValue(session.ended_at)
      }`;
      block.title = `${POSTURE_NAMES[session.posture]}, ${when} (${formatSpan(session.ms)})`;
      block.setAttribute(
        'aria-label',
        `${block.title}${session.implausible ? '. Looks unusually long' : ''}`,
      );
      if (session.implausible) block.classList.add('suspect');
      if (session.id === selectedId) block.classList.add('chosen');
      if (session.ended_at === null) block.classList.add('running');

      block.addEventListener('click', () => {
        selectedId = selectedId === session.id ? null : session.id;
        drawTrack();
        drawEditor();
      });
      track.append(block);
    }

    const scale = element('div', 'scale');
    scale.append(
      element('span', null, toTimeValue(span.from)),
      element('span', null, toTimeValue(span.to)),
    );

    root.replaceChildren(track, scale);
  }

  /* ------------------------------------------------------------- the editor */

  function drawEditor() {
    const session = day.sessions.find((s) => s.id === selectedId);
    if (!session) {
      panel.replaceChildren(
        element(
          'p',
          'editor-hint',
          day.sessions.length > 0
            ? 'Select a block above to correct it.'
            : 'Blocks appear here once the day has something in it.',
        ),
      );
      return;
    }

    const form = element('form', 'editor');
    form.append(
      element(
        'p',
        'editor-what',
        `${POSTURE_NAMES[session.posture]} · ${formatSpan(session.ms)}`,
      ),
    );

    if (session.implausible) {
      form.append(
        element(
          'p',
          'editor-warn',
          'This block is long enough to look like a switch that never got pressed. ' +
            'Split it where the change actually happened, or shorten it.',
        ),
      );
    }

    form.append(postureRow(session), timesRow(session), splitRow(session), actionsRow(session));
    form.addEventListener('submit', (event) => event.preventDefault());
    panel.replaceChildren(form);
  }

  function postureRow(session) {
    const row = element('div', 'editor-row');
    row.append(element('span', 'editor-label', 'It was really'));

    const group = element('div', 'chips');
    for (const posture of POSTURES) {
      const chip = element('button', `chip is-${posture}`, POSTURE_NAMES[posture]);
      chip.type = 'button';
      if (posture === session.posture) chip.classList.add('on');
      chip.disabled = posture === session.posture;
      chip.addEventListener('click', () =>
        submit(`/api/sessions/${session.id}`, 'PATCH', { posture }),
      );
      group.append(chip);
    }
    row.append(group);
    return row;
  }

  function timesRow(session) {
    const row = element('div', 'editor-row');
    row.append(element('span', 'editor-label', 'Ran from'));

    const from = timeField(`start-${session.id}`, session.started_at, 'Start');
    const to = session.ended_at === null
      ? element('span', 'editor-open', 'until now')
      : timeField(`end-${session.id}`, session.ended_at, 'End');

    const apply = element('button', 'chip', 'Move');
    apply.type = 'button';
    apply.addEventListener('click', () => {
      const changes = {};
      const startedAt = fromTimeValue(from.querySelector('input').value, session.started_at);
      if (startedAt === null) return onError('That start time is not a time.');
      if (startedAt !== session.started_at) changes.started_at = startedAt;

      if (session.ended_at !== null) {
        const endedAt = fromTimeValue(to.querySelector('input').value, session.ended_at);
        if (endedAt === null) return onError('That end time is not a time.');
        if (endedAt !== session.ended_at) changes.ended_at = endedAt;
      }
      if (Object.keys(changes).length === 0) return onError('Those are the times it already has.');
      return submit(`/api/sessions/${session.id}`, 'PATCH', changes);
    });

    const pair = element('div', 'chips');
    pair.append(from, element('span', 'editor-to', 'to'), to, apply);
    row.append(pair);
    return row;
  }

  function timeField(id, ms, label) {
    const wrap = element('span', 'time-field');
    const input = document.createElement('input');
    input.type = 'time';
    input.id = id;
    input.value = toTimeValue(ms);
    input.setAttribute('aria-label', label);
    wrap.append(input);
    return wrap;
  }

  function splitRow(session) {
    const row = element('div', 'editor-row');
    row.append(element('span', 'editor-label', 'Switched at'));

    const finish = session.ended_at ?? day.now;
    const midpoint = session.started_at + (finish - session.started_at) / 2;
    const field = timeField(`split-${session.id}`, midpoint, 'Time of the missed switch');

    const group = element('div', 'chips');
    group.append(field);
    for (const posture of POSTURES.filter((p) => p !== session.posture)) {
      const button = element('button', `chip is-${posture}`, `to ${POSTURE_NAMES[posture]}`);
      button.type = 'button';
      button.addEventListener('click', () => {
        const at = fromTimeValue(field.querySelector('input').value, session.started_at);
        if (at === null) return onError('That is not a time.');
        return submit(`/api/sessions/${session.id}/split`, 'POST', { at, posture });
      });
      group.append(button);
    }
    row.append(group);
    return row;
  }

  function actionsRow(session) {
    const row = element('div', 'editor-row editor-actions');
    const remove = element('button', 'chip danger', 'Delete this block');
    remove.type = 'button';
    remove.addEventListener('click', () => submit(`/api/sessions/${session.id}`, 'DELETE'));

    const close = element('button', 'chip', 'Done');
    close.type = 'button';
    close.addEventListener('click', () => {
      selectedId = null;
      drawTrack();
      drawEditor();
    });

    row.append(remove, close);
    return row;
  }

  async function submit(path, method, body) {
    try {
      render(await onEdit(path, method, body));
    } catch (error) {
      onError(error.message);
    }
  }

  return { render, get selectedId() { return selectedId; } };
}
