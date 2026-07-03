# StreamHub on iOS — `LiveKitClient` (Swift)

iOS uses the official **[client-sdk-swift](https://github.com/livekit/client-sdk-swift)**
(`LiveKitClient`). As with Android, the device needs only a `{ token, wsUrl }` pair, which
you fetch from **your own backend** (which calls StreamHub `POST /apps/:app/tokens`
server-side). Then `room.connect(url:token:)` → publish camera/mic → subscribe.

---

## 1. Swift Package Manager dependency

In Xcode: **File ▸ Add Package Dependencies…** and add:

```
https://github.com/livekit/client-sdk-swift.git
```

…pinning a recent release (e.g. **2.x**). Or in `Package.swift`:

```swift
dependencies: [
    .package(url: "https://github.com/livekit/client-sdk-swift.git", from: "2.0.0"),
],
targets: [
    .target(
        name: "MyApp",
        dependencies: [.product(name: "LiveKit", package: "client-sdk-swift")]
    )
]
```

`Info.plist` — usage descriptions (required or the app crashes on capture):

```xml
<key>NSCameraUsageDescription</key>
<string>Used to publish your video.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Used to publish your audio.</string>
```

For background audio (radio/voice), add the `audio` background mode and configure
`AVAudioSession`.

---

## 2. Get a token from your backend

Same contract as Android — never embed the StreamHub Bearer token in the app. Your backend
calls StreamHub and returns `{ token, wsUrl }`:

```
POST https://your-backend.example.com/streamhub-token
{ "room": "demo", "identity": "iphone-7", "publish": true }
→ { "token": "<jwt>", "wsUrl": "wss://media.example.com" }
```

(Server side it's a `POST https://streamhub.example.com/api/v1/apps/live/tokens` with
`Authorization: Bearer $STREAMHUB_TOKEN` — see [android.md](./android.md#2-get-a-token-from-your-backend).)

---

## 3. Minimal compilable example (Swift)

A small `RoomManager` (`ObservableObject`) that fetches creds, connects, publishes
camera + mic, and exposes the first remote video track. Works with SwiftUI or UIKit.

```swift
import Foundation
import LiveKit

@MainActor
final class RoomManager: ObservableObject, RoomDelegate {

    let room = Room()
    @Published var remoteVideoTrack: VideoTrack?

    // Your backend, which calls StreamHub POST /apps/live/tokens server-side.
    private let backendTokenURL = URL(string: "https://your-backend.example.com/streamhub-token")!

    struct Creds: Decodable { let token: String; let wsUrl: String }

    func start(room roomName: String, identity: String) async {
        do {
            let creds = try await fetchCreds(room: roomName, identity: identity)

            room.add(delegate: self)
            try await room.connect(url: creds.wsUrl, token: creds.token)

            // publish local camera + mic
            try await room.localParticipant.setCamera(enabled: true)
            try await room.localParticipant.setMicrophone(enabled: true)
        } catch {
            print("StreamHub connect error:", error)
        }
    }

    func stop() async {
        await room.disconnect()
    }

    private func fetchCreds(room: String, identity: String) async throws -> Creds {
        var req = URLRequest(url: backendTokenURL)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "room": room, "identity": identity, "publish": true
        ])
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(Creds.self, from: data)
    }

    // MARK: RoomDelegate — render remote video
    nonisolated func room(_ room: Room,
                          participant: RemoteParticipant,
                          didSubscribeTrack publication: RemoteTrackPublication) {
        if let video = publication.track as? VideoTrack {
            Task { @MainActor in self.remoteVideoTrack = video }
        }
    }
}
```

Render it in SwiftUI with the SDK's `VideoView`:

```swift
import SwiftUI
import LiveKit

struct CallView: View {
    @StateObject private var rm = RoomManager()

    var body: some View {
        ZStack {
            if let track = rm.remoteVideoTrack {
                SwiftUIVideoView(track)          // remote video
            } else {
                Color.black
            }
        }
        .task { await rm.start(room: "demo", identity: "iphone-7") }
        .onDisappear { Task { await rm.stop() } }
    }
}
```

`wsUrl` is `wss://media.example.com` (from the token response); `token` is the JWT
from `POST /apps/live/tokens`.

---

## 4. Common variations

- **Subscribe-only (viewer):** mint with `canPublish: false`; don't call `setCamera` /
  `setMicrophone`. Just render the subscribed track.
- **Audio-only / voice channel (SPEC §5):** enable only the mic
  (`setMicrophone(enabled: true)`), never the camera; or mint with `audioOnly: true`.
- **Radio listener (SPEC §6):** fetch `GET /apps/:app/radio/:room/listen-token`
  (subscribe-only audio token + wsUrl) and connect; configure `AVAudioSession` for
  playback and enable the background `audio` mode for lock-screen listening.
- **Switch camera:** the published `LocalVideoTrack`'s capturer
  (`CameraCapturer`) exposes `switchCameraPosition()`.

---

## 5. Checklist

1. Add `client-sdk-swift` via SPM; add camera/mic usage strings to `Info.plist`.
2. Backend mints `{ token, wsUrl }` via StreamHub `POST /apps/:app/tokens`.
3. `room.connect(url: wsUrl, token: token)`.
4. `setCamera(enabled:)` / `setMicrophone(enabled:)` to publish.
5. Implement `RoomDelegate.didSubscribeTrack` to render remote video.
6. `room.disconnect()` on teardown.
