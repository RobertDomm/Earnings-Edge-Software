import { useCallback, useEffect, useState } from "react"

export type Theme = "dark" | "light"

const STORAGE_KEY = "screener:theme"

function readStoredTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === "light" ? "light" : "dark" // dark is the default
  } catch {
    return "dark"
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark")
}

/**
 * Theme state with persistence. Dark mode is the default; the choice is
 * stored in localStorage and applied to <html> as the `dark` class.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme)

  useEffect(() => {
    applyTheme(theme)
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      /* ignore */
    }
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"))
  }, [])

  return { theme, toggleTheme }
}
