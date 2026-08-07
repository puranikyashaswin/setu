package com.setu.audio

import android.media.AudioManager
import android.media.AudioFocusRequest
import android.media.AudioAttributes
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class SetuAudioModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val audioManager = context.getSystemService(ReactApplicationContext.AUDIO_SERVICE) as AudioManager
    private var focusRequest: AudioFocusRequest? = null

    override fun getName(): String = "SetuAudio"

    @ReactMethod
    fun startSession(promise: Promise) {
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        audioManager.isSpeakerphoneOn = true
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).build())
                .setOnAudioFocusChangeListener { change ->
                    if (change <= AudioManager.AUDIOFOCUS_LOSS) {
                        context.getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                            .emit("SetuAudioRouteChanged", mapOf("route" to "audio_focus", "interrupted" to true))
                    }
                }
                .build()
            audioManager.requestAudioFocus(focusRequest!!)
        }
        promise.resolve(null)
    }

    @ReactMethod
    fun stopSession(promise: Promise) {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            focusRequest = null
        }
        audioManager.mode = AudioManager.MODE_NORMAL
        promise.resolve(null)
    }

    @ReactMethod
    fun flushPlayback(promise: Promise) {
        // The native WebRTC audio track owns the playback queue; this method is
        // the explicit local-first interruption seam for the production module.
        promise.resolve(null)
    }
}
