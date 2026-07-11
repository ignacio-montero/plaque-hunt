"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type {
  AlreadyCapturedError,
  CaptureMatchResponse,
  ConfirmRequest,
  ConfirmResponse,
  MatchCandidate,
  MatchMethod,
  PlaqueListItem,
} from "./types";
import ManualSearch from "./ManualSearch";

type Coords = { lat: number; lng: number } | null;
type GeoStatus = "idle" | "requesting" | "granted" | "denied" | "unsupported";

// The flow moves through these steps. Kept explicit so loading/empty/error
// states are impossible to skip.
type Step =
  | "select" // choosing a photo + requesting location
  | "matching" // POST /api/capture in flight
  | "review" // candidates shown, user confirms or corrects
  | "confirming" // POST /api/capture/confirm in flight
  | "done" // capture written
  | "already"; // 409 — plaque already captured

// A pick can come from a ranked candidate or from manual search; we normalise
// both to { plaque_id, subject_name } plus the method used to reach it.
interface Selection {
  plaque_id: string;
  subject_name: string;
  method: MatchMethod;
}

export default function CaptureFlow() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [coords, setCoords] = useState<Coords>(null);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("idle");

  const [step, setStep] = useState<Step>("select");
  const [match, setMatch] = useState<CaptureMatchResponse | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noMatch, setNoMatch] = useState(false); // 422: OCR found nothing
  const [showManual, setShowManual] = useState(false);

  const [confirmed, setConfirmed] = useState<ConfirmResponse["capture"] | null>(
    null,
  );
  const [existingCaptureId, setExistingCaptureId] = useState<string | null>(
    null,
  );
  const [existingPlaqueId, setExistingPlaqueId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Guards against a synchronous double-click firing two confirm POSTs before
  // React re-renders (the server also maps the resulting race to a clean 409).
  const submittingRef = useRef(false);

  const resetAll = useCallback(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(null);
    setStep("select");
    setMatch(null);
    setSelection(null);
    setError(null);
    setNoMatch(false);
    setShowManual(false);
    setConfirmed(null);
    setExistingCaptureId(null);
    setExistingPlaqueId(null);
  }, [previewUrl]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(f);
    setPreviewUrl(f ? URL.createObjectURL(f) : null);
  };

  const requestLocation = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoStatus("unsupported");
      return;
    }
    setGeoStatus("requesting");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGeoStatus("granted");
      },
      () => {
        setCoords(null);
        setGeoStatus("denied");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, []);

  // Step 1 → 2: upload the photo (+ location if granted) for OCR + matching.
  const runMatch = useCallback(async () => {
    if (!file) return;
    setStep("matching");
    setError(null);
    setNoMatch(false);

    const form = new FormData();
    form.append("photo", file);
    if (coords) {
      form.append("lat", String(coords.lat));
      form.append("lng", String(coords.lng));
    }

    try {
      // Hard client-side timeout: if the server ever wedges mid-OCR (seen in
      // v1.0.0 when a broken worker never settled the request), fail with a
      // clear message instead of spinning on "Reading photo…" forever. 120 s
      // comfortably covers a slow OCR on the homelab box (server caps at 90 s).
      const res = await fetch("/api/capture", {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(120_000),
      });

      if (res.status === 422) {
        setNoMatch(true);
        setShowManual(true);
        setMatch({
          ocr_raw_text: "",
          location_used: !!coords,
          photo_token: "",
          candidates: [],
        });
        // Try to salvage a photo_token if the server returned one.
        try {
          const body = await res.json();
          if (body?.photo_token) {
            setMatch((m) =>
              m ? { ...m, photo_token: body.photo_token } : m,
            );
          }
          if (typeof body?.ocr_raw_text === "string") {
            setMatch((m) =>
              m ? { ...m, ocr_raw_text: body.ocr_raw_text } : m,
            );
          }
        } catch {
          /* 422 may have no body */
        }
        setStep("review");
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Upload failed (HTTP ${res.status})`);
      }

      const data: CaptureMatchResponse = await res.json();
      setMatch(data);
      const top = data.candidates?.[0];
      if (top) {
        setSelection({
          plaque_id: top.plaque_id,
          subject_name: top.subject_name,
          method: "top_match_accepted",
        });
      }
      setShowManual(!data.candidates || data.candidates.length === 0);
      setStep("review");
    } catch (err) {
      const timedOut =
        err instanceof DOMException &&
        (err.name === "TimeoutError" || err.name === "AbortError");
      setError(
        timedOut
          ? "Reading the photo took too long. Check your connection and try again — a smaller photo may help."
          : err instanceof Error
            ? err.message
            : "Something went wrong uploading.",
      );
      setStep("select");
    }
  }, [file, coords]);

  const pickCandidate = (c: MatchCandidate, index: number) => {
    setSelection({
      plaque_id: c.plaque_id,
      subject_name: c.subject_name,
      // The first (top-ranked) candidate accepted = top_match_accepted;
      // any other ranked candidate = runner_up_selected.
      method: index === 0 ? "top_match_accepted" : "runner_up_selected",
    });
  };

  const pickManual = (p: PlaqueListItem) => {
    setSelection({
      plaque_id: p.id,
      subject_name: p.subject_name,
      method: "manual_search",
    });
    setShowManual(false);
  };

  // Step 3: write the capture.
  const confirm = useCallback(async () => {
    if (!selection || !match) return;
    if (submittingRef.current) return; // ignore rapid double-clicks
    if (!match.photo_token) {
      setError(
        "The photo token is missing, so this capture can't be saved. Please re-upload the photo.",
      );
      return;
    }
    submittingRef.current = true;
    setStep("confirming");
    setError(null);

    const candidate = match.candidates.find(
      (c) => c.plaque_id === selection.plaque_id,
    );

    const body: ConfirmRequest = {
      plaque_id: selection.plaque_id,
      photo_token: match.photo_token,
      ocr_raw_text: match.ocr_raw_text,
      match_confidence: candidate?.match_confidence ?? 0,
      match_method: selection.method,
      ...(coords ? { user_lat: coords.lat, user_lng: coords.lng } : {}),
    };

    try {
      const res = await fetch("/api/capture/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 409) {
        const data: AlreadyCapturedError = await res.json();
        setExistingCaptureId(data.capture?.id ?? null);
        setExistingPlaqueId(data.capture?.plaque_id ?? selection.plaque_id);
        setStep("already");
        return;
      }

      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || `Confirm failed (HTTP ${res.status})`);
      }

      const data: ConfirmResponse = await res.json();
      setConfirmed(data.capture);
      setStep("done");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't save the capture.",
      );
      setStep("review");
    } finally {
      submittingRef.current = false;
    }
  }, [selection, match, coords]);

  // Undo/delete the just-created capture.
  const undo = useCallback(async () => {
    if (!confirmed) return;
    try {
      const res = await fetch(
        `/api/capture/${encodeURIComponent(confirmed.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 404) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || `Delete failed (HTTP ${res.status})`);
      }
      resetAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't undo capture.");
    }
  }, [confirmed, resetAll]);

  const geoLabel = useMemo(() => {
    switch (geoStatus) {
      case "granted":
        return coords
          ? `Location on (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`
          : "Location on";
      case "requesting":
        return "Requesting location…";
      case "denied":
        return "Location denied — matching by text only";
      case "unsupported":
        return "Geolocation not supported — matching by text only";
      default:
        return "Location not requested yet";
    }
  }, [geoStatus, coords]);

  // ----- RENDER -----

  if (step === "done" && confirmed) {
    return (
      <div className="page">
        <div className="card stack">
          <div className="notice notice--info" role="status">
            Captured! This plaque is now marked as found.
          </div>
          {previewUrl && (
            <img className="photo-preview" src={previewUrl} alt="Your capture" />
          )}
          <div className="stack">
            <a
              href="/tracker"
              className="btn btn--primary btn--block"
            >
              See updated tracker
            </a>
            <a href="/" className="btn btn--block">
              Back to map
            </a>
            <button
              type="button"
              className="btn btn--danger btn--block"
              onClick={undo}
            >
              Undo this capture (wrong plaque?)
            </button>
          </div>
          {error && (
            <div className="notice notice--error" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (step === "already") {
    return (
      <div className="page">
        <div className="card stack">
          <div className="notice notice--warn" role="status">
            You&apos;ve already captured this plaque — no duplicate was created.
          </div>
          <div className="stack">
            {existingPlaqueId && (
              <a
                href={`/?plaque=${encodeURIComponent(existingPlaqueId)}`}
                className="btn btn--primary btn--block"
              >
                View it on the map
              </a>
            )}
            <button
              type="button"
              className="btn btn--block"
              onClick={() => setStep("review")}
            >
              Pick a different plaque
            </button>
            <button
              type="button"
              className="btn btn--block"
              onClick={resetAll}
            >
              Start over
            </button>
          </div>
          {existingCaptureId && (
            <p className="muted" style={{ fontSize: 12 }}>
              Existing capture: {existingCaptureId}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page stack">
      <h1 style={{ margin: "4px 0" }}>Capture a plaque</h1>

      {/* Step 1: photo + location */}
      <div className="card stack">
        <div>
          <label className="section-title" htmlFor="photo-input">
            1. Photo of the plaque
          </label>
          <input
            id="photo-input"
            ref={fileInputRef}
            className="input"
            type="file"
            accept="image/*"
            onChange={onFileChange}
            disabled={step === "matching"}
          />
        </div>

        {previewUrl && (
          <img
            className="photo-preview"
            src={previewUrl}
            alt="Selected plaque photo preview"
          />
        )}

        <div className="stack">
          <div className="section-title">2. Location (improves matching)</div>
          <div className="notice notice--info">{geoLabel}</div>
          <button
            type="button"
            className="btn btn--block"
            onClick={requestLocation}
            disabled={geoStatus === "requesting"}
          >
            {geoStatus === "granted"
              ? "Refresh location"
              : "Use my current location"}
          </button>
        </div>

        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={runMatch}
          disabled={!file || step === "matching"}
        >
          {step === "matching" ? (
            <>
              <span className="spinner" aria-hidden /> Reading photo…
            </>
          ) : (
            "3. Identify plaque"
          )}
        </button>

        {error && step === "select" && (
          <div className="notice notice--error" role="alert">
            {error}
          </div>
        )}
      </div>

      {/* Step 2: review candidates / confirm / correct */}
      {step === "review" && match && (
        <div className="card stack">
          <div className="section-title">Is this the right plaque?</div>

          {match.ocr_raw_text && (
            <div className="notice notice--info">
              <strong>Text read:</strong> {match.ocr_raw_text}
            </div>
          )}

          {!match.location_used && (
            <div className="notice notice--warn">
              No location was used, so matching is by text only and may be less
              accurate. Double-check the pick below or search manually.
            </div>
          )}

          {noMatch && (
            <div className="notice notice--warn" role="alert">
              Couldn&apos;t read enough text to suggest a match. Search for the
              plaque manually below.
            </div>
          )}

          {match.candidates.length > 0 && (
            <div className="stack" role="radiogroup" aria-label="Candidates">
              {match.candidates.map((c, i) => {
                const isSel = selection?.plaque_id === c.plaque_id;
                return (
                  <button
                    key={c.plaque_id}
                    type="button"
                    role="radio"
                    aria-checked={isSel}
                    className={`candidate ${
                      isSel ? "candidate--selected" : ""
                    }`}
                    onClick={() => pickCandidate(c, i)}
                  >
                    <span className="candidate__conf">
                      {Math.round(c.match_confidence * 100)}%
                    </span>
                    <span className="candidate__body">
                      <span className="candidate__name">
                        {c.subject_name}
                        {i === 0 && (
                          <span
                            className="muted"
                            style={{ fontWeight: 400, fontSize: 12 }}
                          >
                            {" "}
                            · best match
                          </span>
                        )}
                      </span>
                      <span className="candidate__meta">
                        {c.distance_m != null
                          ? `${Math.round(c.distance_m)} m away`
                          : "distance unknown"}
                        {c.already_captured && " · already captured"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Warn if the currently-selected plaque is already captured. */}
          {selection &&
            match.candidates.find(
              (c) => c.plaque_id === selection.plaque_id,
            )?.already_captured && (
              <div className="notice notice--warn">
                You&apos;ve already captured “{selection.subject_name}”.
                Confirming again will report it as a duplicate.
              </div>
            )}

          <button
            type="button"
            style={{
              background: "none",
              border: "none",
              color: "var(--plaque-blue)",
              font: "inherit",
              fontWeight: 600,
              cursor: "pointer",
              padding: "4px 0",
              textAlign: "left",
            }}
            onClick={() => setShowManual((s) => !s)}
          >
            {showManual
              ? "Hide manual search"
              : "None of these — search manually"}
          </button>

          {showManual && <ManualSearch onPick={pickManual} />}

          {selection && (
            <div className="notice notice--info">
              Selected: <strong>{selection.subject_name}</strong>
            </div>
          )}

          {error && (
            <div className="notice notice--error" role="alert">
              {error}
            </div>
          )}

          <div className="stack">
            <button
              type="button"
              className="btn btn--success btn--block"
              onClick={confirm}
              disabled={!selection}
            >
              Confirm capture
            </button>
            <button
              type="button"
              className="btn btn--block"
              onClick={resetAll}
            >
              Start over
            </button>
          </div>
        </div>
      )}

      {step === "confirming" && (
        <div className="card">
          <p className="muted">
            <span className="spinner" aria-hidden /> Saving capture…
          </p>
        </div>
      )}
    </div>
  );
}
