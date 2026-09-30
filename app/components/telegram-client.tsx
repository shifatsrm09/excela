"use client";

import { useEffect, useState } from "react";
import type { Session } from "@/lib/session-payload";
import { useAuth } from "./auth-context";
import styles from "./telegram.module.css";

type SignedInSession = Extract<Session, { authenticated: true }>;

type TelegramStatus = {
  connected: boolean;
  username?: string;
  firstName?: string;
  linkedAt?: string;
};

export default function TelegramClient({
  initialSession,
}: {
  initialSession: SignedInSession;
}) {
  const { updateSession } = useAuth();

  const [telegram, setTelegram] = useState<TelegramStatus>(
    initialSession.telegram ?? { connected: false },
  );

  const [linkingState, setLinkingState] = useState<{
    code: string;
    botUrl: string;
    expiresAt: string;
  } | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  // Poll for connection status ONLY while a linking code is actively on screen
  useEffect(() => {
    if (!linkingState || telegram.connected) return;

    let active = true;
    const checkStatus = async () => {
      try {
        const res = await fetch("/api/telegram/status", { cache: "no-store" });
        if (!res.ok || !active) return;
        const data: TelegramStatus = await res.json();
        if (!active) return;

        if (data.connected) {
          setTelegram(data);
          setLinkingState(null);
          setNotice("Your Telegram account is now connected! You can start chatting with @ExcelaPlannerBot.");
          setError("");
          updateSession((prev) => ({
            ...prev,
            telegram: {
              connected: true,
              username: data.username,
              firstName: data.firstName,
              linkedAt: data.linkedAt,
            },
          }));
        }
      } catch {
        // Best-effort check
      }
    };

    const timer = setInterval(checkStatus, 3000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [linkingState, telegram.connected, updateSession]);

  async function handleStartLinking() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/telegram/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not generate linking code.");
      }
      setLinkingState({
        code: data.code,
        botUrl: data.botUrl,
        expiresAt: data.expiresAt,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start linking.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/telegram/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not disconnect Telegram.");
      }
      setTelegram({ connected: false });
      setConfirmingDisconnect(false);
      setNotice("Telegram account disconnected successfully.");
      updateSession((prev) => ({
        ...prev,
        telegram: { connected: false },
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setBusy(false);
    }
  }

  function handleCopyCode() {
    if (!linkingState?.code) return;
    navigator.clipboard.writeText(linkingState.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className={styles.container}>
      {/* Header section */}
      <div className={styles.header}>
        <span className={styles.eyebrow}>INTEGRATIONS</span>
        <h1 className={styles.title}>Telegram Bot</h1>
        <p className={styles.intro}>
          Connect your personal Telegram account to manage your Google Sheets planner conversationally, check your schedule, and receive automated daily briefings.
        </p>
      </div>

      {error && <div role="alert" className={styles.error}>{error}</div>}
      {notice && <div role="status" className={styles.notice}>{notice}</div>}

      {/* Main Connection Status Card */}
      <section className={styles.statusCard} aria-labelledby="telegram-status-heading">
        <div className={styles.statusCardHeader}>
          <div className={styles.botIdentity}>
            <div className={styles.botIconWrapper} aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m22 2-7 20-4-9-9-4Z" />
                <path d="M22 2 11 13" />
              </svg>
            </div>
            <div>
              <h2 id="telegram-status-heading" className={styles.botName}>
                Excela Telegram Assistant
              </h2>
              <p className={styles.botHandle}>@ExcelaPlannerBot</p>
            </div>
          </div>

          <div>
            {telegram.connected ? (
              <div className={`${styles.statusBadge} ${styles.statusConnected}`}>
                <span className={`${styles.statusDot} ${styles.statusDotConnected}`} aria-hidden="true" />
                <span>Connected</span>
              </div>
            ) : (
              <div className={`${styles.statusBadge} ${styles.statusDisconnected}`}>
                <span className={`${styles.statusDot} ${styles.statusDotDisconnected}`} aria-hidden="true" />
                <span>Not connected</span>
              </div>
            )}
          </div>
        </div>

        {telegram.connected ? (
          <div className={styles.connectedBody}>
            <div className={styles.detailsGrid}>
              {telegram.username && (
                <div className={styles.detailCard}>
                  <span className={styles.detailLabel}>Telegram Username</span>
                  <span className={styles.detailValue}>@{telegram.username}</span>
                </div>
              )}
              {telegram.firstName && (
                <div className={styles.detailCard}>
                  <span className={styles.detailLabel}>Display Name</span>
                  <span className={styles.detailValue}>{telegram.firstName}</span>
                </div>
              )}
              {telegram.linkedAt && (
                <div className={styles.detailCard}>
                  <span className={styles.detailLabel}>Connected Since</span>
                  <span className={styles.detailValue}>
                    {new Date(telegram.linkedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                </div>
              )}
            </div>

            <div className={styles.connectedChecklist}>
              <div className={styles.checklistItem}>
                <svg className={styles.checkIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>Smart Conversational Agent enabled</span>
              </div>
              <div className={styles.checklistItem}>
                <svg className={styles.checkIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>7-Day Schedule view (<code style={{ color: "#a7f3d0" }}>/week</code>)</span>
              </div>
              <div className={styles.checklistItem}>
                <svg className={styles.checkIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>Daily Schedule briefings (<code style={{ color: "#a7f3d0" }}>/auto</code>)</span>
              </div>
              <div className={styles.checklistItem}>
                <svg className={styles.checkIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>Instant Google Sheet link (<code style={{ color: "#a7f3d0" }}>/view</code>)</span>
              </div>
            </div>

            <div className={styles.disconnectActions}>
              {confirmingDisconnect ? (
                <div className={styles.disconnectConfirmCard}>
                  <p>
                    Are you sure you want to disconnect Telegram? The bot will no longer recognize your account until reconnected.
                  </p>
                  <div className={styles.disconnectConfirmButtons}>
                    <button
                      type="button"
                      className={styles.btnDanger}
                      disabled={busy}
                      onClick={handleDisconnect}
                    >
                      {busy ? "Disconnecting…" : "Yes, disconnect"}
                    </button>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      disabled={busy}
                      onClick={() => setConfirmingDisconnect(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.disconnectTextButton}
                  onClick={() => setConfirmingDisconnect(true)}
                >
                  Disconnect Telegram
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className={styles.unconnectedBody}>
            <p className={styles.unconnectedIntro}>
              Connect your personal Telegram account to manage your schedule from anywhere. You will be able to converse naturally, view upcoming deadlines, and receive automated morning briefings.
            </p>

            {!linkingState ? (
              <div>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  disabled={busy}
                  onClick={handleStartLinking}
                >
                  {busy ? "Generating code…" : "Connect Telegram"}
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <div className={styles.stepsGuide}>
                  <div className={styles.stepCard}>
                    <span className={styles.stepNumber}>1</span>
                    <span>Open <strong>@ExcelaPlannerBot</strong> in Telegram.</span>
                  </div>
                  <div className={styles.stepCard}>
                    <span className={styles.stepNumber}>2</span>
                    <span>Tap <strong>Start</strong> or send the linking code.</span>
                  </div>
                  <div className={styles.stepCard}>
                    <span className={styles.stepNumber}>3</span>
                    <span>Your account links instantly.</span>
                  </div>
                </div>

                <div className={styles.codeBox}>
                  <span className={styles.codeLabel}>YOUR ONE-TIME LINKING CODE</span>
                  <div className={styles.codeDisplay}>{linkingState.code}</div>
                  <div className={styles.codeActions}>
                    <a
                      href={linkingState.botUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.btnPrimary}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m22 2-7 20-4-9-9-4Z" />
                        <path d="M22 2 11 13" />
                      </svg>
                      Open in Telegram ↗
                    </a>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={handleCopyCode}
                    >
                      {copied ? "Copied ✓" : "Copy code"}
                    </button>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={() => setLinkingState(null)}
                    >
                      Cancel
                    </button>
                  </div>
                  <div className={styles.pollingNotice}>
                    <span className={styles.spinner} aria-hidden="true" />
                    <span>Waiting for connection from Telegram… (code expires in 10 minutes)</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Command Capabilities Guide Section */}
      <section className={styles.capabilitiesSection} aria-labelledby="capabilities-heading">
        <div className={styles.sectionHeader}>
          <span className={styles.eyebrow}>CAPABILITIES</span>
          <h2 id="capabilities-heading" className={styles.sectionTitle}>
            What you can do in Telegram
          </h2>
          <p className={styles.sectionIntro}>
            Excela&apos;s Telegram bot gives you full conversational AI control plus quick shortcuts for your busy routine.
          </p>
        </div>

        <div className={styles.commandsGrid}>
          {/* Card 1: Conversational AI */}
          <div className={styles.commandCard}>
            <div className={styles.commandCardTop}>
              <div className={styles.commandHeaderLeft}>
                <div className={styles.commandIconBox} aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <h3 className={styles.commandName}>Conversational AI</h3>
              </div>
              <span className={styles.commandBadge}>Smart Agent</span>
            </div>
            <p className={styles.commandDesc}>
              Chat naturally with Excela just like on the web. Add events, reschedule dates, check deadlines, or mark tasks completed directly in your chat.
            </p>
            <div className={styles.commandExampleBox}>
              <span className={exampleLabel}>Try sending:</span>
              <span className={styles.exampleSnippet}>&ldquo;Add CSE321 Quiz next Monday at 2 PM&rdquo;</span>
              <span className={styles.exampleSnippet}>&ldquo;What do I have scheduled on Friday?&rdquo;</span>
            </div>
          </div>

          {/* Card 2: /week */}
          <div className={styles.commandCard}>
            <div className={styles.commandCardTop}>
              <div className={styles.commandHeaderLeft}>
                <div className={styles.commandIconBox} aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
                    <line x1="16" x2="16" y1="2" y2="6" />
                    <line x1="8" x2="8" y1="2" y2="6" />
                    <line x1="3" x2="21" y1="10" y2="10" />
                  </svg>
                </div>
                <h3 className={styles.commandName}>/week</h3>
              </div>
              <span className={styles.commandBadge}>7-Day View</span>
            </div>
            <p className={styles.commandDesc}>
              Instantly view your full schedule for the next 7 consecutive calendar days (today plus the next 6 days) in a clean single glance.
            </p>
            <div className={styles.commandExampleBox}>
              <span className={exampleLabel}>Command:</span>
              <span className={styles.exampleSnippet}>/week</span>
            </div>
          </div>

          {/* Card 3: /auto */}
          <div className={styles.commandCard}>
            <div className={styles.commandCardTop}>
              <div className={styles.commandHeaderLeft}>
                <div className={styles.commandIconBox} aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </div>
                <h3 className={styles.commandName}>/auto &lt;time&gt;</h3>
              </div>
              <span className={styles.commandBadge}>Daily Alerts</span>
            </div>
            <p className={styles.commandDesc}>
              Configure an automatic daily schedule briefing delivered directly to your Telegram with today&apos;s and tomorrow&apos;s agenda.
            </p>
            <div className={styles.commandExampleBox}>
              <span className={exampleLabel}>Examples:</span>
              <span className={styles.exampleSnippet}>/auto 6:30pm</span>
              <span className={styles.exampleSnippet}>/auto 8.00am</span>
              <span className={styles.exampleSnippet}>/auto off  (disable alerts)</span>
            </div>
          </div>

          {/* Card: Smart Reminders */}
          <div className={styles.commandCard}>
            <div className={styles.commandCardTop}>
              <div className={styles.commandHeaderLeft}>
                <div className={styles.commandIconBox} aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                </div>
                <h3 className={styles.commandName}>Smart Reminders</h3>
              </div>
              <span className={styles.commandBadge}>Automatic</span>
            </div>
            <p className={styles.commandDesc}>
              Any task added with an explicit time automatically gets a Telegram reminder 5 minutes before the event begins.
            </p>
            <div className={styles.commandExampleBox}>
              <span className={exampleLabel}>Examples:</span>
              <span className={styles.exampleSnippet}>&quot;I have self advising at 7pm Oct 1&quot;</span>
              <span className={styles.exampleSnippet}>&quot;Gym tomorrow at 7pm&quot;</span>
              <span className={styles.exampleSnippet}>&quot;Meeting tomorrow at 3pm&quot;</span>
            </div>
          </div>

          {/* Card 4: /view */}
          <div className={styles.commandCard}>
            <div className={styles.commandCardTop}>
              <div className={styles.commandHeaderLeft}>
                <div className={styles.commandIconBox} aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" x2="21" y1="14" y2="3" />
                  </svg>
                </div>
                <h3 className={styles.commandName}>/view</h3>
              </div>
              <span className={styles.commandBadge}>Google Sheet</span>
            </div>
            <p className={styles.commandDesc}>
              Sends you a direct clickable link to immediately open your active Google Sheets monthly planner in your browser.
            </p>
            <div className={styles.commandExampleBox}>
              <span className={exampleLabel}>Command:</span>
              <span className={styles.exampleSnippet}>/view</span>
            </div>
          </div>

          {/* Card 5: /help & /clear */}
          <div className={styles.commandCard}>
            <div className={styles.commandCardTop}>
              <div className={styles.commandHeaderLeft}>
                <div className={styles.commandIconBox} aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                    <line x1="12" x2="12.01" y1="17" y2="17" />
                  </svg>
                </div>
                <h3 className={styles.commandName}>/help &amp; /clear</h3>
              </div>
              <span className={styles.commandBadge}>Utilities</span>
            </div>
            <p className={styles.commandDesc}>
              Access the quick command reference anytime, or reset your current conversation context to start a fresh interaction.
            </p>
            <div className={styles.commandExampleBox}>
              <span className={exampleLabel}>Commands:</span>
              <span className={styles.exampleSnippet}>/help  (view command list)</span>
              <span className={styles.exampleSnippet}>/clear  (reset chat context)</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

const exampleLabel = styles.exampleLabel;
