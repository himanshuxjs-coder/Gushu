import { useEffect, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";

/**
 * A purely local countdown to midnight at the start of 23 Dec 2026
 * in the device's local timezone. No API, database, or network requests.
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

const DAILY_MESSAGES: Record<number, string> = {
  "1": "Tomorrow's your birthday. I hope this year loves you back as much as I do. 💖",
  "2": "2 days to go. Tomorrow is almost your day, and I can't hide my smile.",
  "3": "3 days left. Get ready to be loved like crazy.",
  "4": "4 days until your day. Thank you for being exactly who you are.",
  "5": "5 days to go. My heart is already throwing you a party.",
  "6": "6 days left. I hope the whole world is kind to you on your day.",
  "7": "7 days until your birthday. One week left, and I'm so excited.",
  "8": "8 days to go. Almost time to celebrate my favorite person.",
  "9": "9 days left. You deserve a day as lovely as your heart.",
  "10": "10 days until your birthday, and I can barely wait.",
  "11": "11 days to go. You're the best thing that ever happened to me.",
  "12": "12 days left. I'm planning something special, so get ready.",
  "13": "13 days until your day. Lucky number, because it brings me closer to you.",
  "14": "14 days to go. Two weeks until we celebrate you.",
  "15": "15 days left. Half a month to go, and so much love to give you.",
  "16": "16 days until your birthday. You're my favorite hello and hardest goodbye.",
  "17": "17 days to go. I hope you know how much you matter to me.",
  "18": "18 days left. You make my life warmer, just by being in it.",
  "19": "19 days until your day, and my heart is already racing.",
  "20": "20 days to go. I love you more than I say out loud.",
  "21": "21 days left. Three weeks until we celebrate the person I adore.",
  "22": "22 days until your birthday. You're someone I never want to take for granted.",
  "23": "23 days to go. You're the reason ordinary things feel magical.",
  "24": "24 days left. A day with you feels short, and I wish it were longer.",
  "25": "25 days until your day, and I'm getting more excited every hour.",
  "26": "26 days to go. I hope every wish you make this year comes true.",
  "27": "27 days left. Your smile is my favorite view.",
  "28": "28 days until your birthday. You deserve all the happiness in the world.",
  "29": "29 days to go. I'm so grateful you're in my life.",
  "30": "30 days left. One month until the day we celebrate you.",
  "31": "31 days to go. One month and one day until your day.",
  "32": "32 days left. Thank you for always being you.",
  "33": "33 days until your day, and I can't wait to celebrate you.",
  "34": "34 days to go. You make my world softer and brighter.",
  "35": "35 days left. Every day closer feels like a gift.",
  "36": "36 days until your birthday. I hope it's as beautiful as you are.",
  "37": "37 days to go. Your kindness is my favorite thing about you.",
  "38": "38 days left. You're the kind of person people are lucky to know.",
  "39": "39 days until your day, and I'm already thinking of how to surprise you.",
  "40": "40 days to go. I'd choose you in every version of every day.",
  "41": "41 days left. You're proof that good people exist.",
  "42": "42 days until your birthday. I'm keeping a special place in my heart for it.",
  "43": "43 days to go. I love the way you make everything feel easier.",
  "44": "44 days left, and you're still the best part of my day.",
  "45": "45 days until your day. I'm saving the biggest smile for you.",
  "46": "46 days to go. I hope this year gives you everything you give others.",
  "47": "47 days left. Your laugh is my favorite sound.",
  "48": "48 days until your birthday, and I still can't believe how lucky I am.",
  "49": "49 days to go. Thank you for being my calm in every busy day.",
  "50": "50 days left. Halfway to a hundred reasons I'm glad you exist.",
  "51": "51 days until your day, and my heart is already celebrating.",
  "52": "52 days to go. You make ordinary days feel special.",
  "53": "53 days left. I'm already planning ways to make you smile.",
  "54": "54 days until your birthday, and every one of them feels brighter with you in it.",
  "55": "55 days to go. Some people are worth counting down for, and you're one of them.",
  "56": "56 days left, and you're still my favorite thought every morning.",
  "57": "57 days until the day the world got you. Best day ever.",
  "58": "58 days to go, and I'm already smiling about it."
};

const GIFT_PALETTES = [
  ["#ff8eaa", "#ffd166", "#8ecae6"],
  ["#b8a1ff", "#ffadad", "#a8e6cf"],
  ["#ffb86b", "#9be7ff", "#f4a7d7"],
  ["#a0c4ff", "#fdffb6", "#caffbf"],
  ["#f7aef8", "#a0e7e5", "#ffc6a5"],
  ["#f9c74f", "#90dbf4", "#cdb4db"],
  ["#ffafcc", "#bde0fe", "#caffbf"],
];

function getDailyPalette(now: number) {
  const date = new Date(now);
  const dayOfYear = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / 86400000);
  return GIFT_PALETTES[dayOfYear % GIFT_PALETTES.length];
}

function DigitCell({ value, label }: { value: string; label: string }) {
  return (
    <div className="mystery-countdown-cell" aria-label={`${value} ${label.toLowerCase()}`}>
      <span className="mystery-countdown-digit" aria-hidden="true">{value}</span>
      <span className="mystery-countdown-unit">{label}</span>
    </div>
  );
}

function GiftBox({ color, index }: { color: string; index: number }) {
  return (
    <span className={`birthday-gift birthday-gift-${index + 1}`} style={{ "--gift-color": color } as React.CSSProperties} aria-hidden="true">
      <span className="birthday-gift-lid"><span className="birthday-gift-bow" /></span>
      <span className="birthday-gift-front"><span className="birthday-gift-ribbon" /></span>
      <span className="birthday-gift-side" />
    </span>
  );
}

export function MysteryCountdown() {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const scheduleNextSecond = () => {
      if (disposed || document.visibilityState !== "visible") return;
      const current = Date.now();
      setNow(current);
      timeout = setTimeout(scheduleNextSecond, 1000 - (current % 1000));
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        if (timeout) clearTimeout(timeout);
        scheduleNextSecond();
      } else if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
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

  const time = useMemo(() => getTimeLeft(now), [now]);
  const palette = useMemo(() => getDailyPalette(now), [now]);
  const message = time.days <= 0
    ? "Today is your day. I hope it brings you all the happiness you deserve. 💖"
    : DAILY_MESSAGES[time.days] ?? "Every day brings us a little closer to celebrating you. 💖";
  const complete = TARGET_TIME <= now;

  return (
    <section className="mystery-countdown" aria-label="Birthday countdown">
      <div className="mystery-countdown-heading-row">
        <span className="mystery-countdown-orbit" aria-hidden="true">
          <span className="mystery-countdown-orbit-core" />
        </span>
        <span className="mystery-countdown-heading">
          <span className="mystery-countdown-eyebrow"><Sparkles size={10} /> A LITTLE SOMETHING</span>
          <span className="mystery-countdown-title">{complete ? "The special day is here" : "Counting down to your day"}</span>
        </span>
      </div>

      <div className="mystery-countdown-clock" role="timer" aria-live="off">
        <DigitCell value={String(time.days)} label="Days" />
        <span className="mystery-countdown-separator" aria-hidden="true">:</span>
        <DigitCell value={pad(time.hours)} label="Hours" />
        <span className="mystery-countdown-separator" aria-hidden="true">:</span>
        <DigitCell value={pad(time.minutes)} label="Minutes" />
        <span className="mystery-countdown-separator" aria-hidden="true">:</span>
        <DigitCell value={pad(time.seconds)} label="Seconds" />
      </div>

      <div className="birthday-gifts" aria-hidden="true">
        {palette.map((color, index) => <GiftBox key={index} color={color} index={index} />)}
      </div>
      <p className="birthday-daily-message" aria-live="polite">{message}</p>
    </section>
  );
}
