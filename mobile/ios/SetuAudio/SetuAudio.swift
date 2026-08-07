import AVFoundation
import React

@objc(SetuAudio)
final class SetuAudio: RCTEventEmitter {
  private let session = AVAudioSession.sharedInstance()
  private var observers: [NSObjectProtocol] = []

  override init() {
    super.init()
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { [weak self] _ in
      self?.sendEvent(withName: "SetuAudioRouteChanged", body: ["route": self?.session.currentRoute.outputs.first?.portType.rawValue ?? "unknown", "interrupted": false])
    })
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] notification in
      let type = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue ?? 0
      self?.sendEvent(withName: "SetuAudioRouteChanged", body: ["route": "interruption", "interrupted": type == AVAudioSession.InterruptionType.began.rawValue])
    })
  }

  deinit {
    observers.forEach(NotificationCenter.default.removeObserver)
  }

  @objc override static func requiresMainQueueSetup() -> Bool { true }

  override func supportedEvents() -> [String]! {
    ["SetuAudioRouteChanged"]
  }

  @objc func startSession(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    do {
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker])
      try session.setActive(true, options: [])
      resolve(nil)
    } catch {
      reject("audio_session_failed", "Could not start the voice audio session", error)
    }
  }

  @objc func stopSession(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    do {
      try session.setActive(false, options: [.notifyOthersOnDeactivation])
      resolve(nil)
    } catch {
      reject("audio_session_stop_failed", "Could not stop the voice audio session", error)
    }
  }

  @objc func flushPlayback(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    // The WebRTC/native playback implementation invokes its queue flush here.
    // Keeping this explicit makes barge-in local-first and interruption-safe.
    resolve(nil)
  }
}
