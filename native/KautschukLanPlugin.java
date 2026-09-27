package se.kautschuk.lan;

import android.Manifest;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Enumeration;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.SocketFactory;
import org.java_websocket.WebSocket;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.handshake.ServerHandshake;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "KautschukLan",
    permissions = { @Permission(strings = { Manifest.permission.NEARBY_WIFI_DEVICES }, alias = "nearby") }
)
public class KautschukLanPlugin extends Plugin {
    private static final int DISCOVERY_PORT = 47822;
    private WebSocketServer host;
    private WebSocketClient client;
    private final ConcurrentHashMap<String, WebSocket> peers = new ConcurrentHashMap<>();
    private final AtomicInteger seq = new AtomicInteger(1);
    private volatile boolean roleHost;
    private volatile boolean discoveryRunning;
    private volatile boolean discoveryWanted;
    private DatagramSocket discoverySocket;
    private WifiManager.MulticastLock multicastLock;
    private String announceName = "Kautschuk";
    private int announcePort = 47821;
    private String lastScan = "";
    private String myServiceName = "";
    private NsdManager nsd;
    private NsdManager.RegistrationListener regListener;
    private NsdManager.DiscoveryListener discListener;
    private final AtomicInteger discoveryGen = new AtomicInteger();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ArrayDeque<NsdServiceInfo> resolveQueue = new ArrayDeque<>();
    private final ConcurrentHashMap<String, NsdServiceInfo> foundServices = new ConcurrentHashMap<>();
    private boolean resolving;
    private boolean nsdRegistered;
    private boolean nsdDiscovering;
    private long lastSweep;
    private long lastResolve;

    private static final class WifiEnd {
        Network network;
        Inet4Address address;
        int prefix;
    }

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
            WifiEnd wifi = wifiEndpoint();
            if (wifi != null && wifi.network != null) {
                try {
                    SocketFactory factory = wifi.network.getSocketFactory();
                    if (factory != null) sock.setSocketFactory(factory);
                } catch (Exception ignored) {
                }
            }
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
        if (announceName == null || announceName.isEmpty()) announceName = "Kautschuk";
        announcePort = call.getInt("port", 47821);
        roleHost = true;
        ensureDiscovery(call);
    }

    @PluginMethod
    public void listen(PluginCall call) {
        roleHost = false;
        ensureDiscovery(call);
    }

    @PermissionCallback
    private void discoveryPerms(PluginCall call) {
        if (!discoveryWanted) {
            call.resolve();
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("nearby") != PermissionState.GRANTED) {
            emitDiscovery("Tillåt enheter i närheten om listan förblir tom");
        }
        startDiscovery();
        call.resolve();
    }

    private void ensureDiscovery(PluginCall call) {
        discoveryWanted = true;
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                if (getPermissionState("nearby") != PermissionState.GRANTED) {
                    requestPermissionForAlias("nearby", call, "discoveryPerms");
                    return;
                }
            } catch (Exception ignored) {
            }
        }
        startDiscovery();
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
        discoveryWanted = false;
        discoveryRunning = false;
        roleHost = false;
        discoveryGen.incrementAndGet();
        DatagramSocket socket = discoverySocket;
        discoverySocket = null;
        if (socket != null) {
            try {
                socket.close();
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
        lastScan = "";
        mainHandler.post(this::stopNsdOnMain);
    }

    private void startDiscovery() {
        if (!discoveryWanted) return;
        if (discoveryRunning && discoverySocket != null && !discoverySocket.isClosed()) {
            mainHandler.post(this::startNsdOnMain);
            return;
        }
        final int gen = discoveryGen.incrementAndGet();
        if (!discoveryWanted) return;
        discoveryRunning = true;
        Thread thread = new Thread(() -> {
            if (!discoveryWanted || discoveryGen.get() != gen) return;
            try {
                discoveryLoop(gen);
            } finally {
                if (discoveryGen.get() == gen) discoveryRunning = false;
            }
        }, "kautschuk-discovery");
        thread.setDaemon(true);
        thread.start();
        mainHandler.post(this::startNsdOnMain);
    }

    private void discoveryLoop(int gen) {
        while (discoveryRunning && discoveryWanted && discoveryGen.get() == gen) {
            WifiEnd wifi = wifiEndpoint();
            if (wifi == null) {
                emitDiscovery("Anslut till samma Wi-Fi");
                if (!sleep(1000)) return;
                continue;
            }
            DatagramSocket socket = null;
            try {
                holdMulticast();
                socket = openDiscoverySocket(wifi);
                discoverySocket = socket;
                emitDiscovery(roleHost ? "Syns på Wi-Fi" : "Letar på samma Wi-Fi…");
                byte[] buf = new byte[1024];
                long nextSend = 0;
                long openedAt = System.currentTimeMillis();
                while (discoveryRunning && discoveryWanted && discoveryGen.get() == gen && discoverySocket == socket) {
                    long now = System.currentTimeMillis();
                    if (now - openedAt > 5000) {
                        WifiEnd fresh = wifiEndpoint();
                        if (fresh == null || !fresh.address.equals(wifi.address)) break;
                        openedAt = now;
                    }
                    if (now >= nextSend) {
                        sendPresence(socket, wifi);
                        nextSend = now + 800;
                    }
                    if (!roleHost && now - lastSweep > 4000) {
                        int sweepPrefix = wifi.prefix;
                        if ((sweepPrefix < 24 || sweepPrefix > 30) && isPrivate(wifi.address)) sweepPrefix = 24;
                        if (sweepPrefix >= 24 && sweepPrefix <= 30) {
                            lastSweep = now;
                            sweep(socket, wifi, sweepPrefix);
                        }
                    }
                    if (now - lastResolve > 3000) {
                        lastResolve = now;
                        mainHandler.post(this::requeueResolves);
                    }
                    DatagramPacket packet = new DatagramPacket(buf, buf.length);
                    try {
                        socket.receive(packet);
                        handleDiscovery(socket, packet);
                    } catch (SocketTimeoutException ignored) {
                    }
                }
            } catch (Exception ignored) {
                if (discoveryRunning && discoveryGen.get() == gen) {
                    emitDiscovery("Letar igen…");
                    if (!sleep(800)) return;
                }
            } finally {
                if (socket != null) {
                    try {
                        socket.close();
                    } catch (Exception ignored) {
                    }
                    if (discoverySocket == socket) discoverySocket = null;
                }
            }
        }
    }

    private DatagramSocket openDiscoverySocket(WifiEnd wifi) throws Exception {
        try {
            return bindDiscovery(wifi, true);
        } catch (Exception ex) {
            return bindDiscovery(wifi, false);
        }
    }

    private DatagramSocket bindDiscovery(WifiEnd wifi, boolean specific) throws Exception {
        DatagramSocket socket = new DatagramSocket(null);
        try {
            socket.setReuseAddress(true);
            socket.setBroadcast(true);
            if (wifi.network != null) {
                try {
                    // Unbound sockets follow the default route, often cellular when Wi-Fi has no internet.
                    wifi.network.bindSocket(socket);
                } catch (Exception ignored) {
                }
            }
            if (specific) socket.bind(new InetSocketAddress(wifi.address, DISCOVERY_PORT));
            else socket.bind(new InetSocketAddress(DISCOVERY_PORT));
            socket.setSoTimeout(400);
            return socket;
        } catch (Exception ex) {
            try {
                socket.close();
            } catch (Exception ignored) {
            }
            throw ex;
        }
    }

    private void sendPresence(DatagramSocket socket, WifiEnd wifi) {
        byte[] payload = roleHost ? hostPayload() : probePayload();
        for (InetAddress dest : broadcastTargets(wifi)) {
            try {
                socket.send(new DatagramPacket(payload, payload.length, dest, DISCOVERY_PORT));
            } catch (Exception ignored) {
            }
        }
    }

    private void sweep(DatagramSocket socket, WifiEnd wifi, int prefix) {
        byte[] payload = probePayload();
        int bits = 32 - prefix;
        int count = 1 << bits;
        byte[] raw = wifi.address.getAddress();
        int ip = ((raw[0] & 0xff) << 24) | ((raw[1] & 0xff) << 16) | ((raw[2] & 0xff) << 8) | (raw[3] & 0xff);
        int mask = 0xffffffff << bits;
        int network = ip & mask;
        for (int i = 1; i < count - 1; i++) {
            if (!discoveryRunning) return;
            int host = network + i;
            if (host == ip) continue;
            try {
                byte[] addr = new byte[] {
                    (byte) ((host >>> 24) & 0xff),
                    (byte) ((host >>> 16) & 0xff),
                    (byte) ((host >>> 8) & 0xff),
                    (byte) (host & 0xff)
                };
                socket.send(new DatagramPacket(payload, payload.length, InetAddress.getByAddress(addr), DISCOVERY_PORT));
            } catch (Exception ignored) {
            }
        }
    }

    private java.util.List<InetAddress> broadcastTargets(WifiEnd wifi) {
        java.util.ArrayList<InetAddress> out = new java.util.ArrayList<>();
        try {
            out.add(InetAddress.getByName("255.255.255.255"));
        } catch (Exception ignored) {
        }
        if (wifi != null && wifi.address != null && wifi.prefix >= 8 && wifi.prefix <= 30) {
            try {
                byte[] raw = wifi.address.getAddress();
                int ip = ((raw[0] & 0xff) << 24) | ((raw[1] & 0xff) << 16) | ((raw[2] & 0xff) << 8) | (raw[3] & 0xff);
                int mask = 0xffffffff << (32 - wifi.prefix);
                int bcast = ip | ~mask;
                byte[] addr = new byte[] {
                    (byte) ((bcast >>> 24) & 0xff),
                    (byte) ((bcast >>> 16) & 0xff),
                    (byte) ((bcast >>> 8) & 0xff),
                    (byte) (bcast & 0xff)
                };
                out.add(InetAddress.getByAddress(addr));
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    private byte[] hostPayload() {
        try {
            JSONObject obj = new JSONObject();
            obj.put("app", "kautschuk");
            obj.put("op", "host");
            String name = announceName == null || announceName.isEmpty() ? "Kautschuk" : announceName;
            obj.put("name", name);
            obj.put("ip", findIp());
            obj.put("port", announcePort > 0 ? announcePort : 47821);
            return obj.toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception ex) {
            return "{\"app\":\"kautschuk\",\"op\":\"host\"}".getBytes(StandardCharsets.UTF_8);
        }
    }

    private byte[] probePayload() {
        return "{\"app\":\"kautschuk\",\"op\":\"probe\"}".getBytes(StandardCharsets.UTF_8);
    }

    private void handleDiscovery(DatagramSocket socket, DatagramPacket packet) {
        try {
            String text = new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8);
            JSONObject obj = new JSONObject(text);
            if (!"kautschuk".equals(obj.optString("app"))) return;
            String op = obj.optString("op", "");
            String from = ipv4(packet.getAddress());
            if (!usableIp(from)) from = obj.optString("ip", "");
            if (!usableIp(from) || isLocal(from)) return;
            if ("probe".equals(op)) {
                if (!roleHost) return;
                byte[] reply = hostPayload();
                try {
                    socket.send(new DatagramPacket(reply, reply.length, packet.getAddress(), packet.getPort()));
                } catch (Exception ignored) {
                }
                return;
            }
            if (!"host".equals(op) && !op.isEmpty()) return;
            if (roleHost) return;
            String name = obj.optString("name", "Kautschuk");
            emitFound(name.isEmpty() ? "Kautschuk" : name, from, obj.optInt("port", 47821));
        } catch (Exception ignored) {
        }
    }

    private boolean usableIp(String ip) {
        return ip != null && !ip.isEmpty() && !"0.0.0.0".equals(ip) && !"255.255.255.255".equals(ip);
    }

    private void emitFound(String name, String ip, int port) {
        if (!usableIp(ip) || isLocal(ip)) return;
        JSObject payload = new JSObject();
        payload.put("name", name == null || name.isEmpty() ? "Kautschuk" : name);
        payload.put("ip", ip);
        payload.put("port", port > 0 ? port : 47821);
        emit(payload, "discover");
    }

    private void emitDiscovery(String text) {
        if (text == null) text = "";
        if (text.equals(lastScan)) return;
        lastScan = text;
        emitStatus("discovery", null, text);
    }

    private boolean sleep(long ms) {
        try {
            Thread.sleep(ms);
            return true;
        } catch (InterruptedException ex) {
            return false;
        }
    }

    private void holdMulticast() {
        try {
            if (multicastLock != null && multicastLock.isHeld()) return;
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

    private void startNsdOnMain() {
        if (!discoveryRunning || getContext() == null) return;
        stopNsdOnMain();
        if (nsd == null) nsd = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        if (nsd == null) return;
        if (roleHost) registerHostService();
        startServiceDiscovery();
    }

    private void registerHostService() {
        if (nsd == null) return;
        try {
            NsdServiceInfo info = new NsdServiceInfo();
            info.setServiceName(serviceInstanceName());
            info.setServiceType("_kautschuk._tcp.");
            info.setPort(announcePort > 0 ? announcePort : 47821);
            String name = announceName == null || announceName.isEmpty() ? "Kautschuk" : announceName;
            info.setAttribute("name", name);
            regListener = new NsdManager.RegistrationListener() {
                @Override
                public void onServiceRegistered(NsdServiceInfo serviceInfo) {
                    myServiceName = serviceInfo.getServiceName() == null ? "" : serviceInfo.getServiceName();
                }

                @Override
                public void onRegistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    nsdRegistered = false;
                }

                @Override
                public void onServiceUnregistered(NsdServiceInfo serviceInfo) {
                    myServiceName = "";
                    nsdRegistered = false;
                }

                @Override
                public void onUnregistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {
                }
            };
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, regListener);
            nsdRegistered = true;
        } catch (Exception ex) {
            nsdRegistered = false;
        }
    }

    private void startServiceDiscovery() {
        if (nsd == null) return;
        try {
            discListener = new NsdManager.DiscoveryListener() {
                @Override
                public void onDiscoveryStarted(String serviceType) {
                }

                @Override
                public void onServiceFound(NsdServiceInfo serviceInfo) {
                    String found = serviceInfo.getServiceName() == null ? "" : serviceInfo.getServiceName();
                    if (found.isEmpty() || (!myServiceName.isEmpty() && myServiceName.equals(found))) return;
                    try {
                        NsdServiceInfo copy = new NsdServiceInfo();
                        copy.setServiceName(found);
                        String type = serviceInfo.getServiceType();
                        copy.setServiceType(type == null || type.isEmpty() ? "_kautschuk._tcp." : type);
                        foundServices.put(found, copy);
                        mainHandler.post(() -> {
                            resolveQueue.add(copy);
                            pumpResolve();
                        });
                    } catch (Exception ignored) {
                    }
                }

                @Override
                public void onServiceLost(NsdServiceInfo serviceInfo) {
                    String found = serviceInfo.getServiceName() == null ? "" : serviceInfo.getServiceName();
                    foundServices.remove(found);
                }

                @Override
                public void onDiscoveryStopped(String serviceType) {
                    nsdDiscovering = false;
                }

                @Override
                public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                    nsdDiscovering = false;
                }

                @Override
                public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                }
            };
            nsd.discoverServices("_kautschuk._tcp.", NsdManager.PROTOCOL_DNS_SD, discListener);
            nsdDiscovering = true;
        } catch (Exception ex) {
            nsdDiscovering = false;
        }
    }

    private void requeueResolves() {
        if (!discoveryRunning || nsd == null) return;
        for (NsdServiceInfo info : foundServices.values()) resolveQueue.add(info);
        pumpResolve();
    }

    private void pumpResolve() {
        if (resolving || nsd == null) return;
        final NsdServiceInfo info = resolveQueue.poll();
        if (info == null) return;
        resolving = true;
        NsdManager.ResolveListener listener = new NsdManager.ResolveListener() {
            @Override
            public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                resolving = false;
                pumpResolve();
            }

            @Override
            public void onServiceResolved(NsdServiceInfo serviceInfo) {
                resolving = false;
                emitResolved(serviceInfo);
                pumpResolve();
            }
        };
        try {
            nsd.resolveService(info, listener);
        } catch (Exception ex) {
            resolving = false;
        }
    }

    private void emitResolved(NsdServiceInfo service) {
        if (service == null) return;
        String found = service.getServiceName() == null ? "" : service.getServiceName();
        if (!myServiceName.isEmpty() && myServiceName.equals(found)) return;
        String ip = ipv4(service.getHost());
        if (ip.isEmpty() || isLocal(ip)) return;
        String name = found;
        if (service.getAttributes() != null && service.getAttributes().get("name") != null) {
            name = new String(service.getAttributes().get("name"), StandardCharsets.UTF_8);
        }
        emitFound(name, ip, service.getPort());
    }

    private void stopNsdOnMain() {
        foundServices.clear();
        resolveQueue.clear();
        resolving = false;
        if (nsd != null && nsdRegistered && regListener != null) {
            try {
                nsd.unregisterService(regListener);
            } catch (Exception ignored) {
            }
        }
        nsdRegistered = false;
        if (nsd != null && nsdDiscovering && discListener != null) {
            try {
                nsd.stopServiceDiscovery(discListener);
            } catch (Exception ignored) {
            }
        }
        nsdDiscovering = false;
        regListener = null;
        discListener = null;
        myServiceName = "";
    }

    private String serviceInstanceName() {
        String raw = announceName == null ? "" : announceName;
        StringBuilder sb = new StringBuilder("Kautschuk-");
        for (int i = 0; i < raw.length() && sb.length() < 40; i++) {
            char c = raw.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) sb.append(c);
        }
        if (sb.length() == "Kautschuk-".length()) sb.append("spel");
        return sb.toString();
    }

    private String ipv4(InetAddress addr) {
        if (addr instanceof Inet4Address) {
            String host = addr.getHostAddress();
            return host == null ? "" : host;
        }
        if (addr instanceof Inet6Address) {
            byte[] b = addr.getAddress();
            if (b.length == 16 && b[10] == (byte) 0xff && b[11] == (byte) 0xff) {
                boolean mapped = true;
                for (int i = 0; i < 10; i++) {
                    if (b[i] != 0) mapped = false;
                }
                if (mapped) return (b[12] & 255) + "." + (b[13] & 255) + "." + (b[14] & 255) + "." + (b[15] & 255);
            }
        }
        return "";
    }

    private boolean isLocal(String ip) {
        WifiEnd wifi = wifiEndpoint();
        if (wifi != null && wifi.address != null && ip.equals(wifi.address.getHostAddress())) return true;
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces.hasMoreElements()) {
                Enumeration<InetAddress> addrs = ifaces.nextElement().getInetAddresses();
                while (addrs.hasMoreElements()) {
                    String host = ipv4(addrs.nextElement());
                    if (ip.equals(host)) return true;
                }
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    private WifiEnd wifiEndpoint() {
        Context ctx = getContext();
        if (ctx == null) return null;
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return null;
        WifiEnd lan = null;
        try {
            for (Network network : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(network);
                if (caps == null) continue;
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) continue;
                WifiEnd end = endpointFrom(cm, network);
                if (end == null) continue;
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return end;
                if (lan == null && isPrivate(end.address)) lan = end;
            }
        } catch (Exception ignored) {
        }
        if (lan != null) return lan;
        return endpointFromInterfaces(cm);
    }

    private WifiEnd endpointFrom(ConnectivityManager cm, Network network) {
        LinkProperties lp = cm.getLinkProperties(network);
        if (lp == null) return null;
        for (LinkAddress la : lp.getLinkAddresses()) {
            if (!(la.getAddress() instanceof Inet4Address)) continue;
            Inet4Address ip = (Inet4Address) la.getAddress();
            if (ip.isLoopbackAddress() || ip.isLinkLocalAddress()) continue;
            WifiEnd end = new WifiEnd();
            end.network = network;
            end.address = ip;
            end.prefix = la.getPrefixLength();
            return end;
        }
        return null;
    }

    private WifiEnd endpointFromInterfaces(ConnectivityManager cm) {
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces.hasMoreElements()) {
                NetworkInterface nif = ifaces.nextElement();
                if (!nif.isUp() || nif.isLoopback()) continue;
                String name = nif.getName() == null ? "" : nif.getName().toLowerCase();
                boolean preferred = name.startsWith("wlan") || name.startsWith("ap") || name.startsWith("swlan")
                    || name.startsWith("eth") || name.startsWith("en");
                if (!preferred) continue;
                Enumeration<InetAddress> addrs = nif.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (!(addr instanceof Inet4Address)) continue;
                    Inet4Address ip = (Inet4Address) addr;
                    if (ip.isLoopbackAddress() || ip.isLinkLocalAddress()) continue;
                    WifiEnd end = new WifiEnd();
                    end.address = ip;
                    end.prefix = 24;
                    for (InterfaceAddress ia : nif.getInterfaceAddresses()) {
                        if (ip.equals(ia.getAddress())) end.prefix = ia.getNetworkPrefixLength();
                    }
                    end.network = networkFor(cm, ip);
                    return end;
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private Network networkFor(ConnectivityManager cm, Inet4Address ip) {
        if (cm == null) return null;
        try {
            for (Network network : cm.getAllNetworks()) {
                LinkProperties lp = cm.getLinkProperties(network);
                if (lp == null) continue;
                for (LinkAddress la : lp.getLinkAddresses()) {
                    if (ip.equals(la.getAddress())) return network;
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private boolean isPrivate(Inet4Address ip) {
        byte[] b = ip.getAddress();
        int a = b[0] & 255;
        int c = b[1] & 255;
        if (a == 10) return true;
        if (a == 192 && c == 168) return true;
        return a == 172 && c >= 16 && c <= 31;
    }

    private String findIp() {
        WifiEnd wifi = wifiEndpoint();
        if (wifi != null && wifi.address != null) {
            String host = wifi.address.getHostAddress();
            if (host != null && !host.isEmpty()) return host;
        }
        return "";
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
}
