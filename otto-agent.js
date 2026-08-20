'use strict';

/* ============================================================
 * Otto as a real ElevenLabs agent.
 *
 * The voice-notes kit's Otto is a turn at a time: tap, talk,
 * upload, read the structured note back. This is the same Otto
 * with a live conversation underneath — a WebSocket straight to
 * an ElevenLabs Conversational AI agent, mic streaming up,
 * the agent's voice streaming down, both interruptible.
 *
 * Why it exists here: a trigger scenario is a conversation
 * ("you looped twice and then parked 200 m away — what stopped
 * you getting closer?"), and a one-shot voice note cannot ask a
 * follow-up. The scenario is what the agent is told about:
 *
 *   - the sheet's "Otto says" becomes the agent's FIRST MESSAGE,
 *   - every scenario column plus what the detector actually
 *     measured go up as DYNAMIC VARIABLES ({{scenario_rule}},
 *     {{park_distance_m}}, … — reference them in your prompt),
 *   - the same briefing goes up as a CONTEXTUAL UPDATE, so an
 *     agent whose prompt names none of those variables still
 *     knows which test it just walked into.
 *
 * It is YOUR agent: the prompt, the voice and the tools are
 * whatever you built in ElevenLabs. Nothing here overrides the
 * prompt — only the opening line, because the scenario owns that
 * line, and the conversation language when the tester picked one
 * on the card (🇬🇧/🇮🇹 — the language must be enabled on the agent
 * AND its security settings must allow both overrides; on refusal
 * the session retries once with no overrides at all).
 *
 * The mount seams are VoiceNote's, so app.js swaps one for the
 * other: mount({ el, context, greeting, extra, onSaved }) and
 * onSaved receives { transcript, reply, note, row } exactly as
 * the kit delivers it. When the conversation ends, the user's
 * side of it is structured into the same title + category the
 * dashboard compares against the scenario's expected tip type.
 *
 * Degradation, in this order:
 *   1. agent id + https + mic          -> live conversation
 *   2. no agent id / no mic / no WS    -> caller falls back to
 *      VoiceNote (onFallback), which has its own demo mode
 *
 * Config: window.ELEVENLABS_AGENT_ID (injected at deploy time,
 * see config.js), or ?agent=<id> on any URL for a quick test.
 * A private agent adds the elevenlabs-token Edge Function, which
 * holds the API key; a public agent needs no key at all.
 * ============================================================ */

const OttoAgent = (() => {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* ElevenLabs v3 voices take inline stage directions — "[happy]
   * Goodbye!", "[laughs]" — which the TTS performs and the official
   * widget hides from the transcript. Hide them the same way, on screen
   * and in the stored conversation: they are delivery notes, not words
   * anyone said. */
  const stripAudioTags = s => String(s).replace(/\[[^\][]{1,40}\]/g, ' ').replace(/\s{2,}/g, ' ').trim();

  /* Same chrome as the voice-note kit — the widget file is used verbatim
   * and exports none of this, so the handful of shared constants are
   * repeated rather than the kit edited. The CSS is the kit's. */
  const MIC_SVG = `<svg viewBox="0 0 24 24" width="25" height="25" fill="currentColor" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"/><path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.93V21a1 1 0 1 0 2 0v-3.07A7 7 0 0 0 19 11Z"/></svg>`;
  const STOP_SVG = `<svg viewBox="0 0 24 24" width="23" height="23" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>`;
  const SPARK_SVG = `<svg viewBox="0 0 24 24" width="38" height="38" fill="#fff" aria-hidden="true"><path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5Z"/></svg>`;
  const EYES = `<span class="vn-eyes"><span class="vn-eye"><i></i></span><span class="vn-eye"><i></i></span></span>`;
  const THINK = `<span class="vn-think">${SPARK_SVG}</span>`;
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
      <button class="vn-mic" type="button" aria-label="End the conversation and save"></button>
      <span class="vn-chip" hidden></span>
    </div>`;

  const CAPTIONS = {
    connect: ['Connecting…', 'Opening the line to your agent'],
    listening: ['Listening…', 'Just talk — no tap, no pause'],
    /* short enough to stay on one line next to the button and the chip */
    speaking: ['Otto is talking', 'Cut in any time'],
    think: ['Saving…', 'Filing the debrief against the pin'],
    done: ['Saved', 'The dashboard compares this with the scenario'],
    error: ['Otto could not connect', 'Tap to try the recorded debrief instead'],
    /* the line DID connect — it just heard no words to file. Saying
     * "could not connect" here sent testers hunting the wrong problem. */
    empty: ['Nothing was filed', 'Tap to talk to Otto again'],
  };

  /* A conversation is metered by the minute at both ends of the wire, so
   * it does not run until the battery does: a test debrief that has gone
   * this long has stopped being a test debrief. */
  const MAX_SESSION_MS = 5 * 60e3;
  /* Nothing said at all for this long — the tester walked away with the
   * screen open. End it; a silent session saves nothing anyway. */
  const IDLE_MS = 90e3;

  const agentId = () =>
    String(new URLSearchParams(location.search).get('agent') || window.ELEVENLABS_AGENT_ID || '').trim();

  /* ---------- audio plumbing ----------
   * ElevenLabs speaks and listens in raw PCM (16-bit, little-endian,
   * mono) at a rate the agent chooses and announces in its opening
   * metadata; telephony agents use G.711 µ-law instead. Both directions
   * are handled here so a misconfigured agent shows up as a clear
   * failure rather than as noise the transcript quietly gets wrong. */
  const b64 = bytes => {
    let s = '';
    const CH = 0x8000; // String.fromCharCode.apply blows the stack on a whole clip
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  };
  const unb64 = str => {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  /* "pcm_16000" / "ulaw_8000" -> { codec, rate } */
  const parseFormat = (fmt, fallbackRate) => {
    const m = /^([a-z]+)_?(\d+)?$/.exec(String(fmt || '').toLowerCase());
    return {
      codec: m && m[1] === 'ulaw' ? 'ulaw' : 'pcm',
      rate: (m && +m[2]) || fallbackRate,
    };
  };

  const ulawDecode = u => {
    u = ~u & 0xff;
    const sign = u & 0x80, exp = (u >> 4) & 0x07, mant = u & 0x0f;
    let mag = ((mant << 1) + 33) << exp;
    mag -= 33 << 1;
    return (sign ? -mag : mag) / 32768;
  };
  const ulawEncode = f => {
    let s = Math.max(-1, Math.min(1, f)) * 32767;
    const sign = s < 0 ? 0x80 : 0;
    s = Math.min(32635, Math.abs(s)) + 132;
    let exp = 7;
    for (let mask = 0x4000; exp > 0 && !(s & mask); mask >>= 1) exp--;
    return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
  };

  /* Linear resampler with a carry — the mic runs at the device's rate
   * (44.1 or 48 kHz), the agent wants 16 kHz, and chunk boundaries must
   * not drop or duplicate a sample or the pitch drifts over a minute. */
  function resampler(inRate, outRate) {
    let carry = new Float32Array(0);
    let pos = 0;
    return chunk => {
      const buf = new Float32Array(carry.length + chunk.length);
      buf.set(carry);
      buf.set(chunk, carry.length);
      const step = inRate / outRate;
      const n = Math.max(0, Math.ceil((buf.length - 1 - pos) / step));
      const out = new Float32Array(n);
      let p = pos, k = 0;
      while (p + 1 < buf.length) {
        const i = Math.floor(p), f = p - i;
        out[k++] = buf[i] * (1 - f) + buf[i + 1] * f;
        p += step;
      }
      const consumed = Math.floor(p);
      carry = buf.slice(consumed);
      pos = p - consumed;
      return out.subarray(0, k);
    };
  }

  /* The capture tap runs in an AudioWorklet when there is one: a phone
   * that is also drawing a moving map drops main-thread audio callbacks,
   * and a dropped callback is a hole in what the agent hears. */
  const WORKLET_SRC = `
    class OttoTap extends AudioWorkletProcessor {
      constructor() { super(); this.buf = []; this.n = 0; }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) {
          this.buf.push(new Float32Array(ch));
          this.n += ch.length;
          if (this.n >= 2048) {
            const out = new Float32Array(this.n);
            let o = 0;
            for (const b of this.buf) { out.set(b, o); o += b.length; }
            this.buf = []; this.n = 0;
            this.port.postMessage(out, [out.buffer]);
          }
        }
        return true;
      }
    }
    registerProcessor('otto-tap', OttoTap);`;

  /* One output context for the page, created inside a user gesture by
   * prime() — a trigger fires minutes after the last tap, and a context
   * born outside a gesture starts suspended and stays silent. */
  let out = null;
  function outputCtx() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!out) out = new AC();
      if (out.state === 'suspended') out.resume().catch(() => {});
      return out;
    } catch { return null; }
  }

  function available() {
    if (String(window.OTTO_AGENT || '').toLowerCase() === 'off') return false;
    if (new URLSearchParams(location.search).get('noagent')) return false;
    return !!agentId() && window.isSecureContext && typeof WebSocket !== 'undefined' &&
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
      !!(window.AudioContext || window.webkitAudioContext);
  }

  /* Called from the tap that arms a test: wake the output context and get
   * the microphone question answered NOW, while the tester is looking at
   * the phone — not when the trigger fires half an hour later in a car. */
  async function prime() {
    if (!available()) return false;
    outputCtx();
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
      return true;
    } catch { return false; }
  }

  function mount(options) {
    const opt = {
      el: '#otto', assistant: 'Otto',
      context: () => '', greeting: null, vars: () => ({}), briefing: () => '',
      /* ISO code ('it') to run THIS conversation in — '' / 'en' sends no
       * override and the agent stays in its own default language */
      language: () => '',
      extra: () => ({}), onSaved: null, onError: null, onFallback: null,
      ...(options || {}),
    };
    const root = typeof opt.el === 'string' ? document.querySelector(opt.el) : opt.el;
    if (!root) throw new Error('OttoAgent: mount target not found — ' + opt.el);

    root.classList.add('vn');
    root.innerHTML = SHELL;
    const q = sel => root.querySelector(sel);
    const ui = {
      face: q('.vn-face'), msg: q('.vn-msg'), caption: q('.vn-caption'), sub: q('.vn-sub'),
      mic: q('.vn-mic'), chip: q('.vn-chip'), rings: [q('.vn-ring1'), q('.vn-ring2')],
    };

    const state = {
      ws: null, stream: null, inCtx: null, node: null, src: null,
      turns: [], phase: 'connect', ending: false, saved: false, dead: false, opened: false,
      allowOverrides: true, wantsLanguage: false, tried: 0, lastVoice: 0, timers: [],
      inFmt: { codec: 'pcm', rate: 16000 }, outFmt: { codec: 'pcm', rate: 16000 },
      queue: [], playHead: 0,
    };

    const contextLabel = () => {
      try { return String(opt.context() || '').trim(); } catch { return ''; }
    };

    /* ---------- rendering ---------- */
    const bubble = (who, text) => `
      <div class="vn-bubble vn-bubble-${who}">
        <span class="vn-who">${who === 'ai' ? esc(opt.assistant) : 'YOU'}</span>
        <div class="vn-text">${who === 'ai' ? esc(text) : '&ldquo;' + esc(text) + '&rdquo;'}</div>
      </div>`;

    function render(msg, phase) {
      state.phase = phase || state.phase;
      ui.face.innerHTML = state.phase === 'think' ? THINK : EYES;
      /* the rings are the "the line is open" signal — they run for the
       * whole conversation, not per recording, because it IS one */
      ui.rings.forEach(r => { r.hidden = state.phase !== 'listening' && state.phase !== 'speaking'; });
      if (msg) ui.msg.innerHTML = bubble(msg.from, msg.text);
      const [cap, sub] = CAPTIONS[state.phase] || CAPTIONS.listening;
      ui.caption.textContent = cap;
      ui.sub.textContent = sub;
      ui.mic.hidden = state.phase === 'done' || state.phase === 'think';
      /* the button is an END button here: there is no tap-to-talk in a
       * conversation, so the only thing left to press is "that's it" */
      const live = state.phase === 'listening' || state.phase === 'speaking';
      ui.mic.innerHTML = live ? STOP_SVG : MIC_SVG;
      ui.mic.classList.toggle('vn-mic-rec', live);
      ui.mic.setAttribute('aria-label', live ? 'End the conversation and save' : 'Retry');
    }
    const chip = text => { ui.chip.textContent = text; ui.chip.hidden = false; };
    const say = (from, text) => {
      if (from === 'ai') text = stripAudioTags(text);
      if (!String(text || '').trim()) return; // a line that was ONLY a stage direction
      state.turns.push({ from, text: String(text).trim(), at: new Date().toISOString() });
      state.lastVoice = Date.now();
      render({ from, text }, from === 'ai' ? 'speaking' : 'listening');
    };

    /* ---------- playback ---------- */
    function play(bytes) {
      const ctx = outputCtx();
      if (!ctx) return;
      const { codec, rate } = state.outFmt;
      let f32;
      if (codec === 'ulaw') {
        f32 = new Float32Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) f32[i] = ulawDecode(bytes[i]);
      } else {
        const n = bytes.length >> 1;
        const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
        f32 = new Float32Array(n);
        for (let i = 0; i < n; i++) f32[i] = view.getInt16(i * 2, true) / 32768;
      }
      if (!f32.length) return;
      let buf;
      try { buf = ctx.createBuffer(1, f32.length, rate); } catch { return; }
      buf.copyToChannel(f32, 0);
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(ctx.destination);
      /* a small lead keeps the chunks butted together instead of clicking */
      const at = Math.max(ctx.currentTime + 0.08, state.playHead);
      node.start(at);
      state.playHead = at + buf.duration;
      state.queue.push(node);
      node.onended = () => {
        state.queue = state.queue.filter(n => n !== node);
        if (!state.queue.length && state.phase === 'speaking' && !state.ending) render(null, 'listening');
      };
    }
    function stopPlayback() {
      state.queue.forEach(n => { try { n.stop(); } catch { /* already done */ } });
      state.queue = [];
      state.playHead = 0;
    }

    /* ---------- capture ---------- */
    async function startMic() {
      state.stream = await navigator.mediaDevices.getUserMedia({
        /* the agent's own voice comes out of the same phone — without
         * cancellation it hears itself and answers itself */
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      state.inCtx = ctx;
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      state.src = ctx.createMediaStreamSource(state.stream);
      const down = resampler(ctx.sampleRate, state.inFmt.rate);

      const send = frame => {
        if (!state.ws || state.ws.readyState !== 1) return;
        const f32 = down(frame);
        if (!f32.length) return;
        let bytes;
        if (state.inFmt.codec === 'ulaw') {
          bytes = new Uint8Array(f32.length);
          for (let i = 0; i < f32.length; i++) bytes[i] = ulawEncode(f32[i]);
        } else {
          bytes = new Uint8Array(f32.length * 2);
          const view = new DataView(bytes.buffer);
          for (let i = 0; i < f32.length; i++) {
            const s = Math.max(-1, Math.min(1, f32[i]));
            view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
          }
        }
        state.ws.send(JSON.stringify({ user_audio_chunk: b64(bytes) }));
      };

      let worklet = null;
      try {
        if (ctx.audioWorklet) {
          const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
          await ctx.audioWorklet.addModule(url);
          URL.revokeObjectURL(url);
          worklet = new AudioWorkletNode(ctx, 'otto-tap');
          worklet.port.onmessage = e => send(e.data);
          state.src.connect(worklet);
          /* a worklet with nothing downstream is allowed to be pruned —
           * a muted sink keeps it pulling */
          const mute = ctx.createGain();
          mute.gain.value = 0;
          worklet.connect(mute).connect(ctx.destination);
          state.node = worklet;
        }
      } catch { worklet = null; }
      if (!worklet) {
        /* deprecated, still the only thing every WebView has */
        const sp = ctx.createScriptProcessor(4096, 1, 1);
        sp.onaudioprocess = e => send(new Float32Array(e.inputBuffer.getChannelData(0)));
        state.src.connect(sp);
        const mute = ctx.createGain();
        mute.gain.value = 0;
        sp.connect(mute).connect(ctx.destination);
        state.node = sp;
      }
    }
    function stopMic() {
      try { if (state.node) state.node.disconnect(); } catch { /* gone */ }
      try { if (state.src) state.src.disconnect(); } catch { /* gone */ }
      if (state.node && state.node.port) state.node.port.onmessage = null;
      if (state.node && 'onaudioprocess' in state.node) state.node.onaudioprocess = null;
      if (state.stream) state.stream.getTracks().forEach(t => t.stop());
      if (state.inCtx) { try { state.inCtx.close(); } catch { /* already closed */ } }
      state.node = state.src = state.stream = state.inCtx = null;
    }

    /* ---------- the session ---------- */
    async function socketUrl(id) {
      /* A private agent needs a signed URL, and signing needs the API key
       * — which lives in the Edge Function's secrets, never here. A
       * public agent connects with the id alone, so a missing function is
       * not an error: try, and fall through. */
      try {
        if (Backend.enabled && Backend.agentToken) {
          const d = await Backend.agentToken(id);
          if (d && d.signed_url) return d.signed_url;
        }
      } catch (e) {
        console.warn('OttoAgent: no signed URL (' + (e.message || e) + ') — connecting as a public agent');
      }
      return `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(id)}`;
    }

    function initPayload() {
      let vars = {};
      try { vars = opt.vars() || {}; } catch { vars = {}; }
      /* everything goes up as a string: dynamic variables are substituted
       * into the prompt as text, and a null there reads as "null" */
      const dynamic_variables = {};
      Object.keys(vars).forEach(k => {
        const v = vars[k];
        if (v === null || v === undefined || v === '') return;
        dynamic_variables[k] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
      });
      const payload = { type: 'conversation_initiation_client_data', dynamic_variables };
      /* Two things overridden, both only if the agent's security settings
       * allow it (retried without on refusal): the opening line, because
       * the scenario owns it ("Otto says" on the sheet), and the
       * conversation language, because the tester picked it on the card.
       * 'en' is not sent — that is the agent's own default, and an
       * override the agent has not allowed would cost the opening line
       * for nothing. The prompt, voice and tools stay exactly as built. */
      const agent = {};
      let first = '';
      try { first = String((opt.greeting && opt.greeting()) || '').trim(); } catch { first = ''; }
      if (first) agent.first_message = first;
      let lang = '';
      try { lang = String((opt.language && opt.language()) || '').trim().toLowerCase(); } catch { lang = ''; }
      if (lang && lang !== 'en') agent.language = lang;
      state.wantsLanguage = !!agent.language;
      if (Object.keys(agent).length && state.allowOverrides) payload.conversation_config_override = { agent };
      return payload;
    }

    function connect() {
      state.tried++;
      state.opened = false;
      state.lastVoice = Date.now();
      clearInterval(state.watch);
      /* Two ends to a conversation that nobody ended: a hard cap, and a
       * silence long enough that the tester has clearly walked off. */
      state.watch = setInterval(() => {
        if (state.ending || state.dead) return;
        const now = Date.now();
        if (now - state.started > MAX_SESSION_MS || now - state.lastVoice > IDLE_MS) finish();
      }, 5000);
      render({ from: 'ai', text: 'One moment — getting Otto on the line…' }, 'connect');
      socketUrl(agentId()).then(url => {
        if (state.dead) return;
        let ws;
        try { ws = new WebSocket(url); } catch (e) { return fail(e.message || 'socket refused'); }
        state.ws = ws;
        /* a connect that never resolves is worse than one that fails —
         * the tester is standing in the street waiting for a voice */
        const guard = setTimeout(() => { if (ws.readyState !== 1) { try { ws.close(); } catch { /* gone */ } } }, 12000);
        state.timers.push(guard);

        ws.onopen = () => {
          clearTimeout(guard);
          state.opened = true;
          ws.send(JSON.stringify(initPayload()));
          /* Context the prompt did not have to ask for: an agent that
           * never heard of {{scenario_rule}} still gets told, in plain
           * words, which test just fired. Non-interrupting by design. */
          let brief = '';
          try { brief = String((opt.briefing && opt.briefing()) || '').trim(); } catch { brief = ''; }
          if (brief) ws.send(JSON.stringify({ type: 'contextual_update', text: brief.slice(0, 2000) }));
          startMic().catch(e => fail('microphone: ' + (e.message || e)));
          state.lastVoice = Date.now();
          render(null, 'listening');
          chip('ELEVENLABS');
        };

        ws.onmessage = ev => {
          let d;
          try { d = JSON.parse(ev.data); } catch { return; }
          switch (d.type) {
            case 'conversation_initiation_metadata': {
              const m = d.conversation_initiation_metadata_event || {};
              state.conversationId = m.conversation_id || null;
              state.outFmt = parseFormat(m.agent_output_audio_format, 16000);
              state.inFmt = parseFormat(m.user_input_audio_format, 16000);
              break;
            }
            case 'audio':
              if (d.audio_event && d.audio_event.audio_base_64) {
                state.lastVoice = Date.now();
                if (state.phase === 'listening') render(null, 'speaking');
                play(unb64(d.audio_event.audio_base_64));
              }
              break;
            case 'user_transcript':
              say('me', (d.user_transcription_event || {}).user_transcript);
              break;
            case 'agent_response':
              say('ai', (d.agent_response_event || {}).agent_response);
              break;
            case 'agent_response_correction': {
              /* the agent was cut off — what it actually got to say is
               * what the record should hold */
              const c = stripAudioTags((d.agent_response_correction_event || {}).corrected_agent_response || '');
              const last = state.turns[state.turns.length - 1];
              if (c && last && last.from === 'ai') { last.text = c; render({ from: 'ai', text: last.text }); }
              break;
            }
            case 'interruption':
              stopPlayback();
              render(null, 'listening');
              break;
            case 'ping':
              ws.send(JSON.stringify({ type: 'pong', event_id: (d.ping_event || {}).event_id }));
              break;
            case 'client_error':
              console.warn('OttoAgent: ' + JSON.stringify(d.error_event || {}).slice(0, 300));
              break;
            default:
              break; // tool calls, vad scores, agent_response_complete — nothing to draw
          }
        };

        ws.onerror = () => { /* onclose carries the outcome */ };
        ws.onclose = e => {
          clearTimeout(guard);
          if (state.dead || state.ending) return;
          /* The one refusal worth retrying: overrides not enabled for
           * this agent. Drop the scenario's opening line and reconnect —
           * a debrief in the agent's own words beats no debrief. It is
           * only that if the socket got as far as OPEN: the override
           * goes up after the handshake, so a connection that never
           * opened failed for a reason no retry here can fix. */
          const why = String(e.reason || '');
          if (state.opened && state.allowOverrides && state.tried < 2 && !state.turns.length) {
            state.allowOverrides = false;
            console.warn('OttoAgent: reconnecting without the overrides' + (why ? ' — ' + why : ''));
            /* a declined language override is fixable — name the fix */
            chip(state.wantsLanguage
              ? 'OVERRIDES DECLINED — ALLOW "LANGUAGE" IN THE AGENT\'S SECURITY SETTINGS'
              : 'AGENT DECLINED THE OPENING LINE');
            stopMic();
            connect();
            return;
          }
          if (state.turns.some(t => t.from === 'me')) finish();       // they spoke: that is a debrief
          else fail(why || 'the agent closed the connection');
        };
      }).catch(e => fail(e.message || 'could not reach the agent'));
    }

    /* Connecting failed for good — hand back to the recorded debrief so
     * the tester still has a way to report what they came to report. */
    function fail(msg) {
      if (state.dead) return;
      console.warn('OttoAgent: ' + msg);
      teardown();
      if (opt.onError) { try { opt.onError(new Error(msg)); } catch { /* host's problem */ } }
      if (opt.onFallback) { opt.onFallback(new Error(msg)); return; }
      render({ from: 'ai', text: `I couldn't reach the agent (${msg}). Tap to try again.` }, 'error');
      ui.mic.hidden = false;
    }

    /* Title of last resort, for when the structuring function is not
     * there: the first sentence, cut on a word boundary. The dashboard
     * lists these one per line, and half a word helps nobody. */
    function headline(text) {
      const first = String(text).split(/(?<=[.!?])\s+/)[0] || String(text);
      if (first.length <= 60) return first;
      const cut = first.slice(0, 60);
      const sp = cut.lastIndexOf(' ');
      return (sp > 30 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, '') + '…';
    }

    /* ---------- ending: the conversation becomes a filed debrief ---------- */
    async function finish() {
      if (state.ending || state.saved) return;
      state.ending = true;
      const said = () => state.turns.some(t => t.from === 'me');
      /* Transcripts arrive a beat after the words: a tester who answers
       * and taps END in the same breath would have their whole debrief
       * still in flight — closing the socket now files "nothing was
       * said". Hold the line open a moment and let it land. */
      if (!said() && state.ws && state.ws.readyState === 1) {
        render(null, 'think');
        await new Promise(r => setTimeout(r, 2000));
      }
      teardown();
      const spoken = state.turns.filter(t => t.from === 'me').map(t => t.text).join(' ').trim();
      if (!spoken) {
        render({ from: 'ai', text: 'Nothing was said, so there is nothing to file. Tap to talk to Otto again.' }, 'empty');
        ui.mic.hidden = false;
        state.ending = false;
        state.tried = 0;
        return;
      }
      render({ from: 'ai', text: 'Got it — filing that against the pin…' }, 'think');

      const context = contextLabel();
      /* The agent already replied out loud, so only the structuring is
       * wanted here: the same title + category the dashboard matches
       * against the scenario's expected tip type. If the function is not
       * there, the debrief is still saved — as its own first sentence. */
      let note = { title: headline(spoken), category: null };
      try {
        if (Backend.enabled && Backend.structureText) {
          const d = await Backend.structureText({ transcript: spoken, context, conversation: state.turns });
          if (d && d.note && d.note.title) note = { title: String(d.note.title).slice(0, 60), category: d.note.category || null };
        }
      } catch (e) {
        console.warn('OttoAgent: could not structure the conversation —', e.message);
      }

      const lastReply = [...state.turns].reverse().find(t => t.from === 'ai');
      const row = {
        context,
        transcript: spoken,
        title: note.title,
        category: note.category,
        via: 'elevenlabs',
        convo: state.turns,
        ...opt.extra(),
      };
      let saved = null;
      try {
        const res = await save(row);
        if (Array.isArray(res) && res[0]) saved = res[0];
      } catch (e) {
        console.warn('OttoAgent: could not save the debrief —', e.message);
      }
      state.saved = true;
      chip(`DEBRIEF SAVED · ${note.category || 'INFO'}`);
      render({ from: 'ai', text: (lastReply && lastReply.text) || 'Saved — the dashboard has it.' }, 'done');
      if (opt.onSaved) {
        opt.onSaved({
          transcript: spoken,
          reply: lastReply ? lastReply.text : null,
          spoken: true, // the agent said its piece already — do not speak it again
          note,
          conversation: state.turns,
          conversation_id: state.conversationId || null,
          row: saved || row,
        });
      }
    }

    /* `via` and `convo` arrived with this feature; a database still on the
     * older schema rejects the whole row for them. The conversation is
     * worth more than its metadata — drop them and save the debrief. */
    async function save(row) {
      if (!Backend.enabled) return null;
      try {
        return await Backend.saveNote(row);
      } catch (e) {
        if (!/via|convo|column/i.test(String(e.message || ''))) throw e;
        console.warn('OttoAgent: messages table has no via/convo column yet (re-run schema.sql) — saving without them');
        const { via, convo, ...rest } = row;
        return Backend.saveNote(rest);
      }
    }

    function teardown() {
      state.timers.forEach(clearTimeout);
      state.timers = [];
      clearInterval(state.watch);
      stopMic();
      stopPlayback();
      if (state.ws) {
        const ws = state.ws;
        state.ws = null;
        ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
        try { ws.close(); } catch { /* already closed */ }
      }
    }

    ui.mic.addEventListener('click', () => {
      if (state.phase === 'listening' || state.phase === 'speaking') { finish(); return; }
      if (state.phase === 'error' || state.phase === 'empty') { state.tried = 0; state.allowOverrides = true; connect(); }
    });

    const api = {
      agent: true,
      get live() { return true; },
      start() {
        state.started = state.lastVoice = Date.now();
        connect();
        return api;
      },
      stop() { teardown(); return api; },
      /* Closing the screen mid-conversation still files what was said —
       * the tester answered the question; the screen is not the record. */
      end() { finish(); return api; },
      destroy() {
        if (state.turns.some(t => t.from === 'me') && !state.saved && !state.ending) { finish(); }
        state.dead = true;
        teardown();
        root.innerHTML = '';
        root.classList.remove('vn');
        return api;
      },
    };
    return api.start();
  }

  return { available, prime, mount, agentId };
})();
