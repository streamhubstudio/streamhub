/**
 * esp32cam_ws_ingest.ino — ESP32-CAM (AI-Thinker) → StreamHub ingest directo por WebSocket
 * ==========================================================================================
 * Empuja frames JPEG (1 mensaje binario WS = 1 frame) a wss://<dominio>/ingest/ws,
 * autenticado con una stream key de StreamHub. SIN relay ffmpeg, SIN RTMP, SIN WebRTC.
 * Protocolo: streamhub-docs/integrations/ESP32-WS-INGEST.md (§3).
 *
 * ⚠️ Este endpoint es un DISEÑO (fase F1 del doc). El sketch está completo y compila,
 *    pero el server /ingest/ws tiene que estar implementado para que conecte.
 *
 * Hardware : AI-Thinker ESP32-CAM (OV2640, 4 MB PSRAM)
 * Board    : "AI Thinker ESP32-CAM" — PSRAM: Enabled — Partition: Huge APP
 * Librerías:
 *   - esp32-camera (incluida en el core Arduino-ESP32)
 *   - WebSockets by Markus Sattler (Links2004/arduinoWebSockets), v2.4+
 *     Library Manager: "WebSockets" → #include <WebSocketsClient.h>
 *
 * Provisioning previo (una vez, desde tu backend/CLI — ver doc §3.6):
 *   curl -X POST https://streamhub.example.com/api/v1/apps/live/ws-ingest \
 *        -H "Authorization: Bearer $STREAMHUB_TOKEN" -d '{"room":"cam1"}'
 *   → { "streamKey": "wsk_...", "wsUrl": "wss://streamhub.example.com/ingest/ws", ... }
 */

#include "esp_camera.h"
#include <WiFi.h>
#include <WebSocketsClient.h>

// ------------------------------------------------------------------ CONFIG --
const char* WIFI_SSID  = "tu-wifi";
const char* WIFI_PASS  = "tu-pass";

const char* SH_HOST    = "streamhub.example.com"; // STREAMHUB_DOMAIN (sin esquema)
const uint16_t SH_PORT = 443;                     // wss (TLS lo termina Caddy/nginx)
const char* SH_APP     = "live";                  // app de StreamHub
const char* SH_ROOM    = "cam1";                  // room (server la namespacea: live-cam1)
const char* STREAM_KEY = "wsk_REEMPLAZAR";        // key minteada por POST /ws-ingest

// Perfil de video. CCTV masivo: FRAMESIZE_QVGA + 8 fps (~0.5 Mbps). Ver doc §7.
#define FRAME_SIZE    FRAMESIZE_VGA   // 640x480
#define JPEG_QUALITY  12              // 10–14 sano (menor = mejor calidad, más bytes)
uint32_t TARGET_FPS = 10;             // el server anuncia maxFps en "ready"; respetarlo

// ------------------------------------------------- pin map AI-Thinker ESP32-CAM --
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

// ------------------------------------------------------------------- estado --
WebSocketsClient ws;
bool     streamReady   = false;   // true tras recibir {"type":"ready"} del server
uint32_t framesSent    = 0;
uint32_t lastFrameMs   = 0;
uint32_t lastStatsMs   = 0;
uint32_t fpsWindowCnt  = 0;
uint32_t fpsWindowMs   = 0;

// ------------------------------------------------------------------- cámara --
static bool cameraInit() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer   = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;  c.pin_d1 = Y3_GPIO_NUM;  c.pin_d2 = Y4_GPIO_NUM;  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;  c.pin_d5 = Y7_GPIO_NUM;  c.pin_d6 = Y8_GPIO_NUM;  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;  c.pin_pclk = PCLK_GPIO_NUM;  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM;  c.pin_sccb_sda = SIOD_GPIO_NUM;  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;      // el OV2640 comprime JPEG en hardware — clave del diseño
  c.frame_size   = FRAME_SIZE;
  c.jpeg_quality = JPEG_QUALITY;
  c.fb_count     = 2;                    // doble buffer: captura mientras se envía
  c.fb_location  = CAMERA_FB_IN_PSRAM;
  c.grab_mode    = CAMERA_GRAB_LATEST;   // SIEMPRE el frame más nuevo → nunca acumula atraso
  return esp_camera_init(&c) == ESP_OK;
}

// ------------------------------------------------------------ eventos del WS --
static void onWsEvent(WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      // Upgrade OK + key aceptada a nivel HTTP. Esperamos el "ready" (JSON) para emitir.
      Serial.printf("[ws] conectado a %s\n", (const char*)payload);
      break;

    case WStype_TEXT: {
      // Mensajes de control del server (JSON). Parse minimalista sin ArduinoJson
      // para no gastar heap: nos alcanza con detectar "ready" / "error".
      const char* msg = (const char*)payload;
      if (strstr(msg, "\"ready\"")) {
        streamReady = true;
        // Respetar el maxFps que anuncia el server (naive parse, formato conocido).
        const char* p = strstr(msg, "\"maxFps\":");
        if (p) {
          uint32_t serverMax = (uint32_t)atoi(p + 9);
          if (serverMax > 0 && serverMax < TARGET_FPS) TARGET_FPS = serverMax;
        }
        Serial.printf("[ws] ready — emitiendo a %u fps\n", TARGET_FPS);
      } else if (strstr(msg, "\"error\"")) {
        Serial.printf("[ws] error del server: %s\n", msg);
      }
      break;
    }

    case WStype_DISCONNECTED:
      // La lib reconecta sola (setReconnectInterval). Códigos de cierre en doc §3.5:
      // 4401 key inválida (revisar STREAM_KEY), 4409 otra conexión tomó la key,
      // 4413 frame demasiado grande (bajar FRAME_SIZE/subir JPEG_QUALITY).
      streamReady = false;
      Serial.println("[ws] desconectado — reintentando…");
      break;

    case WStype_ERROR:
      streamReady = false;
      break;

    default: // PING/PONG los maneja enableHeartbeat()
      break;
  }
}

// -------------------------------------------------------------------- setup --
void setup() {
  Serial.begin(115200);
  Serial.println("\nESP32-CAM → StreamHub WS ingest");

  if (!cameraInit()) {
    Serial.println("FATAL: camara no inicializa (¿PSRAM habilitada? ¿pin map correcto?)");
    while (true) delay(1000);
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                 // menos latencia/jitter de WiFi (cuesta ~50 mA)
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(300); Serial.print("."); }
  Serial.printf("\nWiFi OK  ip=%s  rssi=%d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());

  // --- Conexión wss al ingest de StreamHub -------------------------------
  // Auth preferida: header Authorization (no queda en access logs del proxy).
  // Alternativa soportada por el server: query &key=wsk_... (doc §3.1).
  String path = String("/ingest/ws?app=") + SH_APP + "&room=" + SH_ROOM;
  String auth = String("Authorization: Bearer ") + STREAM_KEY;
  ws.setExtraHeaders(auth.c_str());

  // beginSSL sin CA = NO valida el certificado (suficiente para probar).
  // PRODUCCIÓN: validar el cert del dominio con el root CA (ISRG Root X1 si es
  // Let's Encrypt vía Caddy):
  //   static const char CA[] PROGMEM = "-----BEGIN CERTIFICATE-----\n...";
  //   ws.beginSslWithCA(SH_HOST, SH_PORT, path.c_str(), CA);
  ws.beginSSL(SH_HOST, SH_PORT, path.c_str());

  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(3000);        // reconexión automática cada 3 s, para siempre
  ws.enableHeartbeat(15000, 3000, 2);   // ping cada 15 s, timeout 3 s, muerto tras 2 fallos
}

// --------------------------------------------------------------------- loop --
void loop() {
  ws.loop();                            // atiende el socket (SIEMPRE, cada vuelta)

  if (!streamReady || !ws.isConnected()) return;

  // Throttle a TARGET_FPS. El server además aplica su token-bucket (drop, no corta).
  uint32_t now = millis();
  if (now - lastFrameMs < 1000 / TARGET_FPS) return;
  lastFrameMs = now;

  camera_fb_t* fb = esp_camera_fb_get();          // GRAB_LATEST → frame fresco
  if (!fb) return;

  if (fb->format == PIXFORMAT_JPEG && fb->len > 0) {
    // ===== EL PROTOCOLO ENTERO ES ESTA LÍNEA: 1 mensaje binario = 1 JPEG =====
    if (ws.sendBIN(fb->buf, fb->len)) {
      framesSent++;
      fpsWindowCnt++;
    }
  }
  esp_camera_fb_return(fb);                        // devolver el buffer YA (doble buffer)

  // Stats opcionales cada 30 s → visibles en el dashboard (streams.last_stats_json).
  if (now - lastStatsMs > 30000) {
    uint32_t fps = fpsWindowMs ? (fpsWindowCnt * 1000) / (now - fpsWindowMs) : fpsWindowCnt / 30;
    char buf[128];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"stats\",\"fps\":%u,\"rssi\":%d,\"heapFree\":%u,\"frames\":%u}",
             fps, WiFi.RSSI(), (unsigned)ESP.getFreeHeap(), framesSent);
    ws.sendTXT(buf);
    lastStatsMs = now; fpsWindowMs = now; fpsWindowCnt = 0;
  }
}
