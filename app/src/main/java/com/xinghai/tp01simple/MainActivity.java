package com.xinghai.tp01simple;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.media.midi.MidiDevice;
import android.media.midi.MidiDeviceInfo;
import android.media.midi.MidiInputPort;
import android.media.midi.MidiManager;
import android.media.midi.MidiOutputPort;
import android.media.midi.MidiReceiver;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ArrayAdapter;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public class MainActivity extends Activity {

    private static final UUID MIDI_SERVICE_UUID = UUID.fromString("03b80e5a-ede8-4b33-a751-6ce34ec4c700");
    private static final UUID MIDI_CHAR_UUID = UUID.fromString("7772e5db-3868-4112-a1a9-f2669d106bf3");
    private static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_BLE_PERMS = 1002;

    private WebView webView;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> filePathCallback;

    // BLE State
    private BluetoothAdapter btAdapter;
    private BluetoothLeScanner bleScanner;
    private boolean isScanning = false;
    private String pendingScanReqId;
    private boolean pendingScanAcceptAll = false;
    private final Map<String, BluetoothDevice> discoveredDevices = new LinkedHashMap<>();
    private ArrayAdapter<String> scanListAdapter;
    private final List<String> scanDisplayList = new ArrayList<>();
    private final List<String> scanAddressList = new ArrayList<>();
    private AlertDialog scanDialog;

    private BluetoothGatt bluetoothGatt;
    private BluetoothGattCharacteristic midiCharacteristic;
    private String pendingConnectReqId;
    private String pendingNotifyReqId;
    private String pendingWriteReqId;

    // USB MIDI State
    private MidiManager midiManager;
    private final Map<Integer, MidiDeviceInfo> midiInfoMap = new LinkedHashMap<>();
    private final Map<Integer, MidiDevice> openMidiDevices = new LinkedHashMap<>();
    private final Map<Integer, MidiInputPort> openMidiInputPorts = new LinkedHashMap<>();
    private final Map<Integer, MidiOutputPort> openMidiOutputPorts = new LinkedHashMap<>();

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        BluetoothManager btManager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        if (btManager != null) {
            btAdapter = btManager.getAdapter();
        }
        if ( getPackageManager().hasSystemFeature(PackageManager.FEATURE_MIDI)) {
            midiManager = (MidiManager) getSystemService(Context.MIDI_SERVICE);
            if (midiManager != null) {
                midiManager.registerDeviceCallback(new MidiManager.DeviceCallback() {
                    @Override
                    public void onDeviceRemoved(MidiDeviceInfo device) {
                        int id = device.getId();
                        closeMidiPort(id);
                        evalJs("window.__nativeBridge && window.__nativeBridge.onUsbMidiDisconnected(" + id + ");");
                    }
                }, mainHandler);
            }
        }

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidNative");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = filePathCallback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择升级文件 (.ble / .bin)"), REQ_FILE_CHOOSER);
                } catch (Exception e) {
                    MainActivity.this.filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE_CHOOSER) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                String dataString = data.getDataString();
                if (dataString != null) {
                    results = new Uri[]{Uri.parse(dataString)};
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_BLE_PERMS) {
            boolean allGranted = true;
            for (int res : grantResults) {
                if (res != PackageManager.PERMISSION_GRANTED) {
                    allGranted = false;
                    break;
                }
            }
            if (allGranted && pendingScanReqId != null) {
                startBleDevicePicker(pendingScanReqId, pendingScanAcceptAll);
            } else if (pendingScanReqId != null) {
                jsReject(pendingScanReqId, "未授予蓝牙/位置权限，请在系统设置中开启权限", "SecurityError");
                pendingScanReqId = null;
            }
        }
    }

    private boolean hasBlePermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
                    && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        } else {
            return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        }
    }

    private void requestBlePermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            requestPermissions(new String[]{
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.BLUETOOTH_CONNECT
            }, REQ_BLE_PERMS);
        } else {
            requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
            }, REQ_BLE_PERMS);
        }
    }

    @SuppressLint("MissingPermission")
    private void startBleDevicePicker(final String reqId, final boolean acceptAll) {
        if (btAdapter == null || !btAdapter.isEnabled()) {
            jsReject(reqId, "请先在手机系统中打开蓝牙", "InvalidStateError");
            return;
        }
        bleScanner = btAdapter.getBluetoothLeScanner();
        if (bleScanner == null) {
            jsReject(reqId, "无法获取蓝牙 BLE 扫描器", "NotSupportedError");
            return;
        }

        discoveredDevices.clear();
        scanDisplayList.clear();
        scanAddressList.clear();

        scanListAdapter = new ArrayAdapter<>(this, android.R.layout.simple_list_item_1, scanDisplayList);

        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle(acceptAll ? "正在扫描全部蓝牙设备…" : "正在扫描 TP-01 (BLE MIDI)…");
        builder.setAdapter(scanListAdapter, (dialog, which) -> {
            stopBleScan();
            if (which >= 0 && which < scanAddressList.size()) {
                String addr = scanAddressList.get(which);
                BluetoothDevice dev = discoveredDevices.get(addr);
                String name = (dev != null && dev.getName() != null) ? dev.getName() : addr;
                try {
                    JSONObject obj = new JSONObject();
                    obj.put("address", addr);
                    obj.put("name", name);
                    jsResolveObj(reqId, obj.toString());
                } catch (Exception e) {
                    jsReject(reqId, e.getMessage(), "Error");
                }
            }
        });
        builder.setNegativeButton("取消", (dialog, which) -> {
            stopBleScan();
            jsReject(reqId, "User cancelled device chooser", "NotFoundError");
        });
        builder.setOnCancelListener(dialog -> {
            stopBleScan();
            jsReject(reqId, "User cancelled device chooser", "NotFoundError");
        });

        scanDialog = builder.create();
        scanDialog.show();

        // Include already connected BLE devices if any
        BluetoothManager btManager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        if (btManager != null) {
            List<BluetoothDevice> connected = btManager.getConnectedDevices(BluetoothProfile.GATT);
            for (BluetoothDevice d : connected) {
                addDiscoveredDevice(d, 0);
            }
        }

        List<ScanFilter> filters = new ArrayList<>();
        if (!acceptAll) {
            filters.add(new ScanFilter.Builder().setServiceUuid(new ParcelUuid(MIDI_SERVICE_UUID)).build());
        }
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();

        isScanning = true;
        bleScanner.startScan(filters, settings, scanCallback);

        // Stop scanning automatically after 20s
        mainHandler.postDelayed(() -> {
            if (isScanning) {
                stopBleScan();
                if (scanDialog != null && scanDialog.isShowing()) {
                    scanDialog.setTitle(scanAddressList.isEmpty() ? "未找到设备（请勾选显示全部蓝牙设备重试）" : "选择蓝牙设备");
                }
            }
        }, 20000);
    }

    @SuppressLint("MissingPermission")
    private void addDiscoveredDevice(BluetoothDevice device, int rssi) {
        if (device == null || device.getAddress() == null) return;
        String addr = device.getAddress();
        if (discoveredDevices.containsKey(addr)) return;
        String name = device.getName();
        if ((name == null || name.trim().isEmpty()) && pendingScanAcceptAll) {
            name = "未知设备";
        } else if (name == null || name.trim().isEmpty()) {
            name = "BLE MIDI 设备";
        }
        discoveredDevices.put(addr, device);
        String label = name + " (" + addr + ")" + (rssi != 0 ? "  " + rssi + " dBm" : "");
        scanDisplayList.add(label);
        scanAddressList.add(addr);
        if (scanListAdapter != null) {
            scanListAdapter.notifyDataSetChanged();
        }
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            mainHandler.post(() -> addDiscoveredDevice(result.getDevice(), result.getRssi()));
        }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            mainHandler.post(() -> {
                for (ScanResult r : results) {
                    addDiscoveredDevice(r.getDevice(), r.getRssi());
                }
            });
        }
    };

    @SuppressLint("MissingPermission")
    private void stopBleScan() {
        if (isScanning && bleScanner != null) {
            try {
                bleScanner.stopScan(scanCallback);
            } catch (Exception ignored) {}
        }
        isScanning = false;
    }

    @SuppressLint("MissingPermission")
    private void connectBleGatt(String reqId, String address) {
        if (btAdapter == null) {
            jsReject(reqId, "Bluetooth not available", "Error");
            return;
        }
        closeBleGatt();
        pendingConnectReqId = reqId;
        BluetoothDevice device = discoveredDevices.get(address);
        if (device == null) {
            device = btAdapter.getRemoteDevice(address);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            bluetoothGatt = device.connectGatt(this, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
        } else {
            bluetoothGatt = device.connectGatt(this, false, gattCallback);
        }
    }

    @SuppressLint("MissingPermission")
    private void closeBleGatt() {
        if (bluetoothGatt != null) {
            try { bluetoothGatt.disconnect(); } catch (Exception ignored) {}
            try { bluetoothGatt.close(); } catch (Exception ignored) {}
            bluetoothGatt = null;
        }
        midiCharacteristic = null;
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
                gatt.requestMtu(512);
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                midiCharacteristic = null;
                try { gatt.close(); } catch (Exception ignored) {}
                if (bluetoothGatt == gatt) {
                    bluetoothGatt = null;
                }
                if (pendingConnectReqId != null) {
                    String id = pendingConnectReqId;
                    pendingConnectReqId = null;
                    jsReject(id, "GATT 连接断开 (status=" + status + ")", "NetworkError");
                } else {
                    evalJs("window.__nativeBridge && window.__nativeBridge.onBleDisconnected();");
                }
            }
        }

        @SuppressLint("MissingPermission")
        @Override
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            gatt.discoverServices();
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                if (pendingConnectReqId != null) {
                    String id = pendingConnectReqId;
                    pendingConnectReqId = null;
                    jsReject(id, "服务发现失败 (status=" + status + ")", "NotFoundError");
                }
                return;
            }
            BluetoothGattService service = gatt.getService(MIDI_SERVICE_UUID);
            if (service == null) {
                if (pendingConnectReqId != null) {
                    String id = pendingConnectReqId;
                    pendingConnectReqId = null;
                    jsReject(id, "该设备不支持 BLE MIDI 服务", "NotFoundError");
                }
                return;
            }
            BluetoothGattCharacteristic ch = service.getCharacteristic(MIDI_CHAR_UUID);
            if (ch == null) {
                if (pendingConnectReqId != null) {
                    String id = pendingConnectReqId;
                    pendingConnectReqId = null;
                    jsReject(id, "未找到 BLE MIDI 特征值", "NotFoundError");
                }
                return;
            }
            midiCharacteristic = ch;
            if (pendingConnectReqId != null) {
                String id = pendingConnectReqId;
                pendingConnectReqId = null;
                jsResolveStr(id, "ok");
            }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            if (pendingNotifyReqId != null) {
                String id = pendingNotifyReqId;
                pendingNotifyReqId = null;
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    jsResolveStr(id, "ok");
                } else {
                    jsReject(id, "开启通知失败 (status=" + status + ")", "Error");
                }
            }
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            if (pendingWriteReqId != null) {
                String id = pendingWriteReqId;
                pendingWriteReqId = null;
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    jsResolveStr(id, "ok");
                } else {
                    jsReject(id, "GATT 写入失败 (status=" + status + ")", "Error");
                }
            }
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            byte[] value = characteristic.getValue();
            if (value != null && value.length > 0) {
                String b64 = Base64.encodeToString(value, Base64.NO_WRAP);
                evalJs("window.__nativeBridge && window.__nativeBridge.onBleNotify('" + b64 + "');");
            }
        }
    };

    private void closeMidiPort(int devId) {
        try {
            MidiInputPort inPort = openMidiInputPorts.remove(devId);
            if (inPort != null) inPort.close();
        } catch (Exception ignored) {}
        try {
            MidiOutputPort outPort = openMidiOutputPorts.remove(devId);
            if (outPort != null) outPort.close();
        } catch (Exception ignored) {}
        try {
            MidiDevice dev = openMidiDevices.remove(devId);
            if (dev != null) dev.close();
        } catch (Exception ignored) {}
    }

    private void ensureMidiDeviceOpen(int devId, Runnable onReady) {
        if (openMidiDevices.containsKey(devId)) {
            onReady.run();
            return;
        }
        if (midiManager == null) return;
        MidiDeviceInfo info = midiInfoMap.get(devId);
        if (info == null) return;
        midiManager.openDevice(info, device -> {
            if (device != null) {
                openMidiDevices.put(devId, device);
                onReady.run();
            }
        }, mainHandler);
    }

    public class AndroidBridge {

        @JavascriptInterface
        public void bleRequestDevice(final String reqId, final boolean acceptAll) {
            mainHandler.post(() -> {
                pendingScanReqId = reqId;
                pendingScanAcceptAll = acceptAll;
                if (!hasBlePermissions()) {
                    requestBlePermissions();
                } else {
                    startBleDevicePicker(reqId, acceptAll);
                }
            });
        }

        @JavascriptInterface
        public void bleConnect(final String reqId, final String address) {
            mainHandler.post(() -> connectBleGatt(reqId, address));
        }

        @JavascriptInterface
        public void bleDisconnect() {
            mainHandler.post(MainActivity.this::closeBleGatt);
        }

        @SuppressLint("MissingPermission")
        @JavascriptInterface
        public void bleStartNotifications(final String reqId) {
            mainHandler.post(() -> {
                if (bluetoothGatt == null || midiCharacteristic == null) {
                    jsReject(reqId, "蓝牙未连接", "Error");
                    return;
                }
                bluetoothGatt.setCharacteristicNotification(midiCharacteristic, true);
                BluetoothGattDescriptor desc = midiCharacteristic.getDescriptor(CCCD_UUID);
                if (desc != null) {
                    pendingNotifyReqId = reqId;
                    desc.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                    boolean ok = bluetoothGatt.writeDescriptor(desc);
                    if (!ok) {
                        pendingNotifyReqId = null;
                        jsResolveStr(reqId, "ok");
                    }
                } else {
                    jsResolveStr(reqId, "ok");
                }
            });
        }

        @SuppressLint("MissingPermission")
        @JavascriptInterface
        public void bleStopNotifications() {
            mainHandler.post(() -> {
                if (bluetoothGatt != null && midiCharacteristic != null) {
                    try {
                        bluetoothGatt.setCharacteristicNotification(midiCharacteristic, false);
                    } catch (Exception ignored) {}
                }
            });
        }

        @SuppressLint("MissingPermission")
        @JavascriptInterface
        public void bleWrite(final String reqId, final String b64Data, final boolean withResponse) {
            mainHandler.post(() -> {
                if (bluetoothGatt == null || midiCharacteristic == null) {
                    jsReject(reqId, "蓝牙未连接", "Error");
                    return;
                }
                byte[] bytes = Base64.decode(b64Data, Base64.DEFAULT);
                int props = midiCharacteristic.getProperties();
                boolean useWithResp = withResponse || ((props & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) == 0);
                midiCharacteristic.setWriteType(useWithResp
                        ? BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                        : BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                midiCharacteristic.setValue(bytes);
                pendingWriteReqId = reqId;
                boolean started = bluetoothGatt.writeCharacteristic(midiCharacteristic);
                if (!started) {
                    pendingWriteReqId = null;
                    jsReject(reqId, "GATT 写入忙碌或失败", "Error");
                }
            });
        }

        @JavascriptInterface
        public void midiRequestAccess(final String reqId) {
            mainHandler.post(() -> {
                try {
                    JSONArray arr = new JSONArray();
                    midiInfoMap.clear();
                    if (midiManager != null) {
                        MidiDeviceInfo[] infos = midiManager.getDevices();
                        for (MidiDeviceInfo info : infos) {
                            if (info.getType() == MidiDeviceInfo.TYPE_BLUETOOTH) continue;
                            if (info.getInputPortCount() == 0 && info.getOutputPortCount() == 0) continue;
                            int id = info.getId();
                            midiInfoMap.put(id, info);
                            Bundle props = info.getProperties();
                            String name = props != null ? props.getString(MidiDeviceInfo.PROPERTY_NAME) : null;
                            String product = props != null ? props.getString(MidiDeviceInfo.PROPERTY_PRODUCT) : null;
                            String mfg = props != null ? props.getString(MidiDeviceInfo.PROPERTY_MANUFACTURER) : null;
                            JSONObject obj = new JSONObject();
                            obj.put("id", id);
                            obj.put("name", name != null ? name : (product != null ? product : "USB MIDI #" + id));
                            obj.put("manufacturer", mfg != null ? mfg : "");
                            // In Android MidiManager:
                            // Device's "InputPort" receives bytes FROM app (Web MIDI Output)
                            // Device's "OutputPort" sends bytes TO app (Web MIDI Input)
                            obj.put("hasOutput", info.getInputPortCount() > 0);
                            obj.put("hasInput", info.getOutputPortCount() > 0);
                            arr.put(obj);
                        }
                    }
                    jsResolveStr(reqId, arr.toString());
                } catch (Exception e) {
                    jsReject(reqId, e.getMessage(), "Error");
                }
            });
        }

        @JavascriptInterface
        public void midiOpenInput(final int devId) {
            mainHandler.post(() -> ensureMidiDeviceOpen(devId, () -> {
                if (openMidiOutputPorts.containsKey(devId)) return;
                MidiDevice dev = openMidiDevices.get(devId);
                if (dev == null) return;
                MidiOutputPort outPort = dev.openOutputPort(0);
                if (outPort != null) {
                    openMidiOutputPorts.put(devId, outPort);
                    outPort.connect(new MidiReceiver() {
                        @Override
                        public void onSend(byte[] msg, int offset, int count, long timestamp) {
                            byte[] slice = new byte[count];
                            System.arraycopy(msg, offset, slice, 0, count);
                            String b64 = Base64.encodeToString(slice, Base64.NO_WRAP);
                            evalJs("window.__nativeBridge && window.__nativeBridge.onUsbMidiRx(" + devId + ", '" + b64 + "');");
                        }
                    });
                }
            }));
        }

        @JavascriptInterface
        public void midiSend(final int devId, final String b64Data) {
            mainHandler.post(() -> ensureMidiDeviceOpen(devId, () -> {
                try {
                    MidiInputPort inPort = openMidiInputPorts.get(devId);
                    if (inPort == null) {
                        MidiDevice dev = openMidiDevices.get(devId);
                        if (dev != null) {
                            inPort = dev.openInputPort(0);
                            if (inPort != null) {
                                openMidiInputPorts.put(devId, inPort);
                            }
                        }
                    }
                    if (inPort != null) {
                        byte[] bytes = Base64.decode(b64Data, Base64.DEFAULT);
                        inPort.send(bytes, 0, bytes.length);
                    }
                } catch (Exception ignored) {}
            }));
        }

        @JavascriptInterface
        public void setOrientation(final String mode) {
            mainHandler.post(() -> {
                if (mode != null && mode.startsWith("landscape")) {
                    setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                    getWindow().getDecorView().setSystemUiVisibility(
                            View.SYSTEM_UI_FLAG_FULLSCREEN
                                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
                } else {
                    setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                    getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
                }
            });
        }

        @JavascriptInterface
        public void setKeepScreenOn(final boolean on) {
            mainHandler.post(() -> {
                if (on) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        public void saveBase64File(final String filename, final String b64Data) {
            mainHandler.post(() -> {
                try {
                    byte[] bytes = Base64.decode(b64Data, Base64.DEFAULT);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        ContentValues values = new ContentValues();
                        values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                        values.put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream");
                        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                        if (uri != null) {
                            try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                                if (os != null) os.write(bytes);
                            }
                        }
                    } else {
                        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                        if (!dir.exists()) dir.mkdirs();
                        File outFile = new File(dir, filename);
                        try (FileOutputStream fos = new FileOutputStream(outFile)) {
                            fos.write(bytes);
                        }
                    }
                    Toast.makeText(MainActivity.this, "已保存到下载目录 (Download/" + filename + ")", Toast.LENGTH_LONG).show();
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "保存文件失败: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    private void jsResolveStr(String reqId, String val) {
        String escaped = JSONObject.quote(val);
        evalJs("window.__nativeBridge && window.__nativeBridge.resolve('" + reqId + "', " + escaped + ");");
    }

    private void jsResolveObj(String reqId, String jsonLiteral) {
        evalJs("window.__nativeBridge && window.__nativeBridge.resolve('" + reqId + "', " + jsonLiteral + ");");
    }

    private void jsReject(String reqId, String msg, String errName) {
        String escapedMsg = JSONObject.quote(msg != null ? msg : "Error");
        String escapedName = JSONObject.quote(errName != null ? errName : "Error");
        evalJs("window.__nativeBridge && window.__nativeBridge.reject('" + reqId + "', " + escapedMsg + ", " + escapedName + ");");
    }

    private void evalJs(final String script) {
        mainHandler.post(() -> {
            if (webView != null) {
                webView.evaluateJavascript(script, null);
            }
        });
    }

    @Override
    protected void onDestroy() {
        stopBleScan();
        closeBleGatt();
        for (Integer id : new ArrayList<>(openMidiDevices.keySet())) {
            closeMidiPort(id);
        }
        super.onDestroy();
    }
}
