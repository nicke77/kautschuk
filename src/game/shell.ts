import { updateAudio, unlockAudio } from "./audio";
import { drawWorld, fitView, type Skid } from "./draw";
import { forwardSpeed } from "./sim";
import { bestTime, cleanName, Match } from "./match";
import { getLan, setDiscoverHandler, setScanHandler, type DiscoveredHost } from "./lan";
import { TRACKS } from "./tracks";
import { CAR_COLORS, type Input } from "./types";

type TouchState = { steer: number; throttle: number; brake: number; hb: boolean; gas: boolean };

export function mountKautschuk(root: HTMLElement): () => void {
  root.classList.add("game-root");
  root.innerHTML = "";
  const stage = el("div", "stage");
  const canvas = document.createElement("canvas");
  const ui = panel();
  const hud = el("div", "hud");
  hud.hidden = true;
  hud.innerHTML = `
    <div>
      <div class="kicker">Gummi</div>
      <div class="score" data-score>0</div>
      <div class="chain" data-chain></div>
    </div>
    <div class="hud-side">
      <div class="kicker">Varv</div>
      <strong data-lap>1/3</strong>
      <div data-place>1:a</div>
      <div class="oil-flag" data-oil hidden>Olja</div>
    </div>`;
  const flash = el("div", "flash");
  flash.hidden = true;
  flash.textContent = "Kör";
  const touch = touchLayer();
  stage.append(canvas, hud, flash, ui, touch.root);
  root.append(stage);

  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  const match = new Match();
  const keys = new Set<string>();
  let injected = new Set<string>();
  let steerOverride: number | null = null;
  const touchState: TouchState = { steer: 0, throttle: 0, brake: 0, hb: false, gas: false };
  const skids: Skid[] = [];
  let acc = 0;
  let last = performance.now();
  let raf = 0;
  let stopped = false;
  const found = new Map<string, DiscoveredHost & { seen: number }>();
  let scanNote = "";

  let screen: "menu" | "net" = "menu";
  const nameInput = ui.querySelector("input") as HTMLInputElement;
  try {
    nameInput.value = localStorage.getItem("kautschuk-name") || "Du";
  } catch {
    nameInput.value = "Du";
  }

  const unsub = match.subscribe(() => paintChrome());
  paintChrome();
  paintTracks();

  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.code);
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onBlur = () => keys.clear();
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  root.addEventListener("pointerdown", () => unlockAudio());

  ui.querySelector("[data-start]")?.addEventListener("click", () => {
    unlockAudio();
    rememberName();
    match.solo(nameInput.value);
  });
  ui.querySelector("[data-net]")?.addEventListener("click", () => {
    rememberName();
    openNet();
  });
  ui.querySelector("[data-back]")?.addEventListener("click", () => {
    stepBack();
  });
  ui.querySelector("[data-host]")?.addEventListener("click", () => {
    unlockAudio();
    void match.host(nameInput.value);
  });
  ui.querySelector("[data-join]")?.addEventListener("click", () => {
    unlockAudio();
    const ip = (ui.querySelector("[data-ip]") as HTMLInputElement).value;
    void match.join(ip, nameInput.value);
  });
  ui.querySelector("[data-go]")?.addEventListener("click", () => {
    match.startRace();
  });
  ui.querySelector("[data-again]")?.addEventListener("click", () => match.again());
  ui.querySelector("[data-menu]")?.addEventListener("click", () => {
    stepBack();
  });
  ui.querySelector("[data-found]")?.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-join-ip]");
    if (!btn) return;
    unlockAudio();
    const ip = btn.getAttribute("data-join-ip") ?? "";
    const port = btn.getAttribute("data-join-port");
    void match.join(port ? `${ip}:${port}` : ip, nameInput.value);
  });

  for (const button of ui.querySelectorAll<HTMLButtonElement>("[data-track]")) {
    button.addEventListener("click", () => {
      match.setTrack(Number(button.dataset.track));
      paintTracks();
    });
  }
  bindTouch(touch, touchState);

  setDiscoverHandler((host) => {
    found.set(host.ip, { ...host, seen: Date.now() });
    paintChrome();
  });
  setScanHandler((text) => {
    scanNote = text;
    paintChrome();
  });
  const expire = window.setInterval(() => {
    const now = Date.now();
    let dropped = false;
    for (const [ip, row] of found) {
      if (now - row.seen > 7000) {
        found.delete(ip);
        dropped = true;
      }
    }
    if (dropped) paintChrome();
  }, 1000);
  window.__kautschukBack = () => stepBack();

  window.__controlsTest = {
    getYaw: () => {
      const car = match.me();
      return car ? -car.heading : 0;
    },
    getSpeed: () => {
      const car = match.me();
      return car ? forwardSpeed(car) : 0;
    },
    setKeys: (codes) => {
      injected = new Set(codes);
    },
    setSteer: (v) => {
      steerOverride = v;
    },
  };

  const loop = (now: number) => {
    if (stopped) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    acc += dt;
    match.setInput(readInput(keys, injected, steerOverride, touchState));
    let guard = 0;
    while (acc >= 1 / 60 && guard < 5) {
      match.fixed(1 / 60);
      acc -= 1 / 60;
      guard += 1;
      collectSkids(match, skids);
    }
    const me = match.me();
    updateAudio(me ? forwardSpeed(me) : 0, me?.skid ?? 0, match.phase === "race" ? 1 : 0);
    render(ctx, canvas, match, skids, now / 1000);
    paintHud(match, hud, flash);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    unsub();
    match.leave();
    window.clearInterval(expire);
    setDiscoverHandler(() => {});
    setScanHandler(() => {});
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    if (window.__controlsTest) delete window.__controlsTest;
    if (window.__kautschukBack) delete window.__kautschukBack;
  };

  function rememberName() {
    try {
      localStorage.setItem("kautschuk-name", cleanName(nameInput.value));
    } catch {
      /* ignore */
    }
  }

  function paintTracks() {
    for (const button of ui.querySelectorAll<HTMLButtonElement>("[data-track]")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.track) === match.trackIndex));
    }
  }

  function openNet() {
    screen = "net";
    const hint = ui.querySelector("[data-host-hint]");
    if (hint) {
      hint.textContent = getLan().canDiscover
        ? "En blir värd. Den andra stannar här tills namnet syns under Spel i närheten. Tillåt enheter i närheten. Inte gästnät."
        : "Android-appen är värd och syns automatiskt för andra på samma Wi-Fi. Inte gästnät.";
    }
    const addr = ui.querySelector("[data-addr]");
    if (addr) addr.textContent = getLan().canDiscover ? "Eller skriv adress" : "Värdens adress";
    void getLan().listen();
    paintChrome();
  }

  function stepBack() {
    if (match.phase === "results") {
      screen = "menu";
      match.leave();
      return;
    }
    if (match.phase === "race") {
      if (match.mode === "host") {
        screen = "net";
        match.abortToLobby();
        return;
      }
      screen = "menu";
      match.leave();
      return;
    }
    if (screen === "net" || match.phase === "lobby") {
      screen = "menu";
      found.clear();
      match.leave();
      return;
    }
  }

  function paintChrome() {
    const showRace = match.phase === "race";
    const showResults = match.phase === "results";
    const showNet = !showRace && !showResults && (screen === "net" || match.phase === "lobby");
    const showMenu = !showRace && !showResults && !showNet;
    ui.hidden = showRace;
    hud.hidden = !showRace;
    touch.root.hidden = !showRace;
    showGroup("[data-menu-only]", showMenu);
    showGroup("[data-net-only]", showNet);
    showGroup("[data-results-only]", showResults);
    const err = ui.querySelector("[data-error]");
    if (err) err.textContent = showMenu ? match.error : "";
    const lobbyErr = ui.querySelector("[data-lobby-error]");
    if (lobbyErr) lobbyErr.textContent = showNet ? match.error : "";
    const ip = ui.querySelector("[data-show-ip]");
    if (ip) ip.textContent = match.mode === "host" && match.phase === "lobby" ? match.status : "";
    const roster = ui.querySelector("[data-roster]");
    if (roster && showNet) {
      const humans = match.cars.filter((c) => !c.bot);
      roster.innerHTML =
        humans.length === 0
          ? ""
          : humans
              .map((c) => `<li><span>${escapeHtml(c.name)}</span><span>${c.id === match.myId ? "du" : "inne"}</span></li>`)
              .join("");
    }
    const go = ui.querySelector<HTMLButtonElement>("[data-go]");
    if (go) go.hidden = !(match.mode === "host" && match.phase === "lobby");
    const waiting = ui.querySelector<HTMLElement>("[data-wait]");
    if (waiting) waiting.hidden = !(match.mode === "client" && match.phase === "lobby");
    const discover = ui.querySelector<HTMLElement>("[data-discover]");
    const showFound = showNet && getLan().canDiscover && match.mode !== "host";
    if (discover) discover.hidden = !showFound;
    if (showFound) {
      const list = ui.querySelector("[data-found]");
      const empty = ui.querySelector<HTMLElement>("[data-found-empty]");
      const rows = [...found.values()];
      if (list) {
        list.innerHTML = rows
          .map(
            (row) =>
              `<li><button type="button" class="found" data-join-ip="${escapeHtml(row.ip)}" data-join-port="${row.port}"><span>${escapeHtml(row.name)}</span><span>${escapeHtml(row.ip)}</span></button></li>`,
          )
          .join("");
      }
      if (empty) {
        empty.hidden = rows.length > 0;
        if (rows.length === 0) empty.textContent = scanNote || "Letar på samma Wi-Fi…";
      }
    }
    const best = ui.querySelector<HTMLElement>("[data-best]");
    if (best) {
      const time = bestTime();
      best.hidden = !showMenu;
      best.textContent = time > 0 ? `Bästa tid: ${time.toFixed(1)} s` : "";
    }
    if (showResults) {
      const list = ui.querySelector("[data-results]");
      if (list) {
        list.innerHTML = match
          .ranking()
          .map((car, index) => {
            const color = CAR_COLORS[car.id % CAR_COLORS.length];
            const mark = car.finished && car.finishAt >= 0 ? `${car.finishAt.toFixed(1)}s` : "–";
            return `<li><span>${place(index)} ${escapeHtml(car.name)}</span><span style="color:${color}">${mark}</span></li>`;
          })
          .join("");
      }
      const again = ui.querySelector<HTMLButtonElement>("[data-again]");
      if (again) again.hidden = match.mode === "client";
    }
    paintTracks();
  }

  function showGroup(selector: string, show: boolean) {
    for (const node of ui.querySelectorAll<HTMLElement>(selector)) node.hidden = !show;
  }
}

function render(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  match: Match,
  skids: Skid[],
  time: number,
) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 2 || h < 2) return;
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const track = match.track();
  const view = fitView(track, w, h);
  drawWorld(ctx, track, match.cars, skids, view, w, h, time, match.phase === "race" || match.phase === "results");
}

function paintHud(match: Match, hud: HTMLElement, flash: HTMLElement) {
  const me = match.me();
  const score = hud.querySelector("[data-score]");
  const chain = hud.querySelector("[data-chain]");
  const lap = hud.querySelector("[data-lap]");
  const placeEl = hud.querySelector("[data-place]");
  const oil = hud.querySelector("[data-oil]") as HTMLElement | null;
  if (me && score && lap && placeEl) {
    const text = String(Math.floor(me.drift));
    if (score.textContent !== text) score.textContent = text;
    const lapText = `${Math.min(match.laps, me.lap + (me.finished ? 0 : 1))}/${match.laps}`;
    if (lap.textContent !== lapText) lap.textContent = lapText;
    const rank = match.ranking().findIndex((c) => c.id === me.id);
    const p = place(Math.max(0, rank));
    if (placeEl.textContent !== p) placeEl.textContent = p;
    if (chain) chain.textContent = me.chain > 1.2 ? `kedja ${me.chain.toFixed(1)}` : "";
    if (oil) oil.hidden = !me.onOil;
  }
  if (match.flash) {
    flash.textContent = match.flash;
    flash.hidden = false;
  } else {
    flash.hidden = true;
  }
}

function collectSkids(match: Match, skids: Skid[]) {
  if (match.phase !== "race") return;
  for (const car of match.cars) {
    if (car.skid < 0.38) continue;
    skids.push({
      x: car.x,
      y: car.y,
      a: Math.min(0.45, car.skid * 0.4),
      color: car.onOil ? "rgba(215,255,232,0.7)" : "rgba(20,18,16,0.85)",
    });
  }
  if (skids.length > 900) skids.splice(0, skids.length - 900);
  for (const skid of skids) skid.a *= 0.997;
}

function readInput(keys: Set<string>, injected: Set<string>, steerOverride: number | null, touch: TouchState): Input {
  const down = (code: string) => keys.has(code) || injected.has(code);
  let steer = 0;
  if (down("KeyA") || down("ArrowLeft")) steer += 1;
  if (down("KeyD") || down("ArrowRight")) steer -= 1;
  if (steerOverride !== null) steer = steerOverride;
  steer = clamp(steer + touch.steer, -1, 1);
  const throttle = clamp((down("KeyW") || down("ArrowUp") ? 1 : 0) + touch.throttle + (touch.gas ? 1 : 0), 0, 1);
  const brake = clamp((down("KeyS") || down("ArrowDown") ? 1 : 0) + touch.brake, 0, 1);
  return { throttle, brake, steer, handbrake: down("Space") || touch.hb };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function place(index: number): string {
  if (index <= 0) return "1:a";
  if (index === 1) return "2:a";
  return `${index + 1}:e`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "\u0026amp;";
      case "<":
        return "\u0026lt;";
      case ">":
        return "\u0026gt;";
      case '"':
        return "\u0026quot;";
      default:
        return "\u0026#39;";
    }
  });
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function panel(): HTMLElement {
  const node = el("div", "panel");
  node.innerHTML = `
    <div class="brand" data-menu-only>
      <h1>Kaut<span>schuk</span></h1>
      <p class="lede">Hela banan. Håll sladden. Oljan är en belöning, inte ett hinder.</p>
      <div class="bar"></div>
    </div>
    <label class="field" data-menu-only>
      <span>Namn</span>
      <input maxlength="12" autocomplete="off" aria-label="Namn" />
    </label>
    <div class="tracks" data-menu-only>
      ${TRACKS.map(
        (track, index) =>
          `<button type="button" class="track-btn" data-track="${index}" aria-pressed="${index === 0}"><span>${track.name}</span><small>${track.blurb}</small></button>`,
      ).join("")}
    </div>
    <div class="actions" data-menu-only>
      <button type="button" class="btn primary" data-start>Start</button>
      <button type="button" class="btn" data-net>Nätverk</button>
    </div>
    <p class="keys" data-menu-only>W gas · S broms · A vänster · D höger · mellanslag sladd</p>
    <p class="error" data-error></p>
    <p class="best" data-best></p>
    <div data-net-only hidden>
      <div class="kicker">Lokalt nätverk</div>
      <p class="ip" data-show-ip></p>
      <ul class="roster" data-roster></ul>
      <p class="note" data-host-hint></p>
      <div data-discover hidden>
        <div class="kicker">Spel i närheten</div>
        <ul class="roster" data-found></ul>
        <p class="note" data-found-empty>Letar efter värd…</p>
      </div>
      <div class="actions">
        <button type="button" class="btn primary" data-host>Bli värd</button>
        <label class="field"><span data-addr>Värdens adress</span><input data-ip placeholder="192.168.0.12" inputmode="decimal" aria-label="Värdens adress" /></label>
        <button type="button" class="btn" data-join>Gå med</button>
        <button type="button" class="btn primary" data-go hidden>Kör</button>
        <p class="note" data-wait hidden>Väntar på att värden startar.</p>
        <p class="error" data-lobby-error></p>
        <button type="button" class="btn ghost" data-back>Tillbaka</button>
      </div>
      <p class="note">APK och källkod: github.com/nicke77/kautschuk</p>
    </div>
    <div data-results-only hidden>
      <div class="kicker">Mål</div>
      <h2 class="score">Resultat</h2>
      <ul class="roster" data-results></ul>
      <div class="row">
        <button type="button" class="btn primary" data-again>Igen</button>
        <button type="button" class="btn" data-menu>Meny</button>
      </div>
    </div>
  `;
  return node;
}

function touchLayer(): { root: HTMLElement; stick: HTMLElement } {
  const root = el("div", "touch");
  root.hidden = true;
  root.innerHTML = `
    <div class="stick" data-stick><div class="nub" data-nub></div></div>
    <div class="pedals">
      <button type="button" data-gas>Gas</button>
      <button type="button" data-brake>Broms</button>
      <button type="button" data-hb>Sladd</button>
    </div>`;
  return { root, stick: root.querySelector("[data-stick]") as HTMLElement };
}

function bindTouch(touch: { root: HTMLElement }, state: TouchState) {
  const stick = touch.root.querySelector("[data-stick]") as HTMLElement;
  const nub = touch.root.querySelector("[data-nub]") as HTMLElement;
  const move = (ev: PointerEvent) => {
    const rect = stick.getBoundingClientRect();
    const dx = (ev.clientX - (rect.left + rect.width / 2)) / (rect.width * 0.34);
    const dy = (ev.clientY - (rect.top + rect.height / 2)) / (rect.height * 0.34);
    state.steer = clamp(-dx, -1, 1);
    state.throttle = clamp(-dy, 0, 1);
    state.brake = clamp(dy, 0, 1);
    nub.style.transform = `translate(${clamp(dx, -1, 1) * 28}px, ${clamp(dy, -1, 1) * 28}px)`;
  };
  const end = () => {
    state.steer = 0;
    state.brake = 0;
    state.throttle = 0;
    nub.style.transform = "";
  };
  stick.addEventListener("pointerdown", (ev) => {
    stick.setPointerCapture(ev.pointerId);
    move(ev);
  });
  stick.addEventListener("pointermove", (ev) => {
    if (stick.hasPointerCapture(ev.pointerId)) move(ev);
  });
  stick.addEventListener("pointerup", end);
  stick.addEventListener("pointercancel", end);

  const hold = (selector: string, set: (v: boolean) => void) => {
    const button = touch.root.querySelector(selector) as HTMLButtonElement;
    const on = (ev: PointerEvent) => {
      ev.preventDefault();
      set(true);
      button.classList.add("held");
    };
    const off = () => {
      set(false);
      button.classList.remove("held");
    };
    button.addEventListener("pointerdown", on);
    button.addEventListener("pointerup", off);
    button.addEventListener("pointercancel", off);
  };
  hold("[data-gas]", (v) => {
    state.gas = v;
  });
  hold("[data-brake]", (v) => {
    state.brake = v ? 1 : 0;
  });
  hold("[data-hb]", (v) => {
    state.hb = v;
  });
}

declare global {
  interface Window {
    __controlsTest?: {
      getYaw: () => number;
      getSpeed: () => number;
      setKeys?: (codes: string[]) => void;
      setSteer?: (v: number) => void;
    };
    __kautschukBack?: () => void;
  }
}
