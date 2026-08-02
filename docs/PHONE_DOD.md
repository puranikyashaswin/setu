# Phone PWA definition of done

Run on **iPhone Safari (tab + Add to Home Screen PWA)** and **Android Chrome (tab + Install app PWA)** against the deployed `https://` URL.

## Voice & mic

- [ ] `/voice-check?autorun=1` → tap once → speak close → overall **Ready** or **Almost**
- [ ] Main app: first orb tap greets once, then auto-listens
- [ ] Speak a turn → Setu replies → mic reopens without another tap
- [ ] Barge-in: speak during TTS → audio stops, new turn starts
- [ ] Background ~30s → return → speak again (AudioContext / mic recover)
- [ ] “I'm still here” appears after ~30s idle listening (once per session)

## PWA & deploy

- [ ] After a web deploy: **Update Setu** banner or force-quit and reopen PWA
- [ ] Offline / airplane mode: shell loads, voice shows network needed (no fake replies)
- [ ] `NEXT_PUBLIC_API_URL` is `https://` (mixed-content `ws://` breaks iPhone Safari)

## Document scan

- [ ] Scan a sample doc → ask a question grounded in the extracted text

## Platform notes

| Platform | Install | Mic / voice caveats |
|----------|---------|---------------------|
| iPhone Safari | Share → Add to Home Screen | No `webkitSpeechRecognition`; requires HTTPS + user gesture for mic |
| Android Chrome | Menu → Install app | Prefer installed PWA for stable mic / wake lock |

Demo link: `https://YOUR-APP.vercel.app/voice-check?autorun=1`
