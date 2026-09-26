export type LanStatus = { state: string; conn?: string; detail?: string };

export type DiscoveredHost = { name: string; ip: string; port: number };

export type LanApi = {
  canHost: boolean;
  canDiscover: boolean;
  startHost: (port: number) => Promise<{ ip: string; port: number }>;
  connect: (url: string) => Promise<void>;
  send: (data: string, conn?: string) => void;
  stop: () => Promise<void>;
  listen: () => Promise<void>;
  announce: (name: string, port: number) => Promise<void>;
};

type MessageHandler = (data: string, conn?: string) => void;
type StatusHandler = (status: LanStatus) => void;

let api: LanApi | null = null;
let onMessage: MessageHandler = () => {};
let onStatus: StatusHandler = () => {};
let onDiscover: (host: DiscoveredHost) => void = () => {};

export function setLanApi(next: LanApi): void {
  api = next;
}

export function setLanHandlers(message: MessageHandler, status: StatusHandler): void {
  onMessage = message;
  onStatus = status;
}

export function setDiscoverHandler(handler: (host: DiscoveredHost) => void): void {
  onDiscover = handler;
}

export function emitLanMessage(data: string, conn?: string): void {
  onMessage(data, conn);
}

export function emitLanStatus(status: LanStatus): void {
  onStatus(status);
}

export function emitDiscover(host: DiscoveredHost): void {
  if (!host.ip) return;
  onDiscover(host);
}

export function getLan(): LanApi {
  return api ?? webLan;
}

const webLan: LanApi = {
  canHost: false,
  canDiscover: false,
  async startHost() {
    throw new Error("Värdläge finns i Android-appen.");
  },
  connect(url: string) {
    return new Promise((resolve, reject) => {
      let sock: WebSocket;
      try {
        sock = new WebSocket(url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error("Kunde inte ansluta"));
        return;
      }
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.close();
        reject(new Error("Ingen värd svarade"));
      }, 4000);
      sock.onopen = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        webSocket = sock;
        emitLanStatus({ state: "open" });
        resolve();
      };
      sock.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(new Error("Kunde inte nå värden"));
      };
      sock.onclose = () => {
        if (webSocket === sock) webSocket = null;
        emitLanStatus({ state: "closed" });
      };
      sock.onmessage = (ev) => {
        if (typeof ev.data === "string") emitLanMessage(ev.data);
      };
    });
  },
  send(data: string) {
    if (webSocket && webSocket.readyState === WebSocket.OPEN) webSocket.send(data);
  },
  async stop() {
    webSocket?.close();
    webSocket = null;
  },
  async listen() {},
  async announce() {},
};

let webSocket: WebSocket | null = null;

export const LAN_PORT = 47821;

export function hostUrl(ip: string, port = LAN_PORT): string {
  const trimmed = ip.trim();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
  const hasPort = /:\d+$/.test(trimmed);
  return `ws://${hasPort ? trimmed : `${trimmed}:${port}`}`;
}
