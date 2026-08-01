import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyScanEvent,
  initialScanUiState,
  parseScanNdjsonLine,
  reduceScanNdjson,
} from "./scan-events";

describe("scan-events parser", () => {
  it("handles done and clears analyzing", () => {
    const state = reduceScanNdjson(
      [
        '{"type":"progress","stage":"upload_received","percent":5}',
        '{"type":"progress","stage":"ocr_polling","percent":40}',
        '{"type":"done","doc_id":"abc","pages":1,"cached":false}',
      ].join("\n"),
    );
    assert.equal(state.analyzing, false);
    assert.equal(state.outcome, "done");
    assert.equal(state.docId, "abc");
    assert.equal(state.pages, 1);
  });

  it("handles timeout and clears analyzing", () => {
    let state = initialScanUiState();
    state = applyScanEvent(state, { type: "progress", stage: "ocr_started", percent: 20 });
    assert.equal(state.analyzing, true);
    state = applyScanEvent(state, {
      type: "timeout",
      detail: "Document analysis is taking too long. Please retry with a clearer photo.",
    });
    assert.equal(state.analyzing, false);
    assert.equal(state.outcome, "timeout");
    assert.match(state.detail || "", /too long/i);
  });

  it("handles error and clears analyzing", () => {
    const event = parseScanNdjsonLine('{"type":"error","detail":"Provider rejected image"}');
    assert.ok(event);
    const state = applyScanEvent(
      { ...initialScanUiState(), analyzing: true, outcome: "analyzing" },
      event!,
    );
    assert.equal(state.analyzing, false);
    assert.equal(state.outcome, "error");
    assert.equal(state.detail, "Provider rejected image");
  });
});
