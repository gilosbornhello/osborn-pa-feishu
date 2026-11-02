// Calendar grid geometry: pure functions so drop targets are testable without a DOM.
import { addDays, wallParts, wallToInstant } from "../../rules/src/time.js";

export const GRID = Object.freeze({ startHour: 7, endHour: 22, slotMinutes: 30, defaultBlockMinutes: 60 });

/** Monday-based week containing `dateIso`. */
export function weekDays(dateIso) {
  const wd = new Date(`${dateIso}T12:00:00Z`).getUTCDay();
  const monday = addDays(dateIso, -((wd + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export function slotsPerDay(grid = GRID) {
  return ((grid.endHour - grid.startHour) * 60) / grid.slotMinutes;
}

/** Slot index → [startMs, endMs) for a new block of default length, in tz. */
export function slotToRange(dateIso, slotIndex, tz, grid = GRID) {
  const minutes = grid.startHour * 60 + slotIndex * grid.slotMinutes;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  const startMs = wallToInstant(`${dateIso}T${hh}:${mm}`, tz);
  return { startMs, endMs: startMs + grid.defaultBlockMinutes * 60_000 };
}

/** Where a stored block sits on the grid (null if outside this week/grid). */
export function blockPlacement(block, days, tz, grid = GRID) {
  const s = wallParts(block.startMs, tz);
  const dayIndex = days.indexOf(s.date);
  if (dayIndex < 0) return null;
  const startMin = s.hour * 60 + s.minute - grid.startHour * 60;
  const lengthMin = (block.endMs - block.startMs) / 60_000;
  const total = (grid.endHour - grid.startHour) * 60;
  if (startMin + lengthMin <= 0 || startMin >= total) return null;
  const top = Math.max(0, startMin) / total;
  const height = Math.min(total - Math.max(0, startMin), lengthMin - Math.max(0, -startMin)) / total;
  return { dayIndex, top, height, crossesMidnight: wallParts(block.endMs - 1, tz).date !== s.date };
}

/** Moving a block keeps its duration. */
export function moveRange(block, dateIso, slotIndex, tz, grid = GRID) {
  const { startMs } = slotToRange(dateIso, slotIndex, tz, grid);
  return { startMs, endMs: startMs + (block.endMs - block.startMs) };
}
