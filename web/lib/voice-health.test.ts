/// <reference types="node" />
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HEALTH_STEPS,
  autorunVoiceCheckPath,
  buildHealthReport,
  formatHealthReportText,
  parseAutorunFlag,
  scoreApiUrlConfig,
  scoreMicSample,
  scoreOverall,
  stripAutorunFromSearch,
} from "./voice-health";

describe("voice health scoring", () => {
  it("scores close-talk mic sample as pass", () => {
    const r = scoreMicSample({ frames: 80, rmsMax: 0.08, rmsAvg: 0.03 });
    assert.equal(r.status, "pass");
  });

  it("warns on soft speech / room tone", () => {
    assert.equal(scoreMicSample({ frames: 80, rmsMax: 0.015, rmsAvg: 0.006 }).status, "warn");
    assert.equal(scoreMicSample({ frames: 80, rmsMax: 0.004, rmsAvg: 0.003 }).status, "warn");
  });

  it("fails on dead worklet or muted mic", () => {
    assert.equal(scoreMicSample({ frames: 2, rmsMax: 0.1, rmsAvg: 0.05 }).status, "fail");
    assert.equal(scoreMicSample({ frames: 80, rmsMax: 0.0005, rmsAvg: 0.0002 }).status, "fail");
  });

  it("flags http API on https page (iPhone mixed content)", () => {
    const r = scoreApiUrlConfig("http://setu-api.onrender.com", true);
    assert.equal(r.status, "fail");
    assert.match(r.detail, /mixed-content/i);
  });

  it("allows https API and localhost", () => {
    assert.equal(scoreApiUrlConfig("https://setu-api.onrender.com", true).status, "pass");
    assert.equal(scoreApiUrlConfig("http://localhost:8000", true).status, "pass");
  });

  it("overall fail if any check fails; tips included", () => {
    const report = buildHealthReport([
      { id: "api", label: "API", status: "fail", detail: "timeout" },
      { id: "mic", label: "Mic", status: "pass", detail: "ok" },
    ]);
    assert.equal(scoreOverall(report.checks), "fail");
    assert.equal(report.overall, "fail");
    assert.ok(report.tips.some((t) => /Wake the API|Render/i.test(t)));
    assert.match(formatHealthReportText(report), /FAIL\s+API/);
  });

  it("includes env block when snapshot is present", () => {
    const report = buildHealthReport(
      [{ id: "api", label: "API", status: "pass", detail: "ok" }],
      {
        ua: "TestUA",
        platform: "iPhone",
        secure: true,
        sw: "controlled",
        viewport: "390x844",
        apiUrl: "https://api.example.com",
      },
    );
    const text = formatHealthReportText(report);
    assert.match(text, /Env:/);
    assert.match(text, /iPhone/);
    assert.match(text, /TestUA/);
    assert.ok(HEALTH_STEPS.length >= 6);
  });

  it("parses autorun deep-link and strips the flag", () => {
    assert.equal(parseAutorunFlag("?autorun=1"), true);
    assert.equal(parseAutorunFlag("autorun=true&x=1"), true);
    assert.equal(parseAutorunFlag("?autorun=0"), false);
    assert.equal(parseAutorunFlag(""), false);
    assert.equal(autorunVoiceCheckPath(), "/voice-check?autorun=1");
    assert.equal(stripAutorunFromSearch("?autorun=1&lang=hi"), "?lang=hi");
    assert.equal(stripAutorunFromSearch("?autorun=1"), "");
  });
});
