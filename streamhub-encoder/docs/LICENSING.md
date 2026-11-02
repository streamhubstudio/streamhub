# Licencias y patentes — StreamHub Encoder

> Esto es un resumen técnico para decidir el empaquetado. **No es asesoramiento legal.** Antes de vender equipos o
> distribuir imágenes a terceros hace falta una revisión legal (ver `planning/SOFTWARE-ENCODER-PLAN.md` §8).

## Qué distribuimos y bajo qué licencia

| Componente | Licencia | Cómo se usa | Consecuencia |
|---|---|---|---|
| `encoderd` (este repo) | la del monorepo (`LICENSE`) | binario Go estático, **sin cgo**; no enlaza ninguna librería de media | se mantiene separado del código GPL: lanza procesos (`gst-launch-1.0`, `ffmpeg`) y habla con ellos por argv/UDP loopback |
| GStreamer core + base/good/bad | LGPL-2.1+ | paquetes de la distro, procesos aparte | sin obligaciones extra si se usan los paquetes de la distro |
| gst-plugins-ugly (`x264enc`) | **GPL-2.0+** (x264 es GPL) | proceso `gst-launch-1.0` | quien distribuya el appliance con x264 distribuye GPL: hay que ofrecer el código fuente de x264/el plugin (los paquetes de Debian/Ubuntu ya lo cumplen si se distribuyen tal cual) |
| `x265enc` (gst-plugins-bad + libx265) | **GPL-2.0+** (o licencia comercial de MulticoreWare) | proceso `gst-launch-1.0` | igual que x264; para no publicar fuentes hace falta la licencia comercial de x265 |
| gst-libav / FFmpeg (`avenc_aac`, `ffmpeg` para HLS push) | LGPL-2.1+ (los paquetes de Ubuntu tienen partes GPL) | procesos aparte | ídem distro |
| `fallbackswitch`/`fallbacksrc` (gst-plugins-rs) | MPL-2.0 | proceso | sin problema |
| pion/webrtc (WHIP) | MIT | dentro de `encoderd` | sin problema |
| NVIDIA driver / NVENC | propietario (del usuario) | `nvcodec` lo abre con `dlopen` en tiempo de ejecución | no se redistribuye; lo instala el usuario (o el runtime `nvidia` de Docker) |
| Blackmagic Desktop Video (DeckLink) | propietario | `decklinkvideosrc` usa el SDK abierto incluido en GStreamer; el **driver** lo instala el usuario | no se redistribuye el driver |

**fdk-aac no se instala ni se usa** (`fdkaacenc` está excluido de la imagen y del `.deb`): su licencia es incompatible con
GPL. El audio AAC-LC se codifica con `avenc_aac` (FFmpeg nativo). HE-AAC queda fuera hasta resolver la licencia.

## Patentes (independiente del código abierto)

- **HEVC/H.265**: pools Access Advance y Via LA + licenciantes independientes. Vender un *dispositivo* que codifica HEVC
  puede generar regalías por unidad. Con NVENC/QSV parte de la cobertura puede venir del fabricante del chip
  **[verificar]**. Recomendación del plan: H.264 por defecto hacia StreamHub/web; HEVC para contribución.
- **H.264/AVC**: pool Via LA (las patentes principales vencieron o están por vencer **[verificar]** por país).
- **AAC**: pool Via LA. AAC-LC es lo único que usamos.
- **Opus** (WHIP): libre de regalías.

## Recomendación de empaquetado

1. **Uso interno / servicio propio:** imagen Docker y `.deb` tal como están.
2. **Producto vendido a terceros:** ofrecer el código fuente GPL que acompaña al equipo (x264/x265/plugins), o comprar
   la licencia comercial de x265 y usar NVENC/QSV como encoder HEVC principal. Revisión legal de regalías HEVC/AAC por
   unidad antes de la primera venta.
