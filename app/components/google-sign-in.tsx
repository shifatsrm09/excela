"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./loading.module.css";

export const SIGN_IN_CHANNEL = "excela-google";

// Google sign-in runs in a popup so Google's pages never enter this tab's history (the Back button
// can't return to "Choose an account"). If popups are blocked, it falls back to signing in in this tab.
export function startGoogleSignIn(consent = false) {
  const params = new URLSearchParams({ popup: "1" });
  if (consent) params.set("consent", "1");
  const width = 500;
  const height = 650;
  const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
  const popup = window.open(
    `/api/google/connect?${params}`,
    "excela-google",
    `width=${width},height=${height},left=${left},top=${top}`,
  );
  if (!popup) {
    window.location.assign(consent ? "/api/google/connect?consent=1" : "/api/google/connect");
    return;
  }
  popup.focus();
  return popup;
}

// A "Sign in with Google" link for any page. Without JavaScript or with a middle-click it is a normal link.
export function GoogleSignInLink({ className, children }: { className?: string; children: ReactNode }) {
  const [pending, setPending] = useState(false);
  const popupRef = useRef<Window | undefined>(undefined);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => {
      if (popupRef.current?.closed) setPending(false);
    }, 500);
    return () => window.clearInterval(timer);
  }, [pending]);
  // The home page handles the result itself. Anywhere else (e.g. the legal pages) go home once signed in.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(SIGN_IN_CHANNEL);
    channel.onmessage = (event: MessageEvent<{ status?: string }>) => {
      setPending(false);
      if (event.data?.status === "connected" && window.location.pathname !== "/") window.location.assign("/");
    };
    return () => channel.close();
  }, []);

  return (
    <a
      href="/api/google/connect"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (pending) { popupRef.current?.focus(); return; }
        setPending(true);
        popupRef.current = startGoogleSignIn();
      }}
      className={className}
      aria-busy={pending}
    >
      {pending ? <span className={styles.pendingLabel}><span className={styles.spinner} aria-hidden="true" />Signing in…</span> : children}
    </a>
  );
}
