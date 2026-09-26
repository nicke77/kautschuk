let ctx: AudioContext | null = null;
let engine: OscillatorNode | null = null;
let engineGain: GainNode | null = null;
let noiseGain: GainNode | null = null;

export function unlockAudio(): void {
  if (ctx) {
    if (ctx.state === "suspended") void ctx.resume();
    return;
  }
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  ctx = new Ctx();
  engine = ctx.createOscillator();
  engine.type = "sawtooth";
  engine.frequency.value = 48;
  engineGain = ctx.createGain();
  engineGain.gain.value = 0;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 240;
  engine.connect(filter);
  filter.connect(engineGain);
  engineGain.connect(ctx.destination);
  engine.start();

  const buffer = ctx.createBuffer(1, ctx.sampleRate * 1, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 900;
  noiseGain = ctx.createGain();
  noiseGain.gain.value = 0;
  noise.connect(band);
  band.connect(noiseGain);
  noiseGain.connect(ctx.destination);
  noise.start();
}

export function updateAudio(speed: number, skid: number, throttle: number): void {
  if (!ctx || !engine || !engineGain || !noiseGain) return;
  const now = ctx.currentTime;
  const freq = 42 + Math.min(180, Math.abs(speed) * 0.45) + throttle * 16;
  engine.frequency.setTargetAtTime(freq, now, 0.05);
  engineGain.gain.setTargetAtTime(throttle > 0.05 || Math.abs(speed) > 30 ? 0.018 : 0, now, 0.08);
  noiseGain.gain.setTargetAtTime(skid > 0.4 ? Math.min(0.03, skid * 0.03) : 0, now, 0.05);
}

export function stopAudio(): void {
  engineGain?.gain.setTargetAtTime(0, ctx?.currentTime ?? 0, 0.05);
  noiseGain?.gain.setTargetAtTime(0, ctx?.currentTime ?? 0, 0.05);
}
