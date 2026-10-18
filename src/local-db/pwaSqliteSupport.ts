/** Lightweight feature detection kept separate from the SQLite runtime. */
export function isOpfsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "storage" in navigator &&
    typeof (navigator.storage as { getDirectory?: () => unknown }).getDirectory === "function"
  );
}
