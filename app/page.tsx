"use client";

import { ChevronLeft, ChevronRight, Download, FolderOpen, Moon, Pause, Play, RotateCcw, Save, Sun, Upload, X } from "lucide-react";
import { ChangeEvent, PointerEvent, useCallback, useEffect, useRef, useState } from "react";

type Theme = "light" | "dark";

const TRACK_COUNT = 16;
const LOOP_BEATS = 32;
const SONG_STORAGE_KEY = "synthcave-songs";
const SONG_SCHEMA_VERSION = 1;
const COLORS = ["#9ed3f7", "#a9efb8", "#ffe999", "#ffc2c2", "#b8dcfb", "#f7d7e5"];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const TRACK_NOTES = [
  { pitch: 0, octave: 5 },
  { pitch: 11, octave: 4 },
  { pitch: 9, octave: 4 },
  { pitch: 7, octave: 4 },
  { pitch: 5, octave: 4 },
  { pitch: 4, octave: 4 },
  { pitch: 2, octave: 4 },
  { pitch: 0, octave: 4 },
  { pitch: 11, octave: 3 },
  { pitch: 9, octave: 3 },
  { pitch: 7, octave: 3 },
  { pitch: 5, octave: 3 },
  { pitch: 4, octave: 3 },
  { pitch: 2, octave: 3 },
  { pitch: 0, octave: 3 },
  { pitch: 0, octave: 2 }
];

type Clip = {
  id: string;
  trackId: number;
  start: number;
  duration: number;
  color: string;
  pitch: number;
  octave: number;
  curve: number[];
};

type Track = {
  id: number;
  clips: Clip[];
};

type SavedSong = {
  schemaVersion: typeof SONG_SCHEMA_VERSION;
  id: string;
  name: string;
  savedAt: string;
  bpm: number;
  reverse: boolean;
  effects: {
    reverb: number;
    delay: number;
    chorus: number;
  };
  tracks: Track[];
};

type SongModal = "save" | "load" | null;

type AudioChain = {
  context: AudioContext;
  master: GainNode;
  delay: DelayNode;
  delayFeedback: GainNode;
  chorus: DelayNode;
  chorusLfoGain: GainNode;
  reverbWet: GainNode;
  chorusWet: GainNode;
};

type Voice = {
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  vibrato: OscillatorNode;
  vibratoGain: GainNode;
  gain: GainNode;
  filter: BiquadFilterNode;
};

type DragState =
  | { type: "curve"; clipId: string }
  | { type: "create"; clipId: string; anchor: number }
  | {
      type: "move";
      anchorBeat: number;
      anchorTrackId: number;
      clips: Array<{
        id: string;
        start: number;
        trackId: number;
      }>;
    }
  | { type: "resize-left"; clipId: string; end: number }
  | { type: "resize-right"; clipId: string; start: number }
  | { type: "scrub" }
  | null;

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

function createCurve(seed: number) {
  return Array.from({ length: 9 }, (_, index) => Math.sin(seed + index * 0.9) * 0.22);
}

function flatCurve() {
  return Array.from({ length: 9 }, () => 0);
}

function createInitialTracks(): Track[] {
  const clips: Clip[] = [
    { id: "a", trackId: 8, start: 4.2, duration: 8.8, color: COLORS[0], ...TRACK_NOTES[7], curve: createCurve(0.5) },
    { id: "b", trackId: 11, start: 12.4, duration: 5.7, color: COLORS[1], ...TRACK_NOTES[10], curve: createCurve(1.2).map(() => 0) },
    { id: "c", trackId: 6, start: 12.4, duration: 5.7, color: COLORS[2], ...TRACK_NOTES[5], curve: createCurve(2.4).map((value, index) => (index < 3 ? value - 0.1 : value * 0.25)) },
    { id: "d", trackId: 16, start: 12.3, duration: 5.7, color: COLORS[3], ...TRACK_NOTES[15], curve: createCurve(3.2).map(() => -0.04) },
    { id: "e", trackId: 14, start: 16.9, duration: 5.8, color: COLORS[0], ...TRACK_NOTES[13], curve: createCurve(4.1).map(() => 0.08) },
    { id: "f", trackId: 10, start: 22.1, duration: 5.7, color: COLORS[3], ...TRACK_NOTES[9], curve: createCurve(5.6).map((value) => value * 1.25) }
  ];

  return Array.from({ length: TRACK_COUNT }, (_, index) => ({
    id: index + 1,
    clips: clips.filter((clip) => clip.trackId === index + 1)
  }));
}

function allClips(tracks: Track[]) {
  return tracks.flatMap((track) => track.clips);
}

function tracksFromClips(clips: Clip[]) {
  return Array.from({ length: TRACK_COUNT }, (_, index) => {
    const trackId = index + 1;
    return {
      id: trackId,
      clips: clips.filter((clip) => clip.trackId === trackId)
    };
  });
}

function noteForTrack(trackId: number) {
  return TRACK_NOTES[trackId - 1];
}

function clampTrackId(trackId: number) {
  return Math.max(1, Math.min(TRACK_COUNT, trackId));
}

function controlCurve(value: number) {
  return Math.max(0, Math.min(1, value / 100)) ** 1.55;
}

function createSongId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `song-${Date.now()}-${Math.round(Math.random() * 10000)}`;
}

function createSongFileName(name: string) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "synthcave-song";
  return `${slug}.synthcave.json`;
}

function cloneTracks(tracks: Track[]) {
  return tracks.map((track) => ({
    id: track.id,
    clips: track.clips.map((clip) => ({
      ...clip,
      curve: [...clip.curve]
    }))
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isClip(value: unknown): value is Clip {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.trackId === "number" &&
    typeof value.start === "number" &&
    typeof value.duration === "number" &&
    typeof value.color === "string" &&
    typeof value.pitch === "number" &&
    typeof value.octave === "number" &&
    Array.isArray(value.curve) &&
    value.curve.every((point) => typeof point === "number")
  );
}

function isTrack(value: unknown): value is Track {
  return isRecord(value) && typeof value.id === "number" && Array.isArray(value.clips) && value.clips.every(isClip);
}

function isSavedSong(value: unknown): value is SavedSong {
  if (!isRecord(value) || value.schemaVersion !== SONG_SCHEMA_VERSION) return false;
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.savedAt !== "string") return false;
  if (typeof value.bpm !== "number" || typeof value.reverse !== "boolean") return false;
  if (!isRecord(value.effects)) return false;
  if (
    typeof value.effects.reverb !== "number" ||
    typeof value.effects.delay !== "number" ||
    typeof value.effects.chorus !== "number"
  ) {
    return false;
  }
  return Array.isArray(value.tracks) && value.tracks.length === TRACK_COUNT && value.tracks.every(isTrack);
}

function readSavedSongs() {
  try {
    const raw = localStorage.getItem(SONG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSavedSong) : [];
  } catch (_) {
    return [];
  }
}

function writeSavedSongs(songs: SavedSong[]) {
  localStorage.setItem(SONG_STORAGE_KEY, JSON.stringify(songs));
}

function makeImpulse(context: AudioContext, seconds: number) {
  const length = Math.floor(context.sampleRate * seconds);
  const impulse = context.createBuffer(2, length, context.sampleRate);

  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      const decay = 1 - i / length;
      data[i] = (Math.random() * 2 - 1) * decay * decay;
    }
  }

  return impulse;
}

function createAudioChain(): AudioChain {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextClass();
  const master = context.createGain();
  const delay = context.createDelay(1);
  const delayFeedback = context.createGain();
  const reverb = context.createConvolver();
  const reverbWet = context.createGain();
  const chorus = context.createDelay(0.05);
  const chorusWet = context.createGain();
  const chorusLfo = context.createOscillator();
  const chorusLfoGain = context.createGain();

  master.gain.value = 0.7;
  delay.delayTime.value = 0.12;
  delayFeedback.gain.value = 0.08;
  reverb.buffer = makeImpulse(context, 2.7);
  reverbWet.gain.value = 0.12;
  chorus.delayTime.value = 0.014;
  chorusWet.gain.value = 0.08;
  chorusLfo.frequency.value = 0.7;
  chorusLfoGain.gain.value = 0.003;

  chorusLfo.connect(chorusLfoGain);
  chorusLfoGain.connect(chorus.delayTime);
  chorusLfo.start();
  master.connect(context.destination);
  master.connect(delay);
  delay.connect(delayFeedback);
  delayFeedback.connect(delay);
  delay.connect(context.destination);
  master.connect(reverb);
  reverb.connect(reverbWet);
  reverbWet.connect(context.destination);
  master.connect(chorus);
  chorus.connect(chorusWet);
  chorusWet.connect(context.destination);

  return { context, master, delay, delayFeedback, chorus, chorusLfoGain, reverbWet, chorusWet };
}

function midiFrequency(pitch: number, octave: number) {
  const midi = (octave + 1) * 12 + pitch;
  return 440 * 2 ** ((midi - 69) / 12);
}

function noteName(pitch: number, octave: number) {
  return `${NOTE_NAMES[pitch]}${octave}`;
}

function formatFrequency(pitch: number, octave: number) {
  const frequency = midiFrequency(pitch, octave);
  return frequency >= 100 ? `${frequency.toFixed(1)} Hz` : `${frequency.toFixed(2)} Hz`;
}

function wrap(value: number) {
  return ((value % LOOP_BEATS) + LOOP_BEATS) % LOOP_BEATS;
}

function signedOffset(value: number) {
  const wrapped = wrap(value);
  return wrapped > LOOP_BEATS / 2 ? wrapped - LOOP_BEATS : wrapped;
}

function clipContains(clip: Clip, position: number) {
  const offset = wrap(position - clip.start);
  return offset >= 0 && offset <= clip.duration;
}

function clipProgress(clip: Clip, position: number) {
  return Math.max(0, Math.min(1, wrap(position - clip.start) / clip.duration));
}

function curveAt(curve: number[], progress: number) {
  const scaled = progress * (curve.length - 1);
  const left = Math.floor(scaled);
  const right = Math.min(curve.length - 1, left + 1);
  const amount = scaled - left;
  return curve[left] * (1 - amount) + curve[right] * amount;
}

function smoothPath(curve: number[]) {
  const points = curve.map((value, index) => ({
    x: (index / (curve.length - 1)) * 100,
    y: 50 - value * 38
  }));

  return points.reduce((path, point, index) => {
    if (index === 0) return `M ${point.x} ${point.y}`;
    const previous = points[index - 1];
    const cp1x = previous.x + (point.x - previous.x) * 0.45;
    const cp2x = point.x - (point.x - previous.x) * 0.45;
    return `${path} C ${cp1x} ${previous.y}, ${cp2x} ${point.y}, ${point.x} ${point.y}`;
  }, "");
}

export default function Home() {
  const [tracks, setTracks] = useState<Track[]>(createInitialTracks);
  const [isPlaying, setIsPlaying] = useState(false);
  const [reverse, setReverse] = useState(false);
  const [bpm, setBpm] = useState(96);
  const [playhead, setPlayhead] = useState(0);
  const [effects, setEffects] = useState({ reverb: 24, delay: 18, chorus: 16 });
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [dragState, setDragState] = useState<DragState>(null);
  const [theme, setTheme] = useState<Theme>("light");
  const [songModal, setSongModal] = useState<SongModal>(null);
  const [songName, setSongName] = useState("");
  const [savedSongs, setSavedSongs] = useState<SavedSong[]>([]);
  const [songMessage, setSongMessage] = useState("");

  useEffect(() => {
    const initial = (document.documentElement.dataset.theme as Theme) || "light";
    setTheme(initial);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("synthcave-theme", theme);
    } catch (_) {
      // ignore storage errors
    }
  }, [theme]);

  const toggleTheme = () => setTheme((value) => (value === "light" ? "dark" : "light"));

  const openSaveSong = () => {
    setSongName("");
    setSongMessage("");
    setSongModal("save");
  };

  const openLoadSong = () => {
    setSavedSongs(readSavedSongs());
    setSongMessage("");
    setSongModal("load");
  };

  const closeSongModal = () => {
    setSongModal(null);
    setSongMessage("");
  };

  const audioRef = useRef<AudioChain | null>(null);
  const voicesRef = useRef<Map<number, Voice>>(new Map());
  const tracksRef = useRef(tracks);
  const frameRef = useRef<number | null>(null);
  const keyScrollFrameRef = useRef<number | null>(null);
  const keyScrollDirectionRef = useRef(0);
  const keyScrollLastTimeRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const playheadRef = useRef(playhead);
  const isPlayingRef = useRef(isPlaying);
  const reverseRef = useRef(reverse);
  const bpmRef = useRef(bpm);
  const selectedClipIdsRef = useRef<string[]>(selectedClipIds);

  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    selectedClipIdsRef.current = selectedClipIds;
  }, [selectedClipIds]);

  useEffect(() => {
    reverseRef.current = reverse;
  }, [reverse]);

  useEffect(() => {
    bpmRef.current = bpm;
  }, [bpm]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const reverbAmount = controlCurve(effects.reverb);
    const delayAmount = controlCurve(effects.delay);
    const chorusAmount = controlCurve(effects.chorus);
    const now = audio.context.currentTime;
    audio.reverbWet.gain.setTargetAtTime(reverbAmount * 1.45, now, 0.02);
    audio.delayFeedback.gain.setTargetAtTime(delayAmount * 0.86, now, 0.02);
    audio.delay.delayTime.setTargetAtTime(0.045 + delayAmount * 0.48, now, 0.02);
    audio.chorusWet.gain.setTargetAtTime(chorusAmount * 1.15, now, 0.02);
    audio.chorus.delayTime.setTargetAtTime(0.006 + chorusAmount * 0.028, now, 0.02);
    audio.chorusLfoGain.gain.setTargetAtTime(0.002 + chorusAmount * 0.018, now, 0.02);
  }, [effects]);

  const ensureAudio = useCallback(async () => {
    if (!audioRef.current) {
      audioRef.current = createAudioChain();
    }
    if (audioRef.current.context.state === "suspended") {
      await audioRef.current.context.resume();
    }
  }, []);

  const getVoice = useCallback((trackId: number) => {
    const existing = voicesRef.current.get(trackId);
    if (existing) return existing;
    const audio = audioRef.current;
    if (!audio) return null;
    const oscA = audio.context.createOscillator();
    const oscB = audio.context.createOscillator();
    const vibrato = audio.context.createOscillator();
    const vibratoGain = audio.context.createGain();
    const filter = audio.context.createBiquadFilter();
    const gain = audio.context.createGain();

    oscA.type = "sawtooth";
    oscB.type = "square";
    oscB.detune.value = trackId % 2 === 0 ? 8 : -8;
    vibrato.frequency.value = 5.2;
    vibratoGain.gain.value = 0;
    filter.type = "lowpass";
    filter.frequency.value = 2200;
    filter.Q.value = 7;
    gain.gain.value = 0;
    vibrato.connect(vibratoGain);
    vibratoGain.connect(oscA.frequency);
    vibratoGain.connect(oscB.frequency);
    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);
    gain.connect(audio.master);
    oscA.start();
    oscB.start();
    vibrato.start();

    const voice = { oscA, oscB, vibrato, vibratoGain, filter, gain };
    voicesRef.current.set(trackId, voice);
    return voice;
  }, []);

  const updateAudio = useCallback((position: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const now = audio.context.currentTime;

    tracksRef.current.forEach((track) => {
      const activeClip = track.clips.find((clip) => clipContains(clip, position));
      const voice = getVoice(track.id);
      if (!voice) return;

      if (!activeClip) {
        voice.gain.gain.setTargetAtTime(0, now, 0.06);
        voice.vibratoGain.gain.setTargetAtTime(0, now, 0.04);
        return;
      }

      const progress = clipProgress(activeClip, position);
      const bend = curveAt(activeClip.curve, progress) * 12;
      const frequency = midiFrequency(activeClip.pitch, activeClip.octave) * 2 ** (bend / 12);
      voice.oscA.frequency.setTargetAtTime(frequency, now, 0.018);
      voice.oscB.frequency.setTargetAtTime(frequency, now, 0.018);
      voice.gain.gain.setTargetAtTime(0.2, now, 0.035);
      voice.filter.frequency.setTargetAtTime(1300 + Math.max(0, bend) * 80 + activeClip.trackId * 58, now, 0.035);
      voice.vibratoGain.gain.setTargetAtTime(2.5, now, 0.04);
    });
  }, [getVoice]);

  const silenceVoices = useCallback((release = 0.035) => {
    const audio = audioRef.current;
    if (!audio) return;
    const now = audio.context.currentTime;
    voicesRef.current.forEach((voice) => {
      voice.gain.gain.setTargetAtTime(0, now, release);
      voice.vibratoGain.gain.setTargetAtTime(0, now, release);
    });
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      lastFrameRef.current = null;
      silenceVoices(0.05);
      return;
    }

    const run = (time: number) => {
      const lastTime = lastFrameRef.current ?? time;
      const delta = (time - lastTime) / 1000;
      lastFrameRef.current = time;
      const direction = reverseRef.current ? -1 : 1;
      const beatsPerSecond = bpmRef.current / 60;
      const next = wrap(playheadRef.current + direction * delta * beatsPerSecond);
      playheadRef.current = next;
      setPlayhead(next);
      updateAudio(next);
      frameRef.current = window.requestAnimationFrame(run);
    };

    frameRef.current = window.requestAnimationFrame(run);
    return () => {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [isPlaying, silenceVoices, updateAudio]);

  useEffect(() => {
    return () => {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
      voicesRef.current.forEach((voice) => {
        voice.oscA.stop();
        voice.oscB.stop();
        voice.vibrato.stop();
      });
      audioRef.current?.context.close();
    };
  }, []);

  const togglePlay = async () => {
    await ensureAudio();
    setIsPlaying((value) => !value);
  };

  const scrollWithKey = useCallback((time: number) => {
    const lastTime = keyScrollLastTimeRef.current ?? time;
    const delta = (time - lastTime) / 1000;
    keyScrollLastTimeRef.current = time;
    const speed = Math.max(4, bpmRef.current / 14);
    const next = wrap(playheadRef.current + keyScrollDirectionRef.current * delta * speed);
    playheadRef.current = next;
    setPlayhead(next);
    updateAudio(next);
    keyScrollFrameRef.current = window.requestAnimationFrame(scrollWithKey);
  }, [updateAudio]);

  const stopKeyScroll = useCallback(() => {
    if (keyScrollFrameRef.current) window.cancelAnimationFrame(keyScrollFrameRef.current);
    keyScrollFrameRef.current = null;
    keyScrollLastTimeRef.current = null;
    keyScrollDirectionRef.current = 0;
    if (!isPlayingRef.current) silenceVoices();
  }, [silenceVoices]);

  const finishDrag = useCallback(() => {
    const wasManualScrub = dragState?.type === "scrub";
    setDragState(null);
    if (wasManualScrub && !isPlayingRef.current) silenceVoices();
  }, [dragState, silenceVoices]);

  const clipLeft = (clip: Clip) => {
    const relative = clip.start - playhead;
    return 50 + (relative / LOOP_BEATS) * 100;
  };

  const clipCopies = (clip: Clip) => {
    const width = (clip.duration / LOOP_BEATS) * 100;

    return [-1, 0, 1].flatMap((loopOffset) => {
      const left = clipLeft({ ...clip, start: clip.start + loopOffset * LOOP_BEATS });
      if (left + width < -4 || left > 104) return [];
      return [{ loopOffset, left, width }];
    });
  };

  const beatFromPointer = (event: PointerEvent<HTMLElement>) => {
    const trackRow = event.currentTarget.closest(".track-row");
    const rect = (trackRow ?? event.currentTarget).getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    return wrap(playheadRef.current + (x - 0.5) * LOOP_BEATS);
  };

  const trackIdFromPointer = (event: PointerEvent<HTMLElement>) => {
    const tracksElement = event.currentTarget.closest("main")?.querySelector(".tracks");
    if (!tracksElement) return 1;
    const rect = tracksElement.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height - 1, event.clientY - rect.top));
    return clampTrackId(Math.floor((y / rect.height) * TRACK_COUNT) + 1);
  };

  const scrubBeatFromPointer = (event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    return x * LOOP_BEATS;
  };

  const setClipPatch = (clipId: string, patch: Partial<Clip>) => {
    setTracks((current) =>
      current.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip))
      }))
    );
  };

  const moveClips = (moveState: Extract<NonNullable<DragState>, { type: "move" }>, beat: number, trackId: number) => {
    const beatDelta = signedOffset(beat - moveState.anchorBeat);
    const trackDelta = trackId - moveState.anchorTrackId;
    const movingById = new Map(moveState.clips.map((clip) => [clip.id, clip]));

    setTracks((current) => {
      const movedClips = allClips(current).map((clip) => {
        const origin = movingById.get(clip.id);
        if (!origin) return clip;
        const nextTrackId = clampTrackId(origin.trackId + trackDelta);
        return {
          ...clip,
          ...noteForTrack(nextTrackId),
          trackId: nextTrackId,
          start: wrap(origin.start + beatDelta)
        };
      });

      return tracksFromClips(movedClips);
    });
  };

  const deleteSelectedClips = () => {
    const selectedClipIds = selectedClipIdsRef.current;
    if (selectedClipIds.length === 0) return;
    const selected = new Set(selectedClipIds);
    setTracks((current) =>
      current.map((track) => ({
        ...track,
        clips: track.clips.filter((clip) => !selected.has(clip.id))
      }))
    );
    setSelectedClipIds([]);
  };

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return target.matches("input, textarea, select") || target.isContentEditable;
    };

    const handleWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;

      if (event.code === "Space") {
        event.preventDefault();
        void togglePlay();
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        deleteSelectedClips();
        return;
      }

      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      keyScrollDirectionRef.current = event.key === "ArrowLeft" ? -1 : 1;
      if (!keyScrollFrameRef.current) {
        keyScrollLastTimeRef.current = null;
        keyScrollFrameRef.current = window.requestAnimationFrame(scrollWithKey);
      }
    };

    const handleWindowKeyUp = (event: globalThis.KeyboardEvent) => {
      if (
        (event.key === "ArrowLeft" && keyScrollDirectionRef.current === -1) ||
        (event.key === "ArrowRight" && keyScrollDirectionRef.current === 1)
      ) {
        event.preventDefault();
        stopKeyScroll();
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    window.addEventListener("keyup", handleWindowKeyUp);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
      window.removeEventListener("keyup", handleWindowKeyUp);
      stopKeyScroll();
    };
  }, [scrollWithKey, stopKeyScroll]);

  const updateClipCurve = (clipId: string, event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const index = Math.round(x * 8);
    const value = Math.max(-1, Math.min(1, (0.5 - y) * 2));

    setTracks((current) =>
      current.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip;
          const curve = [...clip.curve];
          curve[index] = value;
          if (index > 0) curve[index - 1] = curve[index - 1] * 0.65 + value * 0.35;
          if (index < curve.length - 1) curve[index + 1] = curve[index + 1] * 0.65 + value * 0.35;
          return { ...clip, curve };
        })
      }))
    );
  };

  const updateDrag = (event: PointerEvent<HTMLElement>) => {
    if (!dragState) return;

    if (dragState.type === "scrub") {
      const beat = scrubBeatFromPointer(event);
      playheadRef.current = beat;
      setPlayhead(beat);
      updateAudio(beat);
      return;
    }

    const beat = beatFromPointer(event);

    if (dragState.type === "move") {
      moveClips(dragState, beat, trackIdFromPointer(event));
      return;
    }

    if (dragState.type === "create") {
      const start = Math.min(dragState.anchor, beat);
      const duration = Math.max(0.5, Math.abs(beat - dragState.anchor));
      setClipPatch(dragState.clipId, { start, duration });
      return;
    }

    if (dragState.type === "resize-left") {
      const start = Math.min(beat, dragState.end - 0.5);
      setClipPatch(dragState.clipId, { start, duration: Math.max(0.5, dragState.end - start) });
      return;
    }

    if (dragState.type === "resize-right") {
      const duration = Math.max(0.5, beat - dragState.start);
      setClipPatch(dragState.clipId, { duration: Math.min(duration, LOOP_BEATS - dragState.start) });
    }
  };

  const createClip = (track: Track, event: PointerEvent<HTMLElement>) => {
    const start = beatFromPointer(event);
    const note = noteForTrack(track.id);
    const id = `clip-${Date.now()}-${Math.round(Math.random() * 10000)}`;
    const clip: Clip = {
      id,
      trackId: track.id,
      start,
      duration: 0.5,
      color: COLORS[(track.id + track.clips.length) % COLORS.length],
      ...note,
      curve: flatCurve()
    };
    setSelectedClipIds([id]);
    setDragState({ type: "create", clipId: id, anchor: start });
    setTracks((current) =>
      current.map((currentTrack) =>
        currentTrack.id === track.id ? { ...currentTrack, clips: [...currentTrack.clips, clip] } : currentTrack
      )
    );
  };

  const createCurrentSong = (name: string, existingId?: string): SavedSong => ({
    schemaVersion: SONG_SCHEMA_VERSION,
    id: existingId ?? createSongId(),
    name: name.trim() || "Untitled Song",
    savedAt: new Date().toISOString(),
    bpm,
    reverse,
    effects,
    tracks: cloneTracks(tracks)
  });

  const saveSongToLocalStorage = () => {
    const name = songName.trim();
    if (!name) {
      setSongMessage("Name the song first.");
      return;
    }

    try {
      const currentSongs = readSavedSongs();
      const existing = currentSongs.find((song) => song.name.toLowerCase() === name.toLowerCase());
      const nextSong = createCurrentSong(name, existing?.id);
      const nextSongs = existing
        ? currentSongs.map((song) => (song.id === existing.id ? nextSong : song))
        : [nextSong, ...currentSongs];
      writeSavedSongs(nextSongs);
      setSavedSongs(nextSongs);
      setSongMessage("Saved locally.");
    } catch (_) {
      setSongMessage("Could not save this song locally.");
    }
  };

  const downloadSongFile = () => {
    const name = songName.trim();
    if (!name) {
      setSongMessage("Name the song first.");
      return;
    }

    const song = createCurrentSong(name);
    const blob = new Blob([JSON.stringify(song, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = createSongFileName(song.name);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setSongMessage("Downloaded JSON file.");
  };

  const loadSong = (song: SavedSong) => {
    const nextTracks = cloneTracks(song.tracks);
    setTracks(nextTracks);
    tracksRef.current = nextTracks;
    setBpm(song.bpm);
    bpmRef.current = song.bpm;
    setReverse(song.reverse);
    reverseRef.current = song.reverse;
    setEffects(song.effects);
    setSelectedClipIds([]);
    setPlayhead(0);
    playheadRef.current = 0;
    setSongModal(null);
    setSongMessage("");
  };

  const deleteSavedSong = (songId: string) => {
    const nextSongs = savedSongs.filter((song) => song.id !== songId);
    writeSavedSongs(nextSongs);
    setSavedSongs(nextSongs);
  };

  const uploadSongFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const parsed = JSON.parse(await file.text());
      if (!isSavedSong(parsed)) {
        setSongMessage("That file is not a valid Synthcave song.");
        return;
      }
      loadSong(parsed);
    } catch (_) {
      setSongMessage("Could not read that song file.");
    }
  };

  return (
    <main
      className="synth-shell"
      tabIndex={0}
      onPointerUp={finishDrag}
      onPointerLeave={finishDrag}
    >
      <section className="workspace" aria-label="Synth sequencer">
        <div className="center-line" aria-hidden="true" />
        <div className="tracks">
          {tracks.map((track) => (
            <section
              key={track.id}
              className="track-row"
              aria-label={`Track ${track.id}, ${noteName(TRACK_NOTES[track.id - 1].pitch, TRACK_NOTES[track.id - 1].octave)}, ${formatFrequency(TRACK_NOTES[track.id - 1].pitch, TRACK_NOTES[track.id - 1].octave)}`}
              onPointerDown={(event) => {
                if (event.target instanceof Element && event.target.closest(".clip")) return;
                event.currentTarget.closest("main")?.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                createClip(track, event);
              }}
              onPointerMove={(event) => {
                if (event.buttons === 1) updateDrag(event);
              }}
            >
              <div className="track-line" />
              {track.clips.flatMap((clip) =>
                clipCopies(clip).map((copy) => (
                  <div
                  key={`${clip.id}-${copy.loopOffset}`}
                  className={selectedClipIds.includes(clip.id) ? "clip selected" : "clip"}
                  style={{
                    "--clip": clip.color,
                    left: `${copy.left}%`,
                    width: `${copy.width}%`
                  } as React.CSSProperties}
                  aria-label={`${noteName(clip.pitch, clip.octave)} clip, ${formatFrequency(clip.pitch, clip.octave)}`}
                  aria-selected={selectedClipIds.includes(clip.id)}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.currentTarget.closest("main")?.focus();
                    event.currentTarget.setPointerCapture(event.pointerId);

                    if (event.shiftKey) {
                      setSelectedClipIds((current) =>
                        current.includes(clip.id)
                          ? current.filter((selectedClipId) => selectedClipId !== clip.id)
                          : [...current, clip.id]
                      );
                      setDragState(null);
                      return;
                    }

                    if (event.metaKey) {
                      const draggedClipIds = selectedClipIdsRef.current.includes(clip.id) ? selectedClipIdsRef.current : [clip.id];
                      const draggedClipIdSet = new Set(draggedClipIds);
                      const movingClips = allClips(tracksRef.current)
                        .filter((currentClip) => draggedClipIdSet.has(currentClip.id))
                        .map((currentClip) => ({
                          id: currentClip.id,
                          start: currentClip.start,
                          trackId: currentClip.trackId
                        }));

                      setSelectedClipIds(draggedClipIds);
                      setDragState({
                        type: "move",
                        anchorBeat: beatFromPointer(event),
                        anchorTrackId: trackIdFromPointer(event),
                        clips: movingClips
                      });
                      return;
                    }

                    setSelectedClipIds([clip.id]);
                    const rect = event.currentTarget.getBoundingClientRect();
                    const edgeSize = Math.min(18, rect.width * 0.22);
                    const x = event.clientX - rect.left;

                    if (x <= edgeSize) {
                      setDragState({ type: "resize-left", clipId: clip.id, end: clip.start + clip.duration });
                      return;
                    }

                    if (x >= rect.width - edgeSize) {
                      setDragState({ type: "resize-right", clipId: clip.id, start: clip.start });
                      return;
                    }

                    setDragState({ type: "curve", clipId: clip.id });
                    updateClipCurve(clip.id, event);
                  }}
                  onPointerMove={(event) => {
                    if (event.buttons !== 1) return;
                    if (dragState?.type === "curve" && dragState.clipId === clip.id) {
                      updateClipCurve(clip.id, event);
                      return;
                    }
                    updateDrag(event);
                  }}
                >
                  <span className="resize-handle left" aria-hidden="true" />
                  <span className="resize-handle right" aria-hidden="true" />
                  <svg className="curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                    <path d={smoothPath(clip.curve)} />
                  </svg>
                </div>
                ))
              )}
            </section>
          ))}
        </div>
      </section>

      <footer className="playbar">
        <div className="song-actions">
          <button className="save-button" type="button" onClick={openSaveSong}>
            <Save size={15} />
            Save Song
          </button>
          <button className="save-button" type="button" onClick={openLoadSong}>
            <FolderOpen size={15} />
            Load Song
          </button>
        </div>
        <div className="transport">
          <button className="icon-button" aria-label="Step backward" onClick={() => setPlayhead((value) => wrap(value - 1))}>
            <ChevronLeft size={20} />
          </button>
          <button className="play-button" aria-label={isPlaying ? "Pause" : "Play"} onClick={togglePlay}>
            {isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
          </button>
          <button className="icon-button" aria-label="Step forward" onClick={() => setPlayhead((value) => wrap(value + 1))}>
            <ChevronRight size={20} />
          </button>
          <button className={reverse ? "icon-button active" : "icon-button"} aria-label="Reverse playback" onClick={() => setReverse((value) => !value)}>
            <RotateCcw size={17} />
          </button>
        </div>
        <div className="bar-control">
          <span>{bpm} BPM</span>
          <input aria-label="Tempo" type="range" min={20} max={320} value={bpm} onChange={(event) => setBpm(Number(event.target.value))} />
        </div>
        <div
          className="scrub-control"
          aria-label="Song scrubber"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragState({ type: "scrub" });
            const beat = scrubBeatFromPointer(event);
            playheadRef.current = beat;
            setPlayhead(beat);
            updateAudio(beat);
          }}
          onPointerMove={(event) => {
            if (event.buttons === 1 && dragState?.type === "scrub") updateDrag(event);
          }}
        >
          <div className="scrub-line">
            <span style={{ left: `${(playhead / LOOP_BEATS) * 100}%` }} />
          </div>
        </div>
        <div className="effects" aria-label="Effects">
          <label>
            <span>Reverb</span>
            <input type="range" min={0} max={100} value={effects.reverb} onChange={(event) => setEffects({ ...effects, reverb: Number(event.target.value) })} />
          </label>
          <label>
            <span>Delay</span>
            <input type="range" min={0} max={100} value={effects.delay} onChange={(event) => setEffects({ ...effects, delay: Number(event.target.value) })} />
          </label>
          <label>
            <span>Chorus</span>
            <input type="range" min={0} max={100} value={effects.chorus} onChange={(event) => setEffects({ ...effects, chorus: Number(event.target.value) })} />
          </label>
        </div>
        <div className="playbar-end">
          <button
            type="button"
            className="theme-toggle"
            aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            onClick={toggleTheme}
          >
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>
      </footer>
      {songModal && (
        <div className="modal-backdrop" onPointerDown={closeSongModal}>
          <section
            className="song-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={songModal === "save" ? "save-song-title" : "load-song-title"}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header className="song-modal-header">
              <h2 id={songModal === "save" ? "save-song-title" : "load-song-title"}>
                {songModal === "save" ? "Save Song" : "Load Song"}
              </h2>
              <button className="modal-close" type="button" aria-label="Close" onClick={closeSongModal}>
                <X size={18} />
              </button>
            </header>

            {songModal === "save" ? (
              <form
                className="song-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveSongToLocalStorage();
                }}
              >
                <label>
                  <span>Song name</span>
                  <input
                    autoFocus
                    value={songName}
                    onChange={(event) => setSongName(event.target.value)}
                    placeholder="New cave sketch"
                  />
                </label>
                <div className="modal-actions">
                  <button className="primary-action" type="submit">
                    <Save size={15} />
                    Save Locally
                  </button>
                  <button className="secondary-action" type="button" onClick={downloadSongFile}>
                    <Download size={15} />
                    Download File
                  </button>
                </div>
                {songMessage && <p className="song-message">{songMessage}</p>}
              </form>
            ) : (
              <div className="song-form">
                <div className="saved-song-list">
                  {savedSongs.length === 0 ? (
                    <p className="empty-state">No saved songs yet.</p>
                  ) : (
                    savedSongs.map((song) => (
                      <div className="saved-song" key={song.id}>
                        <div>
                          <strong>{song.name}</strong>
                          <span>{new Date(song.savedAt).toLocaleString()}</span>
                        </div>
                        <button className="secondary-action" type="button" onClick={() => loadSong(song)}>
                          Load
                        </button>
                        <button className="text-action" type="button" onClick={() => deleteSavedSong(song.id)}>
                          Delete
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <label className="file-upload">
                  <Upload size={15} />
                  Upload Song File
                  <input type="file" accept="application/json,.json,.synthcave.json" onChange={uploadSongFile} />
                </label>
                {songMessage && <p className="song-message">{songMessage}</p>}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
