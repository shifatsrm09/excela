"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import styles from "./dashboard.module.css";
import publicStyles from "./public.module.css";
import Landing from "./landing";
import PageSkeleton from "./page-skeleton";
import PendingLink from "./pending-link";
import { SIGN_IN_CHANNEL, startGoogleSignIn } from "./google-sign-in";
import type { Session } from "@/lib/session-payload";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, type ImageInput } from "@/lib/image-input";


type Pipeline = "academic" | "general";

type ViewLink = { sheet: string; url: string; base: string; gid: number; row: number };

// Google Sheets scrolls so the selected cell sits at the top of the window. Selecting a cell above the
// edited row leaves the edited row around the middle of the screen. Column A keeps the default
// horizontal scroll. Sheets' own toolbars take roughly 220px and each row is about 21px tall.
function centeredSheetUrl(link: ViewLink) {
  const visibleRows = Math.max(10, Math.floor((window.innerHeight - 220) / 21));
  const top = Math.max(1, link.row - Math.floor(visibleRows / 2));
  return `${link.base}#gid=${link.gid}&range=A${top}`;
}

// The user's local calendar date (YYYY-MM-DD). Sent with each request so the AI can resolve
// "today", "tomorrow", "yesterday" and similar words against the right day.
function localToday() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const signInMessages: Record<string, string> = {
  denied: "Google permission was not granted. Continue with Google again and allow access to files you create or select with Excela.",
  invalid_state: "Sign-in expired or was opened in a different browser. Please try again.",
  unverified: "That Google account's email is not verified. Use a verified Google account.",
  database: "Signed in with Google, but Excela could not reach its database. Check MONGODB_URI and Atlas network access.",
  failed: "Google sign-in failed. Check the OAuth credentials and the registered redirect URL.",
};

// `initialSession` comes from the server, so the right screen shows on the first paint.
// It is null only when the database could not be reached; then the browser asks again.
export default function HomeClient({ initialSession }: { initialSession: Session | null }) {
  const [message, setMessage] = useState("");
  const [attachment, setAttachment] = useState<(ImageInput & { name: string }) | null>(null);
  const [readingImage, setReadingImage] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageReadId = useRef(0);

  async function attachImage(file: File) {
    if (loading || syncing || readingImage) return;
    if (!IMAGE_TYPES.includes(file.type) || file.size > MAX_IMAGE_BYTES || !file.size) {
      setError("Choose a PNG, JPEG or WebP image up to 3 MB.");
      return;
    }
    const readId = ++imageReadId.current;
    setReadingImage(true);
    setError("");
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read image."));
        reader.onerror = () => reject(new Error("Could not read image."));
        reader.readAsDataURL(file);
      });
      if (readId !== imageReadId.current) return;
      setAttachment({ name: file.name || "Pasted screenshot", mimeType: file.type, data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
      resetResults();
    } catch {
      if (readId === imageReadId.current) setError("Could not read the image. Try another file.");
    } finally { if (readId === imageReadId.current) setReadingImage(false); }
  }

  function clearAttachment() {
    imageReadId.current++;
    setAttachment(null);
    setReadingImage(false);
  }
  const [response, setResponse] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pipeline, setPipeline] = useState<Pipeline>("general");
  const [outputTab, setOutputTab] = useState<"json" | "log">("json");
  const [logs, setLogs] = useState<{ time: string; text: string; tone: "info" | "ok" | "error" }[]>([]);
  const [events, setEvents] = useState<{ course: string; title: string; date: string }[]>([]);
  const [completionDate, setCompletionDate] = useState<string | null>(null);
  const [dayAction, setDayAction] = useState<"complete_day" | "uncomplete_day">("complete_day");
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [viewLinks, setViewLinks] = useState<ViewLink[]>([]);
  const [session, setSession] = useState<Session | null>(initialSession);
  const [resolvingSignIn, setResolvingSignIn] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sidebarOpen) return;
    function closeSidebar(event: KeyboardEvent) {
      if (event.key === "Escape") setSidebarOpen(false);
    }
    document.addEventListener("keydown", closeSidebar);
    return () => document.removeEventListener("keydown", closeSidebar);
  }, [sidebarOpen]);

  useEffect(() => {
    let active = true;
    const status = new URLSearchParams(window.location.search).get("google");
    if (status) {
      if (status !== "connected") setError(signInMessages[status] || "Please sign in with Google again.");
      window.history.replaceState(null, "", window.location.pathname);
    }
    async function loadSession() {
      // When the server already told us who is signed in, this is a quiet background refresh
      // (it renews the session and picks up changes); a failure must not kick anyone out.
      const quiet = initialSession !== null;
      try {
        const result = await fetch("/api/google/status", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
        const data = await result.json();
        if (!active) return;
        if (!result.ok) {
          if (quiet) return;
          setError(data.error || "Could not load your session.");
          setSession({ authenticated: false });
          return;
        }
        setSession(data);
      } catch {
        if (!active || quiet) return;
        setError("Could not load your session. Check your connection and refresh.");
        setSession({ authenticated: false });
      }
    }
    // The server already said nobody is signed in: nothing to fetch.
    if (!initialSession?.authenticated && initialSession !== null) return;
    void loadSession();
    return () => { active = false; };
  }, [initialSession]);

  // The sign-in popup reports the result here once Google sends the user back to Excela.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(SIGN_IN_CHANNEL);
    channel.onmessage = async (event: MessageEvent<{ status?: string }>) => {
      const status = event.data?.status;
      if (!status) return;
      if (status !== "connected") {
        setError(signInMessages[status] || "Please sign in with Google again.");
        return;
      }
      setError("");
      setNotice("");
      setResolvingSignIn(true);
      try {
        const result = await fetch("/api/google/status", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
        const data = await result.json();
        if (result.ok) setSession(data);
        else setError(data.error || "Could not load your session.");
      } catch {
        setError("Could not load your session. Check your connection and refresh.");
      } finally {
        setResolvingSignIn(false);
      }
    };
    return () => channel.close();
  }, []);

  // Closes the settings menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function closeMenu() {
      setMenuOpen(false);
      setConfirmingDelete(false);
    }
    function onPointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) closeMenu();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenu();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  // Keeps the UI in step with what the server says about the session.
  function handleAuthCode(code?: string) {
    if (code === "auth") setSession({ authenticated: false });
    if (code === "reauth") setSession((current) => (current?.authenticated ? { ...current, googleAccess: false } : current));
    if (code === "no_sheet") setSession((current) => (current?.authenticated ? { ...current, sheet: null } : current));
    if (code === "setup_required") setSession((current) => (current?.authenticated ? { ...current, hasApiKey: false } : current));
  }

  // One line per step of an injection, shown in the Output panel's LOG view.
  function addLog(text: string, tone: "info" | "ok" | "error" = "info") {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setLogs((current) => [...current, { time, text, tone }]);
  }

  function choosePipeline(next: Pipeline) {
    if (next === pipeline) return;
    setPipeline(next);
    setError("");
    resetResults();
  }

  function resetResults() {
    setCompletionDate(null);
    setLogs([]);
    setViewLinks([]);
    setResponse("");
    setEvents([]);
    setSynced(false);
    setSyncMessage("");
  }

  async function handleSignOut() {
    clearAttachment();
    try { await fetch("/api/auth/logout", { method: "POST" }); }
    catch { /* The server-side session expires on its own if this fails. */ }
    setSession({ authenticated: false });
    setMessage("");
    setNotice("");
    setConfirmingDelete(false);
    setMenuOpen(false);
    setSidebarOpen(false);
    setError("");
    resetResults();
  }

  async function handleDeleteAccount() {
    if (deleting) return;
    setDeleting(true);
    setError("");
    try {
      const result = await fetch("/api/account", { method: "DELETE" });
      const data = await result.json();
      if (!result.ok) {
        handleAuthCode(data.code);
        throw new Error(data.error || "Unable to delete your account.");
      }
      setSession({ authenticated: false });
      setMessage("");
      clearAttachment();
      setConfirmingDelete(false);
      setMenuOpen(false);
      resetResults();
      setNotice("Your account and all data Excela stored about you were deleted.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to delete your account.");
    } finally {
      setDeleting(false);
    }
  }

  // Writes events to the user's planner. Runs right after extraction (Inject) and for "Retry sync".
  async function runSync(list: { course: string; title: string; date: string }[], date: string | null = null, action: "complete_day" | "uncomplete_day" = "complete_day") {
    setSyncing(true);
    addLog("Writing to your planner…");
    setSyncMessage("");
    setViewLinks([]);
    setError("");
    try {
      const result = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(date ? { action, date } : { action: "add_events", events: list }),
      });
      const data = await result.json();
      if (!result.ok) {
        handleAuthCode(data.code);
        throw new Error(data.error || "Unable to sync with Google Sheets.");
      }
      setSynced(true);
      const summary = date
        ? action === "uncomplete_day"
          ? (data.uncompleted ? `Marked pending: ${data.uncompleted} task(s) on ${date}.` : `No completed blue tasks on ${date}. Nothing changed.`)
          : (data.completed ? `Completed: ${data.completed} task(s) on ${date}.` : `No pending red tasks on ${date}. Nothing changed.`)
        : `Injected: ${data.written} event(s) written, ${data.skipped} already present.`;
      setSyncMessage(summary);
      addLog(summary, "ok");
      setViewLinks(Array.isArray(data.links) ? data.links : []);
    } catch (error) {
      addLog(error instanceof Error ? error.message : "Unable to sync with Google Sheets.", "error");
      setError(error instanceof Error ? error.message : "Unable to sync with Google Sheets.");
    } finally {
      setSyncing(false);
    }
  }

  // Retries only the planner step, so the AI isn't called (and charged) again after a failed sync.
  async function handleSync() {
    if ((!events.length && !completionDate) || syncing || synced || loading) return;
    await runSync(events, completionDate, dayAction);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedMessage = message.trim();

    if ((!trimmedMessage && !attachment) || readingImage || loading || syncing || !session?.authenticated || !session.sheet || !session.hasApiKey || !session.googleAccess) return;

    setError("");
    resetResults();

    setLoading(true);
    addLog(`Reading your message with Ollama (${pipeline} pipeline)…`);

    try {
      const result = await fetch("/api/ai", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: trimmedMessage,
          pipeline,
          today: localToday(),
          ...(attachment ? { image: { mimeType: attachment.mimeType, data: attachment.data } } : {}),
        }),
      });

      if (result.status === 413) {
        throw new Error("The attachment is too large. Try a smaller image.");
      }
      const data = await result.json();

      if (!result.ok) {
        handleAuthCode(data.code);
        throw new Error(data.error || "Unable to send your message.");
      }

      if (
        !data.response ||
        (typeof data.response !== "string" &&
          typeof data.response !== "object")
      ) {
        throw new Error("No response received. Please try again.");
      }

      const extracted = Array.isArray(data.response?.events) ? data.response.events : [];
      const action = data.response?.action === "uncomplete_day" ? "uncomplete_day" : "complete_day";
      const date = ["complete_day", "uncomplete_day"].includes(data.response?.action) && typeof data.response.date === "string" ? data.response.date : null;
      setDayAction(action);
      setCompletionDate(date);
      setEvents(extracted);
      setResponse(
        typeof data.response === "string"
          ? data.response
          : JSON.stringify(data.response, null, 2)
      );
      addLog(date ? `Marking tasks ${action === "uncomplete_day" ? "pending" : "complete"} on ${date}.` : extracted.length ? `Found ${extracted.length} event(s).` : "Declined: no supported planner action found.", date || extracted.length ? "ok" : "info");
      // Inject = extract with AI, then write straight to the planner.
      if (date || extracted.length) await runSync(extracted, date, action);
      else setSyncMessage("No events were found in that message, so nothing was injected.");
    } catch (error) {
      addLog(error instanceof Error ? error.message : "Something went wrong.", "error");
      setError(
        error instanceof Error
          ? error.message
          : "Something went wrong."
      );
    } finally {
      setLoading(false);
    }
  }

  if (resolvingSignIn || session === null) return <PageSkeleton />;

  if (!session.authenticated) {
    return <Landing pending={session === null} error={error} notice={notice} />;
  }

  const setupComplete = Boolean(session.sheet && session.hasApiKey);

  return (
    <div className={styles.dashboard} data-sidebar-open={sidebarOpen}>
      <a href="#dashboard-content" className={styles.skip}>Skip to dashboard</a>
      <header className={styles.navbar}>
        <nav className={styles.navigation} aria-label="Main navigation">
          <Link href="/" className={publicStyles.brand} aria-label="Excela home">
            <Image src="/excela-r.png" alt="" width={34} height={34} priority />
            excela<span className={publicStyles.brandDot}>.</span>
          </Link>
          <button
            type="button"
            className={styles.menuToggle}
            aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            aria-expanded={sidebarOpen}
            aria-controls="dashboard-sidebar"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            <span /><span /><span />
          </button>
        </nav>
        <span className={styles.navTitle}>Your workspace</span>
            <div className={styles.account}>
              <div className={styles.identity}>
                {session.user.picture && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={session.user.picture}
                    alt=""
                    width={36}
                    height={36}
                    referrerPolicy="no-referrer"
                    className="h-9 w-9 rounded-full"
                  />
                )}
                <div className={styles.identityText}>
                  <p className="font-medium">{session.user.name}</p>
                  <p className="text-zinc-400 dark:text-zinc-400">{session.user.email}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {session.sheet && (
                  <a
                    href="/api/sheet/open"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => {
                      // Pass the browser's local month so it matches the user's time zone.
                      event.preventDefault();
                      const now = new Date();
                      window.open(
                        `/api/sheet/open?y=${now.getFullYear()}&m=${now.getMonth() + 1}`,
                        "_blank",
                        "noopener,noreferrer",
                      );
                    }}
                    className={styles.sheetLink}
                    aria-label="View your sheet"
                  >
                    <svg className={styles.sheetIcon} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
                    <span className={styles.sheetLabel}>View your sheet</span>
                  </a>
                )}
                <div ref={menuRef} className="relative">
                  <button
                    type="button"
                    aria-label="Settings"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={() => {
                      setMenuOpen((open) => !open);
                      setConfirmingDelete(false);
                    }}
                    className="rounded-lg border border-zinc-700 p-2 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    <svg
                      aria-hidden="true"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={1.5}
                      stroke="currentColor"
                      className="h-5 w-5"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.826a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
                      />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    </svg>
                  </button>
                  {menuOpen && (
                    <div
                      role="menu"
                      aria-label="Account settings"
                      className="absolute right-0 top-full z-10 mt-2 w-72 rounded-xl border border-zinc-800 bg-zinc-900 p-2 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
                    >
                      {confirmingDelete ? (
                        <div className="flex flex-col gap-3 p-2">
                          <p role="alert" className="text-sm font-medium text-red-400 dark:text-red-400">
                            Delete your account?
                          </p>
                          <p className="text-sm text-zinc-400 dark:text-zinc-400">
                            This permanently deletes your Excela account and everything Excela stores about you: your
                            profile, saved planner link, Google access and sign-in sessions. Your Google Sheets are not
                            changed or deleted. This cannot be undone.
                          </p>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={handleDeleteAccount}
                              disabled={deleting}
                              className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {deleting ? "Deleting…" : "Yes, delete everything"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmingDelete(false)}
                              disabled={deleting}
                              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={handleSignOut}
                            className="w-full rounded-lg px-3 py-2 text-left text-sm font-medium hover:bg-zinc-800 dark:hover:bg-zinc-800"
                          >
                            Sign out
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => setConfirmingDelete(true)}
                            className="w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-red-400 hover:bg-red-950 dark:text-red-400 dark:hover:bg-red-950"
                          >
                            Delete account
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>


      </header>

      <aside id="dashboard-sidebar" aria-label="Sidebar" aria-hidden={!sidebarOpen} inert={!sidebarOpen} className={styles.sidebar}>
        <nav aria-label="Planner settings" className={styles.sidebarNav}>
          <PendingLink href="/setup" className={styles.sidebarAction}>Planner &amp; API settings ↗</PendingLink>
          <PendingLink href="/discord" className={styles.sidebarAction}>Discord announcements ↗</PendingLink>
        </nav>
      </aside>
      {sidebarOpen && <button type="button" className={styles.backdrop} aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}

      <main id="dashboard-content" className={styles.main}>
        <div className={styles.content}>
          {error && <p role="alert" className={styles.error}>{error}</p>}
          {notice && <p role="status" className={styles.notice}>{notice}</p>}
          {!session.googleAccess && (
            <p role="alert" className={styles.warning}>
              Reconnect Google to access your planner.{" "}
              <a href="/api/google/connect?consent=1" onClick={(event) => { event.preventDefault(); startGoogleSignIn(true); }}>
                Sign in with Google again ↗
              </a>
            </p>
          )}

          <div className={styles.workspaceGate}>
          <div className={styles.workspace} data-locked={!setupComplete} inert={!setupComplete} aria-hidden={!setupComplete}>
            <section className={styles.panel} aria-labelledby="input-heading">
              <div className={styles.tabBar}>
                <h2 id="input-heading">Input</h2>
                <div className={styles.segmented} role="group" aria-label="Input type">
                  <button type="button" aria-pressed={pipeline === "general"} data-active={pipeline === "general"} disabled={loading || syncing} onClick={() => choosePipeline("general")}>General</button>
                  <button type="button" aria-pressed={pipeline === "academic"} data-active={pipeline === "academic"} disabled={loading || syncing} onClick={() => choosePipeline("academic")}>Academic</button>
                </div>
              </div>
              <form onSubmit={handleSubmit} className={styles.form} onPaste={(event) => {
                const files = Array.from(event.clipboardData.items).filter((item) => item.kind === "file" && item.type.startsWith("image/"));
                if (!files.length) return;
                event.preventDefault();
                if (files.length > 1) { setError("Attach one image at a time."); return; }
                const file = files[0].getAsFile();
                if (file) void attachImage(file);
              }}>
                {attachment && <div className={styles.attachment}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="Attached announcement" />
                  <span>{attachment.name}</span>
                  <button type="button" disabled={loading || syncing || readingImage} onClick={() => { clearAttachment(); resetResults(); }} aria-label="Remove attached image">Remove ×</button>
                </div>}
                <textarea id="message" enterKeyHint="enter" aria-label={pipeline === "general" ? "Task" : "Announcement"} value={message} onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    // Touch-first devices keep the keyboard's normal newline behavior.
                    // Desktop Enter submits; Shift+Enter and IME composition stay native.
                    const touchKeyboard = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
                    if (!touchKeyboard && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }} placeholder={attachment ? "Add context (optional)…" : pipeline === "general" ? "Type a plan, or paste a screenshot here…" : "Type an announcement, or paste a screenshot here…"} rows={7} required={!attachment} maxLength={20000} disabled={loading || syncing || !session.sheet} />
                <div className={styles.formFooter}>
                  <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void attachImage(file); }} />
                  <button type="button" className={styles.secondary} disabled={loading || syncing || readingImage || !setupComplete} onClick={() => imageInputRef.current?.click()}>{readingImage ? "Reading image…" : attachment ? "Replace image" : "Add image +"}</button>
                  <button type="submit" className={styles.primary} disabled={loading || syncing || readingImage || !session.googleAccess || !setupComplete}>
                    {loading ? "Injecting…" : syncing ? "Injecting…" : "Inject ↗"}
                  </button>
                </div>
                <p className={styles.hint}>{session.sheet ? <><span className={styles.desktopKeyboardHint}>Press Enter to inject · Shift+Enter for a new line.</span><span className={styles.touchKeyboardHint}>Return adds a new line · Tap Inject when ready.</span></> : "Connect or generate a planner to get started."}</p>
              </form>
            </section>

            <section className={styles.panel} aria-labelledby="output-heading" aria-live="polite" aria-busy={loading || syncing}>
              <div className={styles.tabBar}>
                <h2 id="output-heading">Output</h2>
                <div className={styles.segmented} role="group" aria-label="Output view">
                  <button type="button" aria-pressed={outputTab === "json"} data-active={outputTab === "json"} onClick={() => setOutputTab("json")}>JSON</button>
                  <button type="button" aria-pressed={outputTab === "log"} data-active={outputTab === "log"} onClick={() => setOutputTab("log")}>LOG</button>
                </div>
              </div>
              {outputTab === "log" ? (
                logs.length ? (
                  <ol className={styles.log} aria-label="Injection log">
                    {logs.map((entry, index) => (
                      <li key={index} data-tone={entry.tone}><time>{entry.time}</time><span>{entry.text}</span></li>
                    ))}
                  </ol>
                ) : (
                  <div className={styles.emptyState}>
                    <p>No activity yet.</p>
                    <span>Each step of an injection is listed here.</span>
                  </div>
                )
              ) : response ? (
                <pre className={styles.response}>{response}</pre>
              ) : (
                <div className={styles.emptyState}>
                  <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 3v4m8-4v4M4 11h16m-11 5h6" /></svg>
                  <p>Your next plan starts here.</p>
                  <span>Paste an announcement to turn it into a planner entry.</span>
                </div>
              )}
              <div className={styles.outputFooter}>
                {viewLinks.map((link) => <a key={link.url}
                              onClick={(event) => {
                                event.currentTarget.href = centeredSheetUrl(link);
                              }} href={link.url} target="_blank" rel="noopener noreferrer" className={styles.secondary}>{viewLinks.length > 1 ? 'View changes in ' + link.sheet : "View changes"} ↗</a>)}
                {(events.length > 0 || completionDate) && !synced && !loading && !syncing && <button type="button" className={styles.primary} onClick={handleSync} disabled={!session.googleAccess}>Retry sync ↗</button>}
                {syncMessage && <p role="status" className={styles.outputStatus} data-tone={synced ? undefined : "info"}>{syncMessage}</p>}
              </div>
              <p role="status" className={`${styles.hint} ${styles.outputHint}`}>{syncing ? "Writing to your planner…" : loading ? "Reading your message…" : "Use LOG to follow each step of an injection."}</p>
            </section>
          </div>
          {!setupComplete && <div className={styles.setupOverlay}><div className={styles.setupPrompt}><h2>A little setup. Then you are ready.</h2><p>Connect your planner and your personal Ollama API key.</p><PendingLink href="/setup" className={styles.primary}>Complete setup ↗</PendingLink></div></div>}
          </div>
          <footer className={styles.footer}><span>Your sheet. A little less to remember.</span><nav aria-label="Legal"><Link href="/privacy">Privacy policy</Link><Link href="/terms">Terms of service</Link></nav></footer>
        </div>
      </main>
    </div>
  );
}
