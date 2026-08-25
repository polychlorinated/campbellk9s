const COUNT_KEY = "ck9_visit_count";
const DAY_KEY = "ck9_visit_day";
const POPUP_KEY = "ck9_popup_seen";

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Visits are counted once per calendar day. The first call on a new day
 * increments the count, so it is safe to call from multiple scripts.
 */
export function getVisitState(): { count: number; popupSeen: boolean } {
  try {
    const today = todayKey();
    const last = localStorage.getItem(DAY_KEY);
    let count: number;

    if (last === today) {
      count = parseInt(localStorage.getItem(COUNT_KEY) ?? "1", 10) || 1;
    } else {
      const prev = parseInt(localStorage.getItem(COUNT_KEY) ?? "0", 10) || 0;
      count = prev + 1;
      localStorage.setItem(COUNT_KEY, String(count));
      localStorage.setItem(DAY_KEY, today);
    }

    return { count, popupSeen: localStorage.getItem(POPUP_KEY) === "1" };
  } catch {
    // Storage unavailable — behave like a returning visitor.
    return { count: 4, popupSeen: true };
  }
}

export function markPopupSeen(): void {
  try {
    localStorage.setItem(POPUP_KEY, "1");
  } catch {
    // ignore
  }
}
