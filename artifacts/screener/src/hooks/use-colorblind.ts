import { useCallback, useEffect, useState } from "react"

const STORAGE_KEY = "screener:colorblind"

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

function applyColorblind(enabled: boolean): void {
  document.documentElement.classList.toggle("colorblind", enabled)
}

/**
 * Colorblind-mode preference with persistence.
 * When enabled the `colorblind` class is set on <html>, which flips the
 * status palette from green/red to blue/orange via CSS custom-property
 * overrides in index.css.
 */
export function useColorblind() {
  const [colorblind, setColorblind] = useState<boolean>(readStored)

  useEffect(() => {
    applyColorblind(colorblind)
    try {
      localStorage.setItem(STORAGE_KEY, String(colorblind))
    } catch {
      /* ignore */
    }
  }, [colorblind])

  const toggleColorblind = useCallback(() => {
    setColorblind((prev) => !prev)
  }, [])

  return { colorblind, toggleColorblind }
}
