import "@fontsource/oswald/latin-ext-600.css";
import "@fontsource/outfit/latin-ext-400.css";
import "@fontsource/outfit/latin-ext-500.css";
import "./game/game.css";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { emitDiscover, emitLanMessage, emitLanStatus, setLanApi } from "./game/lan";
import { mountKautschuk } from "./game/shell";

type NativeLan = {
  startHost(opts: { port: number }): Promise<{ ip: string; port: number }>;
  connect(opts: { url: string }): Promise<void>;
  send(opts: { data: string; conn?: string }): Promise<void>;
  stop(): Promise<void>;
  listen(): Promise<void>;
  announce(opts: { name: string; port: number }): Promise<void>;
  addListener(
    eventName: "message",
    cb: (event: { data: string; conn?: string }) => void,
  ): Promise<unknown>;
  addListener(
    eventName: "status",
    cb: (event: { state: string; conn?: string; detail?: string }) => void,
  ): Promise<unknown>;
  addListener(
    eventName: "discover",
    cb: (event: { name: string; ip: string; port: number }) => void,
  ): Promise<unknown>;
};

if (Capacitor.isNativePlatform()) {
  const native = registerPlugin<NativeLan>("KautschukLan");
  void native.addListener("message", (event) => emitLanMessage(event.data, event.conn));
  void native.addListener("status", (event) => emitLanStatus(event));
  void native.addListener("discover", (event) => emitDiscover(event));
  setLanApi({
    canHost: true,
    canDiscover: true,
    startHost: (port) => native.startHost({ port }),
    connect: (url) => native.connect({ url }),
    send: (data, conn) => {
      void native.send({ data, conn });
    },
    stop: () => native.stop(),
    listen: () => native.listen(),
    announce: (name, port) => native.announce({ name, port }),
  });
}

const root = document.querySelector("#app");
if (root instanceof HTMLElement) mountKautschuk(root);
