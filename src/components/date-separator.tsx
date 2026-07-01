import { format, isToday, isYesterday, isThisWeek } from "date-fns";

interface DateSeparatorProps {
  date: Date;
}

export function DateSeparator({ date }: DateSeparatorProps) {
  const label = getDateLabel(date);

  return (
    <div className="flex items-center justify-center my-4">
      <div className="px-3 py-1.5 bg-neutral-800/40 backdrop-blur-sm border border-white/5 text-neutral-400 text-[10px] rounded-full uppercase tracking-widest font-semibold shadow-xl">
        {label}
      </div>
    </div>
  );
}

function getDateLabel(date: Date): string {
  const now = new Date();

  if (isToday(date)) {
    return "Today";
  }

  if (isYesterday(date)) {
    return "Yesterday";
  }

  if (isThisWeek(date)) {
    return format(date, "EEEE");
  }

  if (date.getFullYear() === now.getFullYear()) {
    return format(date, "MMMM d");
  }

  return format(date, "MMMM d, yyyy");
}

export function shouldShowSeparator(prevDate: Date | null, currentDate: Date): boolean {
  if (!prevDate) return true;

  const prevDay = new Date(prevDate.getFullYear(), prevDate.getMonth(), prevDate.getDate());
  const currDay = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());

  return prevDay.getTime() !== currDay.getTime();
}
