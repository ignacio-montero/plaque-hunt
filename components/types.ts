// Shared frontend types — mirror the shapes in docs/API_SPEC.md.
// Kept under components/ (frontend owns this; lib/ belongs to the backend).

/** Lightweight plaque record from GET /api/plaques (map markers). */
export interface PlaqueListItem {
  id: string;
  subject_name: string;
  address: string;
  latitude: number;
  longitude: number;
  scheme: string;
  captured: boolean;
}

export interface PlaquesResponse {
  plaques: PlaqueListItem[];
}

/** Capture summary embedded in a plaque detail. */
export interface CaptureSummary {
  id: string;
  photo_path: string;
  captured_at: string;
}

/** Full plaque detail from GET /api/plaques/:id. */
export interface PlaqueDetail {
  id: string;
  subject_name: string;
  inscription_text: string;
  profession: string | null;
  gender: string | null;
  birth_year: number | null;
  death_year: number | null;
  subject_image_url: string | null;
  scheme: string;
  address: string;
  latitude: number;
  longitude: number;
  captured: boolean;
  capture: CaptureSummary | null;
}

/** A ranked candidate returned by POST /api/capture. */
export interface MatchCandidate {
  plaque_id: string;
  subject_name: string;
  match_confidence: number;
  distance_m: number | null;
  already_captured: boolean;
}

/** Successful (200) response from POST /api/capture. */
export interface CaptureMatchResponse {
  ocr_raw_text: string;
  location_used: boolean;
  photo_token: string;
  candidates: MatchCandidate[];
}

export type MatchMethod =
  | "top_match_accepted"
  | "runner_up_selected"
  | "manual_search";

/** Request body for POST /api/capture/confirm. */
export interface ConfirmRequest {
  plaque_id: string;
  photo_token: string;
  ocr_raw_text: string;
  match_confidence: number;
  match_method: MatchMethod;
  user_lat?: number;
  user_lng?: number;
}

/** 201 response from POST /api/capture/confirm. */
export interface ConfirmResponse {
  capture: {
    id: string;
    plaque_id: string;
    photo_path: string;
    captured_at: string;
  };
}

/** 409 body from POST /api/capture/confirm (already captured). */
export interface AlreadyCapturedError {
  error: "already_captured";
  capture: { id: string; plaque_id: string };
}

/** A single labelled aggregate row in the tracker. */
export interface TrackerBucket {
  label: string;
  count: number;
}

/** GET /api/tracker response. */
export interface TrackerResponse {
  total_plaques: number;
  total_captured: number;
  by_profession: TrackerBucket[];
  by_birth_decade: TrackerBucket[];
  by_gender: TrackerBucket[];
}
