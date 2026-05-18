import { useEffect, useRef, useState } from "react";
import { apiJson, getOrCreateTabToken, usePageMeta } from "./app-shared";
import "./workspace.css";

const SCREEN_AUDIO_PROCESSOR_BUFFER_SIZE = 2048;
const INSIGHTS_NEW_QUESTION_VIEWPORT_OFFSET_RATIO = 0.25;
const WORKSPACE_PANEL_RESIZE_STORAGE_KEY = "voxscribe-workspace-left-panel-width";
const WORKSPACE_SNAPSHOT_STORAGE_KEY_PREFIX = "voxscribe-workspace-snapshot";
const WORKSPACE_PANEL_RESIZE_BREAKPOINT = 1120;
const WORKSPACE_LEFT_PANEL_DEFAULT_WIDTH = 520;
const WORKSPACE_LEFT_PANEL_MIN_WIDTH = 340;
const WORKSPACE_RIGHT_PANEL_MIN_WIDTH = 420;
const WORKSPACE_SPLITTER_WIDTH = 18;
const COMPOSER_IMAGE_LIMIT = 8;
const COMPOSER_ALLOWED_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);

function createDefaultActivityMessage() {
  return {
    text: "Please share your screen, Let's go...",
    type: "info",
  };
}

const SEVEN_SEGMENT_ACTIVE_SEGMENTS = {
  "0": ["a", "b", "c", "d", "e", "f"],
  "1": ["b", "c"],
  "2": ["a", "b", "g", "e", "d"],
  "3": ["a", "b", "g", "c", "d"],
  "4": ["f", "g", "b", "c"],
  "5": ["a", "f", "g", "c", "d"],
  "6": ["a", "f", "g", "e", "c", "d"],
  "7": ["a", "b", "c"],
  "8": ["a", "b", "c", "d", "e", "f", "g"],
  "9": ["a", "b", "c", "d", "f", "g"],
};

function SevenSegmentTime({ value }) {
  const text = String(value ?? "");
  const segmentKeys = ["a", "b", "c", "d", "e", "f", "g"];

  return (
    <span className="workspace-seven-seg" aria-label={text}>
      {Array.from(text).map((char, index) => {
        if (char === ":") {
          return (
            <span key={`colon-${index}`} className="workspace-seven-seg-colon" aria-hidden="true">
              <span className="workspace-seven-seg-dot" />
              <span className="workspace-seven-seg-dot" />
            </span>
          );
        }

        const activeSegments = SEVEN_SEGMENT_ACTIVE_SEGMENTS[char] || [];

        return (
          <span key={`digit-${index}-${char}`} className="workspace-seven-seg-digit" aria-hidden="true">
            {segmentKeys.map((segment) => (
              <span
                key={segment}
                className={`workspace-seven-seg-segment workspace-seven-seg-${segment}${
                  activeSegments.includes(segment) ? " on" : ""
                }`}
              />
            ))}
          </span>
        );
      })}
    </span>
  );
}

function getWorkspaceSnapshotStorageKey() {
  if (typeof window === "undefined") {
    return "";
  }

  const tabToken = getOrCreateTabToken();
  return `${WORKSPACE_SNAPSHOT_STORAGE_KEY_PREFIX}:${tabToken || "default"}`;
}

function readWorkspaceSnapshot() {
  if (typeof window === "undefined") {
    return null;
  }

  const storageKey = getWorkspaceSnapshotStorageKey();
  if (!storageKey) {
    return null;
  }

  try {
    const rawSnapshot = window.sessionStorage.getItem(storageKey);
    if (!rawSnapshot) {
      return null;
    }

    const parsedSnapshot = JSON.parse(rawSnapshot);
    return parsedSnapshot && typeof parsedSnapshot === "object" ? parsedSnapshot : null;
  } catch {
    return null;
  }
}

function writeWorkspaceSnapshot(snapshot) {
  if (typeof window === "undefined") {
    return;
  }

  const storageKey = getWorkspaceSnapshotStorageKey();
  if (!storageKey) {
    return;
  }

  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(snapshot));
  } catch {
    // Ignore storage quota and serialization failures.
  }
}

function clearWorkspaceSnapshot() {
  if (typeof window === "undefined") {
    return;
  }

  const storageKey = getWorkspaceSnapshotStorageKey();
  if (!storageKey) {
    return;
  }

  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Ignore storage cleanup failures.
  }
}

function clampWorkspaceLeftPanelWidth(width, containerWidth) {
  const normalizedWidth = Number(width) || WORKSPACE_LEFT_PANEL_DEFAULT_WIDTH;
  const maxWidth = Math.max(
    WORKSPACE_LEFT_PANEL_MIN_WIDTH,
    Number(containerWidth || 0) - WORKSPACE_RIGHT_PANEL_MIN_WIDTH - WORKSPACE_SPLITTER_WIDTH,
  );

  return Math.min(Math.max(normalizedWidth, WORKSPACE_LEFT_PANEL_MIN_WIDTH), maxWidth);
}

function formatDuration(totalSeconds) {
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function getDisplaySurfaceType(stream) {
  const [videoTrack] = stream?.getVideoTracks?.() || [];

  if (!videoTrack || typeof videoTrack.getSettings !== "function") {
    return "";
  }

  return String(videoTrack.getSettings().displaySurface || "").toLowerCase();
}

function getTranscriptBackendBaseUrl() {
  const configuredUrl =
    import.meta.env.VITE_TRANSCRIPT_API_URL || import.meta.env.VITE_TRANSCRIPT_BACKEND_URL;

  if (configuredUrl) {
    return String(configuredUrl).replace(/\/+$/, "");
  }

  return "";
}

function getTranscriptWebSocketUrl(pathname = "/api/transcript/ws") {
  const configuredUrl = getTranscriptBackendBaseUrl();

  if (configuredUrl) {
    const websocketUrl = new URL(pathname, `${configuredUrl}/`);
    websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
    return websocketUrl.toString();
  }

  const websocketUrl = new URL(pathname, window.location.href);
  websocketUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return websocketUrl.toString();
}

function getPreferredScreenShareConstraints() {
  return {
    video: true,
    audio: {
      suppressLocalAudioPlayback: false,
    },
    monitorTypeSurfaces: "exclude",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
    systemAudio: "exclude",
    windowAudio: "window",
  };
}

function getFallbackScreenShareConstraints() {
  return {
    video: true,
    audio: true,
  };
}

function isRetryableScreenShareConstraintError(error) {
  const errorName = String(error?.name || "");

  return (
    errorName === "TypeError" ||
    errorName === "OverconstrainedError" ||
    errorName === "NotSupportedError"
  );
}

function getScreenShareErrorMessage(error) {
  const errorName = String(error?.name || "");

  if (errorName === "NotAllowedError" || errorName === "AbortError") {
    return "Screen share was cancelled.";
  }

  if (errorName === "NotReadableError") {
    return "The selected screen source is busy or blocked by the system.";
  }

  if (errorName === "SecurityError") {
    return "Screen sharing is blocked by this browser security context.";
  }

  if (errorName === "TypeError" || errorName === "OverconstrainedError" || errorName === "NotSupportedError") {
    return "This browser does not support the requested screen-sharing audio options.";
  }

  const message = String(error?.message || "").trim();
  return message || "Unable to start screen share.";
}

function normalizeDomainValue(value = "") {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function isInsightsBulletLine(text = "") {
  return /^([-*•]\s+|\d+[.)]\s+)/.test(String(text || "").trim());
}

function isInsightsQuestionLine(text = "") {
  return /^\s*Q\d+:/i.test(String(text || ""));
}

function isInsightsMarkdownHeadingLine(text = "") {
  return /^\s*#{1,2}\s+\S/.test(String(text || ""));
}

function isInsightsMarkdownSubheadingLine(text = "") {
  return /^\s*###\s+\S/.test(String(text || ""));
}

function isInsightsStandaloneHeadingLine(text = "") {
  const trimmed = String(text || "").trim();

  if (!trimmed || isInsightsQuestionLine(trimmed) || isInsightsBulletLine(trimmed)) {
    return false;
  }

  if (/[.!?]$/.test(trimmed) || trimmed.length > 80) {
    return false;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);

  if (!words.length || words.length > 8) {
    return false;
  }

  const headingLikeWordCount = words.filter((word) => /^[A-Z0-9][A-Za-z0-9/&()+-]*$/.test(word)).length;
  return headingLikeWordCount >= Math.max(1, Math.ceil(words.length * 0.6));
}

function isInsightsStandaloneSubheadingLine(text = "") {
  const trimmed = String(text || "").trim();

  if (!trimmed || isInsightsQuestionLine(trimmed) || isInsightsBulletLine(trimmed) || !trimmed.endsWith(":")) {
    return false;
  }

  return isInsightsStandaloneHeadingLine(trimmed.slice(0, -1));
}

function getInsightsHighlightLines(text = "") {
  return String(text || "")
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();

      if (isInsightsQuestionLine(trimmed)) {
        return {
          type: "question",
          text: line,
          questionId: getQuestionIdFromInsightsText(trimmed) || undefined,
        };
      }

      if (isInsightsMarkdownSubheadingLine(line) || isInsightsStandaloneSubheadingLine(line)) {
        return { type: "subheading", text: line };
      }

      if (isInsightsMarkdownHeadingLine(line) || isInsightsStandaloneHeadingLine(line)) {
        return { type: "heading", text: line };
      }

      return { type: "plain", text: line };
    });
}

function isAllowedComposerImage(file) {
  if (!file) {
    return false;
  }

  const extension = getFileExtension(file.name);
  if (COMPOSER_ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
    return true;
  }

  const mimeType = String(file.type || "").toLowerCase();
  return mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp";
}

function getQuestionIdFromInsightsText(text = "") {
  const match = String(text || "").match(/^\s*(Q\d+):/);
  return match ? match[1] : "";
}

function createTranscriptLine(transcript, speakerLabel = "") {
  return speakerLabel ? `${speakerLabel}: ${transcript}` : transcript;
}

function joinTranscriptSegments(transcriptLines) {
  let joinedText = "";

  for (const line of transcriptLines) {
    const text = String(line || "").trim();

    if (!text) {
      continue;
    }

    joinedText = joinedText ? `${joinedText} ${text}` : text;
  }

  return joinedText;
}

function getFileExtension(filename = "") {
  const parts = String(filename).toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

function formatFileSize(bytes = 0) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function isAllowedTranscriptFile(file) {
  if (!file) {
    return false;
  }

  const allowedExtensions = new Set(["doc", "docx", "pdf"]);
  return allowedExtensions.has(getFileExtension(file.name));
}

function getComposerFileLabel(file) {
  if (!file) {
    return "";
  }

  const filename = String(file.name || "").trim();

  if (filename) {
    return filename;
  }

  const rawSubtype = String(file.type || "").split("/")[1] || "png";
  const normalizedSubtype = rawSubtype.split(/[+;]/)[0].replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  return `pasted-image.${normalizedSubtype}`;
}

function clampComposerImageFiles(files = []) {
  return Array.isArray(files) ? files.slice(0, COMPOSER_IMAGE_LIMIT) : [];
}

function summarizeQuestionText(text = "", fallback = "Untitled request") {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return fallback;
  }

  return normalized.length > 96 ? `${normalized.slice(0, 93).trimEnd()}...` : normalized;
}

function buildQuestionLabel(questionId, summary) {
  const normalizedSummary = summarizeQuestionText(summary, "Untitled request");
  return `${String(questionId || "").trim()} : ${normalizedSummary}`;
}

function buildQuestionEntryText(questionId, promptText, attachmentNames = []) {
  const lines = [`${String(questionId || "").trim()}: ${String(promptText || "").trim()}`];

  if (attachmentNames.length) {
    lines.push(`Uploaded image${attachmentNames.length === 1 ? "" : "s"}: ${attachmentNames.join(", ")}`);
  }

  return lines.join("\n");
}

function buildComposerQueryText(message = "", imageCount = 0) {
  const normalizedMessage = String(message || "").trim();

  if (normalizedMessage) {
    return normalizedMessage;
  }

  return imageCount === 1
    ? "Analyze the uploaded image and answer based on its contents."
    : "Analyze the uploaded images and answer based on their contents.";
}

function resolveThemeColor(cssVariableName) {
  if (typeof window === "undefined" || !cssVariableName) {
    return `var(${cssVariableName})`;
  }

  const value = window.getComputedStyle(document.documentElement).getPropertyValue(cssVariableName).trim();
  return value || `var(${cssVariableName})`;
}

function getInsightsLineInlineStyle(lineType = "plain") {
  if (lineType === "question") {
    return {
      color: resolveThemeColor("--primary"),
      fontWeight: 700,
      fontFamily: 'Bahnschrift, "Segoe UI", sans-serif',
      fontSize: "24px",
    };
  }

  if (lineType === "heading") {
    return {
      color: resolveThemeColor("--warning"),
      fontWeight: 700,
      fontSize: "20px",
      lineHeight: "var(--workspace-insights-line-height-px)",
    };
  }

  if (lineType === "subheading") {
    return {
      color: resolveThemeColor("--success"),
      fontWeight: 700,
      fontSize: "20px",
      lineHeight: "var(--workspace-insights-line-height-px)",
    };
  }

  return undefined;
}

function getProfileInitials(email = "") {
  const normalized = String(email).trim();

  if (!normalized) {
    return "LP";
  }

  const [localPart] = normalized.split("@");
  const pieces = localPart.split(/[._-]+/).filter(Boolean);

  if (pieces.length >= 2) {
    return `${pieces[0][0]}${pieces[1][0]}`.toUpperCase();
  }

  return normalized.slice(0, 2).toUpperCase();
}

function sanitizeDownloadLabel(value = "", fallback = "export") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function buildGeneratedQuestionsDownloadText(questions = []) {
  const questionLines = ["Questions", ""];
  const questionAnswerLines = ["Q&A", ""];

  questions.forEach((question, index) => {
    const fallbackId = `Q${index + 1}`;
    const questionText = String(question?.text || question?.label || question?.id || fallbackId).trim() || fallbackId;
    const answerText = String(question?.answer || "").trim();
    const errorText = String(question?.error || "").trim();
    const exportAnswerText =
      answerText && errorText
        ? `${answerText}\n\n[Generation error] ${errorText}`
        : answerText || errorText || "[No generated answer available]";

    questionLines.push(questionText);
    questionAnswerLines.push(questionText);
    questionAnswerLines.push("Answer:");
    questionAnswerLines.push(exportAnswerText);
    questionAnswerLines.push("");
  });

  return `${questionLines.join("\n").trim()}\n\n${questionAnswerLines.join("\n").trim()}`.trim();
}

function getActivityState(isListening, transcriptText) {
  if (isListening) {
    return "Listening";
  }

  if (String(transcriptText || "").trim()) {
    return "Stopped";
  }

  return "Idle";
}

function areCompatibleTranscriptTokens(tokenA = "", tokenB = "") {
  const normalizedA = String(tokenA).toLowerCase().trim();
  const normalizedB = String(tokenB).toLowerCase().trim();

  if (!normalizedA || !normalizedB) {
    return false;
  }

  if (normalizedA === normalizedB) {
    return true;
  }

  return normalizedB.startsWith(normalizedA);
}

function startsWithCompatibleTokenSequence(text = "", partial = "") {
  const normalizedText = String(text).toLowerCase().trim();
  const normalizedPartial = String(partial).toLowerCase().trim();

  if (!normalizedText || !normalizedPartial) {
    return false;
  }

  const partialTokens = normalizedPartial.split(/\s+/);
  const textTokens = normalizedText.split(/\s+/);

  if (partialTokens.length > textTokens.length) {
    return false;
  }

  for (let index = 0; index < partialTokens.length; index += 1) {
    if (!areCompatibleTranscriptTokens(partialTokens[index], textTokens[index])) {
      return false;
    }
  }

  return true;
}

function tokenizeTranscriptText(text = "") {
  return String(text)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function haveCompatibleTokenOverlap(baseTokens = [], incomingTokens = []) {
  const maxOverlap = Math.min(baseTokens.length, incomingTokens.length);

  for (let overlapSize = maxOverlap; overlapSize > 0; overlapSize -= 1) {
    let isCompatible = true;

    for (let index = 0; index < overlapSize; index += 1) {
      const baseToken = baseTokens[baseTokens.length - overlapSize + index];
      const incomingToken = incomingTokens[index];

      if (
        !areCompatibleTranscriptTokens(baseToken, incomingToken) &&
        !areCompatibleTranscriptTokens(incomingToken, baseToken)
      ) {
        isCompatible = false;
        break;
      }
    }

    if (isCompatible) {
      return overlapSize;
    }
  }

  return 0;
}

function mergeTranscriptText(currentText = "", incomingText = "", { preferIncomingOnMismatch = false } = {}) {
  const current = String(currentText).trim();
  const incoming = String(incomingText).trim();

  if (!current) {
    return incoming;
  }

  if (!incoming) {
    return current;
  }

  if (startsWithCompatibleTokenSequence(incoming, current)) {
    return incoming;
  }

  if (startsWithCompatibleTokenSequence(current, incoming)) {
    return current;
  }

  const currentTokens = tokenizeTranscriptText(current);
  const incomingTokens = tokenizeTranscriptText(incoming);
  const overlapSize = haveCompatibleTokenOverlap(currentTokens, incomingTokens);

  if (overlapSize > 0) {
    return [...currentTokens, ...incomingTokens.slice(overlapSize)].join(" ");
  }

  if (preferIncomingOnMismatch) {
    return incoming;
  }

  return `${current} ${incoming}`.trim();
}

function PreviewModal({ file, isOpen, previewUrl, onClose }) {
  if (!isOpen) {
    return null;
  }

  const extension = getFileExtension(file?.name);

  return (
    <div className="workspace-modal" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="workspace-modal-card">
        <div className="workspace-modal-header">
          <div className="workspace-modal-title-wrap">
            <div className="workspace-modal-title">{file?.name || "Uploaded File Preview"}</div>
            <div className="workspace-modal-subtitle">
              {file ? `${extension.toUpperCase()} • ${formatFileSize(file.size)}` : "No file selected"}
            </div>
          </div>

          <button type="button" className="workspace-modal-close" onClick={onClose} aria-label="Close preview">
            X
          </button>
        </div>

        <div className="workspace-modal-body">
          {!file && (
            <div className="workspace-empty-preview-box">
              <h4>No file selected</h4>
              <p>Please upload a DOC, DOCX, or PDF file using the document upload button.</p>
            </div>
          )}

          {file && extension === "pdf" && previewUrl && (
            <iframe className="workspace-preview-frame" src={previewUrl} title="PDF Preview" />
          )}

          {file && (extension === "doc" || extension === "docx") && (
            <div className="workspace-doc-preview-box">
              <h4>Word document selected</h4>
              <p>
                Inline preview for DOC and DOCX files is limited in the browser, but the file is ready and can
                still be opened directly.
              </p>

              <div className="workspace-doc-preview-meta">
                <div>
                  <strong>File Name:</strong> {file.name}
                </div>
                <div>
                  <strong>Type:</strong> {extension.toUpperCase()}
                </div>
                <div>
                  <strong>Size:</strong> {formatFileSize(file.size)}
                </div>
              </div>

              {previewUrl && (
                <a
                  className="workspace-doc-open-btn"
                  href={previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open File
                </a>
              )}
            </div>
          )}

          {file && !["pdf", "doc", "docx"].includes(extension) && (
            <div className="workspace-empty-preview-box">
              <h4>Unsupported preview</h4>
              <p>This file type is not supported for preview in this modal.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DocumentDomainModal({ file, isOpen, value, error, onChange, onClose, onContinue }) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="workspace-modal workspace-modal-domain" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="workspace-modal-card workspace-domain-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-domain-modal-title"
      >
        <div className="workspace-modal-header workspace-domain-modal-header">
          <div className="workspace-modal-title-wrap">
            <div className="workspace-modal-title workspace-domain-modal-title" id="workspace-domain-modal-title">
              <span className="workspace-domain-modal-title-mark" aria-hidden="true">
                *
              </span>
              <span>Enter Domain</span>
            </div>
            <div className="workspace-modal-subtitle">Domain confirmation is required before upload.</div>
          </div>

          <button type="button" className="workspace-modal-close" onClick={onClose} aria-label="Close domain prompt">
            X
          </button>
        </div>

        <form
          className="workspace-modal-body workspace-domain-modal-body"
          onSubmit={(event) => {
            event.preventDefault();
            onContinue();
          }}
        >
          <div className="workspace-domain-modal-intro">
            <span className="workspace-domain-modal-badge"></span>
            <p>
              Enter the domain for this document. The document will only be uploaded after you confirm it.
            </p>
          </div>

          <div className="workspace-domain-modal-file-card">
            <span className="workspace-domain-modal-file-label">Selected document</span>
            <strong>{file?.name || "No file selected"}</strong>
          </div>

          <label className="workspace-domain-field">
            <span className="workspace-domain-field-label">Domain</span>
            <input
              className="workspace-domain-input"
              type="text"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              placeholder="Example: Data Science"
              autoFocus
            />
          </label>

          {error ? (
            <div className="workspace-domain-field-error" role="alert">
              {error}
            </div>
          ) : null}

          <div className="workspace-domain-modal-actions">
            <button type="button" className="workspace-domain-btn workspace-domain-btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="workspace-domain-btn workspace-domain-btn-primary">
              Continue
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DomainConfirmationModal({ file, isOpen, domain, onClose, onNo, onYes }) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="workspace-modal workspace-modal-domain" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="workspace-modal-card workspace-domain-modal-card workspace-domain-confirm-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-domain-confirm-title"
      >
        <div className="workspace-modal-header workspace-domain-modal-header">
          <div className="workspace-modal-title-wrap">
            <div className="workspace-modal-title" id="workspace-domain-confirm-title">
              Please confirm your domain
            </div>
            <div className="workspace-modal-subtitle"></div>
          </div>

          <button type="button" className="workspace-modal-close" onClick={onClose} aria-label="Close domain confirmation">
            X
          </button>
        </div>

        <div className="workspace-modal-body workspace-domain-modal-body">
          <div className="workspace-domain-confirm-copy">
            <span className="workspace-domain-modal-badge workspace-domain-modal-badge-confirm">Confirmation</span>
            <p>Please confirm the domain before the workspace resets and document processing begins.</p>
          </div>

          <div className="workspace-domain-confirm-grid">
            <div className="workspace-domain-confirm-card">
              <span className="workspace-domain-modal-file-label">Selected document</span>
              <strong>{file?.name || "No file selected"}</strong>
            </div>
            <div className="workspace-domain-confirm-card workspace-domain-confirm-card-accent">
              <span className="workspace-domain-modal-file-label">Selected domain</span>
              <strong>{domain || "No domain entered"}</strong>
            </div>
          </div>

          <div className="workspace-domain-modal-actions workspace-domain-modal-actions-confirm">
            <button type="button" className="workspace-domain-btn workspace-domain-btn-secondary" onClick={onNo}>
              No
            </button>
            <button type="button" className="workspace-domain-btn workspace-domain-btn-primary" onClick={onYes}>
              Yes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function UserWorkspacePage() {
  usePageMeta("Voxscribe Workspace");

  const initialWorkspaceSnapshotRef = useRef(null);
  if (initialWorkspaceSnapshotRef.current === null) {
    initialWorkspaceSnapshotRef.current = readWorkspaceSnapshot() || {};
  }

  const initialWorkspaceSnapshot = initialWorkspaceSnapshotRef.current;
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionUser, setSessionUser] = useState(null);
  const [accessMessage, setAccessMessage] = useState("Checking your session before opening the application...");
  const [activityMessage, setActivityMessage] = useState(() => {
    const storedMessage = initialWorkspaceSnapshot.activityMessage;
    if (storedMessage && typeof storedMessage === "object") {
      const text = String(storedMessage.text || "").trim();
      const type = String(storedMessage.type || "").trim();

      if (text && type) {
        return { text, type };
      }
    }

    return createDefaultActivityMessage();
  });
  const [isListening, setIsListening] = useState(false);
  const [uptimeSeconds, setUptimeSeconds] = useState(() => {
    const storedValue = Number(initialWorkspaceSnapshot.uptimeSeconds);
    return Number.isFinite(storedValue) && storedValue >= 0 ? Math.floor(storedValue) : 0;
  });
  const [tier, setTier] = useState(() => String(initialWorkspaceSnapshot.tier || "pro").trim() || "pro");
  const [questionNumber, setQuestionNumber] = useState(() => {
    const storedValue = Number(initialWorkspaceSnapshot.questionNumber);
    return Number.isFinite(storedValue) && storedValue >= 1 ? Math.floor(storedValue) : 1;
  });
  const [generatedQuestions, setGeneratedQuestions] = useState(() =>
    Array.isArray(initialWorkspaceSnapshot.generatedQuestions) ? initialWorkspaceSnapshot.generatedQuestions : [],
  );
  const [selectedGeneratedQuestionId, setSelectedGeneratedQuestionId] = useState(
    () => String(initialWorkspaceSnapshot.selectedGeneratedQuestionId || "").trim(),
  );
  const [isQuestionDropdownOpen, setIsQuestionDropdownOpen] = useState(false);
  const [transcriptLines, setTranscriptLines] = useState(() =>
    Array.isArray(initialWorkspaceSnapshot.transcriptLines)
      ? initialWorkspaceSnapshot.transcriptLines.map((line) => String(line || ""))
      : [],
  );
  const [finalTranscript, setFinalTranscript] = useState(() => String(initialWorkspaceSnapshot.finalTranscript || ""));
  const [interimTranscript, setInterimTranscript] = useState(() => String(initialWorkspaceSnapshot.interimTranscript || ""));
  const [rightText, setRightText] = useState(() => String(initialWorkspaceSnapshot.rightText || ""));
  const [messageInput, setMessageInput] = useState(() => String(initialWorkspaceSnapshot.messageInput || ""));
  const [composerFiles, setComposerFiles] = useState([]);
  const [composerError, setComposerError] = useState("");
  const [composerUploadPending, setComposerUploadPending] = useState(false);
  const [smartInputResponsePending, setSmartInputResponsePending] = useState(false);
  const [transcriptFile, setTranscriptFile] = useState(null);
  const [transcriptFileName, setTranscriptFileName] = useState(
    () => String(initialWorkspaceSnapshot.transcriptFileName || "").trim(),
  );
  const [smartInputKbFilePath, setSmartInputKbFilePath] = useState(
    () => String(initialWorkspaceSnapshot.smartInputKbFilePath || "").trim(),
  );
  const [smartInputUploadPending, setSmartInputUploadPending] = useState(false);
  const [smartInputIngestPending, setSmartInputIngestPending] = useState(false);
  const [smartInputKbReady, setSmartInputKbReady] = useState(() => {
    const hasStoredPath = Boolean(String(initialWorkspaceSnapshot.smartInputKbFilePath || "").trim());
    if (!hasStoredPath) {
      return true;
    }

    return initialWorkspaceSnapshot.smartInputKbReady !== false;
  });
  const [pendingTranscriptUploadFile, setPendingTranscriptUploadFile] = useState(null);
  const [documentDomainDraft, setDocumentDomainDraft] = useState("");
  const [documentDomainError, setDocumentDomainError] = useState("");
  const [isDocumentDomainModalOpen, setIsDocumentDomainModalOpen] = useState(false);
  const [isDocumentDomainConfirmOpen, setIsDocumentDomainConfirmOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);
  const [isScreenShareEnabled, setIsScreenShareEnabledState] = useState(false);
  const [leftPanelWidth, setLeftPanelWidth] = useState(() => {
    if (typeof window === "undefined") {
      return WORKSPACE_LEFT_PANEL_DEFAULT_WIDTH;
    }

    const storedWidth = Number(window.localStorage.getItem(WORKSPACE_PANEL_RESIZE_STORAGE_KEY));
    return Number.isFinite(storedWidth) && storedWidth > 0
      ? storedWidth
      : WORKSPACE_LEFT_PANEL_DEFAULT_WIDTH;
  });
  const [isPanelResizing, setIsPanelResizing] = useState(false);

  const workspaceMainRef = useRef(null);
  const panelResizeStateRef = useRef(null);
  const transcriptBoxRef = useRef(null);
  const composerFileInputRef = useRef(null);
  const transcriptFileInputRef = useRef(null);
  const transcriptStreamRef = useRef(null);
  const transcriptStreamClosedRef = useRef(false);
  const transcriptReconnectAttemptRef = useRef(0);
  const transcriptReconnectTimerRef = useRef(null);
  const screenStreamRef = useRef(null);
  const screenShareCleanupRef = useRef(null);
  const screenAudioContextRef = useRef(null);
  const screenAudioSourceRef = useRef(null);
  const screenAudioProcessorRef = useRef(null);
  const screenAudioGainRef = useRef(null);
  const screenShareEnabledRef = useRef(false);
  const activeTranscriptSourceRef = useRef(null);
  const questionDropdownRef = useRef(null);
  const insightsShellRef = useRef(null);
  const insightsContentRef = useRef(null);
  const pendingInsightsCenterQuestionIdRef = useRef("");

  const questionLabel = `Q${questionNumber}`;
  const questionBodyTextRaw = `${finalTranscript}${finalTranscript && interimTranscript ? " " : ""}${interimTranscript}`;
  const questionBodyText = questionBodyTextRaw.trim();
  const activityState = getActivityState(isListening, questionBodyTextRaw);
  const activityIndicator = activityMessage.type === "success" ? "\u2713" : activityMessage.type === "error" ? "!" : "i";
  const profileInitials = getProfileInitials(sessionUser?.email);
  const selectedTranscriptFileName = String(transcriptFile?.name || transcriptFileName || "").trim();
  const selectedDocumentDomain = normalizeDomainValue(documentDomainDraft);
  const selectedGeneratedQuestion =
    generatedQuestions.find((question) => question.id === selectedGeneratedQuestionId) || null;
  const insightsHighlightLines = getInsightsHighlightLines(rightText);
  const composerFileNames = composerFiles.map((file) => getComposerFileLabel(file)).filter(Boolean);

  const setActivityStatus = (text, type = "info") => {
    setActivityMessage({ text, type });
  };

  const setScreenShareEnabled = (enabled) => {
    screenShareEnabledRef.current = enabled;
    setIsScreenShareEnabledState(enabled);
  };

  const setInsightsScrollReserve = (reservePx = 0) => {
    if (!insightsShellRef.current) {
      return;
    }

    insightsShellRef.current.style.setProperty(
      "--workspace-insights-scroll-reserve",
      `${Math.max(0, Math.round(Number(reservePx) || 0))}px`,
    );
  };

  const centerInsightsQuestionBlock = (questionId) => {
    const normalizedQuestionId = String(questionId || "").trim();
    const insightsContent = insightsContentRef.current;

    if (!normalizedQuestionId || !insightsContent) {
      return false;
    }

    const targetNode = Array.from(insightsContent.querySelectorAll("[data-insights-question-id]")).find(
      (node) => node.dataset.insightsQuestionId === normalizedQuestionId,
    );

    if (!targetNode) {
      return false;
    }

    const desiredViewportOffset = insightsContent.clientHeight * INSIGHTS_NEW_QUESTION_VIEWPORT_OFFSET_RATIO;
    const maxScrollTop = Math.max(0, insightsContent.scrollHeight - insightsContent.clientHeight);
    const targetScrollTop = Math.min(
      maxScrollTop,
      Math.max(0, targetNode.offsetTop + targetNode.offsetHeight / 2 - desiredViewportOffset),
    );

    insightsContent.scrollTop = targetScrollTop;
    return true;
  };

  const scrollActiveGeneratedQuestionIntoView = () => {
    const dropdownShell = questionDropdownRef.current;

    if (!dropdownShell) {
      return false;
    }

    const dropdownMenu = dropdownShell.querySelector(".workspace-question-dropdown-menu");

    if (!dropdownMenu) {
      return false;
    }

    const dropdownOptions = Array.from(dropdownMenu.querySelectorAll("[data-generated-question-option]"));
    const normalizedQuestionId = String(selectedGeneratedQuestionId || "").trim();
    const targetOption = dropdownOptions.find((node) => {
      const nodeQuestionId = String(node.dataset.generatedQuestionId || "").trim();
      return normalizedQuestionId ? nodeQuestionId === normalizedQuestionId : nodeQuestionId === "";
    });

    if (!targetOption) {
      return false;
    }

    const nextScrollTop =
      targetOption.offsetTop - Math.max(0, (dropdownMenu.clientHeight - targetOption.offsetHeight) / 2);
    const maxScrollTop = Math.max(0, dropdownMenu.scrollHeight - dropdownMenu.clientHeight);
    dropdownMenu.scrollTop = Math.max(0, Math.min(nextScrollTop, maxScrollTop));
    return true;
  };

  const handleGeneratedQuestionSelection = (questionId = "") => {
    const normalizedQuestionId = String(questionId || "").trim();

    setSelectedGeneratedQuestionId(normalizedQuestionId);
    setIsQuestionDropdownOpen(false);

    if (!normalizedQuestionId || typeof window === "undefined") {
      return;
    }

    window.requestAnimationFrame(() => {
      centerInsightsQuestionBlock(normalizedQuestionId);
    });
  };

  const isCurrentTranscriptConnection = (connection) => transcriptStreamRef.current === connection;

  const getActiveScreenShareAudioTracks = () => {
    if (!screenStreamRef.current) {
      return [];
    }

    return screenStreamRef.current
      .getAudioTracks()
      .filter((track) => track.readyState === "live" && track.enabled);
  };

  const applyTranscriptPayload = (payload) => {
    if (!payload?.transcript) {
      return;
    }

    if (payload.is_final || payload.type === "final") {
      const currentInterimText = String(interimTranscript || "").trim();

      setFinalTranscript((current) => {
        let text = String(payload.transcript).trim();
        if (!text) {
          return current;
        }

        if (currentInterimText) {
          text = mergeTranscriptText(currentInterimText, text, { preferIncomingOnMismatch: true });
        }

        return mergeTranscriptText(current, text);
      });

      setInterimTranscript("");
      return;
    }

    const interimText = String(payload.transcript).trim();
    if (!interimText) {
      return;
    }

    setInterimTranscript((current) => mergeTranscriptText(current, interimText, { preferIncomingOnMismatch: true }));
  };

  const teardownScreenAudioPipeline = () => {
    if (screenAudioProcessorRef.current) {
      screenAudioProcessorRef.current.onaudioprocess = null;

      try {
        screenAudioProcessorRef.current.disconnect();
      } catch {
        // Ignore disconnection errors during teardown.
      }

      screenAudioProcessorRef.current = null;
    }

    if (screenAudioSourceRef.current) {
      try {
        screenAudioSourceRef.current.disconnect();
      } catch {
        // Ignore disconnection errors during teardown.
      }

      screenAudioSourceRef.current = null;
    }

    if (screenAudioGainRef.current) {
      try {
        screenAudioGainRef.current.disconnect();
      } catch {
        // Ignore disconnection errors during teardown.
      }

      screenAudioGainRef.current = null;
    }

    if (screenAudioContextRef.current) {
      void screenAudioContextRef.current.close().catch(() => {
        // Ignore close errors during teardown.
      });
      screenAudioContextRef.current = null;
    }
  };

  const closeTranscriptStream = ({ markClosed = true, sendStopSignal = false } = {}) => {
    transcriptStreamClosedRef.current = markClosed;
    activeTranscriptSourceRef.current = null;

    if (transcriptReconnectTimerRef.current) {
      clearTimeout(transcriptReconnectTimerRef.current);
      transcriptReconnectTimerRef.current = null;
    }

    if (!transcriptStreamRef.current) {
      return;
    }

    const transcriptConnection = transcriptStreamRef.current;
    transcriptStreamRef.current = null;

    try {
      if (
        sendStopSignal &&
        transcriptConnection instanceof WebSocket &&
        transcriptConnection.readyState === WebSocket.OPEN
      ) {
        transcriptConnection.send(JSON.stringify({ type: "stop" }));
      }

      if (typeof transcriptConnection.close === "function") {
        transcriptConnection.close();
      }
    } catch {
      // Ignore connection close errors during teardown.
    }
  };

  const releaseScreenShare = (stopTracks = true) => {
    if (screenShareCleanupRef.current) {
      screenShareCleanupRef.current();
      screenShareCleanupRef.current = null;
    }

    const screenStream = screenStreamRef.current;
    screenStreamRef.current = null;
    setScreenShareEnabled(false);

    if (!screenStream || !stopTracks) {
      return;
    }

    screenStream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // Ignore track stop errors during teardown.
      }
    });
  };

  const startCapture = async ({ restart = false } = {}) => {
    if (isListening && !restart) {
      return false;
    }

    closeTranscriptStream({ markClosed: true, sendStopSignal: true });
    teardownScreenAudioPipeline();
    setFinalTranscript("");
    setInterimTranscript("");

    if (!screenShareEnabledRef.current) {
      /*
        "System audio" mode (kept for reference):
        - Opens an SSE stream at `/api/transcript/stream`.
        - Requires server-side WASAPI loopback capture (`pyaudiowpatch`), which is Windows-only.
        - In Linux/Ubuntu Docker deployments it fails, so it is disabled here.

        Previous implementation:

        setActivityStatus("Connecting to system audio...", "info");
        transcriptStreamClosedRef.current = false;
        activeTranscriptSourceRef.current = "system";
        setIsListening(true);

        const tabToken = getOrCreateTabToken();
        const transcriptStream = new EventSource(`/api/transcript/stream?tabToken=${encodeURIComponent(tabToken)}`);
        transcriptStreamRef.current = transcriptStream;

        transcriptStream.onopen = () => {
          if (!isCurrentTranscriptConnection(transcriptStream)) return;
          setActivityStatus("Live capture started from system audio.", "success");
        };

        transcriptStream.onmessage = (event) => {
          if (!isCurrentTranscriptConnection(transcriptStream)) return;
          let payload;
          try { payload = JSON.parse(event.data); } catch { return; }
          if (payload?.error) {
            closeTranscriptStream({ markClosed: true });
            setFinalTranscript("");
            setInterimTranscript("");
            setIsListening(false);
            setActivityStatus(payload.error, "error");
            return;
          }
          applyTranscriptPayload(payload);
        };

        transcriptStream.onerror = () => {
          if (!isCurrentTranscriptConnection(transcriptStream)) return;
          const wasClosedManually = transcriptStreamClosedRef.current;
          closeTranscriptStream({ markClosed: true });
          setFinalTranscript("");
          setInterimTranscript("");
          setIsListening(false);
          if (!wasClosedManually) {
            setActivityStatus("System audio transcript stream disconnected.", "error");
          }
        };
      */

      setActivityStatus("Select a browser tab or window with audio to start live transcription.", "info");
      await handleScreenShare();
      return true;
    }

    const audioTracks = getActiveScreenShareAudioTracks();

    if (!screenStreamRef.current) {
      setIsListening(false);
      setActivityStatus("Share a browser tab or window with audio first to start transcription.", "error");
      return false;
    }

    if (!audioTracks.length) {
      setIsListening(false);
      setActivityStatus(
        "The shared screen source has no live audio track. Share a source with audio enabled and try again.",
        "error",
      );
      return false;
    }

    setActivityStatus("Connecting to shared screen audio...", "info");
    transcriptStreamClosedRef.current = false;
    activeTranscriptSourceRef.current = "screen";

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;

      if (!AudioContextClass) {
        throw new Error("Screen audio capture is not supported in this browser.");
      }

      const screenAudioStream = new MediaStream(audioTracks);
      const audioContext = new AudioContextClass();
      await audioContext.resume();

      const sourceNode = audioContext.createMediaStreamSource(screenAudioStream);
      const processorNode = audioContext.createScriptProcessor(SCREEN_AUDIO_PROCESSOR_BUFFER_SIZE, 1, 1);
      const silentGainNode = audioContext.createGain();
      silentGainNode.gain.value = 0;
      const tabToken = getOrCreateTabToken();
      const transcriptWebSocketUrl = new URL(getTranscriptWebSocketUrl());
      transcriptWebSocketUrl.searchParams.set("tabToken", tabToken);
      const transcriptStream = new WebSocket(transcriptWebSocketUrl.toString());
      let screenStreamInitialized = false;

      transcriptStreamRef.current = transcriptStream;
      screenAudioContextRef.current = audioContext;
      screenAudioSourceRef.current = sourceNode;
      screenAudioProcessorRef.current = processorNode;
      screenAudioGainRef.current = silentGainNode;

      processorNode.onaudioprocess = (event) => {
        if (
          !screenStreamInitialized ||
          !isCurrentTranscriptConnection(transcriptStream) ||
          transcriptStream.readyState !== WebSocket.OPEN
        ) {
          return;
        }

        const channelData = event.inputBuffer.getChannelData(0);
        const pcmBuffer = new Int16Array(channelData.length);

        for (let index = 0; index < channelData.length; index += 1) {
          const sample = Math.max(-1, Math.min(1, channelData[index]));
          pcmBuffer[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }

        transcriptStream.send(pcmBuffer.buffer.slice(0));
      };

      sourceNode.connect(processorNode);
      processorNode.connect(silentGainNode);
      silentGainNode.connect(audioContext.destination);

      setIsListening(true);

      transcriptStream.onopen = () => {
        if (!isCurrentTranscriptConnection(transcriptStream)) {
          return;
        }

        transcriptReconnectAttemptRef.current = 0;
        transcriptStream.send(
          JSON.stringify({
            sampleRate: audioContext.sampleRate,
            channels: 1,
          }),
        );
        screenStreamInitialized = true;
        setActivityStatus("Live Started", "success");
      };

      transcriptStream.onmessage = (event) => {
        if (!isCurrentTranscriptConnection(transcriptStream)) {
          return;
        }

        let payload;

        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (payload?.error) {
          closeTranscriptStream({ markClosed: true, sendStopSignal: true });
          teardownScreenAudioPipeline();
          setFinalTranscript("");
          setInterimTranscript("");
          setIsListening(false);
          setActivityStatus(payload.error, "error");
          return;
        }

        applyTranscriptPayload(payload);
      };

      transcriptStream.onclose = () => {
        if (!isCurrentTranscriptConnection(transcriptStream)) {
          return;
        }

        const wasClosedManually = transcriptStreamClosedRef.current;

        closeTranscriptStream({ markClosed: true, sendStopSignal: true });
        teardownScreenAudioPipeline();
        setFinalTranscript("");
        setInterimTranscript("");
        setIsListening(false);

        if (!wasClosedManually) {
          const attempt = transcriptReconnectAttemptRef.current + 1;
          transcriptReconnectAttemptRef.current = attempt;

          if (attempt <= 6 && screenShareEnabledRef.current && screenStreamRef.current) {
            const delayMs = Math.min(6000, 500 * 2 ** (attempt - 1));
            setActivityStatus(`Transcript stream disconnected. Reconnecting in ${Math.ceil(delayMs / 1000)}s...`, "info");
            transcriptReconnectTimerRef.current = setTimeout(() => {
              transcriptReconnectTimerRef.current = null;
              void startCapture({ restart: true });
            }, delayMs);
            return;
          }

          setActivityStatus("Shared screen audio transcript stream disconnected.", "error");
        }
      };

      return true;
    } catch (error) {
      transcriptStreamClosedRef.current = true;
      teardownScreenAudioPipeline();
      activeTranscriptSourceRef.current = null;
      setFinalTranscript("");
      setInterimTranscript("");
      setIsListening(false);
      setActivityStatus(
        error instanceof Error ? error.message : "Unable to start shared screen audio capture.",
        "error",
      );
      return false;
    }
  };

  useEffect(() => {
    let active = true;
    let heartbeatTimerId;

    const verifySession = async () => {
      try {
        const { response, data } = await apiJson("/api/session");

        if (!active) {
          return;
        }

        if (!response.ok || !data.success) {
          clearWorkspaceSnapshot();
          setSessionUser(null);
          setAccessMessage(data.message || "User login required.");
          return;
        }

        setSessionUser(data.user || null);
      } catch {
        if (active) {
          clearWorkspaceSnapshot();
          setSessionUser(null);
          setAccessMessage("Unable to verify your session. Please login again.");
        }
      } finally {
        if (active) {
          setSessionLoading(false);
        }
      }
    };

    verifySession();

    const handlePageShow = (event) => {
      if (!event.persisted || !active) {
        return;
      }

      setSessionLoading(true);
      verifySession();
    };

    window.addEventListener("pageshow", handlePageShow);

    return () => {
      active = false;
      if (heartbeatTimerId) {
        window.clearInterval(heartbeatTimerId);
      }
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, []);

  useEffect(() => {
    if (!sessionUser) {
      return undefined;
    }

    const sendHeartbeat = async () => {
      try {
        await apiJson("/api/session/ping", { method: "POST" });
      } catch {
        // ignore heartbeat failures; normal session checks will handle logout
      }
    };

    void sendHeartbeat();
    const timerId = window.setInterval(sendHeartbeat, 20_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [sessionUser?.id]);

  useEffect(() => {
    if (!sessionUser?.id || !smartInputKbFilePath || smartInputKbReady || smartInputUploadPending || smartInputIngestPending) {
      return undefined;
    }

    void ingestSmartInputDocument(smartInputKbFilePath).catch((error) => {
      const message = String(error?.message || "Unable to index Smart Input document.");
      setActivityStatus(message, "error");
    });

    return undefined;
  }, [sessionUser?.id, smartInputKbFilePath, smartInputKbReady, smartInputUploadPending, smartInputIngestPending]);

  useEffect(() => {
    if (!isListening) {
      return undefined;
    }

    const timerId = window.setInterval(() => {
      setUptimeSeconds((current) => current + 1);
    }, 1000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [isListening]);

  useEffect(() => {
    if (!transcriptBoxRef.current) {
      return;
    }

    transcriptBoxRef.current.scrollTop = transcriptBoxRef.current.scrollHeight;
  }, [transcriptLines, finalTranscript, interimTranscript]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    window.localStorage.setItem(WORKSPACE_PANEL_RESIZE_STORAGE_KEY, String(Math.round(leftPanelWidth)));
  }, [leftPanelWidth]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const syncPanelWidth = () => {
      if (!workspaceMainRef.current || window.innerWidth <= WORKSPACE_PANEL_RESIZE_BREAKPOINT) {
        return;
      }

      const containerWidth = workspaceMainRef.current.getBoundingClientRect().width;
      setLeftPanelWidth((currentWidth) => clampWorkspaceLeftPanelWidth(currentWidth, containerWidth));
    };

    syncPanelWidth();
    window.addEventListener("resize", syncPanelWidth);

    return () => {
      window.removeEventListener("resize", syncPanelWidth);
    };
  }, []);

  useEffect(() => {
    writeWorkspaceSnapshot({
      activityMessage,
      uptimeSeconds,
      tier,
      questionNumber,
      generatedQuestions,
      selectedGeneratedQuestionId,
      transcriptLines,
      finalTranscript,
      interimTranscript,
      rightText,
      messageInput,
      transcriptFileName: selectedTranscriptFileName,
      smartInputKbFilePath,
      smartInputKbReady: smartInputKbFilePath ? smartInputKbReady : true,
    });
  }, [
    activityMessage,
    uptimeSeconds,
    tier,
    questionNumber,
    generatedQuestions,
    selectedGeneratedQuestionId,
    transcriptLines,
    finalTranscript,
    interimTranscript,
    rightText,
    messageInput,
    selectedTranscriptFileName,
    smartInputKbFilePath,
    smartInputKbReady,
  ]);

  useEffect(() => {
    if (!rightText) {
      setInsightsScrollReserve(0);
    }
  }, [rightText]);

  useEffect(() => {
    const pendingQuestionId = pendingInsightsCenterQuestionIdRef.current;

    if (!pendingQuestionId || typeof window === "undefined") {
      return undefined;
    }

    const insightsContent = insightsContentRef.current;

    if (!insightsContent) {
      return undefined;
    }

    const targetNode = Array.from(insightsContent.querySelectorAll("[data-insights-question-id]")).find(
      (node) => node.dataset.insightsQuestionId === pendingQuestionId,
    );

    if (!targetNode) {
      return undefined;
    }

    const reservePx = Math.max(
      0,
      insightsContent.clientHeight * (1 - INSIGHTS_NEW_QUESTION_VIEWPORT_OFFSET_RATIO) - targetNode.offsetHeight / 2,
    );
    setInsightsScrollReserve(reservePx);

    const frameId = window.requestAnimationFrame(() => {
      if (centerInsightsQuestionBlock(pendingQuestionId)) {
        pendingInsightsCenterQuestionIdRef.current = "";
      }
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [rightText]);

  useEffect(() => {
    if (!isPanelResizing) {
      return undefined;
    }

    const handlePointerMove = (event) => {
      const resizeState = panelResizeStateRef.current;

      if (!resizeState) {
        return;
      }

      const nextWidth = clampWorkspaceLeftPanelWidth(
        event.clientX - resizeState.containerLeft,
        resizeState.containerWidth,
      );
      setLeftPanelWidth(nextWidth);
    };

    const stopPanelResize = () => {
      panelResizeStateRef.current = null;
      setIsPanelResizing(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopPanelResize);
    window.addEventListener("pointercancel", stopPanelResize);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopPanelResize);
      window.removeEventListener("pointercancel", stopPanelResize);
    };
  }, [isPanelResizing]);

  useEffect(() => {
    if (!previewOpen || !transcriptFile) {
      setPreviewUrl("");
      return undefined;
    }

    const objectUrl = URL.createObjectURL(transcriptFile);
    setPreviewUrl(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [previewOpen, transcriptFile]);

  useEffect(() => {
    if (!previewOpen) {
      return undefined;
    }

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setPreviewOpen(false);
      }
    };

    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [previewOpen]);

  useEffect(() => {
    if (!isQuestionDropdownOpen) {
      return undefined;
    }

    const frameId = window.requestAnimationFrame(() => {
      scrollActiveGeneratedQuestionIntoView();
    });

    const handlePointerDown = (event) => {
      if (!questionDropdownRef.current?.contains(event.target)) {
        setIsQuestionDropdownOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setIsQuestionDropdownOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isQuestionDropdownOpen, selectedGeneratedQuestionId]);

  useEffect(() => {
    return () => {
      closeTranscriptStream({ markClosed: true, sendStopSignal: true });
      teardownScreenAudioPipeline();
      releaseScreenShare(true);
    };
  }, []);

  const handleStart = async () => {
    await startCapture();
  };

  const startPanelResize = (clientX) => {
    if (!workspaceMainRef.current || window.innerWidth <= WORKSPACE_PANEL_RESIZE_BREAKPOINT) {
      return;
    }

    const containerRect = workspaceMainRef.current.getBoundingClientRect();
    panelResizeStateRef.current = {
      containerLeft: containerRect.left,
      containerWidth: containerRect.width,
    };

    setLeftPanelWidth((currentWidth) => clampWorkspaceLeftPanelWidth(currentWidth, containerRect.width));
    setIsPanelResizing(true);

    const nextWidth = clampWorkspaceLeftPanelWidth(clientX - containerRect.left, containerRect.width);
    setLeftPanelWidth(nextWidth);
  };

  const handlePanelResizePointerDown = (event) => {
    event.preventDefault();
    startPanelResize(event.clientX);
  };

  const handlePanelResizeKeyDown = (event) => {
    if (!workspaceMainRef.current || window.innerWidth <= WORKSPACE_PANEL_RESIZE_BREAKPOINT) {
      return;
    }

    const containerWidth = workspaceMainRef.current.getBoundingClientRect().width;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setLeftPanelWidth((currentWidth) => clampWorkspaceLeftPanelWidth(currentWidth - 24, containerWidth));
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      setLeftPanelWidth((currentWidth) => clampWorkspaceLeftPanelWidth(currentWidth + 24, containerWidth));
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      setLeftPanelWidth(WORKSPACE_LEFT_PANEL_MIN_WIDTH);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      setLeftPanelWidth(clampWorkspaceLeftPanelWidth(containerWidth, containerWidth));
    }
  };

  const resetWorkspaceForNewDocument = () => {
    clearWorkspaceSnapshot();
    pendingInsightsCenterQuestionIdRef.current = "";
    setInsightsScrollReserve(0);
    closeTranscriptStream({ markClosed: true, sendStopSignal: true });
    teardownScreenAudioPipeline();
    releaseScreenShare(true);
    setIsListening(false);
    setUptimeSeconds(0);
    setQuestionNumber(1);
    setGeneratedQuestions([]);
    setSelectedGeneratedQuestionId("");
    setIsQuestionDropdownOpen(false);
    setTranscriptLines([]);
    setFinalTranscript("");
    setInterimTranscript("");
    setRightText("");
    setMessageInput("");
    setComposerFiles([]);
    setComposerError("");
    setComposerUploadPending(false);
    setSmartInputResponsePending(false);
    setTranscriptFile(null);
    setTranscriptFileName("");
    setSmartInputKbFilePath("");
    setSmartInputKbReady(true);
    setPreviewOpen(false);
    setPreviewUrl("");
    setActivityMessage(createDefaultActivityMessage());

    if (composerFileInputRef.current) {
      composerFileInputRef.current.value = "";
    }
  };

  const resetPendingTranscriptUploadFlow = () => {
    setPendingTranscriptUploadFile(null);
    setDocumentDomainDraft("");
    setDocumentDomainError("");
    setIsDocumentDomainModalOpen(false);
    setIsDocumentDomainConfirmOpen(false);
  };

  const handleStop = () => {
    closeTranscriptStream({ markClosed: true, sendStopSignal: true });
    teardownScreenAudioPipeline();
    setIsListening(false);
    setActivityStatus("Live stopped.", "info");
  };

  const handleClear = () => {
    setTranscriptLines([]);
    setFinalTranscript("");
    setInterimTranscript("");
    setActivityStatus("Transcript cleared.", "info");
  };

  const handleCopy = async () => {
    if (!questionBodyText.trim()) {
      setActivityStatus("There is no transcript to copy yet.", "error");
      return;
    }

    try {
      await navigator.clipboard.writeText(questionBodyText);
      setActivityStatus("Transcript copied to clipboard.", "success");
    } catch {
      setActivityStatus("Clipboard copy failed in this browser.", "error");
    }
  };

  const handleDownload = () => {
    if (!generatedQuestions.length) {
      setActivityStatus("There are no generated questions and answers to download yet.", "error");
      return;
    }

    const candidateLabel = sanitizeDownloadLabel(
      String(sessionUser?.email || "").split("@")[0] || sessionUser?.email,
      "candidate",
    );
    const downloadText = buildGeneratedQuestionsDownloadText(generatedQuestions);
    const exportDate = new Date().toISOString().slice(0, 10);
    const blob = new Blob([downloadText], { type: "text/plain" });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `${candidateLabel}-questions-answers-${exportDate}.txt`;
    link.click();
    URL.revokeObjectURL(downloadUrl);
    setActivityStatus("Questions and generated answers downloaded.", "success");
  };

  const streamSmartInputAnswer = async ({
    queryText,
    questionText,
    questionSummary,
    attachmentNames = [],
    imageFilePaths = [],
    resetTranscript = false,
    resetComposer = false,
    pendingStatusText = "Generating answer...",
  }) => {
    const normalizedQuery = String(queryText || "").trim();

    if (!normalizedQuery) {
      setActivityStatus("A query is required before generating an answer.", "info");
      return;
    }

    if (smartInputUploadPending) {
      setActivityStatus("Please wait for the Smart Input document upload to finish.", "info");
      return;
    }

    if (smartInputIngestPending || (smartInputKbFilePath && !smartInputKbReady)) {
      setActivityStatus("Please wait for the Smart Input document indexing to finish.", "info");
      return;
    }

    if (smartInputResponsePending) {
      setActivityStatus("Please wait for the current answer generation to finish.", "info");
      return;
    }

    const generatedQuestionId = questionLabel;
    const questionEntryText = buildQuestionEntryText(generatedQuestionId, questionText, attachmentNames);
    const generatedQuestion = {
      id: generatedQuestionId,
      label: buildQuestionLabel(generatedQuestionId, questionSummary || questionText),
      text: questionEntryText,
      answer: "",
      error: "",
    };

    pendingInsightsCenterQuestionIdRef.current = generatedQuestion.id;
    setRightText((current) => {
      const existingText = String(current || "").trim();
      const nextQuestionBlock = `${questionEntryText}\n\n`;
      return existingText ? `${existingText}\n\n${nextQuestionBlock}` : nextQuestionBlock;
    });
    setGeneratedQuestions((current) => [...current, generatedQuestion]);
    setSelectedGeneratedQuestionId(generatedQuestion.id);
    setIsQuestionDropdownOpen(false);

    if (resetTranscript) {
      setTranscriptLines([]);
      setFinalTranscript("");
      setInterimTranscript("");
    }

    if (resetComposer) {
      setMessageInput("");
      setComposerFiles([]);
      if (composerFileInputRef.current) {
        composerFileInputRef.current.value = "";
      }
    }

    setQuestionNumber((current) => current + 1);
    setSmartInputResponsePending(true);
    setActivityStatus(pendingStatusText, "info");

    try {
      const tabToken = getOrCreateTabToken();
      const requestBody = { query: normalizedQuery };
      if (smartInputKbFilePath) {
        requestBody.files = [smartInputKbFilePath];
      }
      if (imageFilePaths.length) {
        requestBody.imageFiles = imageFilePaths;
      }

      const streamResponse = await fetch("/api/smart-input/stream", {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          "x-voxscribe-tab": tabToken,
        },
        body: JSON.stringify(requestBody),
      });

      if (!streamResponse.ok) {
        const errorText = (await streamResponse.text()) || "Smart input backend returned an error.";
        setGeneratedQuestions((current) =>
          current.map((question) => (question.id === generatedQuestion.id ? { ...question, error: errorText } : question)),
        );
        setActivityStatus(errorText, "error");
        return;
      }

      if (!streamResponse.body) {
        const errorText = "Smart input streaming is not supported in this browser.";
        setGeneratedQuestions((current) =>
          current.map((question) => (question.id === generatedQuestion.id ? { ...question, error: errorText } : question)),
        );
        setActivityStatus(errorText, "error");
        return;
      }

      const reader = streamResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let doneSeen = false;

      while (!doneSeen) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const separatorIndex = buffer.indexOf("\n\n");
          if (separatorIndex === -1) {
            break;
          }

          const rawEvent = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);

          for (const line of rawEvent.split("\n")) {
            if (!line.startsWith("data:")) {
              continue;
            }

            const jsonText = line.slice(5).trim();
            if (!jsonText) {
              continue;
            }

            let payload;
            try {
              payload = JSON.parse(jsonText);
            } catch {
              continue;
            }

            if (payload?.type === "delta") {
              const delta = String(payload.delta || "");
              if (delta) {
                setRightText((current) => `${String(current || "")}${delta}`);
                setGeneratedQuestions((current) =>
                  current.map((question) =>
                    question.id === generatedQuestion.id
                      ? { ...question, answer: `${String(question.answer || "")}${delta}` }
                      : question,
                  ),
                );
              }
              continue;
            }

            if (payload?.type === "error") {
              throw new Error(String(payload.error || "Smart input backend failed to generate a response."));
            }

            if (payload?.type === "done") {
              doneSeen = true;
              break;
            }
          }
        }
      }

      setActivityStatus("Answer received.", "success");
    } catch (error) {
      const message = String(error?.message || "Unable to reach smart input backend.");
      setGeneratedQuestions((current) =>
        current.map((question) => (question.id === generatedQuestion.id ? { ...question, error: message } : question)),
      );
      setActivityStatus(message, "error");
    } finally {
      setSmartInputResponsePending(false);
    }
  };

  const handleGenerate = async () => {
    const transcriptText = questionBodyText.trim();

    if (!transcriptText) {
      setActivityStatus("No transcript available to generate.", "info");
      return;
    }

    await streamSmartInputAnswer({
      queryText: transcriptText,
      questionText: transcriptText,
      questionSummary: transcriptText,
      resetTranscript: true,
      pendingStatusText: "Transcript moved into Insights. Generating answer...",
    });
  };

  const handleSmartInputKeyDown = (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      handleGenerate();
    }
  };

  const handleScreenShare = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setActivityStatus("Screen sharing is not supported in this browser.", "error");
      return;
    }

    if (screenShareEnabledRef.current) {
      const wasListening = activeTranscriptSourceRef.current === "screen" || isListening;

      if (wasListening) {
        closeTranscriptStream({ markClosed: true, sendStopSignal: true });
        teardownScreenAudioPipeline();
        setFinalTranscript("");
        setInterimTranscript("");
        setIsListening(false);
      }

      releaseScreenShare(true);

      if (wasListening) {
        setActivityStatus("Screen share disabled. Select a source again to resume transcription.", "info");
        await startCapture({ restart: true });
        return;
      }

      setActivityStatus("Screen share disabled. Start will prompt you to select a source.", "info");
      return;
    }

    const wasListening = isListening;

    try {
      if (wasListening) {
        closeTranscriptStream({ markClosed: true, sendStopSignal: true });
        teardownScreenAudioPipeline();
        setFinalTranscript("");
        setInterimTranscript("");
        setIsListening(false);
      }

      releaseScreenShare(true);

      let stream;

      try {
        stream = await navigator.mediaDevices.getDisplayMedia(getPreferredScreenShareConstraints());
      } catch (error) {
        if (!isRetryableScreenShareConstraintError(error)) {
          throw error;
        }

        stream = await navigator.mediaDevices.getDisplayMedia(getFallbackScreenShareConstraints());
      }

      const displaySurface = getDisplaySurfaceType(stream);

      if (displaySurface === "monitor") {
        stream.getTracks().forEach((track) => track.stop());
        setScreenShareEnabled(false);

        if (wasListening) {
          setActivityStatus(
            "Entire-screen sharing cannot isolate audio. Share a browser tab or application window instead.",
            "error",
          );
          await startCapture({ restart: true });
          return;
        }

        setActivityStatus(
          "Entire-screen sharing cannot isolate audio. Share a browser tab or application window instead.",
          "error",
        );
        return;
      }

      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((track) => track.stop());
        setScreenShareEnabled(false);

        if (wasListening) {
          setActivityStatus(
            "The selected shared source has no isolated audio. Share a browser tab or application window with audio.",
            "error",
          );
          await startCapture({ restart: true });
          return;
        }

        setActivityStatus(
          "The selected shared source has no isolated audio. Share a browser tab or application window with audio.",
          "error",
        );
        return;
      }

      const handleTrackEnded = () => {
        if (screenStreamRef.current !== stream) {
          return;
        }

        const wasCapturingScreen = activeTranscriptSourceRef.current === "screen";
        closeTranscriptStream({ markClosed: true, sendStopSignal: true });
        teardownScreenAudioPipeline();
        releaseScreenShare(false);
        setFinalTranscript("");
        setInterimTranscript("");
        setIsListening(false);

        if (wasCapturingScreen) {
          setActivityStatus("Screen share ended. Select a source again to resume transcription.", "info");
          void startCapture({ restart: true });
          return;
        }

        setActivityStatus("Screen share ended. Start will prompt you to select a source.", "info");
      };

      stream.getTracks().forEach((track) => {
        track.addEventListener("ended", handleTrackEnded);
      });

      screenShareCleanupRef.current = () => {
        stream.getTracks().forEach((track) => {
          track.removeEventListener("ended", handleTrackEnded);
        });
      };
      screenStreamRef.current = stream;
      setScreenShareEnabled(true);

      if (wasListening) {
        setActivityStatus("Screen share enabled. Switching to shared screen audio.", "info");
        await startCapture({ restart: true });
        return;
      }

      setActivityStatus("Screen share enabled. Starting shared screen audio.", "info");
      await startCapture();
    } catch (error) {
      setScreenShareEnabled(false);
      const errorMessage = getScreenShareErrorMessage(error);
      const statusType = errorMessage === "Screen share was cancelled." ? "info" : "error";

      if (wasListening) {
        setActivityStatus(`${errorMessage} Select a tab/window with audio to continue.`, statusType);
        await startCapture({ restart: true });
        return;
      }

      setActivityStatus(errorMessage, statusType);
    }
  };

  const uploadSmartInputAsset = async (file, { statusText = "Uploading Smart Input file..." } = {}) => {
    if (!file) {
      return "";
    }

    setSmartInputUploadPending(true);
    setActivityStatus(statusText, "info");

    try {
      const tabToken = getOrCreateTabToken();
      const filename = String(file.name || "").trim();
      const response = await fetch(`/api/smart-input/upload?filename=${encodeURIComponent(filename)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-voxscribe-tab": tabToken,
        },
        body: file,
      });

      const payloadText = await response.text();
      let payload = {};

      try {
        payload = payloadText ? JSON.parse(payloadText) : {};
      } catch {
        payload = {};
      }

      if (!response.ok || !payload?.success) {
        const message =
          String(payload?.message || payloadText || "Unable to upload Smart Input document.").trim() ||
          "Unable to upload Smart Input document.";
        throw new Error(message);
      }

      const uploadedPath = String(payload.filePath || "").trim();
      if (!uploadedPath) {
        throw new Error("Upload succeeded, but backend did not return a file path.");
      }

      return uploadedPath;
    } finally {
      setSmartInputUploadPending(false);
    }
  };

  const ingestSmartInputDocument = async (uploadedPath, domain = "") => {
    const filePath = String(uploadedPath || "").trim();
    if (!filePath) {
      return;
    }

    const normalizedDomain = normalizeDomainValue(domain);

    setSmartInputIngestPending(true);
    setSmartInputKbReady(false);
    setActivityStatus("Processing...", "info");

    try {
      const tabToken = getOrCreateTabToken();
      const response = await fetch("/api/smart-input/ingest", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-voxscribe-tab": tabToken,
        },
        body: JSON.stringify({ files: [filePath], domain: normalizedDomain }),
      });

      const payloadText = await response.text();
      let payload = {};

      try {
        payload = payloadText ? JSON.parse(payloadText) : {};
      } catch {
        payload = {};
      }

      if (!response.ok || !payload?.success) {
        const message =
          String(payload?.detail || payload?.message || payloadText || "Unable to index Smart Input document.").trim() ||
          "Unable to index Smart Input document.";
        throw new Error(message);
      }

      setSmartInputKbReady(true);
      setActivityStatus("Process Completed", "success");
    } finally {
      setSmartInputIngestPending(false);
    }
  };

  const processTranscriptDocumentUpload = async (file, domain) => {
    const selectedFile = file || null;
    const normalizedDomain = normalizeDomainValue(domain);

    if (!selectedFile || !normalizedDomain) {
      return;
    }

    resetWorkspaceForNewDocument();
    setTranscriptFile(selectedFile);
    setTranscriptFileName(String(selectedFile.name || "").trim());
    setSmartInputKbReady(false);
    let uploadedPath = "";

    try {
      uploadedPath = await uploadSmartInputAsset(selectedFile, { statusText: "Uploading Smart Input document..." });
      setSmartInputKbFilePath(uploadedPath);
      await ingestSmartInputDocument(uploadedPath, normalizedDomain);
    } catch (error) {
      setSmartInputKbFilePath("");
      setSmartInputKbReady(false);
      if (!uploadedPath) {
        setTranscriptFile(null);
        setTranscriptFileName("");
      }
      const message = String(error?.message || "Unable to upload Smart Input document.");
      setActivityStatus(message, "error");
    }
  };

  const handleTranscriptFileChange = (event) => {
    const file = event.target.files?.[0] || null;
    event.target.value = "";

    if (!file) {
      return;
    }

    if (!isAllowedTranscriptFile(file)) {
      setActivityStatus("Only DOC, DOCX, and PDF files are allowed for transcript upload.", "error");
      return;
    }

    setPendingTranscriptUploadFile(file);
    setDocumentDomainDraft("");
    setDocumentDomainError("");
    setIsDocumentDomainConfirmOpen(false);
    setIsDocumentDomainModalOpen(true);
  };

  const handleDocumentDomainContinue = () => {
    if (!pendingTranscriptUploadFile) {
      resetPendingTranscriptUploadFlow();
      return;
    }

    const normalizedDomain = normalizeDomainValue(documentDomainDraft);
    if (!normalizedDomain) {
      setDocumentDomainError("Domain is required before the document can be uploaded.");
      return;
    }

    setDocumentDomainDraft(normalizedDomain);
    setDocumentDomainError("");
    setIsDocumentDomainModalOpen(false);
    setIsDocumentDomainConfirmOpen(true);
  };

  const handleConfirmedTranscriptUpload = async () => {
    const fileToUpload = pendingTranscriptUploadFile;
    const confirmedDomain = normalizeDomainValue(documentDomainDraft);

    if (!fileToUpload) {
      resetPendingTranscriptUploadFlow();
      return;
    }

    if (!confirmedDomain) {
      setIsDocumentDomainConfirmOpen(false);
      setIsDocumentDomainModalOpen(true);
      setDocumentDomainError("Domain is required before the document can be uploaded.");
      return;
    }

    resetPendingTranscriptUploadFlow();
    await processTranscriptDocumentUpload(fileToUpload, confirmedDomain);
  };

  const appendComposerFiles = (incomingFiles = []) => {
    const nextFiles = Array.isArray(incomingFiles) ? incomingFiles.filter(Boolean) : [];
    if (!nextFiles.length) {
      return;
    }

    if (nextFiles.some((file) => !isAllowedComposerImage(file))) {
      setComposerError("Only PNG, JPG, JPEG, and WEBP images are allowed in the message field.");
      return;
    }

    const mergedFiles = [...composerFiles, ...nextFiles];
    setComposerFiles(clampComposerImageFiles(mergedFiles));
    setComposerError(mergedFiles.length > COMPOSER_IMAGE_LIMIT ? `You can upload up to ${COMPOSER_IMAGE_LIMIT} images per message.` : "");
  };

  const handleComposerFileChange = (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    appendComposerFiles(files);
  };

  const handleRemoveComposerFile = (targetIndex) => {
    setComposerFiles((current) => current.filter((_, index) => index !== targetIndex));
    setComposerError("");
  };

  const handleSend = async () => {
    const message = messageInput.trim();
    const selectedComposerFiles = [...composerFiles];

    if (!message && !selectedComposerFiles.length) {
      setComposerError("Type a message or choose image files before sending.");
      return;
    }

    if (composerUploadPending) {
      setActivityStatus("Please wait for the image upload to finish.", "info");
      return;
    }

    setComposerError("");

    const attachmentNames = selectedComposerFiles.map((file) => getComposerFileLabel(file)).filter(Boolean);
    const queryText = buildComposerQueryText(message, selectedComposerFiles.length);
    const questionSummary = message || attachmentNames.join(", ") || queryText;
    const uploadedImagePaths = [];

    try {
      if (selectedComposerFiles.length) {
        setComposerUploadPending(true);

        for (let index = 0; index < selectedComposerFiles.length; index += 1) {
          const file = selectedComposerFiles[index];
          const uploadPath = await uploadSmartInputAsset(file, {
            statusText: `Uploading image ${index + 1} of ${selectedComposerFiles.length}...`,
          });
          uploadedImagePaths.push(uploadPath);
        }
      }
    } catch (error) {
      const errorMessage = String(error?.message || "Unable to upload message images.");
      setActivityStatus(errorMessage, "error");
      return;
    } finally {
      setComposerUploadPending(false);
    }

    await streamSmartInputAnswer({
      queryText,
      questionText: queryText,
      questionSummary,
      attachmentNames,
      imageFilePaths: uploadedImagePaths,
      resetComposer: true,
      pendingStatusText: "Message sent to Insights. Generating answer...",
    });
  };

  const handleLogout = async () => {
    setLogoutPending(true);

    try {
      await apiJson("/api/logout", {
        method: "POST",
      });
    } finally {
      clearWorkspaceSnapshot();
      window.location.assign("/");
    }
  };

  if (sessionLoading) {
    return (
      <div className="admin-page">
        <div className="admin-shell">
          <div className="panel-card access-card">
            <h2>Opening workspace...</h2>
            <p>Please wait while your user session is verified and the React application is prepared.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!sessionUser) {
    return (
      <div className="admin-page">
        <div className="admin-shell">
          <section className="panel-card access-card">
            <h2>User Access Required</h2>
            <p>{accessMessage}</p>
            <button type="button" className="admin-primary-btn" onClick={() => window.location.assign("/")}>
              Go to Login
            </button>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-page">
      <div className="workspace-shell">
        <header className="workspace-header">
          <div className="workspace-title-wrap">
            <h1>Voxscribe</h1>
          </div>

          <div className="workspace-profile-card">
            <div className="workspace-profile-left">
              <div className="workspace-profile-avatar">{profileInitials}</div>

              <div className="workspace-profile-content">
                <div className="workspace-profile-title">Login Profile</div>
                <div className="workspace-profile-subtitle">{sessionUser.email}</div>
              </div>
            </div>

            <button
              type="button"
              className="workspace-logout-btn"
              onClick={handleLogout}
              disabled={logoutPending}
            >
              {logoutPending ? "Logging out..." : "Logout"}
            </button>
          </div>
        </header>

        <div
          ref={workspaceMainRef}
          className={`workspace-main${isPanelResizing ? " workspace-main-resizing" : ""}`}
          style={{ "--workspace-left-panel-width": `${leftPanelWidth}px` }}
        >
          <div className="workspace-left">
            <section className="workspace-card workspace-control-panel-card">
              <div className="workspace-control-panel">
                <div className="workspace-control-actions">
                  <div className="workspace-control-group">
                    <button
                      type="button"
                      className="workspace-control-btn workspace-control-btn-start"
                      onClick={handleStart}
                      disabled={isListening}
                    >
                      <svg className="workspace-control-btn-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <path d="M4.2 2.7c0-.85.94-1.36 1.65-.9l7.2 4.75c.64.42.64 1.38 0 1.8l-7.2 4.75c-.71.47-1.65-.04-1.65-.9V2.7z" />
                      </svg>
                      Start
                    </button>
                    <button
                      type="button"
                      className="workspace-control-btn workspace-control-btn-stop"
                      onClick={handleStop}
                      disabled={!isListening}
                    >
                      <svg className="workspace-control-btn-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
                      </svg>
                      Stop
                    </button>
                    <button type="button" className="workspace-control-btn workspace-control-btn-clear" onClick={handleClear}>
                      <svg
                        className="workspace-control-btn-icon workspace-control-btn-icon-broom"
                        viewBox="0 0 512 512"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          d="M0 0 C10.93721349 7.43351739 16.86646193 17.76135445 19.921875 30.47265625 C22.71154277 48.07545988 15.2495456 61.88736344 7.3125 76.9375 C6.51668485 78.45820659 5.72110257 79.97903508 4.92578125 81.5 C3.31724976 84.56773514 1.69962814 87.63051062 0.078125 90.69140625 C-3.21519149 96.92033364 -6.44930186 103.17979514 -9.6875 109.4375 C-13.34920405 116.50968217 -17.01150367 123.58126715 -20.72167969 130.62817383 C-21.52161886 132.14757637 -22.31921185 133.66821686 -23.11425781 135.19018555 C-25.21483793 139.2001842 -27.37081805 143.16962988 -29.59375 147.11328125 C-30.3067627 148.40202148 -30.3067627 148.40202148 -31.03417969 149.71679688 C-31.94530935 151.36152223 -32.87223426 152.99763217 -33.81738281 154.62304688 C-36.32876103 159.12206564 -36.32876103 159.12206564 -36.10546875 164.16015625 C-35.63753906 165.07667969 -35.16960937 165.99320313 -34.6875 166.9375 C-34.29691406 167.78570312 -33.90632813 168.63390625 -33.50390625 169.5078125 C-33.09011719 170.35085937 -32.67632812 171.19390625 -32.25 172.0625 C-22.71176234 192.96784095 -25.13341691 213.91532497 -32.4375 235.0625 C-32.79181595 236.10648956 -32.79181595 236.10648956 -33.15328979 237.17156982 C-49.24557195 284.58197559 -69.1604683 331.11936228 -95.4375 373.8125 C-96.02700439 374.7806665 -96.61650879 375.74883301 -97.22387695 376.74633789 C-104.58327537 388.48606331 -112.16591155 397.68850636 -125.80859375 401.421875 C-131.92270099 402.51693898 -137.23670003 401.85012232 -143.125 400.0625 C-143.84816406 399.844729 -144.57132813 399.62695801 -145.31640625 399.40258789 C-179.03515908 388.79851941 -211.19082747 371.18538472 -240.6875 351.9375 C-241.35088379 351.5058252 -242.01426758 351.07415039 -242.69775391 350.62939453 C-268.074275 334.06317722 -292.81555575 316.16825119 -314.984375 295.453125 C-317.57384935 293.04326737 -320.21609656 290.70765762 -322.875 288.375 C-331.79328368 280.30402508 -339.60113095 272.78364797 -341.125 260.375 C-340.04082581 251.85648847 -337.2396025 245.65023181 -330.6875 239.9375 C-324.94139393 235.7422847 -318.65687122 234.39126834 -311.8125 233.0625 C-271.55208782 225.24598381 -238.92801403 202.43005095 -210.4909668 173.87133789 C-208.99445075 172.36943075 -207.492617 170.87298938 -205.99023438 169.37695312 C-200.67656798 164.06706087 -195.55381377 158.66058816 -190.6875 152.9375 C-187.71702367 149.57642532 -184.71157956 146.25036554 -181.6875 142.9375 C-181.14738281 142.31875 -180.60726562 141.7 -180.05078125 141.0625 C-168.88075541 128.90771118 -150.82034782 120.36766775 -134.6875 117.9375 C-133.32205859 117.95286776 -131.95657815 118.00401926 -130.59375 118.08984375 C-126.24629562 118.26988827 -122.45617901 118.34766705 -118.6875 115.9375 C-113.77142174 109.81874583 -111.00230326 102.19833108 -108.00634766 95.015625 C-106.23251952 90.87559813 -104.15668706 86.94993827 -102 83 C-101.18750839 81.47403552 -100.37777064 79.94660263 -99.5703125 78.41796875 C-98.90370605 77.15605713 -98.90370605 77.15605713 -98.22363281 75.86865234 C-95.28018898 70.25215733 -92.38583871 64.61028283 -89.4859314 58.97122192 C-88.37739057 56.81714528 -87.2667575 54.66415993 -86.15551758 52.51147461 C-82.74585087 45.90298389 -79.3532124 39.28782206 -76.01953125 32.640625 C-67.34818512 15.44002466 -59.85304983 1.90311676 -41.0625 -5.5 C-26.78529747 -9.78316076 -12.76917249 -7.34713106 0 0 Z M-41.13696289 28.74975586 C-44.10921625 32.94348321 -46.22834038 37.560589 -48.4375 42.1875 C-49.49969698 44.36146207 -50.56351586 46.53463239 -51.62890625 48.70703125 C-52.14984863 49.7738916 -52.67079102 50.84075195 -53.20751953 51.93994141 C-55.19124963 55.95779659 -57.26748069 59.92103811 -59.375 63.875 C-64.83383043 74.14829495 -70.13922687 84.49994242 -75.44799805 94.85131836 C-75.79475082 95.52629868 -76.1415036 96.20127899 -76.49876404 96.89671326 C-77.18847372 98.23937952 -77.87709526 99.58260535 -78.56459045 100.92640686 C-80.33630257 104.37481116 -82.14775812 107.79405153 -84.02636719 111.18554688 C-84.40296478 111.87070374 -84.77956238 112.5558606 -85.16757202 113.26177979 C-85.88871255 114.56849749 -86.61818844 115.87066003 -87.35708618 117.16741943 C-88.21029121 118.71779099 -88.95836174 120.32505831 -89.6875 121.9375 C-88.98527375 125.1135384 -88.98527375 125.1135384 -86.25073242 126.43969727 C-85.19217041 126.95588623 -84.1336084 127.4720752 -83.04296875 128.00390625 C-81.89119141 128.57173828 -80.73941406 129.13957031 -79.55273438 129.72460938 C-78.32693995 130.31664862 -77.10102726 130.90844306 -75.875 131.5 C-74.66035467 132.09477969 -73.4461561 132.69047266 -72.23242188 133.28710938 C-69.9946417 134.38415833 -67.75484102 135.47710161 -65.51245117 136.56469727 C-63.229525 137.67409955 -60.95461992 138.79626356 -58.6875 139.9375 C-51.72711016 127.60039413 -45.10252066 115.12831899 -38.6875 102.5 C-37.02254309 99.22959539 -35.35567689 95.96016952 -33.6875 92.69140625 C-33.07412025 91.48920944 -33.07412025 91.48920944 -32.448349 90.26272583 C-25.94199508 77.53756514 -19.24619345 64.90853959 -12.48632812 52.31640625 C-9.09421602 45.94779217 -7.90223712 41.11393023 -8.6875 33.9375 C-10.36925228 29.09332224 -13.39907085 25.69434731 -17.6875 22.9375 C-26.96849784 19.07041757 -34.82674906 21.0623718 -41.13696289 28.74975586 Z M-165.203125 166.78515625 C-169.70500188 171.91678408 -169.70500188 171.91678408 -172.6875 177.9375 C-171.66615967 178.46069824 -170.64481934 178.98389648 -169.5925293 179.52294922 C-134.77020785 197.36503524 -134.77020785 197.36503524 -118.96191406 205.73779297 C-114.37947283 208.15493726 -109.78230018 210.54395943 -105.1875 212.9375 C-97.94757972 216.70905784 -90.7183694 220.49987331 -83.5 224.3125 C-76.6085438 227.95047594 -69.68295183 231.50260748 -62.6875 234.9375 C-61.53610965 231.71028785 -60.39238074 228.48041128 -59.25 225.25 C-58.92451172 224.33798828 -58.59902344 223.42597656 -58.26367188 222.48632812 C-57.95107422 221.60009766 -57.63847656 220.71386719 -57.31640625 219.80078125 C-57.02838135 218.98907471 -56.74035645 218.17736816 -56.44360352 217.34106445 C-52.47579485 204.72786579 -54.37052778 191.94183554 -60.0078125 180.18359375 C-68.22557851 165.47693599 -81.98408237 159.10217089 -96.5625 152.0625 C-97.34665283 151.68101807 -98.13080566 151.29953613 -98.9387207 150.90649414 C-122.80125746 139.65430272 -148.20258524 147.54075643 -165.203125 166.78515625 Z M-196.78125 200.80859375 C-197.5753125 201.65550781 -198.369375 202.50242187 -199.1875 203.375 C-204.35976215 208.70513643 -209.8797162 213.32321156 -215.6875 217.9375 C-216.46480469 218.59363281 -217.24210937 219.24976563 -218.04296875 219.92578125 C-243.45602743 241.16718206 -275.73129503 254.43834341 -307.6875 261.9375 C-303.779594 266.66571419 -299.69913753 271.03289389 -295.1875 275.1875 C-294.58583008 275.74397217 -293.98416016 276.30044434 -293.36425781 276.8737793 C-287.59487296 282.14040347 -281.51188781 286.94681029 -275.30957031 291.68847656 C-272.78349901 293.63359709 -270.29855934 295.62914954 -267.8125 297.625 C-267.01070312 298.26824219 -266.20890625 298.91148437 -265.3828125 299.57421875 C-264.82335937 300.02410156 -264.26390625 300.47398437 -263.6875 300.9375 C-259.94928857 299.5938724 -257.01344011 297.90440187 -253.8125 295.5625 C-252.10434076 294.35392057 -250.39601894 293.14557088 -248.6875 291.9375 C-248.06488281 291.49277344 -247.44226563 291.04804688 -246.80078125 290.58984375 C-242.19941642 287.59734774 -238.00618201 287.0693474 -232.6875 287.9375 C-229.75 289.4375 -229.75 289.4375 -227.6875 290.9375 C-227.0275 290.9375 -226.3675 290.9375 -225.6875 290.9375 C-223.51577819 296.50253715 -222.8369456 301.08206737 -224.5625 306.875 C-227.78732256 311.5225384 -232.16874649 314.59718315 -236.6875 317.9375 C-235.58341079 321.24976762 -235.19511302 321.54650539 -232.3984375 323.3203125 C-231.71152832 323.76093018 -231.02461914 324.20154785 -230.31689453 324.65551758 C-229.57294434 325.11982178 -228.82899414 325.58412598 -228.0625 326.0625 C-227.29921387 326.54678467 -226.53592773 327.03106934 -225.74951172 327.5300293 C-214.9302923 334.36174713 -203.99580933 340.94245035 -192.6875 346.9375 C-182.82644836 338.14894944 -174.5386683 326.9960303 -167.875 315.625 C-165.38220352 311.59109042 -163.18594006 309.15526689 -158.734375 307.38671875 C-154.04027791 306.35652569 -150.18245847 307.25501896 -145.8125 309.25 C-142.96064843 311.51470566 -142.00036357 313.65922883 -141.140625 317.171875 C-140.16768405 329.22137449 -149.27850316 339.16156869 -156.5 348 C-157.22703125 348.85335937 -157.9540625 349.70671875 -158.703125 350.5859375 C-161.23129536 353.58191891 -163.46479686 356.71099544 -165.6875 359.9375 C-158.90772372 363.45910532 -152.06304646 366.5592136 -144.9375 369.3125 C-144.03128906 369.67988281 -143.12507812 370.04726563 -142.19140625 370.42578125 C-138.51840976 371.8467215 -135.33881177 372.88954118 -131.3984375 373.1796875 C-127.06995498 371.19631943 -125.40382312 367.70867486 -123.0625 363.6875 C-122.54816406 362.83704102 -122.03382813 361.98658203 -121.50390625 361.11035156 C-119.87534106 358.39904807 -118.27895924 355.67072174 -116.6875 352.9375 C-116.18379883 352.08414063 -115.68009766 351.23078125 -115.16113281 350.3515625 C-111.57315228 344.26627262 -108.09926999 338.12314847 -104.6875 331.9375 C-104.20313477 331.06206543 -103.71876953 330.18663086 -103.21972656 329.28466797 C-96.60376943 317.23054434 -90.75097571 304.90562917 -85.25 292.3125 C-84.95667786 291.64149261 -84.66335571 290.97048523 -84.36114502 290.27914429 C-77.11875331 276.00681047 -77.11875331 276.00681047 -73.6875 260.9375 C-74.69312988 260.42477539 -75.69875977 259.91205078 -76.73486328 259.38378906 C-110.24684675 242.28686017 -110.24684675 242.28686017 -121.5625 236 C-132.53098027 229.90896944 -143.71914756 224.25182863 -154.89727783 218.5585022 C-165.47271458 213.17061805 -176.0031402 207.74946935 -186.29541016 201.83178711 C-191.61458573 198.43665133 -191.61458573 198.43665133 -196.78125 200.80859375 Z"
                          transform="translate(413.6875,54.0625)"
                        />
                        <path
                          d="M0 0 C4.6992228 3.5530709 9.19620504 8.06243168 10.5625 13.9375 C11.32394923 20.79054303 10.67396776 26.27477293 6.5625 31.9375 C2.98185338 35.70005113 -0.95351542 38.63232475 -6.171875 39.2734375 C-12.72512141 39.35832411 -18.22588862 39.2437535 -23.4375 34.9375 C-27.93246161 30.10812112 -30.38937915 25.11642908 -30.66796875 18.4921875 C-30.12601602 12.48477931 -28.05742506 6.94613726 -23.4375 2.9375 C-16.11859796 -1.94176803 -8.5249477 -2.63498383 0 0 Z"
                          transform="translate(74.4375,225.0625)"
                        />
                        <path
                          d="M0 0 C4.41248936 4.57634838 5.73391624 9.24094039 6.03515625 15.52734375 C5.77830746 22.79249521 3.13835567 26.9949293 -2.02734375 31.90234375 C-8.00950624 35.79074937 -13.52897319 36.32284199 -20.52734375 35.52734375 C-26.10747795 33.75906593 -30.55277304 29.4849616 -33.52734375 24.52734375 C-35.90832173 18.0976543 -35.86838706 12.91200733 -33.52734375 6.52734375 C-30.28453466 0.16644899 -25.33229905 -3.23190996 -18.65234375 -5.41015625 C-11.83437732 -5.54651558 -5.38355931 -4.39084625 0 0 Z"
                          transform="translate(133.52734375,167.47265625)"
                        />
                      </svg>
                      Clear
                    </button>
                  </div>

                  <button
                    type="button"
                    className={`workspace-control-icon-btn workspace-screen-share-btn${
                      isScreenShareEnabled ? " workspace-control-icon-btn-active" : ""
                    }`}
                    onClick={handleScreenShare}
                    aria-label="Screen Share"
                    aria-pressed={isScreenShareEnabled}
                    title={isScreenShareEnabled ? "Turn off Screen Share" : "Turn on Screen Share"}
                  >
                    <svg
                      className="workspace-screen-share-icon"
                      viewBox="0 0 18 18"
                      width="26"
                      height="26"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="3" y="4" width="12" height="9" rx="1.8" />
                      <path d="M7 15h4M9 13v2" />
                      <path d="M9 10V6.8M9 6.8 7.6 8.2M9 6.8l1.4 1.4" />
                    </svg>
                  </button>
                </div>

                <div className="workspace-control-meta">
                  <div className="workspace-status" aria-live="polite">
                    <span className="workspace-status-label">Status</span>
                    <span className="workspace-status-separator" aria-hidden="true">&bull;</span>
                    <span className={`workspace-status-value workspace-status-value-${activityState.toLowerCase()}`}>
                      {activityState}
                    </span>
                  </div>

                  <label className="workspace-tier-control">
                    <span className="workspace-tier-label">Service Tier</span>
                    <span className="workspace-tier-pill">
                      <select
                        className="workspace-tier-select-input"
                        value={tier}
                        onChange={(event) => setTier(event.target.value)}
                        aria-label="Service Tier"
                      >
                        <option value="core">Core</option>
                        <option value="pro">Pro</option>
                        <option value="elite">Elite</option>
                        <option value="ultra">Ultra</option>
                      </select>
                      <svg className="workspace-tier-arrow" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path
                          d="M4.5 6.5 8 10l3.5-3.5"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                  </label>
                </div>
              </div>

              <div className={`workspace-activity-note workspace-activity-note-${activityMessage.type}`} role="status" aria-live="polite">
                <span className="workspace-activity-note-icon" aria-hidden="true">
                  {activityIndicator}
                </span>
                <span>{activityMessage.text}</span>
              </div>
            </section>

            <section className="workspace-card workspace-transcript-card">
              <div className="workspace-section-header">
                <h3>Smart Input</h3>

                <div className="workspace-section-actions">
                  <button
                    type="button"
                    className="workspace-icon-btn"
                    onClick={handleDownload}
                    aria-label="Download transcript"
                    title="Download transcript"
                  >
                    <svg
                      className="workspace-save-icon"
                      viewBox="-6.5 0 32 32"
                      width="27"
                      height="27"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M12.188 4.469v4.656h2.438l-4.875 5.875-4.875-5.875h2.563v-4.656h4.75zM16.313 12l2.844 4.5c0.156 0.375 0.344 1.094 0.344 1.531v8.656c0 0.469-0.375 0.813-0.813 0.813h-17.844c-0.469 0-0.844-0.344-0.844-0.813v-8.656c0-0.438 0.156-1.156 0.313-1.531l2.844-4.5c0.156-0.406 0.719-0.75 1.125-0.75h1.281l1.313 1.594h-2.625l-2.531 4.625c-0.031 0-0.031 0.031-0.031 0.063 0 0.063 0 0.094-0.031 0.125h16.156v-0.125c0-0.031-0.031-0.063-0.031-0.094l-2.531-4.594h-2.625l1.313-1.594h1.25c0.438 0 0.969 0.344 1.125 0.75zM7.469 21.031h4.594c0.406 0 0.781-0.375 0.781-0.813 0-0.406-0.375-0.781-0.781-0.781h-4.594c-0.438 0-0.813 0.375-0.813 0.781 0 0.438 0.375 0.813 0.813 0.813z" />
                    </svg>
                  </button>

                  <button
                    type="button"
                    className="workspace-icon-btn"
                    onClick={() => transcriptFileInputRef.current?.click()}
                    aria-label="Upload document"
                    title="Upload document"
                  >
                    <svg
                      className="workspace-upload-icon"
                      viewBox="0 0 24 24"
                      width="27"
                      height="27"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M8 10C8 7.79086 9.79086 6 12 6C14.2091 6 16 7.79086 16 10V11H17C18.933 11 20.5 12.567 20.5 14.5C20.5 16.433 18.933 18 17 18H16C15.4477 18 15 18.4477 15 19C15 19.5523 15.4477 20 16 20H17C20.0376 20 22.5 17.5376 22.5 14.5C22.5 11.7793 20.5245 9.51997 17.9296 9.07824C17.4862 6.20213 15.0003 4 12 4C8.99974 4 6.51381 6.20213 6.07036 9.07824C3.47551 9.51997 1.5 11.7793 1.5 14.5C1.5 17.5376 3.96243 20 7 20H8C8.55228 20 9 19.5523 9 19C9 18.4477 8.55228 18 8 18H7C5.067 18 3.5 16.433 3.5 14.5C3.5 12.567 5.067 11 7 11H8V10ZM15.7071 13.2929L12.7071 10.2929C12.3166 9.90237 11.6834 9.90237 11.2929 10.2929L8.29289 13.2929C7.90237 13.6834 7.90237 14.3166 8.29289 14.7071C8.68342 15.0976 9.31658 15.0976 9.70711 14.7071L11 13.4142V19C11 19.5523 11.4477 20 12 20C12.5523 20 13 19.5523 13 19V13.4142L14.2929 14.7071C14.6834 15.0976 15.3166 15.0976 15.7071 14.7071C16.0976 14.3166 16.0976 13.6834 15.7071 13.2929Z" />
                    </svg>
                  </button>

                  <button
                    type="button"
                    className="workspace-icon-btn"
                    onClick={() => setPreviewOpen(true)}
                    disabled={!transcriptFile}
                    aria-label="View uploaded file"
                    title="View uploaded file"
                  >
                    <svg
                      className="workspace-view-icon"
                      viewBox="0 0 24 24"
                      width="27"
                      height="27"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="3" />
                      <path d="M20.188 10.9343C20.5762 11.4056 20.7703 11.6412 20.7703 12C20.7703 12.3588 20.5762 12.5944 20.188 13.0657C18.7679 14.7899 15.6357 18 12 18C8.36427 18 5.23206 14.7899 3.81197 13.0657C3.42381 12.5944 3.22973 12.3588 3.22973 12C3.22973 11.6412 3.42381 11.4056 3.81197 10.9343C5.23206 9.21014 8.36427 6 12 6C15.6357 6 18.7679 9.21014 20.188 10.9343Z" />
                    </svg>
                  </button>

                  <input
                    ref={transcriptFileInputRef}
                    type="file"
                    accept=".doc,.docx,.pdf,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    hidden
                    onChange={handleTranscriptFileChange}
                  />
                </div>
              </div>

              <div className="workspace-upload-info">
                {selectedTranscriptFileName
                  ? `Selected document: ${selectedTranscriptFileName}`
                  : "No transcript document selected"}
              </div>

              <div className="workspace-question-dropdown-row">
                <div className="workspace-question-dropdown">
                  <span>Generated Questions</span>
                  <div className="workspace-question-dropdown-shell" ref={questionDropdownRef}>
                    <button
                      type="button"
                      className={`workspace-question-dropdown-trigger${isQuestionDropdownOpen ? " open" : ""}`}
                      onClick={() => setIsQuestionDropdownOpen((current) => !current)}
                      aria-haspopup="listbox"
                      aria-expanded={isQuestionDropdownOpen}
                      disabled={!generatedQuestions.length}
                    >
                      <span
                        className={`workspace-question-dropdown-trigger-text${
                          selectedGeneratedQuestion ? "" : " placeholder"
                        }`}
                      >
                        {selectedGeneratedQuestion ? selectedGeneratedQuestion.id : "Select question"}
                      </span>
                      <span className="workspace-question-dropdown-trigger-arrow">
                        {isQuestionDropdownOpen ? "▲" : "▼"}
                      </span>
                    </button>

                    {isQuestionDropdownOpen && (
                      <div className="workspace-question-dropdown-menu" role="listbox">
                        <button
                          type="button"
                          data-generated-question-option="true"
                          data-generated-question-id=""
                          className={`workspace-question-dropdown-option${
                            selectedGeneratedQuestionId === "" ? " selected" : ""
                          }`}
                          onClick={() => handleGeneratedQuestionSelection("")}
                        >
                          Select question
                        </button>

                        {generatedQuestions.map((question) => (
                          <button
                            key={question.id}
                            type="button"
                            data-generated-question-option="true"
                            data-generated-question-id={question.id}
                            className={`workspace-question-dropdown-option${
                              selectedGeneratedQuestionId === question.id ? " selected" : ""
                            }`}
                            onClick={() => handleGeneratedQuestionSelection(question.id)}
                            title={question.label}
                          >
                            {question.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <textarea
                ref={transcriptBoxRef}
                className="workspace-transcript-box"
                value={questionBodyTextRaw}
                onChange={(event) => {
                  setFinalTranscript(event.target.value);
                  setInterimTranscript("");
                }}
                onKeyDown={handleSmartInputKeyDown}
                placeholder=""
              />

              <div className="workspace-actions">
                <button
                  type="button"
                  className="workspace-secondary-btn workspace-transcript-action-btn workspace-copy-btn"
                  onClick={handleCopy}
                >
                  Copy
                </button>
                <button
                  type="button"
                  className="workspace-dark-btn workspace-transcript-action-btn workspace-generate-btn"
                  onClick={handleGenerate}
                  disabled={
                    smartInputUploadPending ||
                    smartInputIngestPending ||
                    smartInputResponsePending ||
                    composerUploadPending ||
                    (smartInputKbFilePath && !smartInputKbReady)
                  }
                >
                  <span className="workspace-generate-btn-icon" aria-hidden="true">
                    ✦
                  </span>
                  Generate
                </button>
              </div>

              <div className="workspace-input-bar">
                <button
                  type="button"
                  className="workspace-mini-btn"
                  onClick={() => composerFileInputRef.current?.click()}
                  title="Attach images"
                  disabled={composerUploadPending || smartInputResponsePending}
                >
                  <svg
                    className="workspace-composer-upload-icon"
                    viewBox="0 0 24 24"
                    width="27"
                    height="27"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M17 17H17.01M15.6 14H18C18.9319 14 19.3978 14 19.7654 14.1522C20.2554 14.3552 20.6448 14.7446 20.8478 15.2346C21 15.6022 21 16.0681 21 17C21 17.9319 21 18.3978 20.8478 18.7654C20.6448 19.2554 20.2554 19.6448 19.7654 19.8478C19.3978 20 18.9319 20 18 20H6C5.06812 20 4.60218 20 4.23463 19.8478C3.74458 19.6448 3.35523 19.2554 3.15224 18.7654C3 18.3978 3 17.9319 3 17C3 16.0681 3 15.6022 3.15224 15.2346C3.35523 14.7446 3.74458 14.3552 4.23463 14.1522C4.60218 14 5.06812 14 6 14H8.4M12 15V4M12 4L15 7M12 4L9 7" />
                  </svg>
                </button>

                <textarea
                  value={messageInput}
                  onChange={(event) => {
                    setMessageInput(event.target.value);
                    setComposerError("");
                  }}
                  onPaste={(event) => {
                    const pastedImages = Array.from(event.clipboardData?.items || [])
                      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
                      .map((item) => item.getAsFile())
                      .filter(Boolean);

                    if (!pastedImages.length) {
                      return;
                    }

                    event.preventDefault();
                    appendComposerFiles(pastedImages);
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.altKey &&
                      !event.ctrlKey &&
                      !event.metaKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                  className="workspace-message-input"
                  placeholder="Add your query or Upload image..."
                  aria-invalid={Boolean(composerError)}
                  disabled={composerUploadPending || smartInputResponsePending}
                />

                <button
                  type="button"
                  className="workspace-send-btn"
                  onClick={() => {
                    void handleSend();
                  }}
                  aria-label="Send"
                  title="Send"
                  disabled={composerUploadPending || smartInputResponsePending}
                >
                  <svg
                    className="workspace-send-icon"
                    viewBox="0 0 24 24"
                    width="27"
                    height="27"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M11.5003 12H5.41872M5.24634 12.7972L4.24158 15.7986C3.69128 17.4424 3.41613 18.2643 3.61359 18.7704C3.78506 19.21 4.15335 19.5432 4.6078 19.6701C5.13111 19.8161 5.92151 19.4604 7.50231 18.7491L17.6367 14.1886C19.1797 13.4942 19.9512 13.1471 20.1896 12.6648C20.3968 12.2458 20.3968 11.7541 20.1896 11.3351C19.9512 10.8529 19.1797 10.5057 17.6367 9.81135L7.48483 5.24303C5.90879 4.53382 5.12078 4.17921 4.59799 4.32468C4.14397 4.45101 3.77572 4.78336 3.60365 5.22209C3.40551 5.72728 3.67772 6.54741 4.22215 8.18767L5.24829 11.2793C5.34179 11.561 5.38855 11.7019 5.407 11.8459C5.42338 11.9738 5.42321 12.1032 5.40651 12.231C5.38768 12.375 5.34057 12.5157 5.24634 12.7972Z" />
                  </svg>
                </button>

                <input
                  ref={composerFileInputRef}
                  type="file"
                  accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                  multiple
                  hidden
                  onChange={handleComposerFileChange}
                />
              </div>

              {composerError && <div className="workspace-composer-error">{composerError}</div>}

              <div className="workspace-file-name">
                {composerFileNames.length
                  ? `Selected image${composerFileNames.length === 1 ? "" : "s"}: ${composerFileNames.join(", ")}`
                  : "No image selected"}
              </div>

              {composerFileNames.length ? (
                <div className="workspace-composer-attachments" aria-label="Selected message images">
                  {composerFileNames.map((fileName, index) => (
                    <span key={`${fileName}-${index}`} className="workspace-composer-attachment-chip">
                      <span className="workspace-composer-attachment-name">{fileName}</span>
                      <button
                        type="button"
                        className="workspace-composer-attachment-remove"
                        onClick={() => handleRemoveComposerFile(index)}
                        aria-label={`Remove ${fileName}`}
                        title={`Remove ${fileName}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </section>
          </div>

          <div
            className={`workspace-splitter${isPanelResizing ? " active" : ""}`}
            role="separator"
            aria-label="Resize panels"
            aria-orientation="vertical"
            tabIndex={0}
            onPointerDown={handlePanelResizePointerDown}
            onKeyDown={handlePanelResizeKeyDown}
          />

          <section className="workspace-card workspace-right">
            <div className="workspace-section-header">
              <h3>Insights</h3>

              <div className="workspace-timer-box">
                <SevenSegmentTime value={formatDuration(uptimeSeconds)} />
              </div>
            </div>

            <div ref={insightsShellRef} className="workspace-insights-shell">
              <div
                ref={insightsContentRef}
                className={`workspace-insights-box${rightText ? " workspace-insights-box-has-value" : ""}`}
                tabIndex={0}
              >
                {insightsHighlightLines.length ? (
                  insightsHighlightLines.map((line, index) => (
                    <span
                      key={`${line.type}-${index}`}
                      data-insights-question-id={line.questionId}
                      style={getInsightsLineInlineStyle(line.type)}
                      className={`workspace-insights-highlight-line${
                        line.type === "question"
                          ? " workspace-insights-highlight-question"
                          : line.type === "heading"
                            ? " workspace-insights-highlight-heading"
                            : line.type === "subheading"
                              ? " workspace-insights-highlight-subheading"
                              : line.text
                                ? ""
                                : " workspace-insights-highlight-line-empty"
                      }`}
                    >
                      {line.text || " "}
                    </span>
                  ))
                ) : (
                  <span className="workspace-insights-highlight-empty"> </span>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>

      <DocumentDomainModal
        file={pendingTranscriptUploadFile}
        isOpen={isDocumentDomainModalOpen}
        value={documentDomainDraft}
        error={documentDomainError}
        onChange={(value) => {
          setDocumentDomainDraft(value);
          if (documentDomainError) {
            setDocumentDomainError("");
          }
        }}
        onClose={resetPendingTranscriptUploadFlow}
        onContinue={handleDocumentDomainContinue}
      />
      <DomainConfirmationModal
        file={pendingTranscriptUploadFile}
        isOpen={isDocumentDomainConfirmOpen}
        domain={selectedDocumentDomain}
        onClose={resetPendingTranscriptUploadFlow}
        onNo={resetPendingTranscriptUploadFlow}
        onYes={() => {
          void handleConfirmedTranscriptUpload();
        }}
      />
      <PreviewModal
        file={transcriptFile}
        isOpen={previewOpen}
        previewUrl={previewUrl}
        onClose={() => setPreviewOpen(false)}
      />
    </div>
  );
}

export default UserWorkspacePage;
