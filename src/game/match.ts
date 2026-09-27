import { getLan, hostUrl, LAN_PORT, setLanHandlers } from "./lan";
import { botInput, createCar, rankCars, separateCars, stepCar } from "./sim";
import { TRACKS } from "./tracks";
import { LAPS, ZERO_INPUT, type Car, type Input, type SnapCar } from "./types";

const BOTS = ["Nubb", "Kåda", "Tjära"];

export type Phase = "menu" | "lobby" | "race" | "results";

type Listener = () => void;

export class Match {
  phase: Phase = "menu";
  mode: "solo" | "host" | "client" = "solo";
  trackIndex = 0;
  laps = LAPS;
  cars: Car[] = [];
  myId = 0;
  hostIp = "";
  hostPort = LAN_PORT;
  status = "";
  error = "";
  tick = 0;
  finishTimer = -1;
  countdown = 0;
  raceTime = 0;
  flash = "";
  private flashHold = 0;
  private inputs = new Map<number, Input>();
  private connToId = new Map<string, number>();
  private idToConn = new Map<number, string>();
  private nextId = 1;
  private inputAcc = 0;
  private listeners = new Set<Listener>();
  private lastInput: Input = { ...ZERO_INPUT };
  private started = false;

  constructor() {
    setLanHandlers(
      (data, conn) => this.onNet(data, conn),
      (status) => this.onStatus(status.state, status.conn),
    );
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  track() {
    return TRACKS[this.trackIndex] ?? TRACKS[0];
  }

  me(): Car | undefined {
    return this.cars.find((c) => c.id === this.myId);
  }

  ranking(): Car[] {
    return rankCars(this.cars);
  }

  setTrack(index: number): void {
    this.trackIndex = (index + TRACKS.length) % TRACKS.length;
    if (this.mode === "host" && this.phase === "lobby") this.broadcastLobby();
    this.emit();
  }

  solo(name: string): void {
    void getLan().stop();
    this.resetRun("solo");
    this.myId = 0;
    this.spawnField(name, 3);
    this.beginCountdown();
    this.emit();
  }

  async host(name: string): Promise<void> {
    this.error = "";
    const lan = getLan();
    if (!lan.canHost) {
      this.error = "Värdläge körs i Android-appen, på samma Wi-Fi som de andra.";
      this.emit();
      return;
    }
    await lan.stop();
    this.resetRun("host");
    try {
      const info = await lan.startHost(LAN_PORT);
      this.hostIp = info.ip;
      this.hostPort = info.port;
      this.myId = 0;
      this.spawnField(name, 0);
      this.phase = "lobby";
      this.status = info.ip ? `${info.ip}:${info.port}` : "Ingen Wi-Fi-adress";
      void lan.announce(cleanName(name), info.port);
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Kunde inte starta värd";
      this.phase = "menu";
    }
    this.emit();
  }

  async join(raw: string, name: string): Promise<void> {
    this.error = "";
    await getLan().stop();
    this.resetRun("client");
    this.pendingName = name;
    const url = hostUrl(raw, LAN_PORT);
    this.status = "Ansluter…";
    this.phase = "lobby";
    this.emit();
    try {
      await getLan().connect(url);
      getLan().send(JSON.stringify({ op: "join", name: cleanName(name) }));
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Kunde inte ansluta";
      this.phase = "menu";
      this.emit();
    }
  }

  private pendingName = "Du";

  startRace(): void {
    if (this.mode === "client") return;
    if (this.mode === "host") this.fillBots();
    this.beginCountdown();
    if (this.mode === "host") {
      getLan().send(JSON.stringify({ op: "start", track: this.trackIndex, laps: this.laps, countdown: 3 }));
    }
    this.emit();
  }

  leave(): void {
    void getLan().stop();
    this.phase = "menu";
    this.mode = "solo";
    this.cars = [];
    this.started = false;
    this.error = "";
    this.status = "";
    this.inputs.clear();
    this.connToId.clear();
    this.idToConn.clear();
    this.emit();
  }

  abortToLobby(): void {
    if (this.mode !== "host" || this.phase !== "race") return;
    const humans = this.cars.filter((c) => !c.bot);
    this.inputs.clear();
    this.cars = humans.map((human, index) => {
      const spawn = this.track().spawns[index % this.track().spawns.length];
      this.inputs.set(human.id, { ...ZERO_INPUT });
      return createCar(spawn, human.id, human.name, false);
    });
    this.tick = 0;
    this.finishTimer = -1;
    this.started = false;
    this.flash = "";
    this.phase = "lobby";
    this.broadcastLobby();
    this.emit();
  }

  again(): void {
    if (this.mode === "client") return;
    const name = this.me()?.name ?? "Du";
    if (this.mode === "solo") {
      this.solo(name);
      return;
    }
    const humans = this.cars.filter((c) => !c.bot);
    const track = this.track();
    this.inputs.clear();
    this.cars = humans.map((human, index) => {
      const spawn = track.spawns[index % track.spawns.length];
      this.inputs.set(human.id, { ...ZERO_INPUT });
      return createCar(spawn, human.id, human.name, false);
    });
    this.tick = 0;
    this.finishTimer = -1;
    this.started = false;
    this.flash = "";
    this.phase = "lobby";
    this.broadcastLobby();
    this.emit();
  }

  setInput(input: Input): void {
    this.lastInput = input;
    if (this.phase === "race") this.inputs.set(this.myId, input);
  }

  fixed(dt: number): void {
    if (this.phase !== "race" || !this.started) return;
    if (this.countdown > 0) {
      this.countdown -= dt;
      if (this.countdown > 0) {
        this.flash = String(Math.ceil(this.countdown));
        return;
      }
      this.countdown = 0;
      this.flash = "Kör";
      this.flashHold = 0.75;
      return;
    }
    if (this.flashHold > 0) {
      this.flashHold -= dt;
      if (this.flashHold <= 0) this.flash = "";
    }
    if (this.mode === "client") {
      this.inputAcc += dt;
      if (this.inputAcc >= 0.05) {
        this.inputAcc = 0;
        getLan().send(JSON.stringify({ op: "input", ...this.lastInput }));
      }
      for (const car of this.cars) {
        car.x += car.vx * dt;
        car.y += car.vy * dt;
      }
      return;
    }

    this.raceTime += dt;
    const track = this.track();
    for (const car of this.cars) {
      const wasFinished = car.finished;
      const input = car.bot ? botInput(car, track) : (this.inputs.get(car.id) ?? ZERO_INPUT);
      stepCar(car, input, track, dt, this.laps);
      if (!wasFinished && car.finished) car.finishAt = this.raceTime;
    }
    separateCars(this.cars);
    this.tick += 1;
    if (this.cars.some((c) => c.finished)) {
      if (this.finishTimer < 0) this.finishTimer = 0;
      this.finishTimer += dt;
    }
    const allDone = this.cars.length > 0 && this.cars.every((c) => c.finished);
    if (allDone || this.finishTimer > 22) this.finish();
    if (this.mode === "host" && this.tick % 2 === 0) {
      getLan().send(JSON.stringify({ op: "snap", tick: this.tick, cars: this.snapshot() }));
    }
  }

  private finish(): void {
    if (this.phase !== "race") return;
    this.phase = "results";
    this.started = false;
    const me = this.me();
    if (me?.finished && me.finishAt >= 0) {
      try {
        const prev = Number(localStorage.getItem("kautschuk-best-time") ?? "0");
        if (prev <= 0 || me.finishAt < prev) localStorage.setItem("kautschuk-best-time", me.finishAt.toFixed(2));
      } catch {
        /* ignore quota */
      }
    }
    if (this.mode === "host") getLan().send(JSON.stringify({ op: "over" }));
    this.emit();
  }

  private resetRun(mode: "solo" | "host" | "client"): void {
    this.mode = mode;
    this.cars = [];
    this.inputs.clear();
    this.connToId.clear();
    this.idToConn.clear();
    this.nextId = 1;
    this.tick = 0;
    this.finishTimer = -1;
    this.countdown = 0;
    this.raceTime = 0;
    this.started = false;
    this.error = "";
    this.flash = "";
    this.flashHold = 0;
  }

  private beginCountdown(): void {
    this.phase = "race";
    this.started = true;
    this.countdown = 3;
    this.raceTime = 0;
    this.finishTimer = -1;
    this.flash = "3";
    this.flashHold = 0;
  }

  private spawnField(name: string, bots: number): void {
    const track = this.track();
    const player = createCar(track.spawns[0], 0, cleanName(name), false);
    this.cars = [player];
    this.inputs.set(0, { ...ZERO_INPUT });
    for (let i = 0; i < bots; i++) {
      const spawn = track.spawns[(i + 1) % track.spawns.length];
      const id = this.nextId++;
      this.cars.push(createCar(spawn, id, BOTS[i] ?? `Bot ${i + 1}`, true));
    }
  }

  private fillBots(): void {
    const track = this.track();
    while (this.cars.length < 4) {
      const id = this.nextId++;
      const spawn = track.spawns[this.cars.length % track.spawns.length];
      const name = BOTS[(this.cars.length - 1) % BOTS.length] ?? "Bot";
      this.cars.push(createCar({ ...spawn, x: spawn.x - this.cars.length * 6 }, id, name, true));
    }
  }

  private snapshot(): SnapCar[] {
    return this.cars.map((c) => ({
      id: c.id,
      name: c.name,
      bot: c.bot,
      x: Math.round(c.x * 10) / 10,
      y: Math.round(c.y * 10) / 10,
      h: Math.round(c.heading * 1000) / 1000,
      vx: Math.round(c.vx * 10) / 10,
      vy: Math.round(c.vy * 10) / 10,
      lap: c.lap,
      next: c.next,
      drift: Math.round(c.drift),
      skid: Math.round(c.skid * 100) / 100,
      oil: c.onOil,
      finished: c.finished,
      finishAt: c.finished ? Math.round(c.finishAt * 10) / 10 : -1,
    }));
  }

  private broadcastLobby(): void {
    const players = this.cars
      .filter((c) => !c.bot)
      .map((c) => ({ id: c.id, name: c.name }));
    getLan().send(
      JSON.stringify({
        op: "lobby",
        track: this.trackIndex,
        laps: this.laps,
        players,
      }),
    );
  }

  private onStatus(state: string, conn?: string): void {
    if (state === "closed" && this.mode === "client" && this.phase !== "menu") {
      this.error = "Värden försvann";
      this.phase = "menu";
      this.emit();
      return;
    }
    if (state === "closed" && this.mode === "host" && conn) {
      const id = this.connToId.get(conn);
      if (id !== undefined && this.phase !== "menu") {
        this.cars = this.cars.filter((c) => c.id !== id);
        this.connToId.delete(conn);
        this.idToConn.delete(id);
        this.inputs.delete(id);
        if (this.phase === "lobby") this.broadcastLobby();
        this.emit();
      }
    }
  }

  private onNet(data: string, conn?: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (this.mode === "host") this.hostMessage(msg, conn);
    else this.clientMessage(msg);
  }

  private hostMessage(msg: Record<string, unknown>, conn?: string): void {
    if (msg.op === "join" && this.phase === "lobby" && conn) {
      if (this.cars.filter((c) => !c.bot).length >= 4) {
        getLan().send(JSON.stringify({ op: "full" }), conn);
        return;
      }
      const id = this.nextId++;
      const spawn = this.track().spawns[this.cars.length % this.track().spawns.length];
      const car = createCar(spawn, id, cleanName(String(msg.name ?? "Gäst")), false);
      this.cars.push(car);
      this.connToId.set(conn, id);
      this.idToConn.set(id, conn);
      const players = this.cars.filter((c) => !c.bot).map((c) => ({ id: c.id, name: c.name }));
      getLan().send(JSON.stringify({ op: "welcome", id, track: this.trackIndex, laps: this.laps, players }), conn);
      this.broadcastLobby();
      this.emit();
      return;
    }
    if (msg.op === "input" && conn && this.phase === "race") {
      const id = this.connToId.get(conn);
      if (id === undefined) return;
      this.inputs.set(id, {
        throttle: num(msg.throttle),
        brake: num(msg.brake),
        steer: num(msg.steer),
        handbrake: Boolean(msg.handbrake),
      });
    }
  }

  private clientMessage(msg: Record<string, unknown>): void {
    if (msg.op === "welcome") {
      this.myId = num(msg.id);
      this.trackIndex = num(msg.track);
      this.laps = num(msg.laps) || LAPS;
      this.cars = playersToCars(msg.players, this.track());
      this.phase = "lobby";
      this.status = "Inne i lobbyn";
      this.emit();
      return;
    }
    if (msg.op === "lobby") {
      this.trackIndex = num(msg.track);
      this.laps = num(msg.laps) || LAPS;
      this.cars = playersToCars(msg.players, this.track());
      this.phase = "lobby";
      this.started = false;
      this.flash = "";
      this.emit();
      return;
    }
    if (msg.op === "full") {
      this.error = "Loppet är fullt";
      this.phase = "menu";
      this.emit();
      return;
    }
    if (msg.op === "start") {
      this.trackIndex = num(msg.track);
      this.laps = num(msg.laps) || LAPS;
      this.phase = "race";
      this.started = true;
      this.countdown = num(msg.countdown) || 3;
      this.raceTime = 0;
      this.flash = String(Math.ceil(this.countdown));
      this.emit();
      return;
    }
    if (msg.op === "over") {
      this.finish();
      return;
    }
    if (msg.op === "snap" && Array.isArray(msg.cars)) {
      this.applySnap(msg.cars as SnapCar[]);
      if (this.phase === "race") {
        const allDone = this.cars.length > 0 && this.cars.every((c) => c.finished);
        if (allDone) this.finish();
      }
    }
  }

  private applySnap(snaps: SnapCar[]): void {
    for (const snap of snaps) {
      let car = this.cars.find((c) => c.id === snap.id);
      if (!car) {
        car = createCar({ x: snap.x, y: snap.y, h: snap.h }, snap.id, snap.name, snap.bot);
        this.cars.push(car);
      }
      car.name = snap.name;
      car.bot = snap.bot;
      car.x = snap.x;
      car.y = snap.y;
      car.heading = snap.h;
      car.vx = snap.vx;
      car.vy = snap.vy;
      car.lap = snap.lap;
      car.next = snap.next;
      car.drift = snap.drift;
      car.skid = snap.skid;
      car.onOil = snap.oil;
      car.finished = snap.finished;
      car.finishAt = snap.finishAt;
    }
  }
}

function playersToCars(raw: unknown, track: ReturnType<Match["track"]>): Car[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    const row = item as { id?: number; name?: string };
    const spawn = track.spawns[index % track.spawns.length];
    return createCar(spawn, num(row.id), cleanName(String(row.name ?? "Gäst")), false);
  });
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function cleanName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim().slice(0, 12);
  return trimmed || "Du";
}

export function bestTime(): number {
  try {
    return Number(localStorage.getItem("kautschuk-best-time") ?? "0") || 0;
  } catch {
    return 0;
  }
}
