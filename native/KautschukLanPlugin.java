package se.kautschuk.lan;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.view.WindowManager;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.java_websocket.WebSocket;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.handshake.ServerHandshake;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONObject;

@CapacitorPlugin(name = "KautschukLan")
public class KautschukLanPlugin extends Plugin {
    private static final int DISCOVERY_PORT = 47822;
    private WebSocketServer host;
    private WebSocketClient client;
    private final ConcurrentHashMap<String, WebSocket> peers = new ConcurrentHashMap<>();
    private final AtomicInteger seq = new AtomicInteger(1);
    private volatile boolean announcing;
    private volatile boolean listening;
    private DatagramSocket announceSocket;
    private DatagramSocket listenSocket;
    private WifiManager.MulticastLock multicastLock;
    private String announceName = "Kautschuk";
    private int announcePort = 47821;

    @Override
    public void load() {
        if (getActivity() == null) return;
        getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() != null) {
                    getBridge().eval("window.__kautschukBack&&window.__kautschukBack()", null);
                }
            }
        });
    }

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
    public void announce(PluginCall call) {
        announceName = call.getString("name", "Kautschuk");
        announcePort = call.getInt("port", 47821);
        startAnnounce();
        call.resolve();
    }

    @PluginMethod
    public void listen(PluginCall call) {
        startListen();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopDiscovery();
        stopSockets();
        keepScreen(false);
        call.resolve();
    }

    private void stopDiscovery() {
        announcing = false;
        listening = false;
        DatagramSocket announce = announceSocket;
        announceSocket = null;
        if (announce != null) {
            try {
                announce.close();
            } catch (Exception ignored) {
            }
        }
        DatagramSocket listen = listenSocket;
        listenSocket = null;
        if (listen != null) {
            try {
                listen.close();
            } catch (Exception ignored) {
            }
        }
        WifiManager.MulticastLock lock = multicastLock;
        multicastLock = null;
        if (lock != null && lock.isHeld()) {
            try {
                lock.release();
            } catch (Exception ignored) {
            }
        }
    }

    private void startAnnounce() {
        announcing = false;
        DatagramSocket previous = announceSocket;
        announceSocket = null;
        if (previous != null) {
            try {
                previous.close();
            } catch (Exception ignored) {
            }
        }
        final DatagramSocket socket;
        try {
            socket = new DatagramSocket();
            socket.setBroadcast(true);
        } catch (Exception ex) {
            return;
        }
        announceSocket = socket;
        announcing = true;
        Thread thread = new Thread(() -> {
            try {
                while (announcing && announceSocket == socket) {
                    byte[] payload = discoveryPayload();
                    for (InetAddress dest : broadcastTargets()) {
                        try {
                            socket.send(new DatagramPacket(payload, payload.length, dest, DISCOVERY_PORT));
                        } catch (Exception ignored) {
                        }
                    }
                    Thread.sleep(1000);
                }
            } catch (Exception ignored) {
            } finally {
                if (!socket.isClosed()) socket.close();
            }
        }, "kautschuk-announce");
        thread.setDaemon(true);
        thread.start();
    }

    private byte[] discoveryPayload() {
        try {
            JSONObject obj = new JSONObject();
            obj.put("app", "kautschuk");
            obj.put("name", announceName == null || announceName.isEmpty() ? "Kautschuk" : announceName);
            obj.put("ip", findIp());
            obj.put("port", announcePort);
            return obj.toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception ex) {
            return "{\"app\":\"kautschuk\"}".getBytes(StandardCharsets.UTF_8);
        }
    }

    private List<InetAddress> broadcastTargets() {
        List<InetAddress> out = new ArrayList<>();
        try {
            out.add(InetAddress.getByName("255.255.255.255"));
        } catch (Exception ignored) {
        }
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces.hasMoreElements()) {
                NetworkInterface nif = ifaces.nextElement();
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InterfaceAddress ia : nif.getInterfaceAddresses()) {
                    InetAddress broadcast = ia.getBroadcast();
                    if (broadcast != null) out.add(broadcast);
                }
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private void startListen() {
        if (listening) return;
        listening = true;
        Thread thread = new Thread(() -> {
            DatagramSocket socket = null;
            try {
                socket = new DatagramSocket(null);
                socket.setReuseAddress(true);
                socket.setBroadcast(true);
                socket.bind(new InetSocketAddress(DISCOVERY_PORT));
                listenSocket = socket;
                holdMulticast();
                byte[] buf = new byte[512];
                while (listening) {
                    DatagramPacket packet = new DatagramPacket(buf, buf.length);
                    socket.receive(packet);
                    handleDiscovery(packet);
                }
            } catch (Exception ignored) {
                if (listenSocket != socket) listening = false;
            } finally {
                if (socket != null && !socket.isClosed()) socket.close();
            }
        }, "kautschuk-listen");
        thread.setDaemon(true);
        thread.start();
    }

    private void holdMulticast() {
        try {
            if (getContext() == null) return;
            WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi == null) return;
            WifiManager.MulticastLock lock = wifi.createMulticastLock("kautschuk");
            lock.setReferenceCounted(false);
            lock.acquire();
            multicastLock = lock;
        } catch (Exception ignored) {
        }
    }

    private void handleDiscovery(DatagramPacket packet) {
        try {
            String text = new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8);
            JSONObject obj = new JSONObject(text);
            if (!"kautschuk".equals(obj.optString("app"))) return;
            String from = packet.getAddress() instanceof Inet4Address ? packet.getAddress().getHostAddress() : "";
            if (from == null || from.isEmpty() || isLocal(from)) return;
            JSObject payload = new JSObject();
            String name = obj.optString("name", "Kautschuk");
            payload.put("name", name.isEmpty() ? "Kautschuk" : name);
            payload.put("ip", from);
            payload.put("port", obj.optInt("port", 47821));
            emit(payload, "discover");
        } catch (Exception ignored) {
        }
    }

    private boolean isLocal(String ip) {
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces.hasMoreElements()) {
                Enumeration<InetAddress> addrs = ifaces.nextElement().getInetAddresses();
                while (addrs.hasMoreElements()) {
                    String host = addrs.nextElement().getHostAddress();
                    if (ip.equals(host)) return true;
                }
            }
        } catch (Exception ignored) {
        }
        return false;
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
