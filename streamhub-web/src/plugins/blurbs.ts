/**
 * Per-plugin mini-landing copy for the in-app Studio detail view — the
 * dashboard equivalent of the public site's plugin landing pages.
 *
 * The backend manifest already ships a one-line `description`; this adds a
 * slightly longer "what it does" plus a few concrete "use cases", in BOTH
 * languages (EN default + ES). Keyed by the plugin id (same slug as the folder
 * under src/plugins/<id>/ and the backend manifest id). Plugins WITHOUT an entry
 * simply fall back to the manifest description — this map is purely additive, so
 * adding a plugin never requires touching it.
 *
 * Pure data (no React / i18n runtime dep) → unit-testable under node:test.
 */
export interface PluginBlurb {
  /** A short paragraph expanding on the one-line description. */
  what: string
  /** A handful of concrete use cases. */
  useCases: string[]
  /** Flags an early / not-production-certified plugin (shown as a badge). */
  experimental?: boolean
}

export type BlurbLocale = 'en' | 'es'

/** id → { en, es } blurb. */
export const PLUGIN_BLURBS: Record<string, Record<BlurbLocale, PluginBlurb>> = {
  cockpit: {
    en: {
      what: 'A CCTV-style surveillance board: a paginated, drag-and-drop grid of every live stream in the app, so an operator can watch many cameras at once.',
      useCases: [
        'A security desk watching every camera in one wall of tiles.',
        'A production gallery previewing all incoming feeds before going live.',
        'Rearranging the most important streams to the front page.',
      ],
    },
    es: {
      what: 'Un tablero de vigilancia estilo CCTV: una grilla paginada y arrastrable con todos los streams en vivo del app, para monitorear muchas cámaras a la vez.',
      useCases: [
        'Una central de seguridad viendo todas las cámaras en un muro de mosaicos.',
        'Una galería de producción previsualizando todas las señales antes de salir al aire.',
        'Reordenar los streams más importantes a la primera página.',
      ],
    },
  },
  deface: {
    en: {
      what: "Detects faces in the app's live stream (CenterFace) and obfuscates them right on the player — blur, mosaic or a solid mask over each face. Masking happens in the player overlay, so the original never leaves the server unblurred by this plugin.",
      useCases: [
        'Publishing footage from public spaces while respecting privacy.',
        'Streaming classrooms or clinics where faces must stay anonymous.',
        'Compliance with GDPR-style privacy requirements on public feeds.',
      ],
    },
    es: {
      what: 'Detecta rostros en el stream en vivo del app (CenterFace) y los ofusca en el reproductor: desenfoque, mosaico o máscara sólida sobre cada rostro. El enmascarado ocurre en el overlay del reproductor.',
      useCases: [
        'Publicar material de espacios públicos respetando la privacidad.',
        'Transmitir aulas o clínicas donde los rostros deben permanecer anónimos.',
        'Cumplir requisitos de privacidad tipo GDPR en señales públicas.',
      ],
    },
  },
  lpr: {
    en: {
      what: "Reads license plates from the app's live stream (fast-alpr: a YOLOv9 detector plus ONNX OCR, fully open-source), matches them against a whitelist / blacklist and emits plate.detected / plate.allowed / plate.denied events through the app's signed callbacks.",
      useCases: [
        'Automatic barrier / gate control for known plates.',
        'Parking and access logs for a fleet or private lot.',
        'Watchlist alerts when a flagged plate appears on camera.',
      ],
    },
    es: {
      what: 'Lee patentes desde el stream en vivo del app (fast-alpr: detector YOLOv9 + OCR ONNX, open-source), las compara contra una lista blanca / negra y emite eventos plate.detected / plate.allowed / plate.denied por los callbacks firmados del app.',
      useCases: [
        'Control automático de barrera / portón para patentes conocidas.',
        'Registros de estacionamiento y acceso para una flota o predio privado.',
        'Alertas de lista de vigilancia cuando aparece una patente marcada.',
      ],
    },
  },
  'people-counter': {
    en: {
      what: 'Counts people crossing a line you draw on the live video (YOLOv8 + ByteTrack): running IN / OUT totals, live occupancy and a capacity alert, with signed count.in / count.out / occupancy.limit webhooks.',
      useCases: [
        'Live headcount and occupancy for a shop, venue or transit gate.',
        'Capacity-limit alerts when a room exceeds its safe maximum.',
        'Footfall analytics for entrances and corridors.',
      ],
    },
    es: {
      what: 'Cuenta personas que cruzan una línea que dibujás sobre el video en vivo (YOLOv8 + ByteTrack): totales de ENTRADA / SALIDA, ocupación en vivo y alerta de aforo, con webhooks firmados count.in / count.out / occupancy.limit.',
      useCases: [
        'Conteo y ocupación en vivo para un local, evento o molinete de transporte.',
        'Alertas de límite de aforo cuando una sala supera su máximo seguro.',
        'Analítica de flujo de personas en accesos y pasillos.',
      ],
    },
  },
  perimeter: {
    en: {
      what: 'Watches restricted zones on a live camera and, while armed (by schedule or manually), alerts on any person inside them — with snapshot + clip evidence and an acknowledgeable alert queue in the dashboard.',
      useCases: [
        'After-hours intrusion detection for a warehouse or yard.',
        'Keep-out zones around machinery or restricted areas.',
        'Evidence capture with a reviewable, acknowledgeable alert log.',
      ],
    },
    es: {
      what: 'Vigila zonas restringidas en una cámara en vivo y, mientras está armada (por horario o manualmente), alerta ante cualquier persona dentro — con evidencia de captura + clip y una cola de alertas reconocibles en el panel.',
      useCases: [
        'Detección de intrusiones fuera de horario en un depósito o playón.',
        'Zonas de exclusión alrededor de maquinaria o áreas restringidas.',
        'Captura de evidencia con un registro de alertas revisable y reconocible.',
      ],
    },
  },
  presence: {
    en: {
      what: 'Detects people in configured zones of the live stream and fires absence / return / after-hours events (signed app callbacks + webhook), with a visual zone editor and a per-zone occupancy timeline.',
      useCases: [
        'Workstation monitoring — alert when a desk is empty too long.',
        'After-hours presence alerts outside the configured work schedule.',
        'Occupancy timelines per zone for staffing insight.',
      ],
    },
    es: {
      what: 'Detecta personas en zonas configuradas del stream en vivo y dispara eventos de ausencia / regreso / fuera-de-horario (callbacks firmados + webhook), con un editor visual de zonas y una línea de tiempo de ocupación por zona.',
      useCases: [
        'Monitoreo de puestos de trabajo: alertar cuando un escritorio queda vacío demasiado tiempo.',
        'Alertas de presencia fuera del horario laboral configurado.',
        'Líneas de tiempo de ocupación por zona para gestión de personal.',
      ],
    },
  },
  quality: {
    en: {
      what: 'Measures the client↔server connection quality: a download / upload bandwidth test plus latency and jitter, distilled into a green / amber / red traffic light against thresholds you configure.',
      useCases: [
        'Pre-flight check before a viewer starts a critical broadcast.',
        'Diagnosing "why is my stream buffering" from the viewer side.',
        'A quick health light for support to read over the phone.',
      ],
    },
    es: {
      what: 'Mide la calidad de la conexión cliente↔servidor: prueba de ancho de banda de descarga / subida más latencia y jitter, resumida en un semáforo verde / ámbar / rojo según umbrales que configurás.',
      useCases: [
        'Chequeo previo antes de que un espectador inicie una transmisión crítica.',
        'Diagnosticar “por qué se corta mi stream” desde el lado del espectador.',
        'Una luz de salud rápida para que soporte la lea por teléfono.',
      ],
    },
  },
  radio: {
    en: {
      what: 'An audio-only WebRTC radio inside the app: go on air straight from the mic, watch the live listener count and hand out subscribe-only listen tokens for your audience.',
      useCases: [
        'A live talk / music radio show with sub-second audio.',
        'Audio commentary alongside a separate video feed.',
        'Private, token-gated audio broadcasts to a known audience.',
      ],
    },
    es: {
      what: 'Una radio WebRTC solo-audio dentro del app: salí al aire directo desde el micrófono, mirá el conteo de oyentes en vivo y repartí tokens de solo-escucha para tu audiencia.',
      useCases: [
        'Un programa de radio en vivo (charla / música) con audio sub-segundo.',
        'Comentario en audio junto a una señal de video aparte.',
        'Transmisiones de audio privadas, con token, para una audiencia conocida.',
      ],
    },
  },
  'safety-ppe': {
    en: {
      what: 'Detects persons without a helmet or hi-viz vest in configured work zones during work hours (a pretrained YOLOv8 PPE model, community weights) and records ppe.violation events with evidence snapshots. Advisory only — not a certified safety system.',
      useCases: [
        'Advisory PPE-compliance nudges on a construction or plant floor.',
        'Logging apparent helmet / vest violations for a safety review.',
        'A visual overlay highlighting people missing required gear.',
      ],
      experimental: true,
    },
    es: {
      what: 'Detecta personas sin casco o chaleco reflectivo en zonas de trabajo configuradas durante el horario laboral (modelo YOLOv8 de EPP preentrenado, pesos de la comunidad) y registra eventos ppe.violation con capturas de evidencia. Solo orientativo — no es un sistema de seguridad certificado.',
      useCases: [
        'Avisos orientativos de cumplimiento de EPP en una obra o planta.',
        'Registrar aparentes violaciones de casco / chaleco para revisión de seguridad.',
        'Un overlay visual que resalta a quienes les falta el equipo requerido.',
      ],
      experimental: true,
    },
  },
  'scheduled-live': {
    en: {
      what: 'Schedules live premieres: viewers see a countdown until the start time, then the stream is revealed automatically at zero.',
      useCases: [
        'A hyped premiere with a countdown landing for the audience.',
        'Timed product launches or announcements.',
        'Holding viewers on a "starting soon" screen before you go live.',
      ],
    },
    es: {
      what: 'Programa estrenos en vivo: los espectadores ven una cuenta regresiva hasta la hora de inicio y el stream se revela automáticamente al llegar a cero.',
      useCases: [
        'Un estreno con expectativa y cuenta regresiva para la audiencia.',
        'Lanzamientos o anuncios de producto programados.',
        'Mantener a los espectadores en una pantalla de “comienza pronto” antes de salir al aire.',
      ],
    },
  },
  streamflow: {
    en: {
      what: 'A visual, n8n-style workflow builder: drag boxes onto a canvas and wire them with cables to turn any StreamHub event into an automation — trigger on a domain event, snapshot the room, analyze it with ChatGPT/DeepSeek, branch on the result, then notify / emit / store.',
      useCases: [
        'Perimeter intrusion → snapshot → AI "is this real?" → notify only if confirmed.',
        'Plate detected → look it up over HTTP → open the gate or raise an alert.',
        'On a schedule, snapshot every camera and post a digest to Discord.',
      ],
    },
    es: {
      what: 'Un constructor visual de flujos estilo n8n: arrastrás cajas a un lienzo y las conectás con cables para convertir cualquier evento de StreamHub en una automatización — disparás con un evento del dominio, sacás una captura de la sala, la analizás con ChatGPT/DeepSeek, ramificás según el resultado y después avisás / emitís / guardás.',
      useCases: [
        'Intrusión en el perímetro → captura → IA “¿es real?” → avisar solo si se confirma.',
        'Patente detectada → consultarla por HTTP → abrir el portón o levantar una alerta.',
        'Por agenda, sacar una captura de cada cámara y postear un resumen a Discord.',
      ],
    },
  },
  streaming: {
    en: {
      what: 'Go live with your webcam + mic and forward the composed room to an external RTMP destination (YouTube, Twitch, …) through the server-side egress.',
      useCases: [
        'Restreaming a room straight to YouTube or Twitch.',
        'A simple browser-based "go live" button for non-technical hosts.',
        'Simulcasting a StreamHub room to a public platform.',
      ],
    },
    es: {
      what: 'Salí en vivo con tu webcam + micrófono y reenviá la sala compuesta a un destino RTMP externo (YouTube, Twitch, …) mediante el egress del servidor.',
      useCases: [
        'Retransmitir una sala directo a YouTube o Twitch.',
        'Un botón simple de “salir en vivo” en el navegador para hosts no técnicos.',
        'Simulcast de una sala de StreamHub a una plataforma pública.',
      ],
    },
  },
  timestamp: {
    en: {
      what: 'Overlays a live CCTV-style date / time stamp (optionally with the camera name) on the player. Configure the format, corner, colour and whether to show the name.',
      useCases: [
        'Burning a timecode onto surveillance-style playback.',
        'Labeling which camera a tile belongs to.',
        'A tidy, always-on clock in the corner of a live feed.',
      ],
    },
    es: {
      what: 'Superpone una marca de fecha / hora estilo CCTV (opcionalmente con el nombre de la cámara) sobre el reproductor. Configurá formato, esquina, color y si mostrar el nombre.',
      useCases: [
        'Grabar un timecode en una reproducción estilo vigilancia.',
        'Etiquetar a qué cámara pertenece un mosaico.',
        'Un reloj prolijo y siempre visible en la esquina de una señal en vivo.',
      ],
    },
  },
  transcription: {
    en: {
      what: 'Transcribes recorded VODs to text + SRT subtitles, uploaded next to the recording in S3. Local open-source Whisper by default; the OpenAI API is optional.',
      useCases: [
        'Auto-captioning recorded sessions for accessibility.',
        'Searchable transcripts of talks, classes or meetings.',
        'Generating SRT files that travel with the VOD.',
      ],
    },
    es: {
      what: 'Transcribe los VOD grabados a texto + subtítulos SRT, subidos junto a la grabación en S3. Whisper open-source local por defecto; la API de OpenAI es opcional.',
      useCases: [
        'Subtitulado automático de sesiones grabadas para accesibilidad.',
        'Transcripciones buscables de charlas, clases o reuniones.',
        'Generar archivos SRT que viajan con el VOD.',
      ],
    },
  },
  occupancy: {
    en: {
      what: 'Tracks people inside tagged polygon zones you draw on the live video (YOLO11 + ByteTrack) and emits dwell sessions plus over-limit occupancy alerts. Runs on this host or distributed per-stream onto edge nodes.',
      useCases: [
        'Live per-zone occupancy and dwell sessions for a store or venue.',
        'Over-limit alerts when a zone exceeds its safe headcount.',
        'Fanning zone tracking out to BYO-GPU edge nodes near the cameras.',
      ],
    },
    es: {
      what: 'Sigue personas dentro de zonas de polígono etiquetadas que dibujás sobre el video en vivo (YOLO11 + ByteTrack) y emite sesiones de permanencia más alertas de ocupación por exceso. Corre en este host o distribuido por stream en nodos edge.',
      useCases: [
        'Ocupación por zona y sesiones de permanencia en vivo para un local o evento.',
        'Alertas cuando una zona supera su aforo seguro.',
        'Distribuir el seguimiento por zona a nodos edge con GPU cerca de las cámaras.',
      ],
    },
  },
  counting: {
    en: {
      what: 'Counts people crossing tagged lines you draw on the live video (YOLO11 + ByteTrack): running IN / OUT totals and live occupancy, with signed count events. Runs on this host or distributed per-stream onto edge nodes.',
      useCases: [
        'IN/OUT people counting on drawn lines, with live occupancy.',
        'Footfall analytics across multiple tagged entrances and corridors.',
        'Distributed counting across many cameras on edge GPUs.',
      ],
    },
    es: {
      what: 'Cuenta personas que cruzan líneas etiquetadas que dibujás sobre el video en vivo (YOLO11 + ByteTrack): totales de ENTRADA / SALIDA y ocupación en vivo, con eventos de conteo firmados. Corre en este host o distribuido por stream en nodos edge.',
      useCases: [
        'Conteo de ENTRADA/SALIDA sobre líneas dibujadas, con ocupación en vivo.',
        'Analítica de flujo en varios accesos y pasillos etiquetados.',
        'Conteo distribuido en muchas cámaras sobre GPUs edge.',
      ],
    },
  },
  crowd: {
    en: {
      what: 'Periodically head-counts each polygon zone by snapshot and fires a multi-cycle density threshold alert. A near-free snapshot workload — runs on this host or distributed per-stream onto edge nodes.',
      useCases: [
        'Crowd-density threshold alerts for a plaza, platform or venue.',
        'Sustained-density warnings that ignore momentary spikes.',
        'Cheap periodic head-counts across many cameras on edge nodes.',
      ],
    },
    es: {
      what: 'Cuenta cabezas por zona de polígono de forma periódica por captura y dispara una alerta de umbral de densidad multi-ciclo. Una carga de captura casi gratis — corre en este host o distribuida por stream en nodos edge.',
      useCases: [
        'Alertas por umbral de aglomeración para una plaza, andén o evento.',
        'Avisos de densidad sostenida que ignoran picos momentáneos.',
        'Conteos periódicos baratos en muchas cámaras sobre nodos edge.',
      ],
    },
  },
  demography: {
    en: {
      what: 'Reads anonymous age / gender / emotion per detected face (local InsightFace by default, or an opt-in OpenAI / DeepSeek vision-API engine per snapshot), optionally within a region of interest you draw. Runs on this host or distributed per-stream onto edge nodes.',
      useCases: [
        'Anonymous audience demographics for retail or out-of-home media.',
        'Restricting reads to a region of interest on the frame.',
        'Local, open-source demography with an optional cloud vision-API engine.',
      ],
    },
    es: {
      what: 'Lee edad / género / emoción anónimos por rostro detectado (InsightFace local por defecto, o un motor opt-in de API de visión OpenAI / DeepSeek por captura), opcionalmente dentro de una región de interés que dibujás. Corre en este host o distribuido por stream en nodos edge.',
      useCases: [
        'Demografía anónima de audiencia para retail o medios out-of-home.',
        'Restringir las lecturas a una región de interés del cuadro.',
        'Demografía local y open-source con un motor de API de visión opcional.',
      ],
    },
  },
  vidstack: {
    en: {
      what: 'Swaps the built-in video.js HLS + VOD player for an advanced, skinned Vidstack player (hls.js). Sub-second WebRTC live is unaffected — this only changes the HLS + VOD playback experience.',
      useCases: [
        'A more polished, modern player skin for HLS and VODs.',
        'Consistent playback UI across live HLS and recordings.',
        'Trying an alternative player without touching WebRTC live.',
      ],
    },
    es: {
      what: 'Reemplaza el reproductor video.js integrado de HLS + VOD por un reproductor Vidstack avanzado y con skin (hls.js). El vivo WebRTC sub-segundo no se ve afectado — esto solo cambia la reproducción de HLS + VOD.',
      useCases: [
        'Un skin de reproductor más pulido y moderno para HLS y VODs.',
        'UI de reproducción consistente entre HLS en vivo y grabaciones.',
        'Probar un reproductor alternativo sin tocar el vivo WebRTC.',
      ],
    },
  },
  watermark: {
    en: {
      what: 'Overlays a text watermark on the player — a lightweight way to brand or mark ownership of a live feed or VOD.',
      useCases: [
        'Branding a stream with your channel or company name.',
        'Marking preview / confidential feeds visibly.',
        'A discreet ownership stamp on public playback.',
      ],
    },
    es: {
      what: 'Superpone una marca de agua de texto sobre el reproductor — una forma liviana de marcar o brandear una señal en vivo o un VOD.',
      useCases: [
        'Brandear un stream con el nombre de tu canal o empresa.',
        'Marcar visiblemente señales de preview / confidenciales.',
        'Un sello discreto de propiedad en la reproducción pública.',
      ],
    },
  },
  yolo: {
    en: {
      what: "Runs a YOLO worker over the app's live stream, detecting COCO objects and POSTing bounding boxes to a callback URL — a general-purpose object-detection building block.",
      useCases: [
        'Generic object detection feeding your own automation.',
        'A starting point for custom vision workflows via the callback.',
        'Overlaying detected objects on top of the live player.',
      ],
    },
    es: {
      what: 'Ejecuta un worker YOLO sobre el stream en vivo del app, detectando objetos COCO y enviando (POST) las cajas a una URL de callback — un bloque de detección de objetos de propósito general.',
      useCases: [
        'Detección de objetos genérica que alimenta tu propia automatización.',
        'Un punto de partida para flujos de visión personalizados vía el callback.',
        'Superponer los objetos detectados sobre el reproductor en vivo.',
      ],
    },
  },
}

/** Resolve a plugin's blurb for a language (falls back to EN); undefined if none. */
export function getBlurb(id: string, lang?: string): PluginBlurb | undefined {
  const entry = PLUGIN_BLURBS[id]
  if (!entry) return undefined
  const locale: BlurbLocale = (lang ?? 'en').toLowerCase().startsWith('es')
    ? 'es'
    : 'en'
  return entry[locale]
}
