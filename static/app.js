/**
 * Gemini Live Video Translate — Frontend
 *
 * Pipeline
 *   <video> ──createMediaElementSource──┬─▶ AudioWorklet ─▶ 16kHz 16-bit PCM ─▶ WebSocket ─▶ Gemini Live
 *                                       └─▶ sourceGain ──┐
 *   Gemini 24kHz PCM ◀── WebSocket ──▶ scheduler ─▶ targetGain ─┴─▶ speakers
 *
 * - Source (original) and target (translated) audio volumes are fully independent.
 * - Optional auto-ducking lowers the source while translated speech is playing.
 * - Translated subtitles are rendered as a max-2-line overlay on top of the player.
 */

(() => {
  "use strict";

  // =========================================================================
  // Constants & fallbacks
  // =========================================================================

  const STORAGE_KEY = "live_video_translate_settings_v1";
  const INPUT_SAMPLE_RATE = 16000;
  const OUTPUT_SAMPLE_RATE = 24000;
  const DUCK_RATIO = 0.5; // source gain multiplier while translated speech plays (-6 dB)
  const SPEECH_PEAK_THRESHOLD = 500; // int16 peak (~ -36 dBFS) above which a chunk counts as speech
  const DUCK_RELEASE_S = 0.35; // keep ducking briefly after the last audible chunk
  const END_DRAIN_SILENCE_MS = 1800; // silence required after video end before closing the session
  const END_DRAIN_MAX_MS = 20000;
  const SUBTITLE_IDLE_HIDE_MS = 6000;
  const SUBTITLE_FINALIZE_MS = 1600;
  const SEEK_RECONNECT_DEBOUNCE_MS = 450;
  const LEAD_DRIFT_TOLERANCE_S = 0.3; // re-align feeder when it drifts from video + delay by more than this

  const DEFAULT_SETTINGS = {
    targetLang: "ko",
    sourceVolume: 10,
    targetVolume: 100,
    voice: "auto",
    autoDuck: false,
    showSource: false,
    subtitleSize: "md",
    echoTargetLanguage: true,
    lastVideoId: null,
  };

  // Minimal fallback if /api/config is unreachable (server normally supplies 78 languages)
  const FALLBACK_LANGUAGES = [
    { code: "en", name: "English", ko_name: "영어", popular: true },
    { code: "ko", name: "Korean", ko_name: "한국어", popular: true },
    { code: "ja", name: "Japanese", ko_name: "일본어", popular: true },
    { code: "zh-Hans", name: "Chinese (Simplified)", ko_name: "중국어 (간체)", popular: true },
    { code: "es", name: "Spanish", ko_name: "스페인어", popular: true },
    { code: "fr", name: "French", ko_name: "프랑스어", popular: true },
    { code: "de", name: "German", ko_name: "독일어", popular: true },
  ];
  const FALLBACK_VOICES = [
    { id: "auto", name: "자동 (화자 음성 복제)", description: "원 화자의 목소리를 따라 번역 음성을 생성합니다." },
  ];

  const CLIENT_SESSION_ID = (() => {
    try {
      const key = "live_video_translate_session_id";
      let existing = sessionStorage.getItem(key);
      if (!existing) {
        existing =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        sessionStorage.setItem(key, existing);
      }
      return existing;
    } catch (_) {
      return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
  })();

  // =========================================================================
  // DOM
  // =========================================================================

  const $ = (id) => document.getElementById(id);
  const dom = {
    statusPill: $("sessionStatusPill"),
    statusText: $("sessionStatusText"),
    btnToggleSidebar: $("btnToggleSidebar"),
    btnOpenSettings: $("btnOpenSettings"),
    btnLogout: $("btnLogout"),
    workspace: $("workspace"),
    sidebar: $("videoSidebar"),
    videoList: $("videoList"),
    videoCountBadge: $("videoCountBadge"),
    playerWrap: $("playerWrap"),
    video: $("videoPlayer"),
    playerEmpty: $("playerEmpty"),
    holdOverlay: $("holdOverlay"),
    holdCountdown: $("holdCountdown"),
    playoutDelayTag: $("playoutDelayTag"),
    subtitleOverlay: $("subtitleOverlay"),
    subtitleSource: $("subtitleSource"),
    subtitleTarget: $("subtitleTarget"),
    detectedLang: $("detectedLang"),
    detectedLangText: $("detectedLangText"),
    targetLangSelect: $("targetLangSelect"),
    sourceVolume: $("sourceVolume"),
    sourceVolumeValue: $("sourceVolumeValue"),
    sourceVolIcon: $("sourceVolIcon"),
    btnMuteSource: $("btnMuteSource"),
    targetVolume: $("targetVolume"),
    targetVolumeValue: $("targetVolumeValue"),
    targetVolIcon: $("targetVolIcon"),
    btnMuteTarget: $("btnMuteTarget"),
    settingsModal: $("settingsModal"),
    btnCloseSettings: $("btnCloseSettings"),
    btnDoneSettings: $("btnDoneSettings"),
    voiceSelect: $("voiceSelect"),
    voiceDesc: $("voiceDesc"),
    autoDuckToggle: $("autoDuckToggle"),
    showSourceToggle: $("showSourceToggle"),
    echoToggle: $("echoToggle"),
    segButtons: Array.from(document.querySelectorAll(".seg-btn")),
    modelTag: $("modelTag"),
    toast: $("toastMessage"),
  };

  // =========================================================================
  // State
  // =========================================================================

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    languages: FALLBACK_LANGUAGES,
    voices: FALLBACK_VOICES,
    videos: [],
    currentVideo: null,

    // WebSocket / session
    ws: null,
    userWantsSession: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    sessionConnected: false,
    lastActivityPingAt: 0,

    // Web Audio graph
    audioCtx: null,
    mediaSourceNode: null,
    videoGain: null, // per-video loudness compensation (videos.json "gain")
    // Lead feeder: hidden <audio> playing PLAYOUT_DELAY seconds ahead of the visible video.
    // Its output goes only to the capture worklet (never to the speakers).
    playoutDelay: 0,
    feeder: null,
    feederSourceNode: null,
    feederGain: null,
    holding: false,
    holdTimer: null,
    holdTickTimer: null,
    resumingFromHold: false,
    driftTimer: null,
    captureNode: null,
    captureSink: null,
    sourceGain: null,
    targetGain: null,
    captureReady: false,
    isSending: false,

    // Translated-audio scheduler
    nextPlayTime: 0,
    scheduledSources: new Set(),
    pcmRemainder: new Uint8Array(0),
    duckTimer: null,
    rxChunks: 0,
    rxBytes: 0,
    rxLastPeak: 0,
    rxLoudChunks: 0,
    loudUntil: 0, // AudioContext time until which audible translated speech is scheduled

    // Subtitles
    targetLines: [], // committed sentences (strings)
    activeTarget: null, // { text, interim, timer }
    sourceActive: "",
    subtitleHideTimer: null,

    // Playback lifecycle
    seekTimer: null,
    endDrainTimer: null,
    prevSourceVolume: 10,
    lastSpeechWallMs: 0,
    prevTargetVolume: 100,
  };

  // =========================================================================
  // Utilities
  // =========================================================================

  let toastTimer = null;
  function showToast(message, durationMs = 3200) {
    if (!dom.toast) return;
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    dom.toast.classList.add("is-visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      dom.toast.classList.remove("is-visible");
      setTimeout(() => (dom.toast.hidden = true), 250);
    }, durationMs);
  }

  function setStatus(stateName, text) {
    dom.statusPill.setAttribute("data-state", stateName);
    dom.statusText.textContent = text;
  }

  function formatDuration(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return "";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function findLanguage(code) {
    if (!code) return null;
    const lower = code.toLowerCase();
    return (
      state.languages.find((l) => l.code.toLowerCase() === lower) ||
      state.languages.find((l) => l.code.toLowerCase() === lower.split("-")[0]) ||
      null
    );
  }

  function formatLanguageLabel(code) {
    const lang = findLanguage(code);
    if (!lang) return code || "-";
    return `${lang.ko_name} (${lang.code})`;
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state.settings = { ...DEFAULT_SETTINGS, ...parsed };
      }
    } catch (_) {
      state.settings = { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
    } catch (_) {}
  }

  function updateSetting(key, value) {
    state.settings[key] = value;
    saveSettings();
  }

  // =========================================================================
  // Bootstrap
  // =========================================================================

  async function init() {
    loadSettings();
    await Promise.all([fetchConfig(), fetchVideos()]);
    renderLanguageSelect();
    renderVoiceSelect();
    renderVideoList();
    applySettingsToUI();
    bindEvents();
    setStatus("idle", "대기 중");

    // Restore last-selected video (without autoplay)
    const last = state.videos.find((v) => v.id === state.settings.lastVideoId);
    if (last) selectVideo(last, { autoplay: false });
  }

  async function fetchConfig() {
    try {
      const res = await fetch("/api/config", { credentials: "same-origin" });
      if (res.status === 401) {
        window.location.replace("/login");
        return;
      }
      const cfg = await res.json();
      if (Array.isArray(cfg.supported_languages) && cfg.supported_languages.length) {
        state.languages = cfg.supported_languages;
      }
      if (Array.isArray(cfg.supported_voices) && cfg.supported_voices.length) {
        state.voices = cfg.supported_voices;
      }
      if (cfg.live_translate_model && dom.modelTag) {
        dom.modelTag.textContent = cfg.live_translate_model;
      }
      const d = Number(cfg.playout_delay_seconds);
      state.playoutDelay = Number.isFinite(d) && d > 0 ? Math.min(d, 10) : 0;
      if (dom.playoutDelayTag) {
        dom.playoutDelayTag.textContent = state.playoutDelay > 0
          ? `송출 지연 ${state.playoutDelay.toFixed(1)}s (PLAYOUT_DELAY_SECONDS)`
          : "송출 지연 없음 (PLAYOUT_DELAY_SECONDS=0)";
      }
    } catch (err) {
      console.warn("Failed to load /api/config, using fallbacks:", err);
    }
  }

  async function fetchVideos() {
    try {
      const res = await fetch(`/api/videos?ts=${Date.now()}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.status === 401) {
        window.location.replace("/login");
        return;
      }
      const data = await res.json();
      state.videos = Array.isArray(data.videos) ? data.videos.filter((v) => v && v.file) : [];
    } catch (err) {
      console.error("Failed to load videos.json:", err);
      state.videos = [];
      showToast("비디오 목록을 불러오지 못했습니다.");
    }
  }

  // =========================================================================
  // Rendering
  // =========================================================================

  function renderLanguageSelect() {
    const sel = dom.targetLangSelect;
    sel.innerHTML = "";
    const popular = state.languages.filter((l) => l.popular);
    const others = state.languages
      .filter((l) => !l.popular)
      .sort((a, b) => a.ko_name.localeCompare(b.ko_name, "ko"));

    const makeGroup = (label, list) => {
      const group = document.createElement("optgroup");
      group.label = label;
      list.forEach((l) => {
        const opt = document.createElement("option");
        opt.value = l.code;
        opt.textContent = `${l.ko_name} (${l.name} · ${l.code})`;
        group.appendChild(opt);
      });
      return group;
    };
    if (popular.length) sel.appendChild(makeGroup("주요 언어", popular));
    if (others.length) sel.appendChild(makeGroup("전체 언어", others));
    sel.value = state.settings.targetLang;
    if (!sel.value) sel.value = "ko";
  }

  function renderVoiceSelect() {
    const sel = dom.voiceSelect;
    sel.innerHTML = "";
    state.voices.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name;
      sel.appendChild(opt);
    });
    sel.value = state.settings.voice;
    if (!sel.value) sel.value = "auto";
    updateVoiceDescription();
  }

  function updateVoiceDescription() {
    const v = state.voices.find((x) => x.id === dom.voiceSelect.value);
    dom.voiceDesc.textContent = v?.description || "";
  }

  function renderVideoList() {
    dom.videoList.innerHTML = "";
    dom.videoCountBadge.textContent = String(state.videos.length);

    if (!state.videos.length) {
      const li = document.createElement("li");
      li.className = "video-item-empty";
      li.textContent = "등록된 비디오가 없습니다.";
      dom.videoList.appendChild(li);
      return;
    }

    state.videos.forEach((video, index) => {
      const li = document.createElement("li");
      li.className = "video-item";
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.dataset.videoId = video.id;
      li.tabIndex = 0;

      li.innerHTML = `
        <div class="video-thumb" aria-hidden="true">
          <span class="thumb-index">${index + 1}</span>
          <span class="material-symbols-outlined thumb-icon">play_arrow</span>
        </div>
        <div class="video-meta">
          <span class="video-title"></span>
          <span class="video-sub"></span>
        </div>
      `;
      li.querySelector(".video-title").textContent = video.title || video.file;
      const subParts = [];
      if (video.duration) subParts.push(formatDuration(video.duration));
      if (video.description) subParts.push(video.description);
      li.querySelector(".video-sub").textContent = subParts.join(" · ");

      const activate = () => selectVideo(video, { autoplay: true });
      li.addEventListener("click", activate);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
      dom.videoList.appendChild(li);
    });
  }

  function highlightSelectedVideo() {
    dom.videoList.querySelectorAll(".video-item").forEach((li) => {
      const selected = state.currentVideo && li.dataset.videoId === state.currentVideo.id;
      li.classList.toggle("is-selected", Boolean(selected));
      li.setAttribute("aria-selected", selected ? "true" : "false");
    });
  }

  function applySettingsToUI() {
    const s = state.settings;
    dom.sourceVolume.value = s.sourceVolume;
    dom.targetVolume.value = s.targetVolume;
    dom.autoDuckToggle.checked = Boolean(s.autoDuck);
    dom.showSourceToggle.checked = Boolean(s.showSource);
    dom.echoToggle.checked = Boolean(s.echoTargetLanguage);
    dom.subtitleOverlay.dataset.size = s.subtitleSize || "md";
    dom.segButtons.forEach((b) => b.classList.toggle("is-active", b.dataset.size === s.subtitleSize));
    dom.subtitleSource.hidden = !s.showSource;
    updateVolumeUI();
    applyGains();
  }

  function updateVolumeUI() {
    const sv = Number(dom.sourceVolume.value);
    const tv = Number(dom.targetVolume.value);
    dom.sourceVolumeValue.textContent = `${sv}%`;
    dom.targetVolumeValue.textContent = `${tv}%`;
    dom.sourceVolIcon.textContent = sv === 0 ? "volume_off" : sv < 50 ? "volume_down" : "volume_up";
    dom.targetVolIcon.textContent = tv === 0 ? "voice_over_off" : "record_voice_over";
    dom.btnMuteSource.classList.toggle("is-muted", sv === 0);
    dom.btnMuteTarget.classList.toggle("is-muted", tv === 0);
    dom.sourceVolume.style.setProperty("--pct", `${sv}%`);
    dom.targetVolume.style.setProperty("--pct", `${tv}%`);
  }

  // =========================================================================
  // Events
  // =========================================================================

  function bindEvents() {
    // Header
    dom.btnToggleSidebar.addEventListener("click", () => {
      const collapsed = dom.workspace.classList.toggle("sidebar-collapsed");
      dom.btnToggleSidebar.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });
    dom.btnLogout.addEventListener("click", async () => {
      stopSession(true, "logout");
      try {
        await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      } catch (_) {}
      window.location.replace("/login");
    });

    // Settings modal
    dom.btnOpenSettings.addEventListener("click", openSettings);
    dom.btnCloseSettings.addEventListener("click", closeSettings);
    dom.btnDoneSettings.addEventListener("click", closeSettings);
    dom.settingsModal.addEventListener("click", (e) => {
      if (e.target === dom.settingsModal) closeSettings();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !dom.settingsModal.hidden) closeSettings();
    });

    dom.voiceSelect.addEventListener("change", () => {
      updateSetting("voice", dom.voiceSelect.value);
      updateVoiceDescription();
      pushConfigUpdate("음성 변경");
    });
    dom.autoDuckToggle.addEventListener("change", () => {
      updateSetting("autoDuck", dom.autoDuckToggle.checked);
      applyGains();
    });
    dom.showSourceToggle.addEventListener("change", () => {
      updateSetting("showSource", dom.showSourceToggle.checked);
      dom.subtitleSource.hidden = !dom.showSourceToggle.checked;
      renderSubtitles();
    });
    dom.echoToggle.addEventListener("change", () => {
      updateSetting("echoTargetLanguage", dom.echoToggle.checked);
      pushConfigUpdate("echo 설정 변경");
    });
    dom.segButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        dom.segButtons.forEach((b) => b.classList.toggle("is-active", b === btn));
        updateSetting("subtitleSize", btn.dataset.size);
        dom.subtitleOverlay.dataset.size = btn.dataset.size;
        renderSubtitles();
      });
    });

    // Target language
    dom.targetLangSelect.addEventListener("change", () => {
      updateSetting("targetLang", dom.targetLangSelect.value);
      pushConfigUpdate("타겟 언어 변경");
    });

    // Volumes
    dom.sourceVolume.addEventListener("input", () => {
      updateSetting("sourceVolume", Number(dom.sourceVolume.value));
      updateVolumeUI();
      applyGains();
    });
    dom.targetVolume.addEventListener("input", () => {
      updateSetting("targetVolume", Number(dom.targetVolume.value));
      updateVolumeUI();
      applyGains();
    });
    dom.btnMuteSource.addEventListener("click", (e) => {
      e.preventDefault();
      toggleMute("source");
    });
    dom.btnMuteTarget.addEventListener("click", (e) => {
      e.preventDefault();
      toggleMute("target");
    });

    // Video lifecycle
    const v = dom.video;
    // Only "play" (not "playing") drives session/hold logic: "playing" also fires after the
    // lead-hold release and would otherwise re-trigger the hold.
    v.addEventListener("play", onVideoPlay);
    v.addEventListener("pause", onVideoPause);
    v.addEventListener("seeking", onVideoSeeking);
    v.addEventListener("seeked", onVideoSeeked);
    v.addEventListener("ended", onVideoEnded);
    v.addEventListener("error", () => {
      showToast("비디오를 재생할 수 없습니다. 파일 경로를 확인해 주세요.");
      setStatus("error", "재생 오류");
    });

    window.addEventListener("beforeunload", () => stopSession(true, "unload"));
  }

  function openSettings() {
    dom.settingsModal.hidden = false;
    requestAnimationFrame(() => dom.settingsModal.classList.add("is-open"));
  }
  function closeSettings() {
    dom.settingsModal.classList.remove("is-open");
    setTimeout(() => (dom.settingsModal.hidden = true), 180);
  }

  function toggleMute(which) {
    const input = which === "source" ? dom.sourceVolume : dom.targetVolume;
    const key = which === "source" ? "sourceVolume" : "targetVolume";
    const prevKey = which === "source" ? "prevSourceVolume" : "prevTargetVolume";
    const current = Number(input.value);
    if (current > 0) {
      state[prevKey] = current;
      input.value = 0;
    } else {
      const restore = state[prevKey] > 0 ? state[prevKey] : which === "source" ? 10 : 100;
      input.value = restore;
    }
    updateSetting(key, Number(input.value));
    updateVolumeUI();
    applyGains();
  }

  // =========================================================================
  // Video selection & playback lifecycle
  // =========================================================================

  function selectVideo(video, { autoplay }) {
    if (!video) return;
    const isSame = state.currentVideo && state.currentVideo.id === video.id;
    state.currentVideo = video;
    updateSetting("lastVideoId", video.id);
    highlightSelectedVideo();
    dom.playerEmpty.hidden = true;

    clearHold();
    if (!isSame) {
      dom.video.src = `/media/${encodeURIComponent(video.file)}`;
      dom.video.load();
      if (state.feeder) {
        state.feeder.src = dom.video.src;
        state.feeder.load();
      }
    }

    resetTranslationState("비디오 선택");
    ensureAudioGraph();
    if (state.videoGain) {
      const g = getVideoGain(video);
      state.videoGain.gain.setTargetAtTime(g, state.audioCtx.currentTime, 0.02);
      if (state.feederGain) state.feederGain.gain.setTargetAtTime(g, state.audioCtx.currentTime, 0.02);
    }

    // Connect the Live session immediately; audio is only streamed while playing
    startSession();

    if (autoplay) {
      dom.video.play().catch(() => {
        /* autoplay may be blocked until user gesture; controls remain available */
      });
    }
    // Close sidebar on small screens for a cleaner player view
    if (window.matchMedia("(max-width: 900px)").matches) {
      dom.workspace.classList.add("sidebar-collapsed");
      dom.btnToggleSidebar.setAttribute("aria-expanded", "false");
    }
  }

  function onVideoPlay() {
    if (!state.currentVideo) return;
    if (state.endDrainTimer) {
      clearTimeout(state.endDrainTimer);
      state.endDrainTimer = null;
    }
    ensureAudioGraph();
    resumeAudioContext();
    if (!state.userWantsSession || !state.ws || state.ws.readyState > WebSocket.OPEN) {
      startSession();
    }

    if (state.resumingFromHold) {
      // Visible video resuming after the lead hold; feeder is already running ahead
      state.resumingFromHold = false;
      state.isSending = true;
      ensureFeederPlaying();
      startDriftCorrection();
      return;
    }
    if (state.holding) {
      // User pressed play during the hold: keep the picture held until the release timer fires
      try {
        dom.video.pause();
      } catch (_) {}
      return;
    }

    if (state.playoutDelay > 0) {
      beginLeadHold();
    } else {
      state.isSending = true;
    }
  }

  function onVideoPause() {
    if (dom.video.ended) return;
    if (state.holding) return; // our own pause during the lead hold
    // Stop streaming source audio but keep the Live session alive
    state.isSending = false;
    stopDriftCorrection();
    if (state.feeder && !state.feeder.paused) state.feeder.pause();
    if (state.sessionConnected) setStatus("connected", "일시정지");
  }

  function onVideoSeeking() {
    if (state.holding) return;
    state.isSending = false;
    flushTargetAudio();
    if (state.feeder && !state.feeder.paused) state.feeder.pause();
  }

  function onVideoSeeked() {
    if (state.holding) return;
    // Debounce: scrubbing emits many seeked events
    if (state.seekTimer) clearTimeout(state.seekTimer);
    state.seekTimer = setTimeout(() => {
      state.seekTimer = null;
      resetTranslationState("탐색");
      restartSession("탐색으로 세션 재연결");
      if (dom.video.ended) return;
      if (dom.video.paused) {
        if (state.feeder) state.feeder.currentTime = dom.video.currentTime;
        return;
      }
      if (state.playoutDelay > 0) {
        beginLeadHold();
      } else {
        state.isSending = true;
      }
    }, SEEK_RECONNECT_DEBOUNCE_MS);
  }

  // --- Lead hold: feed the model from `t` right away, show the picture `delay` seconds later.

  function beginLeadHold() {
    const delay = state.playoutDelay;
    const video = dom.video;
    clearHold();
    const startAt = video.currentTime;

    // 1) feeder starts immediately at the current position and streams to the model
    if (state.feeder) {
      state.feeder.currentTime = startAt;
      ensureFeederPlaying();
    }
    state.isSending = true;

    // 2) hold the visible video (our own pause; handlers ignore it while `holding`)
    state.holding = true;
    try {
      video.pause();
    } catch (_) {}
    showHold(delay);
    setStatus("connected", "번역 준비 중...");

    const t0 = Date.now();
    state.holdTickTimer = setInterval(() => {
      const left = Math.max(0, delay - (Date.now() - t0) / 1000);
      if (dom.holdCountdown) dom.holdCountdown.textContent = left.toFixed(1);
    }, 100);

    // 3) release after `delay` seconds; the feeder is now exactly `delay` ahead
    state.holdTimer = setTimeout(() => {
      state.holdTimer = null;
      clearInterval(state.holdTickTimer);
      state.holdTickTimer = null;
      state.holding = false;
      hideHold();
      if (video.paused) {
        state.resumingFromHold = true;
        video.play().catch(() => {
          state.resumingFromHold = false;
          showToast("재생을 다시 눌러 주세요.");
        });
      } else {
        // Already playing (e.g. play() raced the hold): just lock in the lead
        state.isSending = true;
        ensureFeederPlaying();
        startDriftCorrection();
      }
    }, delay * 1000);
  }

  function clearHold() {
    if (state.holdTimer) clearTimeout(state.holdTimer);
    if (state.holdTickTimer) clearInterval(state.holdTickTimer);
    state.holdTimer = null;
    state.holdTickTimer = null;
    state.holding = false;
    state.resumingFromHold = false;
    hideHold();
    stopDriftCorrection();
  }

  function showHold(delay) {
    if (!dom.holdOverlay) return;
    if (dom.holdCountdown) dom.holdCountdown.textContent = delay.toFixed(1);
    dom.holdOverlay.hidden = false;
  }
  function hideHold() {
    if (dom.holdOverlay) dom.holdOverlay.hidden = true;
  }

  function ensureFeederPlaying() {
    const f = state.feeder;
    if (!f) return;
    if (f.paused) f.play().catch((e) => console.warn("feeder play failed:", e));
  }

  // Keep feeder = video + delay (within tolerance) while both are playing
  function startDriftCorrection() {
    stopDriftCorrection();
    if (state.playoutDelay <= 0 || !state.feeder) return;
    state.driftTimer = setInterval(() => {
      const v = dom.video;
      const f = state.feeder;
      if (!f || v.paused || v.ended || state.holding) return;
      const expected = v.currentTime + state.playoutDelay;
      if (f.ended || expected >= (f.duration || Infinity)) return;
      if (Math.abs(f.currentTime - expected) > LEAD_DRIFT_TOLERANCE_S) {
        f.currentTime = expected;
      }
      if (f.paused) ensureFeederPlaying();
    }, 1000);
  }
  function stopDriftCorrection() {
    if (state.driftTimer) clearInterval(state.driftTimer);
    state.driftTimer = null;
  }

  function onVideoEnded() {
    state.isSending = false;
    stopDriftCorrection();
    if (state.feeder && !state.feeder.paused) state.feeder.pause();
    setStatus("connected", "번역 마무리 중...");
    // The model keeps streaming (silent) audio while connected, so wait for a stretch of
    // silence (no audible chunk) rather than an empty queue, with an upper bound.
    const startedAt = Date.now();
    state.lastSpeechWallMs = state.lastSpeechWallMs || 0;
    const check = () => {
      const now = Date.now();
      const ctx = state.audioCtx;
      const speechPending = ctx ? ctx.currentTime < state.loudUntil : false;
      const silentFor = now - Math.max(state.lastSpeechWallMs, startedAt);
      const timedOut = now - startedAt > END_DRAIN_MAX_MS;
      if (!timedOut && (speechPending || state.activeTarget || silentFor < END_DRAIN_SILENCE_MS)) {
        state.endDrainTimer = setTimeout(check, 300);
        return;
      }
      state.endDrainTimer = null;
      finalizeTargetSubtitle();
      stopSession(true, "video_ended");
      setStatus("done", "번역 완료");
    };
    check();
  }

  function resetTranslationState(_reason) {
    flushTargetAudio();
    clearSubtitles();
  }

  // =========================================================================
  // Web Audio graph
  // =========================================================================

  function ensureAudioGraph() {
    if (state.audioCtx) return state.audioCtx;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx({ latencyHint: "interactive" });
    state.audioCtx = ctx;

    // Element source (can only be created once per media element)
    state.mediaSourceNode = ctx.createMediaElementSource(dom.video);

    state.videoGain = ctx.createGain();
    state.videoGain.gain.value = getVideoGain(state.currentVideo);
    state.sourceGain = ctx.createGain();
    state.targetGain = ctx.createGain();
    state.sourceGain.connect(ctx.destination);
    state.targetGain.connect(ctx.destination);
    state.mediaSourceNode.connect(state.videoGain);
    state.videoGain.connect(state.sourceGain);

    // Lead feeder (audio-only decode of the same media URL), routed to capture only
    if (state.playoutDelay > 0) {
      const feeder = new Audio();
      feeder.preload = "auto";
      feeder.playsInline = true;
      if (dom.video.src) feeder.src = dom.video.src;
      state.feeder = feeder;
      state.feederSourceNode = ctx.createMediaElementSource(feeder);
      state.feederGain = ctx.createGain();
      state.feederGain.gain.value = getVideoGain(state.currentVideo);
      state.feederSourceNode.connect(state.feederGain);
    }

    applyGains();
    setupCapture(ctx).catch((err) => {
      console.error("Capture setup failed:", err);
      showToast("오디오 캡처 초기화에 실패했습니다.");
    });

    // Ducking supervisor
    if (!state.duckTimer) {
      state.duckTimer = setInterval(applyDucking, 100);
    }
    return ctx;
  }

  function getVideoGain(video) {
    const g = Number(video && video.gain);
    return Number.isFinite(g) && g > 0 ? Math.min(g, 4) : 1;
  }

  function resumeAudioContext() {
    const ctx = state.audioCtx;
    if (ctx && (ctx.state === "suspended" || ctx.state === "interrupted")) {
      ctx.resume().catch(() => {});
    }
  }

  async function setupCapture(ctx) {
    const chunkSamples = Math.max(512, Math.round(ctx.sampleRate * 0.05)); // ~50ms
    // Model input comes from the feeder when playout delay is enabled, else from the visible video
    const captureFrom = state.playoutDelay > 0 && state.feederGain ? state.feederGain : state.videoGain;

    // Muted sink so the graph keeps pulling even if the user mutes the source
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    state.captureSink = sink;

    if (ctx.audioWorklet) {
      try {
        const code = `
          class PcmCaptureProcessor extends AudioWorkletProcessor {
            constructor() {
              super();
              this.chunkSize = ${chunkSamples};
              this.buffer = new Float32Array(this.chunkSize);
              this.writeIndex = 0;
            }
            process(inputs) {
              const input = inputs[0];
              if (!input || !input[0]) return true;
              const ch0 = input[0];
              const ch1 = input[1];
              for (let i = 0; i < ch0.length; i++) {
                // Downmix to mono
                this.buffer[this.writeIndex++] = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
                if (this.writeIndex >= this.chunkSize) {
                  this.port.postMessage(this.buffer.slice(0));
                  this.writeIndex = 0;
                }
              }
              return true;
            }
          }
          registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
        `;
        const blob = new Blob([code], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        const node = new AudioWorkletNode(ctx, "pcm-capture-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        node.port.onmessage = (e) => handleCapturedSamples(e.data, ctx.sampleRate);
        captureFrom.connect(node);
        node.connect(sink);
        state.captureNode = node;
        state.captureReady = true;
        return;
      } catch (err) {
        console.warn("AudioWorklet unavailable, falling back to ScriptProcessor:", err);
      }
    }

    const script = ctx.createScriptProcessor(4096, 2, 1);
    script.onaudioprocess = (event) => {
      const ch0 = event.inputBuffer.getChannelData(0);
      const ch1 = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : null;
      const mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) mono[i] = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      handleCapturedSamples(mono, ctx.sampleRate);
    };
    captureFrom.connect(script);
    script.connect(sink);
    state.captureNode = script;
    state.captureReady = true;
  }

  function handleCapturedSamples(float32, inputRate) {
    if (!state.isSending || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    // RMS for activity keep-alive
    let sum = 0;
    for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
    const rms = Math.sqrt(sum / float32.length);
    if (rms > 0.008) {
      const now = Date.now();
      if (now - state.lastActivityPingAt > 10000) {
        state.lastActivityPingAt = now;
        try {
          state.ws.send(JSON.stringify({ type: "activity" }));
        } catch (_) {}
      }
    }

    const samples = inputRate === INPUT_SAMPLE_RATE ? float32 : downsample(float32, inputRate, INPUT_SAMPLE_RATE);
    const buf = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buf);
    for (let i = 0; i < samples.length; i++) {
      const c = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, c < 0 ? c * 0x8000 : c * 0x7fff, true);
    }
    try {
      state.ws.send(buf);
    } catch (_) {}
  }

  function downsample(buffer, sourceRate, targetRate) {
    const ratio = sourceRate / targetRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < newLength) {
      const nextOffset = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffset && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffset;
    }
    return result;
  }

  // --- Gains & ducking ----------------------------------------------------

  function applyGains() {
    if (!state.audioCtx) return;
    const ctx = state.audioCtx;
    const t = ctx.currentTime;
    const target = state.settings.targetVolume / 100;
    state.targetGain.gain.setTargetAtTime(target, t, 0.03);
    applyDucking(true);
  }

  // The model streams audio continuously (including digital silence) while connected,
  // so "queued audio" is not a speech indicator. Track the time until which audible chunks play.
  function isTargetSpeechPlaying() {
    const ctx = state.audioCtx;
    if (!ctx) return false;
    return ctx.currentTime < state.loudUntil && state.settings.targetVolume > 0;
  }

  function applyDucking(immediate = false) {
    if (!state.audioCtx || !state.sourceGain) return;
    const base = state.settings.sourceVolume / 100;
    const duck = state.settings.autoDuck && isTargetSpeechPlaying();
    const value = duck ? base * DUCK_RATIO : base;
    const g = state.sourceGain.gain;
    const t = state.audioCtx.currentTime;
    if (Math.abs(g.value - value) < 0.001) return;
    g.setTargetAtTime(value, t, immediate ? 0.03 : duck ? 0.08 : 0.25);
  }

  // --- Translated audio playback ------------------------------------------

  function enqueueTargetAudio(arrayBuffer) {
    const ctx = ensureAudioGraph();
    resumeAudioContext();

    // Merge with remainder to keep 16-bit alignment
    let bytes = new Uint8Array(arrayBuffer);
    if (state.pcmRemainder.length) {
      const merged = new Uint8Array(state.pcmRemainder.length + bytes.length);
      merged.set(state.pcmRemainder, 0);
      merged.set(bytes, state.pcmRemainder.length);
      bytes = merged;
    }
    const usable = bytes.length - (bytes.length % 2);
    state.pcmRemainder = bytes.slice(usable);
    if (usable === 0) return;

    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, usable / 2);
    const audioBuffer = ctx.createBuffer(1, int16.length, OUTPUT_SAMPLE_RATE);
    const ch = audioBuffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < int16.length; i++) {
      const s = int16[i];
      ch[i] = s / 32768;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
    state.rxChunks += 1;
    state.rxBytes += usable;
    state.rxLastPeak = peak;
    const isSpeech = peak > SPEECH_PEAK_THRESHOLD;
    if (isSpeech) state.rxLoudChunks += 1;

    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(state.targetGain);

    const now = ctx.currentTime;
    const startAt = Math.max(now + 0.02, state.nextPlayTime);
    src.start(startAt);
    state.nextPlayTime = startAt + audioBuffer.duration;
    if (isSpeech) {
      state.loudUntil = Math.max(state.loudUntil, state.nextPlayTime + DUCK_RELEASE_S);
      state.lastSpeechWallMs = Date.now();
    }

    state.scheduledSources.add(src);
    src.onended = () => state.scheduledSources.delete(src);
    applyDucking();
  }

  function flushTargetAudio() {
    state.scheduledSources.forEach((s) => {
      try {
        s.stop();
      } catch (_) {}
    });
    state.scheduledSources.clear();
    state.pcmRemainder = new Uint8Array(0);
    state.nextPlayTime = 0;
    state.loudUntil = 0;
    applyDucking(true);
  }

  // =========================================================================
  // WebSocket session
  // =========================================================================

  function buildWsUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({
      session_id: CLIENT_SESSION_ID,
      target_lang: state.settings.targetLang,
      echo_target_language: state.settings.echoTargetLanguage ? "true" : "false",
      voice: state.settings.voice || "auto",
    });
    return `${protocol}//${window.location.host}/ws/translate?${params.toString()}`;
  }

  function startSession() {
    if (!state.currentVideo) return;
    if (state.ws && state.ws.readyState <= WebSocket.OPEN && state.userWantsSession) return;
    state.userWantsSession = true;
    state.reconnectAttempts = 0;
    openWebSocket();
  }

  function restartSession(reason) {
    if (!state.currentVideo) return;
    state.userWantsSession = true;
    state.reconnectAttempts = 0;
    if (state.ws) {
      try {
        if (state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: "stop", reason: reason || "restart" }));
        }
        state.ws.onclose = null;
        state.ws.close();
      } catch (_) {}
      state.ws = null;
    }
    openWebSocket();
  }

  function openWebSocket() {
    if (!state.userWantsSession) return;
    if (state.ws) {
      try {
        state.ws.onclose = null;
        state.ws.close();
      } catch (_) {}
      state.ws = null;
    }

    setStatus("connecting", "세션 연결 중...");
    const ws = new WebSocket(buildWsUrl());
    ws.binaryType = "arraybuffer";
    state.ws = ws;

    ws.onopen = () => {
      state.reconnectAttempts = 0;
      if (!dom.video.paused && !dom.video.ended) state.isSending = true;
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        enqueueTargetAudio(event.data);
        return;
      }
      handleServerMessage(event.data);
    };

    ws.onclose = (event) => {
      state.sessionConnected = false;
      if (event && event.code === 4401) {
        stopSession(false, "auth_expired");
        showToast("로그인 세션이 만료되었습니다. 다시 로그인해 주세요.");
        setTimeout(() => window.location.replace("/login"), 800);
        return;
      }
      if (!state.userWantsSession) return;
      scheduleReconnect();
    };

    ws.onerror = () => {
      /* onclose follows */
    };
  }

  function scheduleReconnect() {
    if (!state.userWantsSession) return;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectAttempts += 1;
    if (state.reconnectAttempts > 8) {
      stopSession(false, "reconnect_exhausted");
      setStatus("error", "연결 끊김");
      showToast("네트워크 연결이 끊어져 번역 세션이 종료되었습니다. 비디오를 다시 선택해 주세요.");
      return;
    }
    const delay = Math.min(4000, 600 * Math.pow(1.5, state.reconnectAttempts - 1));
    setStatus("connecting", `연결 복구 중 (${state.reconnectAttempts})...`);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      openWebSocket();
    }, delay);
  }

  function stopSession(sendStop = true, reason = "stop") {
    state.userWantsSession = false;
    state.isSending = false;
    state.sessionConnected = false;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.ws) {
      try {
        if (sendStop && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: "stop", reason }));
        }
        state.ws.onclose = null;
        state.ws.close();
      } catch (_) {}
      state.ws = null;
    }
    if (reason !== "video_ended") setStatus("idle", "대기 중");
  }

  function pushConfigUpdate(label) {
    resetTranslationState(label);
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      try {
        state.ws.send(
          JSON.stringify({
            type: "update_config",
            target_lang: state.settings.targetLang,
            echo_target_language: state.settings.echoTargetLanguage,
            voice: state.settings.voice || "auto",
          })
        );
      } catch (_) {}
    } else if (state.userWantsSession) {
      openWebSocket();
    }
  }

  function handleServerMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }

    switch (msg.type) {
      case "status": {
        if (msg.status === "connected") {
          state.sessionConnected = true;
          setStatus("connected", dom.video.paused ? "준비됨" : "실시간 번역 중");
        } else {
          setStatus("connecting", "세션 연결 중...");
        }
        break;
      }
      case "input_transcription": {
        if (msg.language_code) updateDetectedLanguage(msg.language_code);
        if (msg.text) updateSourceSubtitle(msg.text, Boolean(msg.finished), Boolean(msg.interim));
        if (!dom.video.paused) setStatus("connected", "실시간 번역 중");
        break;
      }
      case "output_transcription": {
        if (msg.text) updateTargetSubtitle(msg.text, Boolean(msg.finished));
        break;
      }
      case "turn_complete": {
        if (msg.turn_complete) finalizeTargetSubtitle();
        break;
      }
      case "go_away": {
        showToast("세션 수명 만료 알림 — 자동으로 연장합니다.");
        break;
      }
      case "inactive_timeout": {
        stopSession(false, "inactive_timeout");
        showToast(msg.message || "장시간 입력이 없어 세션이 종료되었습니다.");
        break;
      }
      case "session_closed": {
        // Server acknowledged our explicit stop/restart; nothing else to do
        break;
      }
      case "config_updated":
        break;
      case "error": {
        setStatus("error", "연결 오류");
        showToast(msg.message || "오류가 발생했습니다.");
        break;
      }
      default:
        break;
    }
  }

  function updateDetectedLanguage(code) {
    dom.detectedLang.classList.add("is-detected");
    dom.detectedLangText.textContent = formatLanguageLabel(code);
  }

  // =========================================================================
  // Subtitles (max 2 lines overlay)
  // =========================================================================

  function updateSourceSubtitle(text, finished, interim) {
    if (interim) {
      state.sourceActive = text;
    } else {
      state.sourceActive = finished ? text : (state.sourceActive.endsWith(text) ? state.sourceActive : state.sourceActive + text);
      if (/[.?!。？！]\s*$/.test(state.sourceActive)) {
        // keep the finished sentence until target catches up; next chunk starts fresh
        const done = state.sourceActive;
        state.sourceActive = "";
        state.sourceLastSentence = done;
      }
    }
    renderSubtitles();
  }

  function updateTargetSubtitle(chunk, finished) {
    let active = state.activeTarget;
    if (!active) {
      active = { text: "", timer: null };
      state.activeTarget = active;
    }
    active.text += chunk;
    if (active.timer) clearTimeout(active.timer);

    const endsSentence = /[.?!。？！]\s*$/.test(active.text);
    if (finished || endsSentence) {
      finalizeTargetSubtitle();
    } else {
      active.timer = setTimeout(finalizeTargetSubtitle, SUBTITLE_FINALIZE_MS);
    }
    renderSubtitles();
  }

  function finalizeTargetSubtitle() {
    const active = state.activeTarget;
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    const text = active.text.trim();
    state.activeTarget = null;
    if (text) {
      state.targetLines.push(text);
      if (state.targetLines.length > 4) state.targetLines.splice(0, state.targetLines.length - 4);
    }
    renderSubtitles();
  }

  function clearSubtitles() {
    if (state.activeTarget?.timer) clearTimeout(state.activeTarget.timer);
    state.activeTarget = null;
    state.targetLines = [];
    state.sourceActive = "";
    state.sourceLastSentence = "";
    if (state.subtitleHideTimer) clearTimeout(state.subtitleHideTimer);
    dom.subtitleTarget.textContent = "";
    dom.subtitleSource.textContent = "";
    dom.subtitleOverlay.classList.remove("is-visible");
  }

  function renderSubtitles() {
    const overlay = dom.subtitleOverlay;
    const targetEl = dom.subtitleTarget;
    const sourceEl = dom.subtitleSource;

    // Candidate lines: last committed + active (active sentence is highlighted)
    const activeText = state.activeTarget ? state.activeTarget.text.trim() : "";
    const committed = state.targetLines.slice(activeText ? -1 : -2);
    const lines = [...committed];
    if (activeText) lines.push(activeText);

    targetEl.innerHTML = "";
    lines.forEach((t, i) => {
      const span = document.createElement("span");
      span.className = "sub-line" + (activeText && i === lines.length - 1 ? " is-active" : "");
      span.textContent = t;
      targetEl.appendChild(span);
    });

    // Enforce max 2 visual lines: drop the oldest line, then trim the head of a long sentence
    const maxHeight = getSubtitleMaxHeight(targetEl);
    let guard = 0;
    while (targetEl.scrollHeight > maxHeight + 2 && targetEl.children.length > 1 && guard++ < 4) {
      targetEl.removeChild(targetEl.firstElementChild);
    }
    guard = 0;
    while (targetEl.scrollHeight > maxHeight + 2 && targetEl.children.length === 1 && guard++ < 60) {
      const only = targetEl.firstElementChild;
      const words = only.textContent.replace(/^…\s*/, "").split(/\s+/);
      if (words.length <= 2) {
        // CJK text without spaces: trim characters
        const chars = only.textContent.replace(/^…/, "");
        if (chars.length <= 4) break;
        only.textContent = "…" + chars.slice(Math.ceil(chars.length * 0.15));
      } else {
        only.textContent = "… " + words.slice(Math.max(1, Math.ceil(words.length * 0.15))).join(" ");
      }
    }

    // Source line (optional)
    if (state.settings.showSource) {
      const src = state.sourceActive || state.sourceLastSentence || "";
      sourceEl.textContent = src;
      sourceEl.hidden = !src;
    } else {
      sourceEl.hidden = true;
    }

    const hasContent = targetEl.children.length > 0 || (!sourceEl.hidden && sourceEl.textContent);
    overlay.classList.toggle("is-visible", Boolean(hasContent));

    if (state.subtitleHideTimer) clearTimeout(state.subtitleHideTimer);
    if (hasContent) {
      state.subtitleHideTimer = setTimeout(() => {
        overlay.classList.remove("is-visible");
      }, SUBTITLE_IDLE_HIDE_MS);
    }
  }

  function getSubtitleMaxHeight(el) {
    const cs = getComputedStyle(el);
    let lh = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lh)) lh = parseFloat(cs.fontSize) * 1.35;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    return lh * 2 + pad;
  }

  // =========================================================================
  // Read-only debug hook (DevTools): window.__lvt.debug()
  window.__lvt = {
    debug: () => ({
      ctxState: state.audioCtx?.state,
      sampleRate: state.audioCtx?.sampleRate,
      wsState: state.ws?.readyState,
      isSending: state.isSending,
      sessionConnected: state.sessionConnected,
      scheduled: state.scheduledSources.size,
      queuedSeconds: state.audioCtx ? Math.max(0, state.nextPlayTime - state.audioCtx.currentTime) : 0,
      sourceGain: state.sourceGain?.gain.value,
      targetGain: state.targetGain?.gain.value,
      targetLines: state.targetLines.length,
      playoutDelay: state.playoutDelay,
      holding: state.holding,
      feederTime: state.feeder ? state.feeder.currentTime : null,
      videoTime: dom.video.currentTime,
      lead: state.feeder ? state.feeder.currentTime - dom.video.currentTime : null,
      rxChunks: state.rxChunks,
      rxBytes: state.rxBytes,
      rxLastPeak: state.rxLastPeak,
      rxLoudChunks: state.rxLoudChunks,
      settings: { ...state.settings },
    }),
  };

  document.addEventListener("DOMContentLoaded", init);
})();
