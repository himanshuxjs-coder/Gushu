import { useEffect, useState } from "react";
import { Clock3, Sparkles } from "lucide-react";

/**
 * A purely local countdown. The target is midnight at the start of 23 Dec 2026
 * in the device's local timezone; no API, DB, network, or interval drift is involved.
 */
const TARGET_TIME = new Date(2026, 11, 23, 0, 0, 0, 0).getTime();

type TimeLeft = { days: number; hours: number; minutes: number; seconds: number };

function getTimeLeft(now: number): TimeLeft {
  const totalSeconds = Math.max(0, Math.floor((TARGET_TIME - now) / 1000));
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

function DigitCell({ value, label }: { value: string; label: string }) {
  return (
    <div className="mystery-countdown-cell" aria-label={`${value} ${label.toLowerCase()}`}>
      <span className="mystery-countdown-digit" aria-hidden="true">{value}</span>
      <span className="mystery-countdown-unit">{label}</span>
    </div>
  );
}

export function MysteryCountdown() {
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const scheduleNextSecond = () => {
      if (disposed) return;
      const current = Date.now();
      setNow(current);
      // Align to the next wall-clock second rather than accumulating interval drift.
      const delay = 1000 - (current % 1000);
      timeout = setTimeout(scheduleNextSecond, delay);
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        if (timeout) clearTimeout(timeout);
        scheduleNextSecond();
      } else if (timeout) {
        clearTimeout(timeout);
      }
    };

    scheduleNextSecond();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disposed = true;
      if (timeout) clearTimeout(timeout);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  const time = getTimeLeft(now);
  const complete = TARGET_TIME <= now;

  return (
    <section className={`mystery-countdown ${expanded ? "is-expanded" : ""}`} aria-label="Countdown to a secret moment">
      <button
        className="mystery-countdown-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="mystery-countdown-orbit" aria-hidden="true">
          <span className="mystery-countdown-orbit-core" />
        </span>
        <span className="mystery-countdown-heading">
          <span className="mystery-countdown-eyebrow"><Sparkles size={10} /> THE COUNTDOWN</span>
          <span className="mystery-countdown-title">{complete ? "The moment has arrived" : "Something is approaching"}</span>
        </span>
        <span className="mystery-countdown-chevron" aria-hidden="true">{expanded ? "−" : "+"}</span>
      </button>

      <div className="mystery-countdown-clock" role="timer" aria-live="off">
        <DigitCell value={String(time.days)} label="Days" />
        <span className="mystery-countdown-separator" aria-hidden="true">:</span>
        <DigitCell value={pad(time.hours)} label="Hours" />
        <span className="mystery-countdown-separator" aria-hidden="true">:</span>
        <DigitCell value={pad(time.minutes)} label="Minutes" />
        <span className="mystery-countdown-separator" aria-hidden="true">:</span>
        <DigitCell value={pad(time.seconds)} label="Seconds" />
      </div>

      <div className="mystery-countdown-foot">
        <span><span className="mystery-countdown-live-dot" /> LOCAL TIME • ALWAYS TICKING</span>
        <Clock3 size={11} aria-hidden="true" />
      </div>

      <div className="mystery-countdown-details" hidden={!expanded}>
        <span>23 DEC 2026</span>
        <span className="mystery-countdown-detail-rule" />
        <span>00:00 • MIDNIGHT</span>
      </div>
    </section>
  );
}
