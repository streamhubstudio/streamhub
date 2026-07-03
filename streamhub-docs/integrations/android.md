# StreamHub on Android — `livekit-android` (Kotlin)

StreamHub's media plane is plain LiveKit, so Android uses the official
**[livekit-android](https://github.com/livekit/client-sdk-android)** SDK. You don't talk
to StreamHub's REST API from the device for media — you only need a `{ token, wsUrl }` pair,
which you fetch from **your own backend** (which in turn calls StreamHub). Then it's:
`room.connect(wsUrl, token)` → publish camera/mic → subscribe to others.

---

## 1. Gradle dependency

`settings.gradle.kts` (Maven Central hosts it):

```kotlin
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
```

`app/build.gradle.kts`:

```kotlin
dependencies {
    implementation("io.livekit:livekit-android:2.11.0")   // check for newer
    // Compose video renderer (optional, if you use Jetpack Compose):
    implementation("io.livekit:livekit-android-compose-components:1.3.0")
}
```

`AndroidManifest.xml` — permissions:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
```

Request `CAMERA` and `RECORD_AUDIO` at runtime before publishing.

---

## 2. Get a token from your backend

Never embed the StreamHub Bearer token in the app. Mint server-side. A minimal backend
endpoint just forwards to StreamHub:

```
POST https://your-backend.example.com/streamhub-token
body: { "room": "demo", "identity": "phone-42", "publish": true }
```

…and your backend does (pseudo / Node):

```js
const r = await fetch("https://streamhub.example.com/api/v1/apps/live/tokens", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.STREAMHUB_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ room, identity, canPublish: publish, canSubscribe: true, ttl: "1h" }),
});
const { data } = await r.json();      // { token, wsUrl, room, ... }
return { token: data.token, wsUrl: data.wsUrl };
```

The app fetches that and gets `{ token, wsUrl }`.

---

## 3. Minimal compilable example (Kotlin)

A single `Activity` that connects, publishes camera + mic, and renders the first remote
participant's video. Uses Kotlin coroutines and an OkHttp call to your backend.

```kotlin
package com.example.streamhub

import android.os.Bundle
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.renderer.SurfaceViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject

class CallActivity : ComponentActivity() {

    private lateinit var room: Room
    private lateinit var container: FrameLayout
    private val http = OkHttpClient()

    // Your backend, which calls StreamHub POST /apps/live/tokens server-side.
    private val backendTokenUrl = "https://your-backend.example.com/streamhub-token"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        container = FrameLayout(this)
        setContentView(container)

        // NOTE: request CAMERA + RECORD_AUDIO runtime permissions before this.
        room = LiveKit.create(applicationContext)

        lifecycleScope.launch {
            // 1) fetch { token, wsUrl } from your backend
            val creds = fetchCreds(room = "demo", identity = "phone-42")

            // 2) start collecting room events (render remote video)
            launch { room.events.collect { onRoomEvent(it) } }

            // 3) connect to the StreamHub/LiveKit edge
            room.connect(creds.wsUrl, creds.token)

            // 4) publish local camera + mic
            val lp = room.localParticipant
            lp.setCameraEnabled(true)
            lp.setMicrophoneEnabled(true)
        }
    }

    private fun onRoomEvent(event: RoomEvent) {
        if (event is RoomEvent.TrackSubscribed) {
            val track = event.track
            if (track is VideoTrack) {
                val renderer = SurfaceViewRenderer(this).apply {
                    room.initVideoRenderer(this)
                }
                runOnUiThread {
                    container.removeAllViews()
                    container.addView(renderer)
                    track.addRenderer(renderer)
                }
            }
        }
    }

    private suspend fun fetchCreds(room: String, identity: String): Creds =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("room", room).put("identity", identity).put("publish", true)
                .toString().toRequestBody("application/json".toMediaType())
            val req = Request.Builder().url(backendTokenUrl).post(body).build()
            http.newCall(req).execute().use { resp ->
                val json = JSONObject(resp.body!!.string())
                Creds(token = json.getString("token"), wsUrl = json.getString("wsUrl"))
            }
        }

    override fun onDestroy() {
        room.disconnect()
        super.onDestroy()
    }

    data class Creds(val token: String, val wsUrl: String)
}
```

`wsUrl` here is `wss://media.example.com` (whatever the token response returns) and
`token` is the LiveKit JWT minted by `POST /apps/live/tokens`.

---

## 4. Common variations

- **Subscribe-only (viewer):** mint the token with `canPublish: false` and skip the
  `setCameraEnabled/​setMicrophoneEnabled` calls. Just render `TrackSubscribed` events.
- **Audio-only / voice channel (SPEC §5):** mint with `audioOnly: true` (or simply only
  enable the mic): `lp.setMicrophoneEnabled(true)` and never enable the camera.
- **Radio listener (SPEC §6):** use the convenience endpoint
  `GET /apps/:app/radio/:room/listen-token` to get a subscribe-only audio token + wsUrl,
  then `room.connect()` and play incoming audio (no UI tracks to render).
- **Screen share:** `lp.setScreenShareEnabled(true)` (requires a MediaProjection
  foreground service per Android rules).
- **Switch camera:** `room.localParticipant.videoTrackPublications` → the
  `LocalVideoTrack` exposes `switchCamera()`.

---

## 5. Checklist

1. Add the `io.livekit:livekit-android` dependency + manifest permissions.
2. Request CAMERA/RECORD_AUDIO at runtime.
3. Backend mints `{ token, wsUrl }` via StreamHub `POST /apps/:app/tokens` (Bearer stays on
   the server).
4. `room.connect(wsUrl, token)`, then `setCameraEnabled/​setMicrophoneEnabled`.
5. Render remote video on `RoomEvent.TrackSubscribed`.
6. `room.disconnect()` on teardown.
