"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import styles from "./discord.module.css";

type Event = { course: string; title: string; date: string };
type Item = { id: string; channelName?: string; messageUrl?: string; author?: string; contentPreview?: string; events: Event[]; createdAt: string };

export default function DiscordInbox() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function load() {
    try {
      const result = await fetch("/api/discord/pending", { cache: "no-store" });
      const data = await result.json();
      if (!result.ok) throw new Error(data.error || "Could not load Discord events.");
      setItems(data.items || []);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load Discord events."); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function ignore(item: Item) {
    setBusy(item.id); setError("");
    try {
      const result = await fetch("/api/discord/pending", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id, status: "ignored" }) });
      const data = await result.json();
      if (!result.ok) throw new Error(data.error || "Could not ignore event.");
      setItems((current) => current.filter((entry) => entry.id !== item.id));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not ignore event."); }
    finally { setBusy(null); }
  }

  async function approve(item: Item) {
    setBusy(item.id); setError("");
    try {
      const sync = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add_events", events: item.events }) });
      const syncData = await sync.json();
      if (!sync.ok) throw new Error(syncData.error || "Could not write the event to Google Sheets.");
      const result = await fetch("/api/discord/pending", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id, status: "approved" }) });
      const data = await result.json();
      if (!result.ok) throw new Error(data.error || "The planner was updated, but Excela could not close the Discord item.");
      setItems((current) => current.filter((entry) => entry.id !== item.id));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not approve event."); }
    finally { setBusy(null); }
  }

  return <main className={styles.page}>
    <header className={styles.header}><Link href="/" className={styles.brand}>← excela.</Link><Link href="/" className={styles.back}>Dashboard</Link></header>
    <section className={styles.content}>
      <p className={styles.eyebrow}>DISCORD ASSIST</p>
      <h1>Review academic announcements.</h1>
      <p className={styles.intro}>Excela reads messages from your configured Discord channels, extracts dated academic events, and waits here for your approval before changing the planner.</p>
      {error && <p className={styles.error}>{error}</p>}
      {loading ? <p className={styles.empty}>Loading…</p> : !items.length ? <div className={styles.empty}><strong>No pending announcements.</strong><span>When the bot finds a relevant announcement, it will appear here.</span></div> : <div className={styles.list}>{items.map((item) => <article key={item.id} className={styles.card}>
        <div className={styles.meta}><span>#{item.channelName || "discord"}</span>{item.messageUrl && <a href={item.messageUrl} target="_blank" rel="noreferrer">Open message ↗</a>}</div>
        {item.contentPreview && <p className={styles.source}>{item.contentPreview}</p>}
        <div className={styles.events}>{item.events.map((event, index) => <div className={styles.event} key={`${item.id}-${index}`}><strong>{[event.course, event.title].filter(Boolean).join(" — ")}</strong><span>{event.date}</span></div>)}</div>
        <div className={styles.actions}><button onClick={() => void approve(item)} disabled={busy === item.id}>{busy === item.id ? "Working…" : "Add to planner"}</button><button onClick={() => void ignore(item)} disabled={busy === item.id} className={styles.secondary}>Ignore</button></div>
      </article>)}</div>}
    </section>
  </main>;
}
