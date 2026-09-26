package se.kautschuk.lan;

import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.URI;
import java.nio.ByteBuffer;
import java.util.Enumeration;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.java_websocket.WebSocket;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.handshake.ServerHandshake;
import org.java_websocket.server.WebSocketServer;

@CapacitorPlugin(name = "KautschukLan")
public class KautschukLanPlugin extends Plugin {
    private WebSocketServer host;
    private WebSocketClient client;
    private final ConcurrentHashMap<String, WebSocket> peers = new ConcurrentHashMap<>();
    private final AtomicInteger seq = new AtomicInteger(1);

    @PluginMethod
    public void startHost(PluginCall call) {
        int port = call.getInt("port", 47821);
        stopSockets();
        try {
            WebSocketServer server = new WebSocketServer(new InetSocketAddress(port)) {
                @Override
                public void onOpen(WebSocket conn, ClientHandshake handshake) {
                    String id = "c" + seq.getAndIncrement();
                    conn.setAttachment(id);
                    peers.put(id, conn);
                    emitStatus("open", id, null);
                }

                @Override
                public void onClose(WebSocket conn, int code, String reason, boolean remote) {
                    String id = conn.getAttachment();
                    if (id != null) peers.remove(id);
                    emitStatus("closed", id, reason);
                }

                @Override
                public void onMessage(WebSocket conn, String message) {
                    emitMessage(message, conn.getAttachment());
                }

                @Override
                public void onMessage(WebSocket conn, ByteBuffer message) {
                }

                @Override
                public void onError(WebSocket conn, Exception ex) {
                    String id = conn != null ? conn.<String>getAttachment() : null;
                    emitStatus("error", id, ex != null ? ex.getMessage() : "fel");
                }

                @Override
                public void onStart() {
                    setConnectionLostTimeout(30);
                }
            };
            server.setReuseAddr(true);
            server.start();
            host = server;
            keepScreen(true);
            JSObject ret = new JSObject();
            ret.put("ip", findIp());
            ret.put("port", port);
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject(ex.getMessage() != null ? ex.getMessage() : "Kunde inte starta värd");
        }
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Saknar adress");
            return;
        }
        stopSockets();
        final boolean[] settled = {false};
        try {
            WebSocketClient sock = new WebSocketClient(new URI(url)) {
                @Override
                public void onOpen(ServerHandshake handshake) {
                    emitStatus("open", null, null);
                }

                @Override
                public void onMessage(String message) {
                    emitMessage(message, null);
                }

                @Override
                public void onClose(int code, String reason, boolean remote) {
                    emitStatus("closed", null, reason);
                    if (!settled[0]) {
                        settled[0] = true;
                        call.reject("Ingen värd svarade");
                    }
                }

                @Override
                public void onError(Exception ex) {
                    emitStatus("error", null, ex != null ? ex.getMessage() : "fel");
                }
            };
            client = sock;
            boolean open = sock.connectBlocking(5, TimeUnit.SECONDS);
            if (!open || !sock.isOpen()) {
                if (!settled[0]) {
                    settled[0] = true;
                    call.reject("Ingen värd svarade");
                }
                try {
                    sock.close();
                } catch (Exception ignored) {
                }
                if (client == sock) client = null;
                return;
            }
            if (!settled[0]) {
                settled[0] = true;
                call.resolve();
            }
        } catch (Exception ex) {
            if (!settled[0]) {
                settled[0] = true;
                call.reject(ex.getMessage() != null ? ex.getMessage() : "Kunde inte ansluta");
            }
        }
    }

    @PluginMethod
    public void send(PluginCall call) {
        String data = call.getString("data", "");
        String conn = call.getString("conn", "");
        try {
            if (client != null && client.isOpen()) {
                client.send(data);
            } else if (host != null) {
                if (conn != null && !conn.isEmpty()) {
                    WebSocket sock = peers.get(conn);
                    if (sock != null && sock.isOpen()) sock.send(data);
                } else {
                    for (WebSocket sock : peers.values()) {
                        if (sock.isOpen()) sock.send(data);
                    }
                }
            }
            call.resolve();
        } catch (Exception ex) {
            call.reject(ex.getMessage() != null ? ex.getMessage() : "Kunde inte skicka");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopSockets();
        keepScreen(false);
        call.resolve();
    }

    private void stopSockets() {
        peers.clear();
        WebSocketServer running = host;
        host = null;
        if (running != null) {
            try {
                running.stop(200);
            } catch (Exception ignored) {
            }
        }
        WebSocketClient sock = client;
        client = null;
        if (sock != null) {
            try {
                sock.close();
            } catch (Exception ignored) {
            }
        }
    }

    private void keepScreen(boolean on) {
        if (getActivity() == null) return;
        getActivity().runOnUiThread(() -> {
            if (getActivity() == null) return;
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    private void emitMessage(String data, String conn) {
        JSObject payload = new JSObject();
        payload.put("data", data == null ? "" : data);
        if (conn != null) payload.put("conn", conn);
        emit(payload, "message");
    }

    private void emitStatus(String state, String conn, String detail) {
        JSObject payload = new JSObject();
        payload.put("state", state);
        if (conn != null) payload.put("conn", conn);
        if (detail != null) payload.put("detail", detail);
        emit(payload, "status");
    }

    private void emit(JSObject payload, String event) {
        Runnable post = () -> notifyListeners(event, payload);
        if (getActivity() != null) getActivity().runOnUiThread(post);
        else post.run();
    }

    private String findIp() {
        String fallback = "";
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces.hasMoreElements()) {
                NetworkInterface nif = ifaces.nextElement();
                if (!nif.isUp() || nif.isLoopback()) continue;
                String name = nif.getName() == null ? "" : nif.getName().toLowerCase();
                boolean preferred = name.startsWith("wlan") || name.startsWith("eth") || name.startsWith("en") || name.startsWith("ap");
                Enumeration<InetAddress> addrs = nif.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (!(addr instanceof Inet4Address)) continue;
                    if (addr.isLoopbackAddress() || addr.isLinkLocalAddress()) continue;
                    String hostAddr = addr.getHostAddress();
                    if (hostAddr == null) continue;
                    if (preferred) return hostAddr;
                    if (fallback.isEmpty()) fallback = hostAddr;
                }
            }
        } catch (Exception ignored) {
        }
        return fallback;
    }
}
