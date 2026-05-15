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

function createDefaultActivityMessage() {
  return {
    text: "Ready to capture transcript input.",
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

function getActivityState(isListening, transcriptLines) {
  if (isListening) {
    return "Listening";
  }

  if (transcriptLines.length) {
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
  const [composerFile, setComposerFile] = useState(null);
  const [composerError, setComposerError] = useState("");
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
  const insightsHighlightRef = useRef(null);
  const insightsTextareaRef = useRef(null);
  const pendingInsightsCenterQuestionIdRef = useRef("");

  const transcriptText = joinTranscriptSegments(transcriptLines);
  const questionLabel = `Q${questionNumber}`;
  const questionBodyTextRaw = `${finalTranscript}${finalTranscript && interimTranscript ? " " : ""}${interimTranscript}`;
  const questionBodyText = questionBodyTextRaw.trim();
  const generatedQuestionText = questionBodyText ? `${questionLabel}: ${questionBodyText}` : "";
  const activityState = getActivityState(isListening, transcriptLines);
  const profileInitials = getProfileInitials(sessionUser?.email);
  const selectedTranscriptFileName = String(transcriptFile?.name || transcriptFileName || "").trim();
  const selectedGeneratedQuestion =
    generatedQuestions.find((question) => question.id === selectedGeneratedQuestionId) || null;
  const insightsHighlightLines = getInsightsHighlightLines(rightText);

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
    const highlightLayer = insightsHighlightRef.current;
    const insightsTextarea = insightsTextareaRef.current;

    if (!normalizedQuestionId || !highlightLayer || !insightsTextarea) {
      return false;
    }

    const targetNode = Array.from(highlightLayer.querySelectorAll("[data-insights-question-id]")).find(
      (node) => node.dataset.insightsQuestionId === normalizedQuestionId,
    );

    if (!targetNode) {
      return false;
    }

    const desiredViewportOffset = insightsTextarea.clientHeight * INSIGHTS_NEW_QUESTION_VIEWPORT_OFFSET_RATIO;
    const maxScrollTop = Math.max(0, insightsTextarea.scrollHeight - insightsTextarea.clientHeight);
    const targetScrollTop = Math.min(
      maxScrollTop,
      Math.max(0, targetNode.offsetTop + targetNode.offsetHeight / 2 - desiredViewportOffset),
    );

    insightsTextarea.scrollTop = targetScrollTop;
    highlightLayer.scrollTop = targetScrollTop;
    return true;
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
        setActivityStatus("Live capture started from shared screen audio.", "success");
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

    const highlightLayer = insightsHighlightRef.current;
    const insightsTextarea = insightsTextareaRef.current;

    if (!highlightLayer || !insightsTextarea) {
      return undefined;
    }

    const targetNode = Array.from(highlightLayer.querySelectorAll("[data-insights-question-id]")).find(
      (node) => node.dataset.insightsQuestionId === pendingQuestionId,
    );

    if (!targetNode) {
      return undefined;
    }

    const reservePx = Math.max(
      0,
      insightsTextarea.clientHeight * (1 - INSIGHTS_NEW_QUESTION_VIEWPORT_OFFSET_RATIO) - targetNode.offsetHeight / 2,
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
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isQuestionDropdownOpen]);

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

  const syncInsightsScroll = (event) => {
    if (!insightsHighlightRef.current) {
      return;
    }

    insightsHighlightRef.current.scrollTop = event.target.scrollTop;
    insightsHighlightRef.current.scrollLeft = event.target.scrollLeft;
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
    setComposerFile(null);
    setComposerError("");
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

  const handleStop = () => {
    closeTranscriptStream({ markClosed: true, sendStopSignal: true });
    teardownScreenAudioPipeline();
    setFinalTranscript("");
    setInterimTranscript("");
    setIsListening(false);
    setActivityStatus("Capture stopped.", "info");
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

  const handleGenerate = async () => {
    const transcriptText = questionBodyText.trim();

    if (!transcriptText) {
      setActivityStatus("No transcript available to generate.", "info");
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

    const generatedQuestion = {
      id: questionLabel,
      label: `${questionLabel} : ${transcriptText}`,
      text: generatedQuestionText,
      answer: "",
      error: "",
    };

    pendingInsightsCenterQuestionIdRef.current = generatedQuestion.id;
    setRightText((current) => {
      const existingText = String(current || "").trim();
      return existingText ? `${existingText}\n\n${generatedQuestionText}` : generatedQuestionText;
    });
    setGeneratedQuestions((current) => [...current, generatedQuestion]);
    setSelectedGeneratedQuestionId(generatedQuestion.id);
    setIsQuestionDropdownOpen(false);
    setTranscriptLines([]);
    setFinalTranscript("");
    setInterimTranscript("");
    setQuestionNumber((current) => current + 1);
    setActivityStatus("Transcript moved into Insights. Generating answer...", "info");

    try {
      const tabToken = getOrCreateTabToken();
      const requestBody = { query: transcriptText };
      if (smartInputKbFilePath) {
        requestBody.files = [smartInputKbFilePath];
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

      setRightText((current) => {
        const existingText = String(current || "");
        return existingText ? `${existingText}\n\n` : "";
      });

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

        // SSE messages are delimited by a blank line.
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
    }
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

  const uploadSmartInputDocument = async (file) => {
    if (!file) {
      return "";
    }

    setSmartInputUploadPending(true);
    setActivityStatus("Uploading Smart Input document...", "info");

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

      setActivityStatus("Smart Input document uploaded.", "success");
      return uploadedPath;
    } finally {
      setSmartInputUploadPending(false);
    }
  };

  const ingestSmartInputDocument = async (uploadedPath) => {
    const filePath = String(uploadedPath || "").trim();
    if (!filePath) {
      return;
    }

    setSmartInputIngestPending(true);
    setSmartInputKbReady(false);
    setActivityStatus("Indexing Smart Input document (creating embeddings)...", "info");

    try {
      const tabToken = getOrCreateTabToken();
      const response = await fetch("/api/smart-input/ingest", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-voxscribe-tab": tabToken,
        },
        body: JSON.stringify({ files: [filePath] }),
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
      setActivityStatus("Smart Input document indexed. You can generate now.", "success");
    } finally {
      setSmartInputIngestPending(false);
    }
  };

  const handleTranscriptFileChange = async (event) => {
    const file = event.target.files?.[0] || null;

    if (!file) {
      setTranscriptFile(null);
      setTranscriptFileName("");
      setSmartInputKbFilePath("");
      setSmartInputKbReady(true);
      setActivityStatus("No transcript document selected.", "info");
      return;
    }

    if (!isAllowedTranscriptFile(file)) {
      event.target.value = "";
      setTranscriptFile(null);
      setTranscriptFileName("");
      setSmartInputKbFilePath("");
      setSmartInputKbReady(true);
      setActivityStatus("Only DOC, DOCX, and PDF files are allowed for transcript upload.", "error");
      return;
    }

    resetWorkspaceForNewDocument();
    setTranscriptFile(file);
    setTranscriptFileName(String(file.name || "").trim());
    setSmartInputKbReady(false);
    let uploadedPath = "";

    try {
      uploadedPath = await uploadSmartInputDocument(file);
      setSmartInputKbFilePath(uploadedPath);
      await ingestSmartInputDocument(uploadedPath);
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

  const handleComposerFileChange = (event) => {
    const file = event.target.files?.[0] || null;
    setComposerFile(file);
    setComposerError("");
  };

  const handleSend = () => {
    const message = messageInput.trim();

    if (!message && !composerFile) {
      setComposerError("Type a message or choose a file before sending.");
      return;
    }

    setComposerError("");

    setTranscriptLines((current) => {
      const next = [...current];
      const composerFileLabel = getComposerFileLabel(composerFile);

      if (message) {
        next.push(createTranscriptLine(message, "You"));
      }

      if (composerFile) {
        next.push(createTranscriptLine(composerFileLabel, "File uploaded"));
      }

      return next;
    });

    if (message) {
      setRightText((current) => {
        const existingText = String(current || "").trim();
        return existingText ? `${existingText}\n\n${message}` : message;
      });
    }

    if (composerFile) {
      setRightText((current) => {
        const existingText = String(current || "").trim();
        const fileMessage = `Uploaded file: ${getComposerFileLabel(composerFile)}`;
        return existingText ? `${existingText}\n\n${fileMessage}` : fileMessage;
      });
    }

    setMessageInput("");
    setComposerFile(null);

    if (composerFileInputRef.current) {
      composerFileInputRef.current.value = "";
    }
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
            <section className="workspace-card">
              <div className="workspace-controls">
                <div className="workspace-controls-row">
                  <div className="workspace-control-group">
                    <button type="button" className="workspace-primary-btn" onClick={handleStart} disabled={isListening}>
                      Start
                    </button>
                    <button type="button" className="workspace-danger-btn" onClick={handleStop} disabled={!isListening}>
                      Stop
                    </button>
                    <button type="button" className="workspace-neutral-btn" onClick={handleClear}>
                      Clear
                    </button>
                  </div>

                  <button
                    type="button"
                    className={`workspace-icon-btn workspace-screen-share-btn${
                      isScreenShareEnabled ? " workspace-icon-btn-active" : ""
                    }`}
                    onClick={handleScreenShare}
                    aria-label="Screen Share"
                    aria-pressed={isScreenShareEnabled}
                    title={isScreenShareEnabled ? "Turn off Screen Share" : "Turn on Screen Share"}
                  >
                    <svg
                      className="workspace-screen-share-icon"
                      viewBox="0 0 24 24"
                      width="22"
                      height="22"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3" />
                      <path d="M8 21h8" />
                      <path d="M12 17v4" />
                      <path d="M17 8l5-5" />
                      <path d="M17 3h5v5" />
                    </svg>
                  </button>
                </div>

                <div className="workspace-controls-row workspace-controls-row-bottom">
                  <div className="workspace-status">
                    Status:
                    <span className={`workspace-badge workspace-badge-${activityState.toLowerCase()}`}>
                      {activityState}
                    </span>
                  </div>

                  <label className="workspace-tier-select">
                    <span>Service Tier</span>
                    <select value={tier} onChange={(event) => setTier(event.target.value)}>
                      <option value="core">Core</option>
                      <option value="pro">Pro</option>
                      <option value="elite">Elite</option>
                      <option value="ultra">Ultra</option>
                    </select>
                  </label>
                </div>
              </div>

              <div className={`workspace-activity-note ${activityMessage.type}`}>{activityMessage.text}</div>
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
                          className={`workspace-question-dropdown-option${
                            selectedGeneratedQuestionId === "" ? " selected" : ""
                          }`}
                          onClick={() => {
                            setSelectedGeneratedQuestionId("");
                            setIsQuestionDropdownOpen(false);
                          }}
                        >
                          Select question
                        </button>

                        {generatedQuestions.map((question) => (
                          <button
                            key={question.id}
                            type="button"
                            className={`workspace-question-dropdown-option${
                              selectedGeneratedQuestionId === question.id ? " selected" : ""
                            }`}
                            onClick={() => {
                              setSelectedGeneratedQuestionId(question.id);
                              setIsQuestionDropdownOpen(false);
                            }}
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
                placeholder="......"
              />

              <div className="workspace-actions">
                <button type="button" className="workspace-secondary-btn" onClick={handleCopy}>
                  Copy
                </button>
                <button
                  type="button"
                  className="workspace-dark-btn"
                  onClick={handleGenerate}
                  onMouseEnter={(event) => {
                    if (event.currentTarget.disabled) {
                      return;
                    }

                    event.currentTarget.style.transform = "scale(1.05)";
                    event.currentTarget.style.background = "linear-gradient(to right, #77daff, #7c6bff)";
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.transform = "";
                    event.currentTarget.style.background = "linear-gradient(to right, #5cc8ff, #6b5cff)";
                  }}
                  disabled={smartInputUploadPending || smartInputIngestPending || (smartInputKbFilePath && !smartInputKbReady)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "12px 24px",
                    border: "none",
                    borderRadius: 12,
                    background: "linear-gradient(to right, #5cc8ff, #6b5cff)",
                    color: "#ffffff",
                    fontSize: 18,
                    fontWeight: 600,
                    boxShadow: "0 4px 10px rgba(0,0,0,0.15)",
                    transition: "transform 0.3s ease, background 0.3s ease",
                  }}
                >
                  <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1 }}>
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
                  title="Attach file"
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
                    const clipboardItems = Array.from(event.clipboardData?.items || []);
                    const imageItem = clipboardItems.find((item) => item.kind === "file" && item.type.startsWith("image/"));
                    const pastedImage = imageItem?.getAsFile() || null;

                    if (!pastedImage) {
                      return;
                    }

                    event.preventDefault();
                    setComposerFile(pastedImage);
                    setComposerError("");
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
                      handleSend();
                    }
                  }}
                  className="workspace-message-input"
                  placeholder="Type your message..."
                  aria-invalid={Boolean(composerError)}
                />

                <button
                  type="button"
                  className="workspace-send-btn"
                  onClick={handleSend}
                  aria-label="Send"
                  title="Send"
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

                <input ref={composerFileInputRef} type="file" hidden onChange={handleComposerFileChange} />
              </div>

              {composerError && <div className="workspace-composer-error">{composerError}</div>}

              <div className="workspace-file-name">
                {composerFile ? `Selected file: ${getComposerFileLabel(composerFile)}` : "No file selected"}
              </div>
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
              <div ref={insightsHighlightRef} className="workspace-insights-highlight" aria-hidden="true">
                {insightsHighlightLines.length ? (
                  insightsHighlightLines.map((line, index) => (
                    <span
                      key={`${line.type}-${index}`}
                      data-insights-question-id={line.questionId}
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

              <textarea
                ref={insightsTextareaRef}
                value={rightText}
                onChange={(event) => setRightText(event.target.value)}
                onScroll={syncInsightsScroll}
                className={`workspace-insights-box${rightText ? " workspace-insights-box-has-value" : ""}`}
                placeholder="Backend data will appear here..."
              />
            </div>
          </section>
        </div>
      </div>

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
