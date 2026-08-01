import { voiceClientLog } from "@/lib/debug";

export type VadLevelsSnapshot = {
  turn_id: number;
  rms_max: number;
  rms_avg: number;
  threshold: number;
  frames_over_threshold: number;
};

/** Sample RMS ~every 100ms; emit vad_levels once per second during a listen window. */
export class VadLevelTelemetry {
  private windowStart = 0;
  private lastSampleAt = 0;
  private sampleSum = 0;
  private sampleCount = 0;
  private sampleMax = 0;
  private framesOverThreshold = 0;

  constructor(private readonly turnId: number) {}

  onFrame(rms: number, threshold: number, now: number): void {
    if (this.windowStart === 0) this.windowStart = now;
    if (rms >= threshold) this.framesOverThreshold += 1;

    if (this.lastSampleAt === 0 || now - this.lastSampleAt >= 100) {
      this.lastSampleAt = now;
      this.sampleSum += rms;
      this.sampleCount += 1;
      this.sampleMax = Math.max(this.sampleMax, rms);
    }

    if (now - this.windowStart >= 1000) {
      this.emit(threshold);
      this.resetWindow(now);
    }
  }

  flush(threshold: number): void {
    if (this.sampleCount === 0 && this.framesOverThreshold === 0) return;
    this.emit(threshold);
  }

  private emit(threshold: number): void {
    const rms_avg = this.sampleCount > 0 ? this.sampleSum / this.sampleCount : 0;
    const snapshot: VadLevelsSnapshot = {
      turn_id: this.turnId,
      rms_max: Number(this.sampleMax.toFixed(4)),
      rms_avg: Number(rms_avg.toFixed(4)),
      threshold: Number(threshold.toFixed(4)),
      frames_over_threshold: this.framesOverThreshold,
    };
    console.info(
      `[audio] vad_levels turn_id=${snapshot.turn_id} rms_max=${snapshot.rms_max} rms_avg=${snapshot.rms_avg} threshold=${snapshot.threshold} frames_over_threshold=${snapshot.frames_over_threshold}`,
    );
    voiceClientLog("vad_levels", snapshot);
  }

  private resetWindow(now: number): void {
    this.windowStart = now;
    this.lastSampleAt = 0;
    this.sampleSum = 0;
    this.sampleCount = 0;
    this.sampleMax = 0;
    this.framesOverThreshold = 0;
  }
}
