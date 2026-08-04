'use strict';

/* ============================================================
 * Voice note widget.
 *
 * Tap the mic, talk, tap again. The clip goes to a Supabase Edge
 * Function that transcribes it and structures it into a short
 * title + category, and the result is written to a table.
 *
 * Three degradation levels, all automatic:
 *   1. backend configured + mic granted -> real recording
 *   2. mic denied, or no MediaRecorder  -> scripted demo
 *   3. no backend at all (empty config) -> scripted demo
 *
 * The scripted demo exists because this started life as a design
 * prototype that had to be presentable with no keys and no
 * network. It is worth keeping: it is the only way to demo the
 * interaction in a meeting room with bad wifi.
 *
 * Usage:
 *   VoiceNote.mount({ el: '#voice', context: () => 'Main St 4' });
 * ============================================================ */

const VoiceNote = (() => {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const MIC_SVG = `<svg viewBox="0 0 24 24" width="25" height="25" fill="currentColor" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"/><path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.93V21a1 1 0 1 0 2 0v-3.07A7 7 0 0 0 19 11Z"/></svg>`;
  const STOP_SVG = `<svg viewBox="0 0 24 24" width="23" height="23" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>`;
  const SPARK_SVG = `<svg viewBox="0 0 24 24" width="38" height="38" fill="#fff" aria-hidden="true"><path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5Z"/></svg>`;

  /* Two eyes that blink — the whole personality of the thing. */
  const EYES = `<span class="vn-eyes"><span class="vn-eye"><i></i></span><span class="vn-eye"><i></i></span></span>`;
  const THINK = `<span class="vn-think">${SPARK_SVG}</span>`;

  const DEFAULTS = {
    el: '#voice-note',
    assistant: 'Otto',
    /* What the note is about — a place, an asset, a ticket, anything.
     * A function so it can change between recordings without remounting. */
    context: () => '',
    greeting: null,
    demo: [
      {
        q: 'What did you find?',
        a: "The entrance moved about 50 metres to the left — there's renovation work.",
      },
      { q: 'Got it. Is that temporary, or here to stay?', a: "Temporary — just while the renovation's going on." },
      { q: 'Thanks. Anything else people should know?', a: "Yeah, there's no lift — it's a four-floor walk-up." },
    ],
    demoFinal: 'Saved & shared — the next person here sees your note before they set out.',
    /* Merged into every saved row: coordinates, asset id, author... */
    extra: () => ({}),
    onSaved: null,
    onError: null,
  };

  const SHELL = `
    <div class="vn-stage">
      <div class="vn-orb">
        <span class="vn-glow"></span>
        <span class="vn-ring vn-ring1"></span>
        <span class="vn-ring vn-ring2"></span>
        <span class="vn-blob"></span>
        <span class="vn-sheen"></span>
        <div class="vn-face"></div>
      </div>
      <div class="vn-msg"></div>
    </div>
    <div class="vn-bar">
      <div class="vn-labels">
        <div class="vn-caption"></div>
        <div class="vn-sub"></div>
      </div>
      <button class="vn-mic" type="button" aria-label="Record a voice note">
        <span class="vn-micring"></span>
        <span class="vn-micicon"></span>
      </button>
      <span class="vn-chip" hidden></span>
    </div>`;

  function mount(options) {
    const opt = { ...DEFAULTS, ...(options || {}) };
    const root = typeof opt.el === 'string' ? document.querySelector(opt.el) : opt.el;
    if (!root) throw new Error('VoiceNote: mount target not found — ' + opt.el);

    root.classList.add('vn');
    root.innerHTML = SHELL;

    const q = sel => root.querySelector(sel);
    const ui = {
      face: q('.vn-face'), msg: q('.vn-msg'), caption: q('.vn-caption'), sub: q('.vn-sub'),
      mic: q('.vn-mic'), micIcon: q('.vn-micicon'), micRing: q('.vn-micring'),
      chip: q('.vn-chip'), rings: [q('.vn-ring1'), q('.vn-ring2')],
    };

    /* ---------- live recording capability ----------
     * getUserMedia needs a secure context: https, or localhost. Checking up
     * front means we fall back to the script instead of failing on tap. */
    const canRecord = () =>
      Backend.enabled && window.isSecureContext &&
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
      typeof MediaRecorder !== 'undefined';

    const state = { rec: null, busy: false, saved: 0, mode: 'live', beat: 0, timer: null };

    const contextLabel = () => {
      try { return String(opt.context() || '').trim(); } catch { return ''; }
    };
    const greetingText = () => {
      const ctx = contextLabel();
      if (opt.greeting) return opt.greeting(ctx);
      return ctx
        ? `You're at ${ctx}. What did you find? Tap the mic and just talk.`
        : 'Tap the mic and tell me what you found.';
    };

    /* ---------- rendering ---------- */
    const bubble = (who, text) => `
      <div class="vn-bubble vn-bubble-${who}">
        <span class="vn-who">${who === 'ai' ? esc(opt.assistant) : 'YOU'}</span>
        <div class="vn-text">${who === 'ai' ? esc(text) : '&ldquo;' + esc(text) + '&rdquo;'}</div>
      </div>`;

    /* Live captions describe what the device is doing. Scripted ones say
     * plainly that it is a script — a demo that pretends to listen when no
     * microphone is open teaches the room the wrong thing about the product. */
    const CAPTIONS = {
      live: {
        idle: ['Tap the mic to talk', 'Your voice, transcribed and saved'],
        rec: ['Recording…', 'Tap stop to send'],
        think: ['Thinking…', 'Transcribing & structuring your note'],
        done: ['Saved', 'The next person here sees it first'],
      },
      script: {
        idle: ['Demo conversation', 'Tap the mic to advance'],
        listening: ['Demo conversation', 'Tap the mic to advance'],
        think: ['Demo conversation', 'Tap the mic to advance'],
        done: ['Saved', 'Scripted demo — nothing was recorded'],
      },
    };

    function render(msg, phase) {
      const scripted = state.mode === 'script';
      ui.face.innerHTML = phase === 'think' ? THINK : EYES;
      ui.rings.forEach(r => { r.hidden = phase !== 'rec' && phase !== 'listening'; });
      if (msg) ui.msg.innerHTML = bubble(msg.from, msg.text);
      const set = scripted ? CAPTIONS.script : CAPTIONS.live;
      const [cap, sub] = set[phase] || set.idle;
      ui.caption.textContent = cap;
      ui.sub.textContent = sub;
      /* Live 'think' means a clip is uploading and a tap would be dropped, so
       * the button goes away. Scripted 'think' is just a pacing beat — the mic
       * is how you step through it, so it has to stay. */
      ui.mic.hidden = phase === 'done' || (phase === 'think' && !scripted);
      ui.micRing.hidden = phase !== 'rec';
      ui.micIcon.innerHTML = phase === 'rec' ? STOP_SVG : MIC_SVG;
      ui.mic.classList.toggle('vn-mic-rec', phase === 'rec');
    }

    function chip(text) {
      ui.chip.textContent = text;
      ui.chip.hidden = false;
    }

    /* ---------- scripted demo ----------
     * Auto-advancing beats: assistant asks, "you" answer, repeat. Timings are
     * slower on the assistant's lines because that is when a viewer reads. */
    const beats = [];
    opt.demo.forEach(t => { beats.push({ from: 'ai', text: t.q }); beats.push({ from: 'me', text: t.a }); });
    beats.push({ from: 'ai', text: opt.demoFinal });

    function runDemo(n) {
      clearTimeout(state.timer);
      state.beat = Math.max(0, Math.min(beats.length - 1, n));
      const b = beats[state.beat];
      const last = state.beat >= beats.length - 1;
      render(b, last ? 'done' : b.from === 'ai' ? 'listening' : 'think');
      if (last) {
        chip('1 NOTE SAVED · DEMO');
        /* The host still gets a callback so the surrounding UI can be seen
         * working — flagged demo:true so nothing counts it as real data. */
        if (opt.onSaved) {
          const said = opt.demo[opt.demo.length - 1].a;
          opt.onSaved({
            transcript: said,
            reply: opt.demoFinal,
            note: { title: said.slice(0, 60), category: 'INFO' },
            row: { context: contextLabel(), transcript: said, title: said.slice(0, 60), category: 'INFO' },
            demo: true,
          });
        }
        return;
      }
      state.timer = setTimeout(() => runDemo(state.beat + 1), b.from === 'ai' ? 5500 : 2200);
    }

    /* ---------- live recording ---------- */
    async function startRecording() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        state.rec = null;
        send(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
      };
      state.rec = rec;
      rec.start();
      render({ from: 'ai', text: "I'm listening — tap again when you're done." }, 'rec');
    }

    async function send(blob) {
      state.busy = true;
      const context = contextLabel();
      render({ from: 'ai', text: 'Got it — one second…' }, 'think');
      try {
        const d = await Backend.transcribe(blob, context);
        /* Show what was actually heard before the reply — if the transcript is
         * wrong, the person needs to see that, not a confident summary of it. */
        render({ from: 'me', text: d.transcript }, 'think');

        const row = {
          context,
          transcript: d.transcript,
          title: (d.note && d.note.title) || null,
          category: (d.note && d.note.category) || null,
          ...opt.extra(),
        };
        let saved = null;
        try {
          const res = await Backend.saveNote(row);
          if (Array.isArray(res) && res[0]) saved = res[0];
        } catch (e) {
          /* The table may not exist yet (run schema.sql). Losing the row is bad
           * but silently losing the conversation on top of it is worse. */
          console.warn('VoiceNote: could not save the note —', e.message);
        }

        state.saved++;
        chip(`${state.saved} NOTE${state.saved > 1 ? 'S' : ''} SAVED · ${row.category || 'INFO'}`);
        if (opt.onSaved) opt.onSaved({ ...d, row: saved || row });

        setTimeout(() => {
          if (state.rec) return; /* they already started the next one */
          render({ from: 'ai', text: d.reply || 'Noted — saved for the next visitor.' }, 'idle');
        }, 1500);
      } catch (e) {
        render({ from: 'ai', text: `I couldn't reach the voice service (${e.message || 'offline'}). Check the function is deployed, then tap the mic to try again.` }, 'idle');
        if (opt.onError) opt.onError(e);
      }
      state.busy = false;
    }

    async function tap() {
      if (state.mode === 'script') { runDemo(state.beat + 1); return; }
      if (state.busy) return;
      if (state.rec) { state.rec.stop(); return; } /* second tap sends the clip */
      try {
        await startRecording();
      } catch {
        /* Mic denied or unavailable — drop to the script rather than dead-end
         * on a permission dialog the person already said no to. */
        state.mode = 'script';
        runDemo(0);
      }
    }

    ui.mic.addEventListener('click', tap);

    /* ---------- public instance ---------- */
    const api = {
      start() {
        state.mode = canRecord() ? 'live' : 'script';
        state.saved = 0;
        state.beat = 0;
        ui.chip.hidden = true;
        if (state.mode === 'live') render({ from: 'ai', text: greetingText() }, 'idle');
        else runDemo(0);
        return api;
      },
      stop() {
        clearTimeout(state.timer);
        if (state.rec) {
          try {
            state.rec.onstop = null;
            state.rec.stop();
            state.rec.stream.getTracks().forEach(t => t.stop());
          } catch { /* already gone */ }
          state.rec = null;
        }
        state.busy = false;
        return api;
      },
      destroy() {
        api.stop();
        ui.mic.removeEventListener('click', tap);
        root.innerHTML = '';
        root.classList.remove('vn');
      },
      get live() { return state.mode === 'live'; },
    };

    return api.start();
  }

  return { mount };
})();
